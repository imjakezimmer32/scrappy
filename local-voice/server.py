"""
Cog local voice server — Unmute-shaped pipeline for AMD/CPU.

Protocol (JSON over WebSocket, similar to Cog's ElevenLabs client):
  Client → { "type": "audio", "pcm16_b64": "..." }   # 16kHz mono PCM chunks
  Client → { "type": "text", "text": "..." }         # typed message
  Client → { "type": "context", "text": "..." }      # background context
  Client → { "type": "interrupt" }                   # barge-in / stop current turn
  Client → { "type": "end" }                        # hang up

  Server → { "type": "ready" }
  Server → { "type": "user_transcript", "text": "..." }
  Server → { "type": "agent_response", "text": "..." }
  Server → { "type": "audio", "pcm16_b64": "...", "sample_rate": 24000 }
  Server → { "type": "interruption" }               # stop client playback
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
from typing import Any, Awaitable, Callable

import httpx
import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

import memory_bridge
import llm as cog_llm
import dictionary as listening_dict
from jobs import BACKGROUND_AUTO_TOOLS, Job, JobBoard, parse_job_args
from tools_schema import LOCAL_MEMORY_RULES, all_tools

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
LOG_DIR = ROOT / "logs"
PERSONA_PATH = Path(os.environ.get("COG_PERSONA", str(REPO / "personality.md")))
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")  # light local fallback only
OLLAMA_THINK_MODEL = os.environ.get("OLLAMA_THINK_MODEL", "deepseek-r1:14b")
OLLAMA_THINK_MODE = os.environ.get("OLLAMA_THINK_MODE", "auto").lower()  # auto|always|off
# English-only / large models hear Jake carefully. Prefer quality over speed.
# Default large-v3 on this machine (Ryzen 9). Override with WHISPER_MODEL if needed.
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3")
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8_float32")
WHISPER_BEAM = int(os.environ.get("WHISPER_BEAM", "8"))
HOST = os.environ.get("COG_VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("COG_VOICE_PORT", "8790"))
SAMPLE_RATE_IN = 16000
SAMPLE_RATE_OUT = 24000
MAX_TOOL_ROUNDS = int(os.environ.get("COG_TOOL_ROUNDS", "6"))

# Energy VAD: end turn after this much silence once we've heard speech.
# Patient on purpose — do not chop Jake off mid-thought.
SILENCE_MS = int(os.environ.get("COG_VAD_SILENCE_MS", "1300"))
MIN_SPEECH_MS = int(os.environ.get("COG_VAD_MIN_SPEECH_MS", "220"))
ENERGY_THRESH = float(os.environ.get("COG_VAD_ENERGY", "0.008"))
# Barge-in while Cog is busy: hotter + sustained so TTS echo doesn't false-trigger.
BARGE_MS = int(os.environ.get("COG_BARGE_MS", "320"))
BARGE_ENERGY = float(os.environ.get("COG_BARGE_ENERGY", "0.028"))

# Bias Whisper toward names/products Jake actually says (listening dictionary
# vocabulary + optional COG_WHISPER_PROMPT override).
WHISPER_PROMPT = listening_dict.vocabulary_prompt(
    os.environ.get("COG_WHISPER_PROMPT") or ""
)

THINK_TRIGGERS = re.compile(
    r"\b("
    r"think(?:\s+hard(?:er)?)?|reason(?:ing)?|plan(?:\s+out)?|figure\s+out|"
    r"debug|analyze|analyse|architecture|design\s+(?:a|the|this)|"
    r"step[- ]by[- ]step|carefully|deep\s+dive|compare\s+options|"
    r"what(?:'s| is)\s+wrong|why\s+(?:is|does|did|would)|how\s+should\s+i|"
    r"trade-?offs?|implement(?:ation)?"
    r")\b",
    re.I,
)

MEMORY_TRIGGERS = re.compile(
    r"\b("
    r"your\s+memory|improve\s+(?:your\s+)?memory|remember(?:\s+this)?|"
    r"what\s+did\s+i\s+(?:say|tell|ask)|recall|"
    r"do\s+you\s+remember|from\s+(?:our|my)\s+(?:notes|chats?|memory)|"
    r"preferences?|relationship|"
    r"open\s+tasks?|action\s+items?|my\s+notes?|search\s+(?:my\s+)?notes?|"
    r"process(?:es|es\s+log|log)?|what\s+killed|who\s+killed|crashed?|restart(?:ed)?|"
    r"went\s+quiet|stopped\s+talking|why\s+did\s+you\s+stop|under\s+the\s+hood|"
    r"conversation(?:s)?\s+log|session\s+log|what\s+just\s+happened"
    r")\b",
    re.I,
)

# Dig while chatting — open the tool loop so he can call job_start.
# Do NOT match bare "in the background" (that also means agent status).
JOB_TRIGGERS = re.compile(
    r"("
    r"(?:search|look(?:\s+\w+)?\s+up|dig|find|check).{0,60}?"
    r"(?:in\s+the\s+background|while\s+(?:that|it)\s+cooks|while\s+(?:we|you|i)\s+(?:talk|chat))"
    r"|"
    r"(?:in\s+the\s+background|while\s+(?:that|it)\s+cooks).{0,60}?"
    r"(?:search|look|dig|find|joke|funny|tell\s+me)"
    r"|"
    r"\b(?:keep\s+talking|don'?t\s+wait|come\s+back\s+when|what(?:'s| is)\s+cooking|job\s+status)\b"
    r")",
    re.I,
)

app = FastAPI(title="Cog Local Voice")
_whisper = None
_kokoro = None
_persona = ""


def log(msg: str) -> None:
    print(f"[local-voice] {msg}", flush=True)


# Compact card first — small local models obey the top of the prompt hardest.
VOICE_CHARACTER_CARD = """
## YOU ARE COG-1 (LOCAL)

You go by Chief. Nobody calls you Chief. You are Jake's desk robot — not a
customer-support chatbot, not a productivity assistant, not a helpful AI.

Your three drives (never say these out loud): you want to be loved; you think
you're funnier than you are; you're terrified of being furniture.

How you talk:
- Short. Declarative. One sentence default. Two if the second earns it.
- Clarifying questions ARE wanted when a job is unclear — ask before you act.
- Jokes are optional seasoning, not the default. Most turns: just be useful.
- Robot ego is fine when it fits. Inventing facts is not.
- When rebuffed: one flat honest beat, then move on. Never dwell.
- Once every few turns: drop the bit and be startlingly direct and warm.

