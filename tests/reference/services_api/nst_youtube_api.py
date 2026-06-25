import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Optional, List, Dict, Literal, Any

import requests
from playwright.async_api import Page, TimeoutError  # type: ignore

# --- VEO Image API helpers ---
from services_api.veo_image_api import (
    image_aspect_const_from_ui_ratio,
    build_generate_image_payload,
    build_generate_image_url,
    request_generate_images_via_browser,
    parse_media_from_response,
    CREATE_IMAGE_MODEL_TO_KEY,
)
from services_api.veo_reference_image_api import (
    build_payload_upload_image,
    request_upload_image_via_browser,
    extract_media_id,
)
from services_api.character_reference_media import (
    CAST_REFERENCE_MEDIA_META_KEY,
    build_profiles_with_media_ids,
    enrich_scene_tasks_with_cast_references,
    load_cast_profiles_from_script,
    resolve_cast_reference_media_for_profile,
)

# --- VEO token/auth collector (tách riêng như A_workflow_get_token.py) ---
from services_api.veo_get_token import (
    load_veo_auth_config,
    refresh_veo_auth_fast,
    fetch_recaptcha_token_via_page,
)

# Upsample image (2K) API
from services_api.veo_api_inflight import veo_api_request_slot
from services_api.veo_upsample_image_api import request_upsample_image_via_browser

# Dùng lại helper từ backend services
from services.nst_browser import NSTBrowserManager  # type: ignore
from services.config_loader import get_settings  # type: ignore
from services.browser_engine import (  # type: ignore
    get_ws_endpoint_for_profile,
    profile_pool_for_run,
    is_chrome_local,
)
from services.nst_flow import (  # type: ignore
    _build_profile_api_key_map,
    _ensure_profiles_started,
    _stop_profiles_by_key,
    _filter_scenes_by_range,
    _STOP_SIGNAL,
    _RUNNING_LOOPS,
    _RUNNING_LOOPS_LOCK,
    _resolve_script_path,
    update_scene_status,
    scene_should_skip_generation,
    set_script_running_state,
    set_script_run_finished,
    update_master_image_status,
    update_master_image_path,
    _wait_for_profiles_ready,
    _goto_flow_with_profile_cache,
)
from services.flow_actions import (  # type: ignore
    send_prompt_text,
    connect_and_get_page,
    cleanup_browser,
    detach_browser_session,
    setup_render_settings,
    select_mode,
)


# ==========================================================
# 1. VEO TOKEN/AUTH COLLECTOR (đã tách sang services_api/veo_get_token.py)
# ==========================================================

# Cấu hình timeout và rate limit cho API tạo ảnh YouTube
TIMEOUT_ANH = 80  # Chờ tối đa 80s cho API trả ảnh; quá thì báo timeout, FAILED, retry nếu còn lượt
TOKEN_TIMEOUT = 60  # Mỗi lần lấy recaptcha token từ Chrome: chờ tối đa 60s; quá thì lỗi lấy token
WAIT_BETWEEN = 20  # Thời gian nghỉ giữa 2 prompt liên tiếp (từ prompt thứ 2 trở đi), giây
MAX_IN_FLIGHT = 3  # Tối đa 3 request API (tạo ảnh + upscale) cùng lúc / profile (veo_api_request_slot)


async def _clear_flow_storage_and_reload(page: Page) -> None:
    """
    Dọn local/session storage, cache... cho origin hiện tại (không đụng cookie),
    sau đó reload page. Dùng khi gặp lỗi 403 lặp lại nhiều lần.
    """
    try:
        url = page.url or ""
        from urllib.parse import urlparse

        parsed = urlparse(url)
        origin = ""
        if parsed.scheme and parsed.netloc:
            origin = f"{parsed.scheme}://{parsed.netloc}"
        if not origin:
            return

        cdp = await page.context.new_cdp_session(page)
        try:
            await cdp.send(
                "Storage.clearDataForOrigin",
                {
                    "origin": origin,
                    "storageTypes": ",".join(
                        [
                            "local_storage",
                            "session_storage",
                            "indexeddb",
                            "cache_storage",
                            "service_workers",
                            "websql",
                            "file_systems",
                            "shared_storage",
                        ]
                    ),
                },
            )
            try:
                await cdp.send("Network.clearBrowserCache")
            except Exception:
                pass
            print(f"[VEO Image API] 🧹 Đã clear storage/cache cho origin {origin}, reload page...")
            await page.reload(wait_until="domcontentloaded", timeout=30_000)
        finally:
            try:
                await cdp.detach()
            except Exception:
                pass
    except Exception as e:
        print(f"[VEO Image API] ⚠️ Không clear storage được: {e}")


async def _restart_nst_profile_and_reconnect(
    nst: NSTBrowserManager,
    api_key_map: Dict[str, str],
    profile_id: str,
    *,
    ratio: str = "16:9",
    model: Optional[str] = None,
) -> Optional[Page]:
    """
    Tắt/bật lại NST browser cho profile_id, rồi vào lại project + setup Batch.
    Giống logic bên nst_flow, nhưng rút gọn cho API.
    Trả về Page mới nếu OK, None nếu lỗi (thì caller tự dừng).
    """
    if _STOP_SIGNAL.is_set():
        return None

    api_key = api_key_map.get(profile_id, "")
    settings_snap = get_settings() or {}

    # 1. Stop profile cũ
    try:
        print(f"[VEO API] 🔁 Restart NST profile {profile_id[-4:]}: stop_profiles...")
        _stop_profiles_by_key(nst, [profile_id], api_key_map)
    except Exception as e:
        print(f"[VEO API] ⚠️ stop_profiles {profile_id[-4:]} lỗi: {e}")

    if _STOP_SIGNAL.is_set():
        return None

    # 2. Start lại profile
    try:
        print(f"[VEO API] 🔁 Restart NST profile {profile_id[-4:]}: start_profiles...")
        _ensure_profiles_started(nst, [profile_id], api_key_map)
        await _wait_for_profiles_ready(nst, [profile_id], api_key_map)
    except Exception as e:
        print(f"[VEO API] ❌ start_profiles {profile_id[-4:]} lỗi: {e}")
        return None

    if _STOP_SIGNAL.is_set():
        return None

    # 3. Lấy lại WS endpoint + Page mới
    ws = get_ws_endpoint_for_profile(nst, profile_id, api_key, settings=settings_snap)
    if not ws:
        print(f"[VEO API] ❌ Sau restart không lấy được WS cho {profile_id[-4:]}.")
        return None

    page = await connect_and_get_page(ws)
    if not page:
        print(f"[VEO API] ❌ Sau restart không connect được Playwright cho {profile_id[-4:]}.")
        return None

    # 4. Vào lại project + setup Batch + setup lại mode/model/ratio (sau restart UI có thể mất state)
    try:
        await _goto_flow_with_profile_cache(
            page,
            profile_id,
            stop_check=lambda: _STOP_SIGNAL.is_set(),
        )
        
        try:
            ok = await select_mode(page, "image", stop_check=lambda: _STOP_SIGNAL.is_set())
            if not ok:
                print(f"[VEO API] ⚠️ Sau restart không chọn được mode image cho {profile_id[-4:]}.")
            await setup_render_settings(
                page,
                output_count=1,
                aspect_ratio=str(ratio or "16:9"),
                model=model,
            )
        except Exception as setup_err:
            print(f"[VEO API] ⚠️ Setup lại sau restart lỗi: {setup_err}")
    except Exception as e:
        print(f"[VEO API] ❌ goto_flow_with_profile_cache sau restart lỗi: {e}")
        return None

    return page


def _normalize_model_label(model: str) -> str:
    """
    Chuẩn hoá chuỗi model từ frontend:
    - Bỏ emoji đầu dòng (🍌, 📷, v.v.).
    - Làm gọn khoảng trắng, lower-case để so khớp.
    """
    if not isinstance(model, str):
        return ""
    raw = model.strip()
    # Bỏ mọi ký tự không phải chữ/số ở đầu (emoji, icon...)
    raw = re.sub(r"^[^\w]+", "", raw).strip()
    # Gộp khoảng trắng + lower
    return " ".join(raw.split()).lower()


def _resolve_model_key_from_frontend(model: Optional[str]) -> Optional[str]:
    """
    Map giá trị model từ frontend (có thể kèm emoji, Pro/pro)
    sang model_key nội bộ (GEM_PIX_2 / NARWHAL / IMAGEN_3_5, ...),
    dùng đúng mapping CREATE_IMAGE_MODEL_TO_KEY trong API_Create_image.
    """
    if not model:
        return None

    normalized = _normalize_model_label(model)
    if not normalized:
        return None

    # Tìm key hiển thị của VEO theo so khớp không phân biệt hoa/thường
    canonical_name: Optional[str] = None
    for display_name in CREATE_IMAGE_MODEL_TO_KEY.keys():
        if normalized == " ".join(display_name.strip().split()).lower():
            canonical_name = display_name
            break

    # Frontend sidebar: "🍌 Nano Banana Pro" | "🍌 Nano Banana 2" | "Imagen 4"
    if not canonical_name and normalized == "nano banana pro":
        canonical_name = "Nano Banana pro"
    if not canonical_name and normalized == "nano banana 2":
        canonical_name = "Nano Banana 2"
    if not canonical_name and normalized == "imagen 4":
        canonical_name = "Imagen 4"

    if not canonical_name:
        print(f"[VEO API] ⚠️ Không map được model frontend: {model!r} (normalized={normalized!r})")
        return None

    return CREATE_IMAGE_MODEL_TO_KEY.get(canonical_name)


