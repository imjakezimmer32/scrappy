"""Relay mic/text to local-voice work-only sidecar (Whisper + tools, no Kokoro)."""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Awaitable, Callable

import websockets

WORK_WS = (os.environ.get("SCRAPPY_LOCAL_WORK_WS") or "ws://127.0.0.1:8790/v1/voice").strip()


class LocalWorkRelay:
    def __init__(self, on_message: Callable[[dict[str, Any]], Awaitable[None]]):
        self._on_message = on_message
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._pump: asyncio.Task | None = None
        self._ready = False

    @property
    def connected(self) -> bool:
        return self._ws is not None and self._ready

    async def connect(self) -> bool:
        if self._ws:
            return self._ready
        try:
            self._ws = await websockets.connect(WORK_WS, max_size=2**22)
        except Exception:
            self._ws = None
            return False
        self._pump = asyncio.create_task(self._pump_loop())
        deadline = time.monotonic() + 120.0
        while not self._ready and time.monotonic() < deadline:
            await asyncio.sleep(0.25)
        return self._ready

    async def close(self) -> None:
        if self._pump:
            self._pump.cancel()
            self._pump = None
        if self._ws:
            try:
                await self._ws.send(json.dumps({"type": "end"}))
            except Exception:
                pass
            await self._ws.close()
        self._ws = None
        self._ready = False

    async def forward(self, msg: dict[str, Any]) -> None:
        if not self._ws:
            return
        try:
            await self._ws.send(json.dumps(msg))
        except Exception:
            pass

    async def _pump_loop(self) -> None:
        assert self._ws
        try:
            while True:
                raw = await self._ws.recv()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if msg.get("type") == "ready":
                    self._ready = True
                if msg.get("type") in ("executive", "user_transcript", "job", "status"):
                    await self._on_message(msg)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass
