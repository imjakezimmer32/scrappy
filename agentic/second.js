// A second set of fifteen decisions. Each one is a pure function.

function retryWithOtherTool(tried, catalog) {
  const used = new Set(tried || []);
  const next = (catalog || []).find((name) => !used.has(name)) || null;
  return { retry: Boolean(next), tool: next };
}

function refuseDuplicate(running, goal) {
  const hit = (running || []).find((row) => row.goal === goal && row.status === "running");
  return { refuse: Boolean(hit), ownerId: hit ? hit.id : null };
}

function statusLine(agents) {
  const list = agents || [];
  const running = list.filter((row) => row.status === "running").length;
  return `${running} running, ${list.length - running} idle.`;
}

function capVoiceAgents(count, cap = 1) {
  return { allow: count < cap, count, cap };
}

function rememberPr(file, pr) {
  const store = require("./store");
  store.update(file, (doc) => ({ ...(doc || {}), lastPr: pr || null }));
  return pr || null;
}

function inQuietHours(date, startHour = 23, endHour = 7) {
  const hour = date.getHours();
  if (startHour > endHour) return hour >= startHour || hour < endHour;
  return hour >= startHour && hour < endHour;
}

function skipNagAfterThrow(thrownRecently) {
  return { nag: thrownRecently !== true };
}

function sessionRecap(events) {
  const notes = (events || []).map((event) => event.text).filter(Boolean);
  if (!notes.length) return null;
  return `We covered ${notes.slice(0, 3).join(", ")}.`;
}

function commitRuleFromPhrase(phrase) {
  const text = String(phrase || "");
  const match = text.match(/\b(always|never)\b[^.]*/i);
  return match ? match[0].trim() : null;
}

function staleGoal(updatedAt, now, days = 7) {
  const age = now - new Date(updatedAt).getTime();
  return { stale: age > days * 24 * 60 * 60 * 1000 };
}

function coalesceNotices(lines) {
  const unique = [];
  (lines || []).forEach((line) => {
    if (line && !unique.includes(line)) unique.push(line);
  });
  return unique.slice(0, 3);
}

function preferContinue(hasOwner) {
  return hasOwner ? "continue" : "start";
}

function clipResult(text, max = 240) {
  const raw = String(text || "");
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1)}…`;
}

function blockPushMain(command) {
  return /push\s+.*\bmain\b/i.test(String(command || ""));
}

function doneToday(entries, now) {
  const day = now.toDateString();
  return (entries || []).filter((entry) => new Date(entry.at).toDateString() === day && entry.status === "done");
}

module.exports = {
  retryWithOtherTool,
  refuseDuplicate,
  statusLine,
  capVoiceAgents,
  rememberPr,
  inQuietHours,
  skipNagAfterThrow,
  sessionRecap,
  commitRuleFromPhrase,
  staleGoal,
  coalesceNotices,
  preferContinue,
  clipResult,
  blockPushMain,
  doneToday,
};
