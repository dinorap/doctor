import os
import json
import threading
import asyncio
from typing import Optional

from asyncio.proactor_events import _ProactorBasePipeTransport

from services.nst_browser import NSTBrowserManager
from services.nst_flow import (
    _STOP_SIGNAL,
    _RUNNING_LOOPS,
    _RUNNING_LOOPS_LOCK,
    FLOW_URL,
    _resolve_script_path,
    _build_profile_api_key_map,
    _wait_for_profiles_ready,
    _ensure_profiles_started,
    _maybe_move_window,
    set_setup_state,
    inject_keep_alive,
    _goto_flow_with_profile_cache,
    silence_event_loop_closed,
)
from services.config_loader import get_settings
from services.browser_engine import profile_pool_for_run, is_chrome_local, get_ws_endpoint_for_profile
from services.flow_actions import (
    connect_and_get_page,
    select_mode,
    FlowStoppedError,
    setup_render_settings,
    detach_browser_session,
    clamp_aspect_ratio_for_flow_video,
    normalize_flow_video_model,
)


def run_flow_with_settings_background_with_profile_cache(
    count: int,
    mode: str,
    model: str,
    ratio: str,
    script_path: Optional[str] = None,
    *,
    flow_url: str = FLOW_URL,
    yt_use_reference_image: bool = False,
    omni_flash_duration: Optional[str] = None,
) -> int:
    """
    Giống run_flow_with_settings_background nhưng:
    - Mỗi profile_id có 1 project URL riêng.
    - URL được cache tối đa 1 ngày, hết hạn sẽ tạo project mới.
    - Logic được tách riêng sang services_api để dùng như API-level helper.
    """
    _STOP_SIGNAL.clear()

    requested_mode = (mode or "").strip().lower()
    mode_hint_path = (_resolve_script_path(script_path) or script_path or "").replace("\\", "/").lower()
    if "/youtube_" in mode_hint_path:
        mode = "image"
    elif "/ai_" in mode_hint_path:
        mode = "video"
    elif requested_mode == "text_to_video":
        mode = "video"
    elif requested_mode in {"image", "video"}:
        mode = requested_mode
    else:
        mode = "image"
    print(f"[NST Setup+CACHE] 🎯 Mode setup đã chuẩn hóa: {mode} (request='{requested_mode or 'empty'}')")

    requested_model = str(model or "").strip()
    if mode == "video":
        normalized_model = normalize_flow_video_model(requested_model)
    else:
        normalized_model = requested_model or "🍌 Nano Banana Pro"
    print(f"[NST Setup+CACHE] 🎛️ Model setup đã chuẩn hóa: {normalized_model} (request='{requested_model or 'empty'}')")

    if mode == "image" and yt_use_reference_image and script_path:
        abs_path = _resolve_script_path(script_path)
        if abs_path and os.path.exists(abs_path):
            try:
                with open(abs_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                has_master = bool((data.get("master_cast_image_prompt") or "").strip())
                rel_path = data.get("master_image_url")
                if has_master and rel_path:
                    script_dir = os.path.dirname(abs_path)
                    mode_dir = os.path.dirname(script_dir)
                    full_path = os.path.join(mode_dir, rel_path)
                    if os.path.exists(full_path):
                        print(
                            f"[NST Setup+CACHE] 📌 YouTube ảnh tham chiếu: tìm thấy master ở {full_path} (mode: image)"
                        )
            except Exception:
                pass

    def _run():
        if os.name == "nt":
            _ProactorBasePipeTransport.__del__ = silence_event_loop_closed(_ProactorBasePipeTransport.__del__)
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        with _RUNNING_LOOPS_LOCK:
            _RUNNING_LOOPS.add(loop)

        async def _main():
            if script_path:
                print(f"[NST Setup+CACHE] 🔒 Lock file: is_setting_up = True")
                await set_setup_state(script_path, True)

            try:
                nst = NSTBrowserManager()
                api_key_map = _build_profile_api_key_map()
                settings_snap = get_settings() or {}
                ids = profile_pool_for_run(count, settings_snap)

                if not ids:
                    print("[NST Setup+CACHE] ⚠️ Không tìm thấy profile nào để chạy.")
                    return

                print(f"[NST Setup+CACHE] 🚀 Khởi động {len(ids)} browser (warm-up, mở song song từng profile)...")

                if is_chrome_local(settings_snap):
                    await asyncio.gather(
                        *[
                            asyncio.to_thread(_ensure_profiles_started, nst, [pid], api_key_map)
                            for pid in ids
                        ],
                        return_exceptions=True,
                    )
                else:
                    async def _warmup_one_profile(pid: str):
                        if _STOP_SIGNAL.is_set():
                            return
                        api_key = api_key_map.get(pid)
                        result = await asyncio.to_thread(
                            nst.connect_profile,
                            pid,
                            headless=False,
                            auto_close=False,
                            extra_config=None,
                            api_key_override=api_key,
                        )
                        if not result.get("success"):
                            print(
                                f"[NST Setup+CACHE] ⚠️ Warmup connect_profile {pid[-4:]} failed: {result.get('error')}"
                            )

                    await asyncio.gather(*[_warmup_one_profile(pid) for pid in ids], return_exceptions=True)
                if _STOP_SIGNAL.is_set():
                    print("[NST Setup+CACHE] 🛑 Dừng theo lệnh Stop (sau warmup).")
                    return
                await _wait_for_profiles_ready(nst, ids, api_key_map)
                print(
                    f"[NST Setup+CACHE] ✅ Đã start {len(ids)} browser. Đang goto Flow (dùng cache) cho tất cả profiles..."
                )

                ws_by_pid: dict[str, str] = {}

                async def _goto_and_setup_profile(pid: str):
                    """Goto cache + refresh auth → setup mode/model ngay (không chờ hết profiles)."""
                    if _STOP_SIGNAL.is_set():
                        return
                    ws = get_ws_endpoint_for_profile(
                        nst, pid, api_key_map.get(pid), settings=settings_snap
                    )
                    if not ws:
                        print(f"[NST Setup+CACHE] ⚠️ Profile {pid[-4:]} chưa sẵn sàng / không lấy được WS.")
                        return
                    page = await connect_and_get_page(ws)
                    if not page:
                        print(f"[NST Setup+CACHE] ⚠️ Profile {pid[-4:]} không kết nối được.")
                        return
                    try:
                        await _maybe_move_window(page)
                        ws_by_pid[pid] = ws
                        print(f"[NST Setup+CACHE] 🌍 Profile {pid[-4:]}: goto Flow/project (cache)...")
                        await _goto_flow_with_profile_cache(
                            page,
                            pid,
                            flow_url,
                            stop_check=lambda: _STOP_SIGNAL.is_set(),
                        )
                        print(f"[NST Setup+CACHE] ▶️ Profile {pid[-4:]}: refresh xong → setup ngay...")
                        if not is_chrome_local(settings_snap):
                            await inject_keep_alive(page)
                        ok = await select_mode(page, mode, stop_check=lambda: _STOP_SIGNAL.is_set())
                        if not ok:
                            print(f"[NST Setup+CACHE] ⚠️ Profile {pid[-4:]}: không chọn được mode {mode}.")
                            return
                        eff_ratio = (
                            clamp_aspect_ratio_for_flow_video(ratio)
                            if mode == "video"
                            else str(ratio or "16:9")
                        )
                        settings_ok = await setup_render_settings(
                            page,
                            output_count=1,
                            aspect_ratio=eff_ratio,
                            model=normalized_model,
                            select_ingredients=(mode == "video"),
                            omni_flash_duration=omni_flash_duration,
                            skip_ratio_and_output=True,
                        )
                        if not settings_ok:
                            print(
                                f"[NST Setup+CACHE] ⚠️ Profile {pid[-4:]}: setup_render_settings lỗi "
                                f"(model={normalized_model!r})."
                            )
                            return
                        print(f"[NST Setup+CACHE] ✅ Profile {pid[-4:]}: goto + refresh + setup xong.")
                    except FlowStoppedError:
                        return
                    except Exception as e:
                        print(f"[NST Setup+CACHE] ⚠️ Profile {pid[-4:]}: {e}")

                await asyncio.gather(
                    *[_goto_and_setup_profile(pid) for pid in ids],
                    return_exceptions=True,
                )

                # Detach CDP session sau khi setup xong để không giữ browser local bị ì khi user thao tác tay.
                await asyncio.gather(
                    *[
                        detach_browser_session(ws)
                        for ws in ws_by_pid.values()
                        if ws
                    ],
                    return_exceptions=True,
                )

                print(f"[NST Setup+CACHE] ✅ Hoàn tất. Bấm Run để chạy tạo ảnh/video.")

            except Exception as e:
                print(f"[NST Setup+CACHE] ❌ Lỗi quá trình setup: {e}")

            finally:
                if script_path:
                    print(f"[NST Setup+CACHE] 🔓 Unlock file: is_setting_up = False")
                    await set_setup_state(script_path, False)

        try:
            loop.run_until_complete(_main())
        finally:
            with _RUNNING_LOOPS_LOCK:
                _RUNNING_LOOPS.discard(loop)
            loop.close()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return count

