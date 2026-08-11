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

import memory_bridge
from tools_schema import LOCAL_MEMORY_RULES, recall_tools

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
LOG_DIR = ROOT / "logs"
PERSONA_PATH = Path(os.environ.get("COG_PERSONA", str(REPO / "personality.md")))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")  # fast chat brain
OLLAMA_THINK_MODEL = os.environ.get("OLLAMA_THINK_MODEL", "deepseek-r1:14b")
OLLAMA_THINK_MODE = os.environ.get("OLLAMA_THINK_MODE", "auto").lower()  # auto|always|off
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
HOST = os.environ.get("COG_VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("COG_VOICE_PORT", "8790"))
SAMPLE_RATE_IN = 16000
SAMPLE_RATE_OUT = 24000
MAX_TOOL_ROUNDS = int(os.environ.get("COG_TOOL_ROUNDS", "4"))

# Energy VAD: end turn after this much silence once we've heard speech.
SILENCE_MS = int(os.environ.get("COG_VAD_SILENCE_MS", "700"))
MIN_SPEECH_MS = int(os.environ.get("COG_VAD_MIN_SPEECH_MS", "280"))
ENERGY_THRESH = float(os.environ.get("COG_VAD_ENERGY", "0.012"))

THINK_TRIGGERS = re.compile(
    r"\b("
    r"think(?:\s+hard(?:er)?)?|reason(?:ing)?|plan(?:\s+out)?|figure\s+out|"
    r"debug|analyze|analyse|architecture|design\s+(?:a|the|this)|"
    r"step[- ]by[- ]step|carefully|deep\s+dive|compare\s+options|"
    r"what(?:'s| is)\s+wrong|why\s+(?:is|does|did|would)|how\s+should\s+i|"
    r"trade-?offs?|implement(?:ation)?|"
    r"(?:your\s+)?memory|remember|recall|preferences?"
    r")\b",
    re.I,
)

MEMORY_TRIGGERS = re.compile(
    r"\b("
    r"your\s+memory|improve\s+(?:your\s+)?memory|remember(?:\s+this)?|"
    r"what\s+did\s+i\s+(?:say|tell|ask)|recall|"
    r"do\s+you\s+remember|from\s+(?:our|my)\s+(?:notes|chats?|memory)|"
    r"preferences?|relationship|"
    r"open\s+tasks?|action\s+items?|my\s+notes?|search\s+(?:my\s+)?notes?"
    r")\b",
    re.I,
)

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
        + "for that specific info. Those notes are private background for you. Just talk normally.\n\n"
        + LOCAL_MEMORY_RULES
    )


def append_transcript(session_id: str, role: str, text: str) -> None:
    line = (text or "").strip()
    if not line:
        return
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = LOG_DIR / f"{session_id}.jsonl"
        with path.open("a", encoding="utf-8") as fh:
            fh.write(
                json.dumps(
                    {"ts": time.time(), "role": role, "text": line[:4000]},
                    ensure_ascii=False,
                )
                + "\n"
            )
    except OSError as err:
        log(f"transcript write failed: {err}")


def needs_memory_tools(user_text: str) -> bool:
    text = (user_text or "").strip()
    if not text or WAKE_ONLY.match(text):
        return False
    return bool(MEMORY_TRIGGERS.search(text))


WAKE_ONLY = re.compile(
    r"^\s*(hey\s+there|okay\s+then|wake\s+up)\s+cog[!?.,\s]*$",
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


def strip_thinking(text: str) -> str:
    """Remove chain-of-thought blocks so Cog doesn't speak his homework."""
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.I)
    cleaned = re.sub(r"<thinking>[\s\S]*?</thinking>", "", cleaned, flags=re.I)
    # DeepSeek-style leftover headers.
    cleaned = re.sub(r"(?im)^\s*(thinking|reasoning)\s*:\s*", "", cleaned)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


