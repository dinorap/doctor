import asyncio
import json
import re
import time as _time_mod
import weakref
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, List, Callable

from playwright.async_api import Page, TimeoutError  # type: ignore

from services.flow_actions import send_prompt_text, goto_flow_and_open_project  # type: ignore
from utils.path_helper import CONFIG_DIR
from utils.veo_auth_secure import read_veo_auth, write_veo_auth, write_plaintext_allowed


FLOW_URL = "https://labs.google/fx/vi/tools/flow"
RECAPTCHA_SITE_KEY = "k=6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV"

BLOCK_KEYWORDS = [
    "flowMedia:batchGenerateImages",
    "batchGenerateImages",
    "batchAsyncGenerateVideoText",
    "batchAsyncGenerateVideoStartImage",
]

# Playwright Python không có page.off() — listener/route cũ không gỡ → log trùng, treo, token lỗi.
_page_token_locks: "weakref.WeakKeyDictionary[Page, asyncio.Lock]" = weakref.WeakKeyDictionary()
_blocking_ready_ctx: set[int] = set()


def _detach_page_listeners(page: Page, event: str, handler: Callable) -> None:
    try:
        page.remove_listener(event, handler)
    except Exception:
        pass


def _page_token_lock(page: Page) -> asyncio.Lock:
    lock = _page_token_locks.get(page)
    if lock is None:
        lock = asyncio.Lock()
        _page_token_locks[page] = lock
    return lock


def _read_auth_file() -> Dict[str, Any]:
    return read_veo_auth(CONFIG_DIR)


def _write_auth_file(obj: Dict[str, Any]) -> None:
    write_veo_auth(CONFIG_DIR, obj or {}, write_plaintext=write_plaintext_allowed())


def _is_filled(obj: Dict[str, Any]) -> bool:
    return bool(obj.get("sessionId") and obj.get("projectId") and obj.get("access_token"))


# Cache auth trong RAM với thời gian sống (để tránh đọc file liên tục trong cùng 1 phiên)
_AUTH_CACHE: Dict[str, Dict[str, Any]] = {}
_AUTH_CACHE_TTL = 300  # Cache 5 phút, sau đó reload để lấy token/cookie mới


VEO_AUTH_TTL_HOURS = 24  # Thời gian sống của auth, đơn vị giờ


def _make_expires_24h() -> str:
    """Tạo chuỗi ISO8601 UTC = bây giờ + 24 giờ."""
    return (datetime.now(timezone.utc) + timedelta(hours=VEO_AUTH_TTL_HOURS)).isoformat()


def is_veo_auth_expired(auth: dict) -> bool:
    """
    Trả về True nếu auth đã hết hạn hoặc expires không hợp lệ.
    Chuỗi expires theo ISO8601 (từ /api/auth/session hoặc do tool tự tạo +24h).
    """
    exp = str(auth.get("expires") or "").strip()
    if not exp:
        return True
    try:
        dt = datetime.fromisoformat(exp.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) >= dt
    except Exception:
        return True


def save_veo_auth_config(profile_id: str, auth: dict) -> None:
    """
    Lưu auth theo từng profile (ưu tiên `veo_auth.enc`; exe chỉ ghi .enc).

    Format:
    {
      "profiles": {
        "<profile_id>": { sessionId, projectId, access_token, cookie, updated_at, expires }
      }
    }
    """
    pid = str(profile_id or "").strip()
    if not pid:
        return
    root = _read_auth_file()
    profiles = root.get("profiles") if isinstance(root.get("profiles"), dict) else {}
    if not isinstance(profiles, dict):
        profiles = {}
    entry = dict(auth or {})
    try:
        entry["updated_at"] = _time_mod.time()
    except Exception:
        entry["updated_at"] = None
    # Nếu auth chưa có expires hợp lệ, đặt = now+24h
    if is_veo_auth_expired(entry):
        entry["expires"] = _make_expires_24h()
    profiles[pid] = entry
    root["profiles"] = profiles
    _write_auth_file(root)
    
    # Cập nhật cache luôn để tránh dùng auth cũ
    try:
        cached_entry = dict(entry)
        cached_entry["_cache_time"] = _time_mod.time()
        _AUTH_CACHE[pid] = cached_entry
    except Exception:
        pass


