"""WebSocket endpoint streaming engine events to the GUI."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

ws_router = APIRouter()


@ws_router.websocket("/ws")
async def event_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    hub = websocket.app.state.hub
    queue = hub.subscribe()
    try:
        while True:
            event = await queue.get()
            await websocket.send_text(json.dumps(event))
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.debug("websocket event stream closed", exc_info=True)
    finally:
        hub.unsubscribe(queue)
