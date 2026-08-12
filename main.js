const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, session, shell } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const systemInfo = require("./system-info");
const recall = require("./recall-mcp");
const cursorAgents = require("./cursor-agents");
const cursorChats = require("./cursor-chats");
const wakeListener = require("./wake-listener");
const localVoice = require("./local-voice-launcher");
const processJournal = require("./process-journal");
const conversationStore = require("./conversation-store");

const PORT = 8787;
const HOST = "127.0.0.1";
const TOKEN_PATH = path.join(app.getPath("userData"), "local-token.txt");

let activeConversationId = null;

function minDurationMs() {
  const file = readEnvFile();
  const raw = process.env.COG_NUDGE_MIN_DURATION_MS || file.COG_NUDGE_MIN_DURATION_MS;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  return 2 * 60 * 1000;
}

let mainWindow = null;
let tray = null;
let server = null;
let alerting = false;
let localToken = null;

function ensureToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      localToken = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    }
  } catch {
    localToken = null;
  }
  if (!localToken) {
    localToken = crypto.randomBytes(24).toString("hex");
    try {
      fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
      fs.writeFileSync(TOKEN_PATH, localToken, "utf8");
    } catch (err) {
      console.error("Could not persist local token:", err);
    }
  }
  // Mirror token next to the project so the Cursor hook can find it easily.
  try {
    const hookTokenPath = path.join(__dirname, "local-token.txt");
    fs.writeFileSync(hookTokenPath, localToken, "utf8");
  } catch {
    // non-fatal
  }
  return localToken;
}

// Cog lives on a transparent, click-through overlay stretched across the
// bounding box of every display, so he can walk, be thrown, and bounce
// across all of them. Monitors rarely share a floor line, so the renderer
// also gets each display's rectangle in overlay-local coordinates and works
// out which floor is under him at any given x.
// The window spans the full physical bounds of every display — including the
// strip the taskbar sits on — so Cog's legs can hang over the edge when he
// sits down. His floor is still the work area, so he stands ON the taskbar's
// top edge rather than walking across it.
function displayLayout() {
  const displays = screen.getAllDisplays();
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const d of displays) {
    left = Math.min(left, d.bounds.x);
    top = Math.min(top, d.bounds.y);
    right = Math.max(right, d.bounds.x + d.bounds.width);
    bottom = Math.max(bottom, d.bounds.y + d.bounds.height);
  }

  return {
    union: { x: left, y: top, width: right - left, height: bottom - top },
    screens: displays.map((d) => ({
      left: d.bounds.x - left,
      right: d.bounds.x + d.bounds.width - left,
      top: d.workArea.y - top,
      // The floor he stands on: the top of the taskbar.
      bottom: d.workArea.y + d.workArea.height - top,
      // The physical bottom of the glass, for anything that hangs over.
      deck: d.bounds.y + d.bounds.height - top,
    })),
  };
}

function overlayBounds() {
  return displayLayout().union;
}

// Windows re-raises the taskbar above other topmost windows whenever you
// click it, which drops Cog behind it until something re-asserts him. There
// is no event for that, so we simply keep re-claiming the top spot. Neither
// call takes focus, so this never interrupts what you're typing into.
let topKeeper = null;

function keepOnTop() {
  if (topKeeper) return;
  topKeeper = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
    mainWindow.setAlwaysOnTop(true, "screen-saver");
    mainWindow.moveTop();
  }, 1200);
}

function pushLayout() {
  if (!mainWindow) return;
  mainWindow.setBounds(overlayBounds());
  mainWindow.webContents.send("workbuddy:layout", displayLayout().screens);
}

// ---------- voice credentials ----------
// The ElevenLabs key lives here in the main process and never crosses into
// the renderer. The renderer only ever receives a signed URL that expires.

