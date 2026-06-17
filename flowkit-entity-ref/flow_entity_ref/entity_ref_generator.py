"""
Entity Reference Generator - Generate reference images for entities.

This module handles the complete flow:
1. Build prompt from entity profile
2. Call Flow API to generate image
3. Parse response to get media_id and URL
4. Upload URL to get permanent media_id (if needed)
5. Download to local storage
"""
import asyncio
import base64
import logging
import ssl
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import aiohttp

from .flow_client_wrapper import FlowClientWrapper
from .profile_builder import build_entity_profile
from .composition import get_aspect_ratio
from .parsing import _is_error, extract_media_id, extract_output_url, _extract_uuid_from_url

logger = logging.getLogger(__name__)


@dataclass
class GenerationResult:
    """Result of a generation operation."""
    success: bool
    media_id: Optional[str] = None
    url: Optional[str] = None
    local_path: Optional[str] = None
    error: Optional[str] = None


class EntityRefGenerator:
    """
    Generator for entity reference images.
    
    Supports all entity types:
    - character
    - location
    - creature
    - visual_asset
    - generic_troop
    - faction
    
    Usage:
        client = FlowClientWrapper()
        client.set_websocket(ws)
        client.set_flow_key("your_key")
        
        generator = EntityRefGenerator(client)
        
        # Generate reference image for a character
        result = await generator.generate_entity_ref(
            name="Hero Warrior",
            description="A brave knight in silver armor",
            entity_type="character",
            material_id="3d_pixar",
            project_id="your_project_id",
        )
        
        print(f"Media ID: {result.media_id}")
        print(f"URL: {result.url}")
    """

    def __init__(self, flow_client: FlowClientWrapper):
        self.client = flow_client

    async def generate_entity_ref(
        self,
        name: str,
        description: Optional[str] = None,
        story: Optional[str] = None,
        entity_type: str = "character",
        material_id: str = "3d_pixar",
        project_id: str = "",
        user_paygate_tier: str = "PAYGATE_TIER_TWO",
        download_to: Optional[str] = None,
    ) -> GenerationResult:
        """
        Generate a reference image for an entity.
        
        Args:
            name: Entity name
            description: Visual description
            story: Optional story context
            entity_type: Entity type (character, location, creature, etc.)
            material_id: Material style (3d_pixar, realistic, anime, etc.)
            project_id: Flow project ID
            user_paygate_tier: User tier (PAYGATE_TIER_ONE or PAYGATE_TIER_TWO)
            download_to: Optional path to download the image locally
            
        Returns:
            GenerationResult with media_id, url, and optional local_path
        """
        if not self.client.connected:
            return GenerationResult(success=False, error="Flow client not connected")

        # Step 1: Build the prompt
        try:
            profile = build_entity_profile(
                name=name,
                description=description,
                story=story,
                entity_type=entity_type,
                material_id=material_id,
            )
        except ValueError as e:
            return GenerationResult(success=False, error=str(e))

        prompt = profile["image_prompt"]
        logger.info(f"Generating {entity_type} ref for '{name}' with material '{material_id}'")

        # Step 2: Determine aspect ratio
        aspect_ratio = get_aspect_ratio(entity_type)

        # Step 3: Call Flow API
        result = await self.client.generate_images(
            prompt=prompt,
            project_id=project_id,
            aspect_ratio=aspect_ratio,
            user_paygate_tier=user_paygate_tier,
        )

        if _is_error(result):
            error_msg = result.get("error", "Unknown error")
            return GenerationResult(success=False, error=error_msg)

        # Step 4: Parse response
        media_id = extract_media_id(result, "GENERATE_CHARACTER_IMAGE")
        output_url = extract_output_url(result, "GENERATE_CHARACTER_IMAGE")

        # Step 5: If we got URL but no media_id, try to upload to get permanent UUID
        if output_url and not media_id:
            logger.info("Got URL but no media_id, trying to extract from URL or upload...")
            uuid_from_url = _extract_uuid_from_url(output_url)
            if uuid_from_url:
                media_id = uuid_from_url
                logger.info(f"Extracted media_id from URL: {media_id}")
            else:
                # Try upload to get media_id
                uploaded_mid = await self._upload_from_url(output_url, project_id)
                if uploaded_mid:
                    media_id = uploaded_mid
                    logger.info(f"Got media_id via upload: {media_id}")

        # Step 6: Download if requested
        local_path = None
        if download_to and output_url:
            local_path = await self._download_image(output_url, download_to)

        if media_id and output_url:
            logger.info(f"Entity ref generated: {media_id}")
            return GenerationResult(
                success=True,
                media_id=media_id,
                url=output_url,
                local_path=local_path,
            )
        else:
            return GenerationResult(
                success=False,
                error="Failed to get media_id or URL from response",
            )

    async def _upload_from_url(self, url: str, project_id: str) -> Optional[str]:
        """Download image from URL and upload to Flow to get permanent media_id."""
        try:
            # Download image
            ssl_ctx = ssl.create_default_context()
            async with aiohttp.ClientSession() as session:
                async with session.get(url, ssl=ssl_ctx) as resp:
                    if resp.status != 200:
                        logger.error(f"Failed to download image: HTTP {resp.status}")
                        return None
                    image_bytes = await resp.read()
                    content_type = resp.headers.get("content-type", "image/jpeg")

            mime = "image/jpeg"
            if "png" in content_type:
                mime = "image/png"
            elif "gif" in content_type:
                mime = "image/gif"

            ext = mime.split("/")[-1]
            file_name = f"entity_ref.{ext}"

            encoded = base64.b64encode(image_bytes).decode("utf-8")
            result = await self.client.upload_image(
                encoded, mime_type=mime, project_id=project_id, file_name=file_name,
            )

            if result.get("_mediaId"):
                return result["_mediaId"]

            data = result.get("data", {})
            if isinstance(data, dict):
                media = data.get("media", {})
                if isinstance(media, dict) and media.get("name"):
                    return media["name"]

            return None
        except Exception as e:
            logger.error(f"Failed to upload from URL: {e}")
            return None

    async def _download_image(self, url: str, dest_path: str) -> Optional[str]:
        """Download image from URL to local file."""
        try:
            Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
            connector = aiohttp.TCPConnector(ssl=False)
            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.get(url, timeout=30) as resp:
                    if resp.status == 200:
                        Path(dest_path).write_bytes(await resp.read())
                        logger.info(f"Image downloaded to: {dest_path}")
                        return dest_path
                    else:
                        logger.error(f"Failed to download: HTTP {resp.status}")
                        return None
        except Exception as e:
            logger.error(f"Failed to download image: {e}")
            return None
