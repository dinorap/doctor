import json
import logging
import re
from datetime import datetime, timezone

import aiohttp
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from engine.config import BASE_DIR
from engine.models.project import Project, ProjectCreate, ProjectUpdate
from engine.models.character import Character
from engine.models.video import Video
from engine.sdk.persistence.sqlite_repository import SQLiteRepository
from engine.services.flow_client import get_flow_client
from engine.utils.slugify import slugify

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["projects"])


COMPOSITION_GUIDELINES = {
    "character": (
        "COMPOSITION: Comprehensive character design sheet layout. "
        "Must include four distinct sections: "
        "1. Body shots (Full body, half body, three-quarter body, and close-up). "
        "2. Multi-angle character turnaround (A three-view: front, side, back rotation chart). "
        "3. Expression sheet (Showing basic emotional states). "
        "4. Pose sheet (Showing typical actions). "
        "Use a clean, neutral background."
    ),
    "location": (
        "COMPOSITION: Comprehensive environment design sheet layout. "
        "Must include four distinct sections: "
        "1. Master establishing shot (Wide angle showing the full environment). "
        "2. Alternate angle (Reverse shot or different perspective). "
        "3. Detail callouts (Close-up of key architectural, natural, or thematic details). "
        "4. Lighting/Mood variation (Showing how the environment looks under different lighting or weather conditions). "
        "Maintain consistent spatial layout and atmosphere."
    ),
    "creature": (
        "COMPOSITION: Comprehensive creature design sheet layout. "
        "Must include four distinct sections: "
        "1. Body shots (Full body and close-up of face/head). "
        "2. Multi-angle turnaround (Front, side, and back views). "
        "3. Action/Movement poses (Showing natural stance, locomotion, or attack pose). "
        "4. Detail callouts (Close-ups of specific anatomical features like claws, scales, or wings). "
        "Use a clean, neutral background."
    ),
    "visual_asset": (
        "COMPOSITION: Comprehensive prop and asset design sheet layout. "
        "Must include four distinct sections: "
        "1. Main beauty shot (Angled three-quarter perspective). "
        "2. Orthographic views (Top, front, and side profiles). "
        "3. Functional/Mechanical views (Showing how it opens, moves, or is held/used). "
        "4. Material/Texture detail (Close-ups showcasing the surface materials and wear/tear). "
        "Use a clean, neutral background with proper scale reference."
    ),
    "generic_troop": (
        "COMPOSITION: Comprehensive troop and uniform design sheet layout. "
        "Must include four distinct sections: "
        "1. Uniform turnaround (Front, side, and back views of the standard loadout). "
        "2. Gear breakdown (Detailed callouts of weapons, armor, and equipment). "
        "3. Rank/Class variations (Showing slight modifications for different roles). "
        "4. Action poses (Showing the troop in a combat or tactical stance). "
        "Use a clean, neutral background."
    ),
    "faction": (
        "COMPOSITION: Comprehensive faction uniform design sheet layout. "
        "Must include four distinct sections: "
        "1. Uniform turnaround (Front, side, and back views of the standard loadout). "
        "2. Gear breakdown (Detailed callouts of weapons, armor, and equipment). "
        "3. Rank/Class variations (Showing slight modifications for different roles). "
        "4. Action poses (Showing the troop in a combat or tactical stance). "
        "Use a clean, neutral background."
    ),
}


_STYLE_COMPAT_MAP = {
    "3d": "3d_pixar",
    "3D": "3d_pixar",
    "photorealistic": "realistic",
}


def _resolve_material_id(value: str) -> str:
    """Map legacy style strings to material IDs. Returns value unchanged if no mapping."""
    return _STYLE_COMPAT_MAP.get(value, value)


