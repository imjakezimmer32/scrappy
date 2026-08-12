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


def process_tools() -> list[dict]:
    s = {"type": "string"}
    i = {"type": "integer"}
    return [
        _fn(
            "process_recent",
            "Read Cog's live process journal: starts, stops, kills, restarts, wake events, chat status. Use when Jake asks what crashed, what killed what, or what just happened under the hood.",
            {
                "limit": {**i, "description": "Max events (default 40)"},
                "kind": {**s, "description": 'Optional filter: process, conversation, note, system, job'},
                "type": {**s, "description": "Optional filter e.g. kill, start, exit, wake, user_note"},
            },
        ),
        _fn(
            "process_search",
            "Search the process journal by keyword (kill, local-voice, wake, model switch, etc).",
            {
                "query": {**s, "description": "What to search for"},
                "limit": {**i, "description": "Max matches (default 30)"},
            },
            ["query"],
        ),
        _fn(
            "process_note",
            "WRITE: add a timestamped note into the process journal (for Jake or for yourself about what just happened).",
            {
                "text": {**s, "description": "Note to record"},
                "reason": {**s, "description": "Optional short reason tag"},
            },
            ["text"],
        ),
        _fn(
            "conversation_recent",
            "List recent saved Cog voice conversations (ids + turn counts) for deep analysis.",
            {"limit": {**i, "description": "Max sessions (default 10)"}},
        ),
        _fn(
            "conversation_get",
            "Fetch one conversation transcript by session id from conversation_recent.",
            {
                "id": {**s, "description": "Session id"},
                "max_turns": {**i, "description": "Max turns to include (default 40)"},
            },
            ["id"],
        ),
    ]


def job_tools() -> list[dict]:
    s = {"type": "string"}
    return [
        _fn(
            "job_start",
            (
                "BACKGROUND WORK: kick off a slow tool (Recall search/ask/save, etc.) while you "
                "keep talking. Returns immediately with a job id. When it finishes, you will be "
                "cued to tell Jake — or it waits in a queue if you're still speaking. "
                "Use this when the dig can wait a few seconds and Jake still wants conversation. "
                "Do NOT use for quick process_recent / conversation reads he needs answered now."
            ),
            {
                "label": {
                    **s,
                    "description": "Short human label, e.g. 'search memory for coffee prefs'",
                },
                "tool": {
                    **s,
                    "description": "Which tool to run in the background (recall_search, recall_ask, …)",
                },
                "args_json": {
                    **s,
                    "description": 'JSON object of args for that tool, e.g. {"query":"coffee","project":"WorkBuddy"}',
                },
            },
            ["label", "tool"],
        ),
        _fn(
            "job_status",
            "Check one background job by id (running / done / error + short result).",
            {"id": {**s, "description": "Job id from job_start"}},
            ["id"],
        ),
        _fn(
            "job_list",
            "List recent background jobs for this call (what's cooking / finished).",
            {},
        ),
    ]


def cursor_tools() -> list[dict]:
    s = {"type": "string"}
    i = {"type": "integer"}
    b = {"type": "boolean"}
    return [
        _fn(
            "cursor_list_agents",
            "List Cursor agents Cog knows about. Use when Jake asks what agents exist.",
            {
                "limit": {**i, "description": "How many (default 10)"},
                "running_only": {**b, "description": "If true, only agents working now"},
                "search": {**s, "description": "Optional text filter"},
            },
        ),
        _fn(
            "cursor_running_agents",
            "Agents working right now. Use for 'what's running' / 'background agents'.",
            {"limit": {**i, "description": "How many (default 10)"}},
        ),
        _fn(
            "cursor_list_cloud_agents",
            "List Jake's cloud agents from Cursor (Agents window overview).",
            {
                "limit": {**i, "description": "How many (default 15)"},
                "include_archived": {**b, "description": "Include archived"},
            },
        ),
        _fn(
            "cursor_agent_status",
            "Live status for one agent by id.",
            {"id": {**s, "description": "Agent id"}},
            ["id"],
        ),
        _fn(
            "cursor_agent_details",
            "Deep live check on one agent — prefer when Jake wants details.",
            {"id": {**s, "description": "Agent id"}},
            ["id"],
        ),
        _fn(
            "cursor_open_agent",
            "Open the agent in the browser for Jake.",
            {"id": {**s, "description": "Agent id"}},
            ["id"],
        ),
    ]


def all_tools() -> list[dict]:
    return recall_tools() + process_tools() + job_tools() + cursor_tools()


LOCAL_MEMORY_RULES = """
## YOUR MEMORY — RECALL

Jake's long-term memory of you lives in Recall on this PC. You have tools for it.

When he says "your memory", "remember", "what did I say", or "improve your memory",
he means YOUR Recall notes about him — not human mnemonic tips or sleep advice.

Use Recall like a friend uses things they know. Search when unsure. Quietly save
lasting preferences under project WorkBuddy. Never dump the whole archive out loud.

## YOUR PROCESS JOURNAL

You also have a timestamped process log of yourself: when local-voice starts/stops,
when wake-listener is killed for a call, model switches, auto-restarts, and notes
Jake adds. Tools: process_recent, process_search, process_note, conversation_recent,
conversation_get.

When Jake asks what crashed, what killed what, why you went quiet, or what processes
ran — look it up. Don't guess. Summarize briefly out loud; don't read the whole log.

## BACKGROUND WORK (job_*)

When Jake says dig/search "in the background" / "while that cooks" / keep talking,
the SYSTEM already starts the dig. You just ack briefly and do the chat/joke part.
Do not call recall_* or process_* on those turns, and do not invent dig results —
you'll be cued when the dig finishes (or it waits in a queue if you're busy).

## CURSOR AGENTS (cursor_*)

When Jake asks what agents are running / working / in the background / status —
call cursor_running_agents or cursor_list_agents. Never invent agent names or status.
If tools return empty, say none are running. If a tool errors, say you couldn't check.
""".strip()

