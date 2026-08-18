const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const voice = path.join(root, "local-voice");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("the listening dictionary does not ship a hardcoded owner name", () => {
  const dict = JSON.parse(read("local-voice/listening-dictionary.json"));
  const vocab = (dict.vocabulary || []).map((w) => String(w).toLowerCase());
  assert.ok(!vocab.includes("jake"), "vocabulary still lists Jake");
});

test("local voice prompts do not hardcode Jake", () => {
  const files = [
    "local-voice/server.py",
    "local-voice/tools_schema.py",
    "local-voice/dictionary.py",
    "local-voice/intent_gate.py",
    "local-voice/llm.py",
    "local-voice/jobs.py",
  ];
  for (const file of files) {
    const text = read(file);
    assert.ok(
      !/\bJake\b/.test(text),
      `${file} still mentions Jake — use owner.name() from the setup panel`
    );
  }
});

test("Electron hands the setup-panel name to the local voice process", () => {
  const main = read("main.js");
  assert.match(main, /SCRAPPY_USER_NAME:\s*settings\.userName\(\)/);
});

test("owner.py reads SCRAPPY_USER_NAME and has a safe fallback", () => {
  const src = fs.readFileSync(path.join(voice, "owner.py"), "utf8");
  assert.match(src, /SCRAPPY_USER_NAME/);
  assert.match(src, /the user/);
});