def load_veo_auth_config(profile_id: str, *, force_reload: bool = False) -> Optional[dict]:
    """
    Đọc auth theo profile_id từ veo_auth.enc (fallback veo_auth.json để migrate).
    
    Cache trong RAM với TTL 5 phút:
    - Lần đầu gọi (hoặc force_reload=True): đọc file mới
    - Trong cùng phiên (< 5 phút): dùng cache
    - Sau 5 phút: tự động reload để lấy token/cookie mới
    """
    pid = str(profile_id or "").strip()
    if not pid:
        return None
    
    # Kiểm tra cache nếu không force reload
    if not force_reload and pid in _AUTH_CACHE:
        cached = _AUTH_CACHE[pid]
        cache_time = cached.get("_cache_time", 0)
        try:
            if _time_mod.time() - cache_time < _AUTH_CACHE_TTL:
                # Cache còn sống, trả về luôn
                result = dict(cached)
                result.pop("_cache_time", None)
                return result
        except Exception:
            pass
    
    # Đọc lại file (cache hết hạn hoặc chưa có cache)
    root = _read_auth_file()

    # Backward compat: file cũ dạng phẳng -> tự chuyển sang profiles[pid]
    if _is_filled(root) and not isinstance(root.get("profiles"), dict):
        migrated = {
            "sessionId": root.get("sessionId"),
            "projectId": root.get("projectId"),
            "access_token": root.get("access_token"),
            "cookie": root.get("cookie") or "",
        }
        _write_auth_file({"profiles": {pid: migrated}})
        # Lưu vào cache
        try:
            import time as _time
            cached_entry = dict(migrated)
            cached_entry["_cache_time"] = _time.time()
            _AUTH_CACHE[pid] = cached_entry
        except Exception:
            pass
        return migrated

    profiles = root.get("profiles") if isinstance(root.get("profiles"), dict) else {}
    if not isinstance(profiles, dict):
        return None
    entry = profiles.get(pid)
    if isinstance(entry, dict) and _is_filled(entry):
        result = {
            "sessionId": entry.get("sessionId"),
            "projectId": entry.get("projectId"),
            "access_token": entry.get("access_token"),
            "cookie": entry.get("cookie") or "",
            "project_url": entry.get("project_url") or "",
            "expires": entry.get("expires") or "",
            "updated_at": entry.get("updated_at"),
        }
        # Lưu vào cache với timestamp
        try:
            cached_entry = dict(result)
            cached_entry["_cache_time"] = _time_mod.time()
            _AUTH_CACHE[pid] = cached_entry
        except Exception:
            pass
        return result
    return None


def _cookies_to_header(cookies: List[Dict[str, Any]]) -> str:
    parts = []
    for c in cookies:
        # Chỉ lấy cookie thuộc Google/Flow, bỏ cookie của hệ thống khác (NST token/x-api-key/profileId...)
        domain = str(c.get("domain") or "").lstrip(".").lower()
        if not (domain.endswith("google.com") or domain.endswith("labs.google")):
            continue
        name = c.get("name")
        value = c.get("value")
        if name and value is not None:
            # bỏ các cookie không liên quan / nhạy cảm nội bộ
            if str(name).lower() in {"token", "x-api-key", "profileid", "profilename"}:
                continue
            parts.append(f"{name}={value}")
    return "; ".join(parts)


def _is_recaptcha_reload(url: str) -> bool:
    url = url or ""
    return "/recaptcha/enterprise/reload" in url


def _extract_recaptcha_token(text: str) -> Optional[str]:
    marker = '["rresp","'
    start = text.find(marker)
    if start == -1:
        return None
    start += len(marker)
    end = text.find('"', start)
    if end == -1:
        return None
    return text[start:end]


def _extract_token_from_generate_post_data(raw: str) -> Optional[str]:
    """
    Fallback: đôi khi Flow không gọi `/recaptcha/enterprise/reload` (hoặc bị cache),
    nhưng request generate vẫn chứa `recaptchaContext.token` trong payload JSON.
    """
    if not raw:
        return None
    try:
        obj = json.loads(raw)
    except Exception:
        return None

    def _pick_token(o: Any) -> Optional[str]:
        if not isinstance(o, dict):
            return None
        cc = o.get("clientContext") or {}
        if isinstance(cc, dict):
            rc = cc.get("recaptchaContext") or {}
            if isinstance(rc, dict):
                tok = rc.get("token")
                if isinstance(tok, str) and tok.strip():
                    return tok.strip()
        return None

    # Case 1: payload root có clientContext
    tok = _pick_token(obj)
    if tok:
        return tok

    # Case 2: payload dạng { requests: [ { clientContext: { recaptchaContext: { token }}}]}
    reqs = obj.get("requests")
    if isinstance(reqs, list) and reqs:
        tok = _pick_token(reqs[0])
        if tok:
            return tok

    return None


