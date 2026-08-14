"""Listening dictionary for Scrappy's ears (Wispr Flow-style).

Two layers, applied AFTER Whisper transcribes — not in the system prompt:

1. vocabulary  — names/terms we also feed Whisper as an initial_prompt boost
2. replacements / phrases — fix persistent mishearings (carp → Scrappy)

Edit local-voice/listening-dictionary.json anytime. Changes hot-reload.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
DICT_PATH = Path(
    __import__("os").environ.get(
        "SCRAPPY_LISTENING_DICTIONARY",
        str(ROOT / "listening-dictionary.json"),
    )
)

_cache: dict[str, Any] = {
    "mtime": None,
    "loaded_at": 0.0,
    "data": {"vocabulary": [], "replacements": [], "phrases": []},
}


def _default_data() -> dict[str, Any]:
    return {
        "vocabulary": ["Scrappy", "Chief", "Jake", "Recall", "ArrayBud"],
        "replacements": [
            {"from": "scrapy", "to": "Scrappy"},
            {"from": "crappy", "to": "Scrappy"},
            {"from": "scrabby", "to": "Scrappy"},
        ],
        "phrases": [
            {"from": "scrap he", "to": "Scrappy"},
            {"from": "hey scrap", "to": "hey Scrappy"},
        ],
    }


def load(force: bool = False) -> dict[str, Any]:
    """Load dictionary from disk; hot-reload when the file changes."""
    now = time.time()
    try:
        mtime = DICT_PATH.stat().st_mtime if DICT_PATH.exists() else None
    except OSError:
        mtime = None

    if (
        not force
        and _cache["data"]
        and _cache["mtime"] == mtime
        and now - float(_cache["loaded_at"]) < 2.0
    ):
        return _cache["data"]

    data = _default_data()
    if DICT_PATH.exists():
        try:
            raw = json.loads(DICT_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                data["vocabulary"] = list(raw.get("vocabulary") or data["vocabulary"])
                data["replacements"] = list(raw.get("replacements") or [])
                data["phrases"] = list(raw.get("phrases") or [])
        except (OSError, json.JSONDecodeError):
            pass

    _cache["mtime"] = mtime
    _cache["loaded_at"] = now
    _cache["data"] = data
    return data


def vocabulary_prompt(extra: str = "") -> str:
    """Build a Whisper initial_prompt that boosts dictionary vocabulary."""
    data = load()
    words = [str(w).strip() for w in data.get("vocabulary") or [] if str(w).strip()]
    # Prefer unique, stable order.
    seen: set[str] = set()
    ordered: list[str] = []
    for w in words:
        key = w.lower()
        if key in seen:
            continue
        seen.add(key)
        ordered.append(w)
    base = (
        "Jake talking to Scrappy. Names and words: "
        + ", ".join(ordered[:40])
        + "."
    )
    extra = (extra or "").strip()
    if extra and extra.lower() not in base.lower():
        return f"{base} {extra}"
    return base


def _apply_phrase(text: str, src: str, dst: str) -> str:
    if not src or not dst:
        return text
    # Whole-phrase only — "hey car" must not match inside "hey carp".
    parts = [re.escape(p) for p in src.strip().split() if p]
    if not parts:
        return text
    pattern = re.compile(r"\b" + r"\s+".join(parts) + r"\b", re.I)
    return pattern.sub(dst, text)


def _apply_word(text: str, src: str, dst: str) -> str:
    if not src or not dst:
        return text
    # Whole-word only so we don't smash substrings.
    pattern = re.compile(rf"\b{re.escape(src)}\b", re.I)

    def repl(match: re.Match[str]) -> str:
        token = match.group(0)
        # Preserve ALLCAPS / Title case lightly.
        if token.isupper():
            return dst.upper()
        if token[:1].isupper():
            return dst[:1].upper() + dst[1:]
        return dst

    return pattern.sub(repl, text)


def apply(text: str) -> str:
    """Apply phrase + word replacements to a Whisper transcript."""
    cleaned = (text or "").strip()
    if not cleaned:
        return ""

    data = load()
    # Phrases first (multi-word / wake-style), then single-word replacements.
    phrases = sorted(
        (p for p in data.get("phrases") or [] if isinstance(p, dict)),
        key=lambda p: len(str(p.get("from") or "")),
        reverse=True,
    )
    for entry in phrases:
        cleaned = _apply_phrase(
            cleaned,
            str(entry.get("from") or "").strip(),
            str(entry.get("to") or "").strip(),
        )

    replacements = sorted(
        (r for r in data.get("replacements") or [] if isinstance(r, dict)),
        key=lambda r: len(str(r.get("from") or "")),
        reverse=True,
    )
    for entry in replacements:
        cleaned = _apply_word(
            cleaned,
            str(entry.get("from") or "").strip(),
            str(entry.get("to") or "").strip(),
        )

    # Lone "car" / "card" / "cop" as the whole utterance → Scrappy (wake-ish).
    if re.fullmatch(r"\s*(car|card|cop|cork)\s*[!?.]*\s*", cleaned, flags=re.I):
        punct = re.search(r"[!?.]+$", cleaned.strip())
        cleaned = "Scrappy" + (punct.group(0) if punct else "")

    return re.sub(r"\s{2,}", " ", cleaned).strip()
