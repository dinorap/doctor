import aiohttp
import base64
import logging
import re
import time
from pathlib import Path

from engine.db import crud
from engine.services.flow_client import get_flow_client
from engine.utils.slugify import slugify
from engine.utils.paths import project_dir, scene_img_path, scene_video_path

logger = logging.getLogger(__name__)

def is_url_expired(url: str) -> bool:
    """Check if a GCS signed URL is expired or close to expiration (<60s)."""
    if not url or "Expires=" not in url:
        return False
    m = re.search(r'Expires=(\d+)', url)
    if m:
        # Buffer 60 seconds
        return int(m.group(1)) < time.time() + 60
    return False

def get_local_path(req_type: str, project_slug: str, scene_or_char: dict) -> Path | None:
    if not scene_or_char:
        return None
    if req_type in ("GENERATE_IMAGE", "REGENERATE_IMAGE", "EDIT_IMAGE"):
        return scene_img_path(project_slug, scene_or_char["id"])
    elif req_type in ("GENERATE_VIDEO", "REGENERATE_VIDEO", "GENERATE_VIDEO_REFS"):
        return scene_video_path(project_slug, scene_or_char["id"])
    elif req_type in ("UPSCALE_VIDEO",):
        return scene_video_path(project_slug, scene_or_char["id"], subdir="4k")
    elif req_type in ("GENERATE_CHARACTER_IMAGE", "REGENERATE_CHARACTER_IMAGE", "EDIT_CHARACTER_IMAGE"):
        return project_dir(project_slug) / "assets" / f"{scene_or_char['id']}.jpg"
    return None

async def download_media_to_local(url: str, project_slug: str, req_type: str, scene_or_char: dict):
    if not url or not url.startswith("http"):
        return
    path = get_local_path(req_type, project_slug, scene_or_char)
    if not path:
        return
    
    # Don't download if it already exists
    if path.exists():
        return
        
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=30) as resp:
                if resp.status == 200:
                    path.write_bytes(await resp.read())
                    logger.info("Saved local media: %s", path)
    except Exception as e:
        logger.warning("Failed to save local media %s: %s", url[:60], e)

async def check_and_recover_media(media_id: str, url: str, project_id: str, local_path: Path | None, auto_reupload: bool = True) -> tuple[bool, str | None]:
    """Returns (is_available, optional_error_message). 
    If expired, tries to refresh from Google API. If deleted and auto_reupload is True, uploads local file to get new media_id."""
    if not media_id:
        return False, "No media_id provided"
        
    if not is_url_expired(url):
        return True, None
        
    client = get_flow_client()
    logger.info("Media URL expired for %s, trying to refresh via get_media", media_id[:12])
    
    # 1. Try to refresh via get_media
    try:
        res = await client.get_media(media_id)
        if isinstance(res, dict) and not res.get("error") and res.get("status") == 200:
            data = res.get("data", {})
            fresh_url = data.get("fifeUrl") or data.get("servingUri")
            if fresh_url:
                media_type = "image"
                if local_path and local_path.suffix == ".mp4":
                    media_type = "video"
                # This will update DB via the flow_client method
                await client._refresh_media_urls([{"mediaId": media_id, "mediaType": media_type, "url": fresh_url}])
                logger.info("Successfully refreshed media URL for %s", media_id[:12])
                return True, None
    except Exception as e:
        logger.warning("Refresh get_media failed for %s: %s", media_id[:12], e)

    # 2. If get_media failed (meaning Google deleted it), try to upload from local
    if local_path and local_path.exists():
        if not auto_reupload:
            logger.info("Google deleted media %s, but auto_reupload is False. Fallback deferred.", media_id[:12])
            return False, "Deleted by Google, reupload deferred"
            
        logger.info("Google deleted media %s, re-uploading from local %s", media_id[:12], local_path)
        try:
            image_bytes = local_path.read_bytes()
            image_b64 = base64.b64encode(image_bytes).decode()
            mime = "video/mp4" if local_path.suffix == ".mp4" else "image/jpeg"
            result = await client.upload_image(image_b64, mime_type=mime, project_id=project_id, file_name=local_path.name)
            new_mid = result.get("_mediaId")
            if new_mid:
                # Update DB
                # Note: We return a special string and let processor update the correct DB fields
                return True, f"RECOVERED:{new_mid}"
            else:
                err_msg = result.get("error") or result.get("status") or result
                logger.error("Failed to re-upload local media %s. Flow result: %s", local_path, err_msg)
                return False, f"Upload API failed: {err_msg}"
        except Exception as e:
            logger.error("Failed to re-upload local media %s: %s", local_path, e)
            return False, f"Failed to re-upload local media: {e}"
            
    return False, "Media URL expired, entity not found on Google, and no local backup available"
