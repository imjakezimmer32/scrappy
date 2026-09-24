# Manual QA (Windows) — run before each public release

You cannot run this in CI from Linux; **Jake runs this on a real Windows PC** after merging.

## A. Fresh install (clean machine or VM)

1. Download **Scrappy-Setup.exe** from [latest release](https://github.com/imjakezimmer32/scrappy/releases/latest).
2. Install → app should appear above taskbar within ~30s.
3. Within ~2 minutes: setup window should open once (if you have no keys).
4. Close setup without saving → right-click Scrappy → **Set up Scrappy…** opens again.
5. Save your name only → he should use it without restarting the app.

## B. ElevenLabs voice path

1. Setup: cloud brain + ElevenLabs key → Save.
2. **Build his voice agent** → success message (no restart required).
3. Tray → **Talk to Scrappy** → say a full sentence → hear reply + mouth meter.
4. Click him → type a message → hear reply.

## C. Local voice path

1. Setup → voice **Local** → **Install local voice stack** (wait; can take many minutes first time).
2. Ensure Ollama is installed; pull model if prompted.
3. Quit and relaunch OR wait for “voice ready” → **Talk to Scrappy**.
4. Full sentence in → hear Kokoro TTS out of speakers (check Volume mixer for Scrappy).

## D. Updates

1. Install an older build (or lower version in package for dev).
2. Launch → wait ~1 min → optional bubble about update OR tray shows **Install update**.
3. **Install update** → installer runs → app quits → new version runs.
4. **Check for updates** when already current → “I'm current” style message.

## E. Quit & processes

1. Tray → **Quit**.
2. Task Manager: no lingering `python.exe` (local voice), PowerShell wake listener, or extra Scrappy processes.

## F. Cursor integration

1. Tray → **Wire up Cursor hooks** (or rely on first launch).
2. Start a Cursor agent; when it finishes (2+ min session), Scrappy nudges.
3. Ask via voice about agent status (if Cursor API key in setup).

## G. Regression smoke

- Throw / drag Scrappy; wake phrase if enabled.
- **Turn off Scrappy** vs **Quit** (off = hidden, still in tray; quit = gone).
- Right-click menu: all items open without crash.

Record build version, date, and pass/fail per section in the release notes.
