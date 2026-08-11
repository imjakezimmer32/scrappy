// cog.js and lines.js are classic scripts sharing one global scope, so we
// alias rather than destructure — a bare `pick`/`FACES` here would redeclare.
const RIG = window.CogRig;
const pickLine = window.CogLines.pick;

// Stub the preload bridge so renderer/index.html can be opened in a plain
// browser while iterating on the animation.
const bridge = window.workbuddy || {
  onGrow() {},
  onAck() {},
  onLayout() {},
  ack() {},
  testGrow() {},
  setInteractive() {},
  voiceSignedUrl: () => Promise.resolve({ ok: false, error: "no_api_key" }),
  voiceStatus: () => Promise.resolve({ configured: false }),
  systemContext: () => Promise.resolve({ ok: false, error: "disabled" }),
  recallContext: () => Promise.resolve({ ok: false, error: "disabled" }),
  chatFocus() {},
};

const CHAR_W = 120;
// Matched to the stride in style.css. Geometry says 77px/s, but the contact
// point traces an arc and the knee flexes under load, so the foot actually
// tracks back 87px/s — measured, not derived. Change --step or the hip sweep
// without re-measuring this and he skates.
const SPEED = 85;
// How hard he has to cross a monitor seam before the glass gives.
const SHATTER_SPEED = 850;
const NAG_EVERY_MS = 12 * 60 * 1000;
const SLEEP_AFTER_MS = 10 * 60 * 1000;
const ESCALATE_MS = 22 * 1000;

const stage = document.getElementById("stage");
const el = document.getElementById("cog");
const flip = el.querySelector(".cog-flip");
const bubble = document.getElementById("bubble");

flip.innerHTML = RIG.buildCog();
const faceEl = document.getElementById("cog-face");

let x = 80;
let target = null;
let resolveWalk = null;
let alerting = false;
let sayToken = 0;
let lastPoke = Date.now();
let asleep = false;

// ---------- rigid body ----------
// He is a point mass with a moment of inertia. Grabbing attaches a spring
// between your cursor and the exact spot you grabbed; that spring's torque
// about his centre of mass is what makes him swing, whip, and keep spinning
// after you let go. Releasing just stops applying the spring — the momentum
// he already has is the throw.

const COM_X = 60; // centre of mass, element-local
const COM_Y = 118;
const GROUND_OFFSET = 176; // element-local y of the floor his feet stand on
const COM_FLOOR = GROUND_OFFSET - COM_Y; // COM height above the stage bottom
const COM_CEIL = 100;

const GRAVITY = 2600;
const SPRING = 1150;
const SPRING_DAMP = 48;
const INV_INERTIA = 1 / 3400;
const LIN_DRAG = 0.85;
const ANG_DRAG = 0.7;
const WALL_E = 0.55;
const FLOOR_E = 0.42;
const CONTACT_SPIN = 0.011;
const GROUND_FRICTION = 3.4;
const MAX_SPEED = 4200;
const MAX_SPIN = 26;
const SETTLE_V = 55;

let cx = 0;
let cy = 0;
let vx = 0;
let vy = 0;
let theta = 0;
let omega = 0;
let settleFor = 0;

let held = false;
let flying = false;
let grabLX = 0;
let grabLY = 0;
let dragMoved = false;
let pressX = 0;
let pressY = 0;
const DRAG_THRESHOLD_PX = 8;

const bounds = () => Math.max(0, stage.clientWidth - CHAR_W);
const clamp = (v) => Math.max(0, Math.min(bounds(), v));
const rand = (a, b) => a + Math.random() * (b - a);
const inHand = () => held || flying;

// ---------- monitors ----------
// The overlay spans every display, but they rarely share a floor line, so
// the floor and ceiling under him depend on which screen he's currently over.

let screens = null;
let lift = 0;

let fallbackScreen = null;

function screenList() {
  if (screens && screens.length) return screens;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!fallbackScreen || fallbackScreen[0].right !== w || fallbackScreen[0].bottom !== h) {
    fallbackScreen = [{ left: 0, top: 0, right: w, bottom: h }];
  }
  return fallbackScreen;
}

function screenAt(px) {
  const list = screenList();
  let best = list[0];
  let bestGap = Infinity;
  for (const s of list) {
    if (px >= s.left && px <= s.right) return s;
    const gap = px < s.left ? s.left - px : px - s.right;
    if (gap < bestGap) {
      bestGap = gap;
      best = s;
    }
  }
  return best;
}

// How far above the overlay's bottom edge this screen's floor sits.
const liftAt = (px) => stage.clientHeight - screenAt(px).bottom;

// He walks only on the monitor he's standing on. Crossing between screens is
// something you do to him — drag him or throw him.
function clampWalk(v) {
  const s = screenAt(x + COM_X);
  const min = Math.max(0, s.left);
  const max = Math.min(bounds(), s.right - CHAR_W);
  return Math.max(min, Math.min(max, v));
}

bridge.onLayout((list) => {
  if (!list || !list.length) return;
  screens = list;
  x = clamp(x);
  lift = liftAt(x + COM_X);
  if (!inHand()) place();
});

