from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from engine.models.video import Video, VideoCreate, VideoUpdate
from engine.sdk.persistence.sqlite_repository import SQLiteRepository
from dataclasses import asdict

router = APIRouter(prefix="/videos", tags=["videos"])

_repo = SQLiteRepository()


def _video_to_flat(sdk_video) -> dict:
    """Convert SDK Video domain model to flat dict matching API response shape."""
    return {
        "id": sdk_video.id,
        "project_id": sdk_video.project_id,
        "title": sdk_video.title,
        "video_story": sdk_video.video_story,
        "display_order": sdk_video.display_order,
        "status": sdk_video.status,
        "orientation": sdk_video.orientation,
        "vertical_url": sdk_video.vertical_url,
        "horizontal_url": sdk_video.horizontal_url,
        "thumbnail_url": sdk_video.thumbnail_url,
        "duration": sdk_video.duration,
        "resolution": sdk_video.resolution,
        "youtube_id": sdk_video.youtube_id,
        "privacy": sdk_video.privacy,
        "tags": sdk_video.tags,
        "created_at": sdk_video.created_at,
        "updated_at": sdk_video.updated_at,
    }


@router.post("", response_model=Video)
async def create(body: VideoCreate):
    sdk_video = await _repo.create_video(**body.model_dump(exclude_none=True))
    from engine.services.event_bus import event_bus
    await event_bus.emit('project_updated', {'project_id': sdk_video.project_id})
    return _video_to_flat(sdk_video)


@router.get("", response_model=list[Video])
async def list_by_project(project_id: str):
    videos = await _repo.list_videos(project_id)
    return [_video_to_flat(v) for v in videos]


@router.get("/{vid}", response_model=Video)
async def get(vid: str):
    sdk_video = await _repo.get_video(vid)
    if not sdk_video:
        raise HTTPException(404, "Video not found")
    return _video_to_flat(sdk_video)


@router.patch("/{vid}", response_model=Video)
async def update(vid: str, body: VideoUpdate):
    row = await _repo.update("video", vid, **body.model_dump(exclude_unset=True))
    if not row:
        raise HTTPException(404, "Video not found")
    sdk_video = _repo._row_to_video(row)
    from engine.services.event_bus import event_bus
    await event_bus.emit('project_updated', {'project_id': sdk_video.project_id})
    return _video_to_flat(sdk_video)


class GenerateScenesResponse(BaseModel):
    success: bool
    count: int
    scenes: list[dict]

class AutoGenerateScenesRequest(BaseModel):
    num_scenes: int = 5


