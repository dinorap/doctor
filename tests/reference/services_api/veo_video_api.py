import json
import random
import uuid
from typing import Any, Dict, List, Optional, Tuple

from playwright.async_api import Page  # type: ignore

URL_GENERATE_TEXT_TO_VIDEO = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText"
URL_STATUS_TEXT_TO_VIDEO = "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus"
# API v3.1+: poll status bằng media[] (thay operations[])
URL_STATUS_MEDIA_BATCH = "https://aisandbox-pa.googleapis.com/v1/media:batchCheckAsyncVideoGenerationStatus"

VIDEO_ASPECT_RATIO_LANDSCAPE = "VIDEO_ASPECT_RATIO_LANDSCAPE"
VIDEO_ASPECT_RATIO_PORTRAIT = "VIDEO_ASPECT_RATIO_PORTRAIT"

# Veo 3.1 - Fast (t2v) — theo aspect ratio
#   16:9 landscape -> veo_3_1_t2v_fast_ultra (ULTRA) / veo_3_1_t2v_fast (NORMAL/PRO)
#   9:16 portrait  -> veo_3_1_t2v_fast_portrait_ultra (ULTRA) / veo_3_1_t2v_fast_portrait (NORMAL/PRO)
DEFAULT_VIDEO_MODEL_KEY_FAST_ULTRA_LANDSCAPE = "veo_3_1_t2v_fast_ultra"
DEFAULT_VIDEO_MODEL_KEY_FAST_ULTRA_PORTRAIT = "veo_3_1_t2v_fast_portrait_ultra"
DEFAULT_VIDEO_MODEL_KEY_FAST_ULTRA_LANDSCAPE_RELAXED = "veo_3_1_t2v_fast_ultra_relaxed"
DEFAULT_VIDEO_MODEL_KEY_FAST_ULTRA_PORTRAIT_RELAXED = "veo_3_1_t2v_fast_portrait_ultra_relaxed"
DEFAULT_VIDEO_MODEL_KEY_FAST_NORMAL_LANDSCAPE = "veo_3_1_t2v_fast"
DEFAULT_VIDEO_MODEL_KEY_FAST_NORMAL_PORTRAIT = "veo_3_1_t2v_fast_portrait"
# Alias giữ tương thích nội bộ / fallback
DEFAULT_VIDEO_MODEL_KEY_ULTRA = DEFAULT_VIDEO_MODEL_KEY_FAST_ULTRA_LANDSCAPE
DEFAULT_VIDEO_MODEL_KEY_PORTRAIT_ULTRA = DEFAULT_VIDEO_MODEL_KEY_FAST_ULTRA_PORTRAIT
DEFAULT_VIDEO_MODEL_KEY_ULTRA_RELAXED = DEFAULT_VIDEO_MODEL_KEY_FAST_ULTRA_LANDSCAPE_RELAXED
DEFAULT_VIDEO_MODEL_KEY_PORTRAIT_ULTRA_RELAXED = DEFAULT_VIDEO_MODEL_KEY_FAST_ULTRA_PORTRAIT_RELAXED
DEFAULT_VIDEO_MODEL_KEY_NORMAL = DEFAULT_VIDEO_MODEL_KEY_FAST_NORMAL_LANDSCAPE
DEFAULT_VIDEO_MODEL_KEY_PORTRAIT_NORMAL = DEFAULT_VIDEO_MODEL_KEY_FAST_NORMAL_PORTRAIT

# Quality model (không fast)
DEFAULT_VIDEO_MODEL_KEY_QUALITY = "veo_3_1_t2v"
DEFAULT_VIDEO_MODEL_KEY_PORTRAIT_QUALITY = "veo_3_1_t2v_portrait"

# Lite — UI: "Veo 3.1 - Lite" (3 key: 4s / 6s / 8s)
DEFAULT_VIDEO_MODEL_KEY_LITE = "veo_3_1_t2v_lite"
DEFAULT_VIDEO_MODEL_KEY_LITE_4S = "veo_3_1_t2v_lite_4s"
DEFAULT_VIDEO_MODEL_KEY_LITE_6S = "veo_3_1_t2v_lite_6s"

