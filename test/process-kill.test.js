const { test } = require("node:test");
const assert = require("node:assert/strict");

test("process-kill exports killProcessTree", () => {
  const mod = require("../process-kill");
  assert.equal(typeof mod.killProcessTree, "function");
});

test("local voice launcher warms in background after start", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../local-voice-launcher.js"),
    "utf8"
  );
  assert.match(src, /beginBackgroundWarm/);
  assert.match(src, /ensureReady/);
  assert.match(src, /killProcessTree/);
});
