"""Chat endpoint — forwards messages to 9Router (OpenAI-compatible API).
Also intercepts /fk:* skill commands and executes them directly.
Injects CLAUDE.md system prompt so LLM behaves like Claude CLI SDK.
All requests include FlowKit API tools so the LLM can execute API calls.
"""
import logging
import os
from pathlib import Path
from typing import AsyncGenerator

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse, JSONResponse
from openai import AsyncOpenAI
from engine.services.skill_executor import (
    detect_skill_command,
    execute_skill,
    list_skills as get_all_skills,
    SkillContentResult,
)
from engine.api.tool_executor import run_tool_loop_stream, FLOWKIT_TOOLS

logger = logging.getLogger(__name__)
router = APIRouter()

# 9Router base URL (configurable via env)
ROUTER_HOST = os.environ.get("ROUTER_HOST", "127.0.0.1")
ROUTER_PORT = int(os.environ.get("ROUTER_PORT", "20128"))
ROUTER_BASE = f"http://{ROUTER_HOST}:{ROUTER_PORT}"
ROUTER_API_KEY = os.environ.get("ROUTER_API_KEY", "")

# ── System prompt (loaded once, cached) ──────────────────────────────────

_PROJECT_ROOT = Path(__file__).parent.parent.parent
_system_prompt_cache: str | None = None


def _build_system_prompt() -> str:
    """Build system prompt from CLAUDE.md + AGENTS.md + skill list."""
    global _system_prompt_cache
    if _system_prompt_cache:
        return _system_prompt_cache

    parts = []

    claude_md = _PROJECT_ROOT / "CLAUDE.md"
    if claude_md.exists():
        parts.append(claude_md.read_text(encoding="utf-8").strip())

    agents_md = _PROJECT_ROOT / "AGENTS.md"
    if agents_md.exists():
        parts.append(agents_md.read_text(encoding="utf-8").strip())

    skills = get_all_skills()
    if skills:
        skill_lines = ["## Available Skills (auto-detected)\n"]
        skill_lines.append("Guide users to the right `/fk-*` command.\n")
        for s in skills:
            usage = s.get("usage") or f"/fk-{s['name']}"
            skill_lines.append(f"- `{usage}`")
        parts.append("\n".join(skill_lines))

    parts.append("""## ChatUI Behavior

You are the FlowKit assistant in the browser extension side panel.
- You have the `flowkit_api` tool to call FlowKit API at http://127.0.0.1:8100.
- When the user provides enough input, USE THE TOOL to execute API calls. Do NOT just describe what to do.
- Keep responses concise. Respond in the user's language.
- After creating resources, show a summary table with IDs.

### Standard API Structure & Rules
Do NOT guess API structures. Always use these exact endpoint patterns:
- `GET /openapi.json` — Read the complete and exact API schema if you are unsure about any payload or parameter.
- `GET /api/projects` | `POST /api/projects` | `PATCH /api/projects/{id}` | `DELETE /api/projects/{id}`
- `GET /api/videos?project_id={id}` | `POST /api/videos` | `PATCH /api/videos/{id}`
- `GET /api/scenes?video_id={id}` — **Requires** `video_id` in query. Do NOT use `project_id` or nested paths.
- `POST /api/scenes` — **Requires** `video_id` in the JSON body.
- `POST /api/requests/batch` — Submit a list of generation tasks (`type`, `project_id`, `video_id`, `scene_id`, `orientation`).
- `GET /api/requests/batch-status?project_id={pid}&type={type}` — Check the status of generation tasks.
- `POST /api/materials` — **Requires** `id` (material name) in the JSON body.

If you ever receive an HTTP 422 or 404 error, immediately call `GET /openapi.json` to correct your assumptions before proceeding.""")

    _system_prompt_cache = "\n\n---\n\n".join(parts)
    return _system_prompt_cache


def invalidate_system_prompt_cache():
    """Call when skills or config change to rebuild the prompt."""
    global _system_prompt_cache
    _system_prompt_cache = None


# ── Chat endpoint ────────────────────────────────────────────────────────