function place() {
  if (inHand()) {
    const tx = cx - COM_X;
    const ty = cy - COM_Y - (stage.clientHeight - GROUND_OFFSET);
    el.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) rotate(${((theta * 180) / Math.PI).toFixed(1)}deg)`;
  } else {
    el.style.transform = `translate(${x.toFixed(1)}px, ${(-lift).toFixed(1)}px)`;
  }
}

// While he's in your hand or in the air, physics owns the character — a
// behaviour that was already mid-flight must not stomp on it.
function setState(s) {
  if (inHand() && s !== "held" && s !== "fly") return;
  el.dataset.state = s;
}

function setFace(name, force) {
  if (inHand() && name !== "alarmed") return;
  // The cursor-in-his-face reaction outranks whatever the behaviour loop
  // wanted his expression to be.
  if (!force && Date.now() < faceLockUntil) return;
  faceEl.innerHTML = (RIG.FACES[name] || RIG.FACES.focused)();
}

function setFacing(dir) {
  el.dataset.facing = dir < 0 ? "left" : "right";
}

// Hitting a monitor seam hard enough shatters the pane between them.
let lastShatter = 0;
let prevScreenLeft = null;

function shatterAt(px, py, dir, speed) {
  const power = Math.min(1.8, speed / 1400);
  let inner = `<circle class="flash" cx="0" cy="0" r="24" fill="#e4f7ff"/>`;

  for (let i = 0; i < 9; i += 1) {
    const a = (i / 9) * Math.PI * 2 + rand(-0.22, 0.22);
    const len = rand(60, 150) * power;
    const mid = a + rand(-0.26, 0.26);
    inner +=
      `<path class="crack" d="M0 0 L${(Math.cos(mid) * len * 0.55).toFixed(1)} ${(Math.sin(mid) * len * 0.55).toFixed(1)}` +
      ` L${(Math.cos(a) * len).toFixed(1)} ${(Math.sin(a) * len).toFixed(1)}"` +
      ` stroke="#d3f0ff" stroke-width="${rand(1.2, 2.6).toFixed(1)}" fill="none" stroke-linecap="round"` +
      ` stroke-dasharray="60" style="animation-delay:${(i * 0.012).toFixed(3)}s"/>`;
  }

  const shards = 20;
  for (let i = 0; i < shards; i += 1) {
    const a = (i / shards) * Math.PI * 2 + rand(-0.14, 0.14);
    const len = rand(14, 34) * power;
    const spread = rand(0.14, 0.32);
    // Shards fan out along the direction he punched through.
    const bias = 1 + Math.max(0, Math.cos(a) * dir) * 0.9;
    const dist = rand(80, 210) * power * bias;
    inner +=
      `<path class="shard" d="M0 0` +
      ` L${(Math.cos(a - spread) * len).toFixed(1)} ${(Math.sin(a - spread) * len).toFixed(1)}` +
      ` L${(Math.cos(a) * len * 1.5).toFixed(1)} ${(Math.sin(a) * len * 1.5).toFixed(1)}` +
      ` L${(Math.cos(a + spread) * len).toFixed(1)} ${(Math.sin(a + spread) * len).toFixed(1)} Z"` +
      ` fill="rgba(226,246,255,0.5)" stroke="#c6ebff" stroke-width="1"` +
      ` style="--dx:${(Math.cos(a) * dist).toFixed(1)}px;--dy:${(Math.sin(a) * dist - rand(0, 40)).toFixed(1)}px;` +
      `--rot:${rand(-320, 320).toFixed(0)}deg;animation-delay:${(Math.random() * 0.05).toFixed(3)}s"/>`;
  }

  const host = document.createElement("div");
  host.className = "shatter";
  host.style.left = `${Math.round(px)}px`;
  host.style.top = `${Math.round(py)}px`;
  host.innerHTML = `<svg viewBox="-220 -220 440 440" aria-hidden="true">${inner}</svg>`;
  stage.appendChild(host);
  setTimeout(() => host.remove(), 1100);
}

// ---------- dust ----------
// Little puffs at his heels as he walks, bigger ones when he drops his weight
// onto the bar or picks it back up.

const STRIDE_DUST = 34; // px of travel between footfalls
let dustAccum = 0;
let dustFoot = 0;

function puff(px, py, scale, drift) {
  const motes = 3 + Math.floor(Math.random() * 3);
  let inner = "";
  for (let i = 0; i < motes; i += 1) {
    const r = rand(2.1, 4.4) * scale;
    const dx = rand(5, 19) * scale * drift;
    const dy = -rand(4, 13) * scale;
    inner +=
      `<circle class="mote" cx="0" cy="0" r="${r.toFixed(1)}" fill="#d3dcea"` +
      ` style="--dx:${dx.toFixed(1)}px;--dy:${dy.toFixed(1)}px;` +
      `--gs:${(1.4 + Math.random() * 0.9).toFixed(2)};` +
      `animation-delay:${(Math.random() * 0.07).toFixed(3)}s"/>`;
  }
  const host = document.createElement("div");
  host.className = "dust";
  host.style.left = `${Math.round(px)}px`;
  host.style.top = `${Math.round(py)}px`;
  host.innerHTML = `<svg viewBox="-70 -70 140 140" aria-hidden="true">${inner}</svg>`;
  stage.appendChild(host);
  setTimeout(() => host.remove(), 900);
}

// A pair of puffs either side of him, on the floor line of his screen.
function puffAtFeet(scale, spread = 13) {
  const floor = screenAt(x + COM_X).bottom;
  puff(x + COM_X - spread, floor, scale, -1);
  puff(x + COM_X + spread, floor, scale, 1);
}

function enterPhysics() {
  prevScreenLeft = null;
  cx = x + COM_X;
  cy = screenAt(cx).bottom - COM_FLOOR;
  vx = 0;
  vy = 0;
  omega = 0;
  theta = 0;
  settleFor = 0;
}

function step(dt) {
  // Floor and ceiling belong to whichever monitor he's currently over; the
  // side walls are the outer edge of the whole desktop.
  const here = screenAt(cx);
  const floorY = here.bottom - COM_FLOOR;
  const ceilY = here.top + COM_CEIL;
  const leftX = COM_X;
  const rightX = Math.max(leftX + 1, stage.clientWidth - COM_X);

  let ax = 0;
  let ay = GRAVITY;
  let alpha = 0;

  if (held) {
    // He keeps his eyes on the cursor that has hold of him. No minimum
    // distance here — the cursor is on him by definition — and no body flip,
    // since the physics is already spinning him.
    const box = el.getBoundingClientRect();
    if (box.width) {
      const hx = box.left + box.width * 0.5;
      const hy = box.top + box.height * (67 / 190);
      const pitch =
        (Math.atan2(-(pointer.y - hy), Math.max(Math.abs(pointer.x - hx), 1)) * 180) / Math.PI;
      el.classList.add("is-watching");
      el.style.setProperty(
        "--head-aim",
        `${Math.max(AIM_UP, Math.min(AIM_DOWN, -pitch * 0.72)).toFixed(1)}deg`
      );
    }

    // Where the grabbed point currently is, and how fast that material
    // point is moving (body velocity plus rotation about the centre).
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const rx = grabLX * c - grabLY * s;
    const ry = grabLX * s + grabLY * c;
    const px = cx + rx;
    const py = cy + ry;
    const pvx = vx - omega * ry;
    const pvy = vy + omega * rx;

    const fx = SPRING * (pointer.x - px) - SPRING_DAMP * pvx;
    const fy = SPRING * (pointer.y - py) - SPRING_DAMP * pvy;

    ax += fx;
    ay += fy;
    alpha += (rx * fy - ry * fx) * INV_INERTIA;
  } else {
    vx -= vx * LIN_DRAG * dt;
    vy -= vy * LIN_DRAG * dt;
    omega -= omega * ANG_DRAG * dt;
  }

  vx += ax * dt;
  vy += ay * dt;
  omega += alpha * dt;

  vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, vx));
  vy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, vy));
  omega = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, omega));

  cx += vx * dt;
  cy += vy * dt;
  theta += omega * dt;

  // Walls. A glancing hit bleeds sideways speed into spin, which is what
  // makes him tumble off a wall instead of mirroring cleanly.
  if (cx < leftX) {
    cx = leftX;
    if (vx < 0) {
      vx = -vx * WALL_E;
      omega = omega * 0.55 + vy * CONTACT_SPIN;
    }
  } else if (cx > rightX) {
    cx = rightX;
    if (vx > 0) {
      vx = -vx * WALL_E;
      omega = omega * 0.55 - vy * CONTACT_SPIN;
    }
  }

  if (cy < ceilY) {
    cy = ceilY;
    if (vy < 0) {
      vy = -vy * WALL_E;
      omega = omega * 0.6 + vx * CONTACT_SPIN;
    }
  }

  if (cy > floorY) {
    cy = floorY;
    if (vy > 0) {
      vy = vy > SETTLE_V ? -vy * FLOOR_E : 0;
      omega = omega * 0.5 - vx * CONTACT_SPIN * 1.4;
      vx *= 0.74;
    }
    // Resting contact: rub off the leftovers.
    vx -= vx * GROUND_FRICTION * dt;
    omega -= omega * GROUND_FRICTION * dt;
  }

  // Crossing the seam between two monitors fast enough breaks the glass.
  const nowScreen = screenAt(cx);
  if (prevScreenLeft !== null && nowScreen.left !== prevScreenLeft && Math.abs(vx) > SHATTER_SPEED) {
    const stamp = performance.now();
    if (stamp - lastShatter > 260) {
      lastShatter = stamp;
      shatterAt(vx > 0 ? nowScreen.left : nowScreen.right, cy, Math.sign(vx), Math.abs(vx));
      vx *= 0.88;
    }
  }
  prevScreenLeft = nowScreen.left;

  if (!held) {
    const resting =
      cy >= floorY - 0.5 &&
      Math.abs(vy) < 45 &&
      Math.abs(vx) < 42 &&
      Math.abs(omega) < 1.1;
    settleFor = resting ? settleFor + dt : 0;
    if (settleFor > 0.22) {
      land();
      return;
    }
    if (Math.abs(vx) > 60) setFacing(vx);
  }

  x = clamp(cx - COM_X);
  place();
}

function land() {
  flying = false;
  held = false;
  // Kick up dust proportional to the impact, before the velocity is cleared.
  puffAtFeet(Math.min(2.4, 0.9 + Math.abs(vy) / 620), 16);
  vx = 0;
  vy = 0;
  omega = 0;
  settleFor = 0;
  target = null;
  stopWatching();
  x = clamp(cx - COM_X);
  // Wherever he came to rest is his monitor now.
  lift = liftAt(x + COM_X);

  // Snap upright with a little overshoot instead of freezing mid-tumble.
  const spun = Math.abs(theta) > 0.8;
  theta = 0;
  el.style.transition = "transform .32s cubic-bezier(.2,1.5,.4,1)";
  place();
  el.classList.add("is-landing");
  setTimeout(() => {
    el.style.transition = "";
    el.classList.remove("is-landing");
  }, 460);

  setState("idle");
  lastPoke = Date.now();
  if (spun) say(pickLine("thrown"), 2600, "dizzy");
  else setFace("focused");
}

// ---------- cancellable waiting ----------

const pending = new Set();

function wait(ms) {
  return new Promise((resolve) => {
    const rec = {};
    rec.id = setTimeout(() => {
      pending.delete(rec);
      resolve("done");
    }, ms);
    rec.cancel = () => {
      clearTimeout(rec.id);
      pending.delete(rec);
      resolve("cancelled");
    };
    pending.add(rec);
  });
}

function cancelAll() {
  for (const rec of [...pending]) rec.cancel();
  if (resolveWalk) {
    target = null;
    const done = resolveWalk;
    resolveWalk = null;
    done("cancelled");
  }
}

// ---------- walking ----------

