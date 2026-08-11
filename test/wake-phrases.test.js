const test = require("node:test");
const assert = require("node:assert/strict");
const { matchesWakePhrase } = require("../renderer/wake-phrases.js");

test("matchesWakePhrase detects unique wake phrases", () => {
  assert.equal(matchesWakePhrase("hey there cog"), true);
  assert.equal(matchesWakePhrase("Hey there, Cog!"), true);
  assert.equal(matchesWakePhrase("okay then cog"), true);
  assert.equal(matchesWakePhrase("wake up cog please"), true);
});

test("matchesWakePhrase ignores short or unrelated speech", () => {
  assert.equal(matchesWakePhrase("hey cog"), false);
  assert.equal(matchesWakePhrase("hi cog"), false);
  assert.equal(matchesWakePhrase("hello there"), false);
  assert.equal(matchesWakePhrase("cog"), false);
  assert.equal(matchesWakePhrase(""), false);
});
