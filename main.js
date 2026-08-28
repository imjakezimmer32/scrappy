const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, session, shell } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFile, spawn, execFileSync } = require("child_process");
const systemInfo = require("./system-info");
const recall = require("./recall-mcp");
const cursorAgents = require("./cursor-agents");
const cursorChats = require("./cursor-chats");
const wakeListener = require("./wake-listener");
const localVoice = require("./local-voice-launcher");
const processJournal = require("./process-journal");
const conversationStore = require("./conversation-store");
const settings = require("./settings");
const persona = require("./persona");
const cursorHooks = require("./cursor-hooks");
const appUpdate = require("./app-update");

const APP_ID = "com.hellalogic.scrappy";
const PORT = 8787;
const HOST = "127.0.0.1";
const TOKEN_PATH = path.join(app.getPath("userData"), "local-token.txt");
const PREFS_PATH = path.join(app.getPath("userData"), "prefs.json");

let prefs = { visible: true, lastUpdateCheck: 0, lastUpdateTold: "" };

function loadPrefs() {
  try {
    if (!fs.existsSync(PREFS_PATH)) return;
    const data = JSON.parse(fs.readFileSync(PREFS_PATH, "utf8"));
    if (typeof data.visible === "boolean") prefs.visible = data.visible;
    if (Number.isFinite(data.lastUpdateCheck)) prefs.lastUpdateCheck = data.lastUpdateCheck;
    if (typeof data.lastUpdateTold === "string") prefs.lastUpdateTold = data.lastUpdateTold;
  } catch (err) {
    console.error("Could not read prefs:", err.message);
  }
}

function savePrefs() {
  try {
    fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
    fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), "utf8");
  } catch (err) {
    console.error("Could not save prefs:", err.message);
  }
}

let activeConversationId = null;

function minDurationMs() {
  const raw = settings.get("SCRAPPY_NUDGE_MIN_DURATION_MS", "");
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

// Scrappy lives on a transparent, click-through overlay stretched across the
// bounding box of every display, so he can walk, be thrown, and bounce
// across all of them. Monitors rarely share a floor line, so the renderer
// also gets each display's rectangle in overlay-local coordinates and works
// out which floor is under him at any given x.
// The window spans the full physical bounds of every display — including the
// strip the taskbar sits on — so Scrappy's legs can hang over the edge when he
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
// click it, which drops Scrappy behind it until something re-asserts him. There
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
  mainWindow.webContents.send("scrappy:layout", displayLayout().screens);
}

// ---------- voice credentials ----------
// The ElevenLabs key lives here in the main process and never crosses into
// the renderer. The renderer only ever receives a signed URL that expires.

// All of these now read through settings.js, which resolves
// process.env > settings store > .env.local > default. Reading the env file
// directly here would skip whatever the setup panel wrote.
const readEnvFile = settings.readEnvFile;

function wakeWordEnabled() {
  return settings.getBool("SCRAPPY_WAKE_WORD", true);
}

function voiceBackendPref() {
  return settings.getLower("VOICE_BACKEND");
}

function ollamaModel() {
  return settings.get("OLLAMA_MODEL");
}

function ollamaThinkModel() {
  return settings.get("OLLAMA_THINK_MODEL");
}

function ollamaThinkMode() {
  return settings.getLower("OLLAMA_THINK_MODE");
}

function llmBackendPref() {
  return settings.getLower("SCRAPPY_LLM_BACKEND");
}

function llmCloudModel() {
  return settings.get("SCRAPPY_LLM_MODEL");
}

function llmCloudKeyPresent() {
  return (
    settings.isSet("SCRAPPY_LLM_API_KEY") ||
    settings.isSet("OPENAI_API_KEY") ||
    settings.isSet("GROQ_API_KEY")
  );
}

// cursor-agents.js takes a plain {KEY: value} bag so it stays free of an
// Electron import. Feed it from the settings store rather than the env file, or
// a key typed into the setup panel is invisible to it.
function cursorKeySource() {
  return {
    CURSOR_API_KEY: settings.get("CURSOR_API_KEY", ""),
    CURSOR_SDK_API_KEY: settings.get("CURSOR_SDK_API_KEY", ""),
  };
}

// One place that pushes the configured name into every module that bakes it
// into text — prompts, transcripts, journal entries.
function applyUserName() {
  const name = settings.userName();
  cursorAgents.setUserName(name);
  conversationStore.setUserName(name);
  processJournal.setUserName(name);
  return name;
}

function installCursorHooksNow() {
  const result = cursorHooks.install({ token: ensureToken() });
  if (!result.ok) {
    console.warn("[hooks] install failed:", result.error);
    return result;
  }
  console.log("[hooks] installed", result.hooksJson);
  return result;
}

