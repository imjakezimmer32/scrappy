"""Work brain. It thinks and uses tools. It does not speak.

The talking model only receives the report this module returns.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable


def distill(messages: list[dict[str, Any]]) -> dict[str, str]:
    thought = ""
    did: list[str] = []
    result = ""
    for msg in messages:
        role = msg.get("role")
        if role == "assistant":
            content = str(msg.get("content") or "").strip()
            if content:
                thought = content.split("\n", 1)[0][:240]
            for call in msg.get("tool_calls") or []:
                fn = (call.get("function") or {}) if isinstance(call, dict) else {}
                name = fn.get("name") or call.get("name")
                if name:
                    did.append(str(name))
        elif role == "tool":
            text = str(msg.get("content") or "").strip()
            if text:
                result = text[:500]
    if not thought:
        thought = "Looked it up."
    did_line = ", ".join(did) if did else "no tool"
    if not result:
        result = thought
    text = f"Thought: {thought}\nDid: {did_line}\nResult: {result}"
    return {"thought": thought, "did": did_line, "result": result, "text": text}


async def run(
    user_text: str,
    *,
    run_tool_loop: Callable[..., Awaitable[list[dict[str, Any]]]],
    model: str,
    force_kind: str,
    should_cancel: Callable[[], bool],
    execute_tool: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]],
) -> dict[str, str]:
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                "You are the work brain, not the voice. "
                "One plain sentence of thought, then the tools. "
                "Do not joke. Do not address the person. "
                "Leave a short result the voice can say."
            ),
        },
        {"role": "user", "content": user_text},
    ]
    done = await run_tool_loop(
        messages,
        model,
        force=True,
        force_kind=force_kind,
        should_cancel=should_cancel,
        execute_tool=execute_tool,
    )
    return distill(done)