# Lite [Lower Priority] — UI riêng (3 key: *_low_priority)
DEFAULT_VIDEO_MODEL_KEY_LITE_LOW_PRIORITY = "veo_3_1_t2v_lite_low_priority"
DEFAULT_VIDEO_MODEL_KEY_LITE_4S_LOW_PRIORITY = "veo_3_1_t2v_lite_4s_low_priority"
DEFAULT_VIDEO_MODEL_KEY_LITE_6S_LOW_PRIORITY = "veo_3_1_t2v_lite_6s_low_priority"

# Omni Flash — UI: "Omni Flash" + thời lượng cảnh (omniFlashDuration)
OMNI_FLASH_VIDEO_MODEL_KEYS = {
    "4s": "abra_t2v_4s",
    "6s": "abra_t2v_6s",
    "8s": "abra_t2v_8s",
    "10s": "abra_t2v_10s",
}
DEFAULT_OMNI_FLASH_VIDEO_MODEL_KEY = "abra_t2v_8s"


def _normalize_account_type(value: Optional[str]) -> str:
    v = str(value or "").strip().upper()
    return v if v in {"NORMAL", "PRO", "ULTRA"} else "ULTRA"


def _user_paygate_tier(account_type: Optional[str]) -> str:
    t = _normalize_account_type(account_type)
    if t == "NORMAL":
        return "PAYGATE_TIER_NOT_PAID"
    if t == "PRO":
        return "PAYGATE_TIER_ONE"
    return "PAYGATE_TIER_TWO"


def _normalize_model_label(model: Optional[str]) -> str:
    if not isinstance(model, str):
        return ""
    return " ".join(model.strip().lower().split())


def is_omni_flash_frontend_model(model: Optional[str]) -> bool:
    return "omni flash" in _normalize_model_label(model)


def is_lite_low_priority_frontend_model(model: Optional[str]) -> bool:
    label = _normalize_model_label(model)
    return "veo 3.1 - lite" in label and "priority" in label


def _append_duration_to_model_key(base_key: str, scene_duration: str) -> str:
    """Gắn _4s / _6s vào key 8s (Fast/Quality theo aspect + ULTRA)."""
    if scene_duration in ("4s", "6s"):
        return f"{base_key}_{scene_duration}"
    return base_key


def normalize_veo_scene_duration_label(duration: Optional[str]) -> str:
    """Chuẩn hóa thời lượng cảnh từ frontend: 4s | 6s | 8s | 10s (mặc định 8s)."""
    raw = str(duration or "8s").strip().lower()
    if raw.isdigit():
        raw = f"{raw}s"
    elif not raw.endswith("s"):
        raw = f"{raw}s"
    if raw in ("4s", "6s", "8s", "10s"):
        return raw
    return "8s"


def resolve_omni_flash_video_model_key(omni_flash_duration: Optional[str]) -> str:
    """Map omniFlashDuration frontend (4s|6s|8s|10s) -> abra_t2v_*."""
    return OMNI_FLASH_VIDEO_MODEL_KEYS.get(
        normalize_veo_scene_duration_label(omni_flash_duration),
        DEFAULT_OMNI_FLASH_VIDEO_MODEL_KEY,
    )


def _resolve_lite_video_model_key(scene_duration: str) -> str:
    if scene_duration == "4s":
        return DEFAULT_VIDEO_MODEL_KEY_LITE_4S
    if scene_duration == "6s":
        return DEFAULT_VIDEO_MODEL_KEY_LITE_6S
    return DEFAULT_VIDEO_MODEL_KEY_LITE


def _resolve_lite_low_priority_video_model_key(scene_duration: str) -> str:
    if scene_duration == "4s":
        return DEFAULT_VIDEO_MODEL_KEY_LITE_4S_LOW_PRIORITY
    if scene_duration == "6s":
        return DEFAULT_VIDEO_MODEL_KEY_LITE_6S_LOW_PRIORITY
    return DEFAULT_VIDEO_MODEL_KEY_LITE_LOW_PRIORITY