function localVoiceEnv() {
  ensureToken();
  const g = settings.get;
  return {
    OLLAMA_MODEL: ollamaModel(),
    OLLAMA_THINK_MODEL: ollamaThinkModel(),
    OLLAMA_THINK_MODE: ollamaThinkMode(),
    SCRAPPY_LLM_BACKEND: llmBackendPref(),
    SCRAPPY_LLM_MODEL: llmCloudModel(),
    SCRAPPY_LLM_THINK_MODEL: g("SCRAPPY_LLM_THINK_MODEL", "") || llmCloudModel(),
    SCRAPPY_LLM_BASE_URL: g("SCRAPPY_LLM_BASE_URL", ""),
    SCRAPPY_LLM_API_KEY: g("SCRAPPY_LLM_API_KEY", ""),
    OPENAI_API_KEY: g("OPENAI_API_KEY", ""),
    GROQ_API_KEY: g("GROQ_API_KEY", ""),
    OPENAI_BASE_URL: g("OPENAI_BASE_URL", ""),
    SCRAPPY_TTS_VOICE: g("SCRAPPY_TTS_VOICE"),
    // Ears: quality-first Whisper (large-v3). Never default back to tiny models.
    WHISPER_MODEL: g("WHISPER_MODEL"),
    WHISPER_COMPUTE: g("WHISPER_COMPUTE"),
    WHISPER_BEAM: g("WHISPER_BEAM"),
    SCRAPPY_VAD_SILENCE_MS: g("SCRAPPY_VAD_SILENCE_MS"),
    SCRAPPY_VAD_ENERGY: g("SCRAPPY_VAD_ENERGY"),
    SCRAPPY_TOOL_ROUNDS: g("SCRAPPY_TOOL_ROUNDS"),
    SCRAPPY_WHISPER_PROMPT: g("SCRAPPY_WHISPER_PROMPT", ""),
    // The rendered persona, not the raw template — otherwise the local brain
    // reads "{{USER}}" out loud and calls everyone that.
    SCRAPPY_PERSONA: persona.renderToFile(settings.userName(), app.getPath("userData")),
    // Local Python voice used to hardcode "Jake". Pass the panel name so he
    // addresses whoever is actually sitting here.
    SCRAPPY_USER_NAME: settings.userName(),
    // Local Python voice talks back to Electron for Recall tools/memory.
    SCRAPPY_URL: `http://${HOST}:${PORT}`,
    SCRAPPY_TOKEN: localToken || "",
  };
}

// Was: rewrite .env.local in place. Now it writes to the settings store
// instead. Two writers on one file is how a key you pasted thirty seconds ago
// disappears — .env.local is read-only from here on, and still read first for
// anyone who set it up that way.
function writeEnvKey(key, value) {
  settings.set(key, value);
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
  writeEnvKey("SCRAPPY_LLM_BACKEND", value);
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
  return {
    apiKey: settings.get("ELEVENLABS_API_KEY", ""),
    agentId: settings.get("ELEVENLABS_AGENT_ID", ""),
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

// Windows will happily paint a real "Scrappy / File / Edit / View / Help"
// title bar on a frameless overlay — after Alt, after the window becomes
// focusable for chat, or after a second window (setup) is created and
// Electron restores the default application menu. Kill that chrome on every
// window, every time it might come back.
function killAppMenu() {
  Menu.setApplicationMenu(null);
}

function killNativeChrome(win) {
  killAppMenu();
  if (!win || win.isDestroyed()) return;
  try {
    win.setMenu(null);
  } catch {
    // ignore
  }
  if (typeof win.removeMenu === "function") {
    try {
      win.removeMenu();
    } catch {
      // ignore
    }
  }
  try {
    win.setAutoHideMenuBar(true);
    win.setMenuBarVisibility(false);
  } catch {
    // ignore
  }
}

function keepOverlayChromeOff() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  killNativeChrome(mainWindow);
  try {
    mainWindow.setTitle("");
  } catch {
    // ignore
  }
}

function guardAgainstNativeChrome(win, { overlay = false } = {}) {
  killNativeChrome(win);
  win.on("page-title-updated", (event) => {
    if (!overlay) return;
    event.preventDefault();
    try {
      win.setTitle("");
    } catch {
      // ignore
    }
  });
  win.on("focus", () => {
    killNativeChrome(win);
    if (overlay) keepOverlayChromeOff();
  });
  win.on("show", () => {
    killNativeChrome(win);
    if (overlay) keepOverlayChromeOff();
  });
  win.webContents.on("did-finish-load", () => {
    killNativeChrome(win);
    if (overlay) keepOverlayChromeOff();
  });
  // Alt toggles the auto-hidden menu bar on Windows. Block it on the overlay
  // so typing or a stray Alt key cannot summon the white File/Edit bar.
  win.webContents.on("before-input-event", (event, input) => {
    if (overlay && input.key === "Alt") event.preventDefault();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...overlayBounds(),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    title: "",
    titleBarStyle: "hidden",
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    thickFrame: false,
    autoHideMenuBar: true,
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

  // The taskbar is itself a topmost window, so "floating" would put Scrappy
  // behind it and his dangling legs would vanish. This level clears it.
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  guardAgainstNativeChrome(mainWindow, { overlay: true });
  keepOverlayChromeOff();
  // Mouse events pass straight through to whatever is underneath; the
  // renderer flips this off while the pointer is actually over Scrappy.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.on("did-finish-load", () => {
    pushLayout();
    pushVisible();
    keepOverlayChromeOff();
  });

  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      hideScrappy("window-close");
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
      label: "Start Scrappy",
      click: () => showScrappy(),
    },
    {
      label: "Turn off Scrappy",
      enabled: prefs.visible,
      click: () => hideScrappy("tray"),
    },
    {
      label: "Type to Scrappy",
      click: () => {
        showScrappy();
        if (mainWindow) mainWindow.webContents.send("scrappy:chat-open");
      },
    },
    {
      label: "Talk to Scrappy (voice)",
      click: () => {
        showScrappy();
        if (mainWindow) mainWindow.webContents.send("scrappy:voice-start");
      },
    },
    {
      label: "Test nudge",
      click: () => triggerGrow({ force: true, source: "tray" }),
    },
    { type: "separator" },
    {
      label: "Set up Scrappy…",
      click: () => openSetupWindow(),
    },
    {
      label: "Wire up Cursor hooks",
      click: () => installCursorHooksNow(),
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
      label: "Check for updates",
      click: () => {
        checkForUpdates({ install: true, speak: true }).catch((err) => {
          console.warn("[update] check failed:", err.message);
        });
      },
    },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        processJournal.record({
          kind: "process",
          type: "quit",
          name: "scrappy",
          by: "tray",
          reason: "Quit from tray",
          pid: process.pid,
        });
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(prefs.visible ? "Scrappy is on — click if you need him" : "Scrappy — click to start");
}

// His face for the notification area. Built from the exact-size PNGs rather
// than from scrappy.ico: nativeImage loads an .ico's *largest* entry, so
// handing it the .ico means Windows downscales 256px to 16px and the eyes
// smear. One representation per DPI scale keeps them crisp.
// Regenerate the assets with `npm run build-icon`.
function trayIcon() {
  const at = (size) => path.join(__dirname, "assets", `scrappy-face-${size}.png`);
  const icon = nativeImage.createFromPath(at(16));
  if (icon.isEmpty()) return nativeImage.createEmpty();

  // 100% DPI wants 16px, 150% wants 24px, 200% wants 32px.
  for (const [scaleFactor, size] of [[1.5, 24], [2, 32]]) {
    try {
      const buf = fs.readFileSync(at(size));
      icon.addRepresentation({ scaleFactor, buffer: buf, width: size, height: size });
    } catch {
      // A missing hi-dpi variant just means Windows scales the 16px one.
    }
  }
  return icon;
}

function createTray() {
  if (process.platform === "win32" && ensureTrayHelper()) {
    // The helper owns the hidden-icons entry so it survives ending Electron.
    return;
  }
  const icon = trayIcon();
  tray = new Tray(icon);
  rebuildTray();
  tray.on("click", () => showScrappy());
  tray.on("double-click", () => showScrappy());
}

const TRAY_EXE = path.join(__dirname, "bin", "Scrappy.exe");
const TRAY_HOME = path.join(__dirname, "bin", "scrappy-home.txt");

function writeTrayHome() {
  const icon = path.join(__dirname, "assets", "scrappy.ico");
  const body =
    `projectRoot=${__dirname}\n` +
    `electronExe=${process.execPath}\n` +
    `iconPath=${icon}\n`;
  fs.mkdirSync(path.dirname(TRAY_HOME), { recursive: true });
  fs.writeFileSync(TRAY_HOME, body, "utf8");
}

function helperRunning() {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-Process -Name Scrappy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"],
      { encoding: "utf8", windowsHide: true, timeout: 4000 }
    );
    return Boolean(String(out || "").trim());
  } catch {
    return false;
  }
}

function ensureTrayHelper() {
  if (process.platform !== "win32") return false;
  if (!fs.existsSync(TRAY_EXE)) return false;
  writeTrayHome();
  if (!helperRunning()) {
    try {
      const child = spawn(TRAY_EXE, ["--no-launch"], {
        detached: true,
        stdio: "ignore",
        cwd: path.dirname(TRAY_EXE),
        windowsHide: true,
      });
      child.unref();
    } catch (err) {
      console.warn("[presence] could not start tray helper:", err.message);
      return false;
    }
  }
  return true;
}

