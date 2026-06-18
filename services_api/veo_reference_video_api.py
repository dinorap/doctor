import json
import uuid
from typing import Any, Dict, List, Optional, Tuple

from playwright.async_api import Page  # type: ignore

URL_GENERATE_REFERENCE_VIDEO = "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages"
URL_STATUS_REFERENCE_VIDEO = "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus"
URL_UPLOAD_USER_IMAGE = "https://aisandbox-pa.googleapis.com/v1:uploadUserImage"


IMAGE_ASPECT_RATIO_LANDSCAPE = "IMAGE_ASPECT_RATIO_LANDSCAPE"
IMAGE_ASPECT_RATIO_PORTRAIT = "IMAGE_ASPECT_RATIO_PORTRAIT"

VIDEO_ASPECT_RATIO_LANDSCAPE = "VIDEO_ASPECT_RATIO_LANDSCAPE"
VIDEO_ASPECT_RATIO_PORTRAIT = "VIDEO_ASPECT_RATIO_PORTRAIT"

DEFAULT_SEED = 9797

# Model keys r2v (tham khảo theo veo_video_api: t2v -> r2v)
MODEL_KEY_ULTRA_LANDSCAPE = "veo_3_1_r2v_fast_landscape_ultra"
MODEL_KEY_PORTRAIT_ULTRA = "veo_3_1_r2v_fast_portrait_ultra"

MODEL_KEY_ULTRA_LANDSCAPE_RELAXED = "veo_3_1_r2v_fast_landscape_ultra_relaxed"
MODEL_KEY_PORTRAIT_ULTRA_RELAXED = "veo_3_1_r2v_fast_portrait_ultra_relaxed"

MODEL_KEY_LANDSCAPE_NORMAL_PRO = "veo_3_1_r2v_fast_landscape"
MODEL_KEY_PORTRAIT_NORMAL_PRO = "veo_3_1_r2v_fast_portrait"

# Quality model (không fast) — theo veo_video_api: thay t2v -> r2v
MODEL_KEY_LANDSCAPE_QUALITY = "veo_3_1_r2v"
MODEL_KEY_PORTRAIT_QUALITY = "veo_3_1_r2v_portrait"

MODEL_KEY_LITE = "veo_3_1_r2v_lite"
MODEL_KEY_LITE_4S = "veo_3_1_r2v_lite_4s"
MODEL_KEY_LITE_6S = "veo_3_1_r2v_lite_6s"

MODEL_KEY_LITE_LOW_PRIORITY = "veo_3_1_r2v_lite_low_priority"
MODEL_KEY_LITE_4S_LOW_PRIORITY = "veo_3_1_r2v_lite_4s_low_priority"
MODEL_KEY_LITE_6S_LOW_PRIORITY = "veo_3_1_r2v_lite_6s_low_priority"


def _normalize_account_type(value: Optional[str]) -> str:
    v = str(value or "").strip().upper()
    return v if v in {"NORMAL", "PRO", "ULTRA"} else "ULTRA"


def _user_paygate_tier(account_type: Optional[str]) -> str:
    """
    Map NORMAL/PRO/ULTRA sang PAYGATE_TIER_* giống veo_video_api.
    """
    t = _normalize_account_type(account_type)
    if t == "NORMAL":
        return "PAYGATE_TIER_NOT_PAID"
    if t == "PRO":
        return "PAYGATE_TIER_ONE"
    return "PAYGATE_TIER_TWO"


def _normalize_model_label(model: Optional[str]) -> str:
    """
    Chuẩn hoá nhãn model từ frontend (veo 3.1 - fast / quality / fast [low priority]...).
    """
    if not isinstance(model, str):
        return ""
    return " ".join(model.strip().lower().split())


def _is_fast_2_mode(veo_model: Optional[str]) -> bool:
    return "fast 2.0" in str(veo_model or "").strip().lower()


def _append_duration_to_r2v_key(base_key: str, scene_duration: str) -> str:
    if scene_duration in ("4s", "6s"):
        return f"{base_key}_{scene_duration}"
    return base_key