function readEnvFile() {
  const out = {};
  const file = path.join(__dirname, ".env.local");
  try {
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch (err) {
    console.error("Could not read .env.local:", err.message);
  }
  return out;
}

function wakeWordEnabled() {
  const file = readEnvFile();
  const setting = (process.env.COG_WAKE_WORD || file.COG_WAKE_WORD || "on").toLowerCase();
  return !(setting === "off" || setting === "false" || setting === "0");
}

function voiceBackendPref() {
  const file = readEnvFile();
  return (process.env.VOICE_BACKEND || file.VOICE_BACKEND || "auto").toLowerCase();
}

function ollamaModel() {
  const file = readEnvFile();
  return process.env.OLLAMA_MODEL || file.OLLAMA_MODEL || "qwen2.5:7b";
}

function ollamaThinkModel() {
  const file = readEnvFile();
  return process.env.OLLAMA_THINK_MODEL || file.OLLAMA_THINK_MODEL || "deepseek-r1:14b";
}

function ollamaThinkMode() {
  const file = readEnvFile();
  return (process.env.OLLAMA_THINK_MODE || file.OLLAMA_THINK_MODE || "auto").toLowerCase();
}

function llmBackendPref() {
  const file = readEnvFile();
  return (process.env.COG_LLM_BACKEND || file.COG_LLM_BACKEND || "cloud").toLowerCase();
}

function llmCloudModel() {
  const file = readEnvFile();
  return process.env.COG_LLM_MODEL || file.COG_LLM_MODEL || "gpt-4o-mini";
}

function llmCloudKeyPresent() {
  const file = readEnvFile();
  return Boolean(
    process.env.COG_LLM_API_KEY ||
      file.COG_LLM_API_KEY ||
      process.env.OPENAI_API_KEY ||
      file.OPENAI_API_KEY ||
      process.env.GROQ_API_KEY ||
      file.GROQ_API_KEY
  );
}

function localVoiceEnv() {
  ensureToken();
  const file = readEnvFile();
  return {
    OLLAMA_MODEL: ollamaModel(),
    OLLAMA_THINK_MODEL: ollamaThinkModel(),
    OLLAMA_THINK_MODE: ollamaThinkMode(),
    COG_LLM_BACKEND: llmBackendPref(),
    COG_LLM_MODEL: llmCloudModel(),
    COG_LLM_THINK_MODEL:
      process.env.COG_LLM_THINK_MODEL || file.COG_LLM_THINK_MODEL || llmCloudModel(),
    COG_LLM_BASE_URL: process.env.COG_LLM_BASE_URL || file.COG_LLM_BASE_URL || "",
    COG_LLM_API_KEY: process.env.COG_LLM_API_KEY || file.COG_LLM_API_KEY || "",
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || file.OPENAI_API_KEY || "",
    GROQ_API_KEY: process.env.GROQ_API_KEY || file.GROQ_API_KEY || "",
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || file.OPENAI_BASE_URL || "",
    COG_TTS_VOICE: process.env.COG_TTS_VOICE || file.COG_TTS_VOICE || "am_michael",
    // Ears: bigger Whisper = much better hearing (medium.en default).
    WHISPER_MODEL: process.env.WHISPER_MODEL || file.WHISPER_MODEL || "medium.en",
    COG_VAD_SILENCE_MS:
      process.env.COG_VAD_SILENCE_MS || file.COG_VAD_SILENCE_MS || "950",
    COG_VAD_ENERGY: process.env.COG_VAD_ENERGY || file.COG_VAD_ENERGY || "0.008",
    COG_WHISPER_PROMPT: process.env.COG_WHISPER_PROMPT || file.COG_WHISPER_PROMPT || "",
    COG_PERSONA: path.join(__dirname, "personality.md"),
    // Local Python voice talks back to Electron for Recall tools/memory.
    WORKBUDDY_URL: `http://${HOST}:${PORT}`,
    WORKBUDDY_TOKEN: localToken || "",
  };
}

function writeEnvKey(key, value) {
  const file = path.join(__dirname, ".env.local");
  let lines = [];
  try {
    if (fs.existsSync(file)) lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    lines = [];
  }
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const next = lines.filter((line) => line.trim() && !re.test(line));
  next.push(`${key}=${value}`);
  // Avoid UTF-8 BOM so keys like ELEVENLABS_API_KEY stay readable.
  fs.writeFileSync(file, `${next.join("\n").replace(/\n*$/, "\n")}`, "utf8");
  process.env[key] = value;
}

function setLocalModel(model) {
  const name = String(model || "").trim();
  if (!name) return { ok: false, error: "empty" };
  writeEnvKey("VOICE_BACKEND", "local");
  writeEnvKey("OLLAMA_MODEL", name);
  processJournal.record({
    kind: "process",
    type: "config",
    name: "ollama-fast",
    by: "tray",
    reason: `switch fast brain -> ${name}`,
    meta: { model: name },
  });
  localVoice.stop(`switch fast brain to ${name}`, "tray");
  const started = localVoice.start(localVoiceEnv(), {
    by: "tray",
    reason: `restart after fast brain -> ${name}`,
  });
  rebuildTray();
  return started.ok ? { ok: true, model: name } : { ok: false, error: started.error || "local_voice_failed" };
}

function setThinkModel(model) {
  const name = String(model || "").trim();
  if (!name) return { ok: false, error: "empty" };
  writeEnvKey("OLLAMA_THINK_MODEL", name);
  processJournal.record({
    kind: "process",
    type: "config",
    name: "ollama-think",
    by: "tray",
    reason: `switch think brain -> ${name}`,
    meta: { model: name },
  });
  localVoice.stop(`switch think brain to ${name}`, "tray");
  const started = localVoice.start(localVoiceEnv(), {
    by: "tray",
    reason: `restart after think brain -> ${name}`,
  });
  rebuildTray();
  return started.ok ? { ok: true, model: name } : { ok: false, error: started.error || "local_voice_failed" };
}

function setLlmBackend(mode) {
  const value = String(mode || "cloud").toLowerCase();
  writeEnvKey("COG_LLM_BACKEND", value);
  if (value === "ollama" || value === "local") {
    writeEnvKey("OLLAMA_MODEL", ollamaModel() === "qwen2.5:14b" ? "qwen2.5:7b" : ollamaModel());
  }
  processJournal.record({
    kind: "process",
    type: "config",
    name: "llm-backend",
    by: "tray",
    reason: `llm backend -> ${value}`,
  });
  localVoice.stop(`switch llm backend to ${value}`, "tray");
  const started = localVoice.start(localVoiceEnv(), {
    by: "tray",
    reason: `restart after llm backend -> ${value}`,
  });
  rebuildTray();
  return started.ok ? { ok: true, backend: value } : { ok: false, error: started.error || "local_voice_failed" };
}

function setThinkMode(mode) {
  const value = String(mode || "auto").toLowerCase();
  writeEnvKey("OLLAMA_THINK_MODE", value);
  processJournal.record({
    kind: "process",
    type: "config",
    name: "think-mode",
    by: "tray",
    reason: `think mode -> ${value}`,
  });
  localVoice.stop(`switch think mode to ${value}`, "tray");
  const started = localVoice.start(localVoiceEnv(), {
    by: "tray",
    reason: `restart after think mode -> ${value}`,
  });
  rebuildTray();
  return started.ok ? { ok: true, mode: value } : { ok: false, error: started.error || "local_voice_failed" };
}

const LOCAL_MODEL_CHOICES = [
  { label: "Qwen 2.5 14B (best character)", id: "qwen2.5:14b" },
  { label: "Qwen 2.5 7B (faster, flatter)", id: "qwen2.5:7b" },
  { label: "Gemma 2 9B (natural chat)", id: "gemma2:9b" },
];

const THINK_MODEL_CHOICES = [
  { label: "DeepSeek R1 14B", id: "deepseek-r1:14b" },
  { label: "Qwen3 14B", id: "qwen3:14b" },
  { label: "DeepSeek R1 32B", id: "deepseek-r1:32b" },
];


function voiceConfig() {
  const file = readEnvFile();
  return {
    apiKey: process.env.ELEVENLABS_API_KEY || file.ELEVENLABS_API_KEY || "",
    agentId: process.env.ELEVENLABS_AGENT_ID || file.ELEVENLABS_AGENT_ID || "",
  };
}

async function resolveVoiceSession() {
  const pref = voiceBackendPref();
  const localInstalled = require("fs").existsSync(
    path.join(__dirname, "local-voice", ".venv", "Scripts", "python.exe")
  );

  const wantLocal =
    pref === "local" || (pref === "auto" && localInstalled);

  if (wantLocal) {
    const started = localVoice.start(localVoiceEnv());
    if (!started.ok && pref === "local") {
      return { ok: false, error: started.error || "local_voice_failed" };
    }
    if (started.ok) {
      const ready = await localVoice.waitReady(120000);
      if (ready.ok) {
        return { ok: true, url: localVoice.wsUrl(), backend: "local" };
      }
      if (pref === "local") {
        return { ok: false, error: "local_voice_timeout" };
      }
    }
  }

  if (pref === "local") {
    return { ok: false, error: "local_voice_failed" };
  }

  // ElevenLabs path (explicit or auto fallback).
  return fetchSignedUrl();
}

// ---------- personality ----------
// The agent's system prompt lives in personality.md and is uploaded to
// ElevenLabs by scripts/setup-voice.js. It is read here only so the tray can
// report whether it's present.

function personalityPresent() {
  return fs.existsSync(path.join(__dirname, "personality.md"));
}

async function fetchSignedUrl() {
  const { apiKey, agentId } = voiceConfig();
  if (!apiKey) return { ok: false, error: "no_api_key" };
  if (!agentId) return { ok: false, error: "no_agent_id" };

  try {
    // Fail early with a clear message when the monthly character budget is empty.
    // Signed URLs can still mint, but the agent will not speak.
    const subRes = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
    });
    if (subRes.ok) {
      const sub = await subRes.json();
      const used = Number(sub.character_count) || 0;
      const limit = Number(sub.character_limit) || 0;
      if (limit > 0 && used >= limit) {
        const resetUnix = Number(sub.next_character_count_reset_unix) || 0;
        return {
          ok: false,
          error: "quota_exceeded",
          resetAt: resetUnix ? new Date(resetUnix * 1000).toISOString() : null,
          used,
          limit,
        };
      }
    }

    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": apiKey } }
    );
    if (!res.ok) {
      if (res.status === 401) return { ok: false, error: "elevenlabs_401" };
      if (res.status === 402 || res.status === 429) return { ok: false, error: "quota_exceeded" };
      return { ok: false, error: `elevenlabs_${res.status}` };
    }
    const data = await res.json();
    if (!data.signed_url) return { ok: false, error: "no_signed_url" };
    return { ok: true, url: data.signed_url, backend: "elevenlabs" };
  } catch (err) {
    console.error("Signed URL request failed:", err.message);
    return { ok: false, error: "network" };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...overlayBounds(),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // The taskbar is itself a topmost window, so "floating" would put Cog
  // behind it and his dangling legs would vanish. This level clears it.
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  // Mouse events pass straight through to whatever is underneath; the
  // renderer flips this off while the pointer is actually over Cog.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.on("did-finish-load", pushLayout);

  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function rebuildTray() {
  if (!tray) return;
  const current = ollamaModel();
  const think = ollamaThinkModel();
  const mode = ollamaThinkMode();
  const llmMode = llmBackendPref();
  const cloudReady = llmCloudKeyPresent();
  const menu = Menu.buildFromTemplate([
    {
      label: "Show Cog",
      click: () => showBuddy(),
    },
    {
      label: "Hide Cog",
      click: () => {
        if (mainWindow) mainWindow.hide();
      },
    },
    {
      label: "Type to Cog",
      click: () => {
        showBuddy();
        if (mainWindow) mainWindow.webContents.send("workbuddy:chat-open");
      },
    },
    {
      label: "Talk to Cog (voice)",
      click: () => {
        showBuddy();
        if (mainWindow) mainWindow.webContents.send("workbuddy:voice-start");
      },
    },
    {
      label: "Test nudge",
      click: () => triggerGrow({ force: true, source: "tray" }),
    },
    { type: "separator" },
    {
      label: cloudReady
        ? `Brain: ${llmMode === "ollama" || llmMode === "local" ? "Local" : "Cloud"} (${llmMode === "ollama" || llmMode === "local" ? current : llmCloudModel()})`
        : `Brain: Local fallback (${current}) — add API key`,
      enabled: false,
    },
    {
      label: "Switch brain",
      submenu: [
        {
          label: cloudReady ? "Cloud API (recommended)" : "Cloud API (needs OPENAI_API_KEY)",
          type: "radio",
          checked: llmMode === "cloud" || llmMode === "openai" || llmMode === "api" || llmMode === "auto",
          click: () => setLlmBackend("cloud"),
        },
        {
          label: "Local light (qwen 7B)",
          type: "radio",
          checked: llmMode === "ollama" || llmMode === "local",
          click: () => {
            writeEnvKey("OLLAMA_MODEL", "qwen2.5:7b");
            setLlmBackend("ollama");
          },
        },
      ],
    },
    {
      label: `Fast local model: ${current}`,
      enabled: false,
    },
    {
      label: "Switch fast brain",
      submenu: LOCAL_MODEL_CHOICES.map((choice) => ({
        label: choice.label,
        type: "radio",
        checked: current === choice.id,
        click: () => {
          const result = setLocalModel(choice.id);
          if (!result.ok) console.warn("[local-voice] fast model switch failed:", result.error);
          else console.log("[local-voice] fast brain ->", choice.id);
        },
      })),
    },
    {
      label: `Think brain: ${think} (${mode})`,
      enabled: false,
    },
    {
      label: "Switch think brain",
      submenu: THINK_MODEL_CHOICES.map((choice) => ({
        label: choice.label,
        type: "radio",
        checked: think === choice.id,
        click: () => {
          const result = setThinkModel(choice.id);
          if (!result.ok) console.warn("[local-voice] think model switch failed:", result.error);
          else console.log("[local-voice] think brain ->", choice.id);
        },
      })),
    },
    {
      label: "Thinking mode",
      submenu: [
        {
          label: "Auto (recommended)",
          type: "radio",
          checked: mode === "auto",
          click: () => setThinkMode("auto"),
        },
        {
          label: "Always think",
          type: "radio",
          checked: mode === "always",
          click: () => setThinkMode("always"),
        },
        {
          label: "Off (fast only)",
          type: "radio",
          checked: mode === "off",
          click: () => setThinkMode("off"),
        },
      ],
    },
    { type: "separator" },
    {
      label: "Add note to process log…",
      click: () => {
        const out = processJournal.openInboxForUser();
        if (!out.ok) console.warn("[process-journal] open inbox failed:", out.error);
        else console.log("[process-journal] inbox:", out.path);
      },
    },
    {
      label: "Open process logs folder",
      click: () => {
        const dir = processJournal.dir();
        if (!dir) return;
        try {
          shell.openPath(dir);
        } catch (err) {
          console.warn("[process-journal] open folder failed:", err.message);
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        processJournal.record({
          kind: "process",
          type: "quit",
          name: "workbuddy",
          by: "tray",
          reason: "Quit from tray",
          pid: process.pid,
        });
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  // Tiny amber dot icon (16x16 PNG)
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPUlEQVQ4T2NkYGD4z0ABYBzVMKoBAzQA5v8MDAyM/ylIMzIyMjL8Z2Bg+E+BZgbG0QyAacB/BiYGRsYoGgAA3zQEAa0x0oUAAAAASUVORK5CYII="
  );
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Workbuddy");
  rebuildTray();
  tray.on("click", () => showBuddy());
}

// Never steal focus — the buddy is decoration until you click him.
function showBuddy() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  fitOverlay();
  mainWindow.showInactive();
}

function raiseOverlay() {
  if (!mainWindow) createWindow();
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.showInactive();
  mainWindow.moveTop();
}

function calmOverlay() {
  if (!mainWindow) return;
  // The taskbar is itself a topmost window, so "floating" would put Cog
  // behind it and his dangling legs would vanish. This level clears it.
  mainWindow.setAlwaysOnTop(true, "screen-saver");
}

function fitOverlay() {
  pushLayout();
}

function triggerGrow(payload = {}) {
  alerting = true;
  raiseOverlay();
  if (mainWindow) {
    mainWindow.webContents.send("workbuddy:grow", {
      at: Date.now(),
      source: payload.source || "hook",
      durationMs: payload.durationMs || null,
      title: payload.title || null,
    });
  }
}

function triggerAck() {
  alerting = false;
  calmOverlay();
  if (mainWindow) {
    mainWindow.webContents.send("workbuddy:ack", { at: Date.now() });
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const queryToken = new URL(req.url, `http://${HOST}`).searchParams.get("token");
  const provided = token || queryToken || "";
  return provided && provided === localToken;
}

function startServer() {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, alerting, ...displayLayout() }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/token") {
      // Only on loopback — helps install scripts; still local-only bind.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: localToken }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/agent-done") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }

      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid_json" }));
        return;
      }

      const force = Boolean(body.force);
      const hookStatus = String(body.status || "").toLowerCase();
      if (
        !force &&
        hookStatus &&
        hookStatus !== "completed" &&
        hookStatus !== "error" &&
        hookStatus !== "finished"
      ) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, skipped: true, reason: "status_filtered", status: hookStatus }));
        return;
      }

      let durationMs = null;
      if (typeof body.durationMs === "number") durationMs = body.durationMs;
      else if (typeof body.duration_minutes === "number") durationMs = body.duration_minutes * 60 * 1000;
      else if (typeof body.durationMinutes === "number") durationMs = body.durationMinutes * 60 * 1000;
      else if (typeof body.startedAt === "number") durationMs = Date.now() - body.startedAt;

      const minMs = minDurationMs();
      if (!force && (durationMs == null || durationMs < minMs)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            skipped: true,
            reason: "too_short",
            durationMs,
            minDurationMs: minMs,
          })
        );
        return;
      }

      triggerGrow({
        force,
        source: body.source || "hook",
        durationMs,
        title: body.title || body.session_title || null,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, alerting: true, durationMs }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/ack") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      triggerAck();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, alerting: false }));
      return;
    }

    // Local AMD voice → Electron memory bridge (Recall brief + tools + save).
    if (req.method === "GET" && url.pathname === "/local/memory-brief") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      const compact = url.searchParams.get("compact") !== "0";
      const brief = await buildRecallBrief({ compact });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(brief));
      return;
    }

    if (req.method === "GET" && url.pathname === "/local/system-context") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      const file = readEnvFile();
      const setting = (process.env.COG_SYSTEM_CONTEXT || file.COG_SYSTEM_CONTEXT || "on").toLowerCase();
      if (setting === "off" || setting === "false" || setting === "0") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "disabled" }));
        return;
      }
      try {
        const text = await systemInfo.snapshot();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, text: String(text || "").slice(0, 2500) }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message || "failed" }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/local/tool") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid_json" }));
        return;
      }
      const result = await runLocalTool(body.tool || body.name, body.args || body.arguments || {});
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === "POST" && url.pathname === "/local/save-session") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid_json" }));
        return;
      }
      const result = await saveCogChatSession(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === "POST" && url.pathname === "/local/process-event") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid_json" }));
        return;
      }
      const result = processJournal.record(body);
      if (body.session_id && (body.kind === "conversation" || body.type === "user" || body.type === "assistant")) {
        conversationStore.recordEvent(body.session_id, body);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === "POST" && url.pathname === "/local/process-note") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid_json" }));
        return;
      }
      const result = processJournal.note(body.text || body.note || "", {
        by: body.by || "http",
        reason: body.reason || "process note",
        meta: body.meta,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === "GET" && url.pathname === "/local/process-recent") {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      const limit = Number(url.searchParams.get("limit") || 80);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, events: processJournal.recent(limit), dir: processJournal.dir() }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  server.on("error", (err) => {
    console.error("Workbuddy server error:", err);
  });

  server.listen(PORT, HOST, () => {
    console.log(`Workbuddy listening on http://${HOST}:${PORT}`);
  });
}

