const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeAgentDone } = require("../agentic/agent-done");

function sentences(speech) {
  return speech.split(/(?<=[.!])\s+/).filter(Boolean);
}

function assertSpoken(out) {
  assert.equal(typeof out.speech, "string");
  assert.ok(out.speech.length > 0);
  assert.ok(out.speech.length <= 280);
  assert.equal(out.speech.includes("?"), false);
  assert.doesNotMatch(out.speech, /want me to/i);
  const parts = sentences(out.speech);
  assert.ok(parts.length >= 1 && parts.length <= 2, `expected 1-2 sentences, got ${parts.length}: ${out.speech}`);
  assert.match(out.speech, /I'll /);
}

test("long success says what landed, what is still open, and a decided next step", () => {
  const out = summarizeAgentDone({
    goal: "Fix the login redirect",
    result: "Fixed the login redirect so /login returns home.\nStill open: password reset email.\nNext: run the auth tests.",
    durationMs: 120000,
    status: "finished",
  });

  assert.equal(out.skip, undefined);
  assert.equal(out.celebrate, true);
  assert.match(out.landed, /login redirect/);
  assert.equal(out.stillOpen, "password reset email");
  assert.equal(out.nextStep, "Run the auth tests");
  assert.match(out.speech, /password reset email/i);
  assert.match(out.speech, /run the auth tests/i);
  assertSpoken(out);
});

test("short run under two minutes is skipped", () => {
  const out = summarizeAgentDone({
    goal: "Tiny tweak",
    result: "Changed a comment.",
    durationMs: 119999,
    status: "completed",
  });
  assert.deepEqual(out, { skip: true });
});

test("force summarizes a short run and celebrates success", () => {
  const out = summarizeAgentDone({
    goal: "Rename a variable",
    result: "Renamed foo to bar.",
    durationMs: 5000,
    status: "Success",
    force: true,
  });

  assert.equal(out.skip, undefined);
  assert.equal(out.celebrate, true);
  assert.match(out.landed, /Renamed foo to bar/);
  assert.equal(out.stillOpen, null);
  assert.equal(out.nextStep, "Read the diff and confirm the change");
  assert.match(out.speech, /read the diff/i);
  assertSpoken(out);
});

test("failure does not celebrate and the speech names the failure", () => {
  const cases = [
    { status: "failed", named: /\bfailed\b/i },
    { status: "ERROR", named: /\berror\b/i },
    { status: "Cancelled", named: /\bcancelled\b/i },
  ];

  for (const { status, named } of cases) {
    const out = summarizeAgentDone({
      goal: "Ship the patch",
      result: "Tests crashed in auth.spec.js.",
      durationMs: 180000,
      status,
    });
    assert.equal(out.celebrate, false, status);
    assert.match(out.landed, /auth\.spec\.js/);
    assert.match(out.speech, named, status);
    assert.equal(typeof out.nextStep, "string");
    assert.ok(out.nextStep.length > 0);
    assertSpoken(out);
  }
});

test("empty result says the run ended with no writeup", () => {
  for (const result of ["", "   ", "\n\t", null, undefined]) {
    const out = summarizeAgentDone({
      goal: "Document the hook",
      result,
      durationMs: 130000,
      status: "completed",
    });
    assert.equal(out.celebrate, true);
    assert.equal(out.landed, "The run ended with no writeup.");
    assert.equal(out.stillOpen, null);
    assert.match(out.nextStep, /check the files for what changed/i);
    assert.match(out.speech, /no writeup/i);
    assertSpoken(out);
  }
});

test("success statuses celebrate and other statuses do not", () => {
  for (const status of ["finished", "FINISHED", "completed", " Success "]) {
    const out = summarizeAgentDone({
      result: "Shipped the patch.",
      durationMs: 120000,
      status,
    });
    assert.equal(out.celebrate, true, status);
  }
  for (const status of ["error", "failed", "cancelled", "canceled", "running", ""]) {
    const out = summarizeAgentDone({
      result: "Shipped the patch.",
      durationMs: 120000,
      status,
    });
    assert.equal(out.celebrate, false, status);
  }
});

test("speech stays within 280 characters on a long writeup", () => {
  const out = summarizeAgentDone({
    goal: "Refactor the desk loop",
    result: `Landed: ${"updated the gait controller ".repeat(80)}\nStill open: ${"edge case ".repeat(40)}\nNext: rerun the gait check on the near leg`,
    durationMs: 240000,
    status: "completed",
  });
  assert.equal(out.celebrate, true);
  assert.match(out.stillOpen, /edge case/);
  assert.match(out.nextStep, /gait check/i);
  assert.ok(out.speech.length <= 280);
  assert.match(out.speech, /I'll /);
  assert.equal(out.speech.includes("?"), false);
});