class ThinkFilter:
    """Streaming filter that holds back <think>…</think> from TTS."""

    def __init__(self) -> None:
        self.buf = ""
        self.in_think = False

    def feed(self, chunk: str) -> str:
        self.buf += chunk or ""
        out = []
        while self.buf:
            if self.in_think:
                end = re.search(r"</think>|</thinking>", self.buf, re.I)
                if not end:
                    # Keep a short tail in case a tag is split across chunks.
                    if len(self.buf) > 32:
                        self.buf = self.buf[-32:]
                    break
                self.buf = self.buf[end.end() :]
                self.in_think = False
                continue
            start = re.search(r"<think>|<thinking>", self.buf, re.I)
            if not start:
                # Hold a little back so a split opening tag isn't spoken.
                hold = 10
                if len(self.buf) > hold:
                    out.append(self.buf[:-hold])
                    self.buf = self.buf[-hold:]
                break
            out.append(self.buf[: start.start()])
            self.buf = self.buf[start.end() :]
            self.in_think = True
        return "".join(out)

    def flush(self) -> str:
        if self.in_think:
            self.buf = ""
            self.in_think = False
            return ""
        leftover = self.buf
        self.buf = ""
        return leftover


def needs_thinking(user_text: str) -> bool:
    """Route hard asks to the thinking model; keep casual chat on the fast brain."""
    if OLLAMA_THINK_MODE in ("off", "false", "0"):
        return False
    if OLLAMA_THINK_MODE in ("always", "on", "true", "1"):
        return True
    text = (user_text or "").strip()
    if not text:
        return False
    if WAKE_ONLY.match(text):
        return False
    if THINK_TRIGGERS.search(text):
        return True
    # Longer, multi-clause asks are usually planning/debugging.
    if len(text) >= 140 and ("?" in text or "," in text):
        return True
    return False


def _tool_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return {"query": raw}
    return {}


async def ollama_chat(
    messages: list[dict[str, Any]],
    model: str,
    *,
    think: bool = False,
    tools: list[dict] | None = None,
    stream: bool = False,
) -> Any:
    url = f"{OLLAMA_URL}/api/chat"
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": stream,
        "options": {
            "temperature": 0.4 if tools else (0.5 if think else 0.7),
            "num_predict": 700 if think else (400 if tools else 220),
        },
    }
    if think:
        payload["think"] = True
    if tools:
        payload["tools"] = tools

    if not stream:
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code != 200:
                raise RuntimeError(f"ollama_{resp.status_code}: {resp.text[:200]!r}")
            data = resp.json()
            return data.get("message") or {}

    async def _gen():
        async with httpx.AsyncClient(timeout=180.0) as client:
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

    return _gen()


async def ollama_stream(messages: list[dict[str, Any]], model: str, *, think: bool):
    gen = await ollama_chat(messages, model, think=think, stream=True)
    async for chunk in gen:
        yield chunk


async def run_tool_loop(
    messages: list[dict[str, Any]],
    model: str,
    *,
    force: bool = False,
) -> list[dict[str, Any]]:
    """Let Ollama call Recall tools, then return the enriched message list."""
    tools = recall_tools()
    working = list(messages)
    if force:
        working.append(
            {
                "role": "user",
                "content": (
                    "(System nudge: Jake is asking about YOUR memory / Recall. "
                    "Call recall_search or recall_ask or recall_recent before answering. "
                    "Do not give human mnemonic/sleep tips.)"
                ),
            }
        )

    for round_i in range(MAX_TOOL_ROUNDS):
        msg = await ollama_chat(working, model, tools=tools, stream=False)
        tool_calls = msg.get("tool_calls") or []
        content = (msg.get("content") or "").strip()

        if not tool_calls:
            if force and round_i == 0 and not content:
                # Model ignored tools — seed a direct search ourselves.
                seed = await memory_bridge.call_tool(
                    "recall_search",
                    {
                        "query": "Cog memory preferences relationship decisions",
                        "project": "WorkBuddy",
                        "limit": 8,
                    },
                )
                working.append(
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "type": "function",
                                "function": {
                                    "name": "recall_search",
                                    "arguments": {
                                        "query": "Cog memory preferences relationship decisions",
                                        "project": "WorkBuddy",
                                        "limit": 8,
                                    },
                                },
                            }
                        ],
                    }
                )
                working.append(
                    {
                        "role": "tool",
                        "content": json.dumps(seed, ensure_ascii=False)[:8000],
                    }
                )
                continue
            if content:
                working.append({"role": "assistant", "content": content})
            break

        # Keep the assistant tool-call turn, then append tool results.
        working.append(
            {
                "role": "assistant",
                "content": content,
                "tool_calls": tool_calls,
            }
        )
        for call in tool_calls:
            fn = call.get("function") or {}
            name = str(fn.get("name") or "").strip()
            args = _tool_args(fn.get("arguments"))
            log(f"tool -> {name} {json.dumps(args)[:160]}")
            if not name.startswith("recall_"):
                result: dict[str, Any] = {"ok": False, "error": "invalid_tool"}
            else:
                result = await memory_bridge.call_tool(name, args)
            working.append(
                {
                    "role": "tool",
                    "content": json.dumps(
                        {
                            "ok": result.get("ok"),
                            "text": (result.get("text") or "")[:6000],
                            "error": result.get("error"),
                            "data": result.get("data"),
                        },
                        ensure_ascii=False,
                        default=str,
                    )[:8000],
                }
            )
    return working


