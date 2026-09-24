const test = require("node:test");
const assert = require("node:assert/strict");
const { observe } = require("../agentic/watch");

const IDLE_NUDGE_MS = 20 * 60 * 1000;

function snap(overrides) {
  return {
    idleMs: 0,
    agentStatus: "running",
    lastError: "",
    errorRepeatCount: 0,
    activeWindow: "",
    ...overrides,
  };
}

function assertSpeech(speech) {
  assert.equal(typeof speech, "string");
  assert.ok(speech.endsWith("."));
  assert.equal(speech.includes("?"), false);
  assert.equal(/want me to/i.test(speech), false);
}

test("repeated error is the highest priority action", () => {
  const out = observe(
    snap({
      errorRepeatCount: 2,
      lastError: "timeout waiting for the editor",
      agentStatus: "stale",
      idleMs: IDLE_NUDGE_MS,
      activeWindow: "Cursor — scrappy",
    })
  );
  assert.deepEqual(out, {
    shouldAct: true,
    reason: "repeated-error",
    action: "fix-repeat",
    speech: "Same error again: timeout waiting for the editor.",
  });
  assertSpeech(out.speech);
});

test("fix-repeat names a long error briefly", () => {
  const lastError = "ECONNRESET while saving the buffer ".repeat(8);
  const out = observe(snap({ errorRepeatCount: 5, lastError }));
  assert.equal(out.action, "fix-repeat");
  assert.ok(out.speech.startsWith("Same error again: "));
  assert.ok(out.speech.endsWith("."));
  assert.ok(out.speech.length < lastError.length);
  assert.equal(out.speech.includes(lastError), false);
  assertSpeech(out.speech);
});

test("a single error does not fire fix-repeat", () => {
  assert.equal(observe(snap({ errorRepeatCount: 1, lastError: "boom" })), null);
  assert.equal(observe(snap({ errorRepeatCount: 2, lastError: "   " })), null);
  assert.equal(observe(snap({ errorRepeatCount: 2, lastError: "" })), null);
});

test("stale or error agent status asks for a check", () => {
  const stale = observe(snap({ agentStatus: "stale", idleMs: IDLE_NUDGE_MS, activeWindow: "Mail" }));
  assert.equal(stale.action, "check-agent");
  assert.equal(stale.reason, "agent-stale");
  assert.equal(stale.shouldAct, true);
  assertSpeech(stale.speech);

  const errored = observe(snap({ agentStatus: "error", errorRepeatCount: 1, lastError: "boom" }));
  assert.equal(errored.action, "check-agent");
  assert.equal(errored.reason, "agent-error");
  assertSpeech(errored.speech);
});

test("idle at twenty minutes with a window nudges once", () => {
  const out = observe(
    snap({ idleMs: IDLE_NUDGE_MS, activeWindow: "Cursor — watch.js" })
  );
  assert.deepEqual(out, {
    shouldAct: true,
    reason: "idle-too-long",
    action: "nudge-idle",
    speech: "I'll nudge the idle work on Cursor — watch.js.",
  });
  assertSpeech(out.speech);
});

test("idle below twenty minutes does not nudge", () => {
  assert.equal(
    observe(snap({ idleMs: IDLE_NUDGE_MS - 1, activeWindow: "Cursor — watch.js" })),
    null
  );
  assert.equal(observe(snap({ idleMs: IDLE_NUDGE_MS, activeWindow: "   " })), null);
  assert.equal(observe(snap({ idleMs: IDLE_NUDGE_MS, activeWindow: "" })), null);
  assert.equal(observe(snap({ idleMs: IDLE_NUDGE_MS })), null);
});

test("a boring snapshot with only an active window returns null", () => {
  assert.equal(
    observe(
      snap({
        idleMs: 12_000,
        agentStatus: "running",
        lastError: "",
        errorRepeatCount: 0,
        activeWindow: "Slack — #general",
      })
    ),
    null
  );
  assert.equal(observe(null), null);
  assert.equal(observe(undefined), null);
});
