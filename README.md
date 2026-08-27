# Scrappy

A small robot who lives above your Windows taskbar and walks over to get you when a
Cursor agent finishes.

Windows only. [imscrappy.dev](https://imscrappy.dev)

## Install (the normal way)

1. **Download** [Scrappy-Setup.exe](https://github.com/imjakezimmer32/scrappy/releases/latest)
2. **Run** the installer. Double-click. Let it finish. He should appear above the taskbar.
3. **Right-click him → Set up Scrappy…**  
   Type your name. Optionally add a brain (OpenAI/Groq) or a voice (ElevenLabs or local).  
   He works with none of that — he just can't talk yet.

That's it. He starts with Windows after that. Cursor hooks are wired on first launch, so
when an agent runs for two minutes or more, he walks to the middle of the screen, goes
orange, and jumps until you click him.

If there isn't a Release yet, use the developer steps at the bottom.

### Everyday use

- Click him to type. Press Enter. He answers out loud if voice is set up.
- Pick him up and throw him. This is on purpose.
- Click the `^` by the clock, then his face, to start him if he's hidden.
- Right-click → **Turn off Scrappy** to send him away.

## License

MIT. See [LICENSE](./LICENSE). You can use, copy, change, and share him, including
commercially, as long as you keep the copyright notice.

## For tinkerers

Settings live in `%APPDATA%\scrappy\settings.json`. Keys are encrypted with the Windows
credential store. An environment variable always wins; `.env.local` is still read but
nothing writes to it any more.

Cursor hooks POST to `http://127.0.0.1:8787/agent-done` with a local token. Sessions under
two minutes are ignored unless `force: true`.

Packaged installs check GitHub Releases and apply in the background when you are not
talking to him (no voice call, typed chat, or setup panel). Git checkouts on `main`
fast-forward `origin/main` the same way. Set `SCRAPPY_AUTO_UPDATE=off` to stop it.

### Developer install

```bash
git clone https://github.com/imjakezimmer32/scrappy
cd scrappy
npm install
npm start
npm run install-hooks      # if he is already running
npm run install-startup    # Start Menu + sign-in
npm run dist               # build Scrappy-Setup.exe on Windows
```

### Who he thinks you are

`personality.md` ships with a `{{USER}}` placeholder. The setup panel fills it in
(`SCRAPPY_USER_NAME`), defaulting to your Windows account name.

## The character

Scrappy is one inline SVG with a real skeleton: shoulder, elbow, hip and knee joints,
each a squared-tooth gear that turns as the limb turns, joined to his head by a
corrugated flex pipe. His face is the screen and it is eyes only — every
expression is carried by the eyes, and a mouth appears only in the states that
animate one (talking, panic, dizzy).

- `renderer/rig.js` — the rig. Proportions, gear geometry, and the face set.
- `renderer/style.css` — every state (`idle`, `walk`, `sit`, `sleep`, `alert`,
  `wave`, `point`) as CSS keyframes on the `.j-*` joint classes.
- `renderer/lines.js` — what he says.
- `renderer/scrappy.js` — behaviour loop, movement, and mouse hit-testing.

The walk is a proper gait, not a pendulum: the planted leg tracks backwards at a
constant rate while the free leg snaps forward with a bent knee, and he's drawn
three-quarter facing with a forward lean so the direction of travel reads.

Two rules keep it from looking wrong:

- **Sign.** Positive rotation swings a downward-pointing limb backwards, so heel
  strike is the negative extreme of the hip. Flip that and he moonwalks.
- **Stride vs speed.** The planted foot tracks back 87px/s across the stance
  phase (the first 58% of the cycle, *not* the whole cycle). SPEED in scrappy.js
  must match that or the feet skate. Measured, not derived — the contact point
  traces an arc and the knee flexes under load, so geometry alone underestimates
  it by 13%.

Depth order back to front is far arm, far leg, torso, near leg, neck, head, near
arm. The near arm comes **after** the head, so a raised hand crosses in front of
his face instead of vanishing behind it — waving, pointing and the agent-done
jump all put the hand over the screen, which is exactly where the pose reads.
The far limbs tuck inboard of the torso so it occludes them; pushed outboard
they read as foreground and the whole three-quarter illusion inverts.

### Rust and rivets

`renderer/wear.js` generates his corrosion, grime and scratches, and `rig.js`
paints it inside the joint groups so it rides the limb animations for free. It
is all seeded from a fixed constant — his rust has to land in the same place
every launch or he isn't the same robot.

All three intensity levels are emitted into the DOM at once. Each element
carries `data-w` — the lowest level it appears at — and the geometry is nested,
so raising the level makes existing damage spread rather than shuffling it
somewhere else. Switching is one attribute, live, with no rebuild:

```js
document.getElementById("scrappy").dataset.wear = "heavy"; // or medium, subtle
```

Rivets, weld seams and the bolted repair plate on his near shin are *not* wear:
they sit outside the `.wear` groups and never fade, because he is always a
patched-together machine — the rust is only how long he's been one.

His head is the one part the tray icon mirrors. `HEAD_RUST` is authored in
head-local unit coordinates and shared by both `rig.js` and
`scripts/build-icon.js`, so the icon rusts where his real head does; run
`npm run build-icon` after changing it. Body detail deliberately stays off the
icon — rivets at 16px are mud.

### Tuning him

| What | Where |
| --- | --- |
| Walk speed, nag interval, sleep timeout | constants at the top of `renderer/scrappy.js` |
| Step cadence | `--step` in `renderer/style.css` |
| Size, head-to-body ratio | `P` in `renderer/rig.js` |
| Colours | `INK` in `renderer/rig.js` |
| How worn he looks | `LEVEL` in `renderer/wear.js` — `subtle`, `medium` or `heavy` |
| Where the rust sits | the `WEAR.rust(...)` calls in `renderer/rig.js`, and `HEAD_RUST` in `renderer/wear.js` |
| Rivets, weld seams, the patch plate | the `built(...)` calls in `renderer/rig.js` |
| What he says | `renderer/lines.js` |
| Tray / favicon icon | `scripts/build-icon.js`, then `npm run build-icon` |
| Throw feel (spring, inertia, bounce) | the rigid body constants in `renderer/scrappy.js` |

Open `renderer/index.html` straight in a browser to iterate on the animation
without launching Electron — the preload bridge is stubbed. Press `n` to fake a
nudge, `s` to make him sleepy. `window.__scrappy.setScreens([...])` fakes a
multi-monitor layout and `window.__scrappy.state()` dumps his physics state.

## Grab and throw

Pick him up and he is a real rigid body. The cursor is attached to the exact
point you grabbed by a spring-damper, and that spring's torque about his centre
of mass is what makes him swing and wind up when you whip him around. Letting go
just stops applying the spring — the linear and angular momentum he already has
is the throw. In the air: gravity, drag, and walls, floor and ceiling that bounce
him with restitution, bleeding sideways speed into spin on each glancing hit so
he tumbles instead of mirroring. When he stops he snaps upright and gets on with
his day.

## His brain and his voice

Default voice is the **local AMD-friendly stack** (Unmute-shaped):

- **Ears:** Whisper (CPU)
- **Brain:** Ollama (`qwen2.5:7b` by default — uses your GPU when Ollama can)
- **Mouth:** Kokoro ONNX TTS

This is free and unlimited. It is not as polished as ElevenLabs, but it keeps
working when cloud credits run out.

Set it in **right-click → Set up Scrappy…**, or by hand in `.env.local`:

```
VOICE_BACKEND=local
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_THINK_MODEL=deepseek-r1:14b
OLLAMA_THINK_MODE=auto
```

Dual-brain mode: the **7B** handles quick chat; a thinking model kicks in for hard asks.
See `docs/local-models.md`.

Compare fast brains anytime:

```bash
npm run model:qwen7
npm run model:qwen14
npm run model:gemma9
```

Or right-click the Scrappy tray icon → **Switch fast brain** / **Switch think brain**.

One-time install:

```bash
npm run setup-local-voice
```

Then restart Scrappy. Scrappy boots the local voice server on `127.0.0.1:8790`.

### Optional: ElevenLabs

Paste a key into the setup panel and press **Build his voice agent**, or set it by hand:

```
VOICE_BACKEND=elevenlabs
ELEVENLABS_API_KEY=your_key_here
```

Or `VOICE_BACKEND=auto` to prefer local when installed and fall back to ElevenLabs.

`npm run setup-voice` uploads `personality.md` to an ElevenLabs agent. The panel's button runs
the same script, but it can hand over a key from the encrypted store — which the bare CLI
cannot read, so use the button if that's where your key lives.

For local mode, Scrappy reads `personality.md` directly.

### Using it

- **Click the ^ arrow** by the clock (hidden icons), then click **Scrappy's face**
  to start him. That icon belongs to a tiny helper named Scrappy, not Electron,
  so it stays even if you end Electron in Task Manager. Right-click the icon for
  **Start Scrappy** / **Turn off Scrappy**.
- **Right-click him** → **Turn off Scrappy**. He hides until you start him again
  from that hidden-icons entry. He will not listen or nudge while he is off.
- **Click him** to open the text box. Type, press enter, he replies out loud.
  This never touches the microphone.
- **Tray, Talk to Scrappy (voice)** starts a full voice conversation with
  turn-taking and barge-in. Click him to hang up.
- **Say "hey there Scrappy"** (when voice is set up) to start talking hands-free —
  Scrappy listens passively in the background until it hears the wake phrase.
  Also works: **"okay then Scrappy"** or **"wake up Scrappy"**.
  Disable with `SCRAPPY_WAKE_WORD=off` in `.env.local`.

Opening the mic on a stray click would be obnoxious, so voice is a deliberate
choice rather than the default — except the wake phrase, which only opens the
full mic after you say hey there Scrappy.

His nudge and check-in lines stay in `renderer/lines.js`. ElevenLabs has no
cheap one-shot text endpoint, and spinning up an agent session to generate a
single throwaway line would be slow and wasteful.

### How the key is handled

The key is read only in the main process. Starting a conversation exchanges it
for a signed WebSocket URL that expires in fifteen minutes, and only that URL
crosses into the renderer. The key is never in the page, never in the DOM and
never in the repo.

The microphone opens only for a voice conversation and is released the moment
it ends. There is no always-on listening.

The overlay is deliberately non-focusable so clicking him never steals focus
from your editor. Opening the text box grants focus for exactly as long as the
box is open, then hands it back.

## Monitors

The overlay is one window stretched across the bounding box of every display,
so there is a single physics world spanning your whole desk. Monitors rarely
share a floor line, so main.js sends the renderer each display rectangle in
overlay-local coordinates and the renderer works out which floor and ceiling
are under him at his current x.

He **walks only on the monitor he is standing on** — strolling, sleeping and
the agent-done nudge all clamp to that screen. Crossing between monitors is
something you do to him: drag him across, or throw him. Wherever he lands
becomes his monitor.

Caveat: one window spanning displays renders at a single scale factor. If your
monitors run different DPI scaling he will look slightly off-size on the
secondary one.

## The window

Scrappy sits on a frameless, transparent, always-on-top window covering every
display's combined work area. It's click-through everywhere except where he actually is: the
renderer hit-tests the pointer against his bounding box and toggles
`setIgnoreMouseEvents` accordingly. The window is non-focusable, so clicking him
never steals focus from your editor.

## Files

- `main.js` — overlay window, tray, localhost server
- `preload.js` — the IPC bridge
- `renderer/` — Scrappy
- `settings.js` — config precedence + encrypted key storage (unit tested)
- `persona.js` — fills `{{USER}}` into `personality.md`
- `setup/` — the setup panel window
- `site/` — the imscrappy.dev landing page (`npm run build-site`)
- `scripts/` — Windows Startup + Cursor hook helpers
- `cursor-agents.js` — Cursor agent lifecycle (start, status, stop)
- `cursor-agent-status.js` — status/timeout logic (unit tested)
- `docs/scrappy-debugging-playbook.md` — how Scrappy can debug Scrappy issues

### Cursor agent status tuning (`.env.local`)

| Variable | Default | What it does |
| --- | --- | --- |
| `CURSOR_AGENT_RUN_TIMEOUT_MS` | `0` (off) | Stop a run after this many ms |
| `CURSOR_AGENT_STALE_MS` | `900000` (15 min) | Treat saved "running" as stuck after this |
| `SCRAPPY_NUDGE_MIN_DURATION_MS` | `120000` (2 min) | Minimum session length before Scrappy walks over |
| `SCRAPPY_WAKE_WORD` | `on` | Enable "hey there Scrappy" listener when voice is configured |

Run `npm test` after changing status logic. Restart Scrappy after hook script updates so he
rewrites `~/.cursor/hooks.json`.

The license text is in [LICENSE](./LICENSE).
