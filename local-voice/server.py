"""
Cog local voice server — Unmute-shaped pipeline for AMD/CPU.

Protocol (JSON over WebSocket, similar to Cog's ElevenLabs client):
  Client → { "type": "audio", "pcm16_b64": "..." }   # 16kHz mono PCM chunks
  Client → { "type": "text", "text": "..." }         # typed message
  Client → { "type": "context", "text": "..." }      # background context
  Client → { "type": "end" }                        # hang up

  Server → { "type": "ready" }
  Server → { "type": "user_transcript", "text": "..." }
  Server → { "type": "agent_response", "text": "..." }
  Server → { "type": "audio", "pcm16_b64": "...", "sample_rate": 24000 }
  Server → { "type": "error", "error": "..." }
  Server → { "type": "status", "state": "listening"|"thinking"|"speaking" }
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import struct
import time
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
PERSONA_PATH = Path(os.environ.get("COG_PERSONA", str(REPO / "personality.md")))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
HOST = os.environ.get("COG_VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("COG_VOICE_PORT", "8790"))
SAMPLE_RATE_IN = 16000
SAMPLE_RATE_OUT = 24000

# Energy VAD: end turn after this much silence once we've heard speech.
SILENCE_MS = int(os.environ.get("COG_VAD_SILENCE_MS", "700"))
MIN_SPEECH_MS = int(os.environ.get("COG_VAD_MIN_SPEECH_MS", "280"))
ENERGY_THRESH = float(os.environ.get("COG_VAD_ENERGY", "0.012"))

app = FastAPI(title="Cog Local Voice")
_whisper = None
_kokoro = None
_persona = ""


def log(msg: str) -> None:
    print(f"[local-voice] {msg}", flush=True)


def load_persona() -> str:
    try:
        text = PERSONA_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        text = "You are Cog, Jake's desk robot. Be brief and spoken-friendly."
    return (
        text
        + "\n\n## VOICE MODE\n"
        + "You are speaking out loud. Keep replies short (1-3 sentences) unless asked for detail. "
        + "No markdown, no bullet lists, no code fences. Sound like Cog.\n"
        + "CRITICAL: Never read, quote, summarize, or recite system notes, machine telemetry, "
        + "Recall dumps, personality text, or anything labeled context unless Jake clearly asks "
        + "for that specific info. Those notes are private background for you. Just talk normally."
    )


WAKE_ONLY = re.compile(
    r"^\s*(hey|hi|okay|ok|yo)\s+(cog|chief|workbuddy|work buddy)[!?.,\s]*$",
    re.I,
)


def get_whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        log(f"loading Whisper '{WHISPER_MODEL}' on CPU int8…")
        _whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        log("Whisper ready")
    return _whisper


def get_kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro

        model = ROOT / "models" / "kokoro-v1.0.onnx"
        voices = ROOT / "models" / "voices-v1.0.bin"
        if not model.exists() or not voices.exists():
            raise RuntimeError(
                "Kokoro models missing. Run: powershell -File scripts/setup-local-voice.ps1"
            )
        log("loading Kokoro TTS…")
        _kokoro = Kokoro(str(model), str(voices))
        log("Kokoro ready")
    return _kokoro


def pcm16_b64_to_float32(b64: str) -> np.ndarray:
    raw = base64.b64decode(b64)
    if len(raw) < 2:
        return np.zeros(0, dtype=np.float32)
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def float32_to_pcm16_b64(audio: np.ndarray) -> str:
    clipped = np.clip(audio, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    return base64.b64encode(pcm.tobytes()).decode("ascii")


def rms_energy(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(samples))))


def transcribe(samples: np.ndarray) -> str:
    if samples.size < SAMPLE_RATE_IN * 0.15:
        return ""
    model = get_whisper()
    segments, _info = model.transcribe(
        samples,
        language="en",
        beam_size=1,
        vad_filter=True,
        without_timestamps=True,
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return text


def split_speakable(buffer: str) -> tuple[list[str], str]:
    """Pull complete sentences off a streaming LLM buffer."""
    parts: list[str] = []
    rest = buffer
    while True:
        m = re.search(r"[.!?]\s+", rest)
        if not m:
            break
        cut = m.end()
        piece = rest[:cut].strip()
        rest = rest[cut:]
        if piece:
            parts.append(piece)
    # Also flush a long clause ending in comma/semicolon if buffer is huge.
    if len(rest) > 180:
        m = re.search(r"[,;:]\s+", rest[80:])
        if m:
            cut = 80 + m.end()
            parts.append(rest[:cut].strip())
            rest = rest[cut:]
    return parts, rest


async def ollama_stream(messages: list[dict[str, str]]):
    url = f"{OLLAMA_URL}/api/chat"
    payload = {
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": True,
        "options": {"temperature": 0.7, "num_predict": 220},
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream("POST", url, json=payload) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                raise RuntimeError(f"ollama_{resp.status_code}: {body[:200]!r}")
            async for line in resp.aiter_lines():
                if not line:
                    continue
                data = json.loads(line)
                msg = data.get("message") or {}
                chunk = msg.get("content") or ""
                if chunk:
                    yield chunk
                if data.get("done"):
                    break


def synthesize(text: str) -> np.ndarray:
    voice = os.environ.get("COG_TTS_VOICE", "am_adam")
    kokoro = get_kokoro()
    samples, _sr = kokoro.create(text, voice=voice, speed=1.05)
    return np.asarray(samples, dtype=np.float32)


class Session:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.history: list[dict[str, str]] = []
        self.side_context: list[str] = []
        self.audio_buf = np.zeros(0, dtype=np.float32)
        self.speech_ms = 0.0
        self.silence_ms = 0.0
        self.in_speech = False
        self.busy = False
        self.closed = False

    async def send(self, payload: dict[str, Any]) -> None:
        if self.closed:
            return
        await self.ws.send_json(payload)

    def add_context(self, text: str) -> None:
        line = (text or "").strip()
        if not line:
            return
        # Keep a tiny rolling brief — never dump this into spoken turns.
        self.side_context.append(line[:1200])
        if len(self.side_context) > 4:
            self.side_context = self.side_context[-4:]

    def build_messages(self) -> list[dict[str, str]]:
        system = _persona
        if self.side_context:
            brief = "\n".join(f"- {c}" for c in self.side_context)
            system += (
                "\n\n## PRIVATE BACKGROUND (do not read aloud)\n"
                "Use only if Jake asks about his machine, notes, or current work.\n"
                f"{brief}"
            )
        # Persona stays one system message; chat is user/assistant only.
        messages = [{"role": "system", "content": system}]
        messages.extend(self.history[-16:])
        return messages

    async def on_audio(self, b64: str) -> None:
        if self.busy:
            return
        samples = pcm16_b64_to_float32(b64)
        if samples.size == 0:
            return
        energy = rms_energy(samples)
        duration_ms = 1000.0 * samples.size / SAMPLE_RATE_IN

        if energy >= ENERGY_THRESH:
            self.in_speech = True
            self.speech_ms += duration_ms
            self.silence_ms = 0.0
            self.audio_buf = np.concatenate([self.audio_buf, samples])
        elif self.in_speech:
            self.silence_ms += duration_ms
            self.audio_buf = np.concatenate([self.audio_buf, samples])
            if self.silence_ms >= SILENCE_MS and self.speech_ms >= MIN_SPEECH_MS:
                await self.finish_user_turn()

        # Cap buffer so we don't grow forever on noise.
        max_samples = SAMPLE_RATE_IN * 30
        if self.audio_buf.size > max_samples:
            self.audio_buf = self.audio_buf[-max_samples:]

    async def finish_user_turn(self) -> None:
        if self.busy:
            return
        clip = self.audio_buf.copy()
        self.audio_buf = np.zeros(0, dtype=np.float32)
        self.in_speech = False
        self.speech_ms = 0.0
        self.silence_ms = 0.0
        self.busy = True
        try:
            await self.send({"type": "status", "state": "thinking"})
            text = await asyncio.to_thread(transcribe, clip)
            if not text or len(text.strip()) < 2:
                await self.send({"type": "status", "state": "listening"})
                return
            await self.send({"type": "user_transcript", "text": text})
            # Wake-only phrases should not dump memory/context — just greet.
            if WAKE_ONLY.match(text):
                greet = "Yeah? I'm here."
                self.history.append({"role": "user", "content": text})
                self.history.append({"role": "assistant", "content": greet})
                await self.send({"type": "status", "state": "speaking"})
                await self.speak(greet)
                await self.send({"type": "agent_response", "text": greet})
                await self.send({"type": "status", "state": "listening"})
                return
            self.history.append({"role": "user", "content": text})
            await self.reply_from_history()
        except Exception as err:  # noqa: BLE001
            log(f"turn failed: {err}")
            await self.send({"type": "error", "error": str(err)})
            await self.send({"type": "status", "state": "listening"})
        finally:
            self.busy = False

    async def on_text(self, text: str) -> None:
        line = (text or "").strip()
        if not line or self.busy:
            return
        self.busy = True
        try:
            await self.send({"type": "status", "state": "thinking"})
            await self.send({"type": "user_transcript", "text": line})
            if WAKE_ONLY.match(line):
                greet = "Yeah? I'm here."
                self.history.append({"role": "user", "content": line})
                self.history.append({"role": "assistant", "content": greet})
                await self.send({"type": "status", "state": "speaking"})
                await self.speak(greet)
                await self.send({"type": "agent_response", "text": greet})
                await self.send({"type": "status", "state": "listening"})
                return
            self.history.append({"role": "user", "content": line})
            await self.reply_from_history()
        except Exception as err:  # noqa: BLE001
            log(f"text turn failed: {err}")
            await self.send({"type": "error", "error": str(err)})
            await self.send({"type": "status", "state": "listening"})
        finally:
            self.busy = False

    async def reply_from_history(self) -> None:
        full = ""
        pending = ""
        await self.send({"type": "status", "state": "speaking"})
        async for chunk in ollama_stream(self.build_messages()):
            full += chunk
            pending += chunk
            sentences, pending = split_speakable(pending)
            for sentence in sentences:
                await self.speak(sentence)

        tail = pending.strip()
        if tail:
            await self.speak(tail)

        reply = full.strip()
        if reply:
            self.history.append({"role": "assistant", "content": reply})
            # Trim spoken chat only (context lives separately).
            if len(self.history) > 20:
                self.history = self.history[-20:]
            await self.send({"type": "agent_response", "text": reply})
        await self.send({"type": "status", "state": "listening"})

    async def speak(self, text: str) -> None:
        clean = re.sub(r"[*`#_>~\[\]\(\)]", "", text).strip()
        if not clean:
            return
        # Hard stop if the model starts dumping system-ish content.
        lowered = clean.lower()
        banned = (
            "private background",
            "from jake's recall",
            "current state of jake",
            "live speech update",
            "system prompt",
            "personality.md",
        )
        if any(b in lowered for b in banned):
            log(f"suppressed context leak: {clean[:80]}")
            return
        audio = await asyncio.to_thread(synthesize, clean)
        # Stream in ~200ms chunks so Cog can start playing ASAP.
        frame = int(SAMPLE_RATE_OUT * 0.2)
        for i in range(0, audio.size, frame):
            piece = audio[i : i + frame]
            await self.send(
                {
                    "type": "audio",
                    "pcm16_b64": float32_to_pcm16_b64(piece),
                    "sample_rate": SAMPLE_RATE_OUT,
                }
            )
            await asyncio.sleep(0)  # yield


@app.get("/health")
async def health():
    ollama_ok = False
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            ollama_ok = r.status_code == 200
    except Exception:  # noqa: BLE001
        ollama_ok = False
    return {
        "ok": True,
        "ollama": ollama_ok,
        "model": OLLAMA_MODEL,
        "whisper": WHISPER_MODEL,
        "persona": PERSONA_PATH.name,
    }


@app.websocket("/v1/voice")
async def voice_socket(ws: WebSocket):
    await ws.accept()
    session = Session(ws)
    await session.send({"type": "ready", "backend": "local-amd", "model": OLLAMA_MODEL})
    await session.send({"type": "status", "state": "listening"})
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
                session.add_context(msg.get("text") or "")
            elif kind in ("end", "close"):
                break
    except WebSocketDisconnect:
        pass
    finally:
        session.closed = True


def warm_models() -> None:
    global _persona
    _persona = load_persona()
    log(f"persona loaded ({len(_persona)} chars)")
    try:
        get_whisper()
    except Exception as err:  # noqa: BLE001
        log(f"Whisper warm failed (will retry on first use): {err}")
    try:
        get_kokoro()
    except Exception as err:  # noqa: BLE001
        log(f"Kokoro warm failed (run setup script): {err}")


if __name__ == "__main__":
    warm_models()
    log(f"listening on ws://{HOST}:{PORT}/v1/voice")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
