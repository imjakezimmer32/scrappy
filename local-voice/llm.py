"""LLM backends for Cog local voice: Ollama (local) or OpenAI-compatible cloud API."""

from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator

import httpx

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")


def backend() -> str:
    raw = (os.environ.get("COG_LLM_BACKEND") or "auto").strip().lower()
    if raw in ("cloud", "openai", "api"):
        # Soft-fallback to local if Jake hasn't pasted a key yet.
        return "cloud" if _cloud_key() else "ollama"
    if raw in ("ollama", "local"):
        return "ollama"
    # auto: cloud if a key is present
    if _cloud_key():
        return "cloud"
    return "ollama"


def _cloud_key() -> str:
    return (
        os.environ.get("COG_LLM_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or os.environ.get("GROQ_API_KEY")
        or ""
    ).strip()


def _cloud_base() -> str:
    base = (
        os.environ.get("COG_LLM_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or ""
    ).strip()
    if base:
        return base.rstrip("/")
    # Groq key without custom base → Groq endpoint
    if os.environ.get("GROQ_API_KEY") and not os.environ.get("OPENAI_API_KEY"):
        return "https://api.groq.com/openai/v1"
    return "https://api.openai.com/v1"


def cloud_model(think: bool = False) -> str:
    if think:
        return (
            os.environ.get("COG_LLM_THINK_MODEL")
            or os.environ.get("COG_LLM_MODEL")
            or "gpt-4o-mini"
        ).strip()
    return (os.environ.get("COG_LLM_MODEL") or "gpt-4o-mini").strip()


def ollama_model(think: bool = False) -> str:
    if think:
        return os.environ.get("OLLAMA_THINK_MODEL", "deepseek-r1:14b")
    return os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")


def active_model(think: bool = False) -> str:
    return cloud_model(think) if backend() == "cloud" else ollama_model(think)


def _to_openai_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize Ollama-ish history into OpenAI chat messages."""
    out: list[dict[str, Any]] = []
    for msg in messages:
        role = msg.get("role") or "user"
        if role == "tool":
            entry: dict[str, Any] = {
                "role": "tool",
                "content": msg.get("content") or "",
            }
            if msg.get("tool_call_id"):
                entry["tool_call_id"] = msg["tool_call_id"]
            elif msg.get("name"):
                entry["tool_call_id"] = str(msg.get("name"))
            else:
                entry["tool_call_id"] = "tool_0"
            out.append(entry)
            continue

        entry = {"role": role, "content": msg.get("content") or ""}
        tool_calls = msg.get("tool_calls")
        if tool_calls:
            normalized = []
            for i, call in enumerate(tool_calls):
                fn = call.get("function") or {}
                args = fn.get("arguments")
                if isinstance(args, dict):
                    args_s = json.dumps(args)
                else:
                    args_s = str(args or "{}")
                normalized.append(
                    {
                        "id": call.get("id") or f"call_{i}",
                        "type": "function",
                        "function": {
                            "name": fn.get("name") or call.get("name") or "",
                            "arguments": args_s,
                        },
                    }
                )
            entry["tool_calls"] = normalized
            if not entry["content"]:
                entry["content"] = None
        out.append(entry)
    return out


def _from_openai_message(data: dict[str, Any]) -> dict[str, Any]:
    choice = ((data.get("choices") or [{}])[0]) or {}
    msg = choice.get("message") or {}
    tool_calls = msg.get("tool_calls") or []
    normalized = []
    for call in tool_calls:
        fn = call.get("function") or {}
        args_raw = fn.get("arguments") or "{}"
        try:
            args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
        except json.JSONDecodeError:
            args = {"raw": args_raw}
        normalized.append(
            {
                "id": call.get("id"),
                "type": "function",
                "function": {"name": fn.get("name"), "arguments": args},
            }
        )
    out: dict[str, Any] = {
        "role": "assistant",
        "content": msg.get("content") or "",
    }
    if normalized:
        out["tool_calls"] = normalized
    return out


async def chat(
    messages: list[dict[str, Any]],
    *,
    think: bool = False,
    tools: list[dict] | None = None,
    stream: bool = False,
) -> Any:
    if backend() == "cloud":
        return await _cloud_chat(messages, think=think, tools=tools, stream=stream)
    return await _ollama_chat(messages, think=think, tools=tools, stream=stream)


async def stream_text(
    messages: list[dict[str, Any]],
    *,
    think: bool = False,
) -> AsyncIterator[str]:
    gen = await chat(messages, think=think, stream=True)
    async for chunk in gen:
        yield chunk


async def _ollama_chat(
    messages: list[dict[str, Any]],
    *,
    think: bool,
    tools: list[dict] | None,
    stream: bool,
) -> Any:
    model = ollama_model(think)
    url = f"{OLLAMA_URL}/api/chat"
    num_ctx = int(os.environ.get("OLLAMA_NUM_CTX", "8192" if not think else "16384"))
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": stream,
        "options": {
            "temperature": 0.35 if tools else (0.55 if think else 0.75),
            "num_predict": 700 if think else (400 if tools else 140),
            "num_ctx": num_ctx,
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


async def _cloud_chat(
    messages: list[dict[str, Any]],
    *,
    think: bool,
    tools: list[dict] | None,
    stream: bool,
) -> Any:
    key = _cloud_key()
    if not key:
        raise RuntimeError("cloud_llm_missing_key")
    model = cloud_model(think)
    url = f"{_cloud_base()}/chat/completions"
    payload: dict[str, Any] = {
        "model": model,
        "messages": _to_openai_messages(messages),
        "stream": stream,
        "temperature": 0.35 if tools else (0.55 if think else 0.8),
        "max_tokens": 700 if think else (400 if tools else 180),
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }

    if not stream:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code != 200:
                raise RuntimeError(f"cloud_{resp.status_code}: {resp.text[:240]!r}")
            return _from_openai_message(resp.json())

    async def _gen():
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    raise RuntimeError(f"cloud_{resp.status_code}: {body[:240]!r}")
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    if line.startswith(":"):
                        continue
                    if line.startswith("data: "):
                        data_s = line[6:].strip()
                    else:
                        data_s = line.strip()
                    if data_s == "[DONE]":
                        break
                    try:
                        data = json.loads(data_s)
                    except json.JSONDecodeError:
                        continue
                    choice = ((data.get("choices") or [{}])[0]) or {}
                    delta = choice.get("delta") or {}
                    chunk = delta.get("content") or ""
                    if chunk:
                        yield chunk

    return _gen()


def health_label() -> dict[str, Any]:
    return {
        "backend": backend(),
        "model": active_model(False),
        "thinkModel": active_model(True),
        "cloudConfigured": bool(_cloud_key()),
        "baseUrl": _cloud_base() if backend() == "cloud" else OLLAMA_URL,
    }