async def apply_request_blocking_for_token(page: Page) -> None:
    """Block generate Flow trên page (một lần / context; có timeout tránh treo CDP)."""
    ctx_id = id(page.context)
    if ctx_id in _blocking_ready_ctx:
        return

    async def _route_handler(route, request):
        url = request.url or ""
        if any(kw in url for kw in BLOCK_KEYWORDS):
            await route.fulfill(
                status=403,
                content_type="application/json",
                body='{"error":{"code":403,"message":"blocked for token-only flow"}}',
            )
        else:
            await route.continue_()

    try:
        try:
            cdp = await asyncio.wait_for(
                page.context.new_cdp_session(page),
                timeout=5.0,
            )
            await cdp.send("Network.enable")
            await cdp.send(
                "Network.setBlockedURLs",
                {
                    "urls": [
                        "*aisandbox-pa.googleapis.com/v1/flowMedia:batchGenerateImages*",
                        "*aisandbox-pa.googleapis.com/v1/projects/*/flowMedia:batchGenerateImages*",
                        "*aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText*",
                        "*aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage*",
                    ]
                },
            )
        except Exception:
            pass

        await page.context.route("**/*", _route_handler)
        _blocking_ready_ctx.add(ctx_id)
    except Exception:
        pass


async def fetch_recaptcha_token_via_page(
    page: Page,
    *,
    prompt_for_token: str = "a",
    timeout: int = 60,
    stabilize_seconds: int = 3,
) -> Optional[str]:
    """
    Lấy recaptcha token: send_prompt_text('a') + Enter.
    Ưu tiên token từ /recaptcha/enterprise/reload; fallback payload generate (đã block).
    """
    _ = prompt_for_token
    async with _page_token_lock(page):
        return await _fetch_recaptcha_token_via_page_locked(
            page,
            timeout=timeout,
            stabilize_seconds=stabilize_seconds,
        )


async def _fetch_recaptcha_token_via_page_locked(
    page: Page,
    *,
    timeout: int,
    stabilize_seconds: int,
) -> Optional[str]:
    print(
        f"[VEO Token] 🔍 Bắt đầu fetch recaptcha (timeout={timeout}s, stabilize={stabilize_seconds}s)"
    )

    loop = asyncio.get_running_loop()
    fut: "asyncio.Future[Optional[str]]" = loop.create_future()
    capture_state = {"from_reload": False}
    logged_keys: set[str] = set()

    def _log_once(key: str, msg: str) -> None:
        if key in logged_keys:
            return
        logged_keys.add(key)
        print(msg)

    async def _on_response(response):
        if fut.done():
            return
        url = response.url or ""
        if not _is_recaptcha_reload(url):
            return
        _log_once("reload_resp", f"[VEO Token] 📡 Response recaptcha reload: {url[:90]}")
        try:
            text = await response.text()
        except Exception as e:
            print(f"[VEO Token] ⚠️ Lỗi đọc response reload: {e}")
            return
        token_value = _extract_recaptcha_token(text or "")
        if token_value and not fut.done():
            capture_state["from_reload"] = True
            print(f"[VEO Token] ✅ Token từ reload: {token_value[:40]}...")
            fut.set_result(token_value)

    def _on_request(req):
        if fut.done():
            return
        try:
            url = (req.url or "").strip()
            if "/recaptcha/" in url and "reload" in url:
                _log_once(f"req_recaptcha_reload:{url[:80]}", f"[VEO Token] 📤 recaptcha reload req")
                return
            if "/recaptcha/" in url:
                _log_once(f"req_recaptcha_other:{url.split('?')[0]}", f"[VEO Token] 📤 recaptcha: {url[:90]}")
                return
            if not any(kw in url for kw in BLOCK_KEYWORDS):
                return
            _log_once(f"req_gen:{url.split('?')[0]}", f"[VEO Token] 📤 generate (blocked): {url[:90]}")
            if capture_state["from_reload"]:
                return
            raw = req.post_data or ""
            token_value = _extract_token_from_generate_post_data(raw)
            if token_value and not fut.done():
                print(f"[VEO Token] ✅ Token từ payload generate (fallback): {token_value[:40]}...")
                fut.set_result(token_value)
        except Exception as e:
            print(f"[VEO Token] ⚠️ Lỗi xử lý request: {e}")

    page.on("response", _on_response)
    page.on("request", _on_request)

    try:
        print("[VEO Token] 🛡️ Thiết lập block generate (CDP/route)...")
        await apply_request_blocking_for_token(page)
        print("[VEO Token] ✅ Block generate sẵn sàng")

        if stabilize_seconds and stabilize_seconds > 0:
            print(f"[VEO Token] ⏳ Đợi {stabilize_seconds}s để listener ổn định...")
            await asyncio.sleep(float(stabilize_seconds))

        print("[VEO Token] ⌨️ send_prompt_text('a') + Enter...")
        ok = await send_prompt_text(page, "a", wait_ms=8_000)
        if not ok:
            print("[VEO Token] ❌ send_prompt_text('a') thất bại!")
            return None
        print("[VEO Token] ✅ Đã gửi 'a' + Enter")

        print("[VEO Token] ⏳ Đợi 1s để request được gửi...")
        await asyncio.sleep(1)

        wait_s = max(1, int(timeout) - 2)
        print(f"[VEO Token] ⏰ Đợi token (timeout={wait_s}s)...")
        try:
            token = await asyncio.wait_for(fut, timeout=wait_s)
            if token:
                src = "reload" if capture_state["from_reload"] else "generate"
                print(f"[VEO Token] ✅ Lấy token thành công ({src}): {token[:40]}...")
            return token
        except asyncio.TimeoutError:
            print(f"[VEO Token] ⏱️ TIMEOUT sau {timeout}s - không bắt được token!")
            return None
    finally:
        _detach_page_listeners(page, "response", _on_response)
        _detach_page_listeners(page, "request", _on_request)


