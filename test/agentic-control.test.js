const test = require("node:test");
const assert = require("node:assert/strict");
const control = require("../agentic/control");

test("he may drive Cursor, open apps, and type", () => {
  assert.equal(control.judge({ action: "cursor-start", goal: "fix the hook" }).decision, "allow");
  assert.equal(control.judge({ action: "open-app", target: "cursor" }).decision, "allow");
  assert.equal(control.judge({ action: "open-url", target: "https://imscrappy.dev" }).decision, "allow");
  assert.equal(control.judge({ action: "type-text", text: "hello" }).decision, "allow");
});

test("he refuses anything harmful", () => {
  assert.equal(control.judge({ action: "type-text", text: "format c:" }).decision, "refuse");
  assert.equal(control.judge({ action: "open-url", target: "https://x" , text: "git push origin main" }).decision, "refuse");
  assert.equal(control.judge({ action: "read-file", target: "C:/Users/me/.ssh/id_rsa" }).decision, "refuse");
  assert.equal(control.judge({ action: "read-file", target: "C:/secrets/password.txt" }).decision, "refuse");
});

test("he will not type over you while you are talking", () => {
  const out = control.respect({ action: "type-text", text: "hi", voiceActive: true });
  assert.equal(out.decision, "ask");
});
