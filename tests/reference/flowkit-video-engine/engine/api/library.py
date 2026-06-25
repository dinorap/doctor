"""
Library API - Browse entities (characters, locations, assets) from project
"""
from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from engine.models.enums import EntityType
from engine.sdk.persistence.sqlite_repository import SQLiteRepository

router = APIRouter(prefix="/library", tags=["library"])


@router.get("/entities")
async def list_entities(
    project_id: Optional[str] = Query(None, description="Filter by project ID"),
    entity_type: Optional[EntityType] = Query(None, description="Filter by entity type"),
    search: Optional[str] = Query(None, description="Search by name"),
    has_image: bool = Query(False, description="Only entities with generated images"),
) -> dict:
    """
    List all entities (characters, locations, creatures, assets) 
    with their image prompts for selection in video generation.
    
    Returns entities grouped by type for easy browsing.
    """
    repo = SQLiteRepository()
    
    # Get all entities, optionally filtered
    rows = await repo.list("character", order_by="created_at DESC")
    
    entities = []
    for row in rows:
        char = repo._row_to_character(row)
        
        # Filter by project if specified
        if project_id:
            project_chars = await repo.list_project_characters(project_id)
            char_ids = {c.id for c in project_chars}
            if char.id not in char_ids:
                continue
        
        # Filter by entity type
        if entity_type and char.entity_type != entity_type:
            continue
        
        # Filter by search
        if search:
            search_lower = search.lower()
            if search_lower not in (char.name or "").lower() and \
               search_lower not in (char.description or "").lower():
                continue
        
        # Filter by has_image
        if has_image and not char.media_id:
            continue
        
        entities.append({
            "id": char.id,
            "name": char.name,
            "slug": char.slug,
            "entity_type": char.entity_type,
            "description": char.description,
            "image_prompt": char.image_prompt,
            "reference_image_url": char.reference_image_url,
            "media_id": char.media_id,
        })
    
    # Group by entity type
    grouped: dict[str, list] = {
        "character": [],
        "location": [],
        "creature": [],
        "visual_asset": [],
        "generic_troop": [],
        "faction": [],
    }
    
    for entity in entities:
        etype = entity["entity_type"]
        if etype in grouped:
            grouped[etype].append(entity)
    
    return {
        "entities": entities,
        "grouped": grouped,
        "counts": {k: len(v) for k, v in grouped.items()},
        "total": len(entities),
    }


@router.get("/entities/{entity_id}")
async def get_entity(entity_id: str) -> dict:
    """Get a single entity by ID."""
    repo = SQLiteRepository()
    char = await repo.get_character(entity_id)
    if not char:
        raise HTTPException(404, "Entity not found")
    
    return {
        "id": char.id,
        "name": char.name,
        "slug": char.slug,
        "entity_type": char.entity_type,
        "description": char.description,
        "image_prompt": char.image_prompt,
        "voice_description": char.voice_description,
        "reference_image_url": char.reference_image_url,
        "media_id": char.media_id,
    }


@router.get("/entity-types")
async def list_entity_types() -> list[dict]:
    """
    List all available entity types with their descriptions.
    Used for the Library UI tabs.
    """
    return [
        {
            "id": "character",
            "name": "Characters",
            "icon": "👤",
            "description": "People, heroes, villains, NPCs",
        },
        {
            "id": "location",
            "name": "Locations",
            "icon": "🏠",
            "description": "Scenes, environments, backgrounds",
        },
        {
            "id": "creature",
            "name": "Creatures",
            "icon": "🐉",
            "description": "Monsters, animals, fantasy beings",
        },
        {
            "id": "visual_asset",
            "name": "Assets",
            "icon": "🎭",
            "description": "Props, costumes, vehicles",
        },
        {
            "id": "generic_troop",
            "name": "Troops",
            "icon": "⚔️",
            "description": "Soldiers, armies, groups",
        },
        {
            "id": "faction",
            "name": "Factions",
            "icon": "🏴",
            "description": "Teams, guilds, organizations",
        },
    ]