@router.post("/chat")
async def chat(request: Request):
    """Forward chat to 9Router with FlowKit tools and system context. NDJSON streaming."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)

    messages = body.get("messages", [])
    project_id = body.get("project_id")
    session_id = body.get("session_id")
    model = body.get("model", "")
    if not model:
        from engine.api.models import get_default_chat_model
        model = await get_default_chat_model()

    if not messages:
        return JSONResponse({"error": "messages is required"}, status_code=400)

    # ── Find last user message ────────────────────────────────────────────
    user_text = ""
    for msg in reversed(messages):
        if isinstance(msg, dict) and msg.get("role") == "user":
            user_text = (msg.get("content") or "").strip()
            break

    # Persist user message if project_id is present
    if project_id and user_text:
        from engine.db.crud import create_chat_message, create_chat_session
        if not session_id:
            title = user_text[:40] + ("..." if len(user_text) > 40 else "")
            sess = await create_chat_session(project_id, title)
            session_id = sess["id"]
        await create_chat_message(project_id, session_id, "user", user_text)

    # Handle skill list query
    if user_text in ("/fk", "/fk-list"):
        skills = get_all_skills()
        out = ["**Available FlowKit skills:**\n"]
        for s in skills:
            out.append(f"  • `{s['usage'] or s['name']}`")
        import json
        
        async def stream_skills():
            yield json.dumps({"type": "content", "content": "\n".join(out)}) + "\n"
            yield json.dumps({"type": "done", "session_id": session_id}) + "\n"
            
        return StreamingResponse(stream_skills(), media_type="application/x-ndjson")

    # ── Skill command interception ────────────────────────────────────────
    skill_cmd = detect_skill_command(user_text)
    if skill_cmd:
        skill_name, skill_args = skill_cmd
        logger.info("Intercepted skill: /fk-%s args=%r", skill_name, skill_args)
        import json
        try:
            result = await execute_skill(skill_name, skill_args)
        except Exception as e:
            logger.exception("Skill execution failed: %s", e)
            async def stream_error():
                yield json.dumps({"type": "error", "content": f"Skill error: {e}"}) + "\n"
                yield json.dumps({"type": "done", "session_id": session_id}) + "\n"
            return StreamingResponse(stream_error(), media_type="application/x-ndjson")

        # Python-handled skill → return result directly
        if isinstance(result, str):
            async def stream_str():
                yield json.dumps({"type": "content", "content": result}) + "\n"
                if project_id and session_id:
                    from engine.db.crud import create_chat_message
                    await create_chat_message(project_id, session_id, "assistant", result)
                yield json.dumps({"type": "done", "session_id": session_id}) + "\n"
            return StreamingResponse(stream_str(), media_type="application/x-ndjson")

        # LLM-orchestrated skill → inject skill content + run with tools
        if isinstance(result, SkillContentResult):
            logger.info("LLM skill: %s (%d chars)", result.name, len(result.content))
            skill_instruction = (
                f"The user invoked `/{result.name}`. "
                f"Follow the instructions below. "
                f"Use the flowkit_api tool to execute API calls — do NOT just describe them.\n\n"
                f"---\n\n{result.content}"
            )
            augmented = [
                {"role": "system", "content": _build_system_prompt() + "\n\n---\n\n" + skill_instruction},
                *[m for m in messages if isinstance(m, dict) and m.get("role") != "system"],
            ]
            return StreamingResponse(
                _chat_with_tools_stream(augmented, model, project_id, session_id),
                media_type="application/x-ndjson"
            )

    # ── Regular chat with tool support ────────────────────────────────────
    system_prompt = _build_system_prompt()
    
    # ── Inject Project Context & DB History ──────────────────────────────
    db_history = []
    if project_id:
        from engine.sdk.persistence.sqlite_repository import SQLiteRepository
        from engine.db.crud import list_chat_messages
        repo = SQLiteRepository()
        p = await repo.get_project(project_id)
        if p:
            chars = await repo.get_project_characters(project_id)
            vids = await repo.list_videos(project_id)
            proj_context = f"Project Context:\nID: {p.id}\nName: {p.name}\nStory: {p.story or ''}\n"
            proj_context += f"Total Characters: {len(chars)}\nTotal Videos: {len(vids)}\n"
            
            context_data = body.get("context", {})
            if context_data:
                proj_context += "\nUser UI Configuration (apply these when creating resources):\n"
                proj_context += f"- Intended Orientation: {context_data.get('pipelineOrientation', 'UNKNOWN')}\n"
                config_data = context_data.get('config', {})
                proj_context += f"- Target Videos Count: {config_data.get('videosCount')}\n"
                proj_context += f"- Scenes per Video: {config_data.get('scenesPerVideo')}\n"
                
            system_prompt += "\n\n" + proj_context
            
        # Load history
        if session_id:
            hist = await list_chat_messages(session_id, limit=30) # last 30 messages
            db_history = [{"role": m["role"], "content": m["content"]} for m in hist]

    augmented = []
    augmented.append({"role": "system", "content": system_prompt})
    
    if project_id:
        augmented.extend(db_history)
    else:
        # If no project_id, just use the messages from the request
        for m in messages:
            if isinstance(m, dict) and m.get("role") != "system":
                augmented.append(m)

    return StreamingResponse(
        _chat_with_tools_stream(augmented, model, project_id, session_id),
        media_type="application/x-ndjson"
    )


async def _chat_with_tools_stream(messages: list, model: str, project_id: str | None, session_id: str | None):
    """Send messages to LLM with FlowKit tools. Yields NDJSON stream chunks."""
    import json
    try:
        # Initialize OpenAI client pointing to 9Router
        client = AsyncOpenAI(
            base_url=f"{ROUTER_BASE}/v1",
            api_key=ROUTER_API_KEY or "no-key",
        )

        logger.info("Chat+tools stream: model=%s msg_count=%d", model, len(messages))

        async for chunk in run_tool_loop_stream(messages, model, client):
            try:
                event = json.loads(chunk)
                if event.get("type") == "internal_done":
                    # DB persistence
                    if project_id and session_id and event.get("final_text"):
                        from engine.db.crud import create_chat_message
                        await create_chat_message(project_id, session_id, "assistant", event["final_text"])
                    # Send public done event
                    yield json.dumps({"type": "done", "session_id": session_id}) + "\n"
                else:
                    yield chunk
            except json.JSONDecodeError:
                yield chunk

    except Exception as e:
        logger.error("9Router connection error: %s", e)
        yield json.dumps({"type": "error", "content": f"Cannot connect to 9Router: {e}"}) + "\n"
        yield json.dumps({"type": "done", "session_id": session_id}) + "\n"

@router.get("/skills")
async def get_skills_endpoint():
    """List all available FlowKit skill commands."""
    return get_all_skills()