def _resolve_lite_r2v_model_key(scene_duration: str) -> str:
    if scene_duration == "4s":
        return MODEL_KEY_LITE_4S
    if scene_duration == "6s":
        return MODEL_KEY_LITE_6S
    return MODEL_KEY_LITE


def _resolve_lite_low_priority_r2v_model_key(scene_duration: str) -> str:
    if scene_duration == "4s":
        return MODEL_KEY_LITE_4S_LOW_PRIORITY
    if scene_duration == "6s":
        return MODEL_KEY_LITE_6S_LOW_PRIORITY
    return MODEL_KEY_LITE_LOW_PRIORITY


def _fast_8s_r2v_model_key(*, account_type: Optional[str], is_portrait: bool) -> str:
    acc = _normalize_account_type(account_type)
    if acc == "ULTRA":
        return MODEL_KEY_PORTRAIT_ULTRA if is_portrait else MODEL_KEY_ULTRA_LANDSCAPE
    return MODEL_KEY_PORTRAIT_NORMAL_PRO if is_portrait else MODEL_KEY_LANDSCAPE_NORMAL_PRO


def _resolve_fast_r2v_model_key(
    scene_duration: str,
    *,
    account_type: Optional[str],
    is_portrait: bool,
) -> str:
    base = _fast_8s_r2v_model_key(account_type=account_type, is_portrait=is_portrait)
    return _append_duration_to_r2v_key(base, scene_duration)


def _resolve_quality_r2v_model_key(scene_duration: str, *, is_portrait: bool) -> str:
    base = MODEL_KEY_PORTRAIT_QUALITY if is_portrait else MODEL_KEY_LANDSCAPE_QUALITY
    return _append_duration_to_r2v_key(base, scene_duration)


def select_reference_video_model_key(
    *,
    aspect_ratio: str,
    frontend_model_label: Optional[str],
    account_type: Optional[str],
    scene_duration: Optional[str] = None,
) -> str:
    """Chon model r2v theo label + thoi luong (4s/6s suffix; 8s key cu)."""
    from services_api.veo_video_api import (  # noqa: WPS433
        is_lite_low_priority_frontend_model,
        is_omni_flash_frontend_model,
        normalize_veo_scene_duration_label,
        resolve_omni_flash_video_model_key,
    )

    label = _normalize_model_label(frontend_model_label)
    is_portrait = aspect_ratio == VIDEO_ASPECT_RATIO_PORTRAIT
    duration = normalize_veo_scene_duration_label(scene_duration)

    if is_omni_flash_frontend_model(frontend_model_label):
        return resolve_omni_flash_video_model_key(duration)

    if not label:
        return _resolve_lite_low_priority_r2v_model_key(duration)

    if label == "veo 3.1 - lite":
        return _resolve_lite_r2v_model_key(duration)

    if is_lite_low_priority_frontend_model(frontend_model_label):
        return _resolve_lite_low_priority_r2v_model_key(duration)

    if label == "veo 3.1 - fast":
        return _resolve_fast_r2v_model_key(
            duration, account_type=account_type, is_portrait=is_portrait
        )

    if label == "veo 3.1 - quality":
        return _resolve_quality_r2v_model_key(duration, is_portrait=is_portrait)

    acc = _normalize_account_type(account_type)
    if acc == "ULTRA":
        if _is_fast_2_mode(frontend_model_label):
            return (
                MODEL_KEY_PORTRAIT_ULTRA_RELAXED
                if is_portrait
                else MODEL_KEY_ULTRA_LANDSCAPE_RELAXED
            )
        return MODEL_KEY_PORTRAIT_ULTRA if is_portrait else MODEL_KEY_ULTRA_LANDSCAPE
    return MODEL_KEY_PORTRAIT_NORMAL_PRO if is_portrait else MODEL_KEY_LANDSCAPE_NORMAL_PRO


