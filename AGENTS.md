# AGENTS.md

## Cursor Cloud specific instructions

Scrappy is a **Windows-only** Electron desktop companion (an articulated robot that
lives above the taskbar and walks over when a Cursor agent finishes). The Cloud VM is
**Linux**, so the full end-user experience cannot be reproduced, but the whole app,
its tests, and the landing site all run headlessly here.

### What runs on this Linux VM
- Dependencies: `npm ci` (only one runtime dep, `@cursor/sdk`; `electron` + `electron-builder` are dev deps). This is the update script and is already run before the agent starts.
- Tests: `npm test` (30 Node built-in tests in `test/*.test.js`). Fast (<1s). There is **no linter** configured.
- Landing site: `npm run build-site` (zero-dependency Node build into `site/dist`). `npm run dev-site` / `deploy-site` use Wrangler/Cloudflare.
- The app: run the Electron overlay headlessly with `xvfb-run -a --server-args="-screen 0 1920x1080x24" npx electron . --no-sandbox`. The `dbus`/GPU/`viz_main_impl` errors in the log are harmless on headless Linux; the app is up once you see `Scrappy listening on http://127.0.0.1:8787`.

### Exercising the core loop headlessly (no GUI needed)
The product's core is a localhost control server on `127.0.0.1:8787` (see `main.js`). This is how a Cursor hook tells Scrappy an agent finished:
- `GET /health` → `{ ok, alerting, ...displayLayout }`
- `GET /token` → local auth token (loopback only)
- `POST /agent-done` (header `Authorization: Bearer <token>`) → sets `alerting:true` and Scrappy nudges. Non-force calls are ignored unless `status` is completed/error/finished **and** duration ≥ `SCRAPPY_NUDGE_MIN_DURATION_MS` (default 2 min); pass `{"force":true}` to trigger immediately.
- `POST /ack` → clears the alert (same as clicking him).

### Windows-only pieces — do NOT run on Linux
- All `*.ps1`-backed scripts: `install-hooks`, `install-startup`, `setup-local-voice`, `build-tray`, `model:*`.
- `npm run dist` / `dist:dir` (electron-builder `--win nsis`) only builds the installer on Windows (CI does this in `.github/workflows/windows-installer.yml`).
- The Python `local-voice/` voice server is optional and Windows-oriented (its launcher hardcodes `local-voice/.venv/Scripts/python.exe`) and its setup downloads large STT/TTS models and needs Ollama. Skip it here.

### Gotchas
- Opening `renderer/index.html` directly in a browser (as the README suggests) is broken in modern Chromium standalone: the `<div id="scrappy">` is exposed as `window.scrappy`, which shadows the stub bridge, so `bridge.onLayout` throws and the page stays blank. It only works under Electron, where the preload `contextBridge` provides the real `window.scrappy`. Run under Electron to see the character.
- The overlay is a transparent, frameless, always-on-top window. On Xvfb it renders on a black background; capture it with `ffmpeg -f x11grab -i :<display>.0 ...` (set `XAUTHORITY` to the `xvfb-run` auth file if using `xvfb-run -a`).
