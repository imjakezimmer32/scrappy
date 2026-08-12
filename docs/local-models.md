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

## Ears (speech-to-text)

Cog listens with **faster-whisper** on your CPU (`WHISPER_MODEL` in `.env.local`).

Default is **`medium.en`** — much more accurate than the old `base` model.
Your Ryzen 9 can handle it. First launch after a model change may take a minute while it warms up.

```
WHISPER_MODEL=medium.en   # best local hearing (default)
# WHISPER_MODEL=small.en  # faster, still good
# WHISPER_MODEL=base      # old/fast/poor — avoid
```

Also tunable:
```
COG_VAD_SILENCE_MS=950   # how long to wait after you pause before he answers
COG_VAD_ENERGY=0.008     # how loud you must be to count as speech
```

## Memory (Recall bridge)

Local voice talks to WorkBuddy on `http://127.0.0.1:8787` with your local token:

- Loads a **working memory brief** at call start (WorkBuddy notes, preferences, live speech, task counts)
- When you ask about memory / notes / tasks, Ollama can call `recall_*` tools
- Chats auto-save back into Recall under project **WorkBuddy**
- Transcripts land in `local-voice/logs/`

So “improve your memory” means Cog’s Recall memory — not human mnemonic tips.

## Switch from the tray
Right-click Workbuddy tray → **Switch fast brain** / **Switch think brain** / **Thinking mode**.
