"""Thread-safe WebSocket broadcast hub.

Engine workers run on plain threads; ``publish`` may be called from any
thread and is marshalled onto the server's event loop so websocket
handlers can await the events as asyncio queues.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

_QUEUE_MAX = 500


class EventHub:
    """Fan-out event bus: one queue per connected websocket client."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._loop: asyncio.AbstractEventLoop | None = None

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Capture the server loop (called once at app startup)."""
        self._loop = loop

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_QUEUE_MAX)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self._subscribers.discard(queue)

    def publish(self, event: dict[str, Any]) -> None:
        """Broadcast ``event`` to every subscriber; safe from any thread."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._broadcast, event)
        except RuntimeError:
            # Loop shutting down while a worker was still finishing.
            pass

    def _broadcast(self, event: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # Slow client: drop the oldest event rather than block the run.
                try:
                    queue.get_nowait()
                    queue.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass
