"""Run Scrappy work brain (tools/agents/Recall) while PersonaPlex handles speech."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCAL_PY = ROOT / "local-voice" / ".venv" / "Scripts" / "python.exe"
WORK_TURN = ROOT / "local-voice" / "work_turn.py"


def local_work_available() -> bool:
    return LOCAL_PY.exists() and WORK_TURN.exists()


async def dispatch_work(user_text: str) -> dict | None:
    text = (user_text or "").strip()
    if not text or not local_work_available():
        return None
    env = {**os.environ, "PYTHONUTF8": "1"}
    proc = await asyncio.create_subprocess_exec(
        str(LOCAL_PY),
        str(WORK_TURN),
        text,
        cwd=str(ROOT / "local-voice"),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        err = (stderr or b"").decode("utf-8", errors="ignore")[:400]
        return {"ok": False, "error": err or f"exit_{proc.returncode}"}
    try:
        data = json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError:
        return {"ok": False, "error": "bad_json"}
    if data.get("skipped"):
        return None
    return {"ok": True, "report": data.get("text") or ""}