def _build_character_profile(char_name: str, char_desc: str | None, story: str | None,
                              entity_type: str = "character", material_id: str = "3d_pixar") -> dict:
    """Build a rich profile (description + image_prompt) for any reference entity.

    The image_prompt generates a reference image used as mediaId for all
    scene generations. Visual appearance is defined HERE, not in scene prompts.
    Scene prompts should only describe actions/environment/composition.

    story may be None — in that case the description omits story context and
    the image_prompt uses a simpler prefix.
    """
    from engine.materials import get_material
    if material_id:
        material = get_material(material_id)
        if not material:
            raise ValueError(f"Unknown material: {material_id}")
        style_instruction = material["style_instruction"] + " "
        if material.get("negative_prompt"):
            style_instruction += f"{material['negative_prompt']} "
        lighting = material.get("lighting", "Studio lighting, highly detailed")
    else:
        style_instruction = ""
        lighting = "Studio lighting, highly detailed"

    base_desc = char_desc or char_name
    composition = COMPOSITION_GUIDELINES.get(entity_type, COMPOSITION_GUIDELINES["character"])

    sheet_types = {
        "character": "character design sheet",
        "location": "environment design sheet",
        "creature": "creature design sheet",
        "visual_asset": "prop and asset design sheet",
        "generic_troop": "troop and uniform design sheet",
        "faction": "faction and uniform design sheet"
    }
    sheet_name = sheet_types.get(entity_type, "concept design sheet")

    if story:
        description = f"{char_name}: {base_desc}. Story context: {story}"
    else:
        description = base_desc

    image_prefix = f"Comprehensive {sheet_name} for {base_desc}. "
    single_image_note = f"Create a detailed multi-panel {sheet_name}. "

    image_prompt = (
        f"{image_prefix}"
        f"{style_instruction}"
        f"{composition} "
        f"{single_image_note}"
        f"{lighting}"
    )

    return {"description": description, "image_prompt": image_prompt}


async def _detect_user_tier(client) -> str:
    """Auto-detect user paygate tier from Flow credits API."""
    try:
        result = await client.get_credits()
        data = result.get("data", result)
        tier = data.get("userPaygateTier", "PAYGATE_TIER_ONE")
        logger.info("Auto-detected user tier: %s", tier)
        return tier
    except Exception as e:
        logger.warning("Failed to detect tier, defaulting to TIER_ONE: %s", e)
        return "PAYGATE_TIER_ONE"


def _get_repo() -> SQLiteRepository:
    return SQLiteRepository()


@router.post("", response_model=Project)
async def create(body: ProjectCreate):
    """Create a new project on Google Flow and locally using ProjectCreator service."""
    from engine.services.project_creator import get_project_creator
    
    creator = get_project_creator()
    return await creator.create_project(body)


@router.get("", response_model=list[Project])
async def list_all(status: str = None):
    repo = _get_repo()
    rows = await repo.list("project", **({} if status is None else {"status": status}))
    return [repo._row_to_project(r) for r in rows]


@router.get("/{pid}", response_model=Project)
async def get(pid: str):
    repo = _get_repo()
    p = await repo.get_project(pid)
    if not p:
        raise HTTPException(404, "Project not found")
    return p


@router.get("/{pid}/chat/sessions")
async def get_chat_sessions(pid: str):
    from engine.db.crud import list_chat_sessions
    return await list_chat_sessions(pid)

@router.get("/{pid}/chat/sessions/{sid}")
async def get_chat_session_history(pid: str, sid: str):
    from engine.db.crud import list_chat_messages
    msgs = await list_chat_messages(sid)
    return [{"role": m["role"], "content": m["content"]} for m in msgs]



@router.patch("/{pid}", response_model=Project)
async def update(pid: str, body: ProjectUpdate):
    repo = _get_repo()
    row = await repo.update("project", pid, **body.model_dump(exclude_unset=True))
    if not row:
        raise HTTPException(404, "Project not found")
        
    from engine.services.event_bus import event_bus
    await event_bus.emit('project_updated', {'project_id': pid})
    
    return repo._row_to_project(row)


