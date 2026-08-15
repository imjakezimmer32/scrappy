// Scrappy — the wear layer. Rust, grime, and scratches.
//
// Three things make this work:
//
// 1. It is SEEDED. shatterAt() and puff() in scrappy.js use live Math.random(),
//    which is right for a one-shot effect and wrong for permanent damage — his
//    rust has to be in the same place every launch or he isn't the same robot.
//
// 2. All three intensity levels are emitted at once. Every element carries
//    data-w = the lowest level at which it appears, and the geometry is nested
//    (subtle is a subset of medium is a subset of heavy), so turning the level
//    up ACCUMULATES damage instead of reshuffling it. style.css hides the
//    higher tiers and scales opacity per level, so switching is one attribute
//    write on #scrappy — no rebuild, no lost animation state.
//
// 3. Everything is an ellipse or a line. No filters, no feTurbulence. That
//    keeps it cheap, and — the real reason — it means scripts/build-icon.js
//    can rasterize the head rust with an ellipse test instead of needing an
//    SVG engine. HEAD_RUST below is the shared contract between the two.
//
// Loaded as a plain script before rig.js in the app, and require()d by the
// icon builder; see the dual export at the bottom.

// The oxide palette lives here rather than in rig.js's INK because it has two
// consumers — the rig and the Node icon builder — and INK is already duplicated
// once in build-icon.js. One copy, imported by both.
const TONE = {
  rustDark: "#6E3A22",
  rustMid: "#A0562C",
  rustLit: "#C9743A",
  grime: "#2A2418",
  scratch: "#8C9BB8", // bare metal under the paint — same as INK.metal
};

const LEVELS = ["subtle", "medium", "heavy"];

// How worn he is out of the box. Override live in devtools with
//   document.getElementById('scrappy').dataset.wear = 'heavy'
const LEVEL = "heavy";

// Master opacity per level, applied to the .wear groups. Multiplies each
// element's own alpha, so it scales the whole pass without touching geometry.
const LEVEL_ALPHA = { subtle: 0.55, medium: 0.8, heavy: 1 };

// --- seeded noise ---------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n2 = (v) => Number(v.toFixed(3));

// --- rust -----------------------------------------------------------------

// A corrosion stain fitted to a box: a few overlapping lobes for the body of
// it, then a scatter of flecks around the edge so it doesn't read as a blob.
// Returns plain data — toSvg() serializes it, and the icon rasterizer consumes
// the same array directly.
function cluster(box, opts) {
  const o = opts || {};
  const rand = mulberry32(o.seed == null ? 1 : o.seed);
  const tier = o.tier || 1;
  const up = Math.min(3, tier + 1);
  const lobes = o.lobes == null ? 4 : o.lobes;
  const flecks = o.flecks == null ? 5 : o.flecks;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const out = [];

  for (let i = 0; i < lobes; i += 1) {
    const t = lobes > 1 ? i / (lobes - 1) : 0;
    // Lobes are roughly EQUAL in size and spread wide enough to overlap
    // side-by-side. Shrinking them concentrically instead gives a bullseye,
    // which reads as a hole punched in him rather than as a stain.
    const scale = (0.46 - 0.07 * t) * (0.85 + 0.3 * rand());
    out.push({
      cx: n2(cx + (rand() - 0.5) * box.w * 0.5),
      cy: n2(cy + (rand() - 0.5) * box.h * 0.5),
      rx: n2((box.w / 2) * scale),
      ry: n2((box.h / 2) * scale),
      // Mostly mid and light oxide. rustDark against the blue-grey shell is a
      // near-black hole at any real opacity, so it's kept for small pits.
      fill: i === 0 ? TONE.rustMid : i === 1 ? TONE.rustLit : i % 2 ? TONE.rustDark : TONE.rustMid,
      alpha: n2(0.52 - 0.08 * t + 0.12 * rand()),
      // The first two lobes are the stain you always see; the rest only show
      // up as the level climbs, which is what makes it grow rather than move.
      tier: i < 2 ? tier : up,
    });
  }

  for (let i = 0; i < flecks; i += 1) {
    const r = 0.09 + 0.09 * rand();
    out.push({
      cx: n2(cx + (rand() - 0.5) * box.w * 1.24),
      cy: n2(cy + (rand() - 0.5) * box.h * 1.24),
      rx: n2((box.w / 2) * r),
      ry: n2((box.h / 2) * r),
      fill: i % 2 ? TONE.rustLit : TONE.rustMid,
      alpha: n2(0.36 + 0.28 * rand()),
      tier: up,
    });
  }

  return out;
}

function toSvg(blobs) {
  return blobs
    .map(
      (b) =>
        `<ellipse cx="${b.cx}" cy="${b.cy}" rx="${b.rx}" ry="${b.ry}"` +
        ` fill="${b.fill}" opacity="${b.alpha}" data-w="${b.tier}"/>`
    )
    .join("");
}

function rust(box, opts) {
  return toSvg(cluster(box, opts));
}

// --- scratches ------------------------------------------------------------