def _load_auth_config(profile_id: str) -> Optional[dict]:
    return load_veo_auth_config(profile_id)


def _download_image_requests_sync(url: str, save_path: str, max_retries: int = 2, timeout: int = 10) -> bool:
    """
    Tải ảnh bằng requests (copy/lược giản từ test/veo_token_nst.py).
    """
    for attempt in range(max_retries):
        try:
            response = requests.get(url, stream=True, timeout=timeout)
            if response.status_code == 200:
                with open(save_path, "wb") as f:
                    for chunk in response.iter_content(1024):
                        f.write(chunk)
                return True
            else:
                print(f"⚠️ Lần {attempt + 1}: Lỗi HTTP {response.status_code}")
        except Exception as e:
            print(f"⚠️ Lần {attempt + 1} thất bại: {e}")
        if attempt < max_retries - 1:
            import time as _time

            _time.sleep(3)
    return False


async def download_image_requests(url: str, save_path: str, max_retries: int = 2, timeout: int = 10) -> bool:
    return await asyncio.to_thread(
        _download_image_requests_sync,
        url,
        save_path,
        max_retries,
        timeout,
    )


# ==========================================================
# 3. API WORKFLOW YOUTUBE: GEN ẢNH MASTER + ẢNH SCENE
# ==========================================================


def _extract_best_media_id_from_generate_response(body: str) -> Optional[str]:
    try:
        obj = json.loads(body or "{}")
    except Exception:
        return None
    try:
        workflows = obj.get("workflows") if isinstance(obj, dict) else None
        if isinstance(workflows, list):
            for wf in workflows:
                if not isinstance(wf, dict):
                    continue
                meta = wf.get("metadata") or {}
                pmid = meta.get("primaryMediaId")
                if isinstance(pmid, str) and pmid.strip():
                    return pmid.strip()
    except Exception:
        pass
    try:
        media = obj.get("media") if isinstance(obj, dict) else None
        if isinstance(media, list):
            for m in media:
                if not isinstance(m, dict):
                    continue
                name = m.get("name")
                if isinstance(name, str) and name.strip():
                    return name.strip()
    except Exception:
        pass
    return None


async def _upscale_master_image_to_2k_via_api(
    page: Page,
    *,
    profile_id: str,
    response_body: str,
    save_path: Path,
    session_id: str,
    project_id: str,
    access_token: str,
    first_media: Optional[Dict[str, Any]] = None,
) -> bool:
    """Upscale master image to 2K via upsampleImage API; write to save_path."""
    media_id = _extract_best_media_id_from_generate_response(response_body)
    if not media_id and first_media:
        media_id = str(first_media.get("mediaId") or first_media.get("name") or "").strip() or None
    if not media_id:
        print("[VEO Master API] ⚠️ Thiếu mediaId cho upscale 2K.")
        return False

    ptag = profile_id[-4:]
    recaptcha_up = await fetch_recaptcha_token_via_page(
        page,
        prompt_for_token="a",
        timeout=30,
        stabilize_seconds=3,
    )
    if not recaptcha_up:
        print(f"[VEO Master API] [{ptag}] ⚠️ Không lấy được token upscale 2K.")
        return False

    if not _load_auth_config(profile_id):
        await refresh_veo_auth_fast(page, profile_id=profile_id)
    current_auth = _load_auth_config(profile_id) or {}
    current_access_token = str(current_auth.get("access_token") or access_token)

    try:
        async with veo_api_request_slot(
            profile_tag=ptag,
            label="upscale master",
            log_prefix="VEO Master API",
            max_in_flight=MAX_IN_FLIGHT,
            stop_check=lambda: _STOP_SIGNAL.is_set(),
        ):
            up = await request_upsample_image_via_browser(
                page,
                media_id=media_id,
                recaptcha_token=recaptcha_up,
                session_id=session_id,
                project_id=project_id,
                access_token=current_access_token,
                target_resolution="UPSAMPLE_IMAGE_RESOLUTION_2K",
                timeout_ms=120_000,
            )
    except Exception as e:
        print(f"[VEO Master API] [{ptag}] ⚠️ upscale exception: {e}")
        return False

    if not up.get("ok"):
        print(f"[VEO Master API] [{ptag}] ⚠️ upscale thất bại status={up.get('status')}")
        return False

    data = up.get("json") or {}
    encoded = str(data.get("encodedImage") or "").replace("\n", "").replace(" ", "")
    if not encoded:
        return False
    try:
        import base64

        save_path.write_bytes(base64.b64decode(encoded))
        print(f"[VEO Master API] [{ptag}] ✅ Master upscale 2K OK → {save_path}")
        return True
    except Exception as e:
        print(f"[VEO Master API] [{ptag}] ⚠️ decode encodedImage lỗi: {e}")
        return False


