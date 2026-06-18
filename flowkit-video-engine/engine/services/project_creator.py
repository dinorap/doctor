"""
Project Creator Service
Encapsulates all logic for creating new projects on Google Flow and locally.
"""
import logging
from typing import Optional

from fastapi import HTTPException

from engine.models.project import Project, ProjectCreate
from engine.sdk.persistence.sqlite_repository import SQLiteRepository
from engine.services.flow_client import get_flow_client
from engine.utils.slugify import slugify

logger = logging.getLogger(__name__)


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
    """Map legacy style strings to material IDs."""
    return _STYLE_COMPAT_MAP.get(value, value)


def _build_character_profile(
    char_name: str,
    char_desc: Optional[str],
    story: Optional[str],
    entity_type: str = "character",
    material_id: str = "3d_pixar"
) -> dict:
    """Build a rich profile (description + image_prompt) for any reference entity."""
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


class ProjectCreator:
    """Service for creating projects on Google Flow and locally."""
    
    def __init__(self):
        self.repo = SQLiteRepository()
    
    async def create_project(self, body: ProjectCreate) -> Project:
        """
        Create a new project on Google Flow and locally.
        
        Steps:
        1. Validate inputs (material, characters)
        2. Create project on Google Flow to get projectId
        3. Create local project record
        4. Create and link reference entities (characters, locations, assets)
        5. Emit project_created event
        
        Returns:
            Project: The created project with Flow-assigned ID
        
        Raises:
            HTTPException: If validation fails or Flow API errors
        """
        from engine.materials import get_material
        
        # Step 1: Validate material
        material_id = _resolve_material_id(body.material)
        if material_id:
            material = get_material(material_id)
            if not material:
                raise HTTPException(
                    400, 
                    f"Unknown material: '{material_id}'. "
                    "Use GET /api/materials to list available materials."
                )
        
        # Step 2: Validate characters before any API calls
        characters_input_raw = body.model_dump(exclude_none=True).get("characters")
        if characters_input_raw:
            slugs = [slugify(c["name"]) for c in characters_input_raw]
            if len(slugs) != len(set(slugs)):
                dupes = [s for s in slugs if slugs.count(s) > 1]
                raise HTTPException(400, f"Duplicate character slugs: {list(set(dupes))}")
        
        # Step 3: Get Flow client and detect user tier
        client = get_flow_client()
        if not client.connected:
            raise HTTPException(
                503, 
                "Extension not connected — cannot create project on Google Flow"
            )
        
        detected_tier = await _detect_user_tier(client)
        
        # Step 4: Create project on Google Flow
        flow_result = await client.create_project(body.name, body.tool_name)
        if flow_result.get("error"):
            raise HTTPException(502, f"Flow API error: {flow_result['error']}")
        
        try:
            data = flow_result.get("data", {})
            result = data["result"]["data"]["json"]["result"]
            flow_project_id = result["projectId"]
        except (KeyError, TypeError) as e:
            logger.error("Unexpected Flow response: %s", flow_result)
            raise HTTPException(502, f"Failed to parse Flow response: {e}")
        
        logger.info("Flow project created: %s", flow_project_id)
        
        # Step 5: Create local project record
        create_data = body.model_dump(exclude_none=True)
        create_data.pop("tool_name", None)
        create_data.pop("style", None)
        characters_input = create_data.pop("characters", None)
        
        project = await self.repo.create_project(
            id=flow_project_id,
            name=create_data["name"],
            description=create_data.get("description"),
            story=create_data.get("story"),
            language=create_data.get("language", "en"),
            user_paygate_tier=detected_tier,
            material=material_id,
            allow_music=create_data.get("allow_music", False),
            allow_voice=create_data.get("allow_voice", False),
        )
        
        # Step 6: Create and link reference entities
        if characters_input:
            for char_input in characters_input:
                etype = char_input.get("entity_type", "character")
                profile = _build_character_profile(
                    char_input["name"],
                    char_input.get("description"),
                    body.story,
                    entity_type=etype,
                    material_id=material_id,
                )
                description = profile["description"]
                image_prompt = profile["image_prompt"]
                char = await self.repo.create_character(
                    name=char_input["name"],
                    slug=slugify(char_input["name"]),
                    entity_type=etype,
                    description=description,
                    image_prompt=image_prompt,
                    voice_description=char_input.get("voice_description"),
                )
                await self.repo.link_character_to_project(flow_project_id, char.id)
                logger.info(
                    "%s '%s' created and linked: %s", 
                    etype, char_input["name"], char.id
                )
        
        # Step 7: Emit event
        from engine.services.event_bus import event_bus
        await event_bus.emit('project_created', {'project_id': flow_project_id})
        
        return project


# Singleton instance
_project_creator = None


def get_project_creator() -> ProjectCreator:
    """Get or create the ProjectCreator singleton."""
    global _project_creator
    if _project_creator is None:
        _project_creator = ProjectCreator()
    return _project_creator
