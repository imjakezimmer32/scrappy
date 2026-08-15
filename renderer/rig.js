// Scrappy — the rig. Bobblehead proportions, gear-toothed joints, one SVG.
// Every joint is a nested <g> with its transform-origin baked in, so CSS
// keyframes on .j-* classes drive the whole character.
//
// Wear (rust, grime, scratches) comes from wear.js, which must load first.
// It goes INSIDE the joint groups so it rides the same keyframes as the part
// it's on — rust on a shin walks with the shin for free.

const WEAR = window.ScrappyWear;

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

// Warm-leaning, slightly desaturated, a touch darker than the original cool
// blue-grey. Pulling the shell hue a few steps toward the oxide family lets
// the rust sit ON him rather than on top of him, and dropping the saturation
// gives the mint eyes and the chest LEDs more room to carry the colour.
// Accents (mint, amber, LEDs) are deliberately untouched.
const INK = {
  shellNear: "#5C6781",
  shellNearLit: "#68738F",
  shellFar: "#384259",
  shellFarLit: "#414C65",
  bootNear: "#414A62",
  bootFar: "#282E39",
  metal: "#8B97AD",
  metalDark: "#3A4257",
  screen: "#1C212D",
  mint: "#6FE3C0",
  amber: "#E8734A",
  panel: "#2B3348",
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
      `<rect x="${C - 5}" y="${yTop.toFixed(2)}" width="10" height="${(pitch + 0.6).toFixed(2)}" fill="#3F4961"/>` +
      `<rect x="${C - w / 2}" y="${yTop.toFixed(2)}" width="${w}" height="${(pitch * 0.74).toFixed(2)}" rx="1.8" fill="${wide ? "#6A7691" : "#4F5A75"}"/>` +
      node +
      `</g>`;
  }

  // Water sits in the corrugation valleys, so the collars are the first thing
  // on the neck to go — but it's a busy little area, so only at heavy.
  const collar = { x: C - 7, y: bottom - 4, w: 14, h: 4, rx: 1.8 };
  return (
    `<g class="j-neck" style="${origin(C, bottom)}">` +
    `<rect x="${collar.x}" y="${collar.y}" width="${collar.w}" height="${collar.h}" rx="${collar.rx}" fill="${INK.metalDark}"/>` +
    worn(
      "w-neck",
      `<rect x="${collar.x}" y="${collar.y}" width="${collar.w}" height="${collar.h}" rx="${collar.rx}"/>`,
      WEAR.rust({ x: C - 6, y: bottom - 4, w: 9, h: 4 }, { seed: 91, tier: 3, lobes: 3, flecks: 4 }),
      false
    ) +
    node +
    `</g>`
  );
}

function origin(x, y) {
  return `transform-box:view-box;transform-origin:${x}px ${y}px`;
}

// Wraps a part's wear in a group clipped to that part's own silhouette, so
// heavy corrosion can't bleed past the shell edge — which would show up as a
// change in the drop-shadow outline, since those trace the SVG's alpha.
// Only one rig is ever mounted, so fixed ids are safe (same bet as
// scrappyScreenClip). Far-side parts get .is-far, which CSS knocks back:
// depth here is carried entirely by shading, and full-strength rust on the
// far limbs flattens him.
function worn(id, clipShape, content, far) {
  if (!content) return "";
  return (
    `<clipPath id="${id}">${clipShape}</clipPath>` +
    `<g class="wear${far ? " is-far" : ""}" clip-path="url(#${id})">${content}</g>`
  );
}

// --- how he was put together ---------------------------------------------
//
// Rivets, weld seams and a field-repair plate. These are NOT wear: they don't
// fade with the level and they sit outside the .wear groups, because he is
// always a bolted-together, patched-up machine — the rust is just how long
// he's been one. They're what stops him reading as a moulded toy.
//
// All of it stays on the body. The head keeps rust only, because the head is
// what scripts/build-icon.js mirrors into the tray icon, and rivets at 16px
// are mud.

// Clearly lighter than the shell — salvage, not factory stock. A plate only a
// shade off the shell just reads as a smudge at his actual size; the value
// gap is what makes it register as a different piece of metal.
const PLATE = "#8A8E9B";

function built(id, clipShape, content) {
  return (
    `<clipPath id="${id}">${clipShape}</clipPath>` +
    `<g class="build" clip-path="url(#${id})">${content}</g>`
  );
}

// Domed head: a dark seat with a brighter cap offset up-left, so it catches
// the same light the rest of him does.
function rivet(x, y, r) {
  const rr = r == null ? 0.95 : r;
  return (
    `<circle cx="${n(x)}" cy="${n(y)}" r="${n(rr)}" fill="${INK.metalDark}" opacity="0.85"/>` +
    `<circle cx="${n(x - rr * 0.16)}" cy="${n(y - rr * 0.18)}" r="${n(rr * 0.6)}" fill="${INK.metal}" opacity="0.8"/>`
  );
}

function rivetRow(x, y, dx, dy, count, r) {
  let out = "";
  for (let i = 0; i < count; i += 1) out += rivet(x + dx * i, y + dy * i, r);
  return out;
}

// A welded joint line: a dark groove with a thin bright bead alongside it.
function seam(d, weight) {
  const w = weight == null ? 0.7 : weight;
  return (
    `<path d="${d}" stroke="${INK.metalDark}" stroke-width="${n(w)}" fill="none" opacity="0.55" stroke-linecap="round"/>` +
    `<path d="${d}" stroke="${INK.metal}" stroke-width="${n(w * 0.42)}" fill="none" opacity="0.3" stroke-linecap="round" transform="translate(0,-0.55)"/>`
  );
}

// The signature repair: a plate off something else entirely, bolted straight
// over the damage. One of these says more about him than any amount of rust.
function patchPlate(b) {
  const i = 1.9;
  return (
    `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.rx == null ? 1.4 : b.rx)}" fill="${PLATE}"/>` +
    `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.rx == null ? 1.4 : b.rx)}" fill="none" stroke="${INK.metalDark}" stroke-width="0.5" opacity="0.5"/>` +
    rivet(b.x + i, b.y + i, 0.8) +
    rivet(b.x + b.w - i, b.y + i, 0.8) +
    rivet(b.x + i, b.y + b.h - i, 0.8) +
    rivet(b.x + b.w - i, b.y + b.h - i, 0.8)
  );
}

const n = (v) => Number(v.toFixed(2));

// A rust bloom on a joint gear. Confined well inside the tooth root radius
// (0.78r) so a circle is an exact enough clip for a cog silhouette. Small
// round parts need FEWER, smaller lobes and more flecks than a flat panel
// does — a couple of fat lobes inside a circle read as bubbles, not rust.
function gearRust(cx, cy, r, opts) {
  const reach = r * 0.64;
  return WEAR.rust({ x: cx - reach, y: cy - reach, w: reach * 2, h: reach * 2 }, opts);
}

function footPath(x) {
  const w = P.limbW;
  const top = GROUND - P.bootH;
  return (
    `M${x - w * 0.7} ${top} H${x + w * 0.5} L${x + w * 1.5} ${GROUND - 3}` +
    ` Q${x + w * 1.5} ${GROUND} ${x + w * 1.1} ${GROUND} H${x - w * 0.5}` +
    ` Q${x - w * 0.9} ${GROUND} ${x - w * 0.7} ${top} Z`
  );
}

// The boots take the worst of it: they're the part that's actually on the
// ground. Grimiest, and rusted along both the top edge and the sole lip.
function foot(x, fill, side, seed, far) {
  const w = P.limbW;
  const top = GROUND - P.bootH;
  const d = footPath(x);
  return (
    `<path d="${d}" fill="${fill}"/>` +
    built(
      `b-boot-${side}`,
      `<path d="${d}"/>`,
      // A toe cap bolted on over the front of the boot — the part that takes
      // every stubbed step.
      seam(`M${n(x + w * 0.42)} ${n(top - 0.5)} L${n(x + w * 0.62)} ${n(GROUND)}`, 0.8) +
        rivet(x + w * 0.9, GROUND - 2.6, 0.75) +
        rivet(x - w * 0.25, GROUND - 2.4, 0.75)
    ) +
    worn(
      `w-boot-${side}`,
      `<path d="${d}"/>`,
      WEAR.grime({ x: x - w * 0.9, y: top, w: w * 2.4, h: P.bootH }, { amount: 0.2, tier: 1 }) +
        WEAR.rust({ x: x - w * 0.6, y: top - 1, w: w * 1.3, h: P.bootH * 0.62 }, { seed, tier: 1, lobes: 3, flecks: 5 }) +
        WEAR.rust({ x: x + w * 0.15, y: GROUND - 3.6, w: w * 1.2, h: 3.6 }, { seed: seed + 1, tier: 2, lobes: 2, flecks: 4 }) +
        WEAR.rust({ x: x + w * 0.55, y: top - 0.5, w: w * 1.1, h: P.bootH * 0.8 }, { seed: seed + 2, tier: 3, lobes: 3, flecks: 5 }),
      far
    )
  );
}

