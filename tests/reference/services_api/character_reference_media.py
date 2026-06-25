"""
Cast/character reference upload cho tab NEW.
- Upload song song (batch) như test_upload_multiple_images.py
- Mỗi Chrome profile giữ mapping riêng (display name + normalized key -> media_id)
- Không ghi reference_media_id vào script JSON
"""
from __future__ import annotations

import json
import re
import threading
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from services.nst_flow import _resolve_script_path
from services_api.veo_get_token import load_veo_auth_config
from services_api.veo_reference_image_api import batch_upload_images_parallel

PROFILE_KEYS = ("cast_profiles", "character_profiles")

# Meta key trả về orchestrator (giống __reference_media_name__)
CAST_REFERENCE_MEDIA_META_KEY = "__cast_reference_media_by_name__"


def _normalize_name_key(name: str) -> str:
    if not isinstance(name, str):
        return ""
    raw = name.strip()
    if not raw:
        return ""
    nfkd = unicodedata.normalize("NFKD", raw)
    no_accents = "".join(ch for ch in nfkd if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", "", no_accents.lower())


class ProfileCastMediaCache:
    """
    Cache media_id theo profile_id — thread-safe, không trộn giữa các profile.

    profile_media_cache[profile_id]["ÔNG LÃO"] = media_id
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._by_profile: Dict[str, Dict[str, str]] = {}

    def get_mapping(self, profile_id: str) -> Dict[str, str]:
        pid = str(profile_id or "").strip()
        if not pid:
            return {}
        with self._lock:
            return dict(self._by_profile.get(pid, {}))

    def merge_mapping(self, profile_id: str, mapping: Dict[str, str]) -> Dict[str, str]:
        pid = str(profile_id or "").strip()
        if not pid:
            return {}
        with self._lock:
            bucket = self._by_profile.setdefault(pid, {})
            for k, v in (mapping or {}).items():
                key = str(k or "").strip()
                mid = str(v or "").strip()
                if key and mid:
                    bucket[key] = mid
            return dict(bucket)

    def clear_profile(self, profile_id: str) -> None:
        pid = str(profile_id or "").strip()
        if not pid:
            return
        with self._lock:
            self._by_profile.pop(pid, None)


# Singleton in-RAM; keys luôn tách theo profile_id.
profile_cast_media_cache = ProfileCastMediaCache()


def parse_scene_character_field(character: str) -> List[str]:
    """Tách scene.character: "ÔNG LÃO, BÀ VỢ GIÀ" -> ["ÔNG LÃO", "BÀ VỢ GIÀ"]."""
    raw = str(character or "").strip()
    if not raw:
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


def load_cast_profiles_from_script(script_path: str) -> Tuple[List[dict], Optional[str]]:
    abs_script = _resolve_script_path(script_path)
    if not abs_script or not Path(abs_script).exists():
        return [], f"Script không tồn tại: {script_path}"
    with open(abs_script, "r", encoding="utf-8") as f:
        script_data = json.load(f)
    for key in PROFILE_KEYS:
        profiles = script_data.get(key)
        if isinstance(profiles, list) and profiles:
            return list(profiles), None
    return [], "missing_character_profiles"


def resolve_reference_image_abs(script_path: str, rel_url: str) -> Optional[str]:
    rel = str(rel_url or "").strip()
    if not rel:
        return None
    p = Path(rel)
    if p.is_absolute() and p.exists():
        return str(p.resolve())
    abs_script = Path(_resolve_script_path(script_path)).resolve()
    if not abs_script.exists():
        return None
    for base in (abs_script.parent.parent, abs_script.parent.parent.parent):
        candidate = (base / rel).resolve()
        if candidate.exists():
            return str(candidate)
    return None


def build_profiles_with_media_ids(
    profiles: List[dict],
    media_by_name_key: Dict[str, str],
) -> List[dict]:
    """Gắn reference_media_id tạm (in-memory) — không ghi file."""
    out: List[dict] = []
    for prof in profiles:
        if not isinstance(prof, dict):
            continue
        row = dict(prof)
        name = str(prof.get("name") or "").strip()
        key = _normalize_name_key(name)
        mid = ""
        if name and name in media_by_name_key:
            mid = str(media_by_name_key[name]).strip()
        elif key and key in media_by_name_key:
            mid = str(media_by_name_key[key]).strip()
        if mid:
            row["reference_media_id"] = mid
        out.append(row)
    return out


def lookup_media_id_for_character_name(
    token: str,
    media_map: Dict[str, str],
    profiles: List[dict],
) -> Optional[str]:
    """Đối chiếu 1 tên nhân vật (scene.character) với mapping profile hiện tại."""
    name = str(token or "").strip()
    if not name:
        return None

    if name in media_map:
        return str(media_map[name]).strip()

    key = _normalize_name_key(name)
    if key and key in media_map:
        return str(media_map[key]).strip()

    for profile in profiles:
        if not isinstance(profile, dict):
            continue
        pname = str(profile.get("name") or "").strip()
        if not pname:
            continue
        if name.casefold() == pname.casefold():
            mid = str(profile.get("reference_media_id") or "").strip()
            if mid:
                return mid
            pk = _normalize_name_key(pname)
            if pk in media_map:
                return str(media_map[pk]).strip()
    return None


def match_reference_media_ids_for_scene_characters(
    character_field: str,
    profiles: List[dict],
    media_map: Optional[Dict[str, str]] = None,
    *,
    max_refs: int = 3,
) -> List[str]:
    """
    Ưu tiên scene.character: giữ thứ tự tên, tối đa max_refs media_id.
    """
    tokens = parse_scene_character_field(character_field)
    if not tokens:
        return []

    mapping = dict(media_map or {})
    matched: List[str] = []
    seen: set[str] = set()

    for token in tokens:
        mid = lookup_media_id_for_character_name(token, mapping, profiles)
        if not mid or mid in seen:
            continue
        matched.append(mid)
        seen.add(mid)
        if len(matched) >= max_refs:
            break
    return matched


def match_reference_media_ids_for_prompt(
    prompt: str,
    profiles: List[dict],
    *,
    max_refs: int = 3,
) -> List[str]:
    """Fallback: quét tên profile trong prompt (khi scene.character trống)."""
    text = str(prompt or "")
    if not text.strip() or not profiles:
        return []

    text_key = _normalize_name_key(text)
    matched: List[str] = []
    seen: set[str] = set()

    for profile in profiles:
        if not isinstance(profile, dict):
            continue
        name = str(profile.get("name") or "").strip()
        media_id = str(profile.get("reference_media_id") or "").strip()
        if not name or not media_id:
            continue
        key = _normalize_name_key(name)
        if not key or key in seen:
            continue
        if key in text_key or name.upper() in text.upper():
            matched.append(media_id)
            seen.add(key)
            if len(matched) >= max_refs:
                break
    return matched


def log_profile_cast_media_mapping(
    profile_id: str,
    profiles: List[dict],
    media_map: Dict[str, str],
    *,
    log_prefix: str = "CastRef",
) -> None:
    """In bảng name -> media_id sau upload (chỉ profile hiện tại)."""
    ptag = str(profile_id or "")[-4:] or "????"
    print(f"[{log_prefix}] [{ptag}] 📋 Cast media mapping (profile này):")
    if not profiles:
        print("  (không có cast_profiles)")
        return
    for prof in profiles:
        if not isinstance(prof, dict):
            continue
        name = str(prof.get("name") or "").strip()
        if not name:
            continue
        mid = lookup_media_id_for_character_name(name, media_map, profiles)
        rel = str(prof.get("reference_image_url") or "").strip()
        print(f"  - {name!r} -> {mid or '(MISSING)'}  file={rel or '?'}")


def log_enriched_scene_cast_references(
    scene_tasks: List[Dict[str, Any]],
    *,
    log_prefix: str = "CastRef",
    profile_tag: str = "????",
) -> None:
    """In kế hoạch media_id theo từng scene sau enrich."""
    print(f"[{log_prefix}] [{profile_tag}] 📑 Reference plan theo scene:")
    for task in scene_tasks:
        if not isinstance(task, dict):
            continue
        sid = task.get("scene_id", "?")
        char_field = str(task.get("character") or "").strip()
        names = list(task.get("reference_input_names") or [])
        ids = [str(x) for x in (task.get("reference_media_ids") or []) if str(x or "").strip()]
        if not ids and not char_field:
            print(f"  scene={sid}: (không dùng cast ref / text-only)")
            continue
        if names and len(names) == len(ids):
            pairs = ", ".join(f"{n}={m}" for n, m in zip(names, ids))
            print(f"  scene={sid}: character={char_field!r} => [{pairs}]")
        elif ids:
            print(
                f"  scene={sid}: character={char_field!r} => "
                f"reference_media_ids={ids}"
            )
        else:
            print(
                f"  scene={sid}: character={char_field!r} => "
                "(MISSING — không map được media_id)"
            )


def enrich_scene_tasks_with_cast_references(
    scene_tasks: List[Dict[str, Any]],
    profiles: List[dict],
    *,
    media_map: Optional[Dict[str, str]] = None,
    log_prefix: Optional[str] = None,
    profile_tag: Optional[str] = None,
) -> None:
    """
    Gắn reference_media_ids cho từng scene task.
    Ưu tiên scene.character; fallback match prompt.
    """
    mapping = dict(media_map or {})
    for task in scene_tasks:
        char_field = str(task.get("character") or "").strip()
        ids: List[str] = []
        names: List[str] = []

        if char_field:
            ids = match_reference_media_ids_for_scene_characters(
                char_field,
                profiles,
                mapping,
            )
            names = parse_scene_character_field(char_field)

        if not ids:
            prompt = str(
                task.get("prompt")
                or task.get("video_prompt")
                or task.get("image_prompt")
                or ""
            ).strip()
            ids = match_reference_media_ids_for_prompt(prompt, profiles)

        if ids:
            task["reference_media_ids"] = ids
            if names:
                task["reference_input_names"] = names[: len(ids)]

    if log_prefix:
        log_enriched_scene_cast_references(
            scene_tasks,
            log_prefix=log_prefix,
            profile_tag=profile_tag or "????",
        )


async def resolve_cast_reference_media_for_profile(
    page: Any,
    script_path: str,
    *,
    profile_id: str,
    project_id: str,
    access_token: str,
    cache: Optional[Dict[str, str]] = None,
    log_prefix: str = "VEO Image API",
) -> Tuple[Dict[str, str], Optional[str]]:
    """
    Mỗi profile upload batch 1 lần (nếu chưa có cache đủ key).
    Trả về dict (display name + normalized key) -> media_id riêng profile này.
    """
    ptag = profile_id[-4:]
    profiles, load_err = load_cast_profiles_from_script(script_path)
    if load_err:
        return {}, load_err

    # Merge: caller cache + singleton theo profile_id (không dùng chung giữa profile).
    media_by_key: Dict[str, str] = profile_cast_media_cache.get_mapping(profile_id)
    if cache:
        media_by_key.update(dict(cache))

    pending: List[Tuple[str, str, str]] = []  # name_key, display_name, abs_path

    for prof in profiles:
        if not isinstance(prof, dict):
            continue
        name = str(prof.get("name") or "").strip()
        if not name:
            continue
        rel = str(prof.get("reference_image_url") or "").strip()
        if not rel:
            continue
        name_key = _normalize_name_key(name)
        if not name_key:
            continue
        if media_by_key.get(name_key) or media_by_key.get(name):
            continue
        abs_path = resolve_reference_image_abs(script_path, rel)
        if not abs_path:
            return media_by_key, f"missing_reference_file:{name}"
        pending.append((name_key, name, abs_path))

    if not pending:
        profile_cast_media_cache.merge_mapping(profile_id, media_by_key)
        log_profile_cast_media_mapping(
            profile_id, profiles, media_by_key, log_prefix=log_prefix
        )
        return media_by_key, None

    current_auth = load_veo_auth_config(profile_id) or {}
    current_access_token = str(current_auth.get("access_token") or access_token)
    current_project_id = str(current_auth.get("projectId") or project_id)

    paths = [p[2] for p in pending]
    print(
        f"[{log_prefix}] [{ptag}] 📤 Upload {len(paths)} ảnh nhân vật SONG SONG "
        f"(profile riêng, không ghi JSON)..."
    )

    mapping = await batch_upload_images_parallel(
        page,
        paths,
        current_project_id,
        current_access_token,
    )

    filename_to_media: Dict[str, str] = {}
    for mid, fname in (mapping or {}).items():
        if mid and fname:
            filename_to_media[str(fname).lower()] = str(mid)

    for name_key, display_name, abs_path in pending:
        fname = Path(abs_path).name.lower()
        mid = filename_to_media.get(fname)
        if not mid:
            return media_by_key, f"reference_upload_failed:{display_name}"
        media_by_key[name_key] = mid
        media_by_key[display_name] = mid
        print(
            f"[{log_prefix}] [{ptag}] 🖼️ {display_name}: {fname} -> {mid}"
        )

    profile_cast_media_cache.merge_mapping(profile_id, media_by_key)
    log_profile_cast_media_mapping(
        profile_id, profiles, media_by_key, log_prefix=log_prefix
    )
    return media_by_key, None
