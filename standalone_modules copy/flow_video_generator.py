"""
Flow Video Generator - Standalone Module
Module tạo video qua Google Flow API.
"""
import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)


class FlowVideoGenerator:
    """Service tạo video qua Google Flow."""
    
    def __init__(self, flow_client):
        """
        Args:
            flow_client: Instance của FlowClientWrapper
        """
        self.client = flow_client
    
    async def generate_video(
        self,
        start_image_media_id: str,
        prompt: str,
        project_id: str,
        scene_id: str,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
        end_image_media_id: Optional[str] = None,
        user_paygate_tier: str = "PAYGATE_TIER_TWO",
        wait_for_completion: bool = False,
        poll_interval: int = 10,
    ) -> dict:
        """
        Tạo video từ ảnh qua Google Flow API.
        
        Args:
            start_image_media_id: Media ID của ảnh bắt đầu
            prompt: Camera movement prompt
            project_id: Flow project ID
            scene_id: Scene ID
            aspect_ratio: PORTRAIT, LANDSCAPE
            end_image_media_id: Optional media ID của ảnh kết thúc
            user_paygate_tier: User tier
            wait_for_completion: Có đợi video generate xong không
            poll_interval: Thời gian giữa các lần check status (seconds)
        
        Returns:
            dict: {"operations": [...], "media_id": "...", "url": "...", "status": "..."}
        """
        if not self.client.connected:
            raise Exception("Flow client not connected")
        
        # Map aspect ratio
        aspect_map = {
            "PORTRAIT": "VIDEO_ASPECT_RATIO_PORTRAIT",
            "LANDSCAPE": "VIDEO_ASPECT_RATIO_LANDSCAPE",
        }
        aspect = aspect_map.get(aspect_ratio.upper(), aspect_ratio)
        
        logger.info(f"Generating video from {start_image_media_id}: {prompt[:50]}...")
        
        # Submit video generation
        result = await self.client.generate_video(
            start_image_media_id=start_image_media_id,
            prompt=prompt,
            project_id=project_id,
            scene_id=scene_id,
            aspect_ratio=aspect,
            end_image_media_id=end_image_media_id,
            user_paygate_tier=user_paygate_tier,
        )
        
        if result.get("error"):
            raise Exception(f"Video generation failed: {result['error']}")
        
        # Parse operations
        try:
            data = result.get("data", result)
            operations = data.get("result", {}).get("data", {}).get("json", {}).get("operations", [])
            
            output = {
                "operations": operations,
                "status": "PENDING",
            }
            
            # Wait for completion if requested
            if wait_for_completion and operations:
                final_result = await self._poll_until_complete(operations, poll_interval)
                output.update(final_result)
            
            return output
            
        except (KeyError, TypeError) as e:
            logger.error(f"Failed to parse response: {e}")
            raise Exception(f"Failed to parse Flow response: {e}")
    
    async def check_status(self, operations: list[dict]) -> dict:
        """
        Check trạng thái video generation.
        
        Args:
            operations: List operations từ generate_video response
        
        Returns:
            dict: {"status": "...", "media_id": "...", "url": "...", "progress": ...}
        """
        if not self.client.connected:
            raise Exception("Flow client not connected")
        
        result = await self.client.check_video_status(operations)
        
        if result.get("error"):
            raise Exception(f"Status check failed: {result['error']}")
        
        # Parse status
        try:
            data = result.get("data", result)
            op_list = data.get("result", {}).get("data", {}).get("json", {}).get("operations", [])
            
            if not op_list:
                return {"status": "UNKNOWN"}
            
            # Check first operation
            op = op_list[0]
            done = op.get("done", False)
            
            if done:
                response = op.get("response", {})
                media_id = response.get("mediaId")
                url = response.get("servingUri") or response.get("fifeUrl")
                
                return {
                    "status": "DONE",
                    "media_id": media_id,
                    "url": url,
                }
            else:
                # Parse progress
                metadata = op.get("metadata", {})
                progress_message = metadata.get("progressMessage", "")
                
                return {
                    "status": "PENDING",
                    "progress": progress_message,
                }
        except (KeyError, TypeError) as e:
            logger.error(f"Failed to parse status: {e}")
            return {"status": "ERROR", "error": str(e)}
    
    async def _poll_until_complete(
        self,
        operations: list[dict],
        interval: int = 10,
        max_wait: int = 600,
    ) -> dict:
        """Poll status cho đến khi complete hoặc timeout."""
        elapsed = 0
        
        while elapsed < max_wait:
            status = await self.check_status(operations)
            
            if status["status"] == "DONE":
                logger.info(f"Video generation complete: {status.get('media_id')}")
                return status
            elif status["status"] == "ERROR":
                raise Exception(f"Video generation failed: {status.get('error')}")
            
            logger.info(f"Waiting for video... ({status.get('progress', 'processing')})")
            await asyncio.sleep(interval)
            elapsed += interval
        
        raise Exception(f"Video generation timeout after {max_wait}s")