function leg(side, x, shell, shellLit, bootFill, gearFill, far) {
  const w = P.limbW;
  // Distinct seeds per side, or both legs corrode identically and he reads as
  // a mirrored decal rather than a robot.
  const sd = side === "l" ? 10 : 60;
  const thigh = { x: x - w / 2, y: HIP_Y, w, h: THIGH + 2, rx: w / 2 };
  const shin = { x: x - w / 2, y: KNEE_Y, w, h: SHIN + 2, rx: w / 2 };
  const rect = (b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.rx}"/>`;
  return `
    <g class="j-hip j-hip-${side}" style="${origin(x, HIP_Y)}">
      <rect x="${thigh.x}" y="${thigh.y}" width="${thigh.w}" height="${thigh.h}" rx="${thigh.rx}" fill="${shell}"/>
      ${built(
        `b-thigh-${side}`,
        rect(thigh),
        rivetRow(x - 2.6, HIP_Y + 3.2, 2.6, 0, 3, 0.75) +
          seam(`M${x - w / 2 + 0.8} ${(HIP_Y + THIGH - 1.4).toFixed(2)} h${(w - 1.6).toFixed(2)}`)
      )}
      ${worn(
        `w-thigh-${side}`,
        rect(thigh),
        WEAR.grime(thigh, { amount: 0.11, tier: 2 }) +
          WEAR.scratches(thigh, { seed: sd + 2, tier: 2, count: 3 }) +
          WEAR.rust({ x: thigh.x, y: thigh.y + thigh.h * 0.45, w: thigh.w, h: thigh.h * 0.5 }, { seed: sd + 7, tier: 3, lobes: 3, flecks: 5 }),
        far
      )}
      <g class="j-knee j-knee-${side}" style="${origin(x, KNEE_Y)}">
        <rect x="${shin.x}" y="${shin.y}" width="${shin.w}" height="${shin.h}" rx="${shin.rx}" fill="${shellLit}"/>
        ${built(
          `b-shin-${side}`,
          rect(shin),
          // Only the near shin gets the plate. Both would read as a design
          // feature; one reads as something that happened to him.
          (side === "l" ? patchPlate({ x: x - 4.4, y: KNEE_Y + 3.6, w: 8.8, h: 8.4 }) : "") +
            seam(`M${x - w / 2 + 0.8} ${(KNEE_Y + 2.2).toFixed(2)} h${(w - 1.6).toFixed(2)}`)
        )}
        ${worn(
          `w-shin-${side}`,
          rect(shin),
          WEAR.grime(shin, { amount: 0.16, tier: 1 }) +
            WEAR.scratches(shin, { seed: sd + 3, tier: 1, count: 4 }) +
            WEAR.rust({ x: shin.x, y: shin.y + shin.h * 0.35, w: shin.w, h: shin.h * 0.65 }, { seed: sd + 8, tier: 2, lobes: 3, flecks: 5 }),
          far
        )}
        ${foot(x, bootFill, side, sd + 4, far)}
        ${gear(x, KNEE_Y, w * 0.62, 8, gearFill, INK.metalDark)}
        ${worn(
          `w-knee-${side}`,
          `<circle cx="${x}" cy="${KNEE_Y}" r="${(w * 0.62 * 0.76).toFixed(2)}"/>`,
          gearRust(x, KNEE_Y, w * 0.62, { seed: sd + 5, tier: 1, lobes: 2, flecks: 7 }),
          far
        )}
      </g>
      ${gear(x, HIP_Y, w * 0.49, 9, gearFill, INK.metalDark)}
      ${worn(
        `w-hip-${side}`,
        `<circle cx="${x}" cy="${HIP_Y}" r="${(w * 0.49 * 0.76).toFixed(2)}"/>`,
        gearRust(x, HIP_Y, w * 0.49, { seed: sd + 6, tier: 2, lobes: 2, flecks: 6 }),
        far
      )}
    </g>`;
}

