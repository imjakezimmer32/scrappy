// Turn a spoken or pasted plan into steps Scrappy can walk, one at a time.
// Persistence lives under the shared store key "plan".

const store = require("./store");

const STEP_RE = /^(?:(\d+)[.)]|[-*])\s+(.+)$/;

function emptyPlan() {
  return { goal: "", steps: [], status: "done" };
}

function parsePlan(text) {
  if (!text || typeof text !== "string") return { steps: [] };
  const steps = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(STEP_RE);
    if (!match) continue;
    steps.push({
      index: steps.length + 1,
      text: match[2].trim(),
      status: "pending",
    });
  }
  return { steps };
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map((step, i) => ({
    index: Number.isInteger(step && step.index) ? step.index : i + 1,
    text: String((step && step.text) || "").trim(),
    status: step && step.status === "done" ? "done" : "pending",
  }));
}

function savePlan(filePath, input) {
  const steps = normalizeSteps(input && input.steps);
  const stored = {
    goal: input && input.goal != null ? String(input.goal) : "",
    steps,
    status: steps.some((step) => step.status === "pending") ? "active" : "done",
  };
  store.update(filePath, (data) => {
    data.plan = stored;
    return data;
  });
  return stored;
}

function loadPlan(filePath) {
  const data = store.read(filePath);
  if (!data.plan || typeof data.plan !== "object") return emptyPlan();
  const steps = normalizeSteps(data.plan.steps);
  const status =
    data.plan.status === "done" || !steps.some((step) => step.status === "pending")
      ? "done"
      : "active";
  return {
    goal: data.plan.goal != null ? String(data.plan.goal) : "",
    steps,
    status,
  };
}

function currentStep(plan) {
  if (!plan || !Array.isArray(plan.steps)) return null;
  return plan.steps.find((step) => step && step.status === "pending") || null;
}

function advance(filePath) {
  let upcoming = null;
  store.update(filePath, (data) => {
    const plan = data.plan && typeof data.plan === "object" ? data.plan : emptyPlan();
    if (!Array.isArray(plan.steps)) plan.steps = [];
    const current = currentStep(plan);
    if (current) current.status = "done";
    upcoming = currentStep(plan);
    plan.status = upcoming ? "active" : "done";
    data.plan = plan;
    return data;
  });
  return upcoming ? { ...upcoming } : null;
}

function kickoffLine(step) {
  const text = String((step && step.text) || "the next step")
    .replace(/\?/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]+$/g, "");
  const body = text || "the next step";
  return `Starting now. ${body}.`;
}

module.exports = {
  parsePlan,
  savePlan,
  loadPlan,
  currentStep,
  advance,
  kickoffLine,
};
