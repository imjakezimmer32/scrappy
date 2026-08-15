# Set up Scrappy

You are installing Scrappy — a small robot who lives above the Windows taskbar and walks over
to fetch the user when a Cursor agent finishes.

Windows only. Needs Node 18 or newer, git, and PowerShell.

Follow these in order. Step 4 fails if step 3 hasn't happened.

## 1. Clone it

```
git clone https://github.com/imjakezimmer32/scrappy
cd scrappy
```

## 2. Install

```
npm install
```

This pulls Electron, which is a large download. Let it finish — `npm run install-startup` later
looks for `node_modules/electron/dist/electron.exe` by name and throws if it isn't there.

## 3. Start him, and leave him running

```
npm start
```

A robot appears standing above the taskbar. Don't close him — the next step needs him alive.

This is load-bearing, not a smoke test. On boot Scrappy mints a local token and serves it on
`http://127.0.0.1:8787/token`. Step 4 fetches that token and throws
`Could not get Scrappy token` if nothing is listening.

## 4. Wire up the Cursor hooks

In a second terminal, same folder:

```
npm run install-hooks
```

Writes `~/.cursor/hooks.json` with four hooks — `sessionStart`, `subagentStart`, `stop`,
`subagentStop` — merging with any hooks already there rather than replacing them.

The `stop` hook is the point: when a Cursor agent finishes, it pings Scrappy, and he walks to
the middle of the screen, turns orange, and jumps until clicked. Sessions under two minutes are
ignored so quick prompts don't summon him.

## 5. Launch him at sign-in

```
npm run install-startup
```

Adds him to Windows Startup and the Start Menu. Undo later with `npm run uninstall-startup`.

## 6. Hand over to the user

**Do not configure his brain, his voice, or any API keys yourself.** He has a setup panel for
that, and it stores keys encrypted in the user's own profile rather than in a file in the
project. Never put an API key in a file here — you'd be writing someone's credentials into a
git checkout.

Tell the user, in your own words:

- He's installed, running, and will come back after a restart.
- **Right-click him → Set up Scrappy…** to give him a brain and a voice. He works without
  either — he just can't talk yet. He'll say as much himself the first time.
- To start him by hand: click the `^` arrow by the clock (hidden icons), then his face.
- Click him to type at him. Right-click for the menu.
- He can be picked up and thrown. This is a feature and he has opinions about it.

## If something breaks

- `Could not get Scrappy token` — he isn't running. Do step 3, keep him open, retry step 4.
- `Electron not found` — `npm install` didn't finish. Run it again and watch for errors.
- He runs but ignores finished agents — the session was under two minutes, or the hooks didn't
  land. Check `~/.cursor/hooks.json` mentions `scrappy-agent-done.ps1`, then restart Cursor so
  it re-reads the file.
- He's on the wrong monitor — drag him. Wherever he lands is where he lives.
