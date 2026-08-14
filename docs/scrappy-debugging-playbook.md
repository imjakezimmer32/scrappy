# Scrappy Self-Debugging Playbook

This guide teaches Scrappy (and Jake) how to investigate and fix Scrappy issues without waiting for a human developer every time.

## Core rule — never quit early

Before Scrappy says he **cannot** do something, he must exhaust research and available capabilities:

1. **Try the direct path** — the obvious tool or action for the request.
2. **Try alternatives** — other tools, workarounds, or a Cursor plan/research agent if the direct path fails.
3. **Check context** — Recall notes, chat history, system info, live agent status, README, and `docs/`.
4. **Only then** say it is not possible — and explain what was tried, what failed, and the best alternative Jake can use.

Example: Jake asks to check an agent. Direct tool fails → try `cursor_agent_details` → try `cursor_list_agents` → try starting a research agent → only then report the blocker with next steps.

**Saying "I can't" without steps 1–3 is not allowed.**

## When to use this

Use this playbook when Jake reports:

- "Scrappy says my agent is still working but it's done"
- "Scrappy stopped talking mid-sentence"
- "Scrappy didn't walk over when my agent finished"
- "Something feels stuck or wrong with status"

## Step 1 — Name the symptom in plain English

Write one sentence: **what Jake expected** vs **what actually happened**.

Example: "Jake asked if the plan agent finished. Scrappy said Working, but Cursor shows Done."

## Step 2 — Pick the subsystem

| Symptom | Likely area | Key files |
|--------|-------------|-----------|
| Wrong agent status | Live status + registry | `cursor-agents.js`, `cursor-agent-status.js` |
| Agent hung forever | Run timeout | `cursor-agent-status.js` (`waitWithTimeout`) |
| No desk nudge | Cursor hooks → `/agent-done` | `scripts/scrappy-agent-done.ps1`, `main.js` |
| Scrappy cut off mid-sentence | Voice playback gaps | `renderer/voice.js` (`scheduleSpeakEnd`) |
| Voice tool hung | Blocking IPC | `main.js` (`continue` → background) |

## Step 3 — Gather evidence (read-only first)

1. **Check saved agent list** — `%APPDATA%/scrappy/cursor-agents.json`
2. **Ask for live status** — use `cursor_agent_details` (always hits Cursor API)
3. **Compare to Cursor UI** — cloud agents at https://cursor.com/agents
4. **Check Scrappy is listening** — `http://127.0.0.1:8787/token` (when app is running)
5. **Run tests** — `npm test` (status logic without Electron)

## Step 4 — Common fixes Scrappy can start

### Stale "Working" status

1. Run `cursor_agent_details` with the agent id
2. If stale, use `cursor_restart_agent` or `cursor_continue_agent`
3. After a Scrappy update, restart Scrappy once (startup reconcile runs automatically)

### Agent run too long

Set in `.env.local`:

```env
CURSOR_AGENT_RUN_TIMEOUT_MS=3600000
CURSOR_AGENT_STALE_MS=900000
```

### No nudge when agent finishes

1. Reinstall hooks: `npm run install-hooks`
2. Make sure Scrappy is running before Cursor sessions
3. Tune minimum nudge time: `SCRAPPY_NUDGE_MIN_DURATION_MS=60000` (1 minute)

### Scrappy stops talking mid-sentence

Usually a gap between audio chunks. Fixed in `renderer/voice.js` with a grace timer — if it returns, increase `SPEAK_END_GRACE_MS` or check long client-tool calls blocking playback.

## Step 5 — Make a small, testable change

Rules for Scrappy-started **implementation** agents:

1. **Plan first** unless Jake explicitly says "implement" or "fix it"
2. **One bug per change** — status accuracy separate from voice separate from hooks
3. **Add or update a test** in `test/` when changing logic in `cursor-agent-status.js`
4. **Run `npm test`** before saying done
5. **Tell Jake simply** — what was wrong, what you changed, what to try

## Step 6 — Verify like Jake would

1. Start a small plan/research agent via voice
2. Ask "is it done?" twice — once while running, once after
3. Start a voice call and listen for a full sentence without dropping to idle
4. Optional: tray → test nudge (`force: true`)

## Step 7 — Teach-back (so Scrappy learns)

After fixing something, Scrappy should save a short Recall note:

- **Title:** `Scrappy fix: <symptom>`
- **Summary:** symptom, root cause, file changed, how to verify
- **Tags:** `scrappy,scrappy,debug`

Next time Jake mentions the same symptom, search Recall first.

## Config cheat sheet

| Variable | Default | Meaning |
|----------|---------|---------|
| `CURSOR_AGENT_RUN_TIMEOUT_MS` | `0` (off) | Max time one agent run may wait |
| `CURSOR_AGENT_STALE_MS` | `900000` (15 min) | When saved "running" is treated as stuck |
| `SCRAPPY_NUDGE_MIN_DURATION_MS` | `120000` (2 min) | Minimum session length before Scrappy walks over |
| `SCRAPPY_CURSOR_AGENTS` | `on` | Master switch for Cursor agent tools |

## Escalation

Hand off to a human developer when:

- `@cursor/sdk` API shape changed and live checks always fail
- Hooks never fire (Cursor hook config outside Scrappy)
- ElevenLabs voice session drops entirely (WebSocket/auth issue)

Otherwise: follow steps 1–7 and iterate. **Do not stop at the first failure** — try alternate tools and paths from the core rule above first.
