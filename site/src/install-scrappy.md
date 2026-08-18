# Set up Scrappy

You are installing Scrappy — a small robot who lives above the Windows taskbar and walks over
to fetch the user when a Cursor agent finishes.

Windows only.

Prefer the installer. Only fall back to git + npm if there is no Release yet.

## 1. Download and run the installer

Open https://github.com/imjakezimmer32/scrappy/releases/latest

Download **Scrappy-Setup.exe**. Double-click it. Let it finish.

A robot should appear standing above the taskbar. He starts with Windows after this.
Cursor hooks are installed on first launch — you do not run `npm run install-hooks`.

If that page has no installer yet, use the developer fallback at the bottom.

## 2. Hand over to the user

**Do not configure his brain, his voice, or any API keys yourself.** He has a setup panel for
that, and it stores keys encrypted in the user's own profile. Never put an API key in a file
in this project.

Tell the user, in your own words:

- He's installed, running, and will come back after a restart.
- **Right-click him → Set up Scrappy…** to give him a name, a brain, and a voice. He works
  without a brain or voice — he just can't talk yet. He'll say as much himself the first time.
- To start him by hand: click the `^` arrow by the clock (hidden icons), then his face.
- Click him to type at him. Right-click for the menu.
- He can be picked up and thrown. This is a feature and he has opinions about it.

## If something breaks

- Nothing appears — run the installer again, then look under Start → Scrappy.
- He runs but ignores finished agents — the session was under two minutes, or Cursor hasn't
  re-read hooks. Restart Cursor. Right-click the tray icon → **Wire up Cursor hooks** if needed.
- He's on the wrong monitor — drag him. Wherever he lands is where he lives.

## Developer fallback (no Release yet)

Needs Node 18+, git, and PowerShell.

```
git clone https://github.com/imjakezimmer32/scrappy
cd scrappy
npm install
npm start
```

Leave him running. In a second terminal:

```
npm run install-hooks
npm run install-startup
```

Then do step 2 above. Do not paste API keys into the repo.
