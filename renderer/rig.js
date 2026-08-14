// Scrappy — the rig. Bobblehead proportions, gear-toothed joints, one SVG.
// Every joint is a nested <g> with its transform-origin baked in, so CSS
// keyframes on .j-* classes drive the whole character.

const P = {
  headW: 82,
  headH: 56,
  torsoW: 44,
  torsoH: 36,
  legLen: 28,
  armLen: 28,
  limbW: 11,
  armW: 9,
  bootH: 9,
};

const C = 60;
const GROUND = 176;

const HIP_Y = GROUND - P.bootH - P.legLen;
const THIGH = P.legLen * 0.54;
const SHIN = P.legLen * 0.46;
const KNEE_Y = HIP_Y + THIGH;

const TORSO_BOTTOM = HIP_Y + 5;
const TORSO_TOP = TORSO_BOTTOM - P.torsoH;
const TORSO_X = C - P.torsoW / 2;

const SHOULDER_Y = TORSO_TOP + P.torsoH * 0.2;
const UPPER_ARM = P.armLen * 0.54;
const FOREARM = P.armLen * 0.46;
const ELBOW_Y = SHOULDER_Y + UPPER_ARM;
const HAND_Y = ELBOW_Y + FOREARM + 3;

// Enough clearance that the flex pipe actually reads between the two.
const HEAD_BOTTOM = TORSO_TOP - 13;
const HEAD_TOP = HEAD_BOTTOM - P.headH;
const HEAD_X = C - P.headW / 2;

// Head is yawed toward the direction of travel — the face sits off-centre.
const YAW = 5;
const SCREEN = {
  x: HEAD_X + P.headW * 0.11 + YAW,
  y: HEAD_TOP + P.headH * 0.15,
  w: P.headW * 0.78,
  h: P.headH * 0.7,
};

// Three-quarter view: the far side of the body wraps away from the viewer, so
// the far limbs tuck IN behind the torso rather than sitting outboard of it.
// Pushed outward they read as foreground and the depth cue inverts.
const LEG_L_X = C - P.torsoW * 0.24 - 3;
const LEG_R_X = C + P.torsoW * 0.24 - 2;
// Both shoulders sit the same distance from the torso centreline — a yaw
// compresses them equally, it does not push the near one outboard. Depth is
// carried by draw order and shading, not by sticking the near arm out. The
// extra inch on the near arm rides it onto the body rather than off its edge.
const ARM_SPREAD = P.torsoW / 2 - 4;
const ARM_L_X = C - ARM_SPREAD + 1;
const ARM_R_X = C + ARM_SPREAD;

const INK = {
  shellNear: "#5B6B8C",
  shellNearLit: "#67779B",
  shellFar: "#374561",
  shellFarLit: "#404F70",
  bootNear: "#414F6E",
  bootFar: "#28303F",
  metal: "#8C9BB8",
  metalDark: "#39445E",
  screen: "#1D2433",
  mint: "#6FE3C0",
  amber: "#E8734A",
  panel: "#2B3550",
  ledRed: "#E2564A",
  ledYellow: "#E9C244",
  ledGreen: "#6FE3C0",
};

const GEO = {
  width: 120,
  height: 190,
  ground: GROUND,
  headTop: HEAD_TOP,
  headCenterX: C,
  screen: SCREEN,
};

// A gear silhouette: trapezoid teeth around a hub. Lives inside the child
// group of each joint, so it turns as the limb turns.
function gear(cx, cy, r, teeth, fill, hub) {
  const tip = r;
  const root = r * 0.78;
  const step = (Math.PI * 2) / teeth;
  // Wide flat tips with near-vertical flanks — squared-off teeth, not spikes.
  const shape = [
    [0.0, root],
    [0.26, root],
    [0.3, tip],
    [0.7, tip],
    [0.74, root],
    [1.0, root],
  ];
  let d = "";
  for (let i = 0; i < teeth; i += 1) {
    const base = i * step;
    for (let j = 0; j < shape.length; j += 1) {
      const [frac, rad] = shape[j];
      const a = base + frac * step;
      const x = (cx + Math.cos(a) * rad).toFixed(2);
      const y = (cy + Math.sin(a) * rad).toFixed(2);
      d += (i === 0 && j === 0 ? "M" : "L") + x + " " + y;
    }
  }
  d += "Z";
  return (
    `<path d="${d}" fill="${fill}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(r * 0.36).toFixed(2)}" fill="${hub}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${(r * 0.14).toFixed(2)}" fill="${fill}"/>`
  );
}

