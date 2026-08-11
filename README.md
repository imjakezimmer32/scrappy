# Workbuddy

A little local buddy that **grows bigger** when a Cursor agent finishes — so you notice it’s time to work again.

## What you do

1. Keep Workbuddy running (it starts with Windows after install).
2. When an agent finishes (sessions ≥ 2 minutes), the buddy grows.
3. Click the buddy when you’re back. It shrinks and waits again.

## Commands

```bash
npm install
npm start
npm run install-startup    # launch on Windows sign-in
npm run uninstall-startup  # stop launching on sign-in
```

## How Cursor talks to it

Cursor hooks POST to `http://127.0.0.1:8787/agent-done` with your local token.
Short sessions under 2 minutes are ignored (unless `force: true`).

## Files

- `main.js` — Electron window + localhost server
- `renderer/` — growing character UI
- `scripts/` — Windows Startup shortcut helpers