function arm(side, x, shell, shellLit, handFill, gearFill, far) {
  const w = P.armW;
  const sd = side === "l" ? 30 : 80;
  const upper = { x: x - w / 2, y: SHOULDER_Y, w, h: UPPER_ARM + 2, rx: w / 2 };
  const fore = { x: x - w / 2, y: ELBOW_Y, w, h: FOREARM + 2, rx: w / 2 };
  const hr = w * 0.72;
  const rect = (b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.rx}"/>`;
  return `
    <g class="j-shoulder j-shoulder-${side}" style="${origin(x, SHOULDER_Y)}">
      <rect x="${upper.x}" y="${upper.y}" width="${upper.w}" height="${upper.h}" rx="${upper.rx}" fill="${shell}"/>
      ${built(
        `b-upperarm-${side}`,
        rect(upper),
        rivetRow(x - 1.9, SHOULDER_Y + 2.8, 1.9, 0, 3, 0.68) +
          seam(`M${x - w / 2 + 0.7} ${(SHOULDER_Y + UPPER_ARM - 1.2).toFixed(2)} h${(w - 1.4).toFixed(2)}`, 0.6)
      )}
      ${worn(
        `w-upperarm-${side}`,
        rect(upper),
        WEAR.grime(upper, { amount: 0.1, tier: 2 }) +
          WEAR.scratches(upper, { seed: sd + 2, tier: 2, count: 3 }) +
          WEAR.rust({ x: upper.x, y: upper.y + upper.h * 0.4, w: upper.w, h: upper.h * 0.55 }, { seed: sd + 7, tier: 3, lobes: 3, flecks: 4 }),
        far
      )}
      <g class="j-elbow j-elbow-${side}" style="${origin(x, ELBOW_Y)}">
        <rect x="${fore.x}" y="${fore.y}" width="${fore.w}" height="${fore.h}" rx="${fore.rx}" fill="${shellLit}"/>
        ${built(
          `b-forearm-${side}`,
          rect(fore),
          seam(`M${x - w / 2 + 0.7} ${(ELBOW_Y + 2).toFixed(2)} h${(w - 1.4).toFixed(2)}`, 0.6) +
            rivet(x, ELBOW_Y + FOREARM - 1.6, 0.7)
        )}
        ${worn(
          `w-forearm-${side}`,
          rect(fore),
          WEAR.grime(fore, { amount: 0.13, tier: 1 }) +
            WEAR.scratches(fore, { seed: sd + 3, tier: 1, count: 3 }) +
            WEAR.rust({ x: fore.x, y: fore.y + fore.h * 0.3, w: fore.w, h: fore.h * 0.7 }, { seed: sd + 8, tier: 2, lobes: 3, flecks: 4 }),
          far
        )}
        <circle cx="${x}" cy="${HAND_Y}" r="${hr}" fill="${handFill}"/>
        ${worn(
          `w-hand-${side}`,
          `<circle cx="${x}" cy="${HAND_Y}" r="${hr}"/>`,
          WEAR.rust({ x: x - hr * 0.72, y: HAND_Y - hr * 0.72, w: hr * 1.44, h: hr * 1.44 }, { seed: sd + 4, tier: 2, lobes: 2, flecks: 7 }),
          far
        )}
        ${gear(x, ELBOW_Y, w * 0.62, 7, gearFill, INK.metalDark)}
        ${worn(
          `w-elbow-${side}`,
          `<circle cx="${x}" cy="${ELBOW_Y}" r="${(w * 0.62 * 0.76).toFixed(2)}"/>`,
          gearRust(x, ELBOW_Y, w * 0.62, { seed: sd + 5, tier: 1, lobes: 2, flecks: 6 }),
          far
        )}
      </g>
      ${gear(x, SHOULDER_Y, w * 0.55, 8, gearFill, INK.metalDark)}
      ${worn(
        `w-shoulder-${side}`,
        `<circle cx="${x}" cy="${SHOULDER_Y}" r="${(w * 0.55 * 0.76).toFixed(2)}"/>`,
        gearRust(x, SHOULDER_Y, w * 0.55, { seed: sd + 6, tier: 2, lobes: 2, flecks: 6 }),
        far
      )}
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

  sleep: () => pair(dash(EYE_MID, EW * 1.15, "#48536D", 4.6)),

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
  const torso = { x: TORSO_X, y: TORSO_TOP, w: P.torsoW, h: P.torsoH, rx: 13 };
  const head = { x: HEAD_X, y: HEAD_TOP, w: P.headW, h: P.headH, rx: 16 };
  // Authored in unit space and shared with scripts/build-icon.js, so the tray
  // icon rusts in the same places his real head does.
  const headRust = WEAR.toSvg(WEAR.placeHeadRust(head));
  return `
<svg class="scrappy-svg" viewBox="0 0 ${GEO.width} ${GEO.height}" aria-hidden="true">
  <ellipse class="scrappy-shadow" cx="${C}" cy="${GROUND + 3}" rx="26" ry="4.5" fill="#000" opacity="0.18"/>
  <g class="j-body">
    <!-- Depth order, back to front: far arm, far leg, torso, near leg, neck,
         head, near arm. The near arm is drawn LAST — in front of his own face —
         because it is the arm on the side nearest the viewer, and an arm that
         raises to wave, point or shield should pass across the face rather than
         disappear behind the head. Put it before the head and every raised-arm
         pose loses its hand exactly when the hand is the point of the pose. -->
    ${arm("r", ARM_R_X, INK.shellFar, INK.shellFarLit, INK.bootFar, "#5D6881", true)}
    ${leg("r", LEG_R_X, INK.shellFar, INK.shellFarLit, INK.bootFar, "#5D6881", true)}

    <g class="j-torso" style="${origin(C, TORSO_TOP + P.torsoH / 2)}">
      <rect x="${torso.x}" y="${torso.y}" width="${torso.w}" height="${torso.h}" rx="${torso.rx}" fill="${INK.shellNear}"/>
      <!-- His chest is two pressed halves welded together with an access
           panel bolted between them. -->
      ${built(
        "b-torso",
        `<rect x="${torso.x}" y="${torso.y}" width="${torso.w}" height="${torso.h}" rx="${torso.rx}"/>`,
        seam(`M${n(TORSO_X + 3)} ${n(TORSO_TOP + P.torsoH * 0.16)} h${n(P.torsoW - 6)}`) +
          seam(`M${n(TORSO_X + 3)} ${n(TORSO_BOTTOM - P.torsoH * 0.2)} h${n(P.torsoW - 6)}`) +
          rivetRow(TORSO_X + 3.4, TORSO_TOP + P.torsoH * 0.16 - 2.6, 0, 0, 1) +
          rivetRow(TORSO_X + P.torsoW - 3.4, TORSO_TOP + P.torsoH * 0.16 - 2.6, 0, 0, 1) +
          rivetRow(TORSO_X + 3.4, TORSO_BOTTOM - 3.4, 0, 0, 1) +
          rivetRow(TORSO_X + P.torsoW - 3.4, TORSO_BOTTOM - 3.4, 0, 0, 1)
      )}
      <!-- Rust creeps UP from the bottom lip: that's the edge that sits closest
           to whatever he's standing in, and it puts the damage below the chest
           panel rather than competing with the LEDs. -->
      ${worn(
        "w-torso",
        `<rect x="${torso.x}" y="${torso.y}" width="${torso.w}" height="${torso.h}" rx="${torso.rx}"/>`,
        WEAR.grime({ x: torso.x, y: TORSO_TOP + P.torsoH * 0.5, w: torso.w, h: P.torsoH * 0.5, rx: 6 }, { amount: 0.1, tier: 2 }) +
          WEAR.rust({ x: TORSO_X + 2, y: TORSO_BOTTOM - 11, w: 19, h: 11 }, { seed: 71, tier: 2, lobes: 3, flecks: 5 }) +
          WEAR.rust({ x: TORSO_X + P.torsoW - 19, y: TORSO_BOTTOM - 9, w: 17, h: 9 }, { seed: 72, tier: 2, lobes: 3, flecks: 4 }) +
          WEAR.rust({ x: TORSO_X - 2, y: TORSO_TOP - 1, w: 14, h: 12 }, { seed: 74, tier: 3, lobes: 3, flecks: 5 }) +
          WEAR.scratches(torso, { seed: 73, tier: 2, count: 3, axis: "x" }),
        false
      )}
      <rect x="${C - P.torsoW * 0.29 + YAW}" y="${TORSO_TOP + P.torsoH * 0.22}" width="${P.torsoW * 0.58}" height="${P.torsoH * 0.4}" rx="4" fill="${INK.panel}"/>
      <g class="build">
        ${rivet(C - P.torsoW * 0.29 + YAW + 1.9, TORSO_TOP + P.torsoH * 0.22 + 1.9, 0.62)}
        ${rivet(C + P.torsoW * 0.29 + YAW - 1.9, TORSO_TOP + P.torsoH * 0.22 + 1.9, 0.62)}
        ${rivet(C - P.torsoW * 0.29 + YAW + 1.9, TORSO_TOP + P.torsoH * 0.62 - 1.9, 0.62)}
        ${rivet(C + P.torsoW * 0.29 + YAW - 1.9, TORSO_TOP + P.torsoH * 0.62 - 1.9, 0.62)}
      </g>
      <g class="chest-lights" style="${origin(C + YAW, TORSO_TOP + P.torsoH * 0.42)}">
        <circle class="led led-1" cx="${C - P.torsoW * 0.14 + YAW}" cy="${TORSO_TOP + P.torsoH * 0.42}" r="2.6" fill="${INK.ledRed}"/>
        <circle class="led led-2" cx="${C + YAW}" cy="${TORSO_TOP + P.torsoH * 0.42}" r="2.6" fill="${INK.ledYellow}"/>
        <circle class="led led-3" cx="${C + P.torsoW * 0.14 + YAW}" cy="${TORSO_TOP + P.torsoH * 0.42}" r="2.6" fill="${INK.ledGreen}"/>
      </g>
    </g>

    ${leg("l", LEG_L_X, INK.shellNear, INK.shellNearLit, INK.bootNear, INK.metal)}

    <!-- The neck is a sibling of the head, not a child. Inside the head group
         it rotated with it, so any real head turn swung the neck's lower end
         clean off the torso. Anchored here it stays plugged into the chest,
         and the head pivots at its own base 4px above the neck's top, which
         the head's own silhouette covers. -->
    ${flexNeck()}
    <g class="j-head" style="${origin(C, HEAD_BOTTOM)}">
      <rect x="${HEAD_X - 11}" y="${HEAD_TOP + P.headH * 0.32}" width="12" height="${P.headH * 0.38}" rx="5" fill="#48536D"/>
      ${worn(
        "w-ear",
        `<rect x="${HEAD_X - 11}" y="${HEAD_TOP + P.headH * 0.32}" width="12" height="${P.headH * 0.38}" rx="5"/>`,
        WEAR.rust(
          { x: HEAD_X - 11, y: HEAD_TOP + P.headH * 0.4, w: 12, h: P.headH * 0.3 },
          { seed: 81, tier: 3, lobes: 3, flecks: 4 }
        ),
        false
      )}
      <rect x="${HEAD_X + P.headW - 2}" y="${HEAD_TOP + P.headH * 0.32}" width="7" height="${P.headH * 0.38}" rx="3.5" fill="${INK.shellFar}"/>
      <rect x="${head.x}" y="${head.y}" width="${head.w}" height="${head.h}" rx="${head.rx}" fill="${INK.shellNear}"/>
      <!-- Head rust goes here, UNDER the screen rect below it: anything that
           laps onto the display gets covered rather than clipped by hand.
           Rust on his face would read as a rendering bug, not as age. -->
      ${worn(
        "w-head",
        `<rect x="${head.x}" y="${head.y}" width="${head.w}" height="${head.h}" rx="${head.rx}"/>`,
        headRust,
        false
      )}
      <rect x="${S.x}" y="${S.y}" width="${S.w}" height="${S.h}" rx="10" fill="${INK.screen}"/>
      <clipPath id="scrappyScreenClip">
        <rect x="${S.x}" y="${S.y}" width="${S.w}" height="${S.h}" rx="10"/>
      </clipPath>
      <g id="scrappy-face" clip-path="url(#scrappyScreenClip)">${FACES.focused()}</g>
    </g>

    <!-- Nearest the viewer, so it crosses in front of the face when raised. -->
    ${arm("l", ARM_L_X, INK.shellNear, INK.shellNearLit, INK.bootNear, INK.metal)}
  </g>
</svg>`;
}

window.ScrappyRig = { GEO, FACES, buildScrappy };