ipcMain.on("workbuddy:ack-from-ui", () => {
  triggerAck();
});

// What he can see about the machine. Off by one line if you'd rather he
// didn't: COG_SYSTEM_CONTEXT=off in .env.local.
ipcMain.handle("workbuddy:system-context", async () => {
  const file = readEnvFile();
  const setting = (process.env.COG_SYSTEM_CONTEXT || file.COG_SYSTEM_CONTEXT || "on").toLowerCase();
  if (setting === "off" || setting === "false" || setting === "0") return { ok: false, error: "disabled" };
  try {
    return { ok: true, text: await systemInfo.snapshot() };
  } catch (err) {
    console.error("System snapshot failed:", err.message);
    return { ok: false, error: "failed" };
  }
});

// What Jake has actually been thinking about, straight out of Recall.
ipcMain.handle("workbuddy:recall-context", async () => {
  const file = readEnvFile();
  const setting = (process.env.COG_RECALL || file.COG_RECALL || "on").toLowerCase();
  if (setting === "off" || setting === "false" || setting === "0") return { ok: false, error: "disabled" };

  try {
    const [live, actions] = await Promise.all([
      recall.call("recall_live_context", {}),
      recall.call("recall_open_actions", { limit: 5 }),
    ]);
    const parts = [];
    if (live.ok && live.text) parts.push(`Recently said out loud: ${clip(live.text, 2500)}`);
    if (actions.ok && actions.data) parts.push(formatActionsBrief(actions.data));
    else if (actions.ok && actions.text) parts.push(`Open action items: ${clip(actions.text, 1200)}`);
    if (!parts.length) return { ok: false, error: "empty" };
    return { ok: true, text: parts.join(" ").slice(0, 4000) };
  } catch (err) {
    console.error("Recall context failed:", err.message);
    return { ok: false, error: "failed" };
  }
});

