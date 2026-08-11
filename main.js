const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, session } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const systemInfo = require("./system-info");
const recall = require("./recall-mcp");
const cursorAgents = require("./cursor-agents");
const cursorChats = require("./cursor-chats");

const PORT = 8787;
const HOST = "127.0.0.1";
const MIN_DURATION_MS = 2 * 60 * 1000;
const TOKEN_PATH = path.join(app.getPath("userData"), "local-token.txt");

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

function voiceConfig() {
  const file = readEnvFile();
  return {
    apiKey: process.env.ELEVENLABS_API_KEY || file.ELEVENLABS_API_KEY || "",
    agentId: process.env.ELEVENLABS_AGENT_ID || file.ELEVENLABS_AGENT_ID || "",
  };
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
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": apiKey } }
    );
    if (!res.ok) {
      return { ok: false, error: `elevenlabs_${res.status}` };
    }
    const data = await res.json();
    if (!data.signed_url) return { ok: false, error: "no_signed_url" };
    return { ok: true, url: data.signed_url };
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

function createTray() {
  // Tiny amber dot icon (16x16 PNG)
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPUlEQVQ4T2NkYGD4z0ABYBzVMKoBAzQA5v8MDAyM/ylIMzIyMjL8Z2Bg+E+BZgbG0QyAacB/BiYGRsYoGgAA3zQEAa0x0oUAAAAASUVORK5CYII="
  );
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Workbuddy");
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
      label: "Test nudge",
      click: () => triggerGrow({ force: true, source: "tray" }),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
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
      let durationMs = null;
      if (typeof body.durationMs === "number") durationMs = body.durationMs;
      else if (typeof body.duration_minutes === "number") durationMs = body.duration_minutes * 60 * 1000;
      else if (typeof body.durationMinutes === "number") durationMs = body.durationMinutes * 60 * 1000;
      else if (typeof body.startedAt === "number") durationMs = Date.now() - body.startedAt;

      if (!force && (durationMs == null || durationMs < MIN_DURATION_MS)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            skipped: true,
            reason: "too_short",
            durationMs,
            minDurationMs: MIN_DURATION_MS,
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
ipcMain.handle("workbuddy:recall-brief", async () => {
  const file = readEnvFile();
  const setting = (process.env.COG_RECALL || file.COG_RECALL || "on").toLowerCase();
  if (setting === "off" || setting === "false" || setting === "0") return { ok: false, error: "disabled" };

  try {
    const [live, actions, recent, search] = await Promise.all([
      recall.call("recall_live_context", { minutes: 10 }),
      recall.call("recall_open_actions", { limit: 5 }),
      recall.call("recall_recent", { limit: 8, project: "WorkBuddy" }),
      recall.call("recall_search", {
        query: "Jake preferences relationship Cog memory decisions",
        project: "WorkBuddy",
        limit: 8,
      }),
    ]);
    const parts = [];
    if (recent.ok && recent.text) parts.push(`Recent WorkBuddy/Cog notes:\n${clip(recent.text, 3500)}`);
    if (search.ok && search.text) parts.push(`Related memory search:\n${clip(search.text, 3500)}`);
    if (live.ok && live.text) parts.push(`Recently said out loud:\n${clip(live.text, 2000)}`);
    if (actions.ok && actions.data) {
      parts.push(formatActionsBrief(actions.data));
    } else if (actions.ok && actions.text) {
      parts.push(`Open tasks summary:\n${clip(actions.text, 1500)}`);
    }
    if (!parts.length) return { ok: false, error: "empty" };
    return {
      ok: true,
      text: parts.join("\n\n").slice(0, 12000),
    };
  } catch (err) {
    console.error("Recall brief failed:", err.message);
    return { ok: false, error: "failed" };
  }
});

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

// Generic Recall MCP tool call for ElevenLabs client tools.
ipcMain.handle("workbuddy:recall-tool", async (_event, name, args) => {
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
});

// Cursor planning/research agents — start, continue, list, status, open.
ipcMain.handle("workbuddy:cursor-agent", async (_event, action, args) => {
  const file = readEnvFile();
  const setting = (process.env.COG_CURSOR_AGENTS || file.COG_CURSOR_AGENTS || "on").toLowerCase();
  if (setting === "off" || setting === "false" || setting === "0") {
    return { ok: false, error: "disabled" };
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
        // Quietly file a pointer note in Recall when available.
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
        return out;
      }
      case "continue":
        return await cursorAgents.continueAgent({
          id: a.id || a.agent_id,
          message: a.message || a.prompt || a.goal,
          apiKey,
        });
      case "status":
        if (a.detailed || a.live || a.refresh) {
          return await cursorAgents.agentStatusDetailed({
            id: a.id || a.agent_id,
            apiKey,
          });
        }
        return cursorAgents.agentStatus(a.id || a.agent_id);
      case "details":
        return await cursorAgents.agentStatusDetailed({
          id: a.id || a.agent_id,
          apiKey,
        });
      case "list":
        return {
          ok: true,
          agents: cursorAgents.listAgents({
            limit: asInt(a.limit) || 10,
            status: a.status,
            kind: a.kind,
            runtime: a.runtime,
            runningOnly: asBool(a.running_only || a.runningOnly),
            search: a.search || a.query,
          }),
        };
      case "running":
        return {
          ok: true,
          agents: cursorAgents.listAgents({
            limit: asInt(a.limit) || 10,
            runningOnly: true,
          }),
        };
      case "list_cloud":
        return await cursorAgents.listCloudAgents({
          limit: asInt(a.limit) || 15,
          includeArchived: asBool(a.include_archived || a.includeArchived),
          apiKey,
        });
      case "open":
        return cursorAgents.openAgentInBrowser(a.id || a.agent_id);
      case "stop":
        return await cursorAgents.stopAgent({
          id: a.id || a.agent_id,
          apiKey,
        });
      case "pause":
        return await cursorAgents.pauseAgent({
          id: a.id || a.agent_id,
          apiKey,
        });
      case "restart":
        return await cursorAgents.restartAgent({
          id: a.id || a.agent_id,
          message: a.message || a.prompt || a.goal,
          apiKey,
        });
      case "archive":
        return await cursorAgents.archiveAgent({
          id: a.id || a.agent_id,
          apiKey,
        });
      case "unarchive":
        return await cursorAgents.unarchiveAgent({
          id: a.id || a.agent_id,
          apiKey,
        });
      case "delete":
        return await cursorAgents.deleteAgent({
          id: a.id || a.agent_id,
          confirm: asBool(a.confirm),
          apiKey,
        });
      default:
        return { ok: false, error: "unknown_action" };
    }
  } catch (err) {
    console.error("Cursor agent action failed:", action, err.message);
    return { ok: false, error: err.message || "failed" };
  }
});

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

ipcMain.handle("workbuddy:voice-signed-url", () => fetchSignedUrl());

ipcMain.handle("workbuddy:voice-status", () => {
  const { apiKey, agentId } = voiceConfig();
  return {
    configured: Boolean(apiKey && agentId),
    hasKey: Boolean(apiKey),
    hasAgent: Boolean(agentId),
    hasPersonality: personalityPresent(),
  };
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
    if (topKeeper) clearInterval(topKeeper);
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