async def auto_collect_veo_auth_from_flow(page: Page, *, profile_id: str, timeout_s: int = 45) -> Optional[dict]:
    """
    Tự lấy sessionId/projectId/access_token bằng cách bắt request thật của Flow UI.
    Sau khi lấy được sẽ ghi vào veo_auth.enc (dev có thể có thêm veo_auth.json).
    """
    loop = asyncio.get_running_loop()
    fut: "asyncio.Future[Optional[dict]]" = loop.create_future()

    def _try_extract_from_request(req) -> Optional[dict]:
        try:
            url = (req.url or "").strip()
            if "flowMedia:batchGenerateImages" not in url:
                return None
            m = re.search(r"/v1/projects/([^/]+)/flowMedia:batchGenerateImages", url)
            project_id = m.group(1) if m else None

            headers = req.headers or {}
            auth = headers.get("authorization") or headers.get("Authorization") or ""
            if "bearer " in auth.lower():
                access_token = auth.split(" ", 1)[1].strip()
            else:
                access_token = ""

            session_id = ""
            try:
                raw = req.post_data or ""
                obj = json.loads(raw) if raw else {}
                session_id = (
                    (obj.get("clientContext") or {}).get("sessionId")
                    or (((obj.get("requests") or [{}])[0].get("clientContext") or {}).get("sessionId"))
                    or ""
                )
            except Exception:
                session_id = ""

            if project_id and access_token and session_id:
                return {
                    "sessionId": session_id,
                    "projectId": project_id,
                    "access_token": access_token,
                    "cookie": "",
                }
        except Exception:
            return None
        return None

    async def _on_request(req):
        if fut.done():
            return
        extracted = _try_extract_from_request(req)
        if extracted:
            fut.set_result(extracted)

    page.on("request", _on_request)
    try:
        ok = await send_prompt_text(page, "a")
        if not ok:
            return None

        try:
            auth = await asyncio.wait_for(fut, timeout=timeout_s)
        except asyncio.TimeoutError:
            return None

        if auth:
            # Luôn cố lấy cookie từ context (ổn định hơn header request) để dùng cho các endpoint nhạy (upscale).
            try:
                cookies = await page.context.cookies()
                cookie_header = _cookies_to_header(cookies)
                if cookie_header:
                    auth["cookie"] = cookie_header
            except Exception:
                pass
            auth["cookie"] = auth.get("cookie") or ""
            save_veo_auth_config(profile_id, auth)
        return auth
    finally:
        _detach_page_listeners(page, "request", _on_request)


def _extract_session_id_from_submit_batch(payload: Dict[str, Any]) -> Optional[str]:
    """
    Rút sessionId từ general.submitBatchLog giống login.py:
    payload.json.appEvents[].event == 'PINHOLE_CREATE_NEW_PROJECT'
    """
    try:
        app_events = (payload.get("json") or {}).get("appEvents") or []
        for event in app_events:
            if not isinstance(event, dict):
                continue
            if event.get("event") == "PINHOLE_CREATE_NEW_PROJECT":
                metadata = event.get("eventMetadata") or {}
                session_id = metadata.get("sessionId")
                if session_id:
                    return str(session_id)
    except Exception:
        return None
    return None


