"""
Flow Client Wrapper - Simplified WebSocket client for Google Flow API.

This is a standalone version that can be used without the full FlowKit codebase.
"""
import asyncio
import logging
from typing import Optional, Any
from uuid import uuid4

logger = logging.getLogger(__name__)


class FlowClientWrapper:
    """Wrapper client for Google Flow API via WebSocket."""

    def __init__(self):
        self._ws = None
        self._flow_key = None
        self._pending = {}
        self._timeout = 300

    def set_websocket(self, ws):
        """Set WebSocket connection from Chrome Extension."""
        self._ws = ws

    def set_flow_key(self, key: str):
        """Set Flow API key."""
        self._flow_key = key

    @property
    def connected(self) -> bool:
        """Check if WebSocket is connected."""
        return self._ws is not None

    async def _send(self, method: str, params: dict, timeout: float = None) -> dict:
        """Send request via WebSocket and wait for response."""
        if not self.connected:
            return {"error": "WebSocket not connected"}

        request_id = str(uuid4())
        future = asyncio.Future()
        self._pending[request_id] = future

        message = {
            "id": request_id,
            "method": method,
            "params": params
        }

        await self._ws.send_json(message)

        try:
            result = await asyncio.wait_for(future, timeout or self._timeout)
            return result
        except asyncio.TimeoutError:
            self._pending.pop(request_id, None)
            return {"error": f"Request timeout after {timeout or self._timeout}s"}
        finally:
            self._pending.pop(request_id, None)

    async def handle_response(self, data: dict):
        """Handle response from WebSocket."""
        request_id = data.get("id")
        if request_id and request_id in self._pending:
            future = self._pending[request_id]
            if not future.done():
                future.set_result(data)

    def _client_context(self, project_id: str, tier: str = "PAYGATE_TIER_TWO") -> dict:
        """Build client context for API requests."""
        return {
            "flowKey": self._flow_key,
            "projectId": project_id,
            "userPaygateTier": tier,
        }

    async def generate_images(
        self,
        prompt: str,
        project_id: str,
        aspect_ratio: str = "IMAGE_ASPECT_RATIO_PORTRAIT",
        user_paygate_tier: str = "PAYGATE_TIER_TWO",
        character_media_ids: Optional[list[str]] = None,
    ) -> dict:
        """Generate images via Google Flow API."""
        params = {
            **self._client_context(project_id, user_paygate_tier),
            "prompt": prompt,
            "aspectRatio": aspect_ratio,
        }
        if character_media_ids:
            params["characterMediaIds"] = character_media_ids

        return await self._send("generateImages", params)

    async def upload_image(
        self,
        image_base64: str,
        mime_type: str = "image/jpeg",
        project_id: str = "",
        file_name: str = "image.png",
    ) -> dict:
        """Upload image to Google Flow."""
        params = {
            "flowKey": self._flow_key,
            "imageBase64": image_base64,
            "mimeType": mime_type,
            "projectId": project_id,
            "fileName": file_name,
        }
        return await self._send("uploadImage", params)

    async def get_media(self, media_id: str) -> dict:
        """Get media info."""
        params = {
            "flowKey": self._flow_key,
            "mediaId": media_id,
        }
        return await self._send("getMedia", params)

    async def get_credits(self) -> dict:
        """Get user credits info."""
        params = {"flowKey": self._flow_key}
        return await self._send("getCredits", params)