def _fast_8s_video_model_key(*, account_type: Optional[str], is_portrait: bool) -> str:
    acc = _normalize_account_type(account_type)
    if acc == "ULTRA":
        return (
            DEFAULT_VIDEO_MODEL_KEY_FAST_ULTRA_PORTRAIT
            if is_portrait
            else DEFAULT_VIDEO_MODEL_KEY_FAST_ULTRA_LANDSCAPE
        )
    return (
        DEFAULT_VIDEO_MODEL_KEY_FAST_NORMAL_PORTRAIT
        if is_portrait
        else DEFAULT_VIDEO_MODEL_KEY_FAST_NORMAL_LANDSCAPE
    )


def _resolve_fast_video_model_key(
    scene_duration: str,
    *,
    account_type: Optional[str],
    is_portrait: bool,
) -> str:
    base = _fast_8s_video_model_key(account_type=account_type, is_portrait=is_portrait)
    return _append_duration_to_model_key(base, scene_duration)


def _resolve_quality_video_model_key(scene_duration: str, *, is_portrait: bool) -> str:
    base = (
        DEFAULT_VIDEO_MODEL_KEY_PORTRAIT_QUALITY
        if is_portrait
        else DEFAULT_VIDEO_MODEL_KEY_QUALITY
    )
    return _append_duration_to_model_key(base, scene_duration)


def _resolve_video_model_key_from_frontend(
    model: Optional[str],
    aspect_ratio: str,
    account_type: Optional[str],
    *,
    omni_flash_duration: Optional[str] = None,
) -> str:
    """
    Map label model + thời lượng cảnh (4s/6s/8s) sang videoModelKey.
    Chỉ 4s và 6s dùng key có suffix; 8s giữ key cũ (Fast/Quality còn tách 16:9 vs 9:16).
    Omni Flash: abra_t2v_{4|6|8|10}s.
    """
    label = _normalize_model_label(model)
    is_portrait = aspect_ratio == VIDEO_ASPECT_RATIO_PORTRAIT
    scene_duration = normalize_veo_scene_duration_label(omni_flash_duration)

    # Omni Flash — abra_t2v_* (có thêm 10s)
    if is_omni_flash_frontend_model(model):
        return resolve_omni_flash_video_model_key(scene_duration)

    # Default UI: "Veo 3.1 - Lite [Lower Priority]"
    if not label:
        return _resolve_lite_low_priority_video_model_key(scene_duration)

    if label == "veo 3.1 - lite":
        return _resolve_lite_video_model_key(scene_duration)

    if is_lite_low_priority_frontend_model(model):
        return _resolve_lite_low_priority_video_model_key(scene_duration)

    # "Veo 3.1 - Fast"
    if label == "veo 3.1 - fast":
        return _resolve_fast_video_model_key(
            scene_duration, account_type=account_type, is_portrait=is_portrait
        )

    if label == "veo 3.1 - quality":
        return _resolve_quality_video_model_key(scene_duration, is_portrait=is_portrait)

    # Fallback: Fast 8s ULTRA theo aspect
    return _resolve_fast_video_model_key(
        "8s", account_type=account_type, is_portrait=is_portrait
    )