// Corrugated hose between torso and head. Built as a chain of nested
// segments, each pivoting at its own base and taking a quarter of
// --neck-bend, so the whole thing curves instead of hinging. The bottom
// collar sits outside the chain and never moves — that is what keeps him
// plugged into his own chest no matter where his head goes.
function flexNeck() {
  const top = HEAD_BOTTOM - 4;
  const bottom = TORSO_TOP + 2;
  const segs = 4;
  const pitch = (bottom - top) / segs;

  // Innermost first: the top collar rides on the last segment.
  let node = `<rect x="${C - 6}" y="${top - 3}" width="12" height="4" rx="1.6" fill="${INK.metalDark}"/>`;
  for (let k = 0; k < segs; k += 1) {
    const yTop = top + k * pitch;
    const base = top + (k + 1) * pitch;
    const wide = k % 2 === 0;
    const w = wide ? 14 : 12;
    node =
      `<g class="neck-seg" style="${origin(C, base)}">` +
      `<rect x="${C - 5}" y="${yTop.toFixed(2)}" width="10" height="${(pitch + 0.6).toFixed(2)}" fill="#3E4C6B"/>` +
      `<rect x="${C - w / 2}" y="${yTop.toFixed(2)}" width="${w}" height="${(pitch * 0.74).toFixed(2)}" rx="1.8" fill="${wide ? "#6B7A9C" : "#4E5D80"}"/>` +
      node +
      `</g>`;
  }

  return (
    `<g class="j-neck" style="${origin(C, bottom)}">` +
    `<rect x="${C - 7}" y="${bottom - 4}" width="14" height="4" rx="1.8" fill="${INK.metalDark}"/>` +
    node +
    `</g>`
  );
}

function origin(x, y) {
  return `transform-box:view-box;transform-origin:${x}px ${y}px`;
}

function foot(x, fill) {
  const w = P.limbW;
  const top = GROUND - P.bootH;
  return (
    `<path d="M${x - w * 0.7} ${top} H${x + w * 0.5} L${x + w * 1.5} ${GROUND - 3}` +
    ` Q${x + w * 1.5} ${GROUND} ${x + w * 1.1} ${GROUND} H${x - w * 0.5}` +
    ` Q${x - w * 0.9} ${GROUND} ${x - w * 0.7} ${top} Z" fill="${fill}"/>`
  );
}

function leg(side, x, shell, shellLit, bootFill, gearFill) {
  const w = P.limbW;
  return `
    <g class="j-hip j-hip-${side}" style="${origin(x, HIP_Y)}">
      <rect x="${x - w / 2}" y="${HIP_Y}" width="${w}" height="${THIGH + 2}" rx="${w / 2}" fill="${shell}"/>
      <g class="j-knee j-knee-${side}" style="${origin(x, KNEE_Y)}">
        <rect x="${x - w / 2}" y="${KNEE_Y}" width="${w}" height="${SHIN + 2}" rx="${w / 2}" fill="${shellLit}"/>
        ${foot(x, bootFill)}
        ${gear(x, KNEE_Y, w * 0.62, 8, gearFill, INK.metalDark)}
      </g>
      ${gear(x, HIP_Y, w * 0.49, 9, gearFill, INK.metalDark)}
    </g>`;
}

