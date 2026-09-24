const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const toolsFirst = require("../agentic/tools-first");
const complaints = require("../agentic/complaints");
const brief = require("../agentic/brief");
const nag = require("../agentic/nag");
const verify = require("../agentic/verify");
const queue = require("../agentic/queue");
const hands = require("../agentic/hands");
const interrupt = require("../agentic/interrupt");
const rules = require("../agentic/rules");
const turn = require("../agentic/turn");

test("tools come before a question", () => {
  const missing = toolsFirst.shouldAsk({ missingFacts: ["the repo"], toolsTried: [] });
  assert.equal(missing.ask, false);
  assert.equal(missing.nextTool, "recall");
  const ready = toolsFirst.shouldAsk({
    missingFacts: ["the repo"],
    toolsTried: toolsFirst.TOOLS,
  });
  assert.equal(ready.ask, true);
  assert.match(ready.question, /the repo/);
  assert.equal(toolsFirst.shouldAsk({ missingFacts: [], toolsTried: [] }).ask, false);
});

test("the second identical complaint becomes a fix goal", () => {
  const file = path.join(os.tmpdir(), `scrappy-complaints-${Date.now()}.json`);
  const once = complaints.noteComplaint(file, "he didn't commit");
  assert.equal(once.shouldFix, false);
  const twice = complaints.noteComplaint(file, "He didn't commit");
  assert.equal(twice.count, 2);
  assert.equal(twice.shouldFix, true);
  assert.match(twice.goal, /Fix this/);
  fs.unlinkSync(file);
});

test("morning brief runs once a day and follows one failure", () => {
  const now = new Date("2026-09-24T09:00:00Z");
  const first = brief.morningBrief({
    now,
    agents: [{ status: "failed", goal: "fix hooks" }, { status: "finished" }],
    unfinishedGoal: "voice",
  });
  assert.equal(first.skip, false);
  assert.match(first.speech, /1 finished/);
  assert.match(first.speech, /Still on: voice/);
  assert.match(first.followUp, /fix hooks/);
  const again = brief.morningBrief({ now, lastBriefAt: now.toISOString(), agents: [] });
  assert.equal(again.skip, true);
  const many = brief.morningBrief({
    now: new Date("2026-09-25T09:00:00Z"),
    agents: [{ status: "error" }, { status: "failed" }],
  });
  assert.equal(many.followUp, null);
});

test("nag names the action after an hour", () => {
  assert.equal(nag.nagLine({ sittingMs: 1000, kind: "PR" }), null);
  assert.match(nag.nagLine({ sittingMs: 2 * 60 * 60 * 1000, kind: "PR", actionTaken: "rebased the branch" }), /Rebased the branch/);
});

test("one owner per goal until the owner is stuck", () => {
  const file = path.join(os.tmpdir(), `scrappy-queue-${Date.now()}.json`);
  assert.equal(queue.enqueue(file, { goal: "ship", ownerId: "a" }).ok, true);
  assert.equal(queue.enqueue(file, { goal: "ship", ownerId: "b" }).error, "owned");
  queue.markStuck(file, "ship");
  assert.equal(queue.enqueue(file, { goal: "ship", ownerId: "b" }).ok, true);
  assert.equal(queue.onIdle(file, "b").goal, "ship");
  fs.unlinkSync(file);
});

test("local hands stay on the allow list", () => {
  assert.equal(hands.isAllowed("read-log"), true);
  assert.equal(hands.describe("delete-repo").ok, false);
});

test("interrupt only for destructive or ambiguous work", () => {
  assert.equal(interrupt.needsInterrupt({ reversible: true }).interrupt, false);
  assert.equal(interrupt.needsInterrupt({ destructive: true }).reason, "destructive");
  assert.equal(interrupt.needsInterrupt({ ambiguous: true }).interrupt, true);
});

test("rules are learned and matched to context", () => {
  const file = path.join(os.tmpdir(), `scrappy-rules-${Date.now()}.json`);
  rules.learnRule(file, "always commit");
  rules.learnRule(file, "always commit");
  const hit = rules.applicableRules(file, "ready to commit the branch");
  assert.equal(hit.length, 1);
  fs.unlinkSync(file);
});

test("a turn needs a fired tool or one real question", () => {
  assert.equal(turn.closeTurn({ toolFired: true }).ok, true);
  assert.equal(turn.closeTurn({ question: "Want me to commit?" }).error, "not_a_commitment");
  assert.equal(turn.closeTurn({}).error, "no_commitment");
  assert.equal(turn.closeTurn({ question: "Which repo?" }).speech, "Which repo?");
});

test("celebrate only when every check passed", () => {
  assert.equal(verify.shouldCelebrate({ claimedDone: false, checks: [{ ok: true }] }).celebrate, false);
  assert.equal(verify.shouldCelebrate({ claimedDone: true, checks: [] }).sendBack, true);
  const bad = verify.shouldCelebrate({ claimedDone: true, checks: [{ name: "ci", ok: false }] });
  assert.equal(bad.celebrate, false);
  assert.match(bad.reason, /ci failed/);
  assert.equal(verify.shouldCelebrate({ claimedDone: true, checks: [{ ok: true }] }).celebrate, true);
});
