const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const adapt = require("../agentic/adapt");

test("talk is heard as a correction or a success without a stated rule", () => {
  assert.equal(adapt.hear("that's wrong").outcome, "corrected");
  assert.equal(adapt.hear("thanks").outcome, "worked");
  assert.equal(adapt.hear("how is the weather"), null);
});

test("two corrections make him fix himself before acting", () => {
  const file = path.join(os.tmpdir(), `scrappy-adapt-${Date.now()}.json`);
  adapt.record(file, adapt.hear("no"));
  adapt.record(file, adapt.hear("that's not it"));
  const style = adapt.stance(file);
  assert.equal(style.autonomy, "ask");
  assert.match(style.speech, /Skip the joke/);
  assert.match(adapt.selfFix(file).goal, /Fix/);
  fs.unlinkSync(file);
});
