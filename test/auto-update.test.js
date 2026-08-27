const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("path");

const autoUpdate = require("../auto-update");

test("conversation includes voice session, typed chat, and setup", () => {
  assert.equal(autoUpdate.inConversation({}), false);
  assert.equal(autoUpdate.inConversation({ conversationId: "s1" }), true);
  assert.equal(autoUpdate.inConversation({ chatFocused: true }), true);
  assert.equal(autoUpdate.inConversation({ setupOpen: true }), true);
});

test("inspectGit refuses a dirty tree and a non-main branch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrappy-git-"));
  fs.mkdirSync(path.join(dir, ".git"));
  const exec = (_cmd, args, _opts, cb) => {
    const key = args.join(" ");
    let stdout = "";
    if (key === "rev-parse --abbrev-ref HEAD") stdout = "cursor/something";
    cb(null, stdout, "");
  };
  const info = await autoUpdate.inspectGit(dir, exec);
  assert.equal(info.updatable, false);
  assert.equal(info.reason, "not_main");
});

test("inspectGit wants a fast-forward of origin/main", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrappy-git-"));
  fs.mkdirSync(path.join(dir, ".git"));
  const exec = (_cmd, args, _opts, cb) => {
    const key = args.join(" ");
    const out = {
      "rev-parse --abbrev-ref HEAD": "main",
      "status --porcelain": "",
      "fetch origin main": "",
      "rev-parse HEAD": "aaa",
      "rev-parse origin/main": "bbb",
      "merge-base HEAD origin/main": "aaa",
    };
    cb(null, out[key] ?? "", "");
  };
  const info = await autoUpdate.inspectGit(dir, exec);
  assert.equal(info.updatable, true);
  assert.equal(info.from, "aaa");
  assert.equal(info.to, "bbb");
});

test("inspectGit skips when already current", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrappy-git-"));
  fs.mkdirSync(path.join(dir, ".git"));
  const exec = (_cmd, args, _opts, cb) => {
    const key = args.join(" ");
    const out = {
      "rev-parse --abbrev-ref HEAD": "main",
      "status --porcelain": "",
      "fetch origin main": "",
      "rev-parse HEAD": "aaa",
      "rev-parse origin/main": "aaa",
    };
    cb(null, out[key] ?? "", "");
  };
  const info = await autoUpdate.inspectGit(dir, exec);
  assert.equal(info.updatable, false);
  assert.equal(info.reason, "current");
});

test("inspectGit skips a dirty working tree", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scrappy-git-"));
  fs.mkdirSync(path.join(dir, ".git"));
  const exec = (_cmd, args, _opts, cb) => {
    const key = args.join(" ");
    const out = {
      "rev-parse --abbrev-ref HEAD": "main",
      "status --porcelain": " M main.js",
    };
    cb(null, out[key] ?? "", "");
  };
  const info = await autoUpdate.inspectGit(dir, exec);
  assert.equal(info.updatable, false);
  assert.equal(info.reason, "dirty");
});

test("main waits for idle before applying an update", () => {
  const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.match(main, /require\("\.\/auto-update"\)/);
  assert.match(main, /function conversationBusy/);
  assert.match(main, /scheduleApplyIfIdle/);
  assert.match(main, /quitAndInstall/);
  assert.match(main, /app\.relaunch/);
});