@router.post("/{vid}/auto-generate-scenes", response_model=GenerateScenesResponse)
async def auto_generate_scenes(vid: str, body: AutoGenerateScenesRequest | None = None):
    """Auto-generate scenes for a video from the project story and entities using LLM."""
    if not body:
        body = AutoGenerateScenesRequest()
    video = await _repo.get_video(vid)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")
        
    from engine.db.crud import get_project
    project = await get_project(video.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    story = project.get("story") or project.get("description") or project.get("name")
    if not story:
        raise HTTPException(status_code=400, detail="Project has no story to generate scenes from")
        
    characters = await _repo.get_project_characters(video.project_id)
    char_names = [c.name for c in characters]
    char_list_str = ", ".join(char_names) if char_names else "None"

    import os
    from openai import AsyncOpenAI
    import json
    import logging
    from engine.api.models import get_default_chat_model

    logger = logging.getLogger(__name__)
    client = AsyncOpenAI(
        base_url=f"http://{os.environ.get('ROUTER_HOST', '127.0.0.1')}:{os.environ.get('ROUTER_PORT', '20128')}/v1",
        api_key=os.environ.get("ROUTER_API_KEY", "no-key"),
    )
    chat_model = await get_default_chat_model()

    # --- PHASE 1: Missing Entity Extraction ---
    extraction_prompt = f"""
You are an expert story analyst.
We have an overall project story:
{story}

And a specific episode (Video) focus:
Title: "{video.title}"
Video Story: {video.video_story}

Currently, we have these existing entities (characters/locations/assets) defined in the project:
{char_list_str}

Your task is to analyze the episode "Story" and determine if there are any NEW characters, locations, or key visual assets mentioned that are NOT in the existing entities list.
If a new entity is needed, define its details.
CRITICAL RULE: Do not include entities that are already in the existing list.

Return a JSON object with a single key "missing_entities" containing an array of objects.
Each object must have:
- "name": string (A short, unique name for the entity)
- "entity_type": string (Must be one of: "character", "location", "visual_asset")
- "description": string (A brief description of what this entity is based on the story)
- "image_prompt": string (A visual description of this entity, e.g., for character: "A tall man with a beard, wearing a red coat". For location: "A dark, spooky forest with tall pine trees".)

If no new entities are needed, return an empty array for "missing_entities".
"""
    try:
        ext_response = await client.chat.completions.create(
            model=chat_model,
            messages=[{"role": "user", "content": extraction_prompt}],
            response_format={"type": "json_object"}
        )
        ext_content = ext_response.choices[0].message.content
        ext_data = json.loads(ext_content)
        missing_entities = ext_data.get("missing_entities", [])
        
        if missing_entities:
            from engine.db.crud import create_character, link_character_to_project
            for ent in missing_entities:
                name = ent.get("name")
                if not name: continue
                # Basic deduplication check just in case LLM hallucinated an existing one
                if name in char_names: continue
                
                c = await create_character(
                    name=name,
                    entity_type=ent.get("entity_type", "character"),
                    description=ent.get("description", ""),
                    image_prompt=ent.get("image_prompt", "")
                )
                await link_character_to_project(video.project_id, c["id"])
            
            # Refetch characters after adding new ones
            characters = await _repo.get_project_characters(video.project_id)
            char_names = [c.name for c in characters]
            char_list_str = ", ".join(char_names) if char_names else "None"
            
    except Exception as e:
        logger.warning(f"Failed to extract missing entities (continuing without them): {e}")

    # --- PHASE 2: Scene Generation ---

    prompt = f"""
You are an expert video director and screenwriter.
We are adapting a segment of our project story into a video sequence.

Overall project story:
{story}

Specific Video Focus:
Title: "{video.title}"
Video Story: {video.video_story}

Available Entities (Characters/Locations/Assets):
{char_list_str}

Your task is to break down this specific video's story into a chronological sequence of EXACTLY {body.num_scenes} visual scenes.
CRITICAL RULES:
1. Ensure the sequence of events strictly follows the "Video Focus" and remains faithful to the "Overall project story".
2. Do not invent new major plot points. Focus only on translating the story into visual and narrative scenes.
3. You MUST use the exact entity names from the "Available Entities" list whenever they appear in the scene.

Return a JSON array of objects, where each object has EXACTLY:
- "prompt": string (Description of action + environment + mood. Reference entities by name. NEVER describe character appearance. NEVER include camera instructions.)
- "narrator_text": string (The dialogue or narration for this scene. Keep it concise, 1-2 sentences.)
- "character_names": array of strings (List of exact entity names from the available entities list that are present in this scene.)

Respond with valid JSON containing a single key "scenes" mapping to the array.
"""
    try:
        response = await client.chat.completions.create(
            model=chat_model,
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        content = response.choices[0].message.content
        data = json.loads(content)
        scenes_data = data.get("scenes", [])
        
        # Get material scene_prefix if applicable
        from engine.materials import get_material
        material_id = project.get("material")
        prefix = ""
        if material_id:
            mat = get_material(material_id)
            if mat and mat.get("scene_prefix"):
                prefix = mat["scene_prefix"]

        existing_scenes = await _repo.list_scenes(vid)
        for s in existing_scenes:
            await _repo.delete_scene(s.id)
            
        start_order = 0
        
        created_scenes = []
        for i, s_data in enumerate(scenes_data):
            final_prompt = s_data.get("prompt", "")
            if prefix and final_prompt and not final_prompt.startswith(prefix):
                final_prompt = f"{prefix} {final_prompt}"
                
            chars = s_data.get("character_names", [])
            # Filter to ensure they match available entities
            valid_chars = [c for c in chars if c in char_names]
            
            from engine.api.scenes import _scene_to_flat
            scene = await _repo.create_scene(
                video_id=vid,
                display_order=start_order + i,
                prompt=final_prompt,
                narrator_text=s_data.get("narrator_text", ""),
                character_names=valid_chars,
                source="user"
            )
            created_scenes.append(scene)
            
        from engine.api.scenes import _scene_to_flat
        return {"success": True, "count": len(created_scenes), "scenes": [_scene_to_flat(s) for s in created_scenes]}
    except Exception as e:
        logger.error(f"Failed to generate scenes: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/{vid}")
async def delete(vid: str):
    video = await _repo.get_video(vid)
    if not video:
        raise HTTPException(404, "Video not found")
    if not await _repo.delete("video", vid):
        raise HTTPException(404, "Video not found")
    from engine.services.event_bus import event_bus
    await event_bus.emit('project_updated', {'project_id': video.project_id})
    return {"ok": True}

