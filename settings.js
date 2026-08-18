// Scrappy's settings. One place that answers "what is this configured to?", so
// the tray, the setup panel and the local voice server can't disagree.
//
// Precedence, highest first:
//   1. process.env    — an explicit environment variable always wins, so you can
//                       still override anything for one run without touching UI
//   2. the store      — what the setup panel writes (userData, secrets encrypted)
//   3. .env.local     — the old hand-edited file, still honoured so nobody's
//                       existing setup breaks
//   4. built-in default
//
// Only the store is ever written. .env.local is read-only from here on: two
// writers on one file is how you lose a key you pasted thirty seconds ago.

const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Keys held back from the renderer and encrypted on disk. Everything else is
// plain config and can be shown in the panel.
const SECRET_KEYS = new Set([
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "SCRAPPY_LLM_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_SDK_API_KEY",
]);

const DEFAULTS = {
  SCRAPPY_USER_NAME: "",
  VOICE_BACKEND: "auto",
  SCRAPPY_LLM_BACKEND: "cloud",
  SCRAPPY_LLM_MODEL: "gpt-4o",
  OLLAMA_MODEL: "qwen2.5:7b",
  OLLAMA_THINK_MODEL: "deepseek-r1:14b",
  OLLAMA_THINK_MODE: "auto",
  SCRAPPY_WAKE_WORD: "on",
  SCRAPPY_TTS_VOICE: "am_michael",
  WHISPER_MODEL: "large-v3",
  WHISPER_COMPUTE: "int8_float32",
  WHISPER_BEAM: "8",
  SCRAPPY_VAD_SILENCE_MS: "1300",
  SCRAPPY_VAD_ENERGY: "0.008",
  SCRAPPY_TOOL_ROUNDS: "6",
  RECALL_EXE: "",
};

const ENV_FILE = path.join(__dirname, ".env.local");

let cache = null;
let envFileCache = null;
let envFileStamp = 0;

function storePath() {
  // Not in the project folder. Config that follows the user, not the checkout.
  return path.join(app.getPath("userData"), "settings.json");
}

function emptyStore() {
  return { values: {}, secrets: {} };
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(storePath(), "utf8");
    const parsed = JSON.parse(raw);
    cache = {
      values: parsed.values && typeof parsed.values === "object" ? parsed.values : {},
      secrets: parsed.secrets && typeof parsed.secrets === "object" ? parsed.secrets : {},
    };
  } catch {
    // Missing or corrupt: start clean rather than refusing to boot.
    cache = emptyStore();
  }
  return cache;
}

function save() {
  const store = load();
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("Could not write settings:", err.message);
    return false;
  }
}

// The legacy file. Re-read when it changes on disk so hand edits still land
// without a restart, but cached so the accessors aren't hitting the filesystem
// dozens of times while a menu is being built.
function readEnvFile() {
  let stamp = 0;
  try {
    stamp = fs.statSync(ENV_FILE).mtimeMs;
  } catch {
    envFileCache = {};
    return envFileCache;
  }
  if (envFileCache && stamp === envFileStamp) return envFileCache;

  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  } catch (err) {
    console.error("Could not read .env.local:", err.message);
  }
  envFileCache = out;
  envFileStamp = stamp;
  return out;
}

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function readSecret(key) {
  const store = load();
  const entry = store.secrets[key];
  if (!entry) return "";
  if (typeof entry === "string") {
    // Written before encryption was available on this machine.
    return entry;
  }
  if (entry.cipher) {
    try {
      return safeStorage.decryptString(Buffer.from(entry.cipher, "base64"));
    } catch {
      // Usually means a different machine or a reset credential store. The key
      // is unrecoverable — treat it as absent so the panel asks again.
      return "";
    }
  }
  return "";
}

function writeSecret(key, value) {
  const store = load();
  if (!value) {
    delete store.secrets[key];
    return save();
  }
  if (encryptionAvailable()) {
    store.secrets[key] = { cipher: safeStorage.encryptString(value).toString("base64") };
  } else {
    // No credential store to lean on. Still better than the project folder,
    // and the panel warns about it.
    store.secrets[key] = value;
  }
  return save();
}

