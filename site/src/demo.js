// The Scrappy on imscrappy.dev is the Scrappy in the app: rig.js builds the
// same SVG and character.css (a straight copy of renderer/style.css) drives the
// same keyframes. Only the behaviour loop is rewritten here.
//
// renderer/scrappy.js is deliberately NOT loaded on the page. It calls
// ScrappyVoice.init() at module scope, binds a window keydown handler that would
// eat typing on the page, and wires a menu with "Quit Scrappy" in it. So the
// wander loop, the cursor tracking and the rigid body are ported instead, with
// the constants kept identical — they are tuned against the CSS, not free
// parameters. The multi-monitor code and the seam-shatter effect are dropped:
// one stage, one floor.

const RIG = window.ScrappyRig;
const pickLine = window.ScrappyLines.pick;

const stage = document.getElementById("stage");
const el = document.getElementById("scrappy");
const flip = el.querySelector(".scrappy-flip");
const bubble = document.getElementById("bubble");

flip.innerHTML = RIG.buildScrappy();
// Every wear tier is already in the DOM; this attribute picks which are shown.
// Without it he renders with none of his rust, which is the same mistake as
// shipping a different robot to the website than the one people install.
el.dataset.wear = window.ScrappyWear.LEVEL;
const faceEl = document.getElementById("scrappy-face");

const CHAR_W = 120;
// Matched to the stride in character.css. Geometry says 77px/s, but the contact
// point traces an arc and the knee flexes under load, so the foot actually
// tracks back 87px/s. Change this without re-measuring and he skates.
const SPEED = 85;
const STRIDE_DUST = 34; // px of travel between footfalls

const COM_X = 60; // centre of mass, element-local
const COM_Y = 118;
const GROUND_OFFSET = 176; // element-local y of the floor his feet stand on
const COM_FLOOR = GROUND_OFFSET - COM_Y; // COM height above the stage floor
// The app uses 100 here, but its ceiling is the top of a screen he can safely
// be clipped against. The page clips at the hero, so a hard throw would slice
// the top off his head: the ceiling bounds his centre of mass, and a tumbling
// body reaches further than an upright one — half his diagonal is ~112px. Sit
// just outside that and he stays whole at any angle.
const COM_CEIL = 118;

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

const SLEEP_AFTER_MS = 40000;
const CHATTER_EVERY_MS = 26000;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let x = 60;
let target = null;
let resolveWalk = null;
let alerting = false;
let asleep = false;
let sayToken = 0;
let lastPoke = Date.now();
let lastChatter = Date.now();
let paused = false;
let dustAccum = 0;
let dustFoot = 0;

const rand = (a, b) => a + Math.random() * (b - a);
const bounds = () => Math.max(0, stage.clientWidth - CHAR_W);
const clamp = (v) => Math.max(0, Math.min(bounds(), v));

// ---------- rigid body ----------
// He is a point mass with a moment of inertia. Grabbing attaches a spring
// between your cursor and the exact spot you grabbed; that spring's torque
// about his centre of mass is what makes him swing, whip, and keep spinning
// after you let go. Releasing just stops applying the spring — the momentum he
// already has is the throw.
//
// Everything here is in stage-local pixels. The app could use client
// coordinates because its stage covered the whole screen; here the stage is one
// element on a scrolling page, so pointer positions get converted on the way in.

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

const inHand = () => held || flying;

// Pointer in client coordinates (what getBoundingClientRect speaks) plus the
// stage-local copy the spring needs.
let pointer = { x: -1, y: -1 };

