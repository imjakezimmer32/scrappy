const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const files = [
  "renderer/scrappy.js",
  "local-voice/listening-dictionary.json",
  "local-voice/dictionary.py",
  "docs/listening-dictionary.md",
];

test("shipped copy has no personal project names or billing dates", () => {
  for (const file of files) {
    const text = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.ok(!text.includes("ArrayBud"), `${file} still mentions ArrayBud`);
    assert.ok(!text.includes("90k"), `${file} still mentions a personal quota`);
    assert.ok(!/Aug 17/.test(text), `${file} still mentions a personal reset date`);
  }
});