function walkTo(dest) {
  target = clampWalk(dest);
  if (Math.abs(target - x) < 2) {
    target = null;
    return Promise.resolve("done");
  }
  setFacing(target - x);
  setState("walk");
  return new Promise((resolve) => {
    resolveWalk = resolve;
  });
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.04, (now - lastFrame) / 1000);
  lastFrame = now;

  if (inHand()) {
    step(dt);
    requestAnimationFrame(frame);
    return;
  }

  if (target !== null) {
    const delta = target - x;
    const stride = SPEED * dt;
    if (Math.abs(delta) <= stride) {
      x = target;
      target = null;
      setState("idle");
      if (resolveWalk) {
        const done = resolveWalk;
        resolveWalk = null;
        done("done");
      }
    } else {
      x += Math.sign(delta) * stride;
      dustAccum += stride;
      if (dustAccum >= STRIDE_DUST) {
        dustAccum = 0;
        dustFoot ^= 1;
        puff(
          x + COM_X + (dustFoot ? 9 : -9),
          screenAt(x + COM_X).bottom,
          0.6,
          el.dataset.facing === "left" ? 1 : -1
        );
      }
    }
    place();
  }
  requestAnimationFrame(frame);
}

// ---------- speech ----------

// Show text without touching his face. ms of 0 leaves it up indefinitely.
function bubbleText(text, ms, hint = "") {
  const mine = ++sayToken;
  bubble.innerHTML = hint ? `${text}<span class="hint">${hint}</span>` : text;
  el.classList.add("is-talking");
  if (!ms) return mine;
  wait(ms).then(() => {
    if (mine === sayToken) el.classList.remove("is-talking");
  });
  return mine;
}

async function say(text, ms = 3400, face = "talk", hint = "") {
  const mine = ++sayToken;
  bubble.innerHTML = hint ? `${text}<span class="hint">${hint}</span>` : text;
  el.classList.add("is-talking");
  setFace(face);
  await wait(ms);
  if (mine !== sayToken) return;
  el.classList.remove("is-talking");
  if (!alerting) setFace(asleep ? "sleep" : "focused");
}

// ---------- talking to him ----------
//
// The brain is a local model served by Ollama. main.js owns the connection and
// the history; this just moves text in and out and drives his face while he
// thinks. If the model is down he falls back to his canned line bank, so he
// is never mute.

const sayBox = document.getElementById("sayBox");
const sayInput = document.getElementById("sayInput");

let chatting = false;

const BRAIN_TROUBLE = {
  no_api_key: ["I'm not wired up yet.", "add your key to .env.local"],
  no_agent_id: ["I don't have an agent.", "run npm run setup-voice"],
  socket_failed: ["Couldn't reach ElevenLabs.", "check your connection"],
  network: ["Couldn't reach ElevenLabs.", "check your connection"],
  elevenlabs_401: ["ElevenLabs turned me down.", "the API key looks wrong"],
  no_signed_url: ["ElevenLabs didn't hand back a session.", ""],
  empty: ["", ""],
};

function openChat() {
  chatting = true;
  cancelAll();
  target = null;
  stopWatching();
  forgetAnnoyance();
  lastPoke = Date.now();
  el.classList.add("is-chatting");
  if (bridge.chatFocus) bridge.chatFocus(true);
  setState("idle");
  setFace("focused", true);
  sayInput.value = "";
  bridge.setInteractive(true);
  interactive = true;
  sayInput.focus();
}

function closeChat() {
  chatting = false;
  el.classList.remove("is-chatting");
  sayInput.blur();
  if (bridge.chatFocus) bridge.chatFocus(false);
  refreshInteractive();
}

// Typed lines go to the same ElevenLabs agent the voice uses, over the same
// socket, so the two share one conversation. His answer comes back through the
// `said` hook and he speaks it aloud at the same time.
async function sendToBrain(text) {
  faceLockUntil = Date.now() + 60000;
  setState("idle");
  setFace("curious", true);
  bubbleText("…", 0);

  const sent = await window.CogVoice.sendText(text);
  if (sent && sent.ok) return;

  faceLockUntil = 0;
  const trouble = BRAIN_TROUBLE[sent && sent.error] || ["Something in me broke.", ""];
  await say(trouble[0], 4200, "squint", trouble[1]);
}

sayInput.addEventListener("keydown", async (e) => {
  e.stopPropagation();
  if (e.key === "Escape") {
    closeChat();
    return;
  }
  if (e.key !== "Enter") return;
  const text = sayInput.value.trim();
  if (!text) {
    closeChat();
    return;
  }
  sayInput.value = "";
  await sendToBrain(text);
  if (chatting) sayInput.focus();
});

sayInput.addEventListener("blur", () => {
  if (chatting && !sayInput.value) closeChat();
});

// Nudges stay on the canned bank: ElevenLabs has no cheap one-shot text
// endpoint, and opening a whole agent session to generate one line would be
// wasteful and slow.
async function speakLine(bucket, situation, ms, face, hint) {
  await say(pickLine(bucket), ms, face, hint);
}

// ---------- conversation ----------

let inCall = false;
let voiceReady = false;

const VOICE_TROUBLE = {
  no_api_key: ["Voice isn't wired up yet.", "add your key to .env.local"],
  no_agent_id: ["I don't have an agent yet.", "run npm run setup-voice"],
  mic_denied: ["I can't hear you.", "microphone permission is blocked"],
  socket_failed: ["Couldn't reach the voice server.", "check local voice / connection"],
  network: ["Couldn't reach ElevenLabs.", "check your connection"],
  elevenlabs_401: ["ElevenLabs turned me down.", "the API key looks wrong"],
  quota_exceeded: ["I'm out of voice credits this month.", "ElevenLabs Starter hit 90k — resets Aug 17, or upgrade the plan"],
  no_signed_url: ["ElevenLabs didn't hand back a session.", ""],
  not_installed: ["Local voice isn't installed yet.", "run scripts/setup-local-voice.ps1"],
  local_voice_failed: ["Local voice didn't start.", "run scripts/setup-local-voice.ps1"],
  local_voice_timeout: ["Local voice is still waking up.", "give it a minute on first launch"],
};