def _extract_project_id_from_trpc(payload: Dict[str, Any]) -> Optional[str]:
    """
    Rút projectId từ payload/response của project.createProject (TRPC).
    Format giống login.py:
    result.data.json.result.projectId
    """
    try:
        return (
            (payload.get("result") or {})
            .get("data", {})
            .get("json", {})
            .get("result", {})
            .get("projectId")
        )
    except Exception:
        return None


def _extract_access_token_from_next_data(payload: Dict[str, Any]) -> Optional[str]:
    """
    Rút access_token từ response /_next/data giống login.py:
    pageProps.session.access_token
    """
    try:
        return (
            (payload.get("pageProps") or {})
            .get("session", {})
            .get("access_token")
        )
    except Exception:
        return None


async def _try_get_project_id_from_page(page: Page) -> Optional[str]:
    """
    Trích projectId từ URL hiện tại của page (nhiều pattern).
    """
    try:
        url = page.url or ""
        # Pattern 1: /flow/project/<projectId>
        m = re.search(r"/flow/project/([^/?#]+)", url)
        if m:
            return m.group(1)
        # Pattern 2: /project/<projectId>
        m = re.search(r"/project/([^/?#]+)", url)
        if m:
            return m.group(1)
        # Pattern 3: /v1/projects/<projectId>
        m = re.search(r"/v1/projects/([^/?#]+)", url)
        if m:
            return m.group(1)
    except Exception:
        pass
    return None


async def _try_get_session_id_from_storage(page: Page) -> Optional[str]:
    """
    Trích sessionId từ localStorage/sessionStorage (deep search).
    Tìm key chứa "session" hoặc "sessionId" trong value dạng JSON.
    """
    try:
        # localStorage
        local_storage = await page.evaluate("() => JSON.stringify(localStorage)")
        if local_storage:
            try:
                obj = json.loads(local_storage)
                for key, val in obj.items():
                    if not val:
                        continue
                    # Nếu value là JSON string, parse tiếp
                    try:
                        val_obj = json.loads(val) if isinstance(val, str) else val
                        if isinstance(val_obj, dict):
                            sid = val_obj.get("sessionId")
                            if sid:
                                return str(sid)
                    except Exception:
                        pass
            except Exception:
                pass

        # sessionStorage
        session_storage = await page.evaluate("() => JSON.stringify(sessionStorage)")
        if session_storage:
            try:
                obj = json.loads(session_storage)
                for key, val in obj.items():
                    if not val:
                        continue
                    try:
                        val_obj = json.loads(val) if isinstance(val, str) else val
                        if isinstance(val_obj, dict):
                            sid = val_obj.get("sessionId")
                            if sid:
                                return str(sid)
                    except Exception:
                        pass
            except Exception:
                pass
    except Exception:
        pass
    return None


async def refresh_veo_auth_fast(
    page: Page,
    *,
    profile_id: str,
    timeout_s: int = 8,
    allow_flow_fallback: bool = False,
) -> Optional[dict]:
    """
    Pro+ / API: chỉ GET /api/auth/session → access_token + cookie, merge auth cũ, lưu, xong.
    Không quét storage DOM, không fallback Flow, không chờ UI.
    """
    if allow_flow_fallback:
        return await auto_collect_veo_auth_from_session(
            page,
            profile_id=profile_id,
            timeout_s=timeout_s,
            allow_flow_fallback=True,
        )
    return await _refresh_veo_auth_session_only(page, profile_id=profile_id, timeout_s=timeout_s)


