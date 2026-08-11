const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen } = require("electron");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

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

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 280;
  const height = 340;
  const x = Math.round(workArea.x + workArea.width - width - 24);
  const y = Math.round(workArea.y + workArea.height - height - 24);

  mainWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true,
    backgroundColor: "#1c1917",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

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
      label: "Show buddy",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    {
      label: "Test grow",
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
  tray.on("click", () => {
    if (!mainWindow) createWindow();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function expandWindowForAlert() {
  if (!mainWindow) createWindow();
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(520, workArea.width - 40);
  const height = Math.min(620, workArea.height - 40);
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);
  mainWindow.setBounds({ x, y, width, height });
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();
}

function shrinkWindowCalm() {
  if (!mainWindow) return;
  const { workArea } = screen.getPrimaryDisplay();
  const width = 280;
  const height = 340;
  const x = Math.round(workArea.x + workArea.width - width - 24);
  const y = Math.round(workArea.y + workArea.height - height - 24);
  mainWindow.setBounds({ x, y, width, height });
}

function triggerGrow(payload = {}) {
  alerting = true;
  expandWindowForAlert();
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
  shrinkWindowCalm();
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
      res.end(JSON.stringify({ ok: true, alerting }));
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

ipcMain.on("workbuddy:test-grow", () => {
  triggerGrow({ force: true, source: "ui-test" });
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    ensureToken();
    createWindow();
    createTray();
    startServer();
  });

  app.on("window-all-closed", (e) => {
    // Stay running in tray on Windows
    e.preventDefault();
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    if (server) {
      try {
        server.close();
      } catch {
        // ignore
      }
    }
  });
}
