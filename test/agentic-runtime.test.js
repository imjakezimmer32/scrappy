const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const runtime = require("../agentic/runtime");

test("live cycle runs the behaviors together", () => {
  const file = path.join(os.tmpdir(), `scrappy-live-${Date.now()}.json`);
  const noon = new Date("2026-09-24T15:00:00");
  const cycle = runtime.liveCycle(file, {
    now: noon,
    complaint: "he didn't commit",
    planText: "1. Sketch the frame\n2. Bolt the arm",
    goal: "build the arm",
    sittingMs: 2 * 60 * 60 * 1000,
    actionTaken: "rebased the branch",
    wantBrief: true,
    includeResume: false,
    hand: "read-log",
    ownerId: "voice",
    reversible: true,
    toolsTried: ["recall"],
    result: "x".repeat(300),
    command: "git status",
    events: [{ text: "hooks" }],
    doneEntries: [{ at: noon.toISOString(), status: "done" }],
    agents: [{ status: "running" }],
    toolFired: true,
    prUrl: "https://example/pr/2",
  });
  assert.ok(cycle.lines.some((line) => /Sketch the frame/.test(line)));
  assert.ok(cycle.lines.some((line) => /Rebased/.test(line)));
  assert.equal(cycle.lines.length <= 3, true);
  assert.equal(cycle.hand.ok, true);
  assert.equal(cycle.gate.ok, true);
  assert.equal(cycle.retry.tool, "cursor-chats");
  assert.equal(cycle.pushBlocked, false);
  assert.equal(cycle.done.length, 1);
  assert.equal(cycle.choice, "start");
  assert.ok(cycle.clipped.endsWith("…"));
  assert.equal(cycle.closed.ok, true);
  const again = runtime.liveCycle(file, {
    now: noon,
    complaint: "he didn't commit",
    toolFired: true,
  });
  assert.ok(again.lines.some((line) => /Fix this/.test(line)));
  fs.unlinkSync(file);
});

test("a push to main is blocked and a bad hand is refused", () => {
  const file = path.join(os.tmpdir(), `scrappy-live-block-${Date.now()}.json`);
  const cycle = runtime.liveCycle(file, {
    now: new Date("2026-09-24T15:00:00"),
    goal: "git push origin main",
    command: "git push origin main",
    hand: "delete-repo",
    ownerId: "voice",
    destructive: true,
    toolFired: false,
  });
  assert.equal(cycle.pushBlocked, true);
  assert.equal(cycle.hand.ok, false);
  assert.equal(cycle.gate.interrupt, true);
  if (fs.existsSync(file)) fs.unlinkSync(file);
});