@router.delete("/{pid}")
async def delete(pid: str):
    repo = _get_repo()
    if not await repo.delete_project(pid):
        raise HTTPException(404, "Project not found")
        
    from engine.services.event_bus import event_bus
    await event_bus.emit('project_deleted', {'project_id': pid})
    
    return {"ok": True}


@router.post("/{pid}/characters/{cid}")
async def link_character(pid: str, cid: str):
    repo = _get_repo()
    if not await repo.link_character_to_project(pid, cid):
        raise HTTPException(400, "Failed to link character")
    return {"ok": True}


@router.delete("/{pid}/characters/{cid}")
async def unlink_character(pid: str, cid: str):
    repo = _get_repo()
    if not await repo.unlink_character_from_project(pid, cid):
        raise HTTPException(404, "Link not found")
    return {"ok": True}


@router.get("/{pid}/characters", response_model=list[Character])
async def get_characters(pid: str):
    repo = _get_repo()
    return await repo.get_project_characters(pid)


@router.get("/{pid}/output-dir")
async def get_output_dir(pid: str):
    """Get or create project output directory with meta.json."""
    repo = _get_repo()
    project = await repo.get_project(pid)
    if not project:
        raise HTTPException(404, "Project not found")

    project_name = project.name if hasattr(project, "name") else project["name"]
    slug = slugify(project_name)
    output_dir = BASE_DIR / "output" / slug

    for subdir in ["scenes", "4k", "tts", "narrated", "trimmed", "norm", "thumbnails", "subclips", "review"]:
        (output_dir / subdir).mkdir(parents=True, exist_ok=True)

    videos = await repo.list_videos(pid)
    video = videos[0] if videos else None
    video_id = video.id if video else None
    scene_count = 0
    if video_id:
        scenes = await repo.list_scenes(video_id)
        scene_count = len(scenes) if scenes else 0

    # Orientation lives on the video table, not project
    video_orientation = (getattr(video, "orientation", None) if video else None) or "VERTICAL"

    now = datetime.now(timezone.utc).isoformat()
    meta = {
        "project_id": pid,
        "project_name": project_name,
        "slug": slug,
        "video_id": video_id,
        "orientation": video_orientation,
        "material": getattr(project, "material", None) or (project.get("material") if isinstance(project, dict) else None) or "",
        "scene_count": scene_count,
        "created_at": now,
    }
    meta_path = output_dir / "meta.json"
    if meta_path.exists():
        existing = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["created_at"] = existing.get("created_at", now)
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")

    return {"slug": slug, "path": f"output/{slug}", "meta": meta}


_ASPECT_RATIO_MAP = {
    "LANDSCAPE": "IMAGE_ASPECT_RATIO_LANDSCAPE",
    "PORTRAIT": "IMAGE_ASPECT_RATIO_PORTRAIT",
}


class ThumbnailRequest(BaseModel):
    prompt: str | None = None
    character_names: list[str] = []
    aspect_ratio: str = "LANDSCAPE"
    output_filename: str = "thumbnail.png"


class ThumbnailResponse(BaseModel):
    success: bool
    media_id: str | None = None
    image_url: str | None = None
    output_path: str | None = None
    prompt: str | None = None
    error: str | None = None


class GenerateEntitiesResponse(BaseModel):
    success: bool
    count: int
    entities: list[Character]

class AutoExtractAssetsRequest(BaseModel):
    min_characters: int | None = None
    max_characters: int | None = None
    min_locations: int | None = None
    max_locations: int | None = None
    min_visual_assets: int | None = None
    max_visual_assets: int | None = None

class GenerateVideosResponse(BaseModel):
    success: bool
    count: int
    videos: list[Video]

class AutoGenerateVideosRequest(BaseModel):
    num_videos: int = 1


