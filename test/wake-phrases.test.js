const test = require("node:test");
const assert = require("node:assert/strict");
const { matchesWakePhrase } = require("../renderer/wake-phrases.js");

test("matchesWakePhrase detects unique wake phrases", () => {
  assert.equal(matchesWakePhrase("hey there scrappy"), true);
  assert.equal(matchesWakePhrase("Hey there, Scrappy!"), true);
  assert.equal(matchesWakePhrase("okay then scrappy"), true);
  assert.equal(matchesWakePhrase("wake up scrappy please"), true);
});

test("matchesWakePhrase ignores short or unrelated speech", () => {
  assert.equal(matchesWakePhrase("hey scrappy"), false);
  assert.equal(matchesWakePhrase("hi scrappy"), false);
  assert.equal(matchesWakePhrase("hello there"), false);
  assert.equal(matchesWakePhrase("scrappy"), false);
  assert.equal(matchesWakePhrase(""), false);
});
