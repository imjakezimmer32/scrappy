const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const maintenance = require("../maintenance");
const appUpdate = require("../app-update");

test("shouldOpenSetupIntro only when not configured and not yet introduced", () => {
  const prefs = { setupIntroduced: false };
  assert.equal(maintenance.shouldOpenSetupIntro(prefs, false), true);
  assert.equal(maintenance.shouldOpenSetupIntro(prefs, true), false);
  maintenance.markSetupIntroduced(prefs);
  assert.equal(maintenance.shouldOpenSetupIntro(prefs, false), false);
});

test("pending update valid only when file exists", () => {
  const prefs = { pendingUpdate: { version: "9.9.9", path: path.join(__dirname, "app-update.test.js") } };
  assert.equal(maintenance.pendingUpdateValid(prefs), true);
  prefs.pendingUpdate.path = "/no/such/file.exe";
  assert.equal(maintenance.pendingUpdateValid(prefs), false);
});

test("summarizePendingForTray ignores stale or same version", () => {
  const prefs = {
    pendingUpdate: {
      version: "9.9.9",
      path: path.join(__dirname, "app-update.test.js"),
    },
  };
  const row = maintenance.summarizePendingForTray(prefs, "1.0.0");
  assert.equal(row.version, "9.9.9");
  assert.equal(maintenance.summarizePendingForTray(prefs, "9.9.9"), null);
});

test("good time to update waits out work and a quiet stretch", () => {
  const base = {
    hasPending: true,
    alerting: false,
    chatOpen: false,
    voiceActive: false,
    cursorHeld: false,
    quietForMs: 120000,
  };
  assert.equal(maintenance.goodTimeToApplyUpdate(base), true);
  assert.equal(maintenance.goodTimeToApplyUpdate({ ...base, hasPending: false }), false);
  assert.equal(maintenance.goodTimeToApplyUpdate({ ...base, alerting: true }), false);
  assert.equal(maintenance.goodTimeToApplyUpdate({ ...base, chatOpen: true }), false);
  assert.equal(maintenance.goodTimeToApplyUpdate({ ...base, voiceActive: true }), false);
  assert.equal(maintenance.goodTimeToApplyUpdate({ ...base, cursorHeld: true }), false);
  assert.equal(maintenance.goodTimeToApplyUpdate({ ...base, quietForMs: 10000 }), false);
});

test("isNewer used for pending tray label", () => {
  assert.equal(appUpdate.isNewer("1.2.0", "1.1.0"), true);
});