// Full startup memory pack: relationship notes + live speech + task COUNTS
// (never dump hundreds of action rows — that truncates and Cog invents wrong totals).
async function buildRecallBrief(opts = {}) {
  const file = readEnvFile();
  const setting = (process.env.COG_RECALL || file.COG_RECALL || "on").toLowerCase();
  if (setting === "off" || setting === "false" || setting === "0") return { ok: false, error: "disabled" };
  const compact = Boolean(opts.compact);

  try {
    const [live, actions, recent, search] = await Promise.all([
      recall.call("recall_live_context", { minutes: compact ? 5 : 10 }),
      recall.call("recall_open_actions", { limit: compact ? 3 : 5 }),
      recall.call("recall_recent", { limit: compact ? 5 : 8, project: "WorkBuddy" }),
      recall.call("recall_search", {
        query: "Jake preferences relationship Cog memory decisions",
        project: "WorkBuddy",
        limit: compact ? 5 : 8,
      }),
    ]);
    const parts = [];
    const recentMax = compact ? 1600 : 3500;
    const searchMax = compact ? 1600 : 3500;
    const liveMax = compact ? 900 : 2000;
    const actionsMax = compact ? 800 : 1500;
    const totalMax = compact ? 4500 : 12000;
    if (recent.ok && recent.text) parts.push(`Recent WorkBuddy/Cog notes:\n${clip(recent.text, recentMax)}`);
    if (search.ok && search.text) parts.push(`Related memory search:\n${clip(search.text, searchMax)}`);
    if (live.ok && live.text) parts.push(`Recently said out loud:\n${clip(live.text, liveMax)}`);
    if (actions.ok && actions.data) {
      parts.push(formatActionsBrief(actions.data));
    } else if (actions.ok && actions.text) {
      parts.push(`Open tasks summary:\n${clip(actions.text, actionsMax)}`);
    }
    if (!parts.length) return { ok: false, error: "empty" };
    return {
      ok: true,
      text: parts.join("\n\n").slice(0, totalMax),
    };
  } catch (err) {
    console.error("Recall brief failed:", err.message);
    return { ok: false, error: "failed" };
  }
}

