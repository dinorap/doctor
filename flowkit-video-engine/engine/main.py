"""Flow Kit Video Engine — FastAPI + WebSocket server entry point."""
import asyncio
import json
import logging
import sys
from contextlib import asynccontextmanager

import websockets
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from engine.config import API_HOST, API_PORT, WS_HOST, WS_PORT
from engine.db.schema import init_db, close_db
from engine.api.projects import router as projects_router
from engine.api.videos import router as videos_router
from engine.api.scenes import router as scenes_router
from engine.api.requests import router as requests_router
from engine.api.flow import router as flow_router
from engine.api.reviews import router as reviews_router
from engine.api.materials import router as materials_router
from engine.api.models import router as models_router
from engine.api.characters import router as characters_router
from engine.api.library import router as library_router
from engine.worker.processor import get_worker_controller
from engine.services.flow_client import get_flow_client
from engine.services.event_bus import event_bus
from engine.sdk import init_sdk

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger(__name__)

logging.getLogger("websockets.server").setLevel(logging.CRITICAL)


async def ws_handler(websocket):
    """Handle a Chrome extension WebSocket connection."""
    client = get_flow_client()
    client.set_extension(websocket)
    logger.info("Extension connected from %s", websocket.remote_address)

    await websocket.send(json.dumps({"type": "callback_secret", "secret": _CALLBACK_SECRET}))

    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
                await client.handle_message(data)
            except json.JSONDecodeError:
                logger.warning("Invalid JSON from extension")
            except Exception as e:
                logger.exception("Error handling extension message: %s", e)
    except websockets.ConnectionClosed:
        pass
    finally:
        client.clear_extension()
        logger.info("Extension disconnected")


async def run_ws_server():
    """Run WebSocket server for extension connections."""
    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        logger.info("WebSocket server listening on ws://%s:%d", WS_HOST, WS_PORT)
        await asyncio.Future()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()

    from engine.db.crud import list_materials as db_list_materials
    from engine.materials import register_material, _BUILTIN_IDS
    try:
        custom_materials = await db_list_materials()
        for m in custom_materials:
            if m["id"] not in _BUILTIN_IDS:
                register_material(m)
                logger.info("Loaded custom material from DB: %s", m["id"])
    except Exception as e:
        logger.warning("Failed to load custom materials: %s", e)

    ops = init_sdk(get_flow_client())
    logger.info("SDK initialized")

    controller = get_worker_controller()

    if sys.platform != "win32":
        import signal
        loop = asyncio.get_event_loop()
        loop.add_signal_handler(signal.SIGTERM, controller.request_shutdown)

    ws_task = asyncio.create_task(run_ws_server())
    worker_task = asyncio.create_task(controller.start())
    logger.info("WS server + worker started")

    yield

    controller.request_shutdown()
    await controller.drain()
    ws_task.cancel()
    worker_task.cancel()
    await close_db()
    logger.info("Flow Kit Video Engine stopped")


app = FastAPI(title="Flow Kit Video Engine", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects_router, prefix="/api")
app.include_router(videos_router, prefix="/api")
app.include_router(scenes_router, prefix="/api")
app.include_router(requests_router, prefix="/api")
app.include_router(flow_router, prefix="/api")
app.include_router(reviews_router, prefix="/api")
app.include_router(materials_router, prefix="/api")
app.include_router(models_router)
app.include_router(characters_router, prefix="/api")
app.include_router(library_router, prefix="/api")


import secrets as _secrets
_CALLBACK_SECRET = _secrets.token_urlsafe(32)


@app.post("/api/ext/callback")
async def ext_callback(request: Request):
    """HTTP callback for extension to deliver API responses."""
    data = await request.json()
    client = get_flow_client()
    req_id = data.get("id")
    logger.info("ext/callback: id=%s pending=%d match=%s",
                str(req_id)[:8] if req_id else "none",
                len(client._pending),
                "yes" if req_id and req_id in client._pending else "no")
    if req_id and req_id in client._pending:
        future = client._pending[req_id]
        try:
            future.set_result(data)
        except asyncio.InvalidStateError:
            pass
        return {"ok": True}
    return {"ok": False, "reason": "no matching pending request"}


@app.get("/health")
async def health():
    client = get_flow_client()
    return {
        "status": "ok",
        "version": "0.2.0",
        "extension_connected": client.connected,
        "ws": client.ws_stats,
    }


if __name__ == "__main__":
    import os
    import uvicorn
    reload_enabled = os.environ.get("GLA_RELOAD", "0") == "1"
    uvicorn.run(
        "engine.main:app",
        host=API_HOST,
        port=API_PORT,
        reload=reload_enabled,
        reload_excludes=["*.db", "*.db-wal", "*.db-shm", "output/*"],
        access_log=False,
    )
