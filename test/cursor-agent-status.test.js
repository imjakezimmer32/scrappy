const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveEffectiveStatus,
  mapSdkRunStatus,
  isRegistryStale,
  terminalRunStatus,
  friendlyStatus,
  formatDurationMs,
  waitWithTimeout,
} = require("../cursor-agent-status");

test("mapSdkRunStatus normalizes SDK values", () => {
  assert.equal(mapSdkRunStatus("completed"), "finished");
  assert.equal(mapSdkRunStatus("failed"), "error");
  assert.equal(mapSdkRunStatus("running"), "running");
});

test("resolveEffectiveStatus uses latest run when not running", () => {
  const out = resolveEffectiveStatus({
    held: false,
    recentRuns: [{ status: "completed" }, { status: "error" }],
    registryStatus: "running",
    registryUpdatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    staleMs: 15 * 60 * 1000,
  });
  assert.equal(out.isRunning, false);
  assert.equal(out.isStale, true);
  assert.equal(out.effectiveStatus, "finished");
});

test("resolveEffectiveStatus trusts registry when fresh", () => {
  const out = resolveEffectiveStatus({
    held: false,
    recentRuns: [{ status: "completed" }],
    registryStatus: "running",
    registryUpdatedAt: new Date().toISOString(),
    staleMs: 15 * 60 * 1000,
  });
  assert.equal(out.isRunning, true);
  assert.equal(out.effectiveStatus, "running");
});

test("resolveEffectiveStatus prefers live running run", () => {
  const out = resolveEffectiveStatus({
    held: false,
    recentRuns: [{ status: "running" }],
    registryStatus: "finished",
  });
  assert.equal(out.isRunning, true);
  assert.equal(out.effectiveStatus, "running");
});

test("isRegistryStale respects threshold", () => {
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  assert.equal(isRegistryStale(fresh, 60_000), false);
  assert.equal(isRegistryStale(old, 60_000), true);
});

test("terminalRunStatus handles timeout", () => {
  assert.equal(terminalRunStatus({ status: "error" }), "error");
  assert.equal(terminalRunStatus({ status: "cancelled" }), "cancelled");
  assert.equal(terminalRunStatus({ status: "ok" }), "finished");
  assert.equal(terminalRunStatus(null, true), "timeout");
});

test("friendlyStatus covers timeout and stale", () => {
  assert.equal(friendlyStatus("timeout", false), "Timed out");
  assert.equal(friendlyStatus("stale", false), "Probably stopped");
  assert.equal(friendlyStatus("running", true), "Working");
});

test("formatDurationMs renders human durations", () => {
  assert.equal(formatDurationMs(45_000), "45s");
  assert.equal(formatDurationMs(125_000), "2m 5s");
});

test("waitWithTimeout returns when run finishes first", async () => {
  const run = {
    status: "running",
    wait: async () => ({ status: "completed", result: "ok" }),
    cancel: async () => {},
  };
  const out = await waitWithTimeout(run, 500);
  assert.equal(out.timedOut, false);
  assert.equal(out.result.result, "ok");
});

test("waitWithTimeout cancels on timeout", async () => {
  let cancelled = false;
  const run = {
    status: "running",
    wait: () => new Promise(() => {}),
    cancel: async () => {
      cancelled = true;
    },
  };
  const out = await waitWithTimeout(run, 30);
  assert.equal(out.timedOut, true);
  assert.equal(out.result.status, "timeout");
  assert.equal(cancelled, true);
});
