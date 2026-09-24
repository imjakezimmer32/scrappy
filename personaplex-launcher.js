// Local Opus bridge only — PersonaPlex GPU inference runs on your cloud server.

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { killProcessTree } = require("./process-kill");

const ROOT = path.join(__dirname);
const BRIDGE_DIR = path.join(ROOT, "personaplex-bridge");
const VENV_PY = path.join(BRIDGE_DIR, ".venv", "Scripts", "python.exe");
const BRIDGE_SERVER = path.join(BRIDGE_DIR, "server.py");
const HOST = "127.0.0.1";
const BRIDGE_PORT = Number(process.env.SCRAPPY_PERSONAPLEX_BRIDGE_PORT || 8792);

let bridgeChild = null;
let wanted = false;
let journal = null;
let lastEnv = {};

function setJournal(j) {
  journal = j;
}

function log(...args) {
  console.log("[personaplex]", ...args);
}

function bridgeInstalled() {
  return fs.existsSync(VENV_PY) && fs.existsSync(BRIDGE_SERVER);
}

function cloudUrlConfigured(env) {
  return Boolean(String((env && env.PERSONAPLEX_SERVER_URL) || "").trim());
}

function bridgeHealth() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: HOST, port: BRIDGE_PORT, path: "/health", timeout: 1500 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve({ ok: res.statusCode === 200, ...JSON.parse(body) });
          } catch {
            resolve({ ok: res.statusCode === 200 });
          }
        });
      }
    );
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}

function stop(reason = "stop", by = "main") {
  wanted = false;
  if (bridgeChild) {
    if (journal) journal.killed("personaplex-bridge", { pid: bridgeChild.pid, by, reason });
    killProcessTree(bridgeChild);
  }
  bridgeChild = null;
  return { ok: true };
}

function startBridge(env) {
  if (!bridgeInstalled()) {
    return { ok: false, error: "personaplex_bridge_not_installed" };
  }
  if (bridgeChild) return { ok: true, already: true, pid: bridgeChild.pid };

  const childEnv = {
    ...process.env,
    ...env,
    SCRAPPY_PERSONAPLEX_BRIDGE_HOST: HOST,
    SCRAPPY_PERSONAPLEX_BRIDGE_PORT: String(BRIDGE_PORT),
    PYTHONUTF8: "1",
  };

  bridgeChild = spawn(VENV_PY, [BRIDGE_SERVER], {
    cwd: BRIDGE_DIR,
    env: childEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = bridgeChild.pid;
  bridgeChild.stdout.on("data", (c) => log(String(c).trim()));
  bridgeChild.stderr.on("data", (c) => console.warn(String(c).trim()));
  bridgeChild.on("exit", (code) => {
    if (bridgeChild && bridgeChild.pid === pid) bridgeChild = null;
    log("bridge exited", code);
  });
  return { ok: true, pid };
}

function start(env = {}) {
  wanted = true;
  lastEnv = env || {};
  if (!cloudUrlConfigured(env)) {
    return { ok: false, error: "personaplex_cloud_url_missing" };
  }
  const bridge = startBridge(env);
  if (!bridge.ok) return bridge;
  return { ok: true, url: wsUrl(), cloud: true };
}

async function waitReady(ms = 120000) {
  const startAt = Date.now();
  while (Date.now() - startAt < ms) {
    if (!wanted) return { ok: false, error: "stopped" };
    const h = await bridgeHealth();
    if (h.ok && h.ready) return h;
    await new Promise((r) => setTimeout(r, 800));
  }
  return { ok: false, error: "personaplex_timeout" };
}

function wsUrl() {
  return `ws://${HOST}:${BRIDGE_PORT}/v1/voice`;
}

function pid() {
  return bridgeChild ? bridgeChild.pid : null;
}

module.exports = {
  start,
  stop,
  health: bridgeHealth,
  waitReady,
  wsUrl,
  setJournal,
  bridgeInstalled,
  cloudUrlConfigured,
  pid,
  BRIDGE_PORT,
};
