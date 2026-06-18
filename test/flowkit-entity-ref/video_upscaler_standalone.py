"""
FlowKit Video Upscaler - Standalone module to upscale videos to 4K.

This is a simplified standalone version extracted from FlowKit agent-flowkit.
Can be used independently without the full FlowKit codebase.

Usage:
    from video_upscaler import VideoUpscalerStandalone

    upscaler = VideoUpscalerStandalone(websocket, flow_key)

    result = await upscaler.upscale(
        media_id="video_uuid",
        orientation="VERTICAL",
        download_to="./output/video_4k.mp4",
    )
"""
import asyncio
import base64
import logging
import ssl
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
import aiohttp

logger = logging.getLogger(__name__)

# Default timeout for upscale polling (5 minutes)
DEFAULT_UPSCALE_TIMEOUT = 300
POLL_INTERVAL = 10


@dataclass
class UpscaleResult:
    """Result of an upscale operation."""
    success: bool
    media_id: Optional[str] = None
    url: Optional[str] = None
    local_path: Optional[str] = None
    error: Optional[str] = None


class VideoUpscalerStandalone:
    """
    Standalone upscaler for video files via Google Flow API.

    Usage:
        from video_upscaler import VideoUpscalerStandalone

        # Initialize with WebSocket and flow key from Chrome Extension
        upscaler = VideoUpscalerStandalone(websocket, "flow_key_here")

        # Upscale a video
        result = await upscaler.upscale(
            media_id="video_media_id",
            orientation="VERTICAL",
            download_to="./output/video_4k.mp4",
        )

        print(f"Success: {result.success}")
        print(f"Media ID: {result.media_id}")
        if result.local_path:
            print(f"Saved to: {result.local_path}")
    """

    def __init__(self, websocket, flow_key: str):
        """
        Initialize the upscaler.

        Args:
            websocket: WebSocket connection from Chrome Extension
            flow_key: Flow API key from Chrome Extension
        """
        self._ws = websocket
        self._flow_key = flow_key
        self._pending = {}
        self._timeout = 300

    @property
    def connected(self) -> bool:
        """Check if WebSocket is connected."""
        return self._ws is not None

    async def _send(self, method: str, params: dict, timeout: float = None) -> dict:
        """Send request via WebSocket and wait for response."""
        if not self.connected:
            return {"error": "WebSocket not connected"}

        import uuid
        request_id = str(uuid.uuid4())
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

    async def _handle_response(self, data: dict):
        """Handle response from WebSocket."""
        request_id = data.get("id")
        if request_id and request_id in self._pending:
            future = self._pending[request_id]
            if not future.done():
                future.set_result(data)

    async def upscale(
        self,
        media_id: str,
        orientation: str = "VERTICAL",
        resolution: str = "VIDEO_RESOLUTION_4K",
        scene_id: str = "",
        timeout: int = DEFAULT_UPSCALE_TIMEOUT,
        download_to: Optional[str] = None,
    ) -> UpscaleResult:
        """
        Upscale a video to 4K resolution.

        Args:
            media_id: The media_id of the video to upscale (UUID format)
            orientation: "VERTICAL" or "HORIZONTAL"
            resolution: Resolution preset (default: VIDEO_RESOLUTION_4K)
            scene_id: Optional scene ID for tracking
            timeout: Polling timeout in seconds (default: 300)
            download_to: Optional path to download the upscaled video

        Returns:
            UpscaleResult with media_id, url, and optional local_path
        """
        if not self.connected:
            return UpscaleResult(success=False, error="WebSocket not connected")

        if not media_id:
            return UpscaleResult(success=False, error="No media_id provided")

        aspect = "VIDEO_ASPECT_RATIO_PORTRAIT" if orientation == "VERTICAL" else "VIDEO_ASPECT_RATIO_LANDSCAPE"

        logger.info(f"Submitting upscale: media_id={media_id[:20]}, aspect={aspect}")

        # Submit upscale request
        submit_result = await self._submit_upscale(
            media_id=media_id,
            scene_id=scene_id,
            aspect_ratio=aspect,
            resolution=resolution,
        )

        if self._is_error(submit_result):
            error_msg = submit_result.get("error", "Unknown error")
            return UpscaleResult(success=False, error=error_msg)

        # Parse operations
        operations = self._parse_operations(submit_result)
        if not operations:
            return UpscaleResult(success=False, error="No operations returned")

        op = operations[0]

        # Check for immediate success
        if op["status"] == "MEDIA_GENERATION_STATUS_SUCCESSFUL":
            url = self._extract_video_url(op)
            media_id_out = self._extract_media_id(submit_result, "UPSCALE_VIDEO")
            logger.info(f"Upscale completed immediately: {media_id_out}")

            local_path = None
            if download_to:
                local_path = await self._download_video(url, download_to)

            return UpscaleResult(
                success=True,
                media_id=media_id_out or media_id,
                url=url,
                local_path=local_path,
            )

        if op["status"] == "MEDIA_GENERATION_STATUS_FAILED":
            return UpscaleResult(success=False, error="Upscale failed immediately")

        # Poll for completion
        logger.info(f"Upscale submitted, polling {len(operations)} operation(s)...")
        poll_result = await self._poll_operations(operations, timeout)

        if self._is_error(poll_result):
            return UpscaleResult(success=False, error=poll_result.get("error", "Poll failed"))

        # Extract results
        poll_ops = self._parse_operations(poll_result)
        if poll_ops:
            final_op = poll_ops[0]
            url = self._extract_video_url(final_op)
            media_id_out = self._extract_media_id(poll_result, "UPSCALE_VIDEO")

            local_path = None
            if download_to and url:
                local_path = await self._download_video(url, download_to)

            if final_op["status"] == "MEDIA_GENERATION_STATUS_SUCCESSFUL":
                logger.info(f"Upscale completed after polling: {media_id_out}")
                return UpscaleResult(
                    success=True,
                    media_id=media_id_out or media_id,
                    url=url,
                    local_path=local_path,
                )
            else:
                return UpscaleResult(success=False, error=f"Operation status: {final_op['status']}")

        return UpscaleResult(success=False, error="No poll result")

    async def _submit_upscale(
        self,
        media_id: str,
        scene_id: str,
        aspect_ratio: str,
        resolution: str,
    ) -> dict:
        """Submit upscale request to Flow API."""
        params = {
            "sessionId": f";{int(time.time() * 1000)}",
            "recaptchaContext": {
                "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
                "token": "",  # Extension injects real token
            },
            "requests": [{
                "aspectRatio": aspect_ratio,
                "resolution": resolution,
                "seed": int(time.time()) % 100000,
                "metadata": {"sceneId": scene_id},
                "videoInput": {"mediaId": media_id},
                "videoModelKey": "veo_3_1_upsampler_4k",
            }],
        }
        return await self._send("upscaleVideo", params, timeout=60)

    async def _poll_operations(
        self,
        operations: list[dict],
        timeout: int,
    ) -> dict:
        """Poll check_video_status until all operations complete or timeout."""
        elapsed = 0
        current_ops = [
            {"operation": {"name": op.get("operation", {}).get("name", "")}, "status": "MEDIA_GENERATION_STATUS_PENDING"}
            for op in operations
        ]

        while elapsed < timeout:
            await asyncio.sleep(POLL_INTERVAL)
            elapsed += POLL_INTERVAL

            status_result = await self._check_status(current_ops)
            if self._is_error(status_result):
                logger.warning(f"Status poll error: {status_result.get('error')}")
                continue

            poll_ops = self._parse_operations(status_result)
            if not poll_ops:
                continue

            current_ops = [
                {"operation": {"name": op.get("operation", {}).get("name", "")}, "status": op.get("status", "")}
                for op in poll_ops
            ]

            # Check all operations
            all_done = True
            has_error = False

            for op in poll_ops:
                status = op.get("status", "")
                if status == "MEDIA_GENERATION_STATUS_PENDING":
                    all_done = False
                elif status == "MEDIA_GENERATION_STATUS_FAILED":
                    has_error = True
                    break

            if has_error:
                return {"error": "Operation failed"}

            if all_done:
                logger.info(f"All {len(poll_ops)} operations completed after {elapsed}s")
                return status_result

            done_count = sum(1 for op in poll_ops if op.get("status") == "MEDIA_GENERATION_STATUS_SUCCESSFUL")
            logger.debug(f"Poll {elapsed}s/{timeout}s: {done_count}/{len(poll_ops)} done")

        return {"error": f"Polling timeout after {timeout}s"}

    async def _check_status(self, operations: list[dict]) -> dict:
        """Check status of video operations."""
        params = {"operations": operations}
        return await self._send("checkVideoStatus", params, timeout=30)

    def _parse_operations(self, result: dict) -> list[dict]:
        """Parse operations from upscale/video response."""
        data = result.get("data", result)
        return data.get("operations", [])

    def _extract_video_url(self, operation: dict) -> str:
        """Extract video URL from operation metadata."""
        metadata = operation.get("operation", {}).get("metadata", {})
        video_meta = metadata.get("video", {})
        return video_meta.get("fifeUrl", "")

    def _is_error(self, result: dict) -> bool:
        """Check if result contains an error."""
        if result.get("error"):
            return True
        status = result.get("status")
        if isinstance(status, int) and status >= 400:
            return True
        data = result.get("data", {})
        if isinstance(data, dict) and data.get("error"):
            return True
        return False

    def _extract_media_id(self, result: dict, req_type: str) -> Optional[str]:
        """Extract UUID media_id from response."""
        import re

        def is_uuid(value: str) -> bool:
            return bool(re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', value, re.I))

        def extract_uuid_from_url(url: str) -> str:
            match = re.search(r'/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', url, re.I)
            return match.group(1) if match else ""

        data = result.get("data", result)

        if req_type in ("UPSCALE_VIDEO",):
            ops = data.get("operations", [])
            if ops:
                video_meta = ops[0].get("operation", {}).get("metadata", {}).get("video", {})
                for field in ("mediaId",):
                    val = video_meta.get(field, "")
                    if val and is_uuid(val):
                        return val
                fife = video_meta.get("fifeUrl", "")
                if fife:
                    uuid_val = extract_uuid_from_url(fife)
                    if uuid_val:
                        return uuid_val
                val = video_meta.get("mediaId", "")
                if val and is_uuid(val):
                    return val
                return None

        return None

    async def _download_video(self, url: str, dest_path: str) -> Optional[str]:
        """Download video from URL to local file."""
        if not url:
            return None

        try:
            Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
            connector = aiohttp.TCPConnector(ssl=False)
            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.get(url, timeout=60) as resp:
                    if resp.status == 200:
                        Path(dest_path).write_bytes(await resp.read())
                        logger.info(f"Video downloaded to: {dest_path}")
                        return dest_path
                    else:
                        logger.error(f"Failed to download video: HTTP {resp.status}")
                        return None
        except Exception as e:
            logger.error(f"Failed to download video: {e}")
            return None


# ─── Standalone utility functions ────────────────────────────────────────────

async def download_video(url: str, dest_path: str) -> Optional[str]:
    """
    Download a video from GCS URL to local path.

    Args:
        url: GCS signed URL of the video
        dest_path: Local path to save the video

    Returns:
        Local path if successful, None otherwise
    """
    try:
        Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
        connector = aiohttp.TCPConnector(ssl=False)
        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.get(url, timeout=60) as resp:
                if resp.status == 200:
                    Path(dest_path).write_bytes(await resp.read())
                    logger.info(f"Video downloaded to: {dest_path}")
                    return dest_path
                else:
                    logger.error(f"Failed to download video: HTTP {resp.status}")
                    return None
    except Exception as e:
        logger.error(f"Failed to download video: {e}")
        return None


async def upload_and_get_media_id(
    websocket,
    flow_key: str,
    file_path: str,
    mime_type: str = "video/mp4",
) -> Optional[str]:
    """
    Upload a video file and get its media_id.

    Args:
        websocket: WebSocket connection from Chrome Extension
        flow_key: Flow API key
        file_path: Path to the video file
        mime_type: MIME type (default: video/mp4)

    Returns:
        media_id (UUID) if successful, None otherwise
    """
    import uuid

    try:
        # Read file
        file_bytes = Path(file_path).read_bytes()
        encoded = base64.b64encode(file_bytes).decode("utf-8")
        file_name = Path(file_path).name

        # Create upscaler to use its _send method
        upscaler = VideoUpscalerStandalone(websocket, flow_key)

        params = {
            "flowKey": flow_key,
            "imageBase64": encoded,
            "mimeType": mime_type,
            "projectId": "",
            "fileName": file_name,
        }

        result = await upscaler._send("uploadImage", params)
        logger.info(f"Upload result: {result}")

        # Extract media_id
        if result.get("_mediaId"):
            return result["_mediaId"]

        data = result.get("data", {})
        if isinstance(data, dict):
            media = data.get("media", {})
            if isinstance(media, dict) and media.get("name"):
                return media["name"]

        return None
    except Exception as e:
        logger.error(f"Failed to upload video: {e}")
        return None


# ─── Example usage ────────────────────────────────────────────────────────────

async def example():
    """
    Example usage of VideoUpscalerStandalone.

    Note: This is a template - you need a real websocket connection
    from the Chrome Extension to use this.
    """
    # Example with mock WebSocket (replace with real one)
    class MockWebSocket:
        async def send_json(self, msg):
            # In real usage, this sends to Chrome Extension
            print(f"Sending: {msg.get('method')}")

        async def recv_json(self):
            # In real usage, this receives from Chrome Extension
            pass

    # Initialize
    ws = MockWebSocket()  # Replace with real WebSocket
    flow_key = "your_flow_key"  # From Chrome Extension

    upscaler = VideoUpscalerStandalone(ws, flow_key)

    # Upscale a video
    video_media_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # Replace with real ID

    result = await upscaler.upscale(
        media_id=video_media_id,
        orientation="VERTICAL",
        resolution="VIDEO_RESOLUTION_4K",
        scene_id="scene_001",
        download_to="./output/video_4k.mp4",
    )

    if result.success:
        print(f"SUCCESS!")
        print(f"  Media ID: {result.media_id}")
        print(f"  URL: {result.url}")
        if result.local_path:
            print(f"  Saved to: {result.local_path}")
    else:
        print(f"FAILED: {result.error}")


if __name__ == "__main__":
    print("VideoUpscalerStandalone - Standalone module for upscaling videos to 4K")
    print()
    print("Usage:")
    print("  from video_upscaler import VideoUpscalerStandalone")
    print()
    print("  upscaler = VideoUpscalerStandalone(websocket, flow_key)")
    print("  result = await upscaler.upscale(media_id='...', orientation='VERTICAL')")
    print()
    print("See docstrings for full API documentation.")