def build_text_to_video_payload(
    prompt: str,
    session_id: str,
    project_id: str,
    recaptcha_token: str,
    *,
    scene_id: Optional[str] = None,
    frontend_model: Optional[str] = None,
    aspect_ratio: str = VIDEO_ASPECT_RATIO_LANDSCAPE,
    output_count: int = 1,
    account_type: Optional[str] = None,
    reference_media_ids: Optional[List[str]] = None,
    reference_audio_media_id: Optional[str] = None,
    omni_flash_duration: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Xây payload batchAsyncGenerateVideoText giống API_text_to_video:
    - Có clientContext.userPaygateTier
    - Chọn videoModelKey dựa trên nhãn model từ frontend + aspect_ratio.
    - Omni Flash: useV2ModelConfig + structuredPrompt + abra_t2v_{4|6|8|10}s
    """
    is_omni = is_omni_flash_frontend_model(frontend_model)
    model_key = _resolve_video_model_key_from_frontend(
        frontend_model,
        aspect_ratio,
        account_type,
        omni_flash_duration=omni_flash_duration,
    )
    user_paygate_tier = _user_paygate_tier(account_type)

    # Log debug: loại tài khoản, model key, tier đang dùng
    try:
        ratio_hint = "9:16" if aspect_ratio == VIDEO_ASPECT_RATIO_PORTRAIT else "16:9"
        duration_hint = f" | scene_duration={normalize_veo_scene_duration_label(omni_flash_duration)}"
        print(
            "[VEO Video API] account_type="
            f"{_normalize_account_type(account_type)} | "
            f"model_label={_normalize_model_label(frontend_model)} | "
            f"aspect={ratio_hint}{duration_hint} | "
            f"videoModelKey={model_key} | "
            f"userPaygateTier={user_paygate_tier}"
        )
    except Exception:
        pass

    client_context: Dict[str, Any] = {
        "recaptchaContext": {
            "token": recaptcha_token,
            "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
        },
        "sessionId": session_id,
        "projectId": project_id,
        "tool": "PINHOLE",
        "userPaygateTier": user_paygate_tier,
    }

    if is_omni:
        req_item: Dict[str, Any] = {
            "aspectRatio": aspect_ratio,
            "seed": random.randint(1000, 99999),
            "textInput": {
                "structuredPrompt": {
                    "parts": [{"text": str(prompt or "")}],
                },
            },
            "videoModelKey": model_key,
            "metadata": {},
        }
        base: Dict[str, Any] = {
            "mediaGenerationContext": {
                "batchId": str(uuid.uuid4()),
                "audioFailurePreference": "BLOCK_SILENCED_VIDEOS",
            },
            "clientContext": client_context,
            "requests": [req_item],
            "useV2ModelConfig": True,
        }
    else:
        base = {
            "clientContext": client_context,
            "requests": [
                {
                    "aspectRatio": aspect_ratio,
                    "seed": 9797,
                    "textInput": {
                        "prompt": prompt,
                    },
                    "videoModelKey": model_key,
                    "metadata": {},
                }
            ],
        }

    req = base["requests"][0]
    if scene_id:
        req["metadata"]["sceneId"] = str(scene_id)
    else:
        req["metadata"]["sceneId"] = str(uuid.uuid4())

    # Thêm referenceImages nếu có media_id (ảnh tham chiếu upload qua API_uploadImage)
    refs: List[Dict[str, Any]] = []
    for mid in (reference_media_ids or [])[:3]:
        m = str(mid or "").strip()
        if not m:
            continue
        refs.append(
            {
                "mediaId": m,
                "imageUsageType": "IMAGE_USAGE_TYPE_ASSET",
            }
        )
    if refs:
        req["referenceImages"] = refs

    # Thêm referenceAudio nếu có mediaId giọng (đồng nhất giọng nhân vật).
    if reference_audio_media_id:
        mid = str(reference_audio_media_id or "").strip().lower()
        if mid:
            req["referenceAudio"] = [{"mediaId": mid}]

    count = output_count if isinstance(output_count, int) and output_count > 0 else 1
    base["requests"] = [json.loads(json.dumps(req)) for _ in range(count)]
    return base


async def request_create_video_via_browser(
    page: Page,
    url: str,
    payload: Dict[str, Any],
    access_token: str,
) -> Dict[str, Any]:
    """Gửi request tạo video qua Playwright page.request.post (giống API_text_to_video)."""
    data = json.dumps(payload)
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {access_token}",
    }
    try:
        response = await page.request.post(
            url,
            data=data,
            headers=headers,
        )
        body = await response.text()
        return {
            "ok": response.ok,
            "url": url,
            "status": response.status,
            "reason": response.status_text,
            "headers": dict(response.headers),
            "body": body,
        }
    except Exception as exc:  # pragma: no cover - defensive
        return {
            "ok": False,
            "url": url,
            "error": str(exc),
        }


async def request_check_status_via_browser(
    page: Page,
    payload: Dict[str, Any],
    access_token: str,
) -> Dict[str, Any]:
    """
    Check status qua browser.
    Payload media[] → ưu tiên v1/media:batchCheckAsyncVideoGenerationStatus (v3.1+).
    Payload operations[] → v1/video:batchCheckAsyncVideoGenerationStatus (cũ).
    """
    if isinstance(payload.get("media"), list) and payload.get("media"):
        res = await request_create_video_via_browser(
            page, URL_STATUS_MEDIA_BATCH, payload, access_token
        )
        if res.get("ok"):
            return res
        fallback = await request_create_video_via_browser(
            page, URL_STATUS_TEXT_TO_VIDEO, payload, access_token
        )
        if fallback.get("ok"):
            return fallback
        return res
    return await request_create_video_via_browser(
        page, URL_STATUS_TEXT_TO_VIDEO, payload, access_token
    )


async def request_get_operation_via_browser(
    page: Page,
    operation_name: str,
    access_token: str,
) -> Dict[str, Any]:
    """
    Gọi GET operation để lấy video URL sau khi status = SUCCESSFUL.
    operation_name format: "projects/{project}/locations/{location}/operations/{operation_id}"
    """
    url = f"https://aisandbox-pa.googleapis.com/v1/{operation_name}"
    headers = {
        "Authorization": f"Bearer {access_token}",
    }
    try:
        response = await page.request.get(
            url,
            headers=headers,
        )
        body = await response.text()
        return {
            "ok": response.ok,
            "url": url,
            "status": response.status,
            "reason": response.status_text,
            "headers": dict(response.headers),
            "body": body,
        }
    except Exception as exc:
        return {
            "ok": False,
            "url": url,
            "error": str(exc),
        }


def extract_media_from_operation_response(op_response: Dict[str, Any]) -> Tuple[str, str]:
    """
    Extract video/thumbnail URL từ response của GET operation.
    Trả về (video_url, thumbnail_url).
    """
    try:
        body_json = json.loads(op_response.get("body", "{}"))
    except Exception:
        body_json = {}
    
    # Parse metadata.video
    metadata = body_json.get("metadata", {}) if isinstance(body_json.get("metadata"), dict) else {}
    video = metadata.get("video", {}) if isinstance(metadata.get("video"), dict) else {}
    
    # VIDEO URL
    video_url = ""
    generated_video = video.get("generatedVideo", {}) if isinstance(video.get("generatedVideo"), dict) else {}
    if generated_video.get("fifeUrl"):
        video_url = str(generated_video["fifeUrl"])
    if not video_url and video.get("fifeUrl"):
        video_url = str(video["fifeUrl"])
    
    # THUMBNAIL URL
    thumbnail_url = ""
    generated_image = video.get("generatedImage", {}) if isinstance(video.get("generatedImage"), dict) else {}
    if generated_image.get("fifeUrl"):
        thumbnail_url = str(generated_image["fifeUrl"])
    if not thumbnail_url:
        poster = video.get("poster", {}) if isinstance(video.get("poster"), dict) else {}
        if poster.get("fifeUrl"):
            thumbnail_url = str(poster["fifeUrl"])
    if not thumbnail_url:
        serving_base_uri = str(video.get("servingBaseUri") or "")
        if serving_base_uri:
            thumbnail_url = serving_base_uri
        else:
            image = metadata.get("image", {}) if isinstance(metadata.get("image"), dict) else {}
            thumbnail_url = str(image.get("fifeUrl") or image.get("uri") or "")
    
    return video_url, thumbnail_url


def extract_media_id_from_create_item(item: Any) -> str:
    """Trích mediaId/name từ 1 phần tử media[] trong CREATE response (API v3.1+)."""
    if not isinstance(item, dict):
        return ""
    for key in ("mediaId", "name", "id", "mediaGenerationId"):
        val = item.get(key)
        if val:
            s = str(val).strip()
            if s:
                return s
    video = item.get("video")
    if isinstance(video, dict):
        op = video.get("operation")
        if isinstance(op, dict):
            op_name = op.get("name")
            if op_name:
                return str(op_name).strip()
    return ""


def parse_media_id_from_create_response(response_body: str) -> Optional[str]:
    """Parse mediaId đầu tiên từ CREATE response (API v3.1+)."""
    try:
        body_json = json.loads(response_body or "")
    except Exception:
        return None
    media = body_json.get("media", [])
    if not isinstance(media, list) or not media:
        return None
    first = media[0]
    mid = extract_media_id_from_create_item(first)
    return mid or None


def parse_operations_from_create_response(response_body: str) -> List[Dict[str, Any]]:
    """
    Parse identifier poll/download từ create response.

    Format mới (API v3.1+): media[] với mediaId (hoặc name)
    Format cũ: operations[] với operation.name
    """
    try:
        body_json = json.loads(response_body or "")
    except Exception:
        return []

    media = body_json.get("media", [])
    if isinstance(media, list) and media:
        results = []
        for item in media:
            if not isinstance(item, dict):
                continue
            media_id = extract_media_id_from_create_item(item)
            if not media_id:
                continue
            meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            scene_id = (
                meta.get("sceneId")
                or item.get("sceneId")
                or item.get("workflowId")
                or media_id
            )
            results.append({
                "sceneId": scene_id,
                "mediaId": media_id,
                "operation": {"name": media_id},
            })
        if results:
            return results

    ops = body_json.get("operations", [])
    return ops if isinstance(ops, list) else []


def extract_media_from_status_op(op: Dict[str, Any]) -> Tuple[str, str]:
    """
    Trích video/image URL từ 1 operation/media item trong response check status.
    Trả về (video_url, thumbnail_url).
    
    Hỗ trợ 2 format:
    1. Format mới (media array): op là item từ response.media[]
    2. Format cũ (operations array): op là item từ response.operations[]
    """
    # =========================
    # FORMAT MỚI: media array
    # =========================
    # Kiểm tra xem có phải format mới không (có key "video" trực tiếp)
    if "video" in op and isinstance(op.get("video"), dict):
        video = op["video"]
        
        # VIDEO URL
        video_url = ""
        generated_video = video.get("generatedVideo", {}) if isinstance(video.get("generatedVideo"), dict) else {}
        if generated_video.get("fifeUrl"):
            video_url = str(generated_video["fifeUrl"])
        if not video_url and video.get("fifeUrl"):
            video_url = str(video["fifeUrl"])
        
        # THUMBNAIL URL
        thumbnail_url = ""
        generated_image = video.get("generatedImage", {}) if isinstance(video.get("generatedImage"), dict) else {}
        if generated_image.get("fifeUrl"):
            thumbnail_url = str(generated_image["fifeUrl"])
        if not thumbnail_url:
            poster = video.get("poster", {}) if isinstance(video.get("poster"), dict) else {}
            if poster.get("fifeUrl"):
                thumbnail_url = str(poster["fifeUrl"])
        if not thumbnail_url:
            thumbnail_url = str(video.get("servingBaseUri") or "")
        
        return video_url, thumbnail_url
    
    # =========================
    # FORMAT CŨ: operations array
    # =========================
    operation = op.get("operation", {}) if isinstance(op.get("operation"), dict) else {}
    metadata = operation.get("metadata", {}) if isinstance(operation.get("metadata"), dict) else {}
    video = metadata.get("video", {}) if isinstance(metadata.get("video"), dict) else {}
    
    # VIDEO URL
    video_url = ""
    generated_video = video.get("generatedVideo", {}) if isinstance(video.get("generatedVideo"), dict) else {}
    if generated_video.get("fifeUrl"):
        video_url = str(generated_video["fifeUrl"])
    if not video_url and video.get("fifeUrl"):
        video_url = str(video["fifeUrl"])
    
    # THUMBNAIL URL
    thumbnail_url = ""
    generated_image = video.get("generatedImage", {}) if isinstance(video.get("generatedImage"), dict) else {}
    if generated_image.get("fifeUrl"):
        thumbnail_url = str(generated_image["fifeUrl"])
    if not thumbnail_url:
        poster = video.get("poster", {}) if isinstance(video.get("poster"), dict) else {}
        if poster.get("fifeUrl"):
            thumbnail_url = str(poster["fifeUrl"])
    if not thumbnail_url:
        serving_base_uri = str(video.get("servingBaseUri") or "")
        if serving_base_uri:
            thumbnail_url = serving_base_uri
        else:
            image = metadata.get("image", {}) if isinstance(metadata.get("image"), dict) else {}
            thumbnail_url = str(image.get("fifeUrl") or image.get("uri") or "")
    
    return video_url, thumbnail_url