// While he's listening his eyes ARE the level meter: the halo swells and
// brightens with your voice. While he's talking, his mouth bar tracks his own
// output instead.
function updateMeters(input, output, isSpeaking) {
  if (isSpeaking) {
    const m = document.getElementById("vu-mouth");
    if (m) m.style.transform = `scaleY(${Math.min(2.2, 0.25 + output * 1.7).toFixed(2)})`;
    return;
  }
  const swell = 1 + Math.min(1, input) * 0.55;
  for (const glow of flip.querySelectorAll(".vu-glow")) {
    glow.style.transform = `scale(${swell.toFixed(2)})`;
    glow.setAttribute("opacity", (0.18 + Math.min(1, input) * 0.4).toFixed(2));
  }
}

async function startCall() {
  cancelAll();
  stopWatching();
  forgetAnnoyance();
  target = null;
  if (window.CogWake) window.CogWake.stop();
  // Give Windows a beat to release the wake-word mic before ElevenLabs grabs it.
  await new Promise((r) => setTimeout(r, 350));
  await wakeUp();
  lastPoke = Date.now();
  // Light up straight away — waiting for the socket would leave a second of
  // silence where you can't tell whether the mic is live.
  inCall = true;
  setState("listen");
  setFace("listen", true);
  bubbleText("Listening…", 0, "click me to stop");

  const result = await window.CogVoice.start({ mic: true });
  if (!result || !result.ok) {
    const trouble = VOICE_TROUBLE[result && result.error] || ["Something went wrong.", ""];
    inCall = false;
    setState("idle");
    say(trouble[0], 4200, "squint", trouble[1]);
    if (window.CogWake && voiceReady) window.CogWake.start();
  }
}

function endCall() {
  window.CogVoice.stop();
}

// Feed him machine telemetry + Recall memory as background context (never
// triggers a reply on its own). Meaningful chats auto-save into Recall.
let contextTimer = null;
let sessionLog = [];
const SESSION_AUTO_SAVE_MIN_TURNS = 2;

function trackSessionLine(role, text) {
  const line = String(text || "").trim();
  if (!line) return;
  sessionLog.push({ role, text: line.slice(0, 500), at: Date.now() });
  if (sessionLog.length > 40) sessionLog = sessionLog.slice(-40);
}

async function pushSystemContext(first) {
  if (!bridge.systemContext) return;
  const snap = await bridge.systemContext();
  if (!snap || !snap.ok || !snap.text) return;
  const local = window.CogVoice && window.CogVoice.backend && window.CogVoice.backend() === "local";
  const text = local ? String(snap.text).slice(0, 500) : snap.text;
  window.CogVoice.sendContext(
    first ? `Current state of Jake's machine: ${text}` : `Machine update: ${text}`
  );
}

async function pushRecallBrief() {
  if (bridge.recallBrief) {
    const r = await bridge.recallBrief();
    if (r && r.ok && r.text) {
      const local = window.CogVoice && window.CogVoice.backend && window.CogVoice.backend() === "local";
      const text = local ? String(r.text).slice(0, 700) : r.text;
      window.CogVoice.sendContext(`From Jake's Recall:\n${text}`);
      return;
    }
  }
  if (!bridge.recallContext) return;
  const r = await bridge.recallContext();
  if (!r || !r.ok || !r.text) return;
  window.CogVoice.sendContext(`From Jake's Recall notes — ${r.text}`);
}

async function pushRecallLive() {
  // Local models overfit on live dumps and start reading them aloud.
  if (window.CogVoice && window.CogVoice.backend && window.CogVoice.backend() === "local") return;
  if (!bridge.recallTool) return;
  const r = await bridge.recallTool("recall_live_context", { minutes: 10 });
  if (!r || !r.ok || !r.text) return;
  window.CogVoice.sendContext(`Live speech update from Recall: ${r.text}`.slice(0, 4000));
}