function toStage(clientX, clientY) {
  const r = stage.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

function place() {
  if (inHand()) {
    const tx = cx - COM_X;
    const ty = cy - (stage.clientHeight - COM_FLOOR);
    el.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) rotate(${((theta * 180) / Math.PI).toFixed(1)}deg)`;
  } else {
    el.style.transform = `translate(${x.toFixed(1)}px, 0px)`;
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
  // The cursor-in-his-face reaction outranks whatever the behaviour loop wanted.
  if (!force && Date.now() < faceLockUntil) return;
  faceEl.innerHTML = (RIG.FACES[name] || RIG.FACES.focused)();
}

function setFacing(dir) {
  el.dataset.facing = dir < 0 ? "left" : "right";
}

// ---------- dust ----------

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

function puffAtFeet(scale, spread = 13) {
  const floor = stage.clientHeight;
  puff(x + COM_X - spread, floor, scale, -1);
  puff(x + COM_X + spread, floor, scale, 1);
}

// ---------- physics ----------

function enterPhysics() {
  cx = x + COM_X;
  cy = stage.clientHeight - COM_FLOOR;
  vx = 0;
  vy = 0;
  omega = 0;
  theta = 0;
  settleFor = 0;
}

function step(dt) {
  const floorY = stage.clientHeight - COM_FLOOR;
  // On a short stage a fixed ceiling could sit below the floor; keep him room.
  const ceilY = Math.min(COM_CEIL, floorY - 40);
  const leftX = COM_X;
  const rightX = Math.max(leftX + 1, stage.clientWidth - COM_X);

  let ax = 0;
  let ay = GRAVITY;
  let alpha = 0;

  if (held) {
    // Where the grabbed point currently is, and how fast that material point is
    // moving (body velocity plus rotation about the centre).
    const p = toStage(pointer.x, pointer.y);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const rx = grabLX * c - grabLY * s;
    const ry = grabLX * s + grabLY * c;
    const px = cx + rx;
    const py = cy + ry;
    const pvx = vx - omega * ry;
    const pvy = vy + omega * rx;

    const fx = SPRING * (p.x - px) - SPRING_DAMP * pvx;
    const fy = SPRING * (p.y - py) - SPRING_DAMP * pvy;

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

  // Walls. A glancing hit bleeds sideways speed into spin, which is what makes
  // him tumble off a wall instead of mirroring cleanly.
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

  if (!held) {
    const resting =
      cy >= floorY - 0.5 && Math.abs(vy) < 45 && Math.abs(vx) < 42 && Math.abs(omega) < 1.1;
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
  const spun = Math.abs(theta) > 0.8;
  vx = 0;
  vy = 0;
  omega = 0;
  settleFor = 0;
  target = null;
  stopWatching();
  x = clamp(cx - COM_X);

  // Snap upright with a little overshoot instead of freezing mid-tumble.
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
  asleep = false;
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
  target = clamp(dest);
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
let rafId = null;

// Integration is split out of the rAF callback so a test can advance the
// simulation by hand — requestAnimationFrame is throttled to nothing while the
// page is hidden, which would otherwise leave him frozen mid-stride.
function advance(dt) {
  if (inHand()) {
    step(dt);
    return;
  }

  // Keep him inside the stage every frame rather than trusting the resize
  // event. The stage doesn't clip vertically (his speech bubble reaches above
  // it), so a Scrappy left standing outside it after a viewport change would
  // widen the page and hand the whole site a horizontal scrollbar.
  const penned = clamp(x);
  if (penned !== x) {
    x = penned;
    if (target !== null) target = clamp(target);
    place();
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
          stage.clientHeight,
          0.6,
          el.dataset.facing === "left" ? 1 : -1
        );
      }
    }
    place();
  }
}

function frame(now) {
  const dt = Math.min(0.04, (now - lastFrame) / 1000);
  lastFrame = now;
  advance(dt);
  rafId = requestAnimationFrame(frame);
}

// ---------- speech ----------

async function say(text, ms = 3400, face = "talk") {
  const mine = ++sayToken;
  bubble.textContent = text;
  el.classList.add("is-talking");
  setFace(face);
  await wait(ms);
  if (mine !== sayToken) return;
  el.classList.remove("is-talking");
  if (!alerting) setFace(asleep ? "sleep" : "focused");
}

// ---------- cursor in his face ----------
// Ported from renderer/scrappy.js: his eyes follow your cursor, and he holds a
// grudge for five seconds after you wave it at him. This is the detail that
// makes him read as alive rather than as a looping animation.

const FACE_PAD = 26;
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
  // .eye-track lives inside .scrappy-flip, which is mirrored when he faces left,
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
  if (paused || inHand() || asleep) return;
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
      if (!alerting) setFace("focused", true);
    }
    faceLockUntil = now + 400;
    aimEyes(box);
    return;
  }

  if (faceHovering) {
    faceHovering = false;
    annoyedUntil = now + ANNOY_MS;
    if (!alerting) setFace("annoyed", true);
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
      if (!alerting) setFace("focused", true);
    }
  }
}

// ---------- watching the cursor ----------
// He cranes his head within a plausible cone, and turns to face you when you're
// clearly off to one side. He gives up once the cursor drops below his own feet.

const AIM_UP = -36;
const AIM_DOWN = 15;
const PITCH_FLOOR = -46;
const FLIP_MARGIN = 34;

function stopWatching() {
  el.classList.remove("is-watching");
  el.style.removeProperty("--head-aim");
}

function watchPointer() {
  if (paused || inHand() || asleep || pointer.x < 0) return;
  const r = el.getBoundingClientRect();
  if (!r.width) return;

  // Head centre in element space is (60, 67) of the 120x190 rig.
  const headX = r.left + r.width * 0.5;
  const headY = r.top + r.height * (67 / 190);
  const dx = pointer.x - headX;
  const dy = pointer.y - headY;
  const pitch = (Math.atan2(-dy, Math.max(Math.abs(dx), 1)) * 180) / Math.PI;

  if (pitch < PITCH_FLOOR) {
    stopWatching();
    return;
  }

  el.classList.add("is-watching");
  el.style.setProperty("--head-aim", `${Math.max(AIM_UP, Math.min(AIM_DOWN, -pitch * 0.72)).toFixed(1)}deg`);

  // Only turn his body when he's standing still; mid-stride a flip would fight
  // the direction he's walking.
  if (target === null && Math.abs(dx) > FLIP_MARGIN) setFacing(dx);
}

setInterval(() => {
  pollFace();
  watchPointer();
}, 50);

// ---------- behaviour ----------

function poke() {
  lastPoke = Date.now();
  if (asleep) {
    asleep = false;
    setState("idle");
    say(pickLine("wake"), 2400, "wonder");
  }
}

async function nap() {
  cancelAll();
  await walkTo(x);
  setState("sit");
  setFace("squint");
  if ((await wait(1600)) === "cancelled") return;
  setState("sleep");
  setFace("sleep");
  asleep = true;
}

async function wave() {
  cancelAll();
  poke();
  setState("wave");
  say(pickLine("ack"), 2200, "pleased");
  if ((await wait(2200)) === "cancelled") return;
  setState("idle");
}

// The real thing: an agent finished, so he walks to the middle, goes amber, and
// jumps until you click him.
async function agentDone() {
  cancelAll();
  poke();
  alerting = true;
  const mid = Math.round(bounds() / 2);
  await walkTo(mid);
  if (!alerting) return;
  setState("alert");
  setFace("alert", true);
  say(pickLine("done"), 4200, "alert");
  let rounds = 0;
  while (alerting) {
    if ((await wait(9000)) === "cancelled") return;
    if (!alerting) return;
    rounds += 1;
    say(pickLine("doneAgain"), 3600, "alert");
    if (rounds > 3) break;
  }
  if (alerting) acknowledge();
}

function acknowledge() {
  if (!alerting) return;
  alerting = false;
  cancelAll();
  setState("wave");
  say(pickLine("ack"), 2400, "pleased");
  setTimeout(() => {
    if (!alerting && !inHand()) setState("idle");
  }, 2400);
}

async function loop() {
  // Under reduced motion he stands there instead of wandering. Picking him up
  // still works — that's a response to you, not unprompted movement.
  if (reduceMotion.matches) return;

  while (true) {
    if (paused || inHand() || alerting) {
      await wait(500);
      continue;
    }

    const idleFor = Date.now() - lastPoke;
    if (!asleep && idleFor > SLEEP_AFTER_MS) {
      await nap();
      continue;
    }
    if (asleep) {
      await wait(1200);
      continue;
    }

    const roll = Math.random();
    if (roll < 0.62) {
      await walkTo(rand(0, bounds()));
      setFace("focused");
      await wait(rand(900, 2600));
    } else if (roll < 0.82) {
      setState("idle");
      setFace(Math.random() < 0.5 ? "curious" : "focused");
      await wait(rand(1800, 3800));
    } else {
      setState("sit");
      setFace("pleased");
      await wait(rand(2600, 5200));
      setState("idle");
    }

    if (Date.now() - lastChatter > CHATTER_EVERY_MS && !asleep && !alerting) {
      lastChatter = Date.now();
      say(pickLine("chatter"), 2600);
      await wait(2600);
    }
  }
}

// ---------- grab and throw ----------

el.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  // Only his own pointerdown is prevented, so text selection and scrolling
  // everywhere else on the page behave normally.
  e.preventDefault();
  cancelAll();
  target = null;
  dragMoved = false;
  el.style.transition = "";
  el.classList.remove("is-landing");
  // Being picked up trumps whatever the cursor-in-his-face state was.
  forgetAnnoyance();
  stopWatching();

  pointer = { x: e.clientX, y: e.clientY };
  pressX = e.clientX;
  pressY = e.clientY;
  if (!flying) enterPhysics();
  held = true;
  flying = false;

  // Remember the grab point in body-local coordinates so the spring pulls on
  // the spot you actually clicked, not on his middle.
  const p = toStage(e.clientX, e.clientY);
  const c = Math.cos(-theta);
  const s = Math.sin(-theta);
  const dx = p.x - cx;
  const dy = p.y - cy;
  grabLX = dx * c - dy * s;
  grabLY = dx * s + dy * c;

  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // capture is a nicety; the window listeners cover us either way
  }

  setState("held");
  setFace("alarmed");
});

window.addEventListener("pointermove", (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  if (!held) return;
  const dx = e.clientX - pressX;
  const dy = e.clientY - pressY;
  if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) dragMoved = true;
});

function release() {
  if (!held) return;
  // Let go. Whatever momentum the spring built is the throw.
  held = false;
  poke();
  if (!dragMoved) {
    // A click, not a throw.
    flying = false;
    theta = 0;
    place();
    if (alerting) {
      acknowledge();
    } else {
      setState("idle");
      setFace("focused");
      wave();
    }
    return;
  }
  flying = true;
  setState("fly");
}

window.addEventListener("pointerup", release);
window.addEventListener("pointercancel", release);

// ---------- the demo buttons ----------

const ACTIONS = {
  done: agentDone,
  wave,
  nap,
  say: () => {
    poke();
    say(pickLine("nag"), 3200, "nag");
  },
};

for (const button of document.querySelectorAll("[data-poke]")) {
  button.addEventListener("click", () => {
    const act = ACTIONS[button.dataset.poke];
    if (!act) return;
    if (button.dataset.poke !== "done") alerting = false;
    act();
  });
}

// ---------- lifecycle ----------

// No point simulating him while he's scrolled off the screen, and a page that
// has been in a background tab for an hour shouldn't come back to a Scrappy
// mid-tantrum.
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      paused = !entry.isIntersecting;
      if (paused) {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
      } else if (rafId === null) {
        lastFrame = performance.now();
        lastPoke = Date.now();
        rafId = requestAnimationFrame(frame);
      }
    }
  },
  { threshold: 0 }
);
observer.observe(stage);

window.addEventListener("resize", () => {
  x = clamp(x);
  if (target !== null) target = clamp(target);
  if (!inHand()) place();
});

// Test hook, in the spirit of window.__scrappy in the app: report his physics
// state, and step the simulation without waiting on the frame clock.
window.__scrappyDemo = {
  state: () => ({
    x,
    cx,
    cy,
    vx,
    vy,
    theta,
    omega,
    held,
    flying,
    target,
    state: el.dataset.state,
    facing: el.dataset.facing,
    asleep,
    alerting,
    paused,
  }),
  tick(ms = 16) {
    advance(Math.min(0.04, ms / 1000));
  },
};

el.hidden = false;
place();
setFace("focused");
rafId = requestAnimationFrame(frame);
loop();
