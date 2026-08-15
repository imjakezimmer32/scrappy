// personality.md is Scrappy's character sheet and it ships with a {{USER}}
// placeholder rather than a name, so he addresses whoever is actually running
// him instead of the person who wrote him.
//
// Two consumers need it filled in: the ElevenLabs agent upload (scripts/
// setup-voice.js) and the local voice server, which reads a file path out of
// SCRAPPY_PERSONA. The latter is why this writes a rendered copy to disk.

const fs = require("node:fs");
const path = require("node:path");

const SOURCE = path.join(__dirname, "personality.md");

function render(name) {
  const who = String(name || "").trim() || "you";
  let text = "";
  try {
    text = fs.readFileSync(SOURCE, "utf8");
  } catch (err) {
    console.error("Could not read personality.md:", err.message);
    return "";
  }
  return text.split("{{USER}}").join(who);
}

// Writes the filled-in copy next to the rest of the user's data and returns its
// path. Rewritten on every call: the name can change from the setup panel and a
// stale persona would have him using the old one until restart.
function renderToFile(name, dir) {
  const text = render(name);
  if (!text) return SOURCE;
  const out = path.join(dir, "personality.rendered.md");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(out, text, "utf8");
    return out;
  } catch (err) {
    console.error("Could not write rendered persona:", err.message);
    return SOURCE;
  }
}

function exists() {
  return fs.existsSync(SOURCE);
}

module.exports = { render, renderToFile, exists, SOURCE };
