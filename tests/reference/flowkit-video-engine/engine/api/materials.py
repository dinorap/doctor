"""FastAPI router for material (visual style) endpoints."""
import logging

import base64
import os
import json

from fastapi import APIRouter, HTTPException, UploadFile, File
from openai import AsyncOpenAI

from engine.config import BASE_DIR
from engine.api.models import get_default_chat_model
from engine.models.material import MaterialCreateRequest, MaterialUpdateRequest, MaterialResponse
from engine.materials import (
    get_material,
    list_materials as _list_materials,
    register_material,
    MATERIALS,
    _BUILTIN_IDS,
)
from engine.db.crud import (
    create_material as crud_create_material,
    update_material as crud_update_material,
    delete_material as crud_delete_material,
    list_materials as crud_list_materials,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/materials", tags=["materials"])

MAX_CUSTOM_MATERIALS = 50


def _to_response(material: dict, is_builtin: bool | None = None) -> MaterialResponse:
    if is_builtin is None:
        is_builtin = material["id"] in _BUILTIN_IDS
    return MaterialResponse(
        id=material["id"],
        name=material["name"],
        style_instruction=material["style_instruction"],
        negative_prompt=material.get("negative_prompt"),
        scene_prefix=material.get("scene_prefix"),
        lighting=material.get("lighting", "Studio lighting, highly detailed"),
        is_builtin=is_builtin,
    )


@router.get("", response_model=list[MaterialResponse])
async def list_all():
    """List all materials (built-in + custom)."""
    return [_to_response(m) for m in _list_materials()]


@router.get("/{material_id}", response_model=MaterialResponse)
async def get(material_id: str):
    """Get material by ID."""
    material = get_material(material_id)
    if not material:
        raise HTTPException(404, f"Material '{material_id}' not found")
    return _to_response(material)


@router.post("", response_model=MaterialResponse, status_code=201)
async def create(body: MaterialCreateRequest):
    """Create a custom material. ID must not clash with built-in materials."""
    if body.id in _BUILTIN_IDS:
        raise HTTPException(400, f"Cannot override built-in material '{body.id}'")
    if get_material(body.id):
        raise HTTPException(409, f"Material '{body.id}' already exists")

    custom_count = sum(1 for mid in MATERIALS if mid not in _BUILTIN_IDS)
    if custom_count >= MAX_CUSTOM_MATERIALS:
        raise HTTPException(429, f"Custom material limit reached ({MAX_CUSTOM_MATERIALS})")

    material = {
        "id": body.id,
        "name": body.name,
        "style_instruction": body.style_instruction,
        "negative_prompt": body.negative_prompt,
        "scene_prefix": body.scene_prefix,
        "lighting": body.lighting,
    }
    register_material(material)
    await crud_create_material(
        id=body.id,
        name=body.name,
        style_instruction=body.style_instruction,
        negative_prompt=body.negative_prompt,
        scene_prefix=body.scene_prefix,
        lighting=body.lighting,
    )
    logger.info("Custom material registered: %s", body.id)
    return _to_response(material, is_builtin=False)


@router.delete("/{material_id}")
async def delete(material_id: str):
    """Delete a custom material. Built-in materials cannot be deleted."""
    if material_id in _BUILTIN_IDS:
        raise HTTPException(400, f"Cannot delete built-in material '{material_id}'")
    if material_id not in MATERIALS:
        raise HTTPException(404, f"Material '{material_id}' not found")
    del MATERIALS[material_id]
    await crud_delete_material(material_id)
    logger.info("Custom material deleted: %s", material_id)
    return {"ok": True}


@router.patch("/{material_id}", response_model=MaterialResponse)
async def update(material_id: str, body: MaterialUpdateRequest):
    """Update a custom material. Built-in materials cannot be updated."""
    if material_id in _BUILTIN_IDS:
        raise HTTPException(400, f"Cannot update built-in material '{material_id}'")
    
    material = get_material(material_id)
    if not material:
        raise HTTPException(404, f"Material '{material_id}' not found")
        
    update_data = body.model_dump(exclude_unset=True)
    if not update_data:
        return _to_response(material, is_builtin=False)
        
    for k, v in update_data.items():
        material[k] = v
        
    # Update in memory
    MATERIALS[material_id] = material
    
    # Update in DB
    await crud_update_material(material_id, **update_data)
    logger.info("Custom material updated: %s", material_id)
    
    return _to_response(material, is_builtin=False)


@router.post("/extract-and-create", response_model=MaterialResponse, status_code=201)
async def extract_and_create(file: UploadFile = File(...)):
    """Upload an image, extract its style using Vision LLM, and register as a new material."""
    contents = await file.read()
    b64_data = base64.b64encode(contents).decode()
    
    # 1. Visioning model extract via mz-9router
    client = AsyncOpenAI(
        base_url=f"http://{os.environ.get('ROUTER_HOST', '127.0.0.1')}:{os.environ.get('ROUTER_PORT', '20128')}/v1",
        api_key=os.environ.get("ROUTER_API_KEY", "no-key"),
    )
    chat_model = await get_default_chat_model()
    
    prompt = """You are an expert prompt engineer and art director. Analyze the visual style, aesthetic, medium, texture, camera effects, and lighting of this image.
CRITICAL: Do NOT describe the subject matter (who or what is in the image). Focus ONLY on HOW it is rendered.

Output your response strictly as a JSON object with the following fields:
{
  "analysis": "[Provide a detailed step-by-step analysis of the art style, textures, camera effects, medium, and lighting]",
  "id": "[A unique lowercase identifier with underscores, e.g., 'vintage_polaroid', 'anime_cel_shade', 'cinematic_3d']",
  "name": "[A short Display Name, e.g., 'Vintage Polaroid']",
  "style_instruction": "[2-4 sentences describing the specific medium, textures, artists/studio references, and rendering quality. This is the main prompt instruction for an AI image generator to replicate this exact style.]",
  "negative_prompt": "[List of styles/flaws that this is NOT, to avoid style bleeding. Start each with 'NOT'. E.g., 'NOT 3D render, NOT anime, NOT flat colors, NOT realistic']",
  "scene_prefix": "[1-2 concise sentences summarizing the visual medium and lighting mood. E.g., 'A vintage polaroid photo with light leaks.']",
  "lighting": "[A short descriptor of the lighting setup, e.g., 'Soft diffused lighting, vintage bloom']"
}"""

    try:
        response = await client.chat.completions.create(
            model=chat_model,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:{file.content_type};base64,{b64_data}", "detail": "high"}}
                ]
            }],
            response_format={"type": "json_object"}
        )
        raw = response.choices[0].message.content
        # Clean markdown if present
        if raw.strip().startswith("```"):
            raw = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        data = json.loads(raw)
    except Exception as e:
        raise HTTPException(500, f"Failed to parse AI response: {str(e)}")

    # Validate extracted data
    mat_id = data.get("id", "").strip().lower()
    if not mat_id or mat_id in _BUILTIN_IDS:
        raise HTTPException(400, f"Invalid or conflicting ID generated by AI: '{mat_id}'")
        
    if get_material(mat_id):
        raise HTTPException(409, f"Material '{mat_id}' already exists")

    custom_count = sum(1 for mid in MATERIALS if mid not in _BUILTIN_IDS)
    if custom_count >= MAX_CUSTOM_MATERIALS:
        raise HTTPException(429, f"Custom material limit reached ({MAX_CUSTOM_MATERIALS})")

    # 2. Register material
    material = {
        "id": mat_id,
        "name": data.get("name", mat_id),
        "style_instruction": data.get("style_instruction", ""),
        "negative_prompt": data.get("negative_prompt", ""),
        "scene_prefix": data.get("scene_prefix", ""),
        "lighting": data.get("lighting", "Studio lighting, highly detailed"),
    }
    
    register_material(material)
    await crud_create_material(
        id=material["id"],
        name=material["name"],
        style_instruction=material["style_instruction"],
        negative_prompt=material["negative_prompt"],
        scene_prefix=material["scene_prefix"],
        lighting=material["lighting"],
    )
    
    # 3. Save preview image to dashboard public dir
    preview_path = BASE_DIR / "dashboard" / "public" / "materials" / f"{mat_id}_preview.png"
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    with open(preview_path, "wb") as f:
        f.write(contents)
        
    logger.info("Custom material extracted and registered: %s", mat_id)
    return _to_response(material, is_builtin=False)
