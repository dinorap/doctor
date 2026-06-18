"""Model configuration API — view and update video/image/upscale model keys + chat AI models."""
import json
import logging
import os
from pathlib import Path

import httpx
from fastapi import APIRouter

from agent import config

router = APIRouter(prefix="/api/models", tags=["models"])
logger = logging.getLogger(__name__)

ROUTER_HOST = os.environ.get("ROUTER_HOST", "127.0.0.1")
ROUTER_PORT = int(os.environ.get("ROUTER_PORT", "20128"))
ROUTER_BASE = f"http://{ROUTER_HOST}:{ROUTER_PORT}"

_MODELS_FILE = Path(__file__).parent.parent / "models.json"


def _read_models() -> dict:
    with open(_MODELS_FILE) as f:
        return json.load(f)


def _write_models(data: dict):
    with open(_MODELS_FILE, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def _reload_config(data: dict):
    """Hot-reload model keys into the running config module."""
    config.VIDEO_MODELS.clear()
    config.VIDEO_MODELS.update(data["video_models"])
    config.UPSCALE_MODELS.clear()
    config.UPSCALE_MODELS.update(data["upscale_models"])
    config.IMAGE_MODELS.clear()
    config.IMAGE_MODELS.update(data["image_models"])


@router.get("")
async def get_models():
    """Return current model configuration."""
    return _read_models()


@router.patch("")
async def patch_models(body: dict):
    """Update model keys. Merges provided keys into existing config.

    Example body to change video model for TIER_TWO i2v portrait:
    {
      "video_models": {
        "PAYGATE_TIER_TWO": {
          "frame_2_video": {
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_fast_portrait_ultra"
          }
        }
      }
    }
    """
    current = _read_models()

    # Deep merge: only update keys that are provided
    for section in ("video_models", "image_models", "upscale_models"):
        if section not in body:
            continue
        if section == "upscale_models" or section == "image_models":
            # Flat dict — direct merge
            current[section].update(body[section])
        else:
            # Nested dict — merge per tier, per gen_type
            for tier, gen_types in body[section].items():
                if tier not in current[section]:
                    current[section][tier] = {}
                for gen_type, ratios in gen_types.items():
                    if gen_type not in current[section][tier]:
                        current[section][tier][gen_type] = {}
                    current[section][tier][gen_type].update(ratios)

    _write_models(current)
    _reload_config(current)
    logger.info("Models updated and hot-reloaded: %s", list(body.keys()))

    return {"status": "updated", "models": current}


# ─── Chat AI Models (from 9Router) ───────────────────────────

_9ROUTER_API_KEY = os.environ.get("ROUTER_API_KEY", "")

# Lazy-loaded at runtime
_cached_chat_models: list | None = None


def _router_headers() -> dict:
    if _9ROUTER_API_KEY:
        return {"Authorization": f"Bearer {_9ROUTER_API_KEY}"}
    return {}


async def _get_all_ai_models() -> list:
    """Fetch full AI_MODELS list from 9Router /api/models."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{ROUTER_BASE}/api/models", headers=_router_headers())
            resp.raise_for_status()
            return resp.json().get("models", [])
    except Exception:
        return []


async def _get_active_provider_codes() -> set:
    """
    Map active provider connections to model provider codes.

    9Router stores connection names (e.g. "codex") in the connections list,
    but model entries use internal codes (e.g. "cx" for OpenAI Codex).
    We resolve this by:
      1. Fetching the full model list to know which codes exist
      2. Fetching active connections
      3. For each connection, checking if its name/authType matches a known code
    """
    all_models = await _get_all_ai_models()
    available_codes = {m["provider"] for m in all_models}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(f"{ROUTER_BASE}/api/providers", headers=_router_headers())
            resp.raise_for_status()
            connections = resp.json().get("connections", [])
    except Exception:
        return available_codes

    result = set()
    for conn in connections:
        if not conn.get("isActive"):
            continue
        provider_name = conn.get("provider", "")
        auth_type = conn.get("authType", "")
        # Direct match
        if provider_name in available_codes:
            result.add(provider_name)
            continue
        # Auth-type based mapping (9Router convention: "oauth" + name hint → code)
        if auth_type == "oauth" and provider_name == "codex":
            # OpenAI Codex CLI → "cx"
            result.add("cx")
        elif auth_type == "oauth" and provider_name in available_codes:
            result.add(provider_name)

    # If nothing resolved, fall back to all available codes (keyed endpoints)
    if not result:
        return available_codes
    return result


@router.get("/chat")
async def get_chat_models():
    """Fetch available chat models from 9Router (filtered by active provider connections)."""
    active_codes = await _get_active_provider_codes()
    all_models = await _get_all_ai_models()

    available = [m for m in all_models if m.get("provider") in active_codes]

    return {
        "models": available,
        "active_codes": list(active_codes),
        "total": len(available),
    }


async def get_default_chat_model() -> str:
    """Helper to dynamically resolve the default model.
    Updated to use the custom 9Router combo 'my-route-combo' for automatic provider fallback.
    """
    return os.environ.get("DEFAULT_CHAT_MODEL", "my-route-combo")
