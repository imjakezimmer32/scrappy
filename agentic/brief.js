// First show of the day: what finished overnight, what failed, and the open goal.
// An unambiguous failed agent becomes the follow-up he starts himself.

function morningBrief(input = {}) {
  const now = input.now instanceof Date ? input.now : new Date();
  const last = input.lastBriefAt ? new Date(input.lastBriefAt) : null;
  if (last && !Number.isNaN(last.getTime()) && sameDay(last, now)) {
    return { skip: true };
  }
  const agents = Array.isArray(input.agents) ? input.agents : [];
  const failed = agents.filter((agent) => isFail(agent && agent.status));
  const finished = agents.filter((agent) => isDone(agent && agent.status));
  const goal = String(input.unfinishedGoal || "").trim();
  const parts = [];
  parts.push(finished.length ? `${finished.length} finished overnight.` : "Nothing finished overnight.");
  if (failed.length) parts.push(`${failed.length} failed.`);
  if (goal) parts.push(`Still on: ${goal}.`);
  const followUp = failed.length === 1 ? `Continue the failed run: ${failed[0].goal || failed[0].id || "that agent"}.` : null;
  return { skip: false, speech: parts.join(" ").slice(0, 280), followUp };
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isFail(status) {
  const s = String(status || "").toLowerCase();
  return s === "error" || s === "failed";
}

function isDone(status) {
  const s = String(status || "").toLowerCase();
  return s === "finished" || s === "completed" || s === "success";
}

module.exports = { morningBrief };
