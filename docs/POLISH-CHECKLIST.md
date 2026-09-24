# Scrappy public polish checklist

Status key: **done** = implemented in repo; **manual** = you verify on Windows; **auto** = covered by `npm test`.

## Download & install

| # | Item | Status |
|---|------|--------|
| 1 | One-file `Scrappy-Setup-*.exe` on GitHub Releases | **manual** (CI on tag) |
| 2 | Installer runs app after finish (`runAfterFinish`) | **done** |
| 3 | Start menu shortcut | **done** |
| 4 | No API keys in repo; setup panel + encrypted store | **done** |
| 5 | Install doc at `site/src/install-scrappy.md` | **done** |

## First launch

| # | Item | Status |
|---|------|--------|
| 6 | Cursor hooks installed automatically on boot | **done** |
| 7 | Setup panel opens once if brain/voice not configured | **done** |
| 8 | Scrappy explains he needs setup (bubble), points to right-click | **done** |
| 9 | Persona file rendered with Windows user name | **done** |
| 10 | Local voice stack warms in background when installed | **done** |

## Setup panel

| # | Item | Status |
|---|------|--------|
| 11 | Save applies live (no “restart Scrappy” for normal changes) | **done** |
| 12 | Build ElevenLabs agent from panel | **done** |
| 13 | **Install local voice** button (runs setup script in app) | **done** |
| 14 | Secrets write-only; env overrides explained | **done** |
| 15 | User-facing errors say “Set up Scrappy”, not `.env.local` | **done** |

## Voice

| # | Item | Status |
|---|------|--------|
| 16 | `voiceReady` gates health + calls | **done** |
| 17 | Background warm at startup | **done** |
| 18 | Clear errors: Ollama down, model missing, mic denied | **done** |
| 19 | ElevenLabs unprompted speech gate | **done** |
| 20 | Quit kills process trees (voice, wake, Recall) | **done** |

## Updates

| # | Item | Status |
|---|------|--------|
| 21 | Quiet check ~45s after launch | **done** |
| 22 | Background download of new installer | **done** |
| 23 | Tray: **Install update (vX.Y.Z)** when download ready | **done** |
| 24 | Check for updates uses staged file when present | **done** |
| 25 | Scrappy speaks when update is ready (optional nudge) | **done** |

## Tray & daily use

| # | Item | Status |
|---|------|--------|
| 26 | Type / Talk / Setup / Hooks / Quit | **done** |
| 27 | Turn off vs Quit documented | **manual** |
| 28 | Agent-done nudge + hooks | **manual** (needs Cursor) |

## Quality bar

| # | Item | Status |
|---|------|--------|
| 29 | `npm test` (Node + Python unit) | **auto** |
| 30 | No developer jargon in default user errors | **done** |
| 31 | Manual QA script for releases | **docs/MANUAL-QA.md** |