// Paint worn through to bare metal. Hairlines, bowed slightly, running mostly
// along the limb's long axis — that's the direction things scrape past him.
function scratches(box, opts) {
  const o = opts || {};
  const rand = mulberry32(o.seed == null ? 1 : o.seed);
  const tier = o.tier || 1;
  const count = o.count == null ? 3 : o.count;
  const axis = o.axis || "y";
  const span = axis === "x" ? box.w : box.h;
  let out = "";

  for (let i = 0; i < count; i += 1) {
    const len = span * (0.18 + 0.26 * rand());
    const jitter = (rand() - 0.5) * 0.5;
    const dx = axis === "x" ? len : len * jitter;
    const dy = axis === "x" ? len * jitter : len;
    // Bow perpendicular to the run so it curves like a real gouge.
    const bow = (rand() - 0.5) * len * 0.3;
    const qx = dx * 0.5 + (axis === "x" ? 0 : bow);
    const qy = dy * 0.5 + (axis === "x" ? bow : 0);
    const x0 = box.x + box.w * (0.2 + 0.6 * rand()) - dx / 2;
    const y0 = box.y + box.h * (0.15 + 0.7 * rand()) - dy / 2;

    out +=
      `<path d="M${n2(x0)} ${n2(y0)} q${n2(qx)} ${n2(qy)} ${n2(dx)} ${n2(dy)}"` +
      ` stroke="${TONE.scratch}" stroke-width="${n2(0.5 + 0.35 * rand())}"` +
      ` fill="none" stroke-linecap="round" opacity="${n2(0.22 + 0.22 * rand())}"` +
      // Half show at the requested tier, half only once he's more worn.
      ` data-w="${i < Math.ceil(count / 2) ? tier : Math.min(3, tier + 1)}"/>`;
  }

  return out;
}

// --- grime ----------------------------------------------------------------

// Dirt is a copy of the part's own shape in warm brown at low alpha, so it
// sits exactly inside the silhouette without needing its own clip. Amount is
// meant to climb the further down the body you go.
function grime(rect, opts) {
  const o = opts || {};
  return (
    `<rect x="${n2(rect.x)}" y="${n2(rect.y)}" width="${n2(rect.w)}" height="${n2(rect.h)}"` +
    (rect.rx == null ? "" : ` rx="${n2(rect.rx)}"`) +
    ` fill="${TONE.grime}" opacity="${n2(o.amount == null ? 0.1 : o.amount)}"` +
    ` data-w="${o.tier || 1}"/>`
  );
}

// --- head rust (shared with the icon builder) -----------------------------

// Authored in head-local unit coordinates — u across the head's width, v down
// its height — because the tray icon's head is squared up to fit a square
// canvas and is a different aspect ratio to the rig's 82x56. Both consumers
// map these onto their own shell rect rather than copying pixel positions.
//
// All three stains sit in the bezel. They're painted UNDER the screen rect in
// both renderers, so anything that laps onto the display is covered — rust on
// his face would read as a rendering bug, not as age.
//
// Every box deliberately overhangs the shell edge so the silhouette clips it.
// Corrosion starts at a rim and eats inward; a stain floating in the middle of
// the bezel with clean air all round it just reads as a smudge of dirt.
const HEAD_RUST = [].concat(
  // Bottom-left corner: the one stain he always has, and the only one small
  // enough to survive being drawn at 16px in the notification area.
  cluster({ x: -0.03, y: 0.79, w: 0.2, h: 0.24 }, { seed: 41, tier: 1, lobes: 3, flecks: 4 }),
  // Creeping out of that corner along the bottom edge — wide and shallow,
  // following the chin. Overlapping the tier-1 stain is the point: at medium
  // he looks like the same patch has spread, not like a new spot appeared.
  cluster({ x: 0.13, y: 0.9, w: 0.36, h: 0.14 }, { seed: 42, tier: 2, lobes: 3, flecks: 4 }),
  // Top-left corner, the last to go.
  cluster({ x: -0.04, y: -0.03, w: 0.22, h: 0.25 }, { seed: 43, tier: 3, lobes: 4, flecks: 5 }),
  // Along the top edge, right of the crown — keeps the damage from being all
  // on one side of his head once he's this far gone.
  cluster({ x: 0.56, y: -0.05, w: 0.32, h: 0.14 }, { seed: 44, tier: 3, lobes: 3, flecks: 5 }),
  // And the bottom-right corner, so the bezel is eaten all the way round.
  cluster({ x: 0.82, y: 0.86, w: 0.22, h: 0.2 }, { seed: 45, tier: 3, lobes: 3, flecks: 4 })
);

// Maps the unit-space blobs onto a real rect. The rig passes its head rect;
// build-icon.js passes its shell rect.
function placeHeadRust(rect) {
  return HEAD_RUST.map((b) => ({
    cx: n2(rect.x + b.cx * rect.w),
    cy: n2(rect.y + b.cy * rect.h),
    rx: n2(b.rx * rect.w),
    ry: n2(b.ry * rect.h),
    fill: b.fill,
    alpha: b.alpha,
    tier: b.tier,
  }));
}

const API = {
  TONE,
  LEVELS,
  LEVEL,
  LEVEL_ALPHA,
  cluster,
  toSvg,
  rust,
  scratches,
  grime,
  HEAD_RUST,
  placeHeadRust,
};

if (typeof module !== "undefined" && module.exports) module.exports = API;
else window.ScrappyWear = API;
