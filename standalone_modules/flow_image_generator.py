"""
Flow Image Generator - Standalone Module
Module tạo ảnh qua Google Flow API.
"""
import logging
import aiohttp
from typing import Optional

logger = logging.getLogger(__name__)


class FlowImageGenerator:
    """Service tạo ảnh qua Google Flow."""
    
    def __init__(self, flow_client):
        """
        Args:
            flow_client: Instance của FlowClientWrapper
        """
        self.client = flow_client
    
    async def generate_image(
        self,
        prompt: str,
        project_id: str,
        aspect_ratio: str = "IMAGE_ASPECT_RATIO_PORTRAIT",
        character_media_ids: Optional[list[str]] = None,
        user_paygate_tier: str = "PAYGATE_TIER_TWO",
        download_to: Optional[str] = None,
    ) -> dict:
        """
        Tạo ảnh qua Google Flow API.
        
        Args:
            prompt: Text prompt mô tả ảnh
            project_id: Flow project ID
            aspect_ratio: PORTRAIT, LANDSCAPE, SQUARE
            character_media_ids: List media IDs của characters để reference
            user_paygate_tier: User tier (TIER_ONE, TIER_TWO, etc.)
            download_to: Optional path để download ảnh về local
        
        Returns:
            dict: {"media_id": "...", "url": "...", "local_path": "..."}
        """
        if not self.client.connected:
            raise Exception("Flow client not connected")
        
        # Map aspect ratio
        aspect_map = {
            "PORTRAIT": "IMAGE_ASPECT_RATIO_PORTRAIT",
            "LANDSCAPE": "IMAGE_ASPECT_RATIO_LANDSCAPE",
            "SQUARE": "IMAGE_ASPECT_RATIO_SQUARE",
        }
        aspect = aspect_map.get(aspect_ratio.upper(), aspect_ratio)
        
        logger.info(f"Generating image: {prompt[:50]}...")
        
        # Call Flow API
        result = await self.client.generate_images(
            prompt=prompt,
            project_id=project_id,
            aspect_ratio=aspect,
            user_paygate_tier=user_paygate_tier,
            character_media_ids=character_media_ids,
        )
        
        if result.get("error"):
            raise Exception(f"Image generation failed: {result['error']}")
        
        # Parse response
        try:
            data = result.get("data", result)
            response_data = data.get("result", {}).get("data", {})
            json_data = response_data.get("json", {})
            result_data = json_data.get("result", {})
            
            media_id = result_data.get("mediaId")
            url = result_data.get("servingUri") or result_data.get("fifeUrl")
            
            if not media_id or not url:
                raise Exception("Missing mediaId or URL in response")
            
            output = {
                "media_id": media_id,
                "url": url,
                "prompt": prompt,
            }
            
            # Download if requested
            if download_to and url:
                local_path = await self._download_image(url, download_to)
                output["local_path"] = local_path
            
            logger.info(f"Image generated: {media_id}")
            return output
            
        except (KeyError, TypeError) as e:
            logger.error(f"Failed to parse response: {e}")
            raise Exception(f"Failed to parse Flow response: {e}")
    
    async def _download_image(self, url: str, dest_path: str) -> str:
        """Download ảnh từ URL về local."""
        try:
            connector = aiohttp.TCPConnector(ssl=False)
            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.get(url) as resp:
                    if resp.status == 200:
                        with open(dest_path, 'wb') as f:
                            f.write(await resp.read())
                        logger.info(f"Image downloaded to: {dest_path}")
                        return dest_path
                    else:
                        raise Exception(f"HTTP {resp.status}")
        except Exception as e:
            logger.error(f"Failed to download image: {e}")
            raise