ipcMain.handle("workbuddy:recall-brief", async () => buildRecallBrief());

async function runRecallTool(name, args) {
  const file = readEnvFile();
  const setting = (process.env.COG_RECALL || file.COG_RECALL || "on").toLowerCase();
  if (setting === "off" || setting === "false" || setting === "0") {
    return { ok: false, error: "disabled" };
  }
  const tool = String(name || "").trim();
  if (!tool.startsWith("recall_")) {
    return { ok: false, error: "invalid_tool" };
  }
  try {
    const normalized = normalizeRecallArgs(tool, args && typeof args === "object" ? args : {});
    const result = await recall.call(tool, normalized);
    if (!result.ok) return result;
    return {
      ok: true,
      text: result.text || "",
      data: result.data,
      isError: Boolean(result.isError),
    };
  } catch (err) {
    console.error("Recall tool failed:", tool, err.message);
    return { ok: false, error: err.message || "failed" };
  }
}

function runProcessTool(name, args) {
  const tool = String(name || "").trim();
  const a = args && typeof args === "object" ? args : {};
  try {
    if (tool === "process_recent") {
      const limit = Math.min(100, Math.max(1, Number(a.limit) || 40));
      let events = processJournal.recent(Math.max(limit * 3, limit));
      if (a.kind) {
        const kind = String(a.kind).toLowerCase();
        events = events.filter((e) => String(e.kind || "").toLowerCase() === kind);
      }
      if (a.type) {
        const type = String(a.type).toLowerCase();
        events = events.filter((e) => String(e.type || "").toLowerCase() === type);
      }
      events = events.slice(-limit);
      return {
        ok: true,
        text: processJournal.formatEvents(events, limit) || "(no process events yet)",
        data: { count: events.length, dir: processJournal.dir() },
      };
    }
    if (tool === "process_search") {
      const query = String(a.query || a.q || "").trim();
      if (!query) return { ok: false, error: "query_required" };
      const limit = Math.min(80, Math.max(1, Number(a.limit) || 30));
      const events = processJournal.search(query, limit);
      return {
        ok: true,
        text:
          processJournal.formatEvents(events, limit) ||
          `(no process events matched "${query}")`,
        data: { count: events.length, query },
      };
    }
    if (tool === "process_note") {
      const text = String(a.text || a.note || "").trim();
      if (!text) return { ok: false, error: "empty" };
      const out = processJournal.note(text, {
        by: a.by || "cog",
        reason: a.reason || "cog process_note tool",
      });
      return {
        ok: Boolean(out.ok),
        text: out.ok ? `Saved process note: ${text.slice(0, 200)}` : out.error || "failed",
        data: out.event || null,
        error: out.ok ? undefined : out.error,
      };
    }
    return { ok: false, error: "invalid_tool" };
  } catch (err) {
    console.error("Process tool failed:", tool, err.message);
    return { ok: false, error: err.message || "failed" };
  }
}

