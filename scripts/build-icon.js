// Builds Scrappy's face into tray/favicon assets.
//
// His face in the app is an SVG rig (renderer/rig.js): a rounded head shell,
// a dark screen inset into it, and two mint slab eyes. This redraws that mark
// on a square canvas and writes PNGs plus a multi-size .ico.
//
// Everything here is hand-rolled on purpose — zlib is the only dependency, so
// the icon can be regenerated on any machine with `npm run build-icon` and no
// native image toolchain.
//
// Usage: node scripts/build-icon.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "..", "assets");
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];
// Windows shows 16px in the notification area and 32px in the overflow
// flyout; the rest are for the favicon and any future packaging.
const ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256];

// Palette lifted from INK in renderer/rig.js. Keep in sync if his shell or
// eye colour changes.
const INK = {
  shell: [0x5b, 0x6b, 0x8c],
  shellLit: [0x67, 0x77, 0x9b],
  screen: [0x1d, 0x24, 0x33],
  mint: [0x6f, 0xe3, 0xc0],
};

// Geometry as fractions of the canvas. The rig's real head is 82x56 with the
// screen inset 11% horizontally and 15% vertically; a square icon can't keep
// that aspect, so the mark is squared up and the eyes keep their real 0.63
// width:height ratio instead.
function geometry(size) {
  // Small sizes need a thinner bezel and chunkier eyes or the face turns to
  // mush — 2px of mint reads as grey once the shell crowds it.
  const small = size <= 24;

  const margin = small ? 0.015 : 0.03;
  const shell = { x: margin, y: margin, w: 1 - margin * 2, h: 1 - margin * 2 };
  shell.r = shell.w * 0.2;

  const inset = small ? 0.1 : 0.13;
  const screen = {
    x: shell.x + shell.w * inset,
    y: shell.y + shell.h * inset,
    w: shell.w * (1 - inset * 2),
    h: shell.h * (1 - inset * 2),
  };
  screen.r = screen.w * 0.156;

  const eyeW = screen.w * (small ? 0.23 : 0.2);
  const eyeH = eyeW / 0.627;
  const cy = screen.y + screen.h * 0.5;
  const eyes = [screen.x + screen.w * 0.32, screen.x + screen.w * 0.68].map((cx) => ({
    x: cx - eyeW / 2,
    y: cy - eyeH / 2,
    w: eyeW,
    h: eyeH,
    r: Math.min(eyeW, eyeH) * 0.36,
  }));

  return { shell, screen, eyes };
}

// --- rasterizer -----------------------------------------------------------

function inRoundRect(px, py, b) {
  if (px < b.x || px > b.x + b.w || py < b.y || py > b.y + b.h) return false;
  const r = Math.min(b.r, b.w / 2, b.h / 2);
  // Nearest point on the rect's inner core; if we're beyond it in both axes
  // we're in a corner and need the circle test.
  const nx = Math.min(Math.max(px, b.x + r), b.x + b.w - r);
  const ny = Math.min(Math.max(py, b.y + r), b.y + b.h - r);
  const dx = px - nx;
  const dy = py - ny;
  return dx * dx + dy * dy <= r * r;
}

// Topmost opaque shape at a point, or null for transparent.
function sample(px, py, g) {
  for (const eye of g.eyes) if (inRoundRect(px, py, eye)) return INK.mint;
  if (inRoundRect(px, py, g.screen)) return INK.screen;
  if (inRoundRect(px, py, g.shell)) {
    // A soft top-light on the shell, same read as shellNearLit in the rig.
    const t = Math.min(1, Math.max(0, (py - g.shell.y) / g.shell.h));
    return [
      Math.round(INK.shellLit[0] + (INK.shell[0] - INK.shellLit[0]) * t),
      Math.round(INK.shellLit[1] + (INK.shell[1] - INK.shellLit[1]) * t),
      Math.round(INK.shellLit[2] + (INK.shell[2] - INK.shellLit[2]) * t),
    ];
  }
  return null;
}

// Supersampled so every edge — including the screen and eyes against the
// shell — gets antialiased, not just the outer silhouette.
function render(size, ss = 4) {
  const g = geometry(size);
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / (size * ss);
  const half = step / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let gr = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const px = (x * ss + sx) * step + half;
          const py = (y * ss + sy) * step + half;
          const c = sample(px, py, g);
          if (c) {
            r += c[0];
            gr += c[1];
            b += c[2];
            hits += 1;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (hits) {
        // Un-premultiplied colour is the mean of covering samples; alpha is
        // the coverage fraction.
        rgba[i] = Math.round(r / hits);
        rgba[i + 1] = Math.round(gr / hits);
        rgba[i + 2] = Math.round(b / hits);
        rgba[i + 3] = Math.round((hits / (ss * ss)) * 255);
      }
    }
  }
  return rgba;
}

// --- PNG encoder ----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10-12: deflate / adaptive filtering / no interlace, all zero.

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- ICO container --------------------------------------------------------

// PNG-compressed ICO entries; supported by Windows Vista and newer.
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;

  entries.forEach((e, i) => {
    const at = i * 16;
    dir[at] = e.size >= 256 ? 0 : e.size; // 0 means 256
    dir[at + 1] = e.size >= 256 ? 0 : e.size;
    dir[at + 2] = 0; // palette size
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// --- SVG source (editable master) ----------------------------------------

function buildSvg() {
  const g = geometry(256);
  const px = (v) => (v * 256).toFixed(2);
  const rr = (b, fill) =>
    `  <rect x="${px(b.x)}" y="${px(b.y)}" width="${px(b.w)}" height="${px(b.h)}" rx="${px(b.r)}" fill="${fill}"/>`;
  const hex = (c) => `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <title>Scrappy</title>
  <!-- Generated by scripts/build-icon.js. Edit the geometry there, not here. -->
  <defs>
    <linearGradient id="shell" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hex(INK.shellLit)}"/>
      <stop offset="1" stop-color="${hex(INK.shell)}"/>
    </linearGradient>
  </defs>
${rr(g.shell, "url(#shell)")}
${rr(g.screen, hex(INK.screen))}
${g.eyes.map((e) => rr(e, hex(INK.mint))).join("\n")}
</svg>
`;
}

// --- main -----------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });

const pngs = new Map();
for (const size of SIZES) {
  const png = encodePng(size, render(size));
  pngs.set(size, png);
  fs.writeFileSync(path.join(OUT_DIR, `scrappy-face-${size}.png`), png);
  console.log(`assets/scrappy-face-${size}.png  ${png.length} bytes`);
}

const ico = encodeIco(ICO_SIZES.map((size) => ({ size, png: pngs.get(size) })));
fs.writeFileSync(path.join(OUT_DIR, "scrappy.ico"), ico);
console.log(`assets/scrappy.ico  ${ico.length} bytes  (${ICO_SIZES.join(", ")})`);

fs.writeFileSync(path.join(OUT_DIR, "scrappy-face.svg"), buildSvg());
console.log("assets/scrappy-face.svg");
