const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const plan = require("../agentic/plan");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrappy-plan-"));
  return path.join(dir, "state.json");
}

test("parsePlan reads numbered steps and skips a leading title", () => {
  const parsed = plan.parsePlan(`
Widget build

1. Sketch the frame

2) Wire the motor
`);
  assert.deepEqual(parsed.steps, [
    { index: 1, text: "Sketch the frame", status: "pending" },
    { index: 2, text: "Wire the motor", status: "pending" },
  ]);
});

test("parsePlan reads markdown bullets", () => {
  const parsed = plan.parsePlan(`
- Sketch the frame
* Wire the motor
`);
  assert.deepEqual(parsed.steps, [
    { index: 1, text: "Sketch the frame", status: "pending" },
    { index: 2, text: "Wire the motor", status: "pending" },
  ]);
});

test("parsePlan returns no steps for empty input", () => {
  assert.deepEqual(plan.parsePlan(""), { steps: [] });
  assert.deepEqual(plan.parsePlan("   \n\n  "), { steps: [] });
  assert.deepEqual(plan.parsePlan("Just a title"), { steps: [] });
});

test("savePlan and loadPlan roundtrip under the plan key", () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ other: 1 }));
  const steps = plan.parsePlan("1. Sketch the frame\n2. Wire the motor").steps;
  plan.savePlan(file, { goal: "Build the widget", steps });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.other, 1);
  assert.equal(raw.plan.goal, "Build the widget");
  const loaded = plan.loadPlan(file);
  assert.equal(loaded.goal, "Build the widget");
  assert.deepEqual(loaded.steps, steps);
  assert.equal(plan.currentStep(loaded).text, "Sketch the frame");
});

test("advance walks two steps then marks the plan done", () => {
  const file = tempFile();
  const steps = plan.parsePlan("1. Sketch the frame\n2. Wire the motor").steps;
  plan.savePlan(file, { goal: "Build the widget", steps });

  const second = plan.advance(file);
  assert.equal(second.text, "Wire the motor");
  assert.equal(second.status, "pending");
  const mid = plan.loadPlan(file);
  assert.equal(mid.steps[0].status, "done");
  assert.equal(mid.steps[1].status, "pending");
  assert.equal(mid.status, "active");

  assert.equal(plan.advance(file), null);
  const done = plan.loadPlan(file);
  assert.equal(done.status, "done");
  assert.equal(done.steps.every((step) => step.status === "done"), true);
  assert.equal(plan.currentStep(done), null);
  assert.equal(plan.advance(file), null);
});

test("empty plan has no current step and advance finishes it", () => {
  const file = tempFile();
  plan.savePlan(file, { goal: "Nothing", steps: [] });
  const loaded = plan.loadPlan(file);
  assert.deepEqual(loaded.steps, []);
  assert.equal(plan.currentStep(loaded), null);
  assert.equal(plan.advance(file), null);
  assert.equal(plan.loadPlan(file).status, "done");
  assert.equal(plan.currentStep(plan.loadPlan("/no/such/plan.json")), null);
});

test("kickoffLine states he is starting the step without asking", () => {
  const line = plan.kickoffLine({ index: 1, text: "Sketch the frame", status: "pending" });
  assert.equal(line.includes("?"), false);
  assert.match(line, /Sketch the frame/);
  assert.match(line, /start/i);
  assert.doesNotMatch(line, /want me to/i);
});