function runConversationTool(name, args) {
  const tool = String(name || "").trim();
  const a = args && typeof args === "object" ? args : {};
  try {
    if (tool === "conversation_recent") {
      const limit = Math.min(40, Math.max(1, Number(a.limit) || 10));
      const sessions = conversationStore.listRecent(limit);
      return {
        ok: true,
        text: conversationStore.formatSessionList(sessions) || "(no saved conversations yet)",
        data: { count: sessions.length, sessions },
      };
    }
    if (tool === "conversation_get") {
      const id = String(a.id || a.session_id || a.sessionId || "").trim();
      if (!id) return { ok: false, error: "id_required" };
      const meta = conversationStore.getSession(id);
      if (!meta || !(meta.transcript || []).length) {
        // Still return meta if present with zero turns.
        if (!meta) return { ok: false, error: "not_found" };
      }
      return {
        ok: true,
        text: conversationStore.formatTranscript(meta, Number(a.max_turns) || 40),
        data: meta,
      };
    }
    return { ok: false, error: "invalid_tool" };
  } catch (err) {
    console.error("Conversation tool failed:", tool, err.message);
    return { ok: false, error: err.message || "failed" };
  }
}

async function runLocalTool(name, args) {
  const tool = String(name || "").trim();
  if (tool.startsWith("recall_")) return runRecallTool(tool, args);
  if (tool.startsWith("process_")) return runProcessTool(tool, args);
  if (tool.startsWith("conversation_")) return runConversationTool(tool, args);
  if (tool.startsWith("cursor_")) return runCursorTool(tool, args);
  return { ok: false, error: "invalid_tool" };
}

function formatAgentsText(agents) {
  const list = Array.isArray(agents) ? agents : [];
  if (!list.length) return "No agents found.";
  return list
    .slice(0, 12)
    .map((a) => {
      const status = a.friendlyStatus || a.status || "unknown";
      const kind = a.kind || "agent";
      const goal = clip(a.goal || "(no goal)", 80);
      // Put id last so spoken summaries can strip it; chat UI still sees it.
      return `- ${status}: ${kind} — ${goal} [id ${a.id || "?"}]`;
    })
    .join("\n");
}

async function runCursorAgentAction(action, args) {
  const file = readEnvFile();
  const setting = (process.env.COG_CURSOR_AGENTS || file.COG_CURSOR_AGENTS || "on").toLowerCase();
  if (setting === "off" || setting === "false" || setting === "0") {
    return { ok: false, error: "disabled", text: "Cursor agents are turned off." };
  }
  const apiKey = cursorAgents.readApiKey(file);
  const a = args && typeof args === "object" ? args : {};
  try {
    switch (String(action || "").trim()) {
      case "start": {
        const out = await cursorAgents.startAgent({
          goal: a.goal || a.prompt || a.message,
          kind: a.kind || "research",
          cwd: a.cwd || a.path || process.cwd(),
          mode: a.mode || process.env.COG_CURSOR_MODE || file.COG_CURSOR_MODE || "auto",
          apiKey,
        });
        if (out.ok && out.id) {
          recall
            .call("recall_save_note", {
              title: `Cursor ${out.kind || "agent"}: ${(a.goal || "").slice(0, 60)}`,
              summary: `Cog started a Cursor ${out.kind || "agent"}.\nId: ${out.id}\nRuntime: ${out.runtime}\nStatus: ${out.status}\nOpen: ${out.openUrl || "(local — use cursor_continue_agent)"}\n\nGoal:\n${a.goal || ""}`,
              tags: "cog,cursor,agent",
              project: "WorkBuddy",
            })
            .catch(() => {});
        }
        return {
          ...out,
          text: out.ok
            ? `Started ${out.kind || "agent"} (${out.status || "running"}). [id ${out.id}]`
            : out.error || out.hint || "failed",
        };
      }
      case "continue": {
        const out = await cursorAgents.continueAgentInBackground({
          id: a.id || a.agent_id,
          message: a.message || a.prompt || a.goal,
          apiKey,
        });
        return { ...out, text: out.ok ? "Follow-up sent; agent working in background." : out.error || "failed" };
      }
      case "status":
      case "details": {
        const out = await cursorAgents.agentStatusDetailed({
          id: a.id || a.agent_id,
          apiKey,
        });
        return {
          ...out,
          text: out.summary || out.text || (out.ok ? "Got agent status." : out.error || "failed"),
        };
      }
      case "list": {
        const agents = cursorAgents.listAgents({
          limit: asInt(a.limit) || 10,
          status: a.status,
          kind: a.kind,
          runtime: a.runtime,
          runningOnly: asBool(a.running_only || a.runningOnly),
          search: a.search || a.query,
        });
        return { ok: true, agents, text: formatAgentsText(agents) };
      }
      case "running": {
        const agents = cursorAgents.listAgents({
          limit: asInt(a.limit) || 10,
          runningOnly: true,
        });
        return {
          ok: true,
          agents,
          text: agents.length ? formatAgentsText(agents) : "No agents running right now.",
        };
      }
      case "list_cloud": {
        const out = await cursorAgents.listCloudAgents({
          limit: asInt(a.limit) || 15,
          includeArchived: asBool(a.include_archived || a.includeArchived),
          apiKey,
        });
        const agents = out.agents || out.data || [];
        return {
          ...out,
          text: out.ok ? formatAgentsText(agents) : out.error || "failed",
        };
      }
      case "open": {
        const out = cursorAgents.openAgentInBrowser(a.id || a.agent_id);
        return { ...out, text: out.ok ? "Opened agent in browser." : out.error || "failed" };
      }
      case "stop": {
        const out = await cursorAgents.stopAgent({ id: a.id || a.agent_id, apiKey });
        return { ...out, text: out.ok ? "Stopped agent." : out.error || "failed" };
      }
      case "pause": {
        const out = await cursorAgents.pauseAgent({ id: a.id || a.agent_id, apiKey });
        return { ...out, text: out.ok ? "Paused agent." : out.error || "failed" };
      }
      case "restart": {
        const out = await cursorAgents.restartAgent({
          id: a.id || a.agent_id,
          message: a.message || a.prompt || a.goal,
          apiKey,
        });
        return { ...out, text: out.ok ? "Restarted agent." : out.error || "failed" };
      }
      case "archive": {
        const out = await cursorAgents.archiveAgent({ id: a.id || a.agent_id, apiKey });
        return { ...out, text: out.ok ? "Archived agent." : out.error || "failed" };
      }
      case "unarchive": {
        const out = await cursorAgents.unarchiveAgent({ id: a.id || a.agent_id, apiKey });
        return { ...out, text: out.ok ? "Unarchived agent." : out.error || "failed" };
      }
      case "delete": {
        const out = await cursorAgents.deleteAgent({
          id: a.id || a.agent_id,
          confirm: asBool(a.confirm),
          apiKey,
        });
        return { ...out, text: out.ok ? "Deleted agent." : out.error || "failed" };
      }
      default:
        return { ok: false, error: "unknown_action", text: "Unknown cursor action." };
    }
  } catch (err) {
    console.error("Cursor agent action failed:", action, err.message);
    return { ok: false, error: err.message || "failed", text: err.message || "failed" };
  }
}

