"""
Example: Generate reference images for all entity types.

This demonstrates how to use the flow_entity_ref module to generate
reference images for characters, locations, creatures, visual assets, etc.
"""
import asyncio
import sys
from pathlib import Path

# Add parent directory to path for local development
sys.path.insert(0, str(Path(__file__).parent.parent))

from flow_entity_ref import (
    EntityRefGenerator,
    FlowClientWrapper,
    build_entity_profile,
    build_scene_prompt,
    list_materials,
    ENTITY_TYPES,
)


async def main():
    # Step 1: Initialize client
    client = FlowClientWrapper()

    # In production, you need:
    # client.set_websocket(ws)          # From Chrome Extension
    # client.set_flow_key("your_key")   # Flow API key

    generator = EntityRefGenerator(client)

    # Example entity data
    project_id = "your_project_id"
    project_slug = "my_project"

    # ============================================================
    # Example 1: Generate CHARACTER reference image
    # ============================================================
    print("\n" + "=" * 60)
    print("Generating CHARACTER reference image...")
    print("=" * 60)

    result = await generator.generate_entity_ref(
        name="Hero Warrior",
        description="A brave knight in gleaming silver armor with a crimson cape",
        story="A legendary hero who saved the kingdom from darkness",
        entity_type="character",
        material_id="3d_pixar",
        project_id=project_id,
        download_to=f"./output/{project_slug}/assets/hero_warrior.jpg",
    )

    if result.success:
        print(f"SUCCESS!")
        print(f"  Media ID: {result.media_id}")
        print(f"  URL: {result.url}")
        if result.local_path:
            print(f"  Saved to: {result.local_path}")
    else:
        print(f"FAILED: {result.error}")

    # ============================================================
    # Example 2: Generate LOCATION reference image
    # ============================================================
    print("\n" + "=" * 60)
    print("Generating LOCATION reference image...")
    print("=" * 60)

    result = await generator.generate_entity_ref(
        name="Enchanted Forest",
        description="A mystical forest with ancient trees, glowing mushrooms, and floating fireflies",
        entity_type="location",
        material_id="3d_pixar",
        project_id=project_id,
        download_to=f"./output/{project_slug}/assets/enchanted_forest.jpg",
    )

    if result.success:
        print(f"SUCCESS!")
        print(f"  Media ID: {result.media_id}")
        print(f"  URL: {result.url}")
    else:
        print(f"FAILED: {result.error}")

    # ============================================================
    # Example 3: Generate CREATURE reference image
    # ============================================================
    print("\n" + "=" * 60)
    print("Generating CREATURE reference image...")
    print("=" * 60)

    result = await generator.generate_entity_ref(
        name="Dragon Lord",
        description="A massive ancient dragon with iridescent scales and intelligent eyes",
        entity_type="creature",
        material_id="3d_pixar",
        project_id=project_id,
    )

    if result.success:
        print(f"SUCCESS!")
        print(f"  Media ID: {result.media_id}")
    else:
        print(f"FAILED: {result.error}")

    # ============================================================
    # Example 4: Generate VISUAL_ASSET reference image
    # ============================================================
    print("\n" + "=" * 60)
    print("Generating VISUAL_ASSET reference image...")
    print("=" * 60)

    result = await generator.generate_entity_ref(
        name="Magic Sword",
        description="A legendary blade with a sapphire-encrusted hilt and runes that glow blue",
        entity_type="visual_asset",
        material_id="3d_pixar",
        project_id=project_id,
    )

    if result.success:
        print(f"SUCCESS!")
        print(f"  Media ID: {result.media_id}")
    else:
        print(f"FAILED: {result.error}")

    # ============================================================
    # Example 5: Generate with ANIME material
    # ============================================================
    print("\n" + "=" * 60)
    print("Generating CHARACTER with ANIME material...")
    print("=" * 60)

    result = await generator.generate_entity_ref(
        name="Ninja Warrior",
        description="A skilled ninja in dark attire with glowing red eyes",
        entity_type="character",
        material_id="anime",
        project_id=project_id,
    )

    if result.success:
        print(f"SUCCESS!")
        print(f"  Media ID: {result.media_id}")
    else:
        print(f"FAILED: {result.error}")

    # ============================================================
    # Example 6: Build profile without generating
    # ============================================================
    print("\n" + "=" * 60)
    print("Building entity profile (no generation)...")
    print("=" * 60)

    profile = build_entity_profile(
        name="Mage Hero",
        description="A powerful wizard in flowing robes with a staff of oak",
        story="The last mage of the Silver Order",
        entity_type="character",
        material_id="ghibli",
    )

    print(f"Description: {profile['description']}")
    print(f"\nPrompt (first 300 chars):\n{profile['image_prompt'][:300]}...")

    # ============================================================
    # Example 7: Build scene prompt
    # ============================================================
    print("\n" + "=" * 60)
    print("Building scene prompt...")
    print("=" * 60)

    scene_prompt = build_scene_prompt(
        scene_description="A hero stands atop a mountain, gazing at the sunset",
        material_id="3d_pixar",
    )
    print(f"Scene prompt:\n{scene_prompt[:300]}...")

    # ============================================================
    # List all available materials
    # ============================================================
    print("\n" + "=" * 60)
    print("Available materials:")
    print("=" * 60)

    for material in list_materials():
        print(f"  - {material['id']}: {material['name']}")


if __name__ == "__main__":
    asyncio.run(main())