function arm(side, x, shell, shellLit, handFill, gearFill) {
  const w = P.armW;
  return `
    <g class="j-shoulder j-shoulder-${side}" style="${origin(x, SHOULDER_Y)}">
      <rect x="${x - w / 2}" y="${SHOULDER_Y}" width="${w}" height="${UPPER_ARM + 2}" rx="${w / 2}" fill="${shell}"/>
      <g class="j-elbow j-elbow-${side}" style="${origin(x, ELBOW_Y)}">
        <rect x="${x - w / 2}" y="${ELBOW_Y}" width="${w}" height="${FOREARM + 2}" rx="${w / 2}" fill="${shellLit}"/>
        <circle cx="${x}" cy="${HAND_Y}" r="${w * 0.72}" fill="${handFill}"/>
        ${gear(x, ELBOW_Y, w * 0.62, 7, gearFill, INK.metalDark)}
      </g>
      ${gear(x, SHOULDER_Y, w * 0.55, 8, gearFill, INK.metalDark)}
    </g>`;
}

// The screen is the whole face. Eyes carry every expression; a mouth only
// appears in the few states that animate one (talking, panic, dizzy).
const S = SCREEN;
const EYE_L = S.x + S.w * 0.32;
const EYE_R = S.x + S.w * 0.68;
const EYE_MID = S.y + S.h * 0.5;
const EYE_UP = S.y + S.h * 0.4;
const EW = S.w * 0.2;
const EH = S.h * 0.52;
const MOUTH_Y = S.y + S.h * 0.78;

const pair = (shape) => shape(EYE_L) + shape(EYE_R);

// A plain rounded slab eye. No highlight — the resting face stays minimal.
function slab(cy, w, h, fill) {
  return (cx) =>
    `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${Math.min(w, h) * 0.36}" fill="${fill}"/>`;
}

function arcUp(cy, w, fill) {
  return (cx) =>
    `<path d="M${cx - w / 2} ${cy + w * 0.28} q${w / 2} -${w * 0.7} ${w} 0" stroke="${fill}" stroke-width="4.6" fill="none" stroke-linecap="round"/>`;
}

function dash(cy, w, fill, weight) {
  return (cx) => `<path d="M${cx - w / 2} ${cy} h${w}" stroke="${fill}" stroke-width="${weight}" stroke-linecap="round"/>`;
}

function mouth(inner) {
  return inner;
}

