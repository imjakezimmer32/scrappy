// Glue the agentic modules into the decisions the app actually runs.

const agentDone = require("./agent-done");
const verify = require("./verify");
const loop = require("./loop");
const turn = require("./turn");
const interrupt = require("./interrupt");
const hands = require("./hands");
const queue = require("./queue");
const toolsFirst = require("./tools-first");
const goals = require("./goals");
const watch = require("./watch");
const plan = require("./plan");
const complaints = require("./complaints");
const morning = require("./brief");
const nag = require("./nag");
const rules = require("./rules");
const second = require("./second");

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

// One pass the app runs on a finished agent, on startup, and before a new agent.
// Every behavior below is invoked from here so a caller cannot skip one.
function liveCycle(filePath, input = {}) {
  const now = input.now instanceof Date ? input.now : new Date();
  const lines = [];

  if (input.complaint) {
    const noted = complaints.noteComplaint(filePath, input.complaint);
    if (noted.shouldFix && noted.goal) {
      goals.setGoal(filePath, { text: noted.goal, source: "complaint" });
      lines.push(noted.goal);
    }
  }

  if (input.rule) rules.learnRule(filePath, input.rule);

  if (input.planText) {
    const parsed = plan.parsePlan(input.planText);
    plan.savePlan(filePath, { goal: input.goal || "", steps: parsed.steps });
    const step = plan.currentStep(plan.loadPlan(filePath));
    if (step) lines.push(plan.kickoffLine(step));
  }

  const sitting = nag.nagLine({
    sittingMs: input.sittingMs,
    kind: input.nagKind || "work",
    actionTaken: input.actionTaken,
  });
  const allowNag = second.skipNagAfterThrow(input.thrownRecently).nag && !second.inQuietHours(now);
  if (sitting && allowNag) lines.push(sitting);

  if (!second.inQuietHours(now)) {
    const seen = watch.observe({
      idleMs: input.idleMs || 0,
      agentStatus: input.agentStatus || null,
      lastError: input.lastError || "",
      errorRepeatCount: input.errorRepeatCount || 0,
      activeWindow: input.activeWindow || "",
    });
    if (seen && seen.speech) lines.push(seen.speech);
  }

  const open = goals.getGoal(filePath);
  const resume = goals.resumeLine(open);
  if (resume && input.includeResume) lines.push(resume);

  const report = morning.morningBrief({
    now,
    lastBriefAt: input.lastBriefAt || null,
    agents: input.agents || [],
    unfinishedGoal: open && open.text,
  });
  if (input.wantBrief && !report.skip && report.speech) lines.push(report.speech);

  if (open && second.staleGoal(open.updatedAt, now.getTime()).stale) {
    lines.push("That goal has gone quiet. I'll leave it until you name a new one.");
  }

  const learned = rules.applicableRules(filePath, (open && open.text) || input.goal || "");
  const hand = input.hand ? hands.describe(input.hand) : null;
  const gate = beforeAction(filePath, input);
  const retry = second.retryWithOtherTool(input.toolsTried, toolsFirst.TOOLS);
  const duplicate = second.refuseDuplicate(input.running || [], input.goal);
  const cap = second.capVoiceAgents(Number(input.voiceAgents) || 0);
  second.rememberPr(filePath, input.prUrl || null);
  const recap = second.sessionRecap(input.events || []);
  if (recap) lines.push(recap);
  const clipped = second.clipResult(input.result || "");
  const pushBlocked = second.blockPushMain(input.command || input.goal || "");
  const done = second.doneToday(input.doneEntries || [], now);
  const status = second.statusLine(input.agents || []);
  const choice = second.preferContinue(Boolean(open));
  const closed = turn.closeTurn({
    toolFired: input.toolFired === true || lines.length > 0,
    question: input.question,
  });

  return {
    lines: second.coalesceNotices(lines),
    resume,
    report,
    learned,
    hand,
    gate,
    retry,
    duplicate,
    cap,
    clipped,
    pushBlocked,
    done,
    status,
    choice,
    closed,
    briefed: Boolean(input.wantBrief && report && !report.skip),
  };
}

module.exports = { afterAgentRun, beforeAction, liveCycle };
