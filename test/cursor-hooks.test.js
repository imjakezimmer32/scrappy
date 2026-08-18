const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const hooks = require("../cursor-hooks");

test("mergeHooks keeps a stranger's hooks and adds Scrappy's", () => {
  const merged = hooks.mergeHooks({
    version: 1,
    hooks: {
      stop: [{ command: "other-tool" }],
      sessionStart: [],
    },
  });
  assert.equal(merged.hooks.stop.length, 2);
  assert.equal(merged.hooks.stop[0].command, "other-tool");
  assert.match(merged.hooks.stop[1].command, /scrappy-agent-done/);
  assert.match(merged.hooks.sessionStart[0].command, /scrappy-session-start/);
});

test("install writes hook scripts and a token without needing npm", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scrappy-hooks-"));
  const result = hooks.install({
    token: "abc123",
    home,
    scriptsDir: path.join(__dirname, "..", "scripts"),
  });
  assert.equal(result.ok, true);
  const dir = hooks.hooksDir(home);
  assert.ok(fs.existsSync(path.join(dir, "scrappy-agent-done.ps1")));
  assert.ok(fs.existsSync(path.join(dir, "scrappy-session-start.ps1")));
  assert.equal(fs.readFileSync(path.join(dir, "scrappy-token.txt"), "utf8"), "abc123");
  const json = JSON.parse(fs.readFileSync(hooks.hooksJsonPath(home), "utf8"));
  assert.match(json.hooks.stop[0].command, /scrappy-agent-done/);
  fs.rmSync(home, { recursive: true, force: true });
});
