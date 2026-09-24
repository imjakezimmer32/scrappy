// One owner per goal. A second agent is refused unless the owner is stuck.

const store = require("./store");

function enqueue(filePath, { goal, ownerId }) {
  const text = String(goal || "").trim();
  const owner = String(ownerId || "").trim();
  if (!text || !owner) return { ok: false, error: "missing" };
  let result = { ok: false };
  store.update(filePath, (doc) => {
    const base = doc && typeof doc === "object" ? doc : {};
    const queue = Array.isArray(base.queue) ? base.queue : [];
    const existing = queue.find((row) => row.goal === text && row.status === "open");
    if (existing && existing.ownerId !== owner && existing.status !== "stuck") {
      result = { ok: false, error: "owned", ownerId: existing.ownerId };
      return base;
    }
    if (existing) {
      existing.ownerId = owner;
      existing.updatedAt = new Date().toISOString();
      result = { ok: true, row: existing };
      return { ...base, queue };
    }
    const row = {
      goal: text,
      ownerId: owner,
      status: "open",
      updatedAt: new Date().toISOString(),
    };
    queue.unshift(row);
    result = { ok: true, row };
    return { ...base, queue: queue.slice(0, 40) };
  });
  return result;
}

function markStuck(filePath, goal) {
  const text = String(goal || "").trim();
  store.update(filePath, (doc) => {
    const base = doc && typeof doc === "object" ? doc : {};
    const queue = Array.isArray(base.queue) ? base.queue : [];
    queue.forEach((row) => {
      if (row.goal === text && row.status === "open") row.status = "stuck";
    });
    return { ...base, queue };
  });
}

function onIdle(filePath, ownerId) {
  const owner = String(ownerId || "").trim();
  const doc = store.read(filePath);
  const queue = Array.isArray(doc.queue) ? doc.queue : [];
  return queue.find((row) => row.ownerId === owner && (row.status === "open" || row.status === "stuck")) || null;
}

module.exports = { enqueue, markStuck, onIdle };
