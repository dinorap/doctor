"""
Media Downloader - Download and cache media files from GCS URLs.
"""
import logging
import re
import time
from pathlib import Path
from typing import Optional

import aiohttp

logger = logging.getLogger(__name__)


def is_url_expired(url: str) -> bool:
    """Check if a GCS signed URL is expired or close to expiration (<60s)."""
    if not url or "Expires=" not in url:
        return False
    m = re.search(r'Expires=(\d+)', url)
    if m:
        # Buffer 60 seconds
        return int(m.group(1)) < time.time() + 60
    return False


async def download_media_to_local(url: str, local_path: str) -> Optional[str]:
    """
    Download media file from URL to local path.
    
    Args:
        url: GCS signed URL
        local_path: Local file path to save to
        
    Returns:
        Local path if successful, None otherwise
    """
    if not url or not url.startswith("http"):
        return None
    
    path = Path(local_path)
    
    # Don't download if already exists
    if path.exists():
        logger.info(f"File already exists: {local_path}")
        return str(path)
    
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        connector = aiohttp.TCPConnector(ssl=False)
        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.get(url, timeout=30) as resp:
                if resp.status == 200:
                    path.write_bytes(await resp.read())
                    logger.info(f"Saved local media: {path}")
                    return str(path)
                else:
                    logger.error(f"Failed to download: HTTP {resp.status}")
                    return None
    except Exception as e:
        logger.error(f"Failed to download media: {e}")
        return None


def get_local_path_for_entity(
    project_slug: str,
    entity_id: str,
    entity_type: str = "character",
) -> Path:
    """
    Get standard local path for entity reference image.
    
    Format: output/{project_slug}/assets/{entity_id}.jpg
    """
    return Path("output") / project_slug / "assets" / f"{entity_id}.jpg"


def get_local_path_for_scene(
    project_slug: str,
    scene_id: str,
    media_type: str = "image",
) -> Path:
    """
    Get standard local path for scene media.
    
    Format: output/{project_slug}/scenes/{scene_id}.jpg (or .mp4)
    """
    ext = "mp4" if media_type == "video" else "jpg"
    return Path("output") / project_slug / "scenes" / f"{scene_id}.{ext}"
