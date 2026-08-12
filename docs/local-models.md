# Dual-brain Cog (fast + think)

## How it works

```
You talk
   ↓
Router (auto)
   ├─ casual / short  → Fast brain (qwen2.5:7b) → quick spoken reply
   └─ hard / "think"  → Think brain (deepseek-r1:14b) → reason silently → speak answer only
```

Thinking traces are stripped so Cog does **not** read his homework out loud.

## Defaults

```
VOICE_BACKEND=local
COG_LLM_BACKEND=cloud
COG_LLM_MODEL=gpt-4o-mini
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_THINK_MODE=off
```

Prefer **cloud** for the brain (see `docs/cloud-brain.md`). Local 7B is only a lightweight fallback.

Modes:
- `auto` — router picks (recommended)
- `always` — every reply uses the think model
- `off` — never think, fast only

## When auto uses the think brain
Examples: "think about…", "plan…", "debug…", "figure out…", "architecture…", long multi-part questions.

Casual "hey there Cog / how's it going" stays on the fast brain.

## Memory (Recall bridge)

Local voice talks to WorkBuddy on `http://127.0.0.1:8787` with your local token:

- Loads a **working memory brief** at call start (WorkBuddy notes, preferences, live speech, task counts)
- When you ask about memory / notes / tasks, Ollama can call `recall_*` tools
- Chats auto-save back into Recall under project **WorkBuddy**
- Transcripts land in `local-voice/logs/`

So “improve your memory” means Cog’s Recall memory — not human mnemonic tips.

## Switch from the tray
Right-click Workbuddy tray → **Switch fast brain** / **Switch think brain** / **Thinking mode**.
