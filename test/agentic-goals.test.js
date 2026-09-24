const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const goals = require("../agentic/goals");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrappy-goals-"));
  return path.join(dir, "state.json");
}

test("setGoal persists an open goal and getGoal returns it", () => {
  const file = tempFile();
  assert.equal(goals.getGoal(file), null);

  const goal = goals.setGoal(file, { text: "  oil the gears  ", source: "chat" });
  assert.equal(typeof goal.id, "string");
  assert.ok(goal.id.length > 0);
  assert.equal(goal.text, "oil the gears");
  assert.equal(goal.source, "chat");
  assert.equal(goal.status, "open");
  assert.equal(goal.createdAt, goal.updatedAt);
  assert.ok(!Number.isNaN(Date.parse(goal.updatedAt)));

  assert.deepEqual(goals.getGoal(file), goal);
});

test("replacing setGoal completes the previous open goal", () => {
  const file = tempFile();
  const first = goals.setGoal(file, { text: "tighten the bolt", source: "chat" });
  const second = goals.setGoal(file, { text: "paint the panel", source: "wake" });

  assert.deepEqual(goals.getGoal(file), second);

  const recent = goals.listRecent(file, 10);
  assert.equal(recent[0].id, second.id);
  assert.equal(recent[0].status, "open");
  const previous = recent.find((goal) => goal.id === first.id);
  assert.ok(previous);
  assert.equal(previous.status, "done");
  assert.ok(previous.updatedAt >= first.updatedAt);
});

test("completeGoal marks the open goal done", () => {
  const file = tempFile();
  const goal = goals.setGoal(file, { text: "sweep the bench", source: "chat" });

  const done = goals.completeGoal(file);
  assert.equal(done.id, goal.id);
  assert.equal(done.status, "done");
  assert.equal(done.text, "sweep the bench");
  assert.equal(goals.getGoal(file), null);
  assert.equal(goals.completeGoal(file), null);

  const recent = goals.listRecent(file, 5);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].status, "done");
  assert.equal(recent[0].id, goal.id);
});

test("resumeLine is null without a goal and names the open task", () => {
  assert.equal(goals.resumeLine(null), null);
  assert.equal(goals.resumeLine(undefined), null);
  assert.equal(goals.resumeLine({ text: "   " }), null);
  assert.equal(goals.resumeLine({ text: "done already", status: "done" }), null);

  const line = goals.resumeLine({
    text: "fix the latch?",
    status: "open",
    source: "chat",
  });
  assert.equal(line, "Still on: fix the latch.");
  assert.equal(line.includes("?"), false);
  assert.equal(/want me to/i.test(line), false);
});

test("listRecent is newest first, includes done goals, and caps at 20", () => {
  const file = tempFile();
  for (let i = 1; i <= 21; i++) {
    goals.setGoal(file, { text: `task ${i}`, source: "test" });
  }

  const recent = goals.listRecent(file, 20);
  assert.equal(recent.length, 20);
  assert.equal(recent[0].text, "task 21");
  assert.equal(recent[0].status, "open");
  assert.equal(recent[19].text, "task 2");
  for (const goal of recent.slice(1)) {
    assert.equal(goal.status, "done");
  }

  assert.equal(goals.getGoal(file).text, "task 21");
  assert.equal(goals.listRecent(file, 100).length, 20);

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.goals.length, 20);
  assert.ok(onDisk.goals.every((goal) => goal.text !== "task 1"));
});
