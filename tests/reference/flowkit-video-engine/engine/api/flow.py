"""Direct Flow API endpoints — for manual operations outside the queue."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from engine.services.flow_client import get_flow_client

router = APIRouter(prefix="/flow", tags=["flow"])


class GenerateImageRequest(BaseModel):
    prompt: str
    project_id: str
    aspect_ratio: str = "IMAGE_ASPECT_RATIO_PORTRAIT"
    user_paygate_tier: str = "PAYGATE_TIER_ONE"
    character_media_ids: Optional[list[str]] = None


class GenerateVideoRequest(BaseModel):
    start_image_media_id: str
    prompt: str
    project_id: str
    scene_id: str
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT"
    end_image_media_id: Optional[str] = None
    user_paygate_tier: str = "PAYGATE_TIER_ONE"


class GenerateVideoRefsRequest(BaseModel):
    reference_media_ids: list[str]
    prompt: str
    project_id: str
    scene_id: str
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT"
    user_paygate_tier: str = "PAYGATE_TIER_ONE"


class UpscaleVideoRequest(BaseModel):
    media_id: str
    scene_id: str
    aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT"
    resolution: str = "VIDEO_RESOLUTION_4K"


class UploadImageRequest(BaseModel):
    file_path: str  # absolute path to local image file
    project_id: str = ""
    file_name: str = "image.png"


class CheckStatusRequest(BaseModel):
    operations: list[dict]


class EditImageRequest(BaseModel):
    prompt: str
    source_media_id: str
    project_id: str
    aspect_ratio: str = "IMAGE_ASPECT_RATIO_PORTRAIT"
    user_paygate_tier: str = "PAYGATE_TIER_ONE"


@router.get("/status")
async def extension_status():
    """Check if extension is connected."""
    client = get_flow_client()
    return {
        "connected": client.connected,
        "flow_key_present": client._flow_key is not None,
    }


@router.get("/credits")
async def get_credits():
    """Get user credits from Google Flow."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.get_credits()
    if result.get("error"):
        raise HTTPException(502, result["error"])
    return result.get("data", result)


@router.post("/generate-image")
async def generate_image(body: GenerateImageRequest):
    """Generate image directly (bypasses queue)."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.generate_images(**body.model_dump())
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    return result.get("data", result)


@router.post("/generate-video")
async def generate_video(body: GenerateVideoRequest):
    """Submit video generation (returns operations for polling)."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.generate_video(**body.model_dump(exclude_none=True))
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    return result.get("data", result)


@router.post("/generate-video-refs")
async def generate_video_refs(body: GenerateVideoRefsRequest):
    """Submit r2v video generation from reference images."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.generate_video_from_references(**body.model_dump())
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    return result.get("data", result)


@router.post("/upscale-video")
async def upscale_video(body: UpscaleVideoRequest):
    """Submit video upscale (returns operations for polling)."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.upscale_video(**body.model_dump())
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    return result.get("data", result)


@router.post("/check-status")
async def check_status(body: CheckStatusRequest):
    """Check video generation status."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.check_video_status(body.operations)
    if result.get("error"):
        raise HTTPException(502, result["error"])
    return result.get("data", result)


@router.post("/refresh-urls/{project_id}")
async def refresh_project_urls(project_id: str):
    """Bulk refresh all media URLs for a project via per-media get_media calls."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.refresh_project_urls(project_id)
    if result.get("error"):
        raise HTTPException(502, result["error"])
    return result


@router.get("/media/{media_id}")
async def get_media(media_id: str):
    """Get media metadata + fresh signed URL from Google Flow.

    Returns the raw response which should contain a fresh fifeUrl/servingUri.
    Use this to refresh expired GCS signed URLs.
    """
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.get_media(media_id)
    if result.get("error"):
        raise HTTPException(502, result["error"])
    status = result.get("status", 200)
    if isinstance(status, int) and status >= 400:
        raise HTTPException(status, result.get("data", "Media not found"))
    return result.get("data", result)


@router.post("/edit-image")
async def edit_image(body: EditImageRequest):
    """Edit an existing image using IMAGE_INPUT_TYPE_BASE_IMAGE (bypasses queue)."""
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    result = await client.edit_image(
        body.prompt, body.source_media_id, body.project_id,
        aspect_ratio=body.aspect_ratio,
        user_paygate_tier=body.user_paygate_tier,
    )
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    return result.get("data", result)


@router.post("/upload-image")
async def upload_image(body: UploadImageRequest):
    """Upload a local image file to Google Flow and get a media_id."""
    import base64, mimetypes
    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")
    try:
        with open(body.file_path, "rb") as f:
            image_bytes = f.read()
    except FileNotFoundError:
        raise HTTPException(404, f"File not found: {body.file_path}")
    b64 = base64.b64encode(image_bytes).decode()
    mime = mimetypes.guess_type(body.file_path)[0] or "image/png"
    result = await client.upload_image(b64, mime_type=mime, project_id=body.project_id, file_name=body.file_name)
    if result.get("error") or (isinstance(result.get("status"), int) and result["status"] >= 400):
        raise HTTPException(result.get("status", 502), result.get("error", result.get("data")))
    media_id = result.get("_mediaId")
    return {"media_id": media_id, "raw": result.get("data", result)}