async def _refresh_veo_auth_session_only(
    page: Page,
    *,
    profile_id: str,
    timeout_s: int = 8,
) -> Optional[dict]:
    pid = str(profile_id or "").strip()
    if not pid:
        return None
    old_auth = load_veo_auth_config(pid) or {}
    req_timeout_ms = min(8_000, max(2_000, int(timeout_s) * 1000))

    try:
        resp = await page.context.request.get(
            "https://labs.google/fx/api/auth/session",
            timeout=req_timeout_ms,
        )
        if not resp.ok:
            print(
                f"[VEO Auth Session] ⚠️ Profile {pid[-4:]} HTTP {resp.status} /api/auth/session"
            )
            return None
        data = json.loads((await resp.text()) or "{}")
        access_token = (data.get("access_token") or "").strip()
        if not access_token:
            print(f"[VEO Auth Session] ⚠️ Profile {pid[-4:]} không có access_token")
            return None
    except Exception as e:
        print(f"[VEO Auth Session] ❌ Profile {pid[-4:]} /api/auth/session: {e}")
        return None

    cookie_header = str(old_auth.get("cookie") or "")
    try:
        part = await page.context.cookies("https://labs.google")
        fresh = _cookies_to_header(part or [])
        if fresh:
            cookie_header = fresh
    except Exception:
        pass

    project_id = (await _try_get_project_id_from_page(page)) or str(
        old_auth.get("projectId") or ""
    ).strip() or None
    session_id = str(old_auth.get("sessionId") or "").strip() or None

    auth = {
        "sessionId": session_id,
        "projectId": project_id,
        "access_token": access_token,
        "cookie": cookie_header,
    }
    if project_id:
        auth["project_url"] = f"{FLOW_URL.rstrip('/')}/project/{project_id}"
    elif old_auth.get("project_url"):
        auth["project_url"] = old_auth["project_url"]
    if data.get("user"):
        auth["user"] = data["user"]
    elif old_auth.get("user"):
        auth["user"] = old_auth["user"]
    if data.get("expires"):
        auth["expires"] = data["expires"]
    elif old_auth.get("expires"):
        auth["expires"] = old_auth["expires"]

    save_veo_auth_config(pid, auth)
    print(
        f"[VEO Auth Session] ✅ Profile {pid[-4:]} refresh OK "
        f"(access_token + cookie, lưu xong — chạy setup tiếp)"
    )
    return auth


