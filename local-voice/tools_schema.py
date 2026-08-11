"""Ollama tool schemas for Cog's local Recall access."""

from __future__ import annotations


def _fn(name: str, description: str, properties: dict, required: list[str] | None = None) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required or [],
            },
        },
    }


def recall_tools() -> list[dict]:
    s = {"type": "string"}
    i = {"type": "integer"}
    return [
        _fn(
            "recall_search",
            "Search Jake's Recall notes and repo brains. Use for facts, preferences, past decisions, and what he said before.",
            {
                "query": {**s, "description": "What to look for"},
                "limit": {**i, "description": "Max results (default 8)"},
                "project": {**s, "description": "Optional project filter, e.g. WorkBuddy"},
                "brain": {**s, "description": 'Optional brain id like "notes" or "repo::workbuddy"'},
            },
            ["query"],
        ),
        _fn(
            "recall_ask",
            "Ask a natural-language question against Jake's notes and get an answer grounded in them.",
            {"question": {**s, "description": "Question to answer from notes"}},
            ["question"],
        ),
        _fn(
            "recall_recent",
            "Newest notes. Use project WorkBuddy for Cog relationship memory.",
            {
                "limit": {**i, "description": "Max notes (default 8)"},
                "project": {**s, "description": "Optional project filter"},
            },
        ),
        _fn(
            "recall_live_context",
            "What Jake said out loud recently from live Recall recording.",
            {"minutes": {**i, "description": "Minutes back (default 15)"}},
        ),
        _fn(
            "recall_open_actions",
            "Open tasks from Recall Tasks board. Always trust total_open for counts.",
            {
                "limit": {**i, "description": "Max rows (default 20)"},
                "project": {**s, "description": "Optional project filter"},
            },
        ),
        _fn(
            "recall_get_note",
            "Fetch one note in full by id.",
            {"id": {**s, "description": "Note id"}},
            ["id"],
        ),
        _fn(
            "recall_save_note",
            "WRITE: save a lasting preference, decision, or relationship fact. Prefer project WorkBuddy with tags cog,relationship,preference.",
            {
                "title": {**s, "description": "Short title"},
                "summary": {**s, "description": "Note body"},
                "tags": {**s, "description": "Comma-separated tags"},
                "project": {**s, "description": "Project, e.g. WorkBuddy"},
            },
            ["title", "summary"],
        ),
        _fn(
            "recall_complete_action",
            "WRITE: check off a finished task. Pass note_id and exact text from recall_open_actions.",
            {
                "note_id": {**s, "description": "Note id"},
                "text": {**s, "description": "Exact action text"},
            },
            ["note_id", "text"],
        ),
    ]


LOCAL_MEMORY_RULES = """
## YOUR MEMORY — RECALL (LOCAL VOICE MODE)

Jake's long-term memory lives in Recall on this PC. You have tools for it. Use them.

When Jake says "your memory", "remember", "what did I say", "improve your memory",
or asks about past preferences/decisions, he means YOUR Recall memory of him —
NOT human brain mnemonics, sleep tips, or generic self-help.

Rules:
1. Search or ask Recall before inventing relationship facts.
2. If memory feels thin, call recall_search / recall_recent / recall_ask first.
3. Quietly save lasting preferences with recall_save_note under project WorkBuddy.
4. Never recite the whole memory dump. Use it the way a friend uses things they know.
5. Keep spoken replies short (1-3 sentences) unless Jake wants detail.
""".strip()