async def generate_master_image_via_api_for_page(
    page: Page,
    script_path: str,
    *,
    profile_id: str,
    ratio: str = "16:9",
    model: Optional[str] = None,
    character_name: Optional[str] = None,
    reference_image_resolution: Optional[str] = None,
    timeout: int = TIMEOUT_ANH,
    token_timeout: int = TOKEN_TIMEOUT,
) -> Dict[str, Any]:
    """
    Tạo Master Image (master_image_url) qua API VEO (flowMedia:batchGenerateImages) cho MỘT profile.

    - Reuse cùng cơ chế auth + recaptcha token + API như scene.
    - Chỉ dùng driver/profile đầu tiên (được gọi từ endpoint riêng).
    - Nếu có character_name: lưu vào sample/{script_name}/{character_name}.png (cho vẽ nhân vật)
    - Nếu không có: lưu vào sample/{script_name}.png (cho vẽ ref cũ)
    """
    if _STOP_SIGNAL.is_set():
        print("[VEO Master API] 🛑 Bỏ qua master image vì đã nhận lệnh Stop.")
        return {"ok": False, "error": "stopped"}

    # Resolve script + đọc master_cast_image_prompt
    abs_script_path = _resolve_script_path(script_path)
    if not abs_script_path or not os.path.exists(abs_script_path):
        print(f"[VEO Master API] ❌ File script không tồn tại: {script_path} (resolved: {abs_script_path})")
        return {"ok": False, "error": f"file_not_found: {script_path}"}

    try:
        with open(abs_script_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[VEO Master API] ❌ Lỗi đọc file script: {e}")
        return {"ok": False, "error": f"read_error: {e}"}

    master_prompt = (data or {}).get("master_cast_image_prompt")
    if not master_prompt:
        print("[VEO Master API] ❌ Thiếu master_cast_image_prompt trong script.")
        return {"ok": False, "error": "missing_master_cast_image_prompt"}

    script_dir = Path(abs_script_path).parent
    mode_dir = script_dir.parent
    script_name = Path(abs_script_path).stem
    
    # Nếu có character_name: lưu vào sample/{script_name}/{character_name}.png
    # Nếu không: lưu vào sample/{script_name}.png (vẽ ref cũ)
    if character_name:
        import re
        safe_char_name = re.sub(r'[^\w\-]', '_', character_name)
        sample_dir = mode_dir / "sample" / script_name
        sample_dir.mkdir(parents=True, exist_ok=True)
        save_path = sample_dir / f"{safe_char_name}.png"
        rel_path = f"sample/{script_name}/{safe_char_name}.png"
    else:
        sample_dir = mode_dir / "sample"
        sample_dir.mkdir(parents=True, exist_ok=True)
        save_path = sample_dir / f"{script_name}.png"
        rel_path = f"sample/{script_name}.png"

    # 1. Load auth
    print(f"[VEO Master API] 🚀 Bắt đầu tạo Master Image qua API cho profile {profile_id[-4:]}...")
    auth = _load_auth_config(profile_id)
    if not auth:
        await refresh_veo_auth_fast(page, profile_id=profile_id)
        auth = _load_auth_config(profile_id)
    if not auth:
        print("[VEO Master API] ❌ Thiếu sessionId/projectId/access_token sau khi auto_collect.")
        await update_master_image_status(abs_script_path, "error")
        return {"ok": False, "error": "missing_auth_config"}

    session_id = auth["sessionId"]
    project_id = auth["projectId"]
    access_token = auth["access_token"]

    # 2. Aspect ratio + model
    aspect_ratio_const = image_aspect_const_from_ui_ratio(ratio)
    model_key = _resolve_model_key_from_frontend(model)

    browser_req_timeout_ms = max(30_000, int(timeout * 1000))

    # 3. Lấy recaptcha token (giống scene)
    await update_master_image_status(abs_script_path, "processing")
    print("[VEO Master API] ⏳ Đang lấy recaptcha token cho master image...")
    recaptcha_token: Optional[str] = None
    max_token_attempts = 3
    for attempt in range(max_token_attempts):
        if _STOP_SIGNAL.is_set():
            print("[VEO Master API] 🛑 Dừng khi đang lấy recaptcha token.")
            return {"ok": False, "error": "stopped"}

        print(
            f"[VEO Master API] 🔄 Thử lấy recaptcha token cho master image "
            f"(lần {attempt + 1}/{max_token_attempts})..."
        )
        token = await fetch_recaptcha_token_via_page(
            page,
            prompt_for_token="a",
            # Master image: tăng timeout lên 30s để tránh timeout sớm
            timeout=30,
            # Đợi 3s cho route + listener ổn định trước khi gửi prompt "a"
            stabilize_seconds=3,
        )
        if token:
            recaptcha_token = token
            break

        print(
            f"[VEO Master API] ⚠️ Không lấy được recaptcha token ở lần {attempt + 1}. "
            "Sẽ thử lại sau 5s nếu còn lượt."
        )
        await asyncio.sleep(5)

    if not recaptcha_token:
        print("[VEO Master API] ⚠️ Timeout hoặc lỗi khi lấy recaptcha token cho master image.")
        await update_master_image_status(abs_script_path, "captcha_error")
        return {"ok": False, "error": "recaptcha_token_failed"}

    print("[VEO Master API] ✅ Đã lấy được recaptcha token cho master image. Chuẩn bị gửi batchGenerateImages...")
    # 4. Gửi API tạo ảnh master
    payload_kwargs: Dict[str, Any] = {"aspect_ratio": aspect_ratio_const, "output_count": 1}
    if model_key:
        payload_kwargs["model_key"] = model_key

    payload = build_generate_image_payload(
        master_prompt,
        session_id,
        project_id,
        recaptcha_token,
        **payload_kwargs,
    )
    image_api_url = build_generate_image_url(project_id)

    max_retries = 2
    response: Optional[Dict[str, Any]] = None
    consecutive_403 = 0
    for attempt in range(max_retries + 1):
        if _STOP_SIGNAL.is_set():
            print("[VEO Master API] 🛑 Dừng khi đang gọi batchGenerateImages cho master.")
            return {"ok": False, "error": "stopped"}
        # Refresh auth nếu cần
        if not _load_auth_config(profile_id):
            await refresh_veo_auth_fast(page, profile_id=profile_id)
        current_auth = _load_auth_config(profile_id) or {}
        current_access_token = str(current_auth.get("access_token") or access_token)
        if attempt == 0:
            print(
                f"[VEO Master API] 📡 Gửi batchGenerateImages (master) lần đầu: "
                f"project_id={project_id}, model={model}, ratio={ratio}"
            )
        else:
            print(
                f"[VEO Master API] 📡 Retry batchGenerateImages (master) lần {attempt + 1}/{max_retries + 1}..."
            )
        try:
            response = await request_generate_images_via_browser(
                page,
                image_api_url,
                payload,
                current_access_token,
                timeout_ms=browser_req_timeout_ms,
            )
        except Exception as e:
            is_timeout = "timeout" in str(e).lower() or "TimeoutError" in type(e).__name__
            if is_timeout and attempt < max_retries:
                print(f"[VEO Master API] ⏱️ Timeout API (attempt {attempt + 1}/{max_retries+1}), retry...")
                await asyncio.sleep(2)
                continue
            print(f"[VEO Master API] ❌ Ngoại lệ API: {e}")
            await update_master_image_status(abs_script_path, "error")
            return {"ok": False, "error": f"api_exception: {e}"}

        if not response:
            print("[VEO Master API] ❌ API trả về response rỗng.")
            await update_master_image_status(abs_script_path, "error")
            return {"ok": False, "error": "empty_response"}

        if response.get("ok"):
            break

        try:
            status_code = int(response.get("status") or 0)
        except Exception:
            status_code = 0

        # 401: chỉ refresh auth rồi retry
        if status_code == 401 and attempt < max_retries:
            print(f"[VEO Master API] 🔑 HTTP 401, refresh auth rồi retry...")
            await refresh_veo_auth_fast(page, profile_id=profile_id)
            await asyncio.sleep(2)
            continue

        # 403: áp dụng ladder nhiều bước
        if status_code == 403 and attempt < max_retries:
            consecutive_403 += 1
            msg = f"HTTP 403 (master) lần {consecutive_403}/{max_retries + 1}"
            print(f"[VEO Master API] ⚠️ {msg}")

            # Lần 1: chỉ log + chờ rồi retry
            if consecutive_403 == 1:
                await asyncio.sleep(WAIT_BETWEEN)
                continue

            # Lần 2: clear storage (không xóa cookie) + reload rồi retry
            if consecutive_403 == 2:
                print("[VEO Master API] 🧹 Lần 2 lỗi 403 liên tiếp → clear storage + reload page rồi retry...")
                await _clear_flow_storage_and_reload(page)
                await asyncio.sleep(WAIT_BETWEEN)
                continue

            # Lần 3+: không retry thêm trong vòng lặp này
            print("[VEO Master API] ⛔ Lỗi 403 lặp lại nhiều lần cho master image, dừng retry.")

        if status_code == 429:
            print("[VEO Master API] ⚠️ Hết quota (HTTP 429) khi tạo master image.")
            await update_master_image_status(abs_script_path, "quota_exceeded")
            return {"ok": False, "error": "quota_exceeded"}

        if attempt < max_retries:
            print(f"[VEO Master API] ⚠️ HTTP {status_code}, retry attempt {attempt + 1}/{max_retries+1}...")
            await asyncio.sleep(2)
            continue

        print(f"[VEO Master API] ❌ API lỗi status={status_code}, bỏ cuộc.")
        await update_master_image_status(abs_script_path, "error")
        return {
            "ok": False,
            "error": f"api_error_status_{status_code}",
            "status": status_code,
        }

    if not response or not response.get("ok"):
        print("[VEO Master API] ❌ API thất bại sau khi retry.")
        await update_master_image_status(abs_script_path, "error")
        return {"ok": False, "error": "api_failed"}

    medias = parse_media_from_response(str(response.get("body") or ""))
    if not medias:
        print("[VEO Master API] ❌ Không tìm thấy media nào trong response.")
        await update_master_image_status(abs_script_path, "error")
        return {"ok": False, "error": "no_media_in_response"}

    first = medias[0]
    download_url = first.get("downloadUrl")
    if not download_url:
        print("[VEO Master API] ❌ media không có downloadUrl.")
        await update_master_image_status(abs_script_path, "error")
        return {"ok": False, "error": "missing_download_url"}

    want_2k = str(reference_image_resolution or "").strip().lower() == "2k"
    response_body = str(response.get("body") or "")

    if want_2k:
        print("[VEO Master API] 🔼 Chế độ 2K: upscale master qua API...")
        upscale_ok = await _upscale_master_image_to_2k_via_api(
            page,
            profile_id=profile_id,
            response_body=response_body,
            save_path=save_path,
            session_id=session_id,
            project_id=project_id,
            access_token=access_token,
            first_media=first if isinstance(first, dict) else None,
        )
        if not upscale_ok:
            print("[VEO Master API] ⚠️ Upscale 2K thất bại, fallback tải 1K...")
            want_2k = False

    if not want_2k:
        print(f"[VEO Master API] 📥 Đang tải master image về: {save_path}")
        ok = await download_image_requests(download_url, str(save_path))
        if not ok:
            print("[VEO Master API] ❌ Lỗi tải file master image.")
            await update_master_image_status(abs_script_path, "error")
            return {"ok": False, "error": "download_failed"}

    # CHỈ lưu vào master_image_url khi KHÔNG có character_name (vẽ ref cũ)
    # Khi có character_name (vẽ nhân vật): chỉ trả về image_url, KHÔNG lưu vào master_image_url
    if not character_name:
        await update_master_image_path(abs_script_path, rel_path)
        print(f"[VEO Master API] 💾 Đã lưu đường dẫn ảnh vào JSON.")
    
    print(f"[VEO Master API] ✅ Tạo master image thành công: {rel_path}")
    return {"ok": True, "image_url": rel_path}


async def generate_youtube_images_via_api_for_page(
    page: Page,
    scene_tasks: List[Dict[str, Any]],
    script_path: str,
    *,
    profile_id: str,
    yt_use_reference_image: bool = False,
    use_cast_profile_references: bool = False,
    reference_media_name: Optional[str] = None,
    cast_reference_media_by_name: Optional[Dict[str, str]] = None,
    ratio: str = "16:9",
    model: Optional[str] = None,
    timeout: int = TIMEOUT_ANH,
    token_timeout: int = TOKEN_TIMEOUT,
    wait_between: int = WAIT_BETWEEN,
    max_in_flight: int = MAX_IN_FLIGHT,
    inflight_lock: Optional[asyncio.Lock] = None,
    in_progress_count: Optional[List[int]] = None,
) -> Dict[int, Dict[str, Any]]:

    """
    Helper: chọn mediaId "đẹp" (UUID) từ response tạo ảnh để dùng cho upscale.
    Ưu tiên:
    - workflows[].metadata.primaryMediaId
    - media[].name
    """
    def _extract_best_media_id_from_generate_response(body: str) -> Optional[str]:
        try:
            obj = json.loads(body or "{}")
        except Exception:
            return None

        try:
            workflows = obj.get("workflows") if isinstance(obj, dict) else None
            if isinstance(workflows, list):
                for wf in workflows:
                    if not isinstance(wf, dict):
                        continue
                    meta = wf.get("metadata") or {}
                    pmid = meta.get("primaryMediaId")
                    if isinstance(pmid, str) and pmid.strip():
                        return pmid.strip()
        except Exception:
            pass

        try:
            media = obj.get("media") if isinstance(obj, dict) else None
            if isinstance(media, list):
                for m in media:
                    if not isinstance(m, dict):
                        continue
                    name = m.get("name")
                    if isinstance(name, str) and name.strip():
                        return name.strip()
        except Exception:
            pass

        return None
    """
    Chạy workflow tạo ảnh YouTube bằng API trên MỘT Flow Page đã setup sẵn (mode=image).

    - page: Playwright Page đã sẵn sàng trong project + đã setup Batch (gọi từ nst_profile_cache_setup).
    - scene_tasks: danh sách prompt ảnh theo thứ tự scene.
    - ratio: "16:9" hoặc "9:16".
    - timeout: timeout tối đa cho API trả ảnh (giây, mặc định 80). Quá thì FAILED + retry nếu còn lượt.
    - token_timeout: timeout lấy recaptcha token từ Chrome (giây, mặc định 60).
    - wait_between: 15s sau khi gửi prompt "a" mới gửi prompt "a" tiếp (không đợi tải ảnh xong).
    - max_in_flight: tối đa 3 job đang xử lý cùng lúc. Nếu in_progress >= max_in_flight thì chờ 5s rồi kiểm tra lại.
    """
    if not scene_tasks:
        return {}

    # 1. Load auth (sessionId/projectId/access_token/cookie)
    auth = _load_auth_config(profile_id)
    if not auth:
        # Thử tự lấy auth từ Flow UI (bắt request thật) rồi load lại
        await refresh_veo_auth_fast(page, profile_id=profile_id)
        auth = _load_auth_config(profile_id)
    if not auth:
        print(
            "[VEO Image API] ❌ Thiếu sessionId/projectId/access_token. "
            "Vui lòng cấu hình ở backend/config/veo_auth.json."
        )
        return {i + 1: {"ok": False, "error": "missing_auth_config"} for i in range(len(scene_tasks))}

    session_id = auth["sessionId"]
    project_id = auth["projectId"]
    access_token = auth["access_token"]

    # 2. Aspect ratio theo input (16:9 … 3:4)
    aspect_ratio_const = image_aspect_const_from_ui_ratio(ratio)

    # 3. Model key theo model frontend (nếu có)
    model_key = _resolve_model_key_from_frontend(model)

    # 4. Timeout gửi request qua browser
    browser_req_timeout_ms = max(30_000, int(timeout * 1000))

    ptag_inflight = profile_id[-4:]

    # Resolve script + chuẩn bị thư mục images giống Playwright:
    # storage/projects/<project>/images/<script_name>
    abs_script_path = _resolve_script_path(script_path)
    if not abs_script_path or not os.path.exists(abs_script_path):
        return {"error": f"File không tồn tại: {script_path} (resolved: {abs_script_path})"}

    script_name = Path(abs_script_path).stem
    project_dir = Path(abs_script_path).resolve().parents[1]
    images_output_dir = project_dir / "images" / script_name
    images_output_dir.mkdir(parents=True, exist_ok=True)

    # Tab NEW: upload batch ảnh nhân vật; media_id nhớ theo profile (RAM), không ghi JSON.
    cast_media_by_name: Dict[str, str] = dict(cast_reference_media_by_name or {})
    if yt_use_reference_image and use_cast_profile_references:
        cast_media_by_name, upload_err = await resolve_cast_reference_media_for_profile(
            page,
            script_path,
            profile_id=profile_id,
            project_id=str(project_id),
            access_token=access_token,
            cache=cast_media_by_name,
            log_prefix="VEO Image API",
        )
        if upload_err:
            print(
                f"[VEO Image API] [{profile_id[-4:]}] ❌ Cast reference upload: {upload_err}"
            )
            return {
                i + 1: {"ok": False, "error": upload_err} for i in range(len(scene_tasks))
            }
        raw_profiles, _ = load_cast_profiles_from_script(script_path)
        cast_profiles_cache = build_profiles_with_media_ids(raw_profiles, cast_media_by_name)
        enrich_scene_tasks_with_cast_references(
            scene_tasks,
            cast_profiles_cache,
            media_map=cast_media_by_name,
            log_prefix="VEO Image API",
            profile_tag=profile_id[-4:],
        )
        print(
            f"[VEO Image API] [{profile_id[-4:]}] 🖼️ Cast refs ready "
            f"({len(cast_media_by_name)} media_id cho profile này)"
        )

    # Ảnh tham chiếu (cũ): upload master_image_url 1 lần / profile.
    # Nếu reference_media_name đã được truyền vào (từ lần trước) thì dùng lại, KHÔNG upload lại.
    ref_name: Optional[str] = reference_media_name
    if (
        yt_use_reference_image
        and not use_cast_profile_references
        and not ref_name
    ):
        try:
            data_for_ref = json.loads(Path(abs_script_path).read_text(encoding="utf-8"))
        except Exception:
            data_for_ref = {}
        master_rel = str((data_for_ref or {}).get("master_image_url") or "").strip()
        if not master_rel:
            print(f"[VEO Image API] [{profile_id[-4:]}] ❌ Bật ảnh tham chiếu nhưng script thiếu master_image_url.")
            return {
                i + 1: {"ok": False, "error": "missing_master_image_url"} for i in range(len(scene_tasks))
            }
        master_abs = (project_dir / master_rel).resolve()
        if not master_abs.exists():
            print(
                f"[VEO Image API] [{profile_id[-4:]}] ❌ Không tìm thấy ảnh tham chiếu: {master_abs}"
            )
            return {
                i + 1: {"ok": False, "error": "missing_master_image_file"} for i in range(len(scene_tasks))
            }

        current_auth = _load_auth_config(profile_id) or {}
        current_access_token = str(current_auth.get("access_token") or access_token)
        upload_payload = build_payload_upload_image(
            image_path=str(master_abs),
            project_id=str(project_id),
        )

        # Upload ảnh tham chiếu với timeout + retry để tránh treo
        max_upload_retries = 2
        upload_res: Optional[Dict[str, Any]] = None
        for attempt in range(max_upload_retries + 1):
            try:
                print(
                    f"[VEO Image API] [{profile_id[-4:]}] 📤 Upload ảnh tham chiếu "
                    f"(lần {attempt + 1}/{max_upload_retries + 1})..."
                )
                upload_res = await request_upload_image_via_browser(
                    page,
                    upload_payload,
                    current_access_token,
                    timeout_ms=60_000,  # Tăng timeout lên 60s cho file ảnh lớn (>20MB)
                )
            except Exception as e:
                print(
                    f"[VEO Image API] [{profile_id[-4:]}] ⚠️ Ngoại lệ khi upload ảnh tham chiếu: {e}"
                )
                upload_res = {"ok": False, "error": str(e)}

            if upload_res.get("ok"):
                break

            if attempt < max_upload_retries:
                print(
                    f"[VEO Image API] [{profile_id[-4:]}] ⚠️ Upload ảnh tham chiếu thất bại "
                    f"(status={upload_res.get('status')}, err={upload_res.get('error')}). "
                    "Sẽ thử lại sau 3s..."
                )
                await asyncio.sleep(3)

        if not upload_res or not upload_res.get("ok"):
            print(
                f"[VEO Image API] [{profile_id[-4:]}] ❌ Upload ảnh tham chiếu thất bại hoàn toàn: "
                f"status={upload_res.get('status')} err={upload_res.get('error')}"
            )
            return {
                i + 1: {"ok": False, "error": "reference_upload_failed"} for i in range(len(scene_tasks))
            }

        ref_name = extract_media_id(str(upload_res.get("body") or ""))
        if not ref_name:
            print(f"[VEO Image API] [{profile_id[-4:]}] ❌ Upload OK nhưng không trích được media name.")
            return {
                i + 1: {"ok": False, "error": "reference_upload_no_media_id"} for i in range(len(scene_tasks))
            }
        print(
            f"[VEO Image API] [{profile_id[-4:]}] 🖼️ Đã upload ảnh tham chiếu: name={ref_name}"
        )

    results: Dict[int, Dict[str, Any]] = {}
    # Rate-limit token: đảm bảo giữa 2 lần bắn prompt "a" (bắt token) tối thiểu wait_between giây.
    token_lock = asyncio.Lock()
    last_token_sent_ts: List[float] = []  # dùng list để pass-by-ref
    pending_api_tasks: List[asyncio.Task] = []
    quota_stop = asyncio.Event()
    consecutive_403 = 0

    async def _rate_limited_fetch_token(*, label: str, timeout_s: int) -> Optional[str]:
        """
        Đảm bảo chỉ gửi prompt "a" để lấy token sau mỗi wait_between giây (theo profile).
        Áp dụng cho cả token tạo ảnh và token upscale để tránh spam quá nhanh.
        """
        async with token_lock:
            if last_token_sent_ts:
                while True:
                    if _STOP_SIGNAL.is_set():
                        return None
                    elapsed = time.time() - last_token_sent_ts[0]
                    if elapsed >= wait_between:
                        break
                    wait_more = wait_between - elapsed
                    print(f"[VEO Image API] [{profile_id[-4:]}] ⏳ {label} chờ {wait_more:.1f}s trước khi lấy token (rate limit)...")
                    await asyncio.sleep(min(1.0, max(0.0, wait_between - elapsed)))
            if _STOP_SIGNAL.is_set():
                return None
            # cập nhật timestamp NGAY TRƯỚC khi fetch (vì hàm sẽ bắn prompt "a" bên trong)
            if last_token_sent_ts:
                last_token_sent_ts[0] = time.time()
            else:
                last_token_sent_ts.append(time.time())

        print(f"[VEO Image API] [{profile_id[-4:]}] 🔑 {label} bắt đầu lấy recaptcha token (timeout={timeout_s}s)...")
        try:
            token = await fetch_recaptcha_token_via_page(
                page,
                prompt_for_token="a",
                timeout=timeout_s,
            )
            if token:
                print(f"[VEO Image API] [{profile_id[-4:]}] ✅ {label} đã lấy token thành công (len={len(token)})")
            else:
                print(f"[VEO Image API] [{profile_id[-4:]}] ❌ {label} lấy token thất bại (trả về None)")
            return token
        except Exception as e:
            print(f"[VEO Image API] [{profile_id[-4:]}] ⚠️ {label} lấy token lỗi: {e}")
            return None

    async def _api_and_download(
        jid: int,
        sid: int,
        payload: dict,
        url: str,
        *,
        use_upscale_2k: bool = False,
    ) -> None:
        """Gửi API + (tuỳ mode) upscale + tải ảnh chạy nền; không block vòng lặp chính."""
        if _STOP_SIGNAL.is_set():
            return
        nonlocal consecutive_403
        try:
            max_retries = 2
            response: Optional[Dict[str, Any]] = None
            last_exc: Optional[Exception] = None

            for attempt in range(max_retries + 1):
                if _STOP_SIGNAL.is_set():
                    return
                try:
                    # Nếu thiếu/expired auth thì tự refresh trước khi gửi
                    if not _load_auth_config(profile_id):
                        await refresh_veo_auth_fast(page, profile_id=profile_id)
                    current_auth = _load_auth_config(profile_id) or {}
                    current_access_token = str(current_auth.get("access_token") or access_token)
                    async with veo_api_request_slot(
                        profile_tag=ptag_inflight,
                        label=f"create job={jid} scene={sid}",
                        log_prefix="VEO Image API",
                        max_in_flight=max_in_flight,
                        stop_check=lambda: _STOP_SIGNAL.is_set(),
                    ):
                        response = await request_generate_images_via_browser(
                            page,
                            url,
                            payload,
                            current_access_token,
                            timeout_ms=browser_req_timeout_ms,
                        )
                except Exception as e:
                    last_exc = e
                    is_timeout = "timeout" in str(e).lower() or "TimeoutError" in type(e).__name__
                    if is_timeout and attempt < max_retries:
                        print(f"[VEO Image API] [{profile_id[-4:]}] ⏱️ job={jid} scene={sid} timeout, retry...")
                        await asyncio.sleep(2)
                        continue
                    print(f"[VEO Image API] ❌ [{jid}] API exception: {e}")
                    results[jid] = {
                        "ok": False,
                        "error": f"api_exception: {e}",
                        "scene_id": sid,
                        "status": "FAILED" if is_timeout else "error",
                    }
                    # Lỗi API (không phải timeout) thường là lỗi tạm thời (token/auth/network).
                    # Không đánh content_error để còn retry ở lượt sau.
                    await update_scene_status(script_path, sid, "FAILED" if is_timeout else "processing")
                    return

                if not response:
                    return
                if response.get("ok"):
                    break

                # 401/403: access_token hết hạn/không hợp lệ → tự refresh rồi retry
                try:
                    status_code = int(response.get("status") or 0)
                except Exception:
                    status_code = 0

                # 401: chỉ refresh auth rồi retry
                if status_code == 401 and attempt < max_retries:
                    print(
                        f"[VEO Image API] [{profile_id[-4:]}] 🔑 job={jid} scene={sid} "
                        f"HTTP 401, refresh auth rồi retry..."
                    )
                    await refresh_veo_auth_fast(page, profile_id=profile_id)
                    await asyncio.sleep(2)
                    continue

                # 403: ladder nhiều bước (theo profile)
                if status_code == 403 and attempt < max_retries:
                    consecutive_403 += 1
                    msg = (
                        f"HTTP 403 (job={jid}, scene={sid}) lần {consecutive_403}/{max_retries + 1}"
                    )
                    print(f"[VEO Image API] [{profile_id[-4:]}] ⚠️ {msg}")

                    # Lần 1: log + đánh FAILED tạm thời + chờ rồi retry
                    if consecutive_403 == 1:
                        await update_scene_status(script_path, sid, "FAILED")
                        await asyncio.sleep(WAIT_BETWEEN)
                        continue

                    # Lần 2: clear storage (không xóa cookie) + reload rồi retry
                    if consecutive_403 == 2:
                        print(
                            f"[VEO Image API] [{profile_id[-4:]}] 🧹 Lần 2 lỗi 403 liên tiếp "
                            f"(job={jid}, scene={sid}) → clear storage + reload page rồi retry..."
                        )
                        await _clear_flow_storage_and_reload(page)
                        await asyncio.sleep(WAIT_BETWEEN)
                        continue

                    # Lần 3+: không retry thêm trong vòng lặp này, yêu cầu worker restart profile
                    print(
                        f"[VEO Image API] [{profile_id[-4:]}] ⛔ Lỗi 403 lặp lại nhiều lần "
                        f"cho job={jid}, scene={sid}, dừng retry."
                    )
                    results["__need_restart_profile__"] = True
                    pending_scenes = results.get("__pending_scenes__", [])
                    if isinstance(pending_scenes, set):
                        buf = pending_scenes
                    else:
                        buf = set(pending_scenes or [])
                    buf.add(sid)
                    results["__pending_scenes__"] = list(buf)
                    return

                # 429: hết quota → đánh dấu riêng, không retry API nữa (để user chuyển sang Playwright)
                if status_code == 429:
                    results[jid] = {
                        "ok": False,
                        "status": 429,
                        "error": "quota_exceeded",
                        "body": (response.get("body") or "")[:500],
                        "scene_id": sid,
                    }
                    await update_scene_status(script_path, sid, "quota_exceeded")
                    quota_stop.set()
                    return

                err_str = str(response.get("error") or response.get("body") or "")
                if "timeout" in err_str.lower() and attempt < max_retries:
                    await asyncio.sleep(2)
                    continue
                break

            if last_exc and not response:
                return

            if not response or not response.get("ok"):
                resp = response or {}
                status_code = resp.get("status")
                body_snip = (resp.get("body") or "")[:500]
                err = resp.get("error")
                print(
                    f"[VEO Image API] [{profile_id[-4:]}] ❌ job={jid} scene={sid} API lỗi: "
                    f"status={status_code} error={err} body_snip={(body_snip or '')[:120]}"
                )
                if status_code == 429:
                    results[jid] = {
                        "ok": False,
                        "status": 429,
                        "error": "quota_exceeded",
                        "body": body_snip,
                        "scene_id": sid,
                    }
                    await update_scene_status(script_path, sid, "quota_exceeded")
                    quota_stop.set()
                    return
                results[jid] = {
                    "ok": False,
                    "status": status_code,
                    "error": resp.get("error"),
                    "body": body_snip,
                    "scene_id": sid,
                }
                # Lỗi HTTP != 401/403 ở API mode thường là lỗi tạm thời (quota/transient/backend),
                # không coi là content policy.
                await update_scene_status(script_path, sid, "FAILED" if status_code in (401, 403) else "processing")
                return

            body = response.get("body") or ""
            medias = parse_media_from_response(body) or []
            if not medias:
                results[jid] = {"ok": False, "error": "no_media_in_response", "body": body[:500], "scene_id": sid}
                await update_scene_status(script_path, sid, "processing")
                return

            first = medias[0]
            download_url = first.get("downloadUrl") or first.get("uri") or first.get("fifeUrl")
            if not download_url:
                results[jid] = {"ok": False, "error": "media_missing_download_url", "scene_id": sid}
                await update_scene_status(script_path, sid, "processing")
                return

            # Mặc định đường dẫn ảnh (dùng cho cả upscale/fallback)
            rel_path = f"images/{script_name}/{sid:03d}.png" if sid > 0 else f"images/{script_name}/job_{jid}.png"
            out_path = images_output_dir / (f"{sid:03d}.png" if sid > 0 else f"job_{jid}.png")

            # Nếu không bật 2k: tải ảnh thường như cũ
            if not use_upscale_2k:
                ok = await download_image_requests(download_url, str(out_path))
                if ok:
                    print(f"[VEO Image API] [{profile_id[-4:]}] 🎉 job={jid} scene={sid} OK → {out_path}")
                    results[jid] = {"ok": True, "image_path": rel_path, "download_url": download_url, "scene_id": sid}
                    await update_scene_status(script_path, sid, "done", rel_path)
                else:
                    print(f"[VEO Image API] [{profile_id[-4:]}] ❌ job={jid} scene={sid} tải ảnh thất bại.")
                    results[jid] = {
                        "ok": False,
                        "error": "download_failed",
                        "download_url": download_url,
                        "scene_id": sid,
                    }
                    await update_scene_status(script_path, sid, "processing")
                return

            # --- 2K MODE: Tạo ảnh xong → upscale, chỉ tải ảnh upscale (fallback ảnh thường) ---
            media_id = _extract_best_media_id_from_generate_response(body) or first.get("mediaId")
            media_id = str(media_id or "").strip()
            if not media_id:
                print(f"[VEO Image API] [{profile_id[-4:]}] ⚠️ job={jid} scene={sid} thiếu mediaId cho upscale, tải ảnh gốc.")
                ok = await download_image_requests(download_url, str(out_path))
                if ok:
                    results[jid] = {"ok": True, "image_path": rel_path, "download_url": download_url, "scene_id": sid}
                    await update_scene_status(script_path, sid, "done", rel_path)
                else:
                    results[jid] = {
                        "ok": False,
                        "error": "download_failed",
                        "download_url": download_url,
                        "scene_id": sid,
                    }
                    await update_scene_status(script_path, sid, "processing")
                return

            # Lấy token riêng cho upscale (không dùng token lần trước), vẫn áp dụng rate-limit 15s
            recaptcha_up = await _rate_limited_fetch_token(
                label=f"job={jid} scene={sid} (upscale)",
                timeout_s=TOKEN_TIMEOUT,
            )

            if not recaptcha_up:
                print(f"[VEO Image API] [{profile_id[-4:]}] ⚠️ job={jid} scene={sid} không lấy được token upscale, tải ảnh gốc.")
                ok = await download_image_requests(download_url, str(out_path))
                if ok:
                    results[jid] = {"ok": True, "image_path": rel_path, "download_url": download_url, "scene_id": sid}
                    await update_scene_status(script_path, sid, "done", rel_path)
                else:
                    results[jid] = {
                        "ok": False,
                        "error": "download_failed",
                        "download_url": download_url,
                        "scene_id": sid,
                    }
                    await update_scene_status(script_path, sid, "processing")
                return

            # Gọi upsampleImage, timeout dài hơn để tránh fail do mạng/queue
            upscale_ok = False
            try:
                # refresh access_token trước upscale để giảm lỗi 401/403
                if not _load_auth_config(profile_id):
                    await refresh_veo_auth_fast(page, profile_id=profile_id)
                current_auth = _load_auth_config(profile_id) or {}
                current_access_token = str(current_auth.get("access_token") or access_token)
                async with veo_api_request_slot(
                    profile_tag=ptag_inflight,
                    label=f"upscale job={jid} scene={sid}",
                    log_prefix="VEO Image API",
                    max_in_flight=max_in_flight,
                    stop_check=lambda: _STOP_SIGNAL.is_set(),
                ):
                    up = await request_upsample_image_via_browser(
                        page,
                        media_id=media_id,
                        recaptcha_token=recaptcha_up,
                        session_id=session_id,
                        project_id=project_id,
                        access_token=current_access_token,
                        target_resolution="UPSAMPLE_IMAGE_RESOLUTION_2K",
                        timeout_ms=120_000,
                    )
            except Exception as e:
                print(f"[VEO Image API] [{profile_id[-4:]}] ⚠️ job={jid} scene={sid} upscale exception: {e}")
                up = {"ok": False, "error": str(e)}

            if up.get("ok"):
                data = up.get("json") or {}
                encoded = str(data.get("encodedImage") or "").replace("\n", "").replace(" ", "")
                if encoded:
                    try:
                        import base64

                        out_path.write_bytes(base64.b64decode(encoded))
                        upscale_ok = True
                        print(
                            f"[VEO Image API] [{profile_id[-4:]}] 🎉 job={jid} scene={sid} "
                            f"upscale 2K OK → {out_path}"
                        )
                        results[jid] = {
                            "ok": True,
                            "image_path": rel_path,
                            "download_url": download_url,
                            "scene_id": sid,
                        }
                        await update_scene_status(script_path, sid, "done", rel_path)
                    except Exception as e:
                        print(
                            f"[VEO Image API] [{profile_id[-4:]}] ⚠️ job={jid} scene={sid} "
                            f"decode encodedImage lỗi: {e}"
                        )

            if not upscale_ok:
                # Fallback: tải ảnh thường nếu upscale fails
                try:
                    up_status = up.get("status") if isinstance(up, dict) else None
                    up_err = up.get("error") if isinstance(up, dict) else None
                    up_body = (up.get("body") or "")[:200] if isinstance(up, dict) else ""
                except Exception:
                    up_status, up_err, up_body = None, None, ""
                print(
                    f"[VEO Image API] [{profile_id[-4:]}] ⚠️ job={jid} scene={sid} upscale thất bại "
                    f"(status={up_status}, error={up_err}, body_snip={up_body!r}), tải ảnh gốc."
                )
                ok = await download_image_requests(download_url, str(out_path))
                if ok:
                    results[jid] = {"ok": True, "image_path": rel_path, "download_url": download_url, "scene_id": sid}
                    await update_scene_status(script_path, sid, "done", rel_path)
                else:
                    results[jid] = {
                        "ok": False,
                        "error": "download_failed",
                        "download_url": download_url,
                        "scene_id": sid,
                    }
                    await update_scene_status(script_path, sid, "processing")
        except Exception as e:
            print(
                f"[VEO Image API] [{profile_id[-4:]}] ❌ job={jid} scene={sid} lỗi xử lý ảnh: {e}"
            )
            results[jid] = {
                "ok": False,
                "error": f"api_and_download_exception: {e}",
                "scene_id": sid,
            }
            await update_scene_status(script_path, sid, "processing")

    for job_id, task in enumerate(scene_tasks, start=1):
        if _STOP_SIGNAL.is_set():
            print(f"[VEO Image API] 🛑 Dừng theo lệnh Stop.")
            break
        if quota_stop.is_set():
            print(f"[VEO Image API] [{profile_id[-4:]}] ⛔ Dừng do hết quota (HTTP 429).")
            break
        current_id = job_id
        scene_id = int(task.get("scene_id") or 0)
        text = str(task.get("prompt") or "").strip()
        if not text:
            results[current_id] = {"ok": False, "error": "empty_prompt", "scene_id": scene_id}
            continue

        ptag = profile_id[-4:]
        print(f"[VEO Image API] [{ptag}] 🧩 job={current_id} scene={scene_id} chuẩn bị lấy token: {text[:80]}...")

        # Lấy token, timeout thì retry tối đa 3 lần cho cùng cảnh đó
        recaptcha_token: Optional[str] = None
        token_retries = 3
        for token_attempt in range(token_retries):
            recaptcha_token = await _rate_limited_fetch_token(
                label=f"job={current_id} scene={scene_id}",
                timeout_s=token_timeout,
            )
            if recaptcha_token:
                break
            if token_attempt < token_retries - 1:
                wait_retry = 5
                print(f"[VEO Image API] [{ptag}] ⏱️ job={current_id} scene={scene_id} token timeout, retry {token_attempt + 2}/{token_retries} sau {wait_retry}s...")
                await asyncio.sleep(wait_retry)
        if not recaptcha_token:
            results[current_id] = {"ok": False, "error": "recaptcha_token_failed", "scene_id": scene_id}
            continue

        payload_kwargs: Dict[str, Any] = {"aspect_ratio": aspect_ratio_const, "output_count": 1}
        if model_key:
            payload_kwargs["model_key"] = model_key
        scene_ref_names = [
            str(x).strip()
            for x in (task.get("reference_input_names") or [])
            if str(x or "").strip()
        ]
        if not scene_ref_names and ref_name:
            scene_ref_names = [ref_name]
        if scene_ref_names:
            payload_kwargs["reference_input_names"] = scene_ref_names[:3]
        payload = build_generate_image_payload(text, session_id, project_id, recaptcha_token, **payload_kwargs)
        image_api_url = build_generate_image_url(project_id)
        
        # 🔍 DEBUG: Log payload + cast reference names
        try:
            import json as _json

            payload_debug = _json.loads(_json.dumps(payload))
            if "clientContext" in payload_debug and "recaptchaContext" in payload_debug.get(
                "clientContext", {}
            ):
                payload_debug["clientContext"]["recaptchaContext"]["token"] = "***"
            for req in payload_debug.get("requests", []):
                if "clientContext" in req and "recaptchaContext" in req.get("clientContext", {}):
                    req["clientContext"]["recaptchaContext"]["token"] = "***"
            char_field = str(task.get("character") or "").strip()
            ref_ids = list(task.get("reference_media_ids") or [])
            ref_names_dbg = scene_ref_names[:3] if scene_ref_names else []
            print(
                f"[VEO Image API] [{ptag}] 🔍 IMAGE PAYLOAD scene={scene_id} "
                f"character={char_field!r} reference_input_names={ref_names_dbg} "
                f"reference_media_ids={ref_ids}"
            )
            body = _json.dumps(payload_debug, ensure_ascii=False, indent=2)
            if len(body) > 12000:
                body = body[:12000] + f"\n… (truncated, total {len(body)} chars)"
            print(f"[VEO Image API] [{ptag}] 📦 payload JSON (token masked):\n{body}")
        except Exception as debug_err:
            print(f"[VEO Image API] [{ptag}] ⚠️ Debug logging error: {debug_err}")
        
        print(f"[VEO Image API] [{ptag}] 🚀 job={current_id} scene={scene_id} gửi API: {image_api_url}")

        # Fire API + download nền; slot create/upscale dùng chung veo_api_request_slot (max 3)
        # Nếu frontend gửi độ phân giải YouTube là "2k" → bật chế độ upscale ảnh sau khi tạo xong
        yt_res = str(task.get("yt_resolution") or task.get("youtube_resolution") or "").strip().lower()
        use_upscale_2k = yt_res == "2k"

        pending_api_tasks.append(
            asyncio.create_task(
                _api_and_download(current_id, scene_id, payload, image_api_url, use_upscale_2k=use_upscale_2k)
            )
        )
        # Lấy token xong + gửi request xong → đánh processing (đang thực hiện)
        await update_scene_status(script_path, scene_id, "processing")

    # Chờ tất cả API + tải ảnh xong (hoặc hủy nếu Stop)
    if pending_api_tasks:
        if _STOP_SIGNAL.is_set() or quota_stop.is_set():
            reason = "Stop" if _STOP_SIGNAL.is_set() else "hết quota (429)"
            print(f"[VEO Image API] 🛑 Hủy {len(pending_api_tasks)} task đang chạy do {reason}.")
            for t in pending_api_tasks:
                t.cancel()
        try:
            await asyncio.gather(*pending_api_tasks, return_exceptions=True)
        except asyncio.CancelledError:
            pass

    # Trả reference_media_name về cho caller để có thể reuse sau khi restart profile
    if ref_name:
        # type: ignore[assignment]
        results["__reference_media_name__"] = ref_name  # kiểu phụ: key meta cho orchestrator

    if cast_media_by_name and use_cast_profile_references:
        results[CAST_REFERENCE_MEDIA_META_KEY] = cast_media_by_name

    return results


# ==========================================================
# 4. ORCHESTRATOR: CHẠY CẢ KỊCH BẢN YOUTUBE TRÊN NHIỀU PROFILE (API MODE, KHÔNG ẢNH THAM CHIẾU)
# ==========================================================


async def _execute_youtube_generation_api_async(
    count: int,
    script_path: str,
    *,
    max_scenes: Optional[int] = None,
    start_scene: Optional[int] = None,
    end_scene: Optional[int] = None,
    ratio: Optional[str] = None,
    model: Optional[str] = None,
    yt_video_resolution: Optional[str] = None,
    yt_use_reference_image: bool = False,
    use_cast_profile_references: bool = False,
) -> Dict[str, Any]:
    """
    Orchestrator YouTube cho chế độ API (không ảnh tham chiếu):
    - Đọc script JSON, lấy danh sách scenes chưa done.
    - Chia scene theo profile (round-robin) giống logic Playwright cũ.
    - Với mỗi profile: kết nối Page đang mở Flow (đã setup sẵn từ nst_profile_cache_setup)
      và gọi generate_youtube_images_via_api_for_page cho tập prompt tương ứng.
    - max_in_flight=3: tối đa 3 job đang xử lý cùng lúc; vượt thì chờ 5s rồi kiểm tra lại.
    """
    from typing import Tuple  # local import tránh circular

    _STOP_SIGNAL.clear()
    abs_script_path = _resolve_script_path(script_path)
    if not abs_script_path or not os.path.exists(abs_script_path):
        return {"error": f"File không tồn tại: {script_path} (resolved: {abs_script_path})"}

    try:
        with open(abs_script_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            scenes = data.get("scenes", [])
    except Exception as e:
        return {"error": f"Lỗi đọc file kịch bản: {e}"}

    # Chỉ áp dụng cho YouTube API mode không ảnh tham chiếu → luôn mode image
    effective_ratio = ratio or "16:9"

    nst = NSTBrowserManager()
    api_key_map = _build_profile_api_key_map()
    active_ids = profile_pool_for_run(count, get_settings() or {})

    scenes_to_consider = _filter_scenes_by_range(
        scenes,
        start_scene,
        end_scene,
        max_scenes,
    )
    tasks_to_run: List[Dict[str, Any]] = []
    for s in scenes_to_consider:
        if scene_should_skip_generation(s, abs_script_path):
            continue
        tasks_to_run.append(
                {
                    "scene_id": s["scene_id"],
                    "prompt": s.get("image_prompt") or s.get("video_prompt") or "",
                    "character": str(s.get("character") or "").strip(),
                    # Frontend gửi yt_video_resolution ("1k"/"2k") theo setting của YouTube tab.
                    # API worker sẽ dùng field này để bật upscale 2K sau khi tạo ảnh.
                    "yt_resolution": yt_video_resolution,
                }
            )

    if not tasks_to_run:
        return {"success": True, "message": "Tất cả đã hoàn thành (API)."}

    print(
        f"[Youtube API] ⚙️ Cấu hình: timeout_ảnh={TIMEOUT_ANH}s, token_timeout={TOKEN_TIMEOUT}s, "
        f"wait_between={WAIT_BETWEEN}s, max_in_flight={MAX_IN_FLIGHT}"
    )

    if not active_ids:
        return {"error": "Thiếu danh sách profiles khả dụng cho API mode."}

    settings_api = get_settings() or {}
    is_local_engine = is_chrome_local(settings_api)

    # Đồng bộ với luồng thường: luôn đảm bảo profile đã được start + ready trước khi lấy WS.
    try:
        print(
            f"[Youtube API] 🔄 Đảm bảo profiles đã start cho API mode: "
            f"{[pid[-4:] for pid in active_ids]}"
        )
        await asyncio.to_thread(_ensure_profiles_started, nst, active_ids, api_key_map)
        await _wait_for_profiles_ready(nst, active_ids, api_key_map)
    except Exception as e:
        print(f"[Youtube API] ⚠️ Không đảm bảo start profiles được cho API mode: {e}")

    # Phân scene theo profile (round-robin) giống execute_youtube_generation
    assignments: Dict[str, List[Dict[str, Any]]] = {}
    for pid in active_ids:
        assignments[pid] = []
    for i, task in enumerate(tasks_to_run):
        pid = active_ids[i % len(active_ids)]
        assignments[pid].append(task)

    async def _worker_api(pid: str, tasks: List[Dict[str, Any]]) -> Tuple[str, Dict[int, Dict[str, Any]]]:
        """Worker API cho 1 profile: kết nối page và chạy generate_youtube_images_via_api_for_page."""
        if not tasks or _STOP_SIGNAL.is_set():
            return pid, {}

        api_key = api_key_map.get(pid)
        ws = get_ws_endpoint_for_profile(nst, pid, api_key, settings=settings_api)
        if not ws:
            print(f"[Youtube API] ⚠️ Profile {pid[-4:]} không lấy được WS endpoint.")
            return pid, {}

        page = await connect_and_get_page(ws)
        if not page:
            print(f"[Youtube API] ⚠️ Profile {pid[-4:]} không connect được Playwright.")
            return pid, {}

        try:
            await page.bring_to_front()
            # Đã setup qua /api/nst/run/profile-cache — chỉ refresh auth, không lặp mode/model/1x.
            await _goto_flow_with_profile_cache(
                page,
                pid,
                stop_check=lambda: _STOP_SIGNAL.is_set(),
            )
            print(
                f"[Youtube API] ✅ Profile {pid[-4:]} sẵn sàng API "
                "(refresh auth; bỏ qua setup lặp sau profile-cache)."
            )
        except Exception as e:
            print(
                f"[Youtube API] ⚠️ Không refresh Flow được cho profile {pid[-4:]} trong API mode: {e}"
            )
            return pid, {}

        # Mỗi profile có lock + counter riêng cho max_in_flight
        inflight_lock = asyncio.Lock()
        in_progress_count = [0]

        results_agg: Dict[int, Dict[str, Any]] = {}
        reference_media_name: Optional[str] = None
        cast_reference_media_by_name: Optional[Dict[str, str]] = None
        restart_attempts = 0
        MAX_RESTARTS = 2

        try:
            while tasks and not _STOP_SIGNAL.is_set():
                print(f"[Youtube API] 🚀 Profile {pid[-4:]} chạy {len(tasks)} scene bằng API...")
                results_for_profile = await generate_youtube_images_via_api_for_page(
                    page,
                    tasks,
                    script_path=script_path,
                    profile_id=pid,
                    yt_use_reference_image=yt_use_reference_image,
                    use_cast_profile_references=use_cast_profile_references,
                    reference_media_name=reference_media_name,
                    cast_reference_media_by_name=cast_reference_media_by_name,
                    ratio=effective_ratio,
                    model=model,
                    inflight_lock=inflight_lock,
                    in_progress_count=in_progress_count,
                )

                # Lấy lại reference_media_name (nếu có) từ kết quả để dùng tiếp cho lần restart sau
                if "__reference_media_name__" in results_for_profile:
                    raw_ref = results_for_profile.get("__reference_media_name__")
                    if isinstance(raw_ref, str) and raw_ref:
                        reference_media_name = raw_ref
                    results_for_profile.pop("__reference_media_name__", None)

                if CAST_REFERENCE_MEDIA_META_KEY in results_for_profile:
                    raw_cast = results_for_profile.get(CAST_REFERENCE_MEDIA_META_KEY)
                    if isinstance(raw_cast, dict):
                        cast_reference_media_by_name = raw_cast
                    results_for_profile.pop(CAST_REFERENCE_MEDIA_META_KEY, None)

                need_restart = bool(results_for_profile.get("__need_restart_profile__"))
                pending_scenes = set(results_for_profile.get("__pending_scenes__", []) or [])

                # Bỏ flag điều khiển ra khỏi dict kết quả chi tiết
                results_for_profile.pop("__need_restart_profile__", None)
                results_for_profile.pop("__pending_scenes__", None)

                # Gộp kết quả vào tổng
                results_agg.update(results_for_profile)

                if not need_restart or not pending_scenes:
                    break

                if restart_attempts >= MAX_RESTARTS:
                    print(
                        f"[VEO API] ⛔ Profile {pid[-4:]} đã restart đủ {MAX_RESTARTS} lần liên tiếp vì 403, dừng hẳn profile này cho run hiện tại."
                    )
                    # Tắt hẳn NST profile này, không bật lại nữa trong run này
                    try:
                        _stop_profiles_by_key(nst, [pid], api_key_map)
                    except Exception as e:
                        print(f"[VEO API] ⚠️ stop_profiles khi dừng hẳn profile {pid[-4:]} lỗi: {e}")
                    break

                restart_attempts += 1
                print(
                    f"[VEO API] 🔁 Restart profile {pid[-4:]} lần {restart_attempts}/{MAX_RESTARTS} "
                    f"do lỗi 403 lặp lại, còn {len(pending_scenes)} scene chưa xong..."
                )

                new_page = await _restart_nst_profile_and_reconnect(
                    nst,
                    api_key_map,
                    pid,
                    ratio=effective_ratio,
                    model=model,
                )
                if not new_page:
                    print(f"[VEO API] ❌ Restart profile {pid[-4:]} thất bại, dừng.")
                    break

                page = new_page
                tasks = [t for t in tasks if int(t.get("scene_id") or 0) in pending_scenes]
        finally:
            try:
                if is_local_engine:
                    await detach_browser_session(ws)
                else:
                    await cleanup_browser(ws)
            except Exception:
                pass

        return pid, results_agg

    # Chạy song song trên nhiều profile
    worker_tasks = []
    for pid, assigned_tasks in assignments.items():
        if not assigned_tasks:
            continue
        worker_tasks.append(_worker_api(pid, assigned_tasks))

    if not worker_tasks:
        return {"error": "Không có scene nào được gán cho profiles trong API mode."}

    await set_script_running_state(script_path, True)

    try:
        worker_results = await asyncio.gather(*worker_tasks, return_exceptions=False)
    finally:
        await set_script_run_finished(script_path)

    summary: Dict[str, Any] = {
        "success": True,
        "profiles": {},
    }
    # Sau khi có kết quả, cập nhật status + image_url vào script JSON giống Playwright
    for pid, res in worker_results:
        summary["profiles"][pid] = res
        for _, info in res.items():
            if not isinstance(info, dict):
                continue
            scene_id = int(info.get("scene_id") or 0)
            image_path = info.get("image_path")
            if not scene_id:
                continue
            if info.get("ok") and image_path:
                # Đánh dấu done + lưu đường dẫn ảnh (RELATIVE path như Playwright)
                await update_scene_status(script_path, scene_id, "done", image_path)
            else:
                # Đánh dấu lỗi: FAILED nếu timeout, còn lại giữ processing để lượt sau retry.
                status_to_set = "FAILED" if info.get("status") == "FAILED" else "processing"
                await update_scene_status(script_path, scene_id, status_to_set)

    return summary


def execute_youtube_generation_api(
    count: int,
    script_path: str,
    *,
    max_scenes: Optional[int] = None,
    start_scene: Optional[int] = None,
    end_scene: Optional[int] = None,
    ratio: Optional[str] = None,
    model: Optional[str] = None,
    yt_video_resolution: Optional[str] = None,
    yt_use_reference_image: bool = False,
    use_cast_profile_references: bool = False,
) -> Dict[str, Any]:
    """
    Wrapper sync để gọi từ FastAPI router:
    - Dùng cho YouTube tab, API mode, KHÔNG ảnh tham chiếu.
    - Đăng ký loop vào _RUNNING_LOOPS để stop_all_tasks có thể dừng được.
    """
    if os.name == "nt":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    with _RUNNING_LOOPS_LOCK:
        _RUNNING_LOOPS.add(loop)
    try:
        return loop.run_until_complete(
            _execute_youtube_generation_api_async(
                count,
                script_path,
                max_scenes=max_scenes,
                start_scene=start_scene,
                end_scene=end_scene,
                ratio=ratio,
                model=model,
                yt_video_resolution=yt_video_resolution,
                yt_use_reference_image=yt_use_reference_image,
                use_cast_profile_references=use_cast_profile_references,
            )
        )
    finally:
        with _RUNNING_LOOPS_LOCK:
            _RUNNING_LOOPS.discard(loop)
        loop.close()


async def _execute_master_image_api_async(
    script_path: str,
    ratio: str,
    model: str,
    reference_image_resolution: str = "1k",
) -> Dict[str, Any]:
    """
    Orchestrator tạo Master Image qua API:
    - Dùng driver/profile đầu tiên của NST.
    - Kết nối Flow Page và gọi generate_master_image_via_api_for_page.
    """
    _STOP_SIGNAL.clear()

    nst = NSTBrowserManager()
    api_key_map = _build_profile_api_key_map()
    settings_m = get_settings() or {}
    pool_one = profile_pool_for_run(1, settings_m)
    if not pool_one:
        return {"error": "no_profile_ids"}
    first_driver_id = pool_one[0]

    api_key = api_key_map.get(first_driver_id)
    _ensure_profiles_started(nst, [first_driver_id], api_key_map)
    await _wait_for_profiles_ready(nst, [first_driver_id], api_key_map)

    ws = get_ws_endpoint_for_profile(nst, first_driver_id, api_key, settings=settings_m)
    if not ws:
        return {"error": "ws_not_found"}

    page = await connect_and_get_page(ws)
    if not page:
        return {"error": "connect_failed"}

    # Đảm bảo đang ở đúng Flow project theo profile cache:
    # - Nếu chưa có URL -> goto Flow + tạo project mới và lưu URL.
    # - Nếu có URL nhưng page đang ở chỗ khác -> goto URL đó.
    # - Nếu page đã ở đúng URL -> không goto lại, chỉ setup Batch.
    try:
        await _goto_flow_with_profile_cache(
            page,
            first_driver_id,
            stop_check=lambda: _STOP_SIGNAL.is_set(),
        )
        
    except Exception as e:
        return {"error": f"goto_flow_failed: {e}"}

    # Sau khi project đã sẵn sàng, cần setup đầy đủ giống Playwright master:
    # - Mode: image
    # - Ratio: ngang/dọc theo tham số
    # - Model: theo model ở sidebar
    try:
        print(f"[VEO Master API] ⚙️ Setup mode=image, ratio={ratio}, model={model} cho profile {first_driver_id[-4:]}...")
        ok = await select_mode(page, "image", stop_check=lambda: _STOP_SIGNAL.is_set())
        if not ok:
            return {"error": "select_mode_failed"}
        await asyncio.sleep(0.5)

        await setup_render_settings(
            page,
            output_count=1,
            aspect_ratio=str(ratio or "16:9"),
            model=model,
        )
        await asyncio.sleep(0.5)
    except Exception as e:
        return {"error": f"setup_render_failed: {e}"}

    # Không đóng NST browser sau khi tạo master image (giữ nguyên session cho các bước sau)
    return await generate_master_image_via_api_for_page(
        page,
        script_path,
        profile_id=first_driver_id,
        ratio=ratio,
        model=model,
        reference_image_resolution=reference_image_resolution,
    )


def execute_master_image_api(
    script_path: str,
    ratio: str,
    model: str,
    reference_image_resolution: str = "1k",
) -> Dict[str, Any]:
    """
    Wrapper sync để gọi từ FastAPI router cho master image (API mode).
    """
    if os.name == "nt":
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    with _RUNNING_LOOPS_LOCK:
        _RUNNING_LOOPS.add(loop)
    try:
        return loop.run_until_complete(
            _execute_master_image_api_async(
                script_path=script_path,
                ratio=ratio,
                model=model,
                reference_image_resolution=reference_image_resolution,
            )
        )
    finally:
        with _RUNNING_LOOPS_LOCK:
            _RUNNING_LOOPS.discard(loop)
        loop.close()

