# Workbuddy

Cog — a small articulated robot who lives on your desktop, walks around above the
taskbar, and comes to get you when a Cursor agent finishes.

## What you do

1. Keep Workbuddy running (it starts with Windows after install).
2. Cog wanders, sits, dozes off, and pings you now and then to keep you honest.
3. When an agent finishes (sessions ≥ 2 minutes), he walks to the middle of the
   screen, goes orange, and jumps until you notice.
4. Click him. He waves, says something, and goes back to wandering.

## Commands

```bash
npm install
npm start
npm run install-startup    # launch on Windows sign-in
npm run uninstall-startup  # stop launching on sign-in
npm run install-hooks      # wire Cursor agent-finished hooks (app must be running once)
```

## How Cursor talks to it

Cursor hooks POST to `http://127.0.0.1:8787/agent-done` with your local token.
Short sessions under 2 minutes are ignored (unless `force: true`).

## The character

Cog is one inline SVG with a real skeleton: shoulder, elbow, hip and knee joints,
each a squared-tooth gear that turns as the limb turns, joined to his head by a
corrugated flex pipe. His face is the screen and it is eyes only — every
expression is carried by the eyes, and a mouth appears only in the states that
animate one (talking, panic, dizzy).

- `renderer/cog.js` — the rig. Proportions, gear geometry, and the face set.
- `renderer/style.css` — every state (`idle`, `walk`, `sit`, `sleep`, `alert`,
  `wave`, `point`) as CSS keyframes on the `.j-*` joint classes.
- `renderer/lines.js` — what he says.
- `renderer/buddy.js` — behaviour loop, movement, and mouse hit-testing.

The walk is a proper gait, not a pendulum: the planted leg tracks backwards at a
constant rate while the free leg snaps forward with a bent knee, and he's drawn
three-quarter facing with a forward lean so the direction of travel reads.

Two rules keep it from looking wrong:

- **Sign.** Positive rotation swings a downward-pointing limb backwards, so heel
  strike is the negative extreme of the hip. Flip that and he moonwalks.
- **Stride vs speed.** The planted foot tracks back 87px/s across the stance
  phase (the first 58% of the cycle, *not* the whole cycle). SPEED in buddy.js
  must match that or the feet skate. Measured, not derived — the contact point
  traces an arc and the knee flexes under load, so geometry alone underestimates
  it by 13%.

Depth order back to front is far arm, far leg, torso, near leg, near arm, head.
The far limbs tuck inboard of the torso so it occludes them; pushed outboard
they read as foreground and the whole three-quarter illusion inverts.

### Tuning him

| What | Where |
| --- | --- |
| Walk speed, nag interval, sleep timeout | constants at the top of `renderer/buddy.js` |
| Step cadence | `--step` in `renderer/style.css` |
| Size, head-to-body ratio | `P` in `renderer/cog.js` |
| Colours | `INK` in `renderer/cog.js` |
| What he says | `renderer/lines.js` |
| Throw feel (spring, inertia, bounce) | the rigid body constants in `renderer/buddy.js` |

Open `renderer/index.html` straight in a browser to iterate on the animation
without launching Electron — the preload bridge is stubbed. Press `n` to fake a
nudge, `s` to make him sleepy. `window.__cog.setScreens([...])` fakes a
multi-monitor layout and `window.__cog.state()` dumps his physics state.

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

Both come from one ElevenLabs agent. Typing and speaking share the same
conversation — typed lines go down the same WebSocket as microphone audio and
run through the same response flow, so he answers out loud either way and
remembers what was said in the other mode.

His personality is `personality.md` at the project root. `npm run setup-voice`
uploads it as the agent's system prompt, so that file is the single source of
truth: edit it and re-run to mint a new agent, or edit the prompt in the
ElevenLabs dashboard.

### Setup

1. Create `.env.local` next to `package.json`:

   ```
   ELEVENLABS_API_KEY=your_key_here
   ```

   It is gitignored.

2. Create the agent:

   ```bash
   npm run setup-voice
   ```

3. Restart Workbuddy.

Optional in the same file: `ELEVENLABS_VOICE_ID` picks the voice and
`ELEVENLABS_LLM` picks the model behind him, defaulting to `claude-sonnet-4-5`.

### Using it

- **Click him** to open the text box. Type, press enter, he replies out loud.
  This never touches the microphone.
- **Tray, Talk to Cog (voice)** starts a full voice conversation with
  turn-taking and barge-in. Click him to hang up.

Opening the mic on a stray click would be obnoxious, so voice is a deliberate
choice rather than the default.

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

Cog sits on a frameless, transparent, always-on-top window covering every
display's combined work area. It's click-through everywhere except where he actually is: the
renderer hit-tests the pointer against his bounding box and toggles
`setIgnoreMouseEvents` accordingly. The window is non-focusable, so clicking him
never steals focus from your editor.

## Files

- `main.js` — overlay window, tray, localhost server
- `preload.js` — the IPC bridge
- `renderer/` — Cog
- `scripts/` — Windows Startup + Cursor hook helpers
- `cursor-agents.js` — Cursor agent lifecycle (start, status, stop)
- `cursor-agent-status.js` — status/timeout logic (unit tested)
- `docs/cog-debugging-playbook.md` — how Cog can debug Workbuddy issues

### Cursor agent status tuning (`.env.local`)

| Variable | Default | What it does |
| --- | --- | --- |
| `CURSOR_AGENT_RUN_TIMEOUT_MS` | `0` (off) | Stop a run after this many ms |
| `CURSOR_AGENT_STALE_MS` | `900000` (15 min) | Treat saved "running" as stuck after this |
| `COG_NUDGE_MIN_DURATION_MS` | `120000` (2 min) | Minimum session length before Cog walks over |

Run `npm test` after changing status logic. Re-run `npm run install-hooks` after hook script updates.
