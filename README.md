# Workbuddy

A little local buddy that **grows bigger** when a Cursor agent finishes — so you notice it’s time to work again.

## What you do

1. `npm install` then `npm start` (buddy window appears).
2. `npm run install-startup` so it launches when you sign in to Windows.
3. `npm run install-hooks` (while Workbuddy is running) so Cursor can ping it.
4. When an agent runs **2+ minutes** and finishes, the buddy grows — click it when you’re back.

Use **Test grow** in the window or tray menu anytime.

## Commands

```bash
npm install
npm start
npm run install-startup    # launch on Windows sign-in
npm run uninstall-startup  # stop launching on sign-in
npm run install-hooks      # install Cursor stop hooks
```

## How Cursor talks to it

Hooks under `~/.cursor/hooks/` POST to `http://127.0.0.1:8787/agent-done` with your local token.
Short sessions under 2 minutes are ignored (unless you force a test).

## Files

- `main.js` — Electron window + localhost server
- `renderer/` — growing character UI
- `scripts/` — Startup + Cursor hook installers
