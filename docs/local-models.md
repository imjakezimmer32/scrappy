# Dual-brain Cog (fast + think)

## Quality first (standing rule)

Jake’s rule: **do not rush Cog.** Prefer careful settings and careful build
decisions over “fast enough.” Hearing, personality, tools, and architecture
should optimize for being right — not for finishing first.

## How it works

```
You talk
   ↓
Router (auto)
   ├─ casual / short  → Fast brain → spoken reply
   └─ hard / "think"  → Think brain → reason silently → speak answer only
```

Thinking traces are stripped so Cog does **not** read his homework out loud.

## Defaults

```
VOICE_BACKEND=local
COG_LLM_BACKEND=cloud
COG_LLM_MODEL=gpt-4o
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_THINK_MODE=auto
```

Prefer **cloud** for the brain (see `docs/cloud-brain.md`). Local 7B is only a
fallback when cloud is unavailable — not the quality target.

Modes:
- `auto` — router picks (recommended)
- `always` — every reply uses the think model
- `off` — never think, fast path only

## When auto uses the think brain
Examples: "think about…", "plan…", "debug…", "figure out…", "architecture…", long multi-part questions.

Casual "hey there Cog / how's it going" stays on the fast brain.

## Ears (speech-to-text)

Cog listens with **faster-whisper** on your CPU.

Default is **`large-v3`** with careful decode settings (`int8_float32`, beam 8).
This is slower than tiny models on purpose — hearing Jake correctly matters more
than answering in a hurry. First launch after a model change can take a few
minutes while it downloads/warms.

```
WHISPER_MODEL=large-v3
WHISPER_COMPUTE=int8_float32
WHISPER_BEAM=8
```

Avoid `base` / `small` unless Jake explicitly asks for a temporary speed trade.

Also tunable:
```
COG_VAD_SILENCE_MS=1300   # wait after a pause before he answers (higher = more patient)
COG_VAD_ENERGY=0.008      # how loud you must be to count as speech
COG_TOOL_ROUNDS=6         # how many tool steps he may take when digging
```

## Listening dictionary (Wispr-style)

Persistent mishearings (Cog → carp/car) are fixed in
`local-voice/listening-dictionary.json` **after** Whisper, before Cog thinks.
See `docs/listening-dictionary.md`. Edit the JSON anytime — it hot-reloads.

## Memory (Recall bridge)

Local voice talks to WorkBuddy on `http://127.0.0.1:8787` with your local token:

- Loads a **working memory brief** at call start (WorkBuddy notes, preferences, live speech, task counts)
- When you ask about memory / notes / tasks, the model can call `recall_*` tools
- Chats auto-save back into Recall under project **WorkBuddy** (deduped)
- Transcripts land in `local-voice/logs/`

So “improve your memory” means Cog’s Recall memory — not human mnemonic tips.

## Switch from the tray
Right-click Workbuddy tray → **Switch fast brain** / **Switch think brain** / **Thinking mode**.
