// Current task Scrappy is on. Survives across chats so a wake can resume
// the work instead of only greeting. Callers pass the shared store path.

const crypto = require("crypto");
const store = require("./store");

const MAX_GOALS = 20;

function nowIso() {
  return new Date().toISOString();
}

function asDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
  return doc;
}

function asGoals(doc) {
  const goals = asDoc(doc).goals;
  if (!Array.isArray(goals)) return [];
  return goals.filter((goal) => goal && typeof goal === "object");
}

function setGoal(filePath, input) {
  const raw = input || {};
  const text = String(raw.text == null ? "" : raw.text).trim();
  const source = raw.source == null ? null : String(raw.source);
  const stamp = nowIso();
  const goal = {
    id: crypto.randomUUID(),
    text,
    source,
    status: "open",
    updatedAt: stamp,
    createdAt: stamp,
  };

  store.update(filePath, (doc) => {
    const base = asDoc(doc);
    const closed = asGoals(base).map((existing) => {
      if (existing.status !== "open") return existing;
      return { ...existing, status: "done", updatedAt: stamp };
    });
    // Newest first. Drop the oldest once the history exceeds the cap.
    const goals = [goal, ...closed].slice(0, MAX_GOALS);
    return { ...base, goals };
  });

  return goal;
}

function getGoal(filePath) {
  const open = asGoals(store.read(filePath)).find((goal) => goal.status === "open");
  return open || null;
}

function completeGoal(filePath) {
  let completed = null;
  const stamp = nowIso();
  store.update(filePath, (doc) => {
    const base = asDoc(doc);
    const goals = asGoals(base).map((goal) => {
      if (completed || goal.status !== "open") return goal;
      completed = { ...goal, status: "done", updatedAt: stamp };
      return completed;
    });
    return { ...base, goals };
  });
  return completed;
}

function resumeLine(goal) {
  if (!goal || typeof goal !== "object") return null;
  if (goal.status === "done") return null;
  const text = String(goal.text == null ? "" : goal.text)
    .replace(/\?/g, "")
    .trim()
    .replace(/[.!]+$/g, "")
    .trim();
  if (!text) return null;
  return `Still on: ${text}.`;
}

function listRecent(filePath, limit) {
  const goals = asGoals(store.read(filePath));
  const n = limit == null ? goals.length : Number(limit);
  if (!Number.isFinite(n) || n <= 0) return [];
  return goals.slice(0, n);
}

module.exports = { setGoal, getGoal, completeGoal, resumeLine, listRecent };
