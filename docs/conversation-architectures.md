# Conversation architectures A + C

How Cog decides what to do after he hears you.

## Pipeline

1. **Ears** — Whisper + listening dictionary (unchanged)
2. **Intent gate (A)** — `chat` / `clarify` / `act` / `dig`
3. **Lanes (C)**
   - **Talk** — speak now; no tools (`chat`, `clarify`)
   - **Work** — tools / agents / background dig (`act`, `dig`); Talk can still ack while dig runs

## Modes

| Mode | Lane | Tools? | Example |
|------|------|--------|---------|
| chat | Talk | No | "how's it going", throw jokes |
| clarify | Talk | No | "start an agent" with no topic |
| act | Work | Yes | "what's running", "search my notes for X" |
| dig | Work + Talk | Background | "dig into preferences in the background and tell a joke" |

## Clarify follow-up

If Cog asks a clarifying question, the next thing you say is treated as the answer and Work runs (when the work kind was known).

## Code

- Gate: `local-voice/intent_gate.py`
- Reply path: `Session.reply_from_history` in `local-voice/server.py`