@router.post("/recover-media/{media_id}")
async def recover_media_endpoint(media_id: str):
    """Attempt to recover a broken/expired media URL."""
    from engine.db import crud
    from engine.utils.media_recovery import check_and_recover_media, get_local_path
    from engine.utils.slugify import slugify
    import logging
    logger = logging.getLogger(__name__)

    # Find the entity that owns this media_id
    scenes = await crud.list_scenes_by_media_id(media_id)
    chars = await crud.list_characters_by_media_id(media_id)
    
    if not scenes and not chars:
        raise HTTPException(404, f"No scene or character found with media_id {media_id}")
        
    entity = scenes[0] if scenes else chars[0]
    pid = entity.get("project_id") if scenes else ""
    if not pid and chars:
        # Get project linked to char, or just use "0"
        linked_projects = await crud.get_db()
        cur = await linked_projects.execute("SELECT project_id FROM project_character WHERE character_id=?", (entity["id"],))
        rows = await cur.fetchall()
        pid = rows[0]["project_id"] if rows else "0"

    project = await crud.get_project(pid) if pid != "0" else None
    project_slug = slugify(project["name"]) if project else "project"

    # Determine type and url
    req_type = "GENERATE_CHARACTER_IMAGE"
    url = entity.get("reference_image_url", "")
    if scenes:
        # Guess the req type based on where the media_id is used
        if entity.get("vertical_video_media_id") == media_id or entity.get("horizontal_video_media_id") == media_id:
            req_type = "GENERATE_VIDEO"
            url = entity.get("vertical_video_url") if entity.get("vertical_video_media_id") == media_id else entity.get("horizontal_video_url", "")
        elif entity.get("vertical_upscale_media_id") == media_id or entity.get("horizontal_upscale_media_id") == media_id:
            req_type = "UPSCALE_VIDEO"
            url = entity.get("vertical_upscale_url") if entity.get("vertical_upscale_media_id") == media_id else entity.get("horizontal_upscale_url", "")
        else:
            req_type = "GENERATE_IMAGE"
            url = entity.get("vertical_image_url") if entity.get("vertical_image_media_id") == media_id else entity.get("horizontal_image_url", "")

    local_path = get_local_path(req_type, project_slug, entity)
    ok, err = await check_and_recover_media(media_id, url, pid, local_path)
    
    if ok and err and err.startswith("RECOVERED:"):
        # The media_id changed! Update it in the database
        new_mid = err.split(":")[1]
        updates = {}
        if scenes:
            scene = entity
            for k, v in scene.items():
                if v == media_id and k.endswith("_media_id"):
                    updates[k] = new_mid
            if updates:
                await crud.update_scene(scene["id"], **updates)
        elif chars:
            char = entity
            if char.get("media_id") == media_id:
                await crud.update_character(char["id"], media_id=new_mid)
                
        # Emit event to refresh UI
        from engine.services.event_bus import event_bus
        await event_bus.emit("project_updated", {"id": pid})
        return {"success": True, "recovered": True, "new_media_id": new_mid}
        
    elif ok:
        # Emit event since URL was refreshed by get_media and _refresh_media_urls emitted URLs refreshed
        from engine.services.event_bus import event_bus
        await event_bus.emit("project_updated", {"id": pid})
        return {"success": True, "refreshed": True}
        
    raise HTTPException(502, f"Failed to recover media: {err}")

@router.get("/media-local/{media_id}")
async def get_local_media_fallback(media_id: str):
    """Serve the local backup of a media file as a fallback."""
    from engine.db import crud
    from engine.utils.media_recovery import get_local_path
    from engine.utils.slugify import slugify
    from fastapi.responses import FileResponse
    import os

    scenes = await crud.list_scenes_by_media_id(media_id)
    chars = await crud.list_characters_by_media_id(media_id)
    if not scenes and not chars:
        raise HTTPException(404, "Media not found")
        
    entity = scenes[0] if scenes else chars[0]
    pid = entity.get("project_id") if scenes else ""
    if not pid and chars:
        db = await crud.get_db()
        cur = await db.execute("SELECT project_id FROM project_character WHERE character_id=?", (entity["id"],))
        rows = await cur.fetchall()
        pid = rows[0]["project_id"] if rows else "0"

    project = await crud.get_project(pid) if pid != "0" else None
    project_slug = slugify(project["name"]) if project else "project"

    req_type = "GENERATE_CHARACTER_IMAGE"
    if scenes:
        if entity.get("vertical_video_media_id") == media_id or entity.get("horizontal_video_media_id") == media_id:
            req_type = "GENERATE_VIDEO"
        elif entity.get("vertical_upscale_media_id") == media_id or entity.get("horizontal_upscale_media_id") == media_id:
            req_type = "UPSCALE_VIDEO"
        else:
            req_type = "GENERATE_IMAGE"

    local_path = get_local_path(req_type, project_slug, entity)
    if local_path and os.path.exists(local_path):
        return FileResponse(local_path)
    raise HTTPException(404, "Local fallback not found")
