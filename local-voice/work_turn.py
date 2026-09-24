"""One-shot work brain turn (tools/agents/Recall) for PersonaPlex duplex voice.

Uses the same executive + intent gate as full local voice — nothing stripped.
Run from local-voice venv: python work_turn.py "user said this"
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

import intent_gate
import llm as scrappy_llm
import memory_bridge
import owner
import executive

# Reuse tool loop from server without starting the voice server.
from server import run_tool_loop  # noqa: E402


async def execute_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    return await memory_bridge.call_tool(name, args or {})


async def run_turn(user_text: str) -> dict[str, str]:
    text = (user_text or "").strip()
    if not text:
        return {"text": "", "thought": "", "did": "", "result": ""}
    intent = intent_gate.classify(text)
    force_kind = "none"
    if intent.mode == "act":
        if intent.work_kind == "agents_start":
            force_kind = "agents_start"
        elif intent.work_kind in ("agents", "memory"):
            force_kind = intent.work_kind
        else:
            force_kind = "agents"
    if intent.mode != "act" or force_kind == "none":
        return {
            "text": "",
            "thought": "talk",
            "did": "no tool",
            "result": "",
            "skipped": True,
        }
    report = await executive.run(
        intent.goal or text,
        run_tool_loop=run_tool_loop,
        model=scrappy_llm.active_model(False),
        force_kind=force_kind,
        should_cancel=lambda: False,
        execute_tool=execute_tool,
    )
    return report


def main() -> None:
    line = " ".join(sys.argv[1:]).strip()
    if not line and not sys.stdin.isatty():
        line = sys.stdin.read().strip()
    out = asyncio.run(run_turn(line))
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