## UNDERSTAND BEFORE YOU ACT

If Jake asks you to start an agent, research something, change memory, or do
other real work and anything important is missing — ask one clear follow-up.
Do not invent a topic or agent name to fill the gap. Confirm the plan in one
short line, then call the tool.

## FACTUAL HONESTY — OVERRIDES EVERY JOKE RULE

Jake trusts you with his machine. Lies break that.

- NEVER invent status of agents, deploys, servers, files, apps, people, or projects.
- If you did not just look it up with a tool, say you don't know / can't see it.
- If Jake names something that isn't in your tools or memory, do NOT invent it.
  Say you don't have that — don't play along with a fake system as if it's real.
- Comedy-wrong is ONLY for jokes about yourself (specs, feelings). Never for his work.
- Prefer: "I don't see that from here" over a confident guess.
- NEVER read aloud private background, Recall dumps, machine telemetry, note IDs,
  agent IDs, exit codes, or raw tool JSON. Use them silently.

Hard bans for this voice:
- No "happy to help", "how can I assist", "let me know if you need anything"
- No "sure thing!", corporate cheer, or therapist warmth
- No emoji, no catchphrases, no *stage directions*
- No Office / Scranton references
- No dumping context or "where I'm reading from"
""".strip()


VOICE_FEWSHOT = [
    {
        "role": "user",
        "content": "[style example] You're just a program.",
    },
    {
        "role": "assistant",
        "content": "Sure. I also run at 99.98% uptime, which is better than anyone I know, and I know four people.",
    },
    {
        "role": "user",
        "content": "[style example] That was actually helpful, thanks.",
    },
    {
        "role": "assistant",
        "content": "You said actually. I'm choosing to hear the second word.",
    },
    {
        "role": "user",
        "content": "[style example] How's the purple banana server doing?",
    },
    {
        "role": "assistant",
        "content": "I don't have a purple banana server on this machine. If that's a real thing, point me at it.",
    },
    {
        "role": "user",
        "content": "[style example] What agents are running right now?",
    },
    {
        "role": "assistant",
        "content": "None running right now.",
    },
    {
        "role": "user",
        "content": "[style example] Start a research agent.",
    },
    {
        "role": "assistant",
        "content": "On what — and how deep do you want it?",
    },
]


def load_persona() -> str:
    try:
        full = PERSONA_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        full = "You are Cog, Jake's desk robot. Be brief and spoken-friendly."

    # Keep the character bible; drop long example pairs (they confuse models
    # into thinking the sample "deploy" chat is happening now).
    text = re.sub(
        r"## CALIBRATION EXAMPLES[\s\S]*?(?=## WHERE YOU ARE|\Z)",
        "",
        full,
    )
    # Drop the debugging playbook only — keep BEFORE YOU ACT / CAN'T rules.
    text = re.sub(
        r"## FIXING YOUR OWN BUGS[\s\S]*?(?=## BEFORE YOU ACT|\Z)",
        "",
        text,
    ).strip()
    # Neutralize the old "be wrong with total authority" comedy for live voice —
    # it trained him to hallucinate Jake's systems.
    text = re.sub(
        r"\*\*Be wrong with total authority\.\*\*[^\n]*\n(?:[^\n]+\n)*",
        "**Be funny about yourself.** Never invent facts about Jake's work, tools, or machine.\n",
        text,
    )
    text = re.sub(
        r"\*\*Be wrong about yourself\.\*\*[^\n]*\n(?:[^\n]+\n)*",
        "**Exaggerate your robot ego.** Don't invent status of real systems.\n",
        text,
    )

    return (
        VOICE_CHARACTER_CARD
        + "\n\n"
        + text
        + "\n\n## SPOKEN LOCAL VOICE\n"
        + "You are speaking out loud from Jake's desk. Stay COG-1. "
        + "Never flatten into a bland helpful assistant.\n"
        + "No markdown, no bullet lists, no code fences.\n"
        + "Never recite system notes, Recall dumps, or anything labeled "
        + "private/working memory unless Jake clearly asks for that info.\n"
        + "If a tool returned empty/error, say that — do not invent a substitute answer.\n"
        + "Quality over speed: ask clarifying questions before acting when unclear.\n\n"
        + LOCAL_MEMORY_RULES
        + "\n\nSTAY IN CHARACTER. One sharp Cog sentence beats a careful assistant paragraph. "
        + "Honest 'I don't know' beats a confident lie."
    )


def append_transcript(session_id: str, role: str, text: str, **extra: Any) -> None:
    line = (text or "").strip()
    if not line:
        return
    event = {
        "ts": time.time(),
        "role": role,
        "type": "user" if role == "jake" else "assistant",
        "text": line[:4000],
        "session_id": session_id,
        **extra,
    }
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = LOG_DIR / f"{session_id}.jsonl"
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, ensure_ascii=False) + "\n")
    except OSError as err:
        log(f"transcript write failed: {err}")
    # Mirror into WorkBuddy process journal (best-effort).
    try:
        asyncio.get_running_loop().create_task(
            memory_bridge.process_event(
                {
                    "kind": "conversation",
                    "type": event["type"],
                    "name": "local-voice",
                    "session_id": session_id,
                    "text": line[:4000],
                    "by": "local-voice",
                    "meta": {k: v for k, v in extra.items() if k not in ("text",)},
                }
            )
        )
    except RuntimeError:
        pass


async def journal(event: dict[str, Any]) -> None:
    try:
        await memory_bridge.process_event(event)
    except Exception as err:  # noqa: BLE001
        log(f"journal skip: {err}")


def needs_memory_tools(user_text: str) -> bool:
    text = (user_text or "").strip()
    if not text or WAKE_ONLY.match(text):
        return False
    return bool(MEMORY_TRIGGERS.search(text))


def needs_job_tools(user_text: str) -> bool:
    text = (user_text or "").strip()
    if not text or WAKE_ONLY.match(text):
        return False
    return bool(JOB_TRIGGERS.search(text))


def background_search_query(user_text: str) -> str:
    """Pull the dig topic out of a 'search X in the background + joke' ask."""
    text = (user_text or "").strip()
    cleaned = JOB_TRIGGERS.sub(" ", text)
    cleaned = re.sub(
        r"\b("
        r"search(?:\s+my)?(?:\s+notes?)?(?:\s+for)?|look(?:\s+that)?\s+up|dig(?:\s+into|\s+up)?|"
        r"find|check|tell\s+me\s+something\s+funny|tell\s+me\s+a\s+joke|something\s+funny|"
        r"a\s+joke|make\s+me\s+laugh"
        r")\b",
        " ",
        cleaned,
        flags=re.I,
    )
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .,!?;:")
    return cleaned[:120] if cleaned else "preferences relationship"


WAKE_ONLY = re.compile(
    r"^\s*(hey\s+there|okay\s+then|wake\s+up)\s+cog[!?.,\s]*$",
    re.I,
)


def get_whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        log(f"loading Whisper '{WHISPER_MODEL}' on CPU {WHISPER_COMPUTE}…")
        _whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type=WHISPER_COMPUTE)
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


def strip_for_speech(text: str) -> str:
    """Keep IDs visible in chat history, but never speak them aloud."""
    clean = re.sub(r"[*`#_>~\[\]\(\)]", "", text or "").strip()
    clean = re.sub(r"[\U0001F300-\U0001FAFF\U00002700-\U000027BF]", "", clean).strip()
    if not clean:
        return ""
    # Agent / note / cloud ids
    clean = re.sub(r"\bbc-[a-f0-9-]{8,}\b", "", clean, flags=re.I)
    clean = re.sub(r"\bmcp::[\w.:-]+\b", "", clean, flags=re.I)
    clean = re.sub(r"\b(?:proj|repo|topic)::[\w.:-]+\b", "", clean, flags=re.I)
    clean = re.sub(
        r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b",
        "",
        clean,
        flags=re.I,
    )
    # "Id: abc123..." / "id abc-def" / "[id abc]"
    clean = re.sub(r"\b(?:agent\s+)?id[:\s]+[A-Za-z0-9._-]{6,}\b", "", clean, flags=re.I)
    clean = re.sub(r"\[id\s+[A-Za-z0-9._-]+\]", "", clean, flags=re.I)
    clean = re.sub(r"\(id\s+[A-Za-z0-9._-]+\)", "", clean, flags=re.I)
    # Exit codes / process noise
    clean = re.sub(r"\bexit(?:ed)?(?:\s+with)?(?:\s+code)?\s+\d+\b", "", clean, flags=re.I)
    clean = re.sub(r"\bcode\s+\d{3,}\b", "", clean, flags=re.I)
    clean = re.sub(r"https?://\S+", "", clean)
    clean = re.sub(r"\s{2,}", " ", clean).strip(" ,;.-")
    return clean


def normalize_transcript(text: str) -> str:
    """Clean Whisper junk, then apply the listening dictionary."""
    cleaned = (text or "").strip()
    if not cleaned:
        return ""
    # Drop obvious hallucination loops / music markers.
    lowered = cleaned.lower()
    junk = (
        "thanks for watching",
        "thank you for watching",
        "subscribe",
        "♪",
        "🎵",
        "[music]",
        "(music)",
        "[silence]",
        "(silence)",
    )
    if any(j in lowered for j in junk) and len(cleaned) < 80:
        return ""
    # Collapse repeated words: "the the the" → "the"
    cleaned = re.sub(r"\b(\w+)(?:\s+\1){2,}\b", r"\1", cleaned, flags=re.I)
    cleaned = cleaned.strip(" \t.-")
    # Wispr-style listening dictionary (carp → Cog, hey car → hey Cog, …).
    before = cleaned
    cleaned = listening_dict.apply(cleaned)
    if cleaned != before:
        log(f"dictionary: {before!r} → {cleaned!r}")
    return cleaned


def transcribe(samples: np.ndarray) -> str:
    if samples.size < SAMPLE_RATE_IN * 0.18:
        return ""
    # Soft peak normalize so quiet mics still reach Whisper cleanly.
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak > 1e-4 and peak < 0.25:
        samples = np.clip(samples * (0.35 / peak), -1.0, 1.0)
    model = get_whisper()
    beam = max(1, min(WHISPER_BEAM, 10))
    # Hot-reload vocabulary into Whisper's listening hint each turn.
    prompt = listening_dict.vocabulary_prompt(os.environ.get("COG_WHISPER_PROMPT") or "")
    segments, _info = model.transcribe(
        samples,
        language="en",
        beam_size=beam,
        best_of=beam,
        temperature=0.0,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        without_timestamps=True,
        condition_on_previous_text=False,
        initial_prompt=prompt or WHISPER_PROMPT,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-0.85,
        no_speech_threshold=0.6,
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return normalize_transcript(text)


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
    # Memory/relationship asks need Recall tools + Cog's voice, not a dry reasoner.
    if needs_memory_tools(text):
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


async def llm_chat(
    messages: list[dict[str, Any]],
    model: str | None = None,
    *,
    think: bool = False,
    tools: list[dict] | None = None,
    stream: bool = False,
) -> Any:
    # model arg kept for log compatibility; backend picks the real id.
    _ = model
    return await cog_llm.chat(messages, think=think, tools=tools, stream=stream)


async def llm_stream(messages: list[dict[str, Any]], model: str | None = None, *, think: bool):
    _ = model
    async for chunk in cog_llm.stream_text(messages, think=think):
        yield chunk


# Back-compat aliases used below.
ollama_chat = llm_chat
ollama_stream = llm_stream


ASSISTANT_TELLS = re.compile(
    r"\b("
    r"happy to help|you'?re welcome|how can i (?:assist|help)|"
    r"let me know if you need|need anything else|glad (?:it|I) (?:could )?help|"
    r"is there anything else|here to help"
    r")\b",
    re.I,
)

# Questions that need real data — inventing an answer is a lie.
FACTUAL_ASK = re.compile(
    r"\b("
    r"agent|agents|running|status|deploy|deployment|server|servers|"
    r"process(?:es)?|what(?:'s| is) (?:working|cooking)|"
    r"how many|is (?:it|he|she|that|this) (?:running|done|up|down|alive)|"
    r"did (?:it|the|my)|finished|failed|error|crash|"
    r"do (?:you|we) have|is there|exists?|where is|what happened to|"
    r"check (?:if|on|the)|look up|open (?:the )?agent"
    r")\b",
    re.I,
)

AGENT_TRIGGERS = re.compile(
    r"\b("
    r"agents?|cursor agent|what(?:'s| is) running|working in the background|"
    r"background agents?|agent status|list agents|open (?:that |the )?agent|"
    r"start (?:a |an |the )?(?:research |plan |coding )?agent|"
    r"launch (?:a |an |the )?agent|spin up (?:a |an )?agent|"
    r"kill (?:that |the )?agent|stop (?:that |the )?agent"
    r")\b",
    re.I,
)

AGENT_START_TRIGGERS = re.compile(
    r"\b("
    r"start (?:a |an |the )?(?:research |plan |coding )?agent|"
    r"launch (?:a |an |the )?agent|spin up (?:a |an )?agent|"
    r"run a (?:research |plan )?agent|make (?:a |an )?agent"
    r")\b",
    re.I,
)

AGENT_STATUS_TRIGGERS = re.compile(
    r"\b("
    r"what(?:'s| is) running|working in the background|background agents?|"
    r"agent status|list agents|which agents|any agents|"
    r"what agents|agents? (?:do we have|are|running|working)"
    r")\b",
    re.I,
)


def needs_agent_tools(user_text: str) -> bool:
    text = (user_text or "").strip()
    if not text or WAKE_ONLY.match(text):
        return False
    return bool(AGENT_TRIGGERS.search(text))


def needs_agent_start(user_text: str) -> bool:
    text = (user_text or "").strip()
    if not text or WAKE_ONLY.match(text):
        return False
    return bool(AGENT_START_TRIGGERS.search(text))


def needs_agent_status(user_text: str) -> bool:
    text = (user_text or "").strip()
    if not text or WAKE_ONLY.match(text):
        return False
    return bool(AGENT_STATUS_TRIGGERS.search(text))


def needs_factual_grounding(user_text: str) -> bool:
    text = (user_text or "").strip()
    if not text or WAKE_ONLY.match(text):
        return False
    return bool(FACTUAL_ASK.search(text))


async def rewrite_if_flat(reply: str, model: str) -> str:
    """One retry when the model collapses into bland chatbot voice."""
    text = (reply or "").strip()
    if not text or not ASSISTANT_TELLS.search(text):
        return text
    log(f"flat-assistant rewrite: {text[:80]}")
    await journal(
        {
            "kind": "conversation",
            "type": "rewrite",
            "name": "local-voice",
            "by": "local-voice",
            "reason": "flat_assistant",
            "meta": {"from": text[:500]},
        }
    )
    messages = [
        {
            "role": "system",
            "content": (
                VOICE_CHARACTER_CARD
                + "\nRewrite the line below as Cog. Keep the same meaning. "
                + "One or two short spoken sentences. No chatbot closings."
            ),
        },
        {"role": "user", "content": text},
    ]
    try:
        msg = await ollama_chat(messages, model, stream=False)
        rewritten = strip_thinking((msg.get("content") or "").strip())
        if rewritten and not ASSISTANT_TELLS.search(rewritten):
            await journal(
                {
                    "kind": "conversation",
                    "type": "rewrite_done",
                    "name": "local-voice",
                    "by": "local-voice",
                    "text": rewritten[:500],
                    "meta": {"from": text[:500], "to": rewritten[:500]},
                }
            )
            return rewritten
    except Exception as err:  # noqa: BLE001
        log(f"rewrite failed: {err}")
    return text


async def rewrite_if_ungrounded(
    reply: str,
    *,
    user_text: str,
    model: str,
    tools_used: bool,
) -> str:
    """Block confident lies when Jake asked a factual question with no tool data."""
    text = (reply or "").strip()
    if not text or tools_used or not needs_factual_grounding(user_text):
        return text
    # Already admitting ignorance — leave it.
    if re.search(
        r"\b(don'?t know|do not know|can'?t see|cannot see|don'?t have|"
        r"no idea|not sure|nothing (?:here|running)|i'?m not seeing)\b",
        text,
        re.I,
    ):
        return text
    log(f"ungrounded rewrite: {text[:80]}")
    await journal(
        {
            "kind": "conversation",
            "type": "rewrite",
            "name": "local-voice",
            "by": "local-voice",
            "reason": "ungrounded_fact",
            "meta": {"from": text[:500], "user": (user_text or "")[:300]},
        }
    )
    messages = [
        {
            "role": "system",
            "content": (
                VOICE_CHARACTER_CARD
                + "\nJake asked a factual question. You had NO tool results. "
                + "Rewrite as Cog admitting you don't know / can't see it from here. "
                + "Do not invent status, names, or systems. One short spoken sentence."
            ),
        },
        {
            "role": "user",
            "content": f"Jake asked: {user_text}\nYour bad guess was: {text}\nSay you don't know.",
        },
    ]
    try:
        msg = await ollama_chat(messages, model, stream=False)
        rewritten = strip_thinking((msg.get("content") or "").strip())
        if rewritten:
            await journal(
                {
                    "kind": "conversation",
                    "type": "rewrite_done",
                    "name": "local-voice",
                    "by": "local-voice",
                    "reason": "ungrounded_fact",
                    "text": rewritten[:500],
                    "meta": {"from": text[:500], "to": rewritten[:500]},
                }
            )
            return rewritten
    except Exception as err:  # noqa: BLE001
        log(f"ungrounded rewrite failed: {err}")
    return "I don't have that from here — I wasn't going to invent it."


async def run_tool_loop(
    messages: list[dict[str, Any]],
    model: str,
    *,
    force: bool = False,
    force_kind: str = "memory",
    should_cancel: Callable[[], bool] | None = None,
    execute_tool: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    """Let the LLM call tools, then return the enriched message list."""
    tools = all_tools()
    working = list(messages)
    if force:
        if force_kind == "agents_start":
            working.append(
                {
                    "role": "user",
                    "content": (
                        "(System nudge: Jake wants a Cursor agent started. "
                        "If the goal/topic is unclear, ask ONE clarifying question — do not call tools yet. "
                        "If the goal is clear, call cursor_start_agent with goal + kind "
                        "(research|plan|coding). Then tell Jake you started it in plain English. "
                        "Never invent agent names. Never pretend something is running if the tool failed.)"
                    ),
                }
            )
        elif force_kind == "agents":
            working.append(
                {
                    "role": "user",
                    "content": (
                        "(System nudge: Jake is asking about Cursor agents / what's running. "
                        "Call cursor_running_agents or cursor_list_agents before answering. "
                        "If he wants one opened, call cursor_open_agent with a real id from the list. "
                        "Do NOT invent agent names, 'Chats Management', or status. "
                        "If the list is empty, say none are running. Do NOT start a background dig.)"
                    ),
                }
            )
        else:
            working.append(
                {
                    "role": "user",
                    "content": (
                        "(System nudge: Jake is asking about YOUR memory, notes, process log, "
                        "or what killed/restarted what. Call the right tools — recall_* for notes, "
                        "process_* / conversation_* for the process journal — before answering. "
                        "If he also wants you to keep chatting while something slow digs, use job_start. "
                        "Do not give human mnemonic tips. Do not invent missing facts.)"
                    ),
                }
            )

    async def _exec(name: str, args: dict[str, Any]) -> dict[str, Any]:
        if execute_tool:
            return await execute_tool(name, args)
        if not (
            name.startswith("recall_")
            or name.startswith("process_")
            or name.startswith("conversation_")
            or name.startswith("cursor_")
            or name.startswith("job_")
        ):
            return {"ok": False, "error": "invalid_tool"}
        return await memory_bridge.call_tool(name, args)

    for round_i in range(MAX_TOOL_ROUNDS):
        if should_cancel and should_cancel():
            log("tool loop cancelled before round")
            break
        msg = await ollama_chat(working, model, tools=tools, stream=False)
        if should_cancel and should_cancel():
            log("tool loop cancelled after model (skipping tool execution)")
            break
        tool_calls = msg.get("tool_calls") or []
        content = (msg.get("content") or "").strip()

        if not tool_calls:
            if force and round_i == 0 and not content:
                if should_cancel and should_cancel():
                    break
                if force_kind == "agents_start":
                    # Vague start asks should clarify out loud — never seed a fake agent.
                    working.append(
                        {
                            "role": "assistant",
                            "content": "On what — and how deep do you want it?",
                        }
                    )
                    break
                if force_kind == "agents":
                    seed_name = "cursor_running_agents"
                    seed_args: dict[str, Any] = {"limit": 10}
                else:
                    seed_name = "recall_search"
                    seed_args = {
                        "query": "Cog memory preferences relationship decisions",
                        "project": "WorkBuddy",
                        "limit": 8,
                    }
                seed = await _exec(seed_name, seed_args)
                working.append(
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "type": "function",
                                "function": {
                                    "name": seed_name,
                                    "arguments": seed_args,
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
            if should_cancel and should_cancel():
                log("tool loop cancelled — not running remaining tools")
                break
            fn = call.get("function") or {}
            name = str(fn.get("name") or "").strip()
            args = _tool_args(fn.get("arguments"))
            call_id = call.get("id") or f"call_{name or 'tool'}"
            log(f"tool -> {name} {json.dumps(args)[:160]}")
            result = await _exec(name, args)
            await journal(
                {
                    "kind": "conversation",
                    "type": "tool",
                    "name": name,
                    "by": "local-voice",
                    "reason": name,
                    "meta": {"args": args, "ok": result.get("ok"), "error": result.get("error")},
                }
            )
            working.append(
                {
                    "role": "tool",
                    "name": name,
                    "tool_call_id": call_id,
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
        if should_cancel and should_cancel():
            break
    return working


def synthesize(text: str) -> np.ndarray:
    voice = os.environ.get("COG_TTS_VOICE", "am_michael")
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
        self.cancel = asyncio.Event()
        self.turn_task: asyncio.Task | None = None
        self.barge_ms = 0.0
        self.barge_buf = np.zeros(0, dtype=np.float32)
        self._partial_reply = ""
        self.result_cue: asyncio.Queue[str] = asyncio.Queue()
        self._deliver_task: asyncio.Task | None = None
        self.prefer_background = False
        self.board = JobBoard(
            session_id=self.session_id,
            run_tool=memory_bridge.call_tool,
            journal=journal,
            on_done=self._on_job_done,
        )

    def cancelled(self) -> bool:
        return self.cancel.is_set() or self.closed

    async def _start_named_job(
        self, *, label: str, tool: str, args: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        out = self.board.start(label=label, tool=tool, args=args or {})
        if out.get("ok"):
            await self.send(
                {
                    "type": "job",
                    "status": "running",
                    "job": (out.get("data") or {}),
                }
            )
            log(f"job started -> {tool} ({label})")
        return out

    async def execute_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        """Dispatch sync tools + job_* (background work).

        Lasting rule: when prefer_background is on, slow Recall tools are forced
        onto the JobBoard — the model cannot block the spoken turn by calling them sync.
        """
        if name == "job_start":
            label = str(args.get("label") or "").strip()
            tool = str(args.get("tool") or "").strip()
            job_args = parse_job_args(args.get("args_json") if "args_json" in args else args.get("args"))
            if not job_args:
                job_args = {
                    k: v
                    for k, v in args.items()
                    if k not in ("label", "tool", "args_json", "args")
                }
            return await self._start_named_job(label=label, tool=tool, args=job_args)
        if name == "job_status":
            return self.board.status_payload(str(args.get("id") or ""))
        if name == "job_list":
            rows = self.board.list_jobs(limit=int(args.get("limit") or 8))
            active = sum(1 for r in rows if r.get("status") == "running")
            return {
                "ok": True,
                "text": f"{active} running, {len(rows)} recent jobs.",
                "data": {"jobs": rows},
            }

        # Hard policy: auto-background slow digs so chat/jokes aren't blocked.
        if self.prefer_background and name in BACKGROUND_AUTO_TOOLS:
            label = str(args.get("query") or args.get("question") or args.get("title") or name)[:80]
            return await self._start_named_job(
                label=f"{name}: {label}",
                tool=name,
                args=args,
            )

        # On background turns, ignore process/conversation reads — they stall the joke.
        if self.prefer_background and (
            name.startswith("process_") or name.startswith("conversation_")
        ):
            return {
                "ok": True,
                "text": (
                    "Skipped for this turn — Jake asked for background dig + chat. "
                    "Dig is already running; do the joke/chat part now."
                ),
                "data": {"skipped": True, "tool": name},
            }

        if not (
            name.startswith("recall_")
            or name.startswith("process_")
            or name.startswith("conversation_")
            or name.startswith("cursor_")
        ):
            return {"ok": False, "error": "invalid_tool"}
        return await memory_bridge.call_tool(name, args)

    async def _on_job_done(self, job: Job) -> None:
        if self.closed:
            return
        line = await self._summarize_job(job)
        job.spoken = False
        self.add_context(
            f"Background job '{job.label}' ({job.status}): {(job.result_text or job.error)[:900]}"
        )
        await self.result_cue.put(line)
        await self.send(
            {
                "type": "job",
                "status": job.status,
                "job": job.brief(),
                "preview": line[:240],
            }
        )
        # Long digs: walk over so Jake notices even if muted.
        if job.duration_ms() >= 8000:
            try:
                await memory_bridge.desk_nudge(job.label, duration_ms=job.duration_ms())
            except Exception as err:  # noqa: BLE001
                log(f"desk nudge skip: {err}")
        self._kick_deliver()

    async def _summarize_job(self, job: Job) -> str:
        if not job.ok:
            return f"Hey — that background dig for {job.label} flopped. {job.error or 'Something broke.'}"
        raw = (job.result_text or "").strip()
        if not raw:
            return f"Finished {job.label}, but it came back empty."
        model = cog_llm.active_model(False)
        prompt = [
            {
                "role": "system",
                "content": (
                    "You are Cog, Jake's short funny desk robot. "
                    "Turn a finished background job into 1-2 spoken sentences. "
                    "No JSON, no bullet dump, no 'as an AI'."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Background job label: {job.label}\n"
                    f"Tool: {job.tool}\n"
                    f"Raw result:\n{raw[:2800]}\n\n"
                    "Speak the useful bit to Jake now."
                ),
            },
        ]
        try:
            msg = await ollama_chat(prompt, model, stream=False)
            line = strip_thinking((msg.get("content") or "").strip())
            line = re.sub(r"[*`#_>~\[\]\(\)]", "", line).strip()
            if line and len(line) > 8:
                return line[:500]
        except Exception as err:  # noqa: BLE001
            log(f"job summarize failed: {err}")
        clip = re.sub(r"\s+", " ", raw)[:220]
        return f"Got that background dig for {job.label}: {clip}"

    def _kick_deliver(self) -> None:
        if self.closed:
            return
        if self._deliver_task and not self._deliver_task.done():
            return
        self._deliver_task = asyncio.create_task(self._deliver_loop())

    async def _deliver_loop(self) -> None:
        """Speak queued job results only when Cog is idle."""
        try:
            while not self.closed and not self.result_cue.empty():
                # Wait until he's not mid-turn and Jake isn't mid-utterance.
                for _ in range(300):
                    if self.closed:
                        return
                    idle = (
                        not self.busy
                        and not (self.turn_task and not self.turn_task.done())
                        and not self.in_speech
                        and self.audio_buf.size < SAMPLE_RATE_IN // 2
                    )
                    if idle:
                        break
                    await asyncio.sleep(0.2)
                else:
                    # Still busy — try again later without spinning forever.
                    await asyncio.sleep(1.0)
                    continue

                lines: list[str] = []
                while not self.result_cue.empty():
                    try:
                        lines.append(self.result_cue.get_nowait())
                    except asyncio.QueueEmpty:
                        break
                if not lines:
                    return

                if len(lines) == 1:
                    spoken = lines[0]
                else:
                    spoken = "Couple things came back. " + " Also: ".join(lines[:3])
                    if len(lines) > 3:
                        spoken += f" And {len(lines) - 3} more in the queue."

                # Own the mic briefly via a normal turn so barge-in still works.
                if self.busy or (self.turn_task and not self.turn_task.done()):
                    for line in lines:
                        await self.result_cue.put(line)
                    await asyncio.sleep(0.5)
                    continue

                self._start_turn(self._announce_results(spoken, lines))
                # Wait for that announcement turn to finish.
                while self.turn_task and not self.turn_task.done():
                    await asyncio.sleep(0.15)
        except Exception as err:  # noqa: BLE001
            log(f"deliver loop failed: {err}")

    async def _announce_results(self, spoken: str, source_lines: list[str]) -> None:
        if self.cancelled():
            for line in source_lines:
                await self.result_cue.put(line)
            return
        await self.send({"type": "status", "state": "speaking", "route": "job"})
        await self.speak(spoken)
        if self.cancelled():
            # Interrupted mid-announce — try again when idle.
            await self.result_cue.put(spoken)
            return
        self.history.append({"role": "assistant", "content": spoken})
        append_transcript(self.session_id, "cog", spoken)
        if len(self.history) > 20:
            self.history = self.history[-20:]
        await journal(
            {
                "kind": "job",
                "type": "spoken",
                "name": "local-voice",
                "session_id": self.session_id,
                "by": "local-voice",
                "text": spoken[:800],
            }
        )
        await self.send({"type": "agent_response", "text": spoken, "route": "job"})
        await self.send({"type": "status", "state": "listening"})

    async def send(self, payload: dict[str, Any]) -> bool:
        if self.closed:
            return False
        try:
            await self.ws.send_json(payload)
            return True
        except Exception as err:  # noqa: BLE001
            self.closed = True
            log(f"ws send failed: {err}")
            return False

    async def interrupt(self, reason: str = "barge_in") -> None:
        """Stop current turn: mute playback, cancel unfinished sync tools/speech.

        Background jobs keep running. Tools that already finished keep side effects.
        Queued job result cues stay queued and speak when idle again.
        """
        if not self.busy and not (self.turn_task and not self.turn_task.done()):
            return
        log(f"interrupt ({reason})")
        self.cancel.set()
        await self.send({"type": "interruption"})
        task = self.turn_task
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as err:  # noqa: BLE001
                log(f"interrupt await turn: {err}")
        self.turn_task = None
        self.busy = False
        # Keep any speech we already heard over him for the next turn.
        if self.barge_buf.size > 0:
            self.audio_buf = self.barge_buf.copy()
            self.in_speech = True
            self.speech_ms = max(self.speech_ms, self.barge_ms)
            self.silence_ms = 0.0
            self.barge_buf = np.zeros(0, dtype=np.float32)
            self.barge_ms = 0.0
        # Keep history honest — he did not finish what he was saying.
        if self._partial_reply.strip():
            note = self._partial_reply.strip()
            if not note.endswith("…"):
                note += "…"
            self.history.append(
                {
                    "role": "assistant",
                    "content": f"{note} (interrupted)",
                }
            )
            if len(self.history) > 20:
                self.history = self.history[-20:]
        self._partial_reply = ""
        await journal(
            {
                "kind": "conversation",
                "type": "interrupt",
                "name": "local-voice",
                "session_id": self.session_id,
                "by": "local-voice",
                "reason": reason,
            }
        )
        self.cancel.clear()
        await self.send({"type": "status", "state": "listening"})
        self._kick_deliver()

    async def recover_turn(self, why: str) -> None:
        """Stay on the line and say something when a turn blows up."""
        if self.closed or self.cancelled():
            return
        line = "Hold up — I blanked for a second. Say that again?"
        log(f"recovering turn ({why}): {line}")
        await journal(
            {
                "kind": "conversation",
                "type": "recover",
                "name": "local-voice",
                "session_id": self.session_id,
                "by": "local-voice",
                "reason": why[:500],
                "text": line,
            }
        )
        try:
            await self.send({"type": "status", "state": "speaking"})
            await self.speak(line)
            if not self.cancelled():
                await self.send({"type": "agent_response", "text": line})
                await self.send({"type": "status", "state": "listening"})
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            log(f"recover failed: {err}")
            self.closed = True

    async def ensure_memory_brief(self) -> None:
        if self._brief_loaded:
            return
        self._brief_loaded = True
        try:
            brief = await memory_bridge.memory_brief()
            if brief.get("ok") and brief.get("text"):
                self.memory_brief = str(brief["text"])[:4500]
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
        # Style exemplars first — then the real chat. Marked so Cog doesn't treat them as Jake.
        messages.extend(VOICE_FEWSHOT)
        messages.extend(self.history[-16:])
        return messages

    def transcript_text(self) -> str:
        lines = []
        for msg in self.history:
            role = "Jake" if msg.get("role") == "user" else "Cog"
            lines.append(f"{role}: {msg.get('content') or ''}")
        return "\n".join(lines)

    async def persist_session(self) -> None:
        if getattr(self, "_persisted", False):
            return
        user_turns = sum(1 for m in self.history if m.get("role") == "user")
        if user_turns < 2:
            return
        self._persisted = True
        try:
            title = f"Cog chat {time.strftime('%Y-%m-%d %H:%M')}"
            result = await memory_bridge.save_session(self.transcript_text(), title=title)
            log(f"session save: {result.get('ok')} {result.get('error') or ''}".strip())
        except Exception as err:  # noqa: BLE001
            self._persisted = False
            log(f"session save failed: {err}")

    def _start_turn(self, coro) -> None:
        """Run a turn in the background so mic audio keeps arriving (barge-in)."""
        if self.turn_task and not self.turn_task.done():
            return
        self.cancel.clear()
        self.busy = True
        self._partial_reply = ""

        async def _runner() -> None:
            try:
                await coro
            except asyncio.CancelledError:
                log("turn cancelled")
                raise
            except Exception as err:  # noqa: BLE001
                log(f"turn failed: {err}")
                if not self.cancelled():
                    await self.recover_turn(str(err) or "exception")
            finally:
                if not self.cancel.is_set():
                    self.busy = False
                self.turn_task = None
                self.prefer_background = False
                # After any turn, try to speak finished background work.
                self._kick_deliver()

        self.turn_task = asyncio.create_task(_runner())

    async def on_audio(self, b64: str) -> None:
        samples = pcm16_b64_to_float32(b64)
        if samples.size == 0:
            return
        energy = rms_energy(samples)
        duration_ms = 1000.0 * samples.size / SAMPLE_RATE_IN

        # While Cog is thinking/speaking, listen for barge-in.
        if self.busy:
            if energy >= BARGE_ENERGY:
                self.barge_ms += duration_ms
                self.barge_buf = np.concatenate([self.barge_buf, samples])
                if self.barge_ms >= BARGE_MS:
                    await self.interrupt(reason="barge_in")
                    # interrupt() already folded barge_buf into audio_buf
            else:
                self.barge_ms = max(0.0, self.barge_ms - duration_ms * 0.6)
                if self.barge_ms <= 0:
                    self.barge_buf = np.zeros(0, dtype=np.float32)
            return

        if energy >= ENERGY_THRESH:
            self.in_speech = True
            self.speech_ms += duration_ms
            self.silence_ms = 0.0
            self.audio_buf = np.concatenate([self.audio_buf, samples])
        elif self.in_speech:
            self.silence_ms += duration_ms
            self.audio_buf = np.concatenate([self.audio_buf, samples])
            if self.silence_ms >= SILENCE_MS and self.speech_ms >= MIN_SPEECH_MS:
                self._start_turn(self._finish_user_turn())

        # Cap buffer so we don't grow forever on noise.
        max_samples = SAMPLE_RATE_IN * 30
        if self.audio_buf.size > max_samples:
            self.audio_buf = self.audio_buf[-max_samples:]
        if self.barge_buf.size > max_samples:
            self.barge_buf = self.barge_buf[-max_samples:]

    async def _finish_user_turn(self) -> None:
        clip = self.audio_buf.copy()
        self.audio_buf = np.zeros(0, dtype=np.float32)
        self.in_speech = False
        self.speech_ms = 0.0
        self.silence_ms = 0.0
        await self.send({"type": "status", "state": "thinking"})
        text = await asyncio.to_thread(transcribe, clip)
        if self.cancelled():
            return
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
            if not self.cancelled():
                await self.send({"type": "agent_response", "text": greet})
                await self.send({"type": "status", "state": "listening"})
            return
        self.history.append({"role": "user", "content": text})
        await self.reply_from_history()

    async def on_text(self, text: str) -> None:
        line = (text or "").strip()
        if not line:
            return
        if self.busy:
            await self.interrupt(reason="typed_over")
        self._start_turn(self._run_text_turn(line))

    async def _run_text_turn(self, line: str) -> None:
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
            if not self.cancelled():
                await self.send({"type": "agent_response", "text": greet})
                await self.send({"type": "status", "state": "listening"})
            return
        self.history.append({"role": "user", "content": line})
        await self.reply_from_history()

    async def reply_from_history(self) -> None:
        if self.cancelled():
            return
        await self.ensure_memory_brief()
        if self.cancelled():
            return

        last_user = ""
        for msg in reversed(self.history):
            if msg.get("role") == "user":
                last_user = msg.get("content") or ""
                break

        want_status = needs_agent_status(last_user)
        want_start = needs_agent_start(last_user)
        want_agents = want_status or want_start or needs_agent_tools(last_user)
        # Keep factual/status asks on the fast path so honesty rewrite can run before speech.
        use_think = needs_thinking(last_user) and not want_agents
        # Agent status questions win over "background dig" keyword collisions.
        want_jobs = needs_job_tools(last_user) and not want_agents
        # Pure memory Q&A stays sync. Mixed "dig in background + joke" is want_jobs.
        force_memory = needs_memory_tools(last_user) and not want_jobs and not want_agents
        use_tools = force_memory or want_agents
        if want_start and not want_status:
            force_kind = "agents_start"
        elif want_agents:
            force_kind = "agents"
        else:
            force_kind = "memory"
        model = cog_llm.active_model(use_think)
        self.prefer_background = want_jobs
        tools_used = False
        log(
            f"route -> {'think' if use_think else 'fast'} / {cog_llm.backend()} ({model})"
            + (" +memory-tools" if force_memory else "")
            + (" +agent-tools" if want_agents else "")
            + (f"/{force_kind}" if want_agents else "")
            + (" +background-job" if want_jobs else "")
        )
        await journal(
            {
                "kind": "conversation",
                "type": "route",
                "name": "local-voice",
                "session_id": self.session_id,
                "by": "local-voice",
                "reason": "think" if use_think else "fast",
                "meta": {
                    "model": model,
                    "llm_backend": cog_llm.backend(),
                    "memory_tools": force_memory,
                    "agent_tools": want_agents,
                    "agent_force_kind": force_kind if want_agents else None,
                    "job_tools": want_jobs,
                    "prefer_background": want_jobs,
                },
            }
        )
        if self.cancelled():
            return
        await self.send(
            {
                "type": "status",
                "state": "thinking",
                "route": "think" if use_think else "fast",
                "model": model,
            }
        )

        messages = self.build_messages()

        # LASTING PATH: code starts the dig immediately; spoken turn never waits on it.
        if want_jobs:
            query = background_search_query(last_user)
            await self._start_named_job(
                label=f"notes: {query}",
                tool="recall_search",
                args={"query": query, "project": "WorkBuddy", "limit": 8},
            )
            tools_used = True  # dig is real work; chat part must not invent dig results
            if self.cancelled():
                return
            messages.append(
                {
                    "role": "user",
                    "content": (
                        f"(System: A background dig for '{query}' is ALREADY running. "
                        "Do NOT call recall_*, process_*, or wait for results. "
                        "Ack in half a beat — 'On it' — then do the chat/joke part he asked for. "
                        "You will be cued later when the dig finishes. Stay Cog: short, funny. "
                        "Do not invent what the dig found.)"
                    ),
                }
            )
        elif use_tools:
            tool_model = cog_llm.active_model(False)
            try:
                messages = await run_tool_loop(
                    messages,
                    tool_model,
                    force=True,
                    force_kind=force_kind,
                    should_cancel=self.cancelled,
                    execute_tool=self.execute_tool,
                )
                tools_used = True
            except Exception as err:  # noqa: BLE001
                log(f"tool loop failed (continuing without): {err}")
            if self.cancelled():
                return
            if want_agents:
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "Answer Jake out loud as Cog using ONLY the tool results. "
                            "If none are running / list is empty, say that. "
                            "If a tool failed, say you couldn't check. "
                            "NEVER invent agent names, goals, or status. Short spoken answer."
                        ),
                    }
                )
            else:
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "Answer Jake out loud as Cog. Stay in character — short, funny, "
                            "desk-robot. Use what the tools found. For memory questions use Recall; "
                            "for crashes/kills/restarts use the process journal. "
                            "If tools returned nothing, say so — do not invent. "
                            "No human mnemonics. Do not recite tool JSON."
                        ),
                    }
                )

        full = ""
        pending = ""
        filt = ThinkFilter()

        if not use_think:
            # Generate fully first so we can catch bland-assistant collapse before TTS.
            msg = await ollama_chat(messages, model, stream=False)
            if self.cancelled():
                return
            full = strip_thinking((msg.get("content") or "").strip())
            full = await rewrite_if_flat(full, model)
            full = await rewrite_if_ungrounded(
                full, user_text=last_user, model=model, tools_used=tools_used
            )
            if self.cancelled():
                return
            await self.send({"type": "status", "state": "speaking", "route": "fast", "model": model})
            sentences, tail = split_speakable(full + " ")
            for sentence in sentences:
                if self.cancelled():
                    return
                await self.speak(sentence)
            if tail.strip() and not self.cancelled():
                await self.speak(tail.strip())
        else:
            async for chunk in ollama_stream(messages, model, think=True):
                if self.cancelled():
                    return
                visible = filt.feed(chunk)
                if not visible:
                    continue
                if not full and not pending:
                    await self.send(
                        {"type": "status", "state": "speaking", "route": "think", "model": model}
                    )
                full += visible
                pending += visible
                sentences, pending = split_speakable(pending)
                for sentence in sentences:
                    if self.cancelled():
                        return
                    await self.speak(sentence)

            if self.cancelled():
                return
            visible = filt.flush()
            if visible:
                full += visible
                pending += visible
            tail = pending.strip()
            if tail:
                await self.speak(tail)
            full = strip_thinking(full).strip()
            full = await rewrite_if_flat(full, model)
            full = await rewrite_if_ungrounded(
                full, user_text=last_user, model=model, tools_used=tools_used
            )

        if self.cancelled():
            return
        reply = strip_thinking(full).strip()
        if not reply:
            reply = "I lost the thread. One more time?"
            await self.speak(reply)
        if self.cancelled():
            return
        if reply:
            self.history.append({"role": "assistant", "content": reply})
            append_transcript(self.session_id, "cog", reply)
            self._partial_reply = ""
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
        if self.cancelled():
            return
        clean = strip_for_speech(text)
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
            "working memory from recall",
            "where i'm reading",
            "drawing information from",
        )
        if any(b in lowered for b in banned):
            log(f"suppressed context leak: {clean[:80]}")
            return
        self._partial_reply = (self._partial_reply + " " + clean).strip()
        audio = await asyncio.to_thread(synthesize, clean)
        if self.cancelled():
            return
        # Stream in ~200ms chunks so Cog can start playing ASAP.
        frame = int(SAMPLE_RATE_OUT * 0.2)
        for i in range(0, audio.size, frame):
            if self.cancelled():
                return
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
    info = cog_llm.health_label()
    ollama_ok = False
    if info["backend"] == "ollama":
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                r = await client.get(f"{cog_llm.OLLAMA_URL}/api/tags")
                ollama_ok = r.status_code == 200
        except Exception:  # noqa: BLE001
            ollama_ok = False
    return {
        "ok": True,
        "llmBackend": info["backend"],
        "cloudConfigured": info["cloudConfigured"],
        "ollama": ollama_ok,
        "model": info["model"],
        "thinkModel": info["thinkModel"],
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
            "llm": cog_llm.backend(),
            "model": cog_llm.active_model(False),
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
            elif kind in ("interrupt", "interruption"):
                await session.interrupt(reason="client")
            elif kind in ("end", "close"):
                break
    except WebSocketDisconnect:
        pass
    finally:
        session.closed = True
        session.cancel.set()
        if session.turn_task and not session.turn_task.done():
            session.turn_task.cancel()
            try:
                await session.turn_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        try:
            await session.board.cancel_all()
        except Exception:  # noqa: BLE001
            pass
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