async def auto_collect_veo_auth_from_session(
    page: Page,
    *,
    profile_id: str,
    timeout_s: int = 30,
    allow_flow_fallback: bool = True,
) -> Optional[dict]:
    """
    Phương thức mới nhanh hơn: lấy access_token và cookie từ endpoint /api/auth/session
    mà KHÔNG cần gửi prompt "a" hay click Create.
    
    Flow:
    1. Gọi https://labs.google/fx/api/auth/session -> lấy access_token từ JSON response
    2. Trích projectId từ URL hiện tại
    3. Trích sessionId từ localStorage/sessionStorage, nếu không có thì lấy từ auth config cũ
    4. Lấy cookie từ browser context
    5. Lưu vào veo_auth.enc
    6. Nếu thiếu projectId/sessionId và allow_flow_fallback=True -> fallback sang auto_collect_veo_auth_from_flow()
    """
    try:
        # Đảm bảo page đang ở labs.google domain trước khi gọi API
        current_url = page.url or ""
        if "labs.google" not in current_url:
            print(
                f"[VEO Auth Session] ⚠️ Profile {profile_id[-4:]} không ở labs.google domain, skip"
            )
            if allow_flow_fallback:
                print(f"[VEO Auth Session] 🔄 Profile {profile_id[-4:]} fallback sang auto_collect_veo_auth_from_flow()")
                return await auto_collect_veo_auth_from_flow(page, profile_id=profile_id, timeout_s=timeout_s)
            return None

        # 1. Gọi /api/auth/session để lấy access_token
        auth_url = "https://labs.google/fx/api/auth/session"
        access_token = None
        user_info = None
        expires = None
        try:
            # Dùng page.context.request thay vì page.request (ổn định hơn)
            req_timeout_ms = min(12_000, max(3_000, int(timeout_s) * 1000))
            resp = await page.context.request.get(auth_url, timeout=req_timeout_ms)
            if not resp.ok:
                print(
                    f"[VEO Auth Session] ⚠️ Profile {profile_id[-4:]} HTTP {resp.status} khi gọi /api/auth/session"
                )
                if allow_flow_fallback:
                    print(f"[VEO Auth Session] 🔄 Profile {profile_id[-4:]} fallback sang auto_collect_veo_auth_from_flow()")
                    return await auto_collect_veo_auth_from_flow(page, profile_id=profile_id, timeout_s=timeout_s)
                return None
            body = await resp.text()
            data = json.loads(body or "{}")
            access_token = data.get("access_token")
            user_info = data.get("user")  # optional
            expires = data.get("expires")  # optional
            if not access_token:
                print(
                    f"[VEO Auth Session] ⚠️ Profile {profile_id[-4:]} không có access_token trong response"
                )
                if allow_flow_fallback:
                    print(f"[VEO Auth Session] 🔄 Profile {profile_id[-4:]} fallback sang auto_collect_veo_auth_from_flow()")
                    return await auto_collect_veo_auth_from_flow(page, profile_id=profile_id, timeout_s=timeout_s)
                return None
        except Exception as e:
            print(f"[VEO Auth Session] ❌ Profile {profile_id[-4:]} lỗi gọi /api/auth/session: {e}")
            if allow_flow_fallback:
                print(f"[VEO Auth Session] 🔄 Profile {profile_id[-4:]} fallback sang auto_collect_veo_auth_from_flow()")
                return await auto_collect_veo_auth_from_flow(page, profile_id=profile_id, timeout_s=timeout_s)
            return None

        # 2. Trích projectId từ URL
        project_id = await _try_get_project_id_from_page(page)
        if not project_id:
            print(
                f"[VEO Auth Session] ⚠️ Profile {profile_id[-4:]} không trích được projectId từ URL"
            )
            if allow_flow_fallback:
                print(f"[VEO Auth Session] 🔄 Profile {profile_id[-4:]} fallback sang auto_collect_veo_auth_from_flow()")
                return await auto_collect_veo_auth_from_flow(page, profile_id=profile_id, timeout_s=timeout_s)
            return None

        # 3. sessionId: ưu tiên auth cũ (nhanh), chỉ quét storage khi chưa có
        old_auth = load_veo_auth_config(profile_id)
        session_id = None
        if old_auth and old_auth.get("sessionId"):
            session_id = str(old_auth.get("sessionId") or "").strip() or None
            if session_id:
                print(
                    f"[VEO Auth Session] ✅ Profile {profile_id[-4:]} dùng sessionId từ auth cũ: {session_id[:8]}..."
                )
        if not session_id:
            session_id = await _try_get_session_id_from_storage(page)
            if session_id:
                print(
                    f"[VEO Auth Session] ✅ Profile {profile_id[-4:]} sessionId từ storage: {session_id[:8]}..."
                )
        if not session_id:
            print(
                f"[VEO Auth Session] ⚠️ Profile {profile_id[-4:]} không có sessionId (storage + auth cũ)"
            )
            if allow_flow_fallback:
                print(f"[VEO Auth Session] 🔄 Profile {profile_id[-4:]} fallback sang auto_collect_veo_auth_from_flow()")
                return await auto_collect_veo_auth_from_flow(page, profile_id=profile_id, timeout_s=timeout_s)
            return None

        # 4. Cookie chỉ labs.google (tránh context.cookies() full profile → kẹt 20–30s)
        cookie_header = ""
        try:
            cookies = []
            for url in ("https://labs.google", "https://google.com"):
                try:
                    part = await page.context.cookies(url)
                    if part:
                        cookies.extend(part)
                except Exception:
                    pass
            cookie_header = _cookies_to_header(cookies)
            if not cookie_header and old_auth:
                cookie_header = str(old_auth.get("cookie") or "")
        except Exception as e:
            print(f"[VEO Auth Session] ⚠️ Profile {profile_id[-4:]} lỗi lấy cookie: {e}")
            if old_auth:
                cookie_header = str(old_auth.get("cookie") or "")

        # 5. Lưu vào veo_auth.enc
        project_url = f"{FLOW_URL.rstrip('/')}/project/{project_id}"
        auth = {
            "sessionId": session_id,
            "projectId": project_id,
            "access_token": access_token,
            "cookie": cookie_header,
            "project_url": project_url,
        }
        if user_info:
            auth["user"] = user_info
        if expires:
            auth["expires"] = expires
        save_veo_auth_config(profile_id, auth)
        print(
            f"[VEO Auth Session] ✅ Profile {profile_id[-4:]} lấy auth từ /api/auth/session thành công"
        )
        return auth

    except Exception as e:
        print(f"[VEO Auth Session] ❌ Profile {profile_id[-4:]} exception: {e}")
        if allow_flow_fallback:
            print(f"[VEO Auth Session] 🔄 Profile {profile_id[-4:]} fallback sang auto_collect_veo_auth_from_flow()")
            return await auto_collect_veo_auth_from_flow(page, profile_id=profile_id, timeout_s=timeout_s)
        return None


