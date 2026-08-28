const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("reach, chase and cling exist as character states", () => {
  const css = fs.readFileSync(path.join(root, "renderer", "style.css"), "utf8");
  assert.match(css, /data-state="reach"/);
  assert.match(css, /data-state="chase"/);
  assert.match(css, /data-state="cling"/);
  assert.match(css, /--step:\s*0\.52s/);
});

test("overlay and site load the hunt math", () => {
  const overlay = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const site = fs.readFileSync(path.join(root, "site", "src", "index.html"), "utf8");
  assert.match(overlay, /cursor-hunt\.js/);
  assert.match(site, /cursor-hunt\.js/);
});

test("browser preview does not treat the character node as the IPC bridge", () => {
  const text = fs.readFileSync(path.join(root, "renderer", "scrappy.js"), "utf8");
  assert.match(text, /typeof window\.scrappy\.onLayout === "function"/);
});

test("he has lines for grabbing and being shaken off", () => {
  const lines = fs.readFileSync(path.join(root, "renderer", "lines.js"), "utf8");
  assert.match(lines, /cling:/);
  assert.match(lines, /clingMiss:/);
  assert.match(lines, /clingOff:/);
});
