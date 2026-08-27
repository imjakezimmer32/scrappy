const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const setupHtml = fs.readFileSync(path.join(__dirname, "../setup/index.html"), "utf8");
const overlayHtml = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");

test("kills Electron's File/Edit/View/Help menu on every window", () => {
  assert.match(main, /function killNativeChrome/);
  assert.match(main, /function keepOverlayChromeOff/);
  assert.match(main, /browser-window-created/);
  assert.match(main, /setMenuBarVisibility\(false\)/);
  assert.match(main, /Menu\.setApplicationMenu\(null\)/);
});

test("setup window is frameless so it cannot grow a white title bar", () => {
  assert.match(main, /function openSetupWindow/);
  const setupBlock = main.slice(main.indexOf("function openSetupWindow"));
  assert.match(setupBlock, /frame:\s*false/);
  assert.match(setupBlock, /titleBarStyle:\s*"hidden"/);
  assert.match(setupHtml, /id="close"/);
});

test("overlay page title is empty so Windows has nothing to paint as Scrappy", () => {
  assert.match(overlayHtml, /<title><\/title>/);
});
