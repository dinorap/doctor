"""
Entity Profile Builder - Builds description and image_prompt for reference entities.

This module creates the full prompt used to generate reference images for:
- Characters (people, creatures, etc.)
- Locations (environments, scenes)
- Visual Assets (props, vehicles, objects)
- Factions and Troops

The prompt is built from:
1. Material style (from materials.py)
2. Composition guidelines (from composition.py)
3. Entity description
4. Story context (optional)
"""

from typing import Optional

from .materials import get_material
from .composition import get_composition, get_sheet_type_name


def build_entity_profile(
    name: str,
    description: Optional[str] = None,
    story: Optional[str] = None,
    entity_type: str = "character",
    material_id: str = "3d_pixar",
) -> dict:
    """
    Build a rich profile (description + image_prompt) for any reference entity.

    The image_prompt generates a reference image used as mediaId for all
    scene generations. Visual appearance is defined HERE, not in scene prompts.
    Scene prompts should only describe actions/environment/composition.

    Args:
        name: Entity name (e.g., "Hero Warrior", "Dark Forest", "Magic Sword")
        description: Visual description of the entity
        story: Optional story context for the character
        entity_type: One of "character", "location", "creature", "visual_asset", 
                    "generic_troop", "faction"
        material_id: Material style (e.g., "3d_pixar", "realistic", "anime")

    Returns:
        dict with keys:
            - description: Full description with story context
            - image_prompt: Complete prompt for image generation
    """
    # Step 1: Get material style
    material = get_material(material_id)
    if not material:
        raise ValueError(f"Unknown material: {material_id}")
    
    style_instruction = material["style_instruction"]
    if material.get("negative_prompt"):
        style_instruction += " " + material["negative_prompt"]
    
    lighting = material.get("lighting", "Studio lighting, highly detailed")

    # Step 2: Get composition template
    composition = get_composition(entity_type)

    # Step 3: Get sheet type name
    sheet_name = get_sheet_type_name(entity_type)

    # Step 4: Build base description
    base_desc = description or name
    if story:
        full_description = f"{name}: {base_desc}. Story context: {story}"
    else:
        full_description = base_desc

    # Step 5: Build image prompt
    image_prefix = f"Comprehensive {sheet_name} for {base_desc}. "
    single_image_note = f"Create a detailed multi-panel {sheet_name}. "

    image_prompt = (
        f"{image_prefix}"
        f"{style_instruction} "
        f"{composition} "
        f"{single_image_note}"
        f"{lighting}"
    )

    return {
        "description": full_description,
        "image_prompt": image_prompt,
    }


def build_scene_prompt(
    scene_description: str,
    material_id: str = "3d_pixar",
    include_negative: bool = True,
) -> str:
    """
    Build a scene prompt with material prefix.
    
    Args:
        scene_description: The scene/action description
        material_id: Material style for the scene
        include_negative: Include negative prompt
        
    Returns:
        Complete scene prompt with style prefix
    """
    material = get_material(material_id)
    if not material:
        raise ValueError(f"Unknown material: {material_id}")
    
    scene_prefix = material.get("scene_prefix", "")
    negative_prompt = material.get("negative_prompt", "") if include_negative else ""
    
    prompt = scene_description
    if scene_prefix:
        prompt = f"{scene_prefix}, {prompt}"
    if negative_prompt:
        prompt = f"{prompt}. Negative: {negative_prompt}"
    
    return prompt