def build_payload_upload_user_image(
    *,
    base64_image: str,
    mime_type: str,
    session_id: str,
    aspect_ratio: str = IMAGE_ASPECT_RATIO_PORTRAIT,
) -> Dict[str, Any]:
    return {
        "imageInput": {
            "rawImageBytes": base64_image,
            "mimeType": mime_type,
            "isUserUploaded": True,
            "aspectRatio": aspect_ratio,
        },
        "clientContext": {
            "sessionId": session_id,
            "tool": "ASSET_MANAGER",
        },
    }


def build_payload_generate_reference_video(
    *,
    recaptcha_token: str,
    session_id: str,
    project_id: str,
    prompt: str,
    seed: Optional[int],
    video_model_key: str,
    reference_media_ids: List[str],
    scene_id: Optional[str] = None,
    aspect_ratio: str = VIDEO_ASPECT_RATIO_PORTRAIT,
    output_count: int = 1,
    account_type: Optional[str] = None,
    batch_id: Optional[str] = None,
    reference_audio_media_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Xây payload cho batchAsyncGenerateVideoReferenceImages (Reference Video).
    reference_audio_media_id: mediaId giọng (chữ thường), giống build_text_to_video_payload.
    """
    refs: List[Dict[str, Any]] = []
    for media_id in list(reference_media_ids or [])[:3]:
        mid = str(media_id or "").strip()
        if not mid:
            continue
        refs.append(
            {
                "mediaId": mid,
                "imageUsageType": "IMAGE_USAGE_TYPE_ASSET",
            }
        )

    if not refs:
        raise ValueError("reference_media_ids is required")

    user_paygate_tier = _user_paygate_tier(account_type)

    request_item: Dict[str, Any] = {
        "aspectRatio": aspect_ratio,
        "seed": int(seed or DEFAULT_SEED),
        "textInput": {
            "structuredPrompt": {
                "parts": [
                    {
                        "text": str(prompt or ""),
                    }
                ]
            }
        },
        "videoModelKey": str(video_model_key or "").strip(),
        "metadata": {},
        "referenceImages": refs,
    }

    if reference_audio_media_id:
        mid = str(reference_audio_media_id or "").strip().lower()
        if mid:
            request_item["referenceAudio"] = [{"mediaId": mid}]

    if scene_id:
        request_item["metadata"]["sceneId"] = str(scene_id)

    count = int(output_count or 1)
    if count < 1:
        count = 1

    requests = [json.loads(json.dumps(request_item)) for _ in range(count)]

    payload: Dict[str, Any] = {
        "clientContext": {
            "projectId": str(project_id or ""),
            "tool": "PINHOLE",
            "userPaygateTier": user_paygate_tier,
            "sessionId": str(session_id or ""),
            "recaptchaContext": {
                "token": str(recaptcha_token or ""),
                "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
            },
        },
        "mediaGenerationContext": {
            "batchId": str(batch_id or uuid.uuid4()),
        },
        "requests": requests,
    }

    return payload


def debug_log_reference_video_payload(
    *,
    payload: Dict[str, Any],
    log_prefix: str = "VEO Video API",
    profile_tag: str = "????",
    scene_id: Any = "?",
    character_field: str = "",
    source_media_ids: Optional[List[str]] = None,
    use_cast_profile_references: bool = False,
    prompt_preview_len: int = 240,
    max_json_chars: int = 12000,
) -> None:
    """
    Log payload Reference Video trước khi gửi (ẩn recaptcha token).
    """
    try:
        clone: Dict[str, Any] = json.loads(json.dumps(payload))
    except Exception:
        clone = dict(payload)

    cc = clone.get("clientContext")
    if isinstance(cc, dict):
        rc = cc.get("recaptchaContext")
        if isinstance(rc, dict) and rc.get("token"):
            rc["token"] = "***"

    ptag = profile_tag
    print(f"[{log_prefix}] [{ptag}] 🔍 REFERENCE VIDEO PAYLOAD scene={scene_id}")
    if use_cast_profile_references:
        print(f"  scene.character: {character_field!r}")
    if source_media_ids is not None:
        print(f"  resolved reference_media_ids (input): {source_media_ids}")

    mgc = clone.get("mediaGenerationContext") or {}
    if isinstance(mgc, dict) and mgc.get("batchId"):
        print(f"  mediaGenerationContext.batchId: {mgc.get('batchId')}")

    reqs = clone.get("requests") or []
    if not isinstance(reqs, list):
        reqs = []
    for i, req in enumerate(reqs):
        if not isinstance(req, dict):
            continue
        refs = req.get("referenceImages") or []
        ref_ids: List[str] = []
        if isinstance(refs, list):
            for r in refs:
                if isinstance(r, dict) and r.get("mediaId"):
                    ref_ids.append(str(r["mediaId"]))
        meta = req.get("metadata") if isinstance(req.get("metadata"), dict) else {}
        prompt_text = ""
        try:
            parts = (
                req.get("textInput", {})
                .get("structuredPrompt", {})
                .get("parts", [])
            )
            if parts and isinstance(parts[0], dict):
                prompt_text = str(parts[0].get("text") or "")
        except Exception:
            pass
        preview = prompt_text[:prompt_preview_len]
        if len(prompt_text) > prompt_preview_len:
            preview += "…"
        print(f"  requests[{i}]:")
        print(f"    videoModelKey: {req.get('videoModelKey')}")
        print(f"    aspectRatio: {req.get('aspectRatio')}")
        print(f"    seed: {req.get('seed')}")
        print(f"    metadata.sceneId: {meta.get('sceneId')}")
        print(f"    referenceImages[].mediaId: {ref_ids}")
        ra = req.get("referenceAudio")
        if ra:
            print(f"    referenceAudio: {ra}")
        print(f"    prompt: {preview!r}")

    try:
        body = json.dumps(clone, ensure_ascii=False, indent=2)
        if len(body) > max_json_chars:
            body = body[:max_json_chars] + f"\n… (truncated, total {len(body)} chars)"
        print(f"[{log_prefix}] [{ptag}] 📦 payload JSON (token masked):\n{body}")
    except Exception as e:
        print(f"[{log_prefix}] [{ptag}] ⚠️ Không serialize payload debug: {e}")


async def _send_request_via_browser(
    page: Page,
    url: str,
    payload: Dict[str, Any],
    access_token: str,
) -> Dict[str, Any]:
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
    except Exception as exc:
        return {
            "ok": False,
            "url": url,
            "error": str(exc),
        }


async def request_upload_user_image_via_browser(
    page: Page,
    payload: Dict[str, Any],
    access_token: str,
) -> Dict[str, Any]:
    """
    Upload ảnh tham chiếu qua endpoint v1:uploadUserImage (Reference Video).
    """
    return await _send_request_via_browser(
        page,
        URL_UPLOAD_USER_IMAGE,
        payload,
        access_token,
    )


async def request_create_reference_video_via_browser(
    page: Page,
    payload: Dict[str, Any],
    access_token: str,
) -> Dict[str, Any]:
    """
    Gửi request tạo video reference qua batchAsyncGenerateVideoReferenceImages.
    """
    return await _send_request_via_browser(
        page,
        URL_GENERATE_REFERENCE_VIDEO,
        payload,
        access_token,
    )


async def request_check_reference_status_via_browser(
    page: Page,
    payload: Dict[str, Any],
    access_token: str,
) -> Dict[str, Any]:
    """
    Check status reference video. 
    - Nếu payload có operations[] → dùng operation polling endpoint (chính xác nhất)
    - Nếu payload có media[] → thử /v1/media:batchCheckAsyncVideoGenerationStatus
      (endpoint này có thể 404 cho reference video, nên fallback sang operation)
    """
    from services_api.veo_video_api import URL_STATUS_MEDIA_BATCH

    # Ưu tiên operations[] → poll qua operation endpoint
    if isinstance(payload.get("operations"), list) and payload.get("operations"):
        ops = payload["operations"]
        for op in ops:
            if isinstance(op, dict) and op.get("name"):
                return await request_get_operation_via_browser(
                    page, op["name"], access_token
                )

    # Thử media[] với endpoint /v1/media:... trước
    if isinstance(payload.get("media"), list) and payload.get("media"):
        res = await _send_request_via_browser(
            page, URL_STATUS_MEDIA_BATCH, payload, access_token
        )
        if res.get("ok") and res.get("status") == 200:
            return res
        # Nếu 404 hoặc fail → fallback sang operation polling
        # (response từ generate thường có operation.name để poll)

    # Fallback: thử operations[] endpoint cũ
    return await _send_request_via_browser(
        page,
        URL_STATUS_REFERENCE_VIDEO,
        payload,
        access_token,
    )


async def request_get_operation_via_browser(
    page: Page,
    operation_name: str,
    access_token: str,
) -> Dict[str, Any]:
    """
    Gọi GET operation để lấy video URL sau khi status = SUCCESSFUL (reference video).
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


def parse_operations_from_reference_response(response_body: str) -> List[Dict[str, Any]]:
    """
    Parse mediaId/operation từ response create reference video.
    Hỗ trợ cả format media[] (API mới) và operations[] (cũ).
    """
    try:
        from services_api.veo_video_api import parse_operations_from_create_response

        return parse_operations_from_create_response(response_body)
    except Exception:
        pass
    try:
        body_json = json.loads(response_body or "")
    except Exception:
        return []
    ops = body_json.get("operations", [])
    return ops if isinstance(ops, list) else []


def extract_media_from_reference_status_op(op: Dict[str, Any]) -> Tuple[str, str]:
    """
    Trích video/image URL từ 1 operation trong response check status reference.
    Trả về (video_url, thumbnail_url).
    
    Logic mới hỗ trợ cấu trúc API mới từ Google Flow/Veo:
    - video.generatedVideo.fifeUrl (format mới)
    - video.fifeUrl (fallback)
    - video.generatedImage.fifeUrl (thumbnail format mới)
    - video.poster.fifeUrl (thumbnail fallback)
    """
    operation = op.get("operation", {}) if isinstance(op.get("operation"), dict) else {}
    metadata = operation.get("metadata", {}) if isinstance(operation.get("metadata"), dict) else {}
    video = metadata.get("video", {}) if isinstance(metadata.get("video"), dict) else {}
    
    # =========================
    # VIDEO URL
    # =========================
    video_url = ""
    
    # Format mới: generatedVideo.fifeUrl
    generated_video = video.get("generatedVideo", {}) if isinstance(video.get("generatedVideo"), dict) else {}
    if generated_video.get("fifeUrl"):
        video_url = str(generated_video["fifeUrl"])
    
    # Fallback: video.fifeUrl (format cũ)
    if not video_url and video.get("fifeUrl"):
        video_url = str(video["fifeUrl"])
    
    # =========================
    # THUMBNAIL URL
    # =========================
    thumbnail_url = ""
    
    # Format mới: generatedImage.fifeUrl
    generated_image = video.get("generatedImage", {}) if isinstance(video.get("generatedImage"), dict) else {}
    if generated_image.get("fifeUrl"):
        thumbnail_url = str(generated_image["fifeUrl"])
    
    # Fallback: poster.fifeUrl
    if not thumbnail_url:
        poster = video.get("poster", {}) if isinstance(video.get("poster"), dict) else {}
        if poster.get("fifeUrl"):
            thumbnail_url = str(poster["fifeUrl"])
    
    # Fallback cũ: servingBaseUri hoặc image.fifeUrl
    if not thumbnail_url:
        serving_base_uri = str(video.get("servingBaseUri") or "")
        if serving_base_uri:
            thumbnail_url = serving_base_uri
        else:
            image = metadata.get("image", {}) if isinstance(metadata.get("image"), dict) else {}
            thumbnail_url = str(image.get("fifeUrl") or image.get("uri") or "")
    
    return video_url, thumbnail_url

