// Glue the agentic modules into the decisions the app actually runs.

const agentDone = require("./agent-done");
const verify = require("./verify");
const loop = require("./loop");
const turn = require("./turn");
const interrupt = require("./interrupt");
const hands = require("./hands");
const queue = require("./queue");
const toolsFirst = require("./tools-first");

function afterAgentRun(input = {}) {
  const summary = agentDone.summarizeAgentDone(input);
  if (summary.skip) return { summary };
  const checks = Array.isArray(input.checks) && input.checks.length
    ? input.checks
    : [{ name: "status", ok: summary.celebrate === true }];
  const verdict = verify.shouldCelebrate({
    claimedDone: summary.celebrate === true,
    checks,
  });
  const follow = loop.decideFollowUp({
    goal: input.goal || "",
    result: input.result || "",
    goalMet: verdict.celebrate,
    hops: Number(input.hops) || 0,
    maxHops: input.maxHops,
  });
  const closed = turn.closeTurn({ toolFired: true });
  return { summary, verdict, follow, closed };
}

function beforeAction(filePath, input = {}) {
  const gate = interrupt.needsInterrupt(input);
  if (gate.interrupt) return { ok: false, ...gate };
  if (input.hand && !hands.isAllowed(input.hand)) return { ok: false, reason: "hand" };
  if (input.goal && input.ownerId) {
    const owned = queue.enqueue(filePath, { goal: input.goal, ownerId: input.ownerId });
    if (!owned.ok) return { ok: false, reason: owned.error, ownerId: owned.ownerId };
  }
  const ask = toolsFirst.shouldAsk({
    missingFacts: input.missingFacts,
    toolsTried: input.toolsTried,
  });
  if (ask.nextTool) return { ok: true, nextTool: ask.nextTool };
  if (ask.ask) return { ok: false, reason: "ask", question: ask.question };
  return { ok: true };
}

module.exports = { afterAgentRun, beforeAction };
