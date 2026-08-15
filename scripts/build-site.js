// Builds the imscrappy.dev landing page into site/dist.
//
// Deliberately zero-dependency plain node, so Cloudflare's build step is just
// `node scripts/build-site.js` with nothing to install first.
//
// The page reuses the REAL character: renderer/rig.js and renderer/style.css
// are copied in as-is, so the Scrappy on the website is the same Scrappy in the
// app. Never fork them into site/ — a copy would drift the moment the rig is
// tuned.

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const src = path.join(root, "site", "src");
const dist = path.join(root, "site", "dist");

// Character source shared with the Electron app. Left column is the file in the
// repo, right column is the name it takes on the site.
const SHARED = [
  // wear.js must be listed before rig.js and loaded before it in the page:
  // rig.js reads window.ScrappyWear at module scope and throws without it.
  ["renderer/wear.js", "wear.js"],
  ["renderer/rig.js", "rig.js"],
  ["renderer/style.css", "character.css"],
  ["renderer/lines.js", "lines.js"],
  ["assets/scrappy-face.svg", "scrappy-face.svg"],
  ["assets/scrappy-face-256.png", "scrappy-face-256.png"],
  ["assets/scrappy.ico", "favicon.ico"],
];

// Markdown that gets both copied out as a downloadable file and inlined into
// the page, so the copy button and the download can never disagree.
const PROMPTS = {
  INSTALL_PROMPT: "install-scrappy.md",
  VOICE_PROMPT: "voice-setup.md",
};

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function main() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });

  for (const [from, to] of SHARED) {
    const abs = path.join(root, from);
    if (!fs.existsSync(abs)) throw new Error(`missing shared asset: ${from}`);
    fs.copyFileSync(abs, path.join(dist, to));
  }

  // Everything in site/src except index.html, which needs substitution first.
  for (const name of fs.readdirSync(src)) {
    if (name === "index.html") continue;
    fs.copyFileSync(path.join(src, name), path.join(dist, name));
  }

  let html = fs.readFileSync(path.join(src, "index.html"), "utf8");
  for (const [token, file] of Object.entries(PROMPTS)) {
    const body = fs.readFileSync(path.join(src, file), "utf8").trimEnd();
    const placeholder = `{{${token}}}`;
    if (!html.includes(placeholder)) throw new Error(`index.html has no ${placeholder}`);
    html = html.replace(placeholder, escapeHtml(body));
  }
  fs.writeFileSync(path.join(dist, "index.html"), html);

  const files = fs.readdirSync(dist).length;
  console.log(`built site/dist — ${files} files`);
}

main();