async function autoSaveSessionMemory() {
  if (!bridge.recallTool) return;
  const jakeLines = sessionLog.filter((l) => l.role === "jake");
  if (jakeLines.length < SESSION_AUTO_SAVE_MIN_TURNS) return;

  const summaryParts = [];
  for (const line of sessionLog.slice(-16)) {
    summaryParts.push(`${line.role === "jake" ? "Jake" : "Cog"}: ${line.text}`);
  }
  const summary = summaryParts.join("\n").slice(0, 3500);
  const title = `Cog chat ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  await bridge.recallTool("recall_save_note", {
    title,
    summary,
    tags: ["cog", "conversation", "relationship"],
    project: "WorkBuddy",
  });
}

function startContextFeed() {
  stopContextFeed(false);
  sessionLog = [];
  pushSystemContext(true);
  pushRecallBrief();
  contextTimer = setInterval(() => {
    pushSystemContext(false);
    pushRecallLive();
  }, 30000);
}

function stopContextFeed(save = true) {
  if (contextTimer) clearInterval(contextTimer);
  contextTimer = null;
  if (save) autoSaveSessionMemory().catch(() => {});
}

window.CogVoice.init({
  open() {
    inCall = true;
    if (window.CogWake) window.CogWake.stop();
    cancelAll();
    target = null;
    setState("listen");
    setFace("listen");
    bubbleText("I'm listening.", 0, "click me to hang up");
    startContextFeed();
  },
  closed() {
    inCall = false;
    stopContextFeed(true);
    sayToken += 1;
    el.classList.remove("is-talking");
    setState("idle");
    setFace("focused");
    lastPoke = Date.now();
    if (window.CogWake && voiceReady) window.CogWake.start();
  },
  speakStart() {
    setState("speak");
    setFace("speak");
  },
  speakEnd() {
    if (!inCall) return;
    setState("listen");
    setFace("listen");
  },
  heard(text) {
    trackSessionLine("jake", text);
    if (text) bubbleText(text, 0);
  },
  said(text) {
    trackSessionLine("cog", text);
    if (!text) return;
    faceLockUntil = 0;
    // Typed conversations have no call open, so clear the bubble ourselves.
    if (chatting) {
      bubbleText(text, Math.min(12000, 3000 + text.length * 55));
    } else {
      bubbleText(text, 0);
    }
  },
  level(l) {
    updateMeters(l.input, l.output, l.speaking);
  },
  tool() {},
  // He tried to fill a silence and the gate stopped him. Nothing shown,
  // nothing played — he just stays listening.
  suppressed() {},
  ignored() {},
  error(code) {
    inCall = false;
    const trouble = VOICE_TROUBLE[code] || ["Something went wrong.", ""];
    say(trouble[0], 5200, "squint", trouble[1]);
    if (window.CogWake && voiceReady) window.CogWake.start();
  },
});

// ---------- cursor in his face ----------
//
// Put the pointer on his head and his eyes follow it around the screen. Take
// it away and he keeps glaring at it, half-lidded, for five more seconds.

const FACE_PAD = 8;
const ANNOY_MS = 5000;
const EYE_RANGE_X = 5;
const EYE_RANGE_Y = 3.4;

let faceHovering = false;
let annoyedUntil = 0;
let faceLockUntil = 0;

function headBox() {
  const head = flip.querySelector(".j-head");
  const r = head && head.getBoundingClientRect();
  return r && r.width ? r : null;
}

function aimEyes(box) {
  const hx = (box.left + box.right) / 2;
  const hy = (box.top + box.bottom) / 2;
  const nx = Math.max(-1, Math.min(1, (pointer.x - hx) / Math.max(box.width / 2, 1)));
  const ny = Math.max(-1, Math.min(1, (pointer.y - hy) / Math.max(box.height / 2, 1)));
  // .eye-track lives inside .cog-flip, which is mirrored when he faces left,
  // so the horizontal sense has to be inverted or his eyes track backwards.
  const sign = el.dataset.facing === "left" ? -1 : 1;
  el.style.setProperty("--eye-x", `${(nx * EYE_RANGE_X * sign).toFixed(1)}px`);
  el.style.setProperty("--eye-y", `${(ny * EYE_RANGE_Y).toFixed(1)}px`);
}

function clearEyes() {
  el.style.removeProperty("--eye-x");
  el.style.removeProperty("--eye-y");
}

function forgetAnnoyance() {
  faceHovering = false;
  annoyedUntil = 0;
  faceLockUntil = 0;
  clearEyes();
}

function pollFace() {
  if (inCall || inHand()) return;
  const box = headBox();
  if (!box || pointer.x < 0) return;

  const inside =
    pointer.x >= box.left - FACE_PAD &&
    pointer.x <= box.right + FACE_PAD &&
    pointer.y >= box.top - FACE_PAD &&
    pointer.y <= box.bottom + FACE_PAD;

  const now = Date.now();

  if (inside) {
    if (!faceHovering || annoyedUntil) {
      faceHovering = true;
      annoyedUntil = 0;
      setFace("focused", true);
    }
    faceLockUntil = now + 400;
    aimEyes(box);
    return;
  }

  if (faceHovering) {
    faceHovering = false;
    annoyedUntil = now + ANNOY_MS;
    setFace("annoyed", true);
  }

  if (annoyedUntil) {
    if (now < annoyedUntil) {
      // Still glaring — the eyes keep following wherever the cursor went.
      faceLockUntil = annoyedUntil;
      aimEyes(box);
    } else {
      annoyedUntil = 0;
      faceLockUntil = 0;
      clearEyes();
      setFace("focused", true);
    }
  }
}

setInterval(pollFace, 50);

// ---------- watching the cursor ----------
//
// He can crane his head within a realistic cone and turn his body to follow,
// but he gives up once the cursor leaves what he could plausibly see — below
// his own feet, or right on top of him.

const AIM_UP = -36; // furthest he'll crane upwards
const AIM_DOWN = 15; // he can't look far down past his own chest
const PITCH_FLOOR = -46; // below this the cursor is behind/under him: stop
const FLIP_MARGIN = 34; // hysteresis so he doesn't jitter across the midline

function aimAtPointer() {
  if (pointer.x < 0) return null;
  const r = el.getBoundingClientRect();
  if (!r.width) return null;

  // Head centre in element space is (60, 67) of the 120x190 rig.
  const headX = r.left + r.width * 0.5;
  const headY = r.top + r.height * (67 / 190);
  const dx = pointer.x - headX;
  const dy = pointer.y - headY;

  if (Math.hypot(dx, dy) < 26) return null; // cursor is basically on him

  const pitch = (Math.atan2(-dy, Math.max(Math.abs(dx), 1)) * 180) / Math.PI;
  if (pitch < PITCH_FLOOR) return null; // he'd have to look through himself

  return {
    deg: Math.max(AIM_UP, Math.min(AIM_DOWN, -pitch * 0.72)),
    dir: dx < 0 ? -1 : 1,
    dx,
  };
}

function applyAim(aim) {
  el.style.setProperty("--head-aim", `${aim.deg.toFixed(1)}deg`);
  if (Math.abs(aim.dx) > FLIP_MARGIN) setFacing(aim.dir);
}

function stopWatching() {
  el.classList.remove("is-watching");
  el.style.removeProperty("--head-aim");
}

// Track for a while, bailing the moment the angle stops being plausible.
async function watchCursor(ms) {
  const first = aimAtPointer();
  if (!first) return "no-target";
  el.classList.add("is-watching");
  applyAim(first);

  const until = Date.now() + ms;
  while (Date.now() < until) {
    const beat = await wait(70);
    if (beat === "cancelled" || inHand() || inCall || alerting) break;
    const aim = aimAtPointer();
    if (!aim) break; // lost him — look away rather than crane impossibly
    applyAim(aim);
  }
  stopWatching();
  return "done";
}

// ---------- idle behaviours ----------

const IDLE_LOOKS = ["curious", "squint", "pleased", "focused"];

async function stroll() {
  const dest = clampWalk(x + rand(-760, 760));
  if (Math.abs(dest - x) < 60) return wait(1200);
  await walkTo(dest);
  setState("idle");
  return wait(rand(1500, 4000));
}

async function lookAround() {
  setState("idle");
  setFace(IDLE_LOOKS[Math.floor(Math.random() * IDLE_LOOKS.length)]);
  setFacing(-1);
  await wait(1100);
  setFacing(1);
  await wait(1100);
  setFace("focused");
  if (Math.random() < 0.25) await say(pickLine("chatter"), 2400);
  return wait(rand(800, 2000));
}

// His favourite thing to do. He perches on the taskbar for a good while,
// swinging his legs and glancing around, rather than sitting for four seconds
// and popping straight back up.
const SIT_LOOKS = ["squint", "curious", "focused", "pleased", "focused"];

async function sitDown() {
  setState("sit");
  puffAtFeet(1.05);
  setFace("squint");

  const until = Date.now() + rand(14000, 30000);
  while (Date.now() < until) {
    const beat = await wait(rand(2600, 5400));
    if (beat === "cancelled" || inHand() || inCall || alerting) break;

    // Sometimes he clocks the cursor and follows it instead.
    if (Math.random() < 0.3) {
      const watched = await watchCursor(rand(2800, 6000));
      if (watched !== "no-target") continue;
    }

    if (Math.random() < 0.34) {
      // Turn towards the open desktop and just look at it for a while.
      const here = screenAt(x + COM_X);
      setFacing((here.left + here.right) / 2 - (x + COM_X));
      el.classList.add("is-gazing");
      setFace("wonder");
      const gaze = await wait(rand(3200, 6000));
      el.classList.remove("is-gazing");
      if (gaze === "cancelled" || inHand() || inCall || alerting) break;
      continue;
    }

    setFace(SIT_LOOKS[Math.floor(Math.random() * SIT_LOOKS.length)]);
    // Glance over his shoulder now and then.
    if (Math.random() < 0.25) setFacing(Math.random() < 0.5 ? -1 : 1);
  }

  el.classList.remove("is-gazing");
  setState("idle");
  puffAtFeet(0.8);
  setFace("focused");
  setFacing(1);
  return wait(600);
}

// Flat out on the taskbar: head on the bar, near arm and leg hanging over the
// lip, far leg stretched along it. Rare, on purpose.
async function lieDown() {
  setState("lie");
  puffAtFeet(1.15, 18);
  setFace("squint");
  await wait(900);
  setFace("focused");

  const until = Date.now() + rand(18000, 34000);
  while (Date.now() < until) {
    const beat = await wait(rand(3400, 6200));
    if (beat === "cancelled" || inHand() || inCall || alerting) break;
    if (Math.random() < 0.4) {
      // Picking his head up off the bar to actually look at the thing.
      el.classList.add("is-headup");
      const watched = await watchCursor(rand(2600, 5000));
      el.classList.remove("is-headup");
      if (watched === "no-target") setFace(Math.random() < 0.5 ? "squint" : "pleased");
      continue;
    }
    if (Math.random() < 0.3) {
      el.classList.add("is-headup");
      setFace("curious");
      await wait(rand(1800, 3200));
      el.classList.remove("is-headup");
      continue;
    }
    setFace(SIT_LOOKS[Math.floor(Math.random() * SIT_LOOKS.length)]);
  }

  stopWatching();
  el.classList.remove("is-headup");
  setState("idle");
  puffAtFeet(0.85);
  setFace("focused");
  return wait(700);
}

async function goToSleep() {
  asleep = true;
  await walkTo(screenAt(x + COM_X).right - CHAR_W - 14);
  setState("sit");
  await wait(900);
  setState("sleep");
  setFace("sleep");
  await say(pickLine("sleepy"), 2400, "sleep");
}

async function wakeUp() {
  if (!asleep) return;
  asleep = false;
  setState("idle");
  setFace("focused");
}

async function live() {
  setFacing(1);
  lift = liftAt(x + COM_X);
  place();
  await wait(600);
  setState("wave");
  await say("Hi. I'm Cog.", 2600, "pleased", "I'll tell you when the agent's done.");
  setState("idle");

  for (;;) {
    if (inHand() || inCall || chatting) {
      await wait(250);
      continue;
    }
    if (alerting) {
      await wait(400);
      continue;
    }
    if (asleep) {
      await wait(1500);
      continue;
    }
    if (Date.now() - lastPoke > SLEEP_AFTER_MS) {
      await goToSleep();
      continue;
    }

    // Weighted towards sitting — it's the most characterful thing he does.
    const roll = Math.random();
    if (roll < 0.4) await sitDown();
    else if (roll < 0.62) await stroll();
    else if (roll < 0.74) await watchCursor(rand(3000, 7000));
    else if (roll < 0.86) await lookAround();
    else if (roll < 0.93) await lieDown();
    else {
      setState("idle");
      await wait(rand(2500, 6500));
    }
  }
}

// ---------- the job: get you back to work ----------

async function startAlert(payload) {
  if (alerting) return;
  stopWatching();
  // If you're mid-conversation with him you're obviously at your desk, so
  // there's nothing to fetch you back from — he just mentions it.
  if (inCall) {
    bubbleText("Agent's done, by the way.", 5000);
    bridge.ack();
    return;
  }
  alerting = true;
  asleep = false;
  cancelAll();

  const label = payload && payload.title ? String(payload.title).slice(0, 60) : "";
  // He nudges you from the middle of whichever monitor he's standing on.
  const here = screenAt(x + COM_X);
  await walkTo((here.left + here.right) / 2 - CHAR_W / 2);

  setState("alert");
  setFace("alert");
  speakLine("done", `A coding agent just finished${label ? ` (${label})` : ""} and you are fetching Jake back to his desk.`, 7000, "alert", label || "click me when you're back");

  while (alerting) {
    const result = await wait(ESCALATE_MS);
    if (result === "cancelled" || !alerting) break;
    say(pickLine("doneAgain"), 7000, "alert", "click me when you're back");
  }
}

async function acknowledge() {
  const wasAlerting = alerting;
  alerting = false;
  lastPoke = Date.now();
  cancelAll();
  await wakeUp();

  if (wasAlerting) {
    bridge.ack();
    setState("wave");
    await say(pickLine("ack"), 2400, "pleased");
  } else {
    setState("wave");
    await say(pickLine("chatter"), 2200, "pleased");
  }
  setState("idle");
  setFace("focused");
}

// A click means different things depending on what he's doing.
function tap() {
  if (alerting) {
    acknowledge();
    return;
  }
  if (inCall) {
    endCall();
    return;
  }
  if (chatting) {
    closeChat();
    return;
  }
  // A click starts talking to him. His eyes light the moment it happens so
  // there's never any doubt the microphone is open.
  startCall();
}

async function nag() {
  if (alerting || asleep || inHand() || inCall || chatting) return;
  cancelAll();
  setState("point");
  setFace("nag");
  await speakLine("nag", "You are checking in on Jake to see if he is still working.", 4200, "nag");
  setState("idle");
  setFace("focused");
}

setInterval(nag, NAG_EVERY_MS);

// ---------- grab and throw ----------

let pointer = { x: -1, y: -1 };

el.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  cancelAll();
  target = null;
  dragMoved = false;
  el.style.transition = "";
  el.classList.remove("is-landing");
  // Being picked up trumps whatever the cursor-in-his-face state was.
  forgetAnnoyance();

  pointer = { x: e.clientX, y: e.clientY };
  pressX = e.clientX;
  pressY = e.clientY;
  if (!flying) enterPhysics();
  held = true;
  flying = false;

  // Remember the grab point in body-local coordinates so the spring pulls
  // on the spot you actually clicked, not on his middle.
  const c = Math.cos(-theta);
  const s = Math.sin(-theta);
  const dx = e.clientX - cx;
  const dy = e.clientY - cy;
  grabLX = dx * c - dy * s;
  grabLY = dx * s + dy * c;

  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // capture is a nicety; the window listeners cover us either way
  }

  setState("held");
  setFace("alarmed");
  // Hold the mouse for the whole drag — he'll outrun his own hit box.
  interactive = true;
  bridge.setInteractive(true);
});

window.addEventListener("pointermove", (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  if (held) {
    const dx = e.clientX - pressX;
    const dy = e.clientY - pressY;
    if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      dragMoved = true;
    }
    return;
  }
  refreshInteractive();
});

window.addEventListener("pointerup", () => {
  if (!held) return;
  // Let go. Whatever momentum the spring built is the throw.
  held = false;
  flying = true;
  setState("fly");
  if (!dragMoved) {
    flying = false;
    theta = 0;
    place();
    setState("idle");
    setFace("focused");
    tap();
  }
  refreshInteractive();
});

window.addEventListener("pointercancel", () => {
  if (!held) return;
  held = false;
  flying = true;
  setState("fly");
});

// ---------- click-through plumbing ----------

// The window is click-through by default; we only claim the mouse while the
// pointer is actually over Cog or his bubble.
let interactive = false;

function hits(rect, pad) {
  return (
    pointer.x >= rect.left - pad &&
    pointer.x <= rect.right + pad &&
    pointer.y >= rect.top - pad &&
    pointer.y <= rect.bottom + pad
  );
}

function refreshInteractive() {
  if (held) return;
  const overBody = hits(el.getBoundingClientRect(), 4);
  const overBubble = el.classList.contains("is-talking") && hits(bubble.getBoundingClientRect(), 4);
  const next = overBody || overBubble;
  if (next !== interactive) {
    interactive = next;
    bridge.setInteractive(next);
  }
}

// Cog moves under a stationary cursor too, so re-test on a slow tick.
setInterval(refreshInteractive, 140);

window.addEventListener("resize", () => {
  x = clamp(x);
  lift = liftAt(x + COM_X);
  if (!inHand()) place();
});

// Dev aid: N fakes a nudge, S makes him sleepy. Only reachable when the
// page has keyboard focus, which the real overlay never takes.
window.addEventListener("keydown", (e) => {
  if (e.key === "n") startAlert({ title: "test nudge" });
  if (e.key === "s") lastPoke = 0;
});

// Test hook so the browser preview can fake a multi-monitor layout.
window.__cog = {
  setScreens(list) {
    screens = list;
    x = clamp(x);
    lift = liftAt(x + COM_X);
    if (!inHand()) place();
  },
  state: () => ({ x, lift, cx, cy, held, flying, screen: screenAt(x + COM_X) }),
};

if (window.CogWake) {
  window.CogWake.init({
    onWake(phrase) {
      if (inCall || alerting) return;
      console.log("[wake] heard:", phrase);
      bubbleText("Hey — I'm here.", 1800);
      startCall();
    },
  });
}

if (bridge.voiceStatus) {
  bridge
    .voiceStatus()
    .then((s) => {
      voiceReady = Boolean(s && s.configured);
      if (voiceReady && s.wakeWord !== false && s.wakeSupported && window.CogWake) {
        window.CogWake.start();
        console.log("[wake] listening for:", (s.wakePhrases || ["hey cog"]).join(", "));
      }
    })
    .catch(() => {
      voiceReady = false;
    });
}

if (bridge.onChatOpen) bridge.onChatOpen(() => (chatting ? closeChat() : openChat()));
if (bridge.onVoiceStart) {
  bridge.onVoiceStart(() => {
    if (!inCall) startCall();
  });
}

bridge.onGrow((payload) => startAlert(payload));
bridge.onAck(() => {
  if (alerting) acknowledge();
});

requestAnimationFrame(frame);
live();