// Windows only shows a tray icon while a process is alive. Electron is the
// wrong process for that — ending it in Task Manager would steal the icon.
// Shortcuts therefore launch bin/Scrappy.exe, a tiny helper that keeps the
// hidden-icons entry and can start Electron again.
function shortcutDetails() {
  const icon = path.join(__dirname, "assets", "scrappy.ico");
  const target = fs.existsSync(TRAY_EXE) ? TRAY_EXE : process.execPath;
  const details = {
    target,
    cwd: fs.existsSync(TRAY_EXE) ? path.dirname(TRAY_EXE) : __dirname,
    description: "Start Scrappy",
    icon: fs.existsSync(icon) ? icon : undefined,
    iconIndex: 0,
    appUserModelId: APP_ID,
  };
  if (target === process.execPath && !app.isPackaged) {
    details.args = `"${__dirname}"`;
    details.cwd = __dirname;
  }
  return details;
}

function writeShortcut(filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const op = fs.existsSync(filePath) ? "replace" : "create";
    const ok = shell.writeShortcutLink(filePath, op, shortcutDetails());
    if (!ok) console.warn("[presence] shortcut write returned false:", filePath);
  } catch (err) {
    console.warn("[presence] shortcut failed:", filePath, err.message);
  }
}

function ensureWindowsPresence() {
  if (process.platform !== "win32") return;
  app.setAppUserModelId(APP_ID);
  ensureTrayHelper();
  const programs = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
  const startup = path.join(programs, "Startup");
  writeShortcut(path.join(programs, "Scrappy.lnk"));
  writeShortcut(path.join(startup, "Scrappy.lnk"));
  for (const stale of ["Workbuddy.lnk", "Cog.lnk"]) {
    for (const dir of [programs, startup]) {
      const p = path.join(dir, stale);
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }
}

// Keep the notify icon in the overflow (^ hidden icons) rather than pinning
// it next to the clock. Windows creates the registry key after the first tray
// show, so this runs a moment later.
function keepTrayInHiddenIcons() {
  if (process.platform !== "win32") return;
  const paths = [process.execPath, TRAY_EXE].filter((p) => p && fs.existsSync(p));
  const list = paths.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(",");
  if (!list) return;
  const ps = `
    $want = @(${list})
    $base = 'HKCU:\\Control Panel\\NotifyIconSettings'
    if (-not (Test-Path $base)) { exit 0 }
    Get-ChildItem $base | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($p.ExecutablePath -and ($want -contains $p.ExecutablePath)) {
        New-ItemProperty -Path $_.PSPath -Name IsPromoted -Value 0 -PropertyType DWord -Force | Out-Null
      }
    }
  `;
  execFile("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], (err) => {
    if (err) console.warn("[tray] could not pin hidden-icon setting:", err.message);
  });
}

function maybeStartWake(by, reason) {
  if (!prefs.visible) return;
  if (!wakeWordEnabled()) return;
  const { apiKey, agentId } = voiceConfig();
  const localInstalled = fs.existsSync(
    path.join(__dirname, "local-voice", ".venv", "Scripts", "python.exe")
  );
  if (localInstalled || (apiKey && agentId)) {
    wakeListener.start(by, reason);
  }
}

function pushVisible() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("scrappy:set-visible", prefs.visible);
  if (!prefs.visible) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

function hideScrappy(by = "ui") {
  const wasVisible = prefs.visible;
  prefs.visible = false;
  if (wasVisible) savePrefs();
  // Never hide the overlay window itself. On Windows a transparent
  // frameless window grows a fake "Scrappy" title bar after hide/show.
  pushVisible();
  setCursorTrack(false);
  wakeListener.stop("main", "scrappy turned off");
  if (wasVisible) {
    processJournal.record({
      kind: "process",
      type: "hide",
      name: "scrappy",
      by,
      reason: "turned off",
    });
  }
  rebuildTray();
}

// Never steal focus — Scrappy is decoration until you click him.
function showScrappy() {
  const wasHidden = !prefs.visible;
  prefs.visible = true;
  if (wasHidden) {
    savePrefs();
    processJournal.record({
      kind: "process",
      type: "show",
      name: "scrappy",
      by: "ui",
      reason: "turned on",
    });
  }
  if (!mainWindow) {
    createWindow();
  } else {
    fitOverlay();
  }
  pushVisible();
  if (wasHidden) maybeStartWake("main", "scrappy turned on");
  rebuildTray();
}

function raiseOverlay() {
  if (!mainWindow) createWindow();
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.moveTop();
}

function calmOverlay() {
  if (!mainWindow) return;
  // The taskbar is itself a topmost window, so "floating" would put Scrappy
  // behind it and his dangling legs would vanish. This level clears it.
  mainWindow.setAlwaysOnTop(true, "screen-saver");
}

function fitOverlay() {
  pushLayout();
}