const FACES = {
  // The resting face. Eyes live in .eye-track so scrappy.js can slide them
  // around to follow your cursor without re-rendering the face.
  focused: () =>
    `<g class="blinker"><g class="eye-track">${pair(slab(EYE_MID, EW, EH, INK.mint))}</g></g>`,

  // Half-lidded and looking away — what you get for the five seconds after
  // you've been waving your cursor in his face. The lid sits outside
  // .eye-track so it stays put while the eyes slide under it.
  annoyed: () =>
    `<g class="eye-track">${pair(slab(EYE_MID, EW, EH, INK.mint))}</g>` +
    `<rect x="${S.x}" y="${S.y}" width="${S.w}" height="${EYE_MID - S.y + EH * 0.12}" rx="9" fill="${INK.screen}"/>`,

  pleased: () => pair(arcUp(EYE_MID, EW * 1.25, INK.mint)),

  // Eyes drift to one side — the cheapest way to look like he's thinking.
  curious: () =>
    `<g class="blinker">` +
    pair(slab(EYE_MID, EW * 0.92, EH * 0.96, INK.panel)) +
    `<circle cx="${EYE_L + EW * 0.2}" cy="${EYE_MID}" r="${EW * 0.3}" fill="${INK.mint}"/>` +
    `<circle cx="${EYE_R + EW * 0.2}" cy="${EYE_MID}" r="${EW * 0.3}" fill="${INK.mint}"/>` +
    `</g>`,

  squint: () => pair(dash(EYE_MID, EW * 1.1, INK.mint, 5)),

  // Half-lidded: the full eye with a lid dropped over the top of it.
  nag: () =>
    pair(slab(EYE_MID, EW, EH, INK.mint)) +
    `<rect x="${S.x + 2}" y="${S.y + 2}" width="${S.w - 4}" height="${EYE_MID - S.y - EH * 0.06}" rx="8" fill="${INK.screen}"/>`,

  alert: () =>
    `<g class="eye-throb">` +
    pair(slab(EYE_MID, EW * 1.5, EH * 1.15, INK.amber)) +
    `</g>`,

  // Cute terror, robot flavour: blown-wide eyes with pupils shrunk to pinpricks,
  // the whole face juddering, and the display glitching a scanline because his
  // little processor is having a moment.
  alarmed: () =>
    `<rect class="glitch-bar" x="${S.x}" y="${S.y}" width="${S.w}" height="${S.h * 0.16}" fill="#BFF6E6" opacity="0.28"/>` +
    `<g class="terror">` +
    `<circle cx="${EYE_L}" cy="${EYE_UP}" r="${EH * 0.66}" fill="${INK.mint}"/>` +
    `<circle cx="${EYE_R}" cy="${EYE_UP}" r="${EH * 0.66}" fill="${INK.mint}"/>` +
    `<g class="pupils">` +
    `<circle cx="${EYE_L}" cy="${EYE_UP}" r="${EH * 0.19}" fill="${INK.screen}"/>` +
    `<circle cx="${EYE_R}" cy="${EYE_UP}" r="${EH * 0.19}" fill="${INK.screen}"/>` +
    `</g>` +
    `<ellipse class="terror-mouth" cx="${S.x + S.w / 2}" cy="${MOUTH_Y + 1}" rx="${S.w * 0.075}" ry="${S.h * 0.115}" fill="${INK.mint}"/>` +
    `</g>`,

  dizzy: () =>
    `<path d="M${EYE_L - EW * 0.6} ${EYE_UP - EH * 0.34} l${EW * 1.2} ${EH * 0.68} M${EYE_L + EW * 0.6} ${EYE_UP - EH * 0.34} l-${EW * 1.2} ${EH * 0.68}" stroke="${INK.mint}" stroke-width="3.6" stroke-linecap="round"/>` +
    `<path d="M${EYE_R - EW * 0.6} ${EYE_UP - EH * 0.34} l${EW * 1.2} ${EH * 0.68} M${EYE_R + EW * 0.6} ${EYE_UP - EH * 0.34} l-${EW * 1.2} ${EH * 0.68}" stroke="${INK.mint}" stroke-width="3.6" stroke-linecap="round"/>` +
    mouth(
      `<path d="M${S.x + S.w * 0.34} ${MOUTH_Y} q${S.w * 0.08} -4 ${S.w * 0.16} 0 q${S.w * 0.08} 4 ${S.w * 0.16} 0" stroke="${INK.mint}" stroke-width="3" fill="none" stroke-linecap="round"/>`
    ),

  talk: () =>
    `<g class="blinker">${pair(slab(EYE_UP, EW, EH * 0.86, INK.mint))}</g>` +
    mouth(
      `<rect class="mouth-talk" x="${S.x + S.w / 2 - S.w * 0.14}" y="${MOUTH_Y - 5}" width="${S.w * 0.28}" height="10" rx="3" fill="${INK.mint}"/>`
    ),

  sleep: () => pair(dash(EYE_MID, EW * 1.15, "#48587A", 4.6)),

  // Wide eyes sitting high on the screen — reads as looking up, and pairs
  // with the head tilt from .is-gazing.
  wonder: () =>
    `<g class="blinker">${pair(slab(S.y + S.h * 0.34, EW * 1.2, EH * 1.08, INK.mint))}</g>`,

  // Listening: his eyes light up. Bright cores with a halo behind them that
  // scrappy.js swells with your actual microphone level, so the glow IS the
  // recording indicator — no separate icon needed.
  listen: () => {
    const w = EW * 1.16;
    const h = EH * 1.12;
    const halo = (cx) =>
      `<rect class="vu-glow" x="${cx - w * 0.85}" y="${EYE_MID - h * 0.8}" width="${w * 1.7}" height="${h * 1.6}" rx="${Math.min(w, h) * 0.8}" fill="${INK.mint}" opacity="0.18"/>`;
    const core = (cx) =>
      `<rect class="vu-core" x="${cx - w / 2}" y="${EYE_MID - h / 2}" width="${w}" height="${h}" rx="${Math.min(w, h) * 0.36}" fill="#CFFFEF"/>`;
    return pair(halo) + pair(core);
  },

  // Speaking: eyes plus a mouth bar scaled by his actual output level.
  speak: () =>
    `<g class="blinker">${pair(slab(EYE_UP, EW, EH * 0.86, INK.mint))}</g>` +
    mouth(
      `<rect id="vu-mouth" x="${S.x + S.w / 2 - S.w * 0.16}" y="${MOUTH_Y - 6}" width="${S.w * 0.32}" height="12" rx="4" fill="${INK.mint}"/>`
    ),
};

