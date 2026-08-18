"""Intent gate for Scrappy (architectures A + C).

A — Clarify, then act: decide chat / clarify / act before tools.
C — Two lanes: Talk (speak now) vs Work (tools/agents, maybe in background).

This replaces the old “keyword forces tools” path with an explicit gate.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

import owner

Lane = Literal["talk", "work"]
Mode = Literal["chat", "clarify", "act", "dig"]
WorkKind = Literal["memory", "agents", "agents_start", "none"]


@dataclass
class Intent:
    lane: Lane
    mode: Mode
    work_kind: WorkKind = "none"
    reason: str = ""
    clarify_hint: str = ""
    dig_query: str = ""
    goal: str = ""


WAKE_ONLY = re.compile(
    r"^\s*(hey\s+there|okay\s+then|wake\s+up)\s+scrappy[!?.,\s]*$",
    re.I,
)

CHATTY = re.compile(
    r"\b("
    r"how(?:'s|s| is) it going|what(?:'s|s| is) up|good morning|good night|"
    r"thanks|thank you|you(?:'re| are) (?:funny|dumb|a robot|just)|"
    r"i love you|miss you|throw(?:ing)? (?:you|me)|how many throws|"
    r"what am i doing to you|stop shaking|put (?:you|me) down"
    r")\b",
    re.I,
)

AGENT_START = re.compile(
    r"\b("
    r"start (?:a |an |the )?(?:research |plan |coding )?agent|"
    r"launch (?:a |an |the )?agent|spin up (?:a |an )?agent|"
    r"run a (?:research |plan )?agent|make (?:a |an )?agent"
    r")\b",
    re.I,
)

AGENT_STATUS = re.compile(
    r"\b("
    r"what(?:'s|s| is) running|working in the background|background agents?|"
    r"agent status|list agents|which agents|any agents|"
    r"what agents|agents? (?:do we have|are|running|working)|"
    r"open (?:that |the )?agent|stop (?:that |the )?agent|kill (?:that |the )?agent"
    r")\b",
    re.I,
)

MEMORY_ASK = re.compile(
    r"\b("
    r"your\s+memory|remember(?:\s+this)?|what\s+did\s+i\s+(?:say|tell|ask)|"
    r"recall|open\s+tasks?|action\s+items?|my\s+notes?|search\s+(?:my\s+)?notes?|"
    r"preferences?|process(?:es)?\s+log|what\s+killed|who\s+killed|crashed?"
    r")\b",
    re.I,
)

DIG = re.compile(
    r"\b("
    r"in the background|while (?:that|you) (?:cook|dig|work)|"
    r"keep (?:talking|chatting)|dig (?:into|on)|look into .+ (?:in the )?background"
    r")\b",
    re.I,
)

VAGUE_WORK = re.compile(
    r"\b("
    r"do (?:it|something|that)|fix (?:it|that|this)|handle (?:it|that)|"
    r"look into (?:it|that|this)|figure (?:it|that) out|"
    r"can you (?:help|do)|go ahead|make it happen"
    r")\b",
    re.I,
)

GOAL_AFTER_AGENT = re.compile(
    r"(?:agent|research|plan)\s+(?:on|about|for|to|into)\s+(.+)$",
    re.I,
)


def extract_agent_goal(text: str) -> str:
    m = GOAL_AFTER_AGENT.search((text or "").strip())
    if not m:
        return ""
    goal = m.group(1).strip(" .!?")
    # Too short / pronoun-only = still unclear.
    if len(goal) < 4 or goal.lower() in {"it", "that", "this", "stuff", "things"}:
        return ""
    return goal


def classify_intent(user_text: str, *, pending: dict[str, Any] | None = None) -> Intent:
    """Gate: chat / clarify / act / dig (+ talk vs work lane)."""
    text = (user_text or "").strip()
    if not text or WAKE_ONLY.match(text):
        return Intent("talk", "chat", reason="wake_or_empty")

    # Continuing a prior clarify → treat answer as act when we know the work kind.
    if pending:
        kind = str(pending.get("work_kind") or "none")
        original = str(pending.get("original") or "")
        if kind in ("agents_start", "memory", "agents"):
            combined = f"{original} — {owner.name()} clarified: {text}".strip(" —")
            return Intent(
                "work",
                "act",
                work_kind=kind,  # type: ignore[arg-type]
                reason="clarify_followup",
                goal=text if kind == "agents_start" else "",
                dig_query=combined,
            )
        # Vague work with no kind yet: re-classify the clarification alone.
        # (Fall through with pending cleared by caller after this turn.)
        pending = None

    if DIG.search(text):
        q = text
        m = re.search(r"(?:dig|look into|search)\s+(?:into\s+|on\s+|for\s+)?(.+?)(?:\s+in the background)?$", text, re.I)
        if m:
            q = m.group(1).strip(" .")
        return Intent("work", "dig", work_kind="memory", reason="background_dig", dig_query=q or text)

    if AGENT_START.search(text):
        goal = extract_agent_goal(text)
        if not goal:
            return Intent(
                "talk",
                "clarify",
                work_kind="agents_start",
                reason="agent_start_unclear",
                clarify_hint="On what — and how deep do you want it?",
            )
        return Intent("work", "act", work_kind="agents_start", reason="agent_start_clear", goal=goal)

    if AGENT_STATUS.search(text):
        return Intent("work", "act", work_kind="agents", reason="agent_status")

    if MEMORY_ASK.search(text):
        # Bare "remember this" / "search my notes" without topic → clarify.
        if re.fullmatch(r".*\b(remember this|search(?: my)? notes|what about my notes)\b.*", text, re.I) and len(text) < 28:
            return Intent(
                "talk",
                "clarify",
                work_kind="memory",
                reason="memory_unclear",
                clarify_hint="What should I remember or look up?",
            )
        return Intent("work", "act", work_kind="memory", reason="memory_ask")

    if VAGUE_WORK.search(text) and len(text) < 80:
        return Intent(
            "talk",
            "clarify",
            work_kind="none",
            reason="vague_work",
            clarify_hint="What exactly do you want me to do?",
        )

    if CHATTY.search(text) or len(text) < 12:
        return Intent("talk", "chat", reason="chatty")

    # Default: talk lane. Work only when signals are clear.
    return Intent("talk", "chat", reason="default_chat")
