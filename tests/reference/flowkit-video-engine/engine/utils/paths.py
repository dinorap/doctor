"""Centralized path resolver for project output directories and scene files."""
from pathlib import Path

from engine.config import OUTPUT_DIR


def project_dir(project_slug: str) -> Path:
    """Return the output directory for a given project slug."""
    return OUTPUT_DIR / project_slug


def scene_filename(scene_id: str, ext: str = "mp4") -> str:
    """Return canonical scene filename using only scene_id: <scene_id>.<ext>."""
    return f"{scene_id}.{ext}"


def scene_4k_path(project_slug: str, scene_id: str) -> Path:
    """Return path to the 4K scene video file."""
    return project_dir(project_slug) / "4k" / scene_filename(scene_id)


def scene_img_path(project_slug: str, scene_id: str) -> Path:
    """Return path to the scene image file (img/ subdir)."""
    return project_dir(project_slug) / "img" / scene_filename(scene_id, ext="jpg")


def scene_tts_path(project_slug: str, scene_id: str) -> Path:
    """Return path to the TTS narration WAV for a scene."""
    return project_dir(project_slug) / "tts" / scene_filename(scene_id, ext="wav")


def scene_video_path(
    project_slug: str, scene_id: str, subdir: str = "scenes"
) -> Path:
    """Return path to a scene video file under an arbitrary subdir."""
    return project_dir(project_slug) / subdir / scene_filename(scene_id)


def resolve_4k_file(project_slug: str, scene_id: str) -> "Path | None":
    """Locate the 4K file for a scene.
    """
    canonical = scene_4k_path(project_slug, scene_id)
    if canonical.exists():
        return canonical
    return None
