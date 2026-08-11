const test = require("node:test");
const assert = require("node:assert/strict");
const { matchesWakePhrase } = require("../renderer/wake-phrases.js");

test("matchesWakePhrase detects hey cog variants", () => {
  assert.equal(matchesWakePhrase("hey cog"), true);
  assert.equal(matchesWakePhrase("Hey, Cog!"), true);
  assert.equal(matchesWakePhrase("hey chief"), true);
  assert.equal(matchesWakePhrase("hi cog are you there"), true);
  assert.equal(matchesWakePhrase("ok cog listen"), true);
});

test("matchesWakePhrase ignores unrelated speech", () => {
  assert.equal(matchesWakePhrase("hello there"), false);
  assert.equal(matchesWakePhrase("cog"), false);
  assert.equal(matchesWakePhrase(""), false);
});
