const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// settings.js needs Electron's app + safeStorage. Stub both so this runs under
// plain node, with a throwaway userData directory per run.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scrappy-settings-"));

const electronStub = {
  app: { getPath: () => tmp },
  safeStorage: {
    isEncryptionAvailable: () => true,
    // Not real crypto — just something reversible that is obviously not the
    // plaintext, so the "don't write keys in the clear" test means something.
    encryptString: (s) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b) => b.toString("utf8").replace(/^enc:/, ""),
  },
};

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return "electron-stub";
  return resolve.call(this, request, ...rest);
};
require.cache["electron-stub"] = {
  id: "electron-stub",
  filename: "electron-stub",
  loaded: true,
  exports: electronStub,
};

const settings = require("../settings");

test("falls back to the built-in default", () => {
  assert.equal(settings.get("OLLAMA_MODEL"), "qwen2.5:7b");
  assert.equal(settings.sourceOf("OLLAMA_MODEL"), "default");
});

test("the store beats the default", () => {
  settings.set("OLLAMA_MODEL", "gemma2:9b");
  assert.equal(settings.get("OLLAMA_MODEL"), "gemma2:9b");
});

test("an explicit environment variable beats the store", () => {
  settings.set("SCRAPPY_LLM_MODEL", "from-store");
  process.env.SCRAPPY_LLM_MODEL = "from-env";
  assert.equal(settings.get("SCRAPPY_LLM_MODEL"), "from-env");
  assert.equal(settings.sourceOf("SCRAPPY_LLM_MODEL"), "environment");
  delete process.env.SCRAPPY_LLM_MODEL;
  // With the override gone the stored value is back in charge.
  assert.equal(settings.get("SCRAPPY_LLM_MODEL"), "from-store");
});

test("secrets round-trip but are never written in the clear", () => {
  settings.set("ELEVENLABS_API_KEY", "sk-super-secret");
  assert.equal(settings.get("ELEVENLABS_API_KEY"), "sk-super-secret");
  assert.equal(settings.isSet("ELEVENLABS_API_KEY"), true);

  const onDisk = fs.readFileSync(settings.storePath(), "utf8");
  assert.ok(!onDisk.includes("sk-super-secret"), "raw key must not appear in settings.json");
});

test("a secret can be removed", () => {
  settings.set("GROQ_API_KEY", "gsk-throwaway");
  assert.equal(settings.isSet("GROQ_API_KEY"), true);
  settings.set("GROQ_API_KEY", "");
  assert.equal(settings.isSet("GROQ_API_KEY"), false);
});

test("forPanel reports secrets as booleans, never as text", () => {
  settings.set("OPENAI_API_KEY", "sk-do-not-leak");
  const state = settings.forPanel();
  assert.equal(state.secrets.OPENAI_API_KEY, true);
  assert.ok(!JSON.stringify(state).includes("sk-do-not-leak"), "forPanel leaked a key");
});

test("userName prefers the configured name over the OS account", () => {
  settings.set("SCRAPPY_USER_NAME", "Ada");
  assert.equal(settings.userName(), "Ada");
  settings.set("SCRAPPY_USER_NAME", "");
  // Falls back to something, and never to the name of whoever wrote him.
  const fallback = settings.userName();
  assert.ok(fallback.length > 0);
  assert.notEqual(fallback.toLowerCase(), "jake");
});

test("isConfigured tracks whether he can actually hold a conversation", () => {
  settings.set("ELEVENLABS_API_KEY", "");
  settings.set("OPENAI_API_KEY", "");
  settings.set("GROQ_API_KEY", "");
  settings.set("SCRAPPY_LLM_API_KEY", "");
  settings.set("VOICE_BACKEND", "elevenlabs");
  assert.equal(settings.isConfigured(), false);

  settings.set("ELEVENLABS_API_KEY", "sk-present");
  assert.equal(settings.isConfigured(), true);

  // The local stack brings its own brain, so it counts as configured.
  settings.set("ELEVENLABS_API_KEY", "");
  settings.set("VOICE_BACKEND", "local");
  assert.equal(settings.isConfigured(), true);
});
