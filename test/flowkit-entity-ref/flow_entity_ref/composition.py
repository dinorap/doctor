"""
Composition Guidelines - 4-panel design sheet layouts for each entity type.

These guidelines define the structure of reference images generated for:
- character
- location
- creature
- visual_asset
- generic_troop
- faction
"""

# 4-panel design sheet layouts per entity type
COMPOSITION_GUIDELINES: dict[str, str] = {
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

# Sheet type names for each entity
SHEET_TYPE_NAMES: dict[str, str] = {
    "character": "character design sheet",
    "location": "environment design sheet",
    "creature": "creature design sheet",
    "visual_asset": "prop and asset design sheet",
    "generic_troop": "troop and uniform design sheet",
    "faction": "faction and uniform design sheet",
}

# Entity types that need LANDSCAPE aspect ratio for reference images
_LANDSCAPE_ENTITY_TYPES: set[str] = {"location"}

# All supported entity types
ENTITY_TYPES: list[str] = [
    "character",
    "location",
    "creature",
    "visual_asset",
    "generic_troop",
    "faction",
]


def get_aspect_ratio(entity_type: str) -> str:
    """
    Get the appropriate aspect ratio for an entity type's reference image.
    
    Returns:
        "IMAGE_ASPECT_RATIO_LANDSCAPE" for location
        "IMAGE_ASPECT_RATIO_PORTRAIT" for all other types
    """
    if entity_type in _LANDSCAPE_ENTITY_TYPES:
        return "IMAGE_ASPECT_RATIO_LANDSCAPE"
    return "IMAGE_ASPECT_RATIO_PORTRAIT"


def get_composition(entity_type: str) -> str:
    """Get composition guideline for an entity type."""
    return COMPOSITION_GUIDELINES.get(entity_type, COMPOSITION_GUIDELINES["character"])


def get_sheet_type_name(entity_type: str) -> str:
    """Get the sheet type name for an entity type."""
    return SHEET_TYPE_NAMES.get(entity_type, "concept design sheet")