function triggerGrow(payload = {}) {
  if (!prefs.visible) {
    console.log("[scrappy] skipped nudge — turned off");
    return;
  }
  alerting = true;
  raiseOverlay();
  if (mainWindow) {
    mainWindow.webContents.send("scrappy:grow", {
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
    mainWindow.webContents.send("scrappy:ack", { at: Date.now() });
  }
}

// ---------- updates ----------
// The installer lives on the GitHub Release. Checking hits that API; installing
// downloads Scrappy-Setup-*.exe and runs it, then we quit so the new copy can
// take the folder.

function tellHim(text, kind = "update") {
  if (!text || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("scrappy:notice", { kind, text });
}

async function fetchLatestRelease() {
  const res = await fetch(appUpdate.RELEASES_LATEST, {
    headers: { "User-Agent": "scrappy", Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return { message: "Not Found" };
  if (!res.ok) throw new Error(`github ${res.status}`);
  return res.json();
}

async function downloadInstaller(url, name) {
  const dest = path.join(app.getPath("temp"), name || "Scrappy-Setup.exe");
  const res = await fetch(url, { headers: { "User-Agent": "scrappy" }, redirect: "follow" });
  if (!res.ok) throw new Error(`download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

async function checkForUpdates({ install = false, speak = true } = {}) {
  const current = app.getVersion();
  prefs.lastUpdateCheck = Date.now();
  savePrefs();
  let info;
  try {
    info = appUpdate.summarizeRelease(await fetchLatestRelease(), current);
  } catch (err) {
    if (speak) tellHim("Couldn't reach the update server. imscrappy.dev has the download.");
    return { ok: false, error: String(err.message || err), current };
  }
  if (!info.ok) {
    if (speak) tellHim("No installer is published yet. I'm this version until there is.");
    return info;
  }
  if (!info.newer) {
    if (speak) tellHim(`I'm current. ${info.current}.`);
    return info;
  }
  if (!install) {
    if (speak && prefs.lastUpdateTold !== info.latest) {
      prefs.lastUpdateTold = info.latest;
      savePrefs();
      tellHim(`There's a newer me — ${info.latest}. Right-click → Check for updates.`);
    }
    return info;
  }
  if (!info.downloadUrl) {
    if (speak) tellHim("There's a newer me. I opened the download page.");
    shell.openExternal(info.url || appUpdate.DOWNLOAD_PAGE);
    return info;
  }
  if (speak) tellHim(`Downloading ${info.latest}. I'll open the installer and step aside.`);
  try {
    const dest = await downloadInstaller(info.downloadUrl, info.downloadName);
    const opened = await shell.openPath(dest);
    if (opened) throw new Error(opened);
    app.isQuitting = true;
    setTimeout(() => app.quit(), 600);
    return { ...info, installing: true, dest };
  } catch (err) {
    if (speak) tellHim("Download failed. I opened the page instead.");
    shell.openExternal(info.url || appUpdate.DOWNLOAD_PAGE);
    return { ...info, error: String(err.message || err) };
  }
}

function scheduleQuietUpdateCheck() {
  const quietEvery = 20 * 60 * 60 * 1000;
  setTimeout(() => {
    if (Date.now() - (prefs.lastUpdateCheck || 0) < quietEvery) return;
    checkForUpdates({ install: false, speak: true }).catch((err) => {
      console.warn("[update] quiet check failed:", err.message);
    });
  }, 45000);
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
      const setting = settings.getLower("SCRAPPY_SYSTEM_CONTEXT", "on");
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
      const result = await saveScrappyChatSession(body);
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
    console.error("Scrappy server error:", err);
  });

  server.listen(PORT, HOST, () => {
    console.log(`Scrappy listening on http://${HOST}:${PORT}`);
  });
}

// ---------- the setup panel ----------
// A real window, because pasting an API key into a native menu is miserable.
// Fixed options still live in the menus; this handles anything you type.

let setupWindow = null;

function openSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 620,
    height: 760,
    title: "",
    frame: false,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    backgroundColor: "#0b0f18",
    show: false,
    // Unlike the overlay, this window is meant to be focused and typed into.
    webPreferences: {
      preload: path.join(__dirname, "setup", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  guardAgainstNativeChrome(setupWindow);
  // Opening this window used to restore Electron's default File/Edit/View/Help
  // menu on EVERY window — including the fullscreen overlay, which then drew
  // a white "Scrappy" bar across the top of the desktop.
  keepOverlayChromeOff();
  setupWindow.loadFile(path.join(__dirname, "setup", "index.html"));
  setupWindow.once("ready-to-show", () => {
    killNativeChrome(setupWindow);
    keepOverlayChromeOff();
    setupWindow.show();
  });
  setupWindow.on("closed", () => {
    setupWindow = null;
    keepOverlayChromeOff();
  });
}

ipcMain.on("scrappy:open-setup", () => openSetupWindow());

ipcMain.on("setup:close", () => {
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
});

ipcMain.handle("scrappy:user-name", () => settings.userName());

ipcMain.handle("scrappy:setup-status", () => ({
  configured: settings.isConfigured(),
  userName: settings.userName(),
}));

// The panel never receives a key — forPanel() reports secrets as booleans.
ipcMain.handle("setup:read", () => settings.forPanel());

ipcMain.handle("setup:write", (_event, patch) => {
  if (!patch || typeof patch !== "object") return { ok: false, error: "bad_patch" };
  const previousName = settings.userName();
  const ok = settings.setMany(patch);
  // A name change has to reach the modules that bake it into text, and the
  // rendered persona has to be rewritten or he keeps using the old one.
  applyUserName();
  persona.renderToFile(settings.userName(), app.getPath("userData"));
  if (settings.userName() !== previousName && localVoice.pid()) {
    localVoice.stop("user name changed", "setup");
    localVoice.start(localVoiceEnv(), { by: "setup", reason: "restart after name change" });
  }
  const recallExe = settings.get("RECALL_EXE", "");
  if (recallExe) process.env.RECALL_EXE = recallExe;
  else delete process.env.RECALL_EXE;
  rebuildTray();
  if (mainWindow) mainWindow.webContents.send("scrappy:settings-changed");
  return { ok, state: settings.forPanel() };
});

// Build the ElevenLabs agent from inside the app.
//
// scripts/setup-voice.js is plain node, so it cannot decrypt the settings store
// — a key typed into the panel would be invisible to it and `npm run
// setup-voice` would report no key at all. Rather than duplicate 500 lines of
// agent config, run that script as a child with the key handed to it in its
// environment. The CLI still works on its own for anyone using .env.local.
ipcMain.handle("setup:build-voice", async () => {
  const apiKey = settings.get("ELEVENLABS_API_KEY", "");
  if (!apiKey) return { ok: false, error: "no_key" };

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(__dirname, "scripts", "setup-voice.js")],
      {
        cwd: __dirname,
        timeout: 120000,
        env: {
          ...process.env,
          // ELECTRON_RUN_AS_NODE makes the bundled Electron binary behave as a
          // plain node, so there's no dependency on node being on PATH.
          ELECTRON_RUN_AS_NODE: "1",
          ELEVENLABS_API_KEY: apiKey,
          SCRAPPY_USER_NAME: settings.userName(),
        },
      },
      (err, stdout, stderr) => {
        const output = `${stdout || ""}${stderr || ""}`.trim();
        if (err) {
          resolve({ ok: false, error: "failed", output: output.slice(-1200) });
          return;
        }
        // setup-voice writes the new agent id into .env.local. That's still in
        // the read chain, but copy it into the store so there's one source of
        // truth going forward.
        settings.reload();
        const agentId = settings.readEnvFile().ELEVENLABS_AGENT_ID;
        if (agentId) settings.set("ELEVENLABS_AGENT_ID", agentId);
        resolve({ ok: true, output: output.slice(-1200), state: settings.forPanel() });
      }
    );
  });
});

ipcMain.handle("setup:clear-secret", (_event, key) => {
  if (!settings.SECRET_KEYS.has(key)) return { ok: false, error: "not_a_secret" };
  settings.set(key, "");
  rebuildTray();
  return { ok: true, state: settings.forPanel() };
});

ipcMain.on("scrappy:ack-from-ui", () => {
  triggerAck();
});

ipcMain.on("scrappy:hide", () => {
  hideScrappy("right-click");
});

ipcMain.on("scrappy:pref-visible", (event) => {
  event.returnValue = Boolean(prefs.visible);
});

ipcMain.handle("scrappy:check-updates", async () => {
  return checkForUpdates({ install: true, speak: true });
});

ipcMain.on("scrappy:quit", () => {
  app.isQuitting = true;
  processJournal.record({
    kind: "process",
    type: "quit",
    name: "scrappy",
    by: "right-click",
    reason: "Quit from Scrappy menu",
    pid: process.pid,
  });
  app.quit();
});

// What he can see about the machine. Off by one line if you'd rather he
// didn't: SCRAPPY_SYSTEM_CONTEXT=off in .env.local.
ipcMain.handle("scrappy:system-context", async () => {
  const setting = settings.getLower("SCRAPPY_SYSTEM_CONTEXT", "on");
  if (setting === "off" || setting === "false" || setting === "0") return { ok: false, error: "disabled" };
  try {
    return { ok: true, text: await systemInfo.snapshot() };
  } catch (err) {
    console.error("System snapshot failed:", err.message);
    return { ok: false, error: "failed" };
  }
});

// What the user has actually been thinking about, straight out of Recall.
ipcMain.handle("scrappy:recall-context", async () => {
  const setting = settings.getLower("SCRAPPY_RECALL", "on");
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
// (never dump hundreds of action rows — that truncates and Scrappy invents wrong totals).
async function buildRecallBrief(opts = {}) {
  const setting = settings.getLower("SCRAPPY_RECALL", "on");
  if (setting === "off" || setting === "false" || setting === "0") return { ok: false, error: "disabled" };
  const compact = Boolean(opts.compact);

  try {
    const [live, actions, recent, search] = await Promise.all([
      recall.call("recall_live_context", { minutes: compact ? 5 : 10 }),
      recall.call("recall_open_actions", { limit: compact ? 3 : 5 }),
      recall.call("recall_recent", { limit: compact ? 5 : 8, project: "Scrappy" }),
      recall.call("recall_search", {
        query: "the user preferences relationship Scrappy memory decisions",
        project: "Scrappy",
        limit: compact ? 5 : 8,
      }),
    ]);
    const parts = [];
    const recentMax = compact ? 1600 : 3500;
    const searchMax = compact ? 1600 : 3500;
    const liveMax = compact ? 900 : 2000;
    const actionsMax = compact ? 800 : 1500;
    const totalMax = compact ? 4500 : 12000;
    if (recent.ok && recent.text) parts.push(`Recent Scrappy/Scrappy notes:\n${clip(recent.text, recentMax)}`);
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

ipcMain.handle("scrappy:recall-brief", async () => buildRecallBrief());

async function runRecallTool(name, args) {
  const setting = settings.getLower("SCRAPPY_RECALL", "on");
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
        by: a.by || "scrappy",
        reason: a.reason || "scrappy process_note tool",
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
  const setting = settings.getLower("SCRAPPY_CURSOR_AGENTS", "on");
  if (setting === "off" || setting === "false" || setting === "0") {
    return { ok: false, error: "disabled", text: "Cursor agents are turned off." };
  }
  const apiKey = cursorAgents.readApiKey(cursorKeySource());
  const a = args && typeof args === "object" ? args : {};
  try {
    switch (String(action || "").trim()) {
      case "start": {
        const out = await cursorAgents.startAgent({
          goal: a.goal || a.prompt || a.message,
          kind: a.kind || "research",
          cwd: a.cwd || a.path || process.cwd(),
          mode: a.mode || process.env.SCRAPPY_CURSOR_MODE || file.SCRAPPY_CURSOR_MODE || "auto",
          apiKey,
        });
        if (out.ok && out.id) {
          recall
            .call("recall_save_note", {
              title: `Cursor ${out.kind || "agent"}: ${(a.goal || "").slice(0, 60)}`,
              summary: `Scrappy started a Cursor ${out.kind || "agent"}.\nId: ${out.id}\nRuntime: ${out.runtime}\nStatus: ${out.status}\nOpen: ${out.openUrl || "(local — use cursor_continue_agent)"}\n\nGoal:\n${a.goal || ""}`,
              tags: "scrappy,cursor,agent",
              project: "Scrappy",
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
ipcMain.handle("scrappy:recall-tool", async (_event, name, args) => runLocalTool(name, args));
ipcMain.handle("scrappy:local-tool", async (_event, name, args) => runLocalTool(name, args));

// Cursor planning/research agents — start, continue, list, status, open.
ipcMain.handle("scrappy:cursor-agent", async (_event, action, args) => runCursorAgentAction(action, args));

let lastScrappyChatFingerprint = "";
let lastScrappyChatAt = 0;

async function saveScrappyChatSession(body = {}) {
  const transcript = String(body.transcript || body.summary || "").trim();
  if (!transcript) return { ok: false, error: "empty" };
  const fingerprint = crypto
    .createHash("sha1")
    .update(transcript.slice(0, 3500).replace(/\s+/g, " ").trim())
    .digest("hex");
  const now = Date.now();
  // Local voice + renderer used to double-save the same chat within milliseconds.
  if (fingerprint === lastScrappyChatFingerprint && now - lastScrappyChatAt < 120000) {
    return { ok: true, deduped: true, fingerprint };
  }
  const title =
    String(body.title || "").trim() ||
    `Scrappy chat ${new Date().toLocaleString("en-CA", { hour12: false }).slice(0, 16)}`;
  const summary = String(body.summary || transcript).slice(0, 3500);
  const result = await runRecallTool("recall_save_note", {
    title,
    summary,
    tags: ["scrappy", "conversation", "relationship"],
    project: "Scrappy",
  });
  if (result && result.ok !== false) {
    lastScrappyChatFingerprint = fingerprint;
    lastScrappyChatAt = now;
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

// Read the user's other Cursor chats (local conversation index + transcripts).
ipcMain.handle("scrappy:cursor-chats", async (_event, action, args) => {
  const setting = settings.getLower("SCRAPPY_CURSOR_CHATS", "on");
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

ipcMain.handle("scrappy:voice-signed-url", () => resolveVoiceSession());

ipcMain.handle("scrappy:voice-status", async () => {
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

ipcMain.on("scrappy:wake-pause", () => {
  wakeListener.pause("renderer", "pause for voice call");
});

ipcMain.on("scrappy:wake-resume", () => {
  wakeListener.resume("renderer", "resume after voice call");
});

ipcMain.handle("scrappy:process-note", (_event, text) => {
  return processJournal.note(text, { by: "ui", reason: "from Scrappy UI" });
});

ipcMain.handle("scrappy:process-event", (_event, event) => {
  const result = processJournal.record(event || {});
  if (event && event.session_id) {
    conversationStore.recordEvent(event.session_id, event);
  }
  return result;
});

ipcMain.handle("scrappy:conversation-start", (_event, info = {}) => {
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

ipcMain.handle("scrappy:conversation-event", (_event, sessionId, event) => {
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

ipcMain.handle("scrappy:conversation-end", (_event, sessionId, extra = {}) => {
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

ipcMain.handle("scrappy:process-recent", (_event, limit) => {
  return { ok: true, events: processJournal.recent(limit || 80), dir: processJournal.dir() };
});

// The overlay is deliberately non-focusable so clicking Scrappy never pulls focus
// off your editor — but a text box needs keystrokes, so focus is granted for
// exactly as long as the chat is open.
ipcMain.on("scrappy:chat-focus", (_event, on) => {
  if (!mainWindow) return;
  mainWindow.setFocusable(Boolean(on));
  keepOverlayChromeOff();
  if (on) mainWindow.focus();
  keepOverlayChromeOff();
});

ipcMain.on("scrappy:set-interactive", (_event, interactive) => {
  if (!mainWindow) return;
  if (interactive) mainWindow.setIgnoreMouseEvents(false);
  else mainWindow.setIgnoreMouseEvents(true, { forward: true });
  keepOverlayChromeOff();
});

// While he is hunting or clinging, poll the real cursor so he can follow it
// even though the overlay stays click-through.
let cursorTimer = null;
function setCursorTrack(on) {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
  if (!on) return;
  cursorTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    const b = mainWindow.getBounds();
    mainWindow.webContents.send("scrappy:cursor", { x: pt.x - b.x, y: pt.y - b.y });
  }, 16);
}

ipcMain.on("scrappy:track-cursor", (_event, on) => {
  setCursorTrack(Boolean(on));
});

ipcMain.on("scrappy:test-grow", () => {
  triggerGrow({ force: true, source: "ui-test" });
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.setName("Scrappy");
  app.setAppUserModelId(APP_ID);
  app.on("second-instance", () => {
    showScrappy();
  });

  app.on("browser-window-created", (_event, win) => {
    killNativeChrome(win);
  });

  app.whenReady().then(() => {
    killAppMenu();
    loadPrefs();
    ensureWindowsPresence();
    ensureToken();
    // Tell everything who it's talking to before anything can write a log line
    // or build a prompt with the wrong name in it.
    applyUserName();
    const recallExe = settings.get("RECALL_EXE", "");
    if (recallExe) process.env.RECALL_EXE = recallExe;
    const writableRoot = app.isPackaged ? app.getPath("userData") : __dirname;
    processJournal.init({ projectRoot: writableRoot, userName: settings.userName() });
    conversationStore.init({
      projectRoot: writableRoot,
      userData: app.getPath("userData"),
      userName: settings.userName(),
    });
    localVoice.setJournal(processJournal);
    wakeListener.setJournal(processJournal);
    processJournal.started("scrappy", {
      pid: process.pid,
      by: "main",
      reason: "Electron app ready",
      meta: { voiceBackend: voiceBackendPref() },
    });

    // Scrappy needs the microphone to hold a conversation; nothing else.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === "media" || permission === "audioCapture");
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      return permission === "media" || permission === "audioCapture";
    });

    createWindow();
    createTray();
    setTimeout(keepTrayInHiddenIcons, 2500);
    scheduleQuietUpdateCheck();
    startServer();
    installCursorHooksNow();

    // Prefer local AMD voice when configured; still start wake word either way.
    const pref = voiceBackendPref();
    if (pref === "local" || pref === "auto") {
      localVoice.start(localVoiceEnv(), { by: "main", reason: "startup local voice" });
    }

    wakeListener.init({
      onWake(phrase) {
        if (!prefs.visible) return;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send("scrappy:wake", { phrase });
      },
    });
    if (prefs.visible) maybeStartWake("main", "startup wake word");
    const cursorKey = cursorAgents.readApiKey(cursorKeySource());
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
      name: "scrappy",
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
