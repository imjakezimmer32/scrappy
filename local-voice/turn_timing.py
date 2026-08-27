"""Turn-timing helpers for local voice.

Keeps VAD silence, rewrite skips, and stream-vs-wait decisions in one place
so they can be unit-tested without Whisper or Kokoro.
"""

from __future__ import annotations

import os
import re

# Patient default for long thoughts. Short utterances use SHORT_SILENCE_MS.
SILENCE_MS = int(os.environ.get("SCRAPPY_VAD_SILENCE_MS", "1300"))
SHORT_SILENCE_MS = int(os.environ.get("SCRAPPY_VAD_SHORT_SILENCE_MS", "800"))
# Start Whisper while still waiting for the rest of the silence.
SPECULATIVE_MS = int(os.environ.get("SCRAPPY_VAD_SPECULATIVE_MS", "600"))
# Speech longer than this keeps the patient silence (don't clip "and also…").
LONG_SPEECH_MS = float(os.environ.get("SCRAPPY_VAD_LONG_SPEECH_MS", "2500"))
# Talk-lane replies at or under this length skip serial quality rewrites.
SHORT_TALK_CHARS = int(os.environ.get("SCRAPPY_SHORT_TALK_CHARS", "160"))

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

WAKE_ONLY = re.compile(
    r"^\s*(hey\s+there|okay\s+then|wake\s+up)\s+scrappy[!?.,\s]*$",
    re.I,
)


def needs_factual_grounding(user_text: str) -> bool:
    text = (user_text or "").strip()
    if not text or WAKE_ONLY.match(text):
        return False
    return bool(FACTUAL_ASK.search(text))


def silence_needed_ms(speech_ms: float) -> int:
    """Shorter hang-up after a quick line; keep 1300ms after a long thought."""
    if speech_ms >= LONG_SPEECH_MS:
        return SILENCE_MS
    return min(SILENCE_MS, SHORT_SILENCE_MS)


def skip_talk_rewrites(
    *,
    mode: str,
    lane: str,
    reply: str,
    user_text: str,
    tools_used: bool,
) -> bool:
    """Skip flat/ungrounded rewrite trips on short casual talk."""
    if tools_used:
        return False
    if mode != "chat" or lane != "talk":
        return False
    if needs_factual_grounding(user_text):
        return False
    return len((reply or "").strip()) <= SHORT_TALK_CHARS


def stream_before_rewrite(
    *,
    mode: str,
    lane: str,
    user_text: str,
    tools_used: bool,
) -> bool:
    """Speak the first sentence as tokens arrive, unless honesty rewrite must run first."""
    if tools_used:
        return True
    if needs_factual_grounding(user_text):
        return False
    return True