// ---------- the accessors ----------

function get(key, fallback) {
  if (process.env[key]) return process.env[key];

  const store = load();
  if (SECRET_KEYS.has(key)) {
    const secret = readSecret(key);
    if (secret) return secret;
  } else if (store.values[key] !== undefined && store.values[key] !== "") {
    return store.values[key];
  }

  const file = readEnvFile();
  if (file[key]) return file[key];

  if (fallback !== undefined) return fallback;
  return DEFAULTS[key] !== undefined ? DEFAULTS[key] : "";
}

function getLower(key, fallback) {
  return String(get(key, fallback) || "").toLowerCase();
}

function getBool(key, fallback = true) {
  const raw = getLower(key, fallback ? "on" : "off");
  return !(raw === "off" || raw === "false" || raw === "0" || raw === "no");
}

function set(key, value) {
  const store = load();
  const text = value === null || value === undefined ? "" : String(value);
  if (SECRET_KEYS.has(key)) return writeSecret(key, text);
  if (text === "") delete store.values[key];
  else store.values[key] = text;
  // Keep the running process in step; child processes inherit from here.
  if (text === "") delete process.env[key];
  else process.env[key] = text;
  return save();
}

function setMany(patch) {
  let ok = true;
  for (const [key, value] of Object.entries(patch || {})) {
    if (!set(key, value)) ok = false;
  }
  return ok;
}

function isSet(key) {
  return Boolean(get(key, ""));
}

// Where a value is actually coming from — the panel shows this so nobody spends
// an afternoon wondering why the box they typed in isn't winning.
function sourceOf(key) {
  if (process.env[key]) return "environment";
  const store = load();
  if (SECRET_KEYS.has(key) ? readSecret(key) : store.values[key]) return "settings";
  if (readEnvFile()[key]) return ".env.local";
  return "default";
}

// ---------- who he's talking to ----------

function userName() {
  const chosen = get("SCRAPPY_USER_NAME", "");
  if (chosen) return chosen;
  // Nobody has told him a name yet. The OS knows one, and it beats calling
  // everybody by the name of the person who wrote him.
  try {
    const raw = os.userInfo().username || "";
    const first = raw.split(/[.\-_\\ ]/)[0];
    if (first) return first.charAt(0).toUpperCase() + first.slice(1);
  } catch {
    // fall through
  }
  return "you";
}

// ---------- what the panel is allowed to see ----------
// Secrets go back as a boolean, never as text. The panel needs to know a key is
// present so it can say so; it does not need the key.

function forPanel() {
  const out = { values: {}, secrets: {}, sources: {}, encryptionAvailable: encryptionAvailable() };
  const keys = new Set([...Object.keys(DEFAULTS), ...SECRET_KEYS, ...Object.keys(load().values)]);
  for (const key of keys) {
    if (SECRET_KEYS.has(key)) out.secrets[key] = isSet(key);
    else out.values[key] = get(key);
    out.sources[key] = sourceOf(key);
  }
  out.userName = userName();
  return out;
}

// True once he can actually hold a conversation — used to decide whether to
// nudge someone through setup on first run.
function isConfigured() {
  const voice = getLower("VOICE_BACKEND");
  const hasEleven = isSet("ELEVENLABS_API_KEY");
  const hasCloudBrain =
    isSet("OPENAI_API_KEY") || isSet("GROQ_API_KEY") || isSet("SCRAPPY_LLM_API_KEY");
  if (voice === "elevenlabs") return hasEleven;
  if (voice === "local") return true; // the local stack has its own installer
  return hasEleven || hasCloudBrain;
}

function reload() {
  cache = null;
  envFileCache = null;
  envFileStamp = 0;
}

module.exports = {
  SECRET_KEYS,
  DEFAULTS,
  get,
  getLower,
  getBool,
  set,
  setMany,
  isSet,
  sourceOf,
  userName,
  forPanel,
  isConfigured,
  encryptionAvailable,
  readEnvFile,
  reload,
  storePath,
};