def synthesize(text: str) -> np.ndarray:
    voice = os.environ.get("COG_TTS_VOICE", "am_adam")
    kokoro = get_kokoro()
    samples, _sr = kokoro.create(text, voice=voice, speed=1.05)
    return np.asarray(samples, dtype=np.float32)


class Session:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.session_id = f"cog-{int(time.time())}-{os.getpid()}"
        self.history: list[dict[str, str]] = []
        self.side_context: list[str] = []
        self.memory_brief = ""
        self.audio_buf = np.zeros(0, dtype=np.float32)
        self.speech_ms = 0.0
        self.silence_ms = 0.0
        self.in_speech = False
        self.busy = False
        self.closed = False
        self._brief_loaded = False

    async def send(self, payload: dict[str, Any]) -> None:
        if self.closed:
            return
        await self.ws.send_json(payload)

    async def ensure_memory_brief(self) -> None:
        if self._brief_loaded:
            return
        self._brief_loaded = True
        try:
            brief = await memory_bridge.memory_brief()
            if brief.get("ok") and brief.get("text"):
                self.memory_brief = str(brief["text"])[:10000]
                log(f"memory brief loaded ({len(self.memory_brief)} chars)")
            else:
                log(f"memory brief unavailable: {brief.get('error') or brief}")
        except Exception as err:  # noqa: BLE001
            log(f"memory brief failed: {err}")
        try:
            snap = await memory_bridge.system_context()
            if snap.get("ok") and snap.get("text"):
                self.add_context(f"Machine: {str(snap['text'])[:800]}")
        except Exception as err:  # noqa: BLE001
            log(f"system context skip: {err}")

    def add_context(self, text: str) -> None:
        line = (text or "").strip()
        if not line:
            return
        # Keep a tiny rolling brief — never dump this into spoken turns.
        self.side_context.append(line[:1200])
        if len(self.side_context) > 4:
            self.side_context = self.side_context[-4:]

    def build_messages(self) -> list[dict[str, Any]]:
        system = _persona
        if self.memory_brief:
            system += (
                "\n\n## WORKING MEMORY FROM RECALL (private — do not read aloud)\n"
                "This is YOUR memory of Jake. Use it like a friend uses things they know. "
                "If he asks about memory/preferences and this feels thin, call Recall tools.\n"
                f"{self.memory_brief}"
            )
        if self.side_context:
            brief = "\n".join(f"- {c}" for c in self.side_context)
            system += (
                "\n\n## PRIVATE BACKGROUND (do not read aloud)\n"
                "Use only if Jake asks about his machine, notes, or current work.\n"
                f"{brief}"
            )
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
        messages.extend(self.history[-16:])
        return messages

    def transcript_text(self) -> str:
        lines = []
        for msg in self.history:
            role = "Jake" if msg.get("role") == "user" else "Cog"
            lines.append(f"{role}: {msg.get('content') or ''}")
        return "\n".join(lines)

    async def persist_session(self) -> None:
        user_turns = sum(1 for m in self.history if m.get("role") == "user")
        if user_turns < 2:
            return
        try:
            title = f"Cog chat {time.strftime('%Y-%m-%d %H:%M')}"
            result = await memory_bridge.save_session(self.transcript_text(), title=title)
            log(f"session save: {result.get('ok')} {result.get('error') or ''}".strip())
        except Exception as err:  # noqa: BLE001
            log(f"session save failed: {err}")

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
            append_transcript(self.session_id, "jake", text)
            # Wake-only phrases should not dump memory/context — just greet.
            if WAKE_ONLY.match(text):
                greet = "Yeah? I'm here."
                self.history.append({"role": "user", "content": text})
                self.history.append({"role": "assistant", "content": greet})
                append_transcript(self.session_id, "cog", greet)
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
            append_transcript(self.session_id, "jake", line)
            if WAKE_ONLY.match(line):
                greet = "Yeah? I'm here."
                self.history.append({"role": "user", "content": line})
                self.history.append({"role": "assistant", "content": greet})
                append_transcript(self.session_id, "cog", greet)
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
        await self.ensure_memory_brief()

        last_user = ""
        for msg in reversed(self.history):
            if msg.get("role") == "user":
                last_user = msg.get("content") or ""
                break

        use_think = needs_thinking(last_user)
        force_memory = needs_memory_tools(last_user)
        model = OLLAMA_THINK_MODEL if use_think else OLLAMA_MODEL
        log(
            f"route -> {'think' if use_think else 'fast'} ({model})"
            + (" +memory-tools" if force_memory else "")
        )
        await self.send(
            {
                "type": "status",
                "state": "thinking",
                "route": "think" if use_think else "fast",
                "model": model,
            }
        )

        # Only spend a tool round when Jake is asking about memory/notes/tasks.
        messages = self.build_messages()
        if force_memory:
            try:
                messages = await run_tool_loop(messages, OLLAMA_MODEL, force=True)
            except Exception as err:  # noqa: BLE001
                log(f"tool loop failed (continuing without): {err}")
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Reply out loud to Jake now in Cog's voice. "
                        "Short spoken answer only. Do not recite notes or tool JSON. "
                        "If he asked about YOUR memory, talk about Recall/notes — not human mnemonics."
                    ),
                }
            )

        full = ""
        pending = ""
        filt = ThinkFilter()
        if not use_think:
            await self.send({"type": "status", "state": "speaking", "route": "fast", "model": model})

        async for chunk in ollama_stream(messages, model, think=use_think):
            visible = filt.feed(chunk)
            if not visible:
                continue
            if use_think and not full and not pending:
                await self.send({"type": "status", "state": "speaking", "route": "think", "model": model})
            full += visible
            pending += visible
            sentences, pending = split_speakable(pending)
            for sentence in sentences:
                await self.speak(sentence)

        visible = filt.flush()
        if visible:
            full += visible
            pending += visible
        tail = pending.strip()
        if tail:
            await self.speak(tail)

        reply = strip_thinking(full).strip()
        if reply:
            self.history.append({"role": "assistant", "content": reply})
            append_transcript(self.session_id, "cog", reply)
            if len(self.history) > 20:
                self.history = self.history[-20:]
            await self.send(
                {
                    "type": "agent_response",
                    "text": reply,
                    "route": "think" if use_think else "fast",
                }
            )
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
        "thinkModel": OLLAMA_THINK_MODEL,
        "thinkMode": OLLAMA_THINK_MODE,
        "whisper": WHISPER_MODEL,
        "persona": PERSONA_PATH.name,
    }


@app.websocket("/v1/voice")
async def voice_socket(ws: WebSocket):
    await ws.accept()
    session = Session(ws)
    await session.send(
        {
            "type": "ready",
            "backend": "local-amd",
            "model": OLLAMA_MODEL,
            "session_id": session.session_id,
            "memory": True,
        }
    )
    await session.send({"type": "status", "state": "listening"})
    # Prefetch Recall so the first real turn already has working memory.
    asyncio.create_task(session.ensure_memory_brief())
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
        await session.persist_session()


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
