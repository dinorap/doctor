"""
FlowKit Entity Reference Module

Standalone module for generating reference images for entities:
- character
- location
- creature
- visual_asset
- generic_troop
- faction

Usage:
    from flow_entity_ref import EntityRefGenerator, FlowClientWrapper
    
    client = FlowClientWrapper()
    client.set_websocket(ws)
    client.set_flow_key("your_flow_key")
    
    generator = EntityRefGenerator(client)
    
    # Generate character reference
    result = await generator.generate_entity_ref(
        name="Hero Warrior",
        description="A brave knight in silver armor",
        entity_type="character",
        material_id="3d_pixar",
        project_id="your_project_id",
    )
"""

from .flow_client_wrapper import FlowClientWrapper
from .entity_ref_generator import EntityRefGenerator, GenerationResult
from .profile_builder import build_entity_profile, build_scene_prompt
from .materials import get_material, list_materials, register_material, MATERIALS
from .composition import (
    COMPOSITION_GUIDELINES,
    ENTITY_TYPES,
    get_aspect_ratio,
    get_composition,
    get_sheet_type_name,
)
from .media_downloader import download_media_to_local, get_local_path_for_entity
from .parsing import extract_media_id, extract_output_url

__all__ = [
    # Main classes
    "FlowClientWrapper",
    "EntityRefGenerator",
    "GenerationResult",
    # Profile building
    "build_entity_profile",
    "build_scene_prompt",
    # Materials
    "get_material",
    "list_materials",
    "register_material",
    "MATERIALS",
    # Composition
    "COMPOSITION_GUIDELINES",
    "ENTITY_TYPES",
    "get_aspect_ratio",
    "get_composition",
    "get_sheet_type_name",
    # Utilities
    "download_media_to_local",
    "get_local_path_for_entity",
    "extract_media_id",
    "extract_output_url",
]

__version__ = "1.0.0"