const CURSOR_TOOL_ACTIONS = {
  cursor_start_agent: "start",
  cursor_continue_agent: "continue",
  cursor_list_agents: "list",
  cursor_running_agents: "running",
  cursor_list_cloud_agents: "list_cloud",
  cursor_agent_status: "status",
  cursor_agent_details: "details",
  cursor_open_agent: "open",
  cursor_stop_agent: "stop",
  cursor_kill_agent: "stop",
  cursor_pause_agent: "pause",
  cursor_restart_agent: "restart",
  cursor_archive_agent: "archive",
  cursor_unarchive_agent: "unarchive",
  cursor_delete_agent: "delete",
};

async function runCursorTool(name, args) {
  const action = CURSOR_TOOL_ACTIONS[String(name || "").trim()];
  if (!action) return { ok: false, error: "invalid_tool", text: "Unknown cursor tool." };
  return runCursorAgentAction(action, args || {});
}

// Generic local tool call (Recall + process journal + conversations + cursor).
ipcMain.handle("workbuddy:recall-tool", async (_event, name, args) => runLocalTool(name, args));
ipcMain.handle("workbuddy:local-tool", async (_event, name, args) => runLocalTool(name, args));

// Cursor planning/research agents — start, continue, list, status, open.
ipcMain.handle("workbuddy:cursor-agent", async (_event, action, args) => runCursorAgentAction(action, args));

let lastCogChatFingerprint = "";
let lastCogChatAt = 0;

async function saveCogChatSession(body = {}) {
  const transcript = String(body.transcript || body.summary || "").trim();
  if (!transcript) return { ok: false, error: "empty" };
  const fingerprint = crypto
    .createHash("sha1")
    .update(transcript.slice(0, 3500).replace(/\s+/g, " ").trim())
    .digest("hex");
  const now = Date.now();
  // Local voice + renderer used to double-save the same chat within milliseconds.
  if (fingerprint === lastCogChatFingerprint && now - lastCogChatAt < 120000) {
    return { ok: true, deduped: true, fingerprint };
  }
  const title =
    String(body.title || "").trim() ||
    `Cog chat ${new Date().toLocaleString("en-CA", { hour12: false }).slice(0, 16)}`;
  const summary = String(body.summary || transcript).slice(0, 3500);
  const result = await runRecallTool("recall_save_note", {
    title,
    summary,
    tags: ["cog", "conversation", "relationship"],
    project: "WorkBuddy",
  });
  if (result && result.ok !== false) {
    lastCogChatFingerprint = fingerprint;
    lastCogChatAt = now;
  }
  return result;
}

