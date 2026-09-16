"""ASGI app factory + entry point for the local GUI API server.

Run with::

    python -m quill_engine.api.server [--port 8765]

The server binds loopback only. Defaults are tuned for the desktop app:
the disk store (projects survive restarts) and instant export/preview
(no implicit LLM rewrites — the GUI triggers rewrites explicitly). Both
can be overridden per ``create_app`` call; ``store``/``engine`` are
injectable for tests.
"""

from __future__ import annotations

import argparse
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .. import config, orchestrator
from ..opensearch_store import JsonFileStore
from .events import EventHub
from .routes import api_router
from .state import Registry, RunManager
from .ws import ws_router


@asynccontextmanager
async def _lifespan(app: FastAPI):
    import asyncio

    app.state.hub.attach_loop(asyncio.get_running_loop())
    yield


def create_app(
    *,
    store=None,
    engine=None,
    hub: EventHub | None = None,
    instant_export: bool = True,
) -> FastAPI:
    """Build the API app.

    ``instant_export`` disables the export-time rewrite cascade
    (``config.EXPORT_REWRITE_SECTIONS``) so preview/export never spawns
    hidden LLM work; the GUI drives rewrites through /run and /rewrite.
    ``store`` defaults to the disk-backed ``JsonFileStore`` unless
    ``QUILL_STORE`` selects an explicit backend.
    """
    if store is None:
        store = (
            JsonFileStore()
            if config.STORE_BACKEND == "memory"
            else orchestrator.new_store()
        )
    engine = engine if engine is not None else orchestrator
    hub = hub if hub is not None else EventHub()
    config.EXPORT_REWRITE_SECTIONS = not instant_export

    app = FastAPI(title="quill_engine", version="1", lifespan=_lifespan)
    app.add_middleware(
        CORSMiddleware,
        # Loopback-only server; the Electron renderer and the Vite dev
        # server both hit it from localhost origins.
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.hub = hub
    app.state.registry = Registry(store=store, engine=engine)
    app.state.runs = RunManager(store=store, engine=engine, hub=hub)

    app.include_router(api_router)
    app.include_router(ws_router)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="quill_engine GUI API server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    import uvicorn

    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
