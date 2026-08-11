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
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_THINK_MODEL=deepseek-r1:14b
OLLAMA_THINK_MODE=auto
```

Modes:
- `auto` — router picks (recommended)
- `always` — every reply uses the think model
- `off` — never think, fast only

## When auto uses the think brain
Examples: "think about…", "plan…", "debug…", "figure out…", "architecture…", long multi-part questions.

Casual "hey there Cog / how's it going" stays on the fast brain.

## Switch from the tray
Right-click Workbuddy tray → **Switch fast brain** / **Switch think brain** / **Thinking mode**.