function clip(text, max) {
  const s = String(text || "");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function formatActionsBrief(data) {
  const total = data.total_open ?? (data.open_actions || []).length;
  const counts = data.counts_by_project || {};
  const lines = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `- ${id}: ${n}`);
  const samples = (data.open_actions || [])
    .slice(0, 5)
    .map((a) => `- [${a.project_id || "none"}] ${a.action}`)
    .join("\n");
  return [
    `Recall Tasks: ${total} open (full board).`,
    lines.length ? `By project:\n${lines.join("\n")}` : "",
    samples ? `Sample:\n${samples}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// Read Jake's other Cursor chats (local conversation index + transcripts).
ipcMain.handle("workbuddy:cursor-chats", async (_event, action, args) => {
  const file = readEnvFile();
  const setting = (process.env.COG_CURSOR_CHATS || file.COG_CURSOR_CHATS || "on").toLowerCase();
  if (setting === "off" || setting === "false" || setting === "0") {
    return { ok: false, error: "disabled" };
  }
  const a = args && typeof args === "object" ? args : {};
  try {
    switch (String(action || "").trim()) {
      case "list":
        return cursorChats.listChats({
          limit: asInt(a.limit) || 15,
          includeArchived: asBool(a.include_archived || a.includeArchived),
        });
      case "search":
        return cursorChats.searchChats({
          query: a.query || a.q || a.text,
          limit: asInt(a.limit) || 10,
        });
      case "get":
        return cursorChats.getChat({
          id: a.id || a.chat_id,
          maxChars: asInt(a.max_chars || a.maxChars) || 8000,
        });
      default:
        return { ok: false, error: "unknown_action" };
    }
  } catch (err) {
    console.error("Cursor chats action failed:", action, err.message);
    return { ok: false, error: err.message || "failed" };
  }
});

function splitList(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (value == null || value === "") return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function asBool(value) {
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function asInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const n = parseInt(String(value).trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

// ElevenLabs client tools pass everything as strings; MCP expects typed JSON.
function normalizeRecallArgs(tool, args) {
  const out = { ...args };
  if ("limit" in out) {
    const n = asInt(out.limit);
    if (n !== undefined) out.limit = n;
    else delete out.limit;
  }
  if ("minutes" in out) {
    const n = asInt(out.minutes);
    if (n !== undefined) out.minutes = n;
    else delete out.minutes;
  }
  if ("tags" in out) out.tags = splitList(out.tags);
  if ("aliases" in out) out.aliases = splitList(out.aliases);
  if ("pinned" in out) out.pinned = asBool(out.pinned);
  if ("trashed" in out) out.trashed = asBool(out.trashed);
  // Drop empty optional strings so MCP treats them as omitted.
  for (const key of Object.keys(out)) {
    if (out[key] === "" || out[key] == null) delete out[key];
  }
  return out;
}

ipcMain.handle("workbuddy:voice-signed-url", () => resolveVoiceSession());

ipcMain.handle("workbuddy:voice-status", async () => {
  const { apiKey, agentId } = voiceConfig();
  const pref = voiceBackendPref();
  const localHealth = await localVoice.health();
  const localInstalled = fs.existsSync(
    path.join(__dirname, "local-voice", ".venv", "Scripts", "python.exe")
  );
  const localReady = Boolean(localHealth && localHealth.ok);
  const elevenReady = Boolean(apiKey && agentId);
  const configured =
    pref === "local"
      ? localInstalled
      : pref === "elevenlabs"
        ? elevenReady
        : localInstalled || elevenReady;
  return {
    configured,
    backend: pref,
    localInstalled,
    localReady,
    ollamaModel: ollamaModel(),
    hasKey: Boolean(apiKey),
    hasAgent: Boolean(agentId),
    hasPersonality: personalityPresent(),
    wakeWord: wakeWordEnabled(),
    wakeSupported: process.platform === "win32",
    wakePhrases: wakeListener.phrases,
  };
});

ipcMain.on("workbuddy:wake-pause", () => {
  wakeListener.pause("renderer", "pause for voice call");
});

ipcMain.on("workbuddy:wake-resume", () => {
  wakeListener.resume("renderer", "resume after voice call");
});

ipcMain.handle("workbuddy:process-note", (_event, text) => {
  return processJournal.note(text, { by: "ui", reason: "from Cog UI" });
});

ipcMain.handle("workbuddy:process-event", (_event, event) => {
  const result = processJournal.record(event || {});
  if (event && event.session_id) {
    conversationStore.recordEvent(event.session_id, event);
  }
  return result;
});

ipcMain.handle("workbuddy:conversation-start", (_event, info = {}) => {
  const id = info.sessionId || conversationStore.newSessionId();
  activeConversationId = id;
  conversationStore.recordEvent(id, {
    type: "session_start",
    backend: info.backend || null,
    model: info.model || null,
  });
  processJournal.conversation("session_start", {
    session_id: id,
    by: "renderer",
    meta: { backend: info.backend, model: info.model },
  });
  return { ok: true, sessionId: id };
});

ipcMain.handle("workbuddy:conversation-event", (_event, sessionId, event) => {
  const id = sessionId || activeConversationId || conversationStore.newSessionId();
  activeConversationId = id;
  conversationStore.recordEvent(id, event || {});
  processJournal.conversation(event?.type || "event", {
    session_id: id,
    text: event?.text,
    by: "renderer",
    meta: event,
  });
  return { ok: true, sessionId: id };
});

ipcMain.handle("workbuddy:conversation-end", (_event, sessionId, extra = {}) => {
  const id = sessionId || activeConversationId;
  if (!id) return { ok: false, error: "no_session" };
  const ended = conversationStore.endSession(id, extra);
  processJournal.conversation("session_end", {
    session_id: id,
    by: "renderer",
    meta: extra,
  });
  if (activeConversationId === id) activeConversationId = null;
  return ended;
});

ipcMain.handle("workbuddy:process-recent", (_event, limit) => {
  return { ok: true, events: processJournal.recent(limit || 80), dir: processJournal.dir() };
});

// The overlay is deliberately non-focusable so clicking Cog never pulls focus
// off your editor — but a text box needs keystrokes, so focus is granted for
// exactly as long as the chat is open.
ipcMain.on("workbuddy:chat-focus", (_event, on) => {
  if (!mainWindow) return;
  mainWindow.setFocusable(Boolean(on));
  if (on) mainWindow.focus();
});

ipcMain.on("workbuddy:set-interactive", (_event, interactive) => {
  if (!mainWindow) return;
  if (interactive) mainWindow.setIgnoreMouseEvents(false);
  else mainWindow.setIgnoreMouseEvents(true, { forward: true });
});

ipcMain.on("workbuddy:test-grow", () => {
  triggerGrow({ force: true, source: "ui-test" });
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showBuddy();
  });

  app.whenReady().then(() => {
    ensureToken();
    processJournal.init({ projectRoot: __dirname });
    conversationStore.init({ projectRoot: __dirname, userData: app.getPath("userData") });
    localVoice.setJournal(processJournal);
    wakeListener.setJournal(processJournal);
    processJournal.started("workbuddy", {
      pid: process.pid,
      by: "main",
      reason: "Electron app ready",
      meta: { voiceBackend: voiceBackendPref() },
    });

    // Cog needs the microphone to hold a conversation; nothing else.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === "media" || permission === "audioCapture");
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      return permission === "media" || permission === "audioCapture";
    });

    createWindow();
    createTray();
    startServer();

    // Prefer local AMD voice when configured; still start wake word either way.
    const pref = voiceBackendPref();
    if (pref === "local" || pref === "auto") {
      localVoice.start(localVoiceEnv(), { by: "main", reason: "startup local voice" });
    }

    wakeListener.init({
      onWake(phrase) {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send("workbuddy:wake", { phrase });
      },
    });
    const envFile = readEnvFile();
    const { apiKey, agentId } = voiceConfig();
    const localInstalled = fs.existsSync(
      path.join(__dirname, "local-voice", ".venv", "Scripts", "python.exe")
    );
    if (wakeWordEnabled() && (localInstalled || (apiKey && agentId))) {
      wakeListener.start("main", "startup wake word");
    }
    const cursorKey = cursorAgents.readApiKey(envFile);
    if (cursorKey) {
      cursorAgents.reconcileRunningAgents({ apiKey: cursorKey, silent: true }).catch((err) => {
        console.warn("Startup agent reconcile failed:", err.message || err);
      });
      cursorAgents.startStatusPolling(cursorKey);
    }

    // Taskbar autohide, resolution changes, docking — keep the overlay
    // pinned to the current work area.
    keepOnTop();

    screen.on("display-metrics-changed", fitOverlay);
    screen.on("display-added", fitOverlay);
    screen.on("display-removed", fitOverlay);
  });

  app.on("window-all-closed", (e) => {
    // Stay running in tray on Windows
    e.preventDefault();
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    processJournal.record({
      kind: "process",
      type: "quit",
      name: "workbuddy",
      by: "main",
      reason: "before-quit",
      pid: process.pid,
      kills: [
        localVoice.pid() ? `local-voice:${localVoice.pid()}` : null,
        "wake-listener",
      ].filter(Boolean),
    });
    if (topKeeper) clearInterval(topKeeper);
    wakeListener.stop("main", "app quitting");
    localVoice.stop("app quitting", "main");
    cursorAgents.stopStatusPolling();
    recall.stop();
    if (server) {
      try {
        server.close();
      } catch {
        // ignore
      }
    }
  });
}
