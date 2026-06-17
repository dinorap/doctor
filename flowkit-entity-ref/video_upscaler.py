"""
Video Upscaler - Upscale videos to 4K resolution.

This module handles:
1. Submit upscale request to Flow API
2. Poll for completion
3. Handle inline rawBytes (4K video data returned directly)
4. Download upscaled video
"""
import asyncio
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import aiohttp

from .flow_client_wrapper import FlowClientWrapper
from .parsing import _is_error, extract_media_id, extract_output_url

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


@dataclass
class VideoOperation:
    """Represents a video operation from Flow API."""
    name: str
    status: str  # MEDIA_GENERATION_STATUS_PENDING, SUCCESSFUL, FAILED
    metadata: dict = None

    @property
    def is_pending(self) -> bool:
        return self.status == "MEDIA_GENERATION_STATUS_PENDING"

    @property
    def is_successful(self) -> bool:
        return self.status == "MEDIA_GENERATION_STATUS_SUCCESSFUL"

    @property
    def is_failed(self) -> bool:
        return self.status == "MEDIA_GENERATION_STATUS_FAILED"


def parse_operations(result: dict) -> list[VideoOperation]:
    """Parse operations from upscale/video response."""
    data = result.get("data", result)
    ops = data.get("operations", [])
    return [
        VideoOperation(
            name=op.get("operation", {}).get("name", ""),
            status=op.get("status", ""),
            metadata=op.get("operation", {}).get("metadata", {}),
        )
        for op in ops
    ]


def extract_video_url(operation: VideoOperation) -> str:
    """Extract video URL from operation metadata."""
    if operation.metadata:
        video_meta = operation.metadata.get("video", {})
        return video_meta.get("fifeUrl", "")
    return ""


class VideoUpscaler:
    """
    Upscaler for video files via Google Flow API.

    Usage:
        client = FlowClientWrapper()
        client.set_websocket(ws)
        client.set_flow_key("your_key")

        upscaler = VideoUpscaler(client)

        # Upscale a video
        result = await upscaler.upscale_video(
            media_id="video_media_id",
            orientation="VERTICAL",  # or "HORIZONTAL"
            download_to="./output/video_4k.mp4",
        )

        print(f"Success: {result.success}")
        print(f"Media ID: {result.media_id}")
    """

    def __init__(self, flow_client: FlowClientWrapper):
        self.client = flow_client

    async def upscale_video(
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
            media_id: The media_id of the video to upscale
            orientation: "VERTICAL" or "HORIZONTAL"
            resolution: Resolution preset (default: VIDEO_RESOLUTION_4K)
            scene_id: Optional scene ID for tracking
            timeout: Polling timeout in seconds (default: 300)
            download_to: Optional path to download the upscaled video

        Returns:
            UpscaleResult with media_id, url, and optional local_path
        """
        if not self.client.connected:
            return UpscaleResult(success=False, error="Flow client not connected")

        if not media_id:
            return UpscaleResult(success=False, error="No media_id provided")

        aspect = "VIDEO_ASPECT_RATIO_PORTRAIT" if orientation == "VERTICAL" else "VIDEO_ASPECT_RATIO_LANDSCAPE"

        logger.info(f"Submitting upscale request: media_id={media_id[:20]}, aspect={aspect}")

        # Submit upscale request
        submit_result = await self.client.upscale_video(
            media_id=media_id,
            scene_id=scene_id,
            aspect_ratio=aspect,
            resolution=resolution,
        )

        if _is_error(submit_result):
            error_msg = submit_result.get("error", "Unknown error")
            return UpscaleResult(success=False, error=error_msg)

        # Parse operations
        operations = parse_operations(submit_result)
        if not operations:
            return UpscaleResult(success=False, error="No operations returned")

        op = operations[0]

        # Check for immediate success
        if op.is_successful:
            url = extract_video_url(op)
            media_id_out = extract_media_id(submit_result, "UPSCALE_VIDEO")
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

        if op.is_failed:
            return UpscaleResult(success=False, error="Upscale failed immediately")

        # Poll for completion
        logger.info(f"Upscale submitted, polling {len(operations)} operation(s)...")
        poll_result = await self._poll_operations(operations, timeout)

        if _is_error(poll_result):
            return UpscaleResult(success=False, error=poll_result.get("error", "Poll failed"))

        # Extract results
        poll_ops = parse_operations(poll_result)
        if poll_ops:
            final_op = poll_ops[0]
            url = extract_video_url(final_op)
            media_id_out = extract_media_id(poll_result, "UPSCALE_VIDEO")

            local_path = None
            if download_to and url:
                local_path = await self._download_video(url, download_to)

            if final_op.is_successful:
                logger.info(f"Upscale completed after polling: {media_id_out}")
                return UpscaleResult(
                    success=True,
                    media_id=media_id_out or media_id,
                    url=url,
                    local_path=local_path,
                )
            else:
                return UpscaleResult(success=False, error=f"Operation status: {final_op.status}")

        return UpscaleResult(success=False, error="No poll result")

    async def _poll_operations(
        self,
        operations: list[VideoOperation],
        timeout: int,
    ) -> dict:
        """Poll check_video_status until all operations complete or timeout."""
        elapsed = 0
        current_ops = [
            {"operation": {"name": op.name}, "status": "MEDIA_GENERATION_STATUS_PENDING"}
            for op in operations
        ]

        while elapsed < timeout:
            await asyncio.sleep(POLL_INTERVAL)
            elapsed += POLL_INTERVAL

            status_result = await self.client.check_video_status(current_ops)
            if _is_error(status_result):
                logger.warning(f"Status poll error: {status_result.get('error')}")
                continue

            poll_ops = parse_operations(status_result)
            if not poll_ops:
                continue

            current_ops = [
                {"operation": {"name": op.name}, "status": op.status}
                for op in poll_ops
            ]

            # Check all operations
            all_done = True
            has_error = False

            for op in poll_ops:
                if op.is_pending:
                    all_done = False
                elif op.is_failed:
                    has_error = True
                    break

            if has_error:
                return {"error": "Operation failed"}

            if all_done:
                logger.info(f"All {len(poll_ops)} operations completed after {elapsed}s")
                return status_result

            done_count = sum(1 for op in poll_ops if op.is_successful)
            logger.debug(f"Poll {elapsed}s/{timeout}s: {done_count}/{len(poll_ops)} done")

        return {"error": f"Polling timeout after {timeout}s"}

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
