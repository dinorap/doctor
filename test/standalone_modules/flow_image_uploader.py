"""
Flow Image Uploader - Standalone Module
Module upload ảnh local lên Google Flow.
"""
import base64
import logging
import mimetypes
from pathlib import Path

logger = logging.getLogger(__name__)


class FlowImageUploader:
    """Service upload ảnh lên Google Flow."""
    
    def __init__(self, flow_client):
        """
        Args:
            flow_client: Instance của FlowClientWrapper
        """
        self.client = flow_client
    
    async def upload_image(
        self,
        file_path: str,
        project_id: str = "",
        file_name: Optional[str] = None,
    ) -> dict:
        """
        Upload ảnh local lên Google Flow.
        
        Args:
            file_path: Đường dẫn tới file ảnh local
            project_id: Flow project ID (optional)
            file_name: Tên file (optional, mặc định dùng tên file gốc)
        
        Returns:
            dict: {"media_id": "...", "url": "..."}
        """
        if not self.client.connected:
            raise Exception("Flow client not connected")
        
        # Validate file exists
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")
        
        # Read and encode image
        logger.info(f"Uploading image: {file_path}")
        
        with open(file_path, 'rb') as f:
            image_bytes = f.read()
        
        image_base64 = base64.b64encode(image_bytes).decode()
        
        # Detect MIME type
        mime_type = mimetypes.guess_type(file_path)[0] or "image/png"
        
        # Use original filename if not provided
        if not file_name:
            file_name = path.name
        
        # Upload via Flow API
        result = await self.client.upload_image(
            image_base64=image_base64,
            mime_type=mime_type,
            project_id=project_id,
            file_name=file_name,
        )
        
        if result.get("error"):
            raise Exception(f"Image upload failed: {result['error']}")
        
        # Parse response
        media_id = result.get("_mediaId")
        url = result.get("data", {}).get("servingUri", "")
        
        if not media_id:
            raise Exception("No media_id returned from Flow")
        
        logger.info(f"Image uploaded: {media_id}")
        
        return {
            "media_id": media_id,
            "url": url,
            "file_name": file_name,
        }