function buildScrappy() {
  return `
<svg class="scrappy-svg" viewBox="0 0 ${GEO.width} ${GEO.height}" aria-hidden="true">
  <ellipse class="scrappy-shadow" cx="${C}" cy="${GROUND + 3}" rx="26" ry="4.5" fill="#000" opacity="0.18"/>
  <g class="j-body">
    <!-- Depth order, back to front: far arm, far leg, torso, near leg, near arm. -->
    ${arm("r", ARM_R_X, INK.shellFar, INK.shellFarLit, INK.bootFar, "#5E6C8C")}
    ${leg("r", LEG_R_X, INK.shellFar, INK.shellFarLit, INK.bootFar, "#5E6C8C")}

    <g class="j-torso" style="${origin(C, TORSO_TOP + P.torsoH / 2)}">
      <rect x="${TORSO_X}" y="${TORSO_TOP}" width="${P.torsoW}" height="${P.torsoH}" rx="13" fill="${INK.shellNear}"/>
      <rect x="${C - P.torsoW * 0.29 + YAW}" y="${TORSO_TOP + P.torsoH * 0.22}" width="${P.torsoW * 0.58}" height="${P.torsoH * 0.4}" rx="4" fill="${INK.panel}"/>
      <g class="chest-lights" style="${origin(C + YAW, TORSO_TOP + P.torsoH * 0.42)}">
        <circle class="led led-1" cx="${C - P.torsoW * 0.14 + YAW}" cy="${TORSO_TOP + P.torsoH * 0.42}" r="2.6" fill="${INK.ledRed}"/>
        <circle class="led led-2" cx="${C + YAW}" cy="${TORSO_TOP + P.torsoH * 0.42}" r="2.6" fill="${INK.ledYellow}"/>
        <circle class="led led-3" cx="${C + P.torsoW * 0.14 + YAW}" cy="${TORSO_TOP + P.torsoH * 0.42}" r="2.6" fill="${INK.ledGreen}"/>
      </g>
    </g>

    ${leg("l", LEG_L_X, INK.shellNear, INK.shellNearLit, INK.bootNear, INK.metal)}
    ${arm("l", ARM_L_X, INK.shellNear, INK.shellNearLit, INK.bootNear, INK.metal)}

    <!-- The neck is a sibling of the head, not a child. Inside the head group
         it rotated with it, so any real head turn swung the neck's lower end
         clean off the torso. Anchored here it stays plugged into the chest,
         and the head pivots at its own base 4px above the neck's top, which
         the head's own silhouette covers. -->
    ${flexNeck()}
    <g class="j-head" style="${origin(C, HEAD_BOTTOM)}">
      <rect x="${HEAD_X - 11}" y="${HEAD_TOP + P.headH * 0.32}" width="12" height="${P.headH * 0.38}" rx="5" fill="#48587A"/>
      <rect x="${HEAD_X + P.headW - 2}" y="${HEAD_TOP + P.headH * 0.32}" width="7" height="${P.headH * 0.38}" rx="3.5" fill="${INK.shellFar}"/>
      <rect x="${HEAD_X}" y="${HEAD_TOP}" width="${P.headW}" height="${P.headH}" rx="16" fill="${INK.shellNear}"/>
      <rect x="${S.x}" y="${S.y}" width="${S.w}" height="${S.h}" rx="10" fill="${INK.screen}"/>
      <clipPath id="scrappyScreenClip">
        <rect x="${S.x}" y="${S.y}" width="${S.w}" height="${S.h}" rx="10"/>
      </clipPath>
      <g id="scrappy-face" clip-path="url(#scrappyScreenClip)">${FACES.focused()}</g>
    </g>
  </g>
</svg>`;
}

window.ScrappyRig = { GEO, FACES, buildScrappy };
