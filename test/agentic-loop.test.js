const { test } = require("node:test");
const assert = require("node:assert/strict");
const { decideFollowUp } = require("../agentic/loop");

function assertSpoken(message) {
  assert.equal(typeof message, "string");
  assert.ok(message.length > 0);
  assert.equal(message.includes("?"), false);
  assert.equal(/want me to/i.test(message), false);
}

test("met", () => {
  const out = decideFollowUp({
    goal: "ship the patch",
    result: "notes\nTODO still broken\nstill open: the footer",
    goalMet: true,
    hops: 1,
    maxHops: 3,
  });
  assert.equal(out.action, "stop");
  assert.equal(out.hops, 1);
  assertSpoken(out.message);
  assert.match(out.message, /\b(finished|met|did|wrapped|completed)\b/i);
  assert.match(out.message, /goal/i);
  assert.doesNotMatch(out.message, /loop forever/i);

  const atCap = decideFollowUp({
    goal: "ship the patch",
    result: "TODO still broken",
    goalMet: true,
    hops: 3,
    maxHops: 3,
  });
  assert.equal(atCap.action, "stop");
  assert.equal(atCap.hops, 3);
  assert.match(atCap.message, /goal/i);
});

test("max hops", () => {
  const atLimit = decideFollowUp({
    goal: "ship the patch",
    result: "TODO still broken",
    goalMet: false,
    hops: 3,
    maxHops: 3,
  });
  assert.equal(atLimit.action, "stop");
  assert.equal(atLimit.hops, 3);
  assertSpoken(atLimit.message);
  assert.match(atLimit.message, /stop/i);
  assert.match(atLimit.message, /does not loop forever/i);

  const over = decideFollowUp({
    goal: "ship the patch",
    result: "built the installer",
    goalMet: false,
    hops: 5,
    maxHops: 3,
  });
  assert.equal(over.action, "stop");
  assert.equal(over.hops, 5);
  assert.match(over.message, /does not loop forever/i);
});

test("leftover continue", () => {
  const cases = [
    { result: "notes\nTODO fix the tray icon", quote: "TODO fix the tray icon" },
    { result: "leftover: wire the tests", quote: "leftover: wire the tests" },
    { result: "ok\nstill open: the footer link", quote: "still open: the footer link" },
  ];
  for (const c of cases) {
    const out = decideFollowUp({
      goal: "ship the patch",
      result: c.result,
      goalMet: false,
      hops: 0,
      maxHops: 3,
    });
    assert.equal(out.action, "continue");
    assert.equal(out.hops, 1);
    assertSpoken(out.message);
    assert.match(out.message, /same agent/i);
    assert.match(out.message, /\bfinish\b/i);
    assert.ok(out.message.includes(c.quote), out.message);
  }

  const buried = decideFollowUp({
    goal: "ship the patch",
    result: "I left a TODO in a comment and moved on.",
    goalMet: false,
    hops: 0,
    maxHops: 3,
  });
  assert.equal(buried.action, "next");
});

test("plain next", () => {
  const out = decideFollowUp({
    goal: "ship the patch",
    result: "Installer builds clean.",
    goalMet: false,
    hops: 1,
    maxHops: 3,
  });
  assert.equal(out.action, "next");
  assert.equal(out.hops, 2);
  assertSpoken(out.message);
  assert.match(out.message, /ship the patch/);
  assert.match(out.message, /Installer builds clean/);
  assert.match(out.message, /step/i);
});

test("default maxHops", () => {
  const under = decideFollowUp({
    goal: "ship the patch",
    result: "halfway",
    goalMet: false,
    hops: 2,
  });
  assert.equal(under.action, "next");
  assert.equal(under.hops, 3);
  assertSpoken(under.message);

  const at = decideFollowUp({
    goal: "ship the patch",
    result: "halfway",
    goalMet: false,
    hops: 3,
  });
  assert.equal(at.action, "stop");
  assert.equal(at.hops, 3);
  assert.match(at.message, /does not loop forever/i);
});