@router.post("/{pid}/auto-generate-videos", response_model=GenerateVideosResponse)
async def auto_generate_videos(pid: str, body: AutoGenerateVideosRequest | None = None):
    """Auto-generate videos (episodes/parts) from project story using LLM."""
    if not body:
        body = AutoGenerateVideosRequest()
    repo = _get_repo()
    project = await repo.get_project(pid)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    story = project.story or project.description or project.name
    if not story:
        raise HTTPException(status_code=400, detail="Project has no story to generate videos from")

    import os
    from openai import AsyncOpenAI
    client = AsyncOpenAI(
        base_url=f"http://{os.environ.get('ROUTER_HOST', '127.0.0.1')}:{os.environ.get('ROUTER_PORT', '20128')}/v1",
        api_key=os.environ.get("ROUTER_API_KEY", "no-key"),
    )

    prompt = f"""
You are an expert video director. Analyze the following story and determine the optimal way to adapt it into video format.
You MUST split the story into EXACTLY {body.num_videos} chronological episodes/parts.
Ensure that the output strictly follows the provided story, covering all major plot points from beginning to end without adding unmentioned events.

Return a JSON array of objects, where each object represents a video/episode and has EXACTLY:
- "title": string (Episode title)
- "video_story": string (Comprehensive summary of the specific plot points covered in this video. Do not invent new events.)

Story:
{story}

Respond with valid JSON containing a single key "videos" mapping to the array.
"""
    try:
        from engine.api.models import get_default_chat_model
        chat_model = await get_default_chat_model()

        response = await client.chat.completions.create(
            model=chat_model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        content = response.choices[0].message.content
        import json
        data = json.loads(content)
        videos_data = data.get("videos", [])
        
        # Delete existing videos for a fresh start
        existing_videos = await repo.list_videos(project.id)
        for v in existing_videos:
            await repo.delete_video(v.id)
        
        created_videos = []
        start_order = 0
        
        for i, v in enumerate(videos_data):
            video = await repo.create_video(
                project_id=project.id,
                title=v.get("title", f"Part {start_order + i + 1}"),
                video_story=v.get("video_story", ""),
                display_order=start_order + i
            )
            created_videos.append(video)
            
        from engine.api.videos import _video_to_flat
        return {"success": True, "count": len(created_videos), "videos": [_video_to_flat(v) for v in created_videos]}
    except Exception as e:
        logger.error(f"Failed to generate videos: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/{pid}/auto-extract-assets", response_model=GenerateEntitiesResponse)
async def auto_extract_assets(pid: str, body: AutoExtractAssetsRequest | None = None):
    """Auto-extract characters and locations from project story using LLM."""
    if not body:
        body = AutoExtractAssetsRequest()
    repo = _get_repo()
    project = await repo.get_project(pid)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    story = project.story or project.description or project.name
    if not story:
        raise HTTPException(status_code=400, detail="Project has no story to generate assets from")

    import os
    from openai import AsyncOpenAI
    client = AsyncOpenAI(
        base_url=f"http://{os.environ.get('ROUTER_HOST', '127.0.0.1')}:{os.environ.get('ROUTER_PORT', '20128')}/v1",
        api_key=os.environ.get("ROUTER_API_KEY", "no-key"),
    )

    limits_prompt = []
    if body.min_characters is not None and body.max_characters is not None:
        limits_prompt.append(f"- Between {body.min_characters} and {body.max_characters} characters.")
    else:
        limits_prompt.append("- Extract as many characters as necessary based on the story.")
        
    if body.min_locations is not None and body.max_locations is not None:
        limits_prompt.append(f"- Between {body.min_locations} and {body.max_locations} locations.")
    else:
        limits_prompt.append("- Extract as many locations as necessary based on the story.")
        
    if body.min_visual_assets is not None and body.max_visual_assets is not None:
        limits_prompt.append(f"- Between {body.min_visual_assets} and {body.max_visual_assets} visual assets.")
    else:
        limits_prompt.append("- Extract as many visual assets as necessary based on the story.")

    limits_str = "\n".join(limits_prompt)

    prompt = f"""
You are an expert at pre-production for video generation.
Read the following story and extract the key entities (characters, locations, and major props) needed to generate the video scenes.

You MUST extract:
{limits_str}

Return a JSON array of objects, where each object has EXACTLY:
- "name": string (short identifier)
- "entity_type": string (must be exactly "character", "location", or "visual_asset")
- "description": string (detailed visual appearance)
- "voice_description": string or null (optional, for characters only: e.g. "Deep calm heroic voice")

Story:
{story}

Respond with valid JSON containing a single key "entities" mapping to the array.
"""
    try:
        from engine.api.models import get_default_chat_model
        chat_model = await get_default_chat_model()

        response = await client.chat.completions.create(
            model=chat_model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        content = response.choices[0].message.content
        import json
        data = json.loads(content)
        entities = data.get("entities", [])
        # Delete existing characters
        existing_chars = await repo.get_project_characters(project.id)
        for char in existing_chars:
            await repo.unlink_character_from_project(project.id, char.id)
            await repo.delete_character(char.id)
            
        created_chars = []
        for e in entities:
            etype = e.get("entity_type", "character")
            profile = _build_character_profile(
                e.get("name", "Unknown"),
                e.get("description", ""),
                story,
                entity_type=etype,
                material_id=project.material,
            )
            char = await repo.create_character(
                name=e.get("name", "Unknown"),
                slug=slugify(e.get("name", "Unknown")),
                entity_type=etype,
                description=profile["description"],
                image_prompt=profile["image_prompt"],
                voice_description=e.get("voice_description"),
            )
            await repo.link_character_to_project(project.id, char.id)
            created_chars.append(char)
            
        return {"success": True, "count": len(created_chars), "entities": created_chars}
    except Exception as e:
        logger.error(f"Failed to extract entities: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _build_thumbnail_prompt(project) -> str:
    """Auto-generate a cinematic YouTube thumbnail prompt from project metadata."""
    name = getattr(project, "name", None) or "Untitled"
    story = getattr(project, "story", None) or ""
    description = getattr(project, "description", None) or ""

    context = story or description or name
    # Truncate to keep prompt focused (Flow has input limits)
    if len(context) > 300:
        context = context[:300] + "..."

    return (
        f"YouTube thumbnail, cinematic dramatic scene, "
        f"{context}, "
        f"intense emotion, epic composition, vivid saturated colors, "
        f"dynamic lighting with rim light and volumetric rays, "
        f"shallow depth of field, bokeh background, "
        f"4K, 8K, masterpiece, highly detailed, sharp focus, HDR, "
        f"1280x720, 16:9 YouTube thumbnail format"
    )


@router.get("/{pid}/thumbnail")
async def get_local_thumbnail(pid: str):
    from fastapi.responses import FileResponse
    repo = _get_repo()
    project = await repo.get_project(pid)
    if not project:
        raise HTTPException(404, "Project not found")
        
    project_name = slugify(getattr(project, "name", "project"))
    out_dir = BASE_DIR / "output" / project_name / "thumbnails"
    output_path = out_dir / "thumbnail.png"
    
    if output_path.exists():
        return FileResponse(output_path)
    raise HTTPException(404, "Thumbnail not found locally")


@router.post("/{pid}/generate-thumbnail", response_model=ThumbnailResponse)
async def generate_thumbnail(pid: str, body: ThumbnailRequest | None = None):
    """Generate a thumbnail image for a project via Google Flow API (synchronous, no queue).

    If prompt is omitted, auto-generates a cinematic prompt from the project story/description.
    If character_names is omitted, auto-includes all entities that have a media_id.
    """
    import logging
    logger = logging.getLogger(__name__)
    from engine.materials import get_material
    from engine.sdk.services.result_handler import parse_result

    # Accept empty body (dashboard sends {})
    if body is None:
        body = ThumbnailRequest()

    logger.info("generate_thumbnail: started for project %s", pid)

    client = get_flow_client()
    if not client.connected:
        raise HTTPException(503, "Extension not connected")

    repo = _get_repo()
    project = await repo.get_project(pid)
    if not project:
        raise HTTPException(404, "Project not found")

    # Auto-generate prompt from project context when not provided
    user_prompt = body.prompt or _build_thumbnail_prompt(project)

    # Build full prompt: prepend material scene_prefix for style consistency
    material_id = getattr(project, "material", None) or "realistic"
    material = get_material(material_id)
    scene_prefix = material["scene_prefix"] if material and material.get("scene_prefix") else ""
    full_prompt = f"{scene_prefix} {user_prompt}".strip() if scene_prefix else user_prompt

    # Resolve character references — auto-collect all entities with media_id when none specified
    entities = await repo.get_project_characters(pid)
    character_media_ids = None

    if body.character_names:
        # Explicit list: validate that named entities have refs
        valid_ids = []
        missing = []
        for entity in entities:
            name = entity["name"] if isinstance(entity, dict) else entity.name
            mid = entity.get("media_id") if isinstance(entity, dict) else getattr(entity, "media_id", None)
            char_slug = (entity.get("slug") if isinstance(entity, dict) else getattr(entity, "slug", None)) or ""
            if not ((char_slug and char_slug in body.character_names) or (name and name in body.character_names)):
                continue
            if mid:
                valid_ids.append(mid)
            else:
                missing.append(name)
        if missing:
            raise HTTPException(400, f"Missing reference images for: {', '.join(missing)}. Generate ref images first.")
        character_media_ids = valid_ids if valid_ids else None
    else:
        # Auto-collect: use all entities that already have a media_id
        auto_ids = []
        for entity in entities:
            mid = entity.get("media_id") if isinstance(entity, dict) else getattr(entity, "media_id", None)
            if mid:
                auto_ids.append(mid)
        character_media_ids = auto_ids if auto_ids else None
        if auto_ids:
            logger.info("generate_thumbnail: auto-collected %d entity refs", len(auto_ids))

    aspect_ratio = _ASPECT_RATIO_MAP.get(body.aspect_ratio.upper(), "IMAGE_ASPECT_RATIO_LANDSCAPE")
    tier = getattr(project, "user_paygate_tier", "PAYGATE_TIER_TWO") or "PAYGATE_TIER_TWO"

    logger.info("generate_thumbnail: calling generate_images prompt=%s refs=%s", full_prompt[:60], character_media_ids)
    raw = await client.generate_images(
        prompt=full_prompt,
        project_id=pid,
        aspect_ratio=aspect_ratio,
        user_paygate_tier=tier,
        character_media_ids=character_media_ids,
    )
    logger.info("generate_thumbnail: generate_images returned, error=%s", raw.get("error") if isinstance(raw, dict) else "n/a")

    gen_result = parse_result(raw, "GENERATE_IMAGE")
    if not gen_result.success:
        raise HTTPException(502, gen_result.error or "Image generation failed")

    # Download and save to output/{project_name}/thumbnails/{filename}
    project_name = slugify(getattr(project, "name", "project"))
    out_dir = BASE_DIR / "output" / project_name / "thumbnails"
    out_dir.mkdir(parents=True, exist_ok=True)
    output_path = out_dir / body.output_filename

    if gen_result.url and gen_result.url.startswith("http"):
        try:
            connector = aiohttp.TCPConnector(ssl=False)
            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.get(gen_result.url) as resp:
                    if resp.status == 200:
                        output_path.write_bytes(await resp.read())
                    else:
                        raise HTTPException(502, f"Failed to download image: HTTP {resp.status}")
        except aiohttp.ClientError as e:
            raise HTTPException(502, f"Failed to download image: {e}") from e

    # Persist the generated thumbnail URL to the database
    await repo.update("project", pid, thumbnail_url=gen_result.url)

    return ThumbnailResponse(
        success=True,
        media_id=gen_result.media_id,
        image_url=gen_result.url,
        output_path=str(output_path),
        prompt=full_prompt,
    )