async def auto_collect_veo_auth_on_project_creation(
    page: Page,
    *,
    profile_id: str,
    flow_url: str = FLOW_URL,
    timeout_s: int = 60,
    stop_check=None,
) -> Optional[dict]:
    """
    Flow mới: vào Flow + bấm 'Tạo dự án' rồi bắt chính request tạo project để lấy:
    - sessionId  (general.submitBatchLog)
    - projectId  (project.createProject)
    - access_token + cookie (_next/data)

    Sau khi đủ trường sẽ lưu vào veo_auth.enc theo profile_id.
    """
    loop = asyncio.get_running_loop()
    fut: "asyncio.Future[Optional[dict]]" = loop.create_future()

    capture: Dict[str, Any] = {
        "sessionId": None,
        "projectId": None,
        "access_token": None,
        "cookie": None,
    }

    def _maybe_finish() -> None:
        if (
            capture.get("sessionId")
            and capture.get("projectId")
            and capture.get("access_token")
            and not fut.done()
        ):
            project_id = str(capture.get("projectId"))
            # URL chuẩn theo projectId (không còn lưu vào settings.json)
            project_url = f"{FLOW_URL.rstrip('/')}/project/{project_id}"
            auth = {
                "sessionId": capture.get("sessionId"),
                "projectId": capture.get("projectId"),
                "access_token": capture.get("access_token"),
                "cookie": capture.get("cookie") or "",
                "project_url": project_url,
            }
            save_veo_auth_config(profile_id, auth)
            fut.set_result(auth)

    async def _on_request(req) -> None:
        if fut.done():
            return
        try:
            url = (req.url or "").strip()
        except Exception:
            url = ""

        # general.submitBatchLog -> sessionId
        if "general.submitBatchLog" in url and not capture.get("sessionId"):
            try:
                raw = req.post_data or ""
            except Exception:
                raw = ""
            try:
                obj = json.loads(raw) if raw else {}
            except Exception:
                obj = {}
            session_id = _extract_session_id_from_submit_batch(obj)
            if session_id:
                capture["sessionId"] = session_id
                _maybe_finish()

        # project.createProject -> projectId (từ request)
        if "project.createProject" in url and not capture.get("projectId"):
            try:
                raw = req.post_data or ""
            except Exception:
                raw = ""
            try:
                obj = json.loads(raw) if raw else {}
            except Exception:
                obj = {}
            project_id = _extract_project_id_from_trpc(obj)
            if project_id:
                capture["projectId"] = project_id
                _maybe_finish()

        # /_next/data -> cookie (nếu có)
        if "labs.google/fx/_next/data" in url and not capture.get("cookie"):
            try:
                cookie_header = req.headers.get("cookie")
            except Exception:
                cookie_header = None
            if cookie_header:
                capture["cookie"] = cookie_header
                _maybe_finish()

    async def _on_response(response) -> None:
        if fut.done():
            return
        try:
            url = (response.url or "").strip()
        except Exception:
            url = ""

        # project.createProject -> projectId (từ response)
        if "project.createProject" in url and not capture.get("projectId"):
            try:
                payload = await response.json()
            except Exception:
                payload = None
            if isinstance(payload, dict):
                project_id = _extract_project_id_from_trpc(payload)
                if project_id:
                    capture["projectId"] = project_id
                    _maybe_finish()

        # /_next/data -> access_token (+ cookie fallback)
        if "labs.google/fx/_next/data" in url and not capture.get("access_token"):
            try:
                payload = await response.json()
            except Exception:
                payload = None
            if isinstance(payload, dict):
                token = _extract_access_token_from_next_data(payload)
                if token:
                    capture["access_token"] = token
                    _maybe_finish()

            if not capture.get("cookie"):
                try:
                    req = response.request
                    cookie_header = req.headers.get("cookie") if req else None
                except Exception:
                    cookie_header = None
                if cookie_header:
                    capture["cookie"] = cookie_header
                    _maybe_finish()

    page.on("request", _on_request)
    page.on("response", _on_response)

    try:
        # Điều hướng + bấm "Tạo dự án" (Flow mới)
        await goto_flow_and_open_project(
            page,
            flow_url,
            stop_check=stop_check,
        )

        try:
            auth = await asyncio.wait_for(fut, timeout=max(1, int(timeout_s)))
        except asyncio.TimeoutError:
            auth = None

        # Best-effort: bổ sung cookie từ context (đôi khi request header không có/không đủ).
        if auth and isinstance(auth, dict):
            try:
                cookies = await page.context.cookies()
                cookie_header = _cookies_to_header(cookies)
                if cookie_header:
                    auth["cookie"] = cookie_header
                    save_veo_auth_config(profile_id, auth)
            except Exception:
                pass

        return auth
    finally:
        _detach_page_listeners(page, "request", _on_request)
        _detach_page_listeners(page, "response", _on_response)

