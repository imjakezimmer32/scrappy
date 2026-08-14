# Process + conversation logs

Scrappy now keeps a timestamped diary of **everything that runs**, not just chat text.

## Where it lives

- `process-logs/YYYY-MM-DD.jsonl` — today’s full timeline (starts, stops, kills, restarts, chat, your notes)
- `process-logs/latest.jsonl` — same events, easy to open
- `process-logs/ADD-NOTE-HERE.txt` — **you type notes here**
- `conversations/` — one folder per voice call (full transcript + summary)

## How to add your own note (easiest)

1. Right-click the Scrappy tray icon  
2. Click **Add note to process log…**  
3. Notepad opens — type under the `#` lines, **Save**  
4. Within a few seconds Scrappy pulls it into the log

Or open the folder from tray → **Open process logs folder**.

## How to read it

```
npm run process-log
```

You’ll see lines like:

```
2026-08-12T00:51:02.100Z  [process/kill]  local-voice pid=1234 (switch fast brain) kills=[local-voice:1234]
2026-08-12T00:51:04.200Z  [process/start] local-voice pid=5678 (restart after fast brain)
2026-08-12T00:52:11.000Z  [note/user_note] jake :: Voice felt stuck after model switch
```

That `kills=[...]` line is how you see **what stopped what**.

## Scrappy can read this too

Ask him out loud:
- “What just killed local voice?”
- “Check the process log.”
- “What conversations did we save today?”

He has tools: `process_recent`, `process_search`, `process_note`, `conversation_recent`, `conversation_get`.

## Background jobs

Scrappy can dig (Recall search, etc.) **while still talking to you**. When the dig finishes:

- If he’s free → he speaks the result
- If he’s mid-sentence / mid-turn → it waits in a **cue** and he pipes up when idle

Those show up in the journal as `kind: job` (`start` / `done` / `error` / `spoken`). Ask: “what’s cooking?” or “job status.”

## What gets recorded automatically

- Scrappy / local-voice / wake-listener **start, stop, kill, exit, auto-restart**
- Why it happened (`by` + `reason`) — tray, auto-restart, voice call, quit, etc.
- Conversation beats: what you said, what Scrappy said, model route, tools, rewrites, recoveries
- Background job start/finish/spoken cues
- Notes you add by hand
