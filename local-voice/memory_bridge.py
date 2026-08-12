"""WorkBuddy ↔ local-voice memory bridge (HTTP to Electron on :8787)."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx

WORKBUDDY_URL = os.environ.get("WORKBUDDY_URL", "http://127.0.0.1:8787").rstrip("/")
TOKEN_CANDIDATES = [
    os.environ.get("WORKBUDDY_TOKEN", ""),
    str(Path(__file__).resolve().parent.parent / "local-token.txt"),
    str(Path(os.environ.get("APPDATA", "")) / "workbuddy" / "local-token.txt"),
]


def _token() -> str:
    env = os.environ.get("WORKBUDDY_TOKEN", "").strip()
    if env:
        return env
    for cand in TOKEN_CANDIDATES[1:]:
        try:
            p = Path(cand)
            if p.exists():
                return p.read_text(encoding="utf-8").strip()
        except OSError:
            continue
    return ""


async def memory_brief() -> dict[str, Any]:
    token = _token()
    if not token:
        return {"ok": False, "error": "no_token"}
    url = f"{WORKBUDDY_URL}/local/memory-brief"
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url, headers={"Authorization": f"Bearer {token}"})
        if r.status_code != 200:
            return {"ok": False, "error": f"http_{r.status_code}", "text": r.text[:300]}
        return r.json()


async def call_tool(name: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
    token = _token()
    if not token:
        return {"ok": False, "error": "no_token"}
    url = f"{WORKBUDDY_URL}/local/tool"
    payload = {"tool": name, "args": args or {}}
    async with httpx.AsyncClient(timeout=90.0) as client:
        r = await client.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            content=json.dumps(payload),
        )
        if r.status_code != 200:
            return {"ok": False, "error": f"http_{r.status_code}", "text": r.text[:300]}
        return r.json()


async def save_session(transcript: str, title: str | None = None) -> dict[str, Any]:
    token = _token()
    if not token or not transcript.strip():
        return {"ok": False, "error": "skip"}
    url = f"{WORKBUDDY_URL}/local/save-session"
    payload = {
        "title": title or "Cog chat",
        "transcript": transcript[:12000],
        "summary": transcript[:1500],
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            content=json.dumps(payload),
        )
        if r.status_code != 200:
            return {"ok": False, "error": f"http_{r.status_code}"}
        return r.json()


async def system_context() -> dict[str, Any]:
    token = _token()
    if not token:
        return {"ok": False, "error": "no_token"}
    url = f"{WORKBUDDY_URL}/local/system-context"
    async with httpx.AsyncClient(timeout=8.0) as client:
        r = await client.get(url, headers={"Authorization": f"Bearer {token}"})
        if r.status_code != 200:
            return {"ok": False, "error": f"http_{r.status_code}"}
        return r.json()


async def process_event(event: dict[str, Any]) -> dict[str, Any]:
    token = _token()
    if not token:
        return {"ok": False, "error": "no_token"}
    url = f"{WORKBUDDY_URL}/local/process-event"
    async with httpx.AsyncClient(timeout=8.0) as client:
        r = await client.post(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            content=json.dumps(event),
        )
        if r.status_code != 200:
            return {"ok": False, "error": f"http_{r.status_code}"}
        return r.json()
