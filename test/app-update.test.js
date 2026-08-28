const { test } = require("node:test");
const assert = require("node:assert/strict");
const upd = require("../app-update");

test("isNewer compares dotted versions and ignores a v prefix", () => {
  assert.equal(upd.isNewer("1.1.0", "1.0.0"), true);
  assert.equal(upd.isNewer("v1.1.0", "1.1.0"), false);
  assert.equal(upd.isNewer("1.0.0", "1.1.0"), false);
  assert.equal(upd.isNewer("1.0.10", "1.0.9"), true);
});

test("pickInstaller prefers Scrappy-Setup-*.exe and skips blockmaps", () => {
  const asset = upd.pickInstaller([
    { name: "latest.yml" },
    { name: "Scrappy-Setup-1.1.0.exe.blockmap" },
    { name: "Scrappy-Setup-1.1.0.exe", browser_download_url: "https://example/setup.exe" },
  ]);
  assert.equal(asset.name, "Scrappy-Setup-1.1.0.exe");
});

test("summarizeRelease reports when he is behind", () => {
  const out = upd.summarizeRelease(
    {
      tag_name: "v1.1.0",
      html_url: "https://github.com/imjakezimmer32/scrappy/releases/tag/v1.1.0",
      assets: [{ name: "Scrappy-Setup-1.1.0.exe", browser_download_url: "https://example/setup.exe" }],
    },
    "1.0.0"
  );
  assert.equal(out.ok, true);
  assert.equal(out.newer, true);
  assert.equal(out.latest, "1.1.0");
  assert.equal(out.downloadUrl, "https://example/setup.exe");
});

test("summarizeRelease reports current when the tag matches", () => {
  const out = upd.summarizeRelease({ tag_name: "v1.1.0", assets: [] }, "1.1.0");
  assert.equal(out.ok, true);
  assert.equal(out.newer, false);
});

test("missing release is a soft miss", () => {
  const out = upd.summarizeRelease({ message: "Not Found" }, "1.1.0");
  assert.equal(out.ok, false);
  assert.equal(out.error, "no_release");
});
