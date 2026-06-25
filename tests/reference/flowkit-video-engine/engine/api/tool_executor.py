"""Tool executor for LLM-orchestrated skills.

Provides a single `flowkit_api` tool that the LLM can call to interact
with the FlowKit API (create projects, videos, scenes, etc.).

Implements an agentic tool-calling loop: send messages+tools to LLM,
execute any tool_calls, append results, repeat until LLM returns text.
"""
import json
import logging

import httpx

from engine.config import API_HOST, API_PORT

logger = logging.getLogger(__name__)

FLOWKIT_API_BASE = f"http://{API_HOST}:{API_PORT}"

# OpenAI-compatible tool definitions
FLOWKIT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "flowkit_api",
            "description": (
                "Execute a FlowKit API call. Use this to create projects, "
                "videos, scenes, generate images/videos, and check status. "
                "The server is at http://127.0.0.1:8100."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PATCH", "DELETE"],
                    },
                    "path": {
                        "type": "string",
                        "description": (
                            "API path e.g. /health, /api/projects, "
                            "/api/videos, /api/scenes, /api/materials"
                        ),
                    },
                    "body": {
                        "type": "string",
                        "description": "JSON encoded string of the request body for POST/PATCH. Must be a valid JSON string. Example: '{\"name\": \"My Project\", \"story\": \"...\"}'",
                    },
                },
                "required": ["method", "path"],
            },
        },
    }
]


async def execute_tool_call(name: str, arguments: dict) -> str:
    """Execute a single tool call and return result as JSON string."""
    if name != "flowkit_api":
        return json.dumps({"error": f"Unknown tool: {name}"})

    method = arguments.get("method", "GET").upper()
    path = arguments.get("path", "")
    
    body_raw = arguments.get("body")
    body = {}
    if body_raw:
        if isinstance(body_raw, str):
            try:
                body = json.loads(body_raw)
            except json.JSONDecodeError:
                return json.dumps({"error": "body must be a valid JSON string"})
        elif isinstance(body_raw, dict):
            body = body_raw
    url = f"{FLOWKIT_API_BASE}{path}"

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            if method == "GET":
                r = await client.get(url)
            elif method == "POST":
                r = await client.post(url, json=body or {})
            elif method == "PATCH":
                r = await client.patch(url, json=body or {})
            elif method == "DELETE":
                r = await client.delete(url)
            else:
                return json.dumps({"error": f"Unsupported method: {method}"})

            r.raise_for_status()
            
            data = r.json()
            # Workaround for Gemini API bug: Gemini backend crashes if function_response contains "$ref" keys
            def _clean_refs(obj):
                if isinstance(obj, dict):
                    if "$ref" in obj:
                        obj["_ref"] = obj.pop("$ref")
                    for v in obj.values():
                        _clean_refs(v)
                elif isinstance(obj, list):
                    for i in obj:
                        _clean_refs(i)
                        
            _clean_refs(data)
            return json.dumps(data, ensure_ascii=False)
        except httpx.HTTPStatusError as e:
            detail = e.response.text[:500] if e.response else ""
            return json.dumps({"error": f"HTTP {e.response.status_code}", "detail": detail})
        except Exception as e:
            return json.dumps({"error": str(e)})


async def run_tool_loop_stream(
    messages: list,
    model: str,
    client,
    max_rounds: int = 15,
):
    """Agentic tool-calling loop (streaming).

    Sends messages+tools to the LLM (via 9Router). Streams NDJSON back.
    If the LLM responds with tool_calls, executes them and loops.
    """
    current = list(messages)

    for round_num in range(max_rounds):
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=current,
                tools=FLOWKIT_TOOLS,
                stream=True,
            )
        except Exception as e:
            yield json.dumps({"type": "error", "content": str(e)}) + "\n"
            return

        tool_calls = {}
        content_buffer = ""
        
        async for chunk in response:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                yield json.dumps({"type": "content", "content": delta.content}) + "\n"
                content_buffer += delta.content
                
            if delta.tool_calls:
                for tc in delta.tool_calls:
                    if tc.index not in tool_calls:
                        tool_calls[tc.index] = {"id": tc.id or "", "function": {"name": "", "arguments": ""}}
                    if tc.function.name:
                        tool_calls[tc.index]["function"]["name"] += tc.function.name
                    if tc.function.arguments:
                        tool_calls[tc.index]["function"]["arguments"] += tc.function.arguments

        # Convert accumulated tool calls dictionary to a list
        tc_list = [tc for i, tc in sorted(tool_calls.items())]
        
        # Build the message dict to append to our history
        msg_dump = {"role": "assistant"}
        if content_buffer:
            msg_dump["content"] = content_buffer
        else:
            msg_dump["content"] = None
            
        if tc_list:
            api_tc_list = []
            for tc in tc_list:
                api_tc_list.append({
                    "id": tc["id"],
                    "type": "function",
                    "function": tc["function"]
                })
            msg_dump["tool_calls"] = api_tc_list
            
        current.append(msg_dump)

        if not tc_list:
            break
            
        # Execute each tool call
        for tc in tc_list:
            fn_name = tc["function"]["name"]
            args_str = tc["function"]["arguments"]
            
            yield json.dumps({"type": "tool_call", "name": fn_name, "arguments": args_str}) + "\n"
            
            try:
                args = json.loads(args_str)
            except json.JSONDecodeError:
                args = {}

            result = await execute_tool_call(fn_name, args)
            logger.info(
                "Tool[%d]: %s %s → %s",
                round_num, args.get("method", "?"), args.get("path", "?"),
                result[:200],
            )
            
            yield json.dumps({"type": "tool_result", "name": fn_name, "content": result}) + "\n"

            current.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result,
            })

    # Return final accumulated content for saving to DB
    # We collect the text from all assistant messages in the loop that have text
    final_text = ""
    for m in current[len(messages):]:
        if m.get("role") == "assistant" and m.get("content"):
            final_text += m["content"]
            
    yield json.dumps({"type": "internal_done", "final_text": final_text}) + "\n"
