"""
Scrappy ↔ PersonaPlex bridge.

Exposes the same JSON WebSocket protocol as local-voice so Electron stays unchanged.
Talks binary Opus (0x01 / 0x02) to moshi.server on WSS.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import ssl
import struct
import urllib.parse
from typing import Any

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn
import websockets

from local_work import LocalWorkRelay
from work_dispatch import dispatch_work, local_work_available

HOST = os.environ.get("SCRAPPY_PERSONAPLEX_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("SCRAPPY_PERSONAPLEX_BRIDGE_PORT", "8792"))
MOSHI_HOST = os.environ.get("SCRAPPY_PERSONAPLEX_HOST", "127.0.0.1")
MOSHI_PORT = int(os.environ.get("SCRAPPY_PERSONAPLEX_PORT", "8998"))
SERVER_URL = (os.environ.get("PERSONAPLEX_SERVER_URL") or "").strip().rstrip("/")
VOICE_PROMPT = os.environ.get("PERSONAPLEX_VOICE_PROMPT", "NATM1.pt")
TEXT_PROMPT = os.environ.get("PERSONAPLEX_TEXT_PROMPT", "")
SAMPLE_IN = 16000
SAMPLE_OUT = 24000

app = FastAPI(title="Scrappy PersonaPlex Bridge")

_opus_ok = False
_opus_err = ""


def _check_opus() -> None:
    global _opus_ok, _opus_err
    try:
        import av  # noqa: F401

        _opus_ok = True
        _opus_err = ""
    except Exception as err:  # noqa: BLE001
        _opus_ok = False
        _opus_err = str(err)


_check_opus()


def pcm16_b64_to_float32(b64: str, rate: int) -> np.ndarray:
    raw = base64.b64decode(b64)
    if len(raw) < 2:
        return np.zeros(0, dtype=np.float32)
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if rate == SAMPLE_OUT:
        return samples
    if rate == SAMPLE_IN:
        # Linear resample 16k → 24k
        if samples.size == 0:
            return samples
        ratio = SAMPLE_OUT / SAMPLE_IN
        out_len = int(samples.size * ratio)
        x = np.arange(samples.size, dtype=np.float32)
        xi = np.linspace(0, samples.size - 1, out_len, dtype=np.float32)
        return np.interp(xi, x, samples).astype(np.float32)
    return samples


def float32_to_pcm16_b64(audio: np.ndarray, rate: int = SAMPLE_OUT) -> str:
    clipped = np.clip(audio, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    return base64.b64encode(pcm.tobytes()).decode("ascii")


def encode_opus_frames(pcm_f32_24k: np.ndarray) -> list[bytes]:
    import av

    if pcm_f32_24k.size == 0:
        return []
    container = av.AudioFrame.from_ndarray(
        (pcm_f32_24k * 32767).astype(np.int16).reshape(1, -1), format="s16", layout="mono"
    )
    container.sample_rate = SAMPLE_OUT
    out: list[bytes] = []
    # Simple frame chunk ~20ms
    frame_samples = int(SAMPLE_OUT * 0.02)
    for i in range(0, pcm_f32_24k.size, frame_samples):
        chunk = pcm_f32_24k[i : i + frame_samples]
        if chunk.size == 0:
            continue
        frame = av.AudioFrame.from_ndarray(
            (chunk * 32767).astype(np.int16).reshape(1, -1), format="s16", layout="mono"
        )
        frame.sample_rate = SAMPLE_OUT
        # Opus encode via codec context
        ctx = av.codec.CodecContext.create("libopus", "w")
        ctx.sample_rate = SAMPLE_OUT
        ctx.layout = "mono"
        ctx.format = "s16"
        ctx.time_base = f"1/{SAMPLE_OUT}"
        for packet in ctx.encode(frame):
            out.append(bytes(packet))
    return out


def decode_opus_payload(payload: bytes) -> np.ndarray:
    import av

    ctx = av.codec.CodecContext.create("libopus", "r")
    ctx.sample_rate = SAMPLE_OUT
    packet = av.Packet(payload)
    frames = []
    for frame in ctx.decode(packet):
        arr = frame.to_ndarray().astype(np.float32) / 32768.0
        frames.append(arr.reshape(-1))
    if not frames:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(frames)


def moshi_ws_url() -> str:
    if SERVER_URL:
        base = SERVER_URL.replace("https://", "wss://").replace("http://", "ws://")
        if not base.startswith("ws"):
            base = f"wss://{base}"
    else:
        base = f"wss://{MOSHI_HOST}:{MOSHI_PORT}"
    q = urllib.parse.urlencode(
        {
            "voice_prompt": VOICE_PROMPT,
            "text_prompt": TEXT_PROMPT[:4000],
        }
    )
    return f"{base}/api/chat?{q}"


def ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": _opus_ok,
        "ready": _opus_ok,
        "opus": _opus_ok,
        "opusError": _opus_err,
        "moshi": moshi_ws_url().split("?")[0],
        "voicePrompt": VOICE_PROMPT,
    }


def inject_work_context(line: str) -> None:
    global TEXT_PROMPT
    chunk = (line or "").strip()
    if not chunk:
        return
    TEXT_PROMPT = f"{TEXT_PROMPT}\n{chunk}".strip()[:4000]


class Session:
    def __init__(self, client: WebSocket):
        self.client = client
        self.pp: websockets.WebSocketClientProtocol | None = None
        self.agent_text = ""
        self.closed = False
        self.work: LocalWorkRelay | None = None
        self._work_tasks: set[asyncio.Task] = set()

    async def send_json(self, msg: dict[str, Any]) -> None:
        if self.closed:
            return
        await self.client.send_text(json.dumps(msg))

    async def connect_personaplex(self) -> None:
        url = moshi_ws_url()
        self.pp = await websockets.connect(url, ssl=ssl_context(), max_size=2**22)
        # Handshake 0x00
        try:
            handshake = await asyncio.wait_for(self.pp.recv(), timeout=30.0)
            if isinstance(handshake, bytes) and handshake[:1] != b"\x00":
                raise RuntimeError(f"unexpected handshake {handshake[:4]!r}")
        except asyncio.TimeoutError:
            raise RuntimeError("personaplex handshake timeout") from None

    async def pump_personaplex(self) -> None:
        assert self.pp
        while not self.closed:
            msg = await self.pp.recv()
            if not isinstance(msg, bytes) or not msg:
                continue
            kind = msg[0]
            payload = msg[1:]
            if kind == 0x01:
                try:
                    pcm = decode_opus_payload(payload)
                except Exception:  # noqa: BLE001
                    continue
                if pcm.size:
                    await self.send_json(
                        {
                            "type": "audio",
                            "pcm16_b64": float32_to_pcm16_b64(pcm),
                            "sample_rate": SAMPLE_OUT,
                        }
                    )
            elif kind == 0x02:
                token = payload.decode("utf-8", errors="ignore")
                if token:
                    self.agent_text += token
                    await self.send_json({"type": "agent_response", "text": self.agent_text})
            elif kind == 0x03:
                err = payload.decode("utf-8", errors="ignore")
                await self.send_json({"type": "error", "error": err or "personaplex_error"})
                break

    async def on_audio(self, b64: str) -> None:
        if self.work and self.work.connected:
            await self.work.forward({"type": "audio", "pcm16_b64": b64})
        if not self.pp or not _opus_ok:
            return
        pcm = pcm16_b64_to_float32(b64, SAMPLE_IN)
        try:
            frames = encode_opus_frames(pcm)
        except Exception:  # noqa: BLE001
            return
        for frame in frames:
            await self.pp.send(b"\x01" + frame)

    async def _on_work_message(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "executive":
            report = str(msg.get("report") or "").strip()
            if report:
                inject_work_context(f"(Work brain result — say this naturally to the user: {report})")
                await self.send_json({"type": "executive", "report": report})
        elif kind == "user_transcript":
            await self.send_json(msg)
        elif kind == "job":
            await self.send_json(msg)

    async def _run_work_fallback(self, line: str) -> None:
        result = await dispatch_work(line)
        if not result or not result.get("ok"):
            return
        report = str(result.get("report") or "").strip()
        if report:
            inject_work_context(f"(Work brain result — say this naturally to the user: {report})")
            await self.send_json({"type": "executive", "report": report})

    def _schedule_work_fallback(self, line: str) -> None:
        task = asyncio.create_task(self._run_work_fallback(line))
        self._work_tasks.add(task)
        task.add_done_callback(self._work_tasks.discard)

    async def on_text(self, text: str) -> None:
        line = text.strip()
        if not line:
            return
        inject_work_context(f"User typed: {line}")
        if self.work and self.work.connected:
            await self.work.forward({"type": "text", "text": line})
        elif local_work_available():
            self._schedule_work_fallback(line)

    async def on_context(self, text: str) -> None:
        line = text.strip()
        if not line:
            return
        inject_work_context(f"(Context: {line})")
        if self.work and self.work.connected:
            await self.work.forward({"type": "context", "text": line})


@app.websocket("/v1/voice")
async def voice_socket(ws: WebSocket) -> None:
    await ws.accept()
    session = Session(ws)
    if not _opus_ok:
        await session.send_json({"type": "error", "error": f"opus_unavailable:{_opus_err}"})
        await ws.close()
        return
    try:
        await session.connect_personaplex()
    except Exception as err:  # noqa: BLE001
        await session.send_json({"type": "error", "error": f"personaplex_connect:{err}"})
        await ws.close()
        return

    await session.send_json(
        {
            "type": "ready",
            "backend": "personaplex",
            "duplex": True,
            "voice": VOICE_PROMPT,
        }
    )
    await session.send_json({"type": "status", "state": "listening"})

    if local_work_available() or os.environ.get("SCRAPPY_LOCAL_WORK_WS"):
        session.work = LocalWorkRelay(session._on_work_message)
        try:
            await session.work.connect()
        except Exception:
            session.work = None

    pump_task = asyncio.create_task(session.pump_personaplex())
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")
            if kind in ("audio", "user_audio_chunk"):
                b64 = msg.get("pcm16_b64") or msg.get("user_audio_chunk") or ""
                await session.on_audio(b64)
            elif kind == "text":
                await session.on_text(msg.get("text") or "")
            elif kind == "context":
                await session.on_context(msg.get("text") or "")
            elif kind in ("end", "close"):
                break
    except WebSocketDisconnect:
        pass
    finally:
        session.closed = True
        pump_task.cancel()
        for task in list(session._work_tasks):
            task.cancel()
        if session.work:
            await session.work.close()
        if session.pp:
            await session.pp.close()


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
