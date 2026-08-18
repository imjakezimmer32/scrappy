const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const recall = require("../recall-mcp");
const root = path.join(__dirname, "..");

test("Recall candidates never include a specific Windows user folder", () => {
  const home = path.join("C:", "Users", "Ada");
  const env = {
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  };
  const candidates = recall.candidatePaths(env, home);
  assert.ok(candidates.length > 0);
  for (const p of candidates) {
    assert.ok(!/\\Users\\hella\\/i.test(p), `still points at hella: ${p}`);
    assert.ok(p.toLowerCase().endsWith("recall.exe"));
  }
  assert.ok(candidates.some((p) => p.includes("Program Files")));
  assert.ok(candidates.some((p) => p.includes(home)));
});

test("exePath honors RECALL_EXE when the file exists", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scrappy-recall-"));
  const exe = path.join(tmp, "recall.exe");
  fs.writeFileSync(exe, "");
  assert.equal(recall.exePath(null, { RECALL_EXE: exe, PATH: "" }), exe);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the repo does not hardcode C:\\Users\\hella paths", () => {
  const files = [
    "recall-mcp.js",
    "scripts/setup-local-voice.ps1",
    "main.js",
    "settings.js",
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.ok(!/Users\\hella/i.test(text), `${file} still has a hella path`);
    assert.ok(!/Users\/hella/i.test(text), `${file} still has a hella path`);
  }
});
