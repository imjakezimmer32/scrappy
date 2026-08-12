// Spawns and watches the local AMD voice server (Python FastAPI).

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const ROOT = path.join(__dirname);
const VOICE_DIR = path.join(ROOT, "local-voice");
const VENV_PY = path.join(VOICE_DIR, ".venv", "Scripts", "python.exe");
const SERVER = path.join(VOICE_DIR, "server.py");
const HOST = "127.0.0.1";
const PORT = Number(process.env.COG_VOICE_PORT || 8790);

let child = null;
let wanted = false;
let restartTimer = null;
let journal = null;
let lastEnv = {};

function setJournal(j) {
  journal = j;
}

function log(...args) {
  console.log("[local-voice]", ...args);
}

function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: "/health", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode === 200, ...JSON.parse(body) });
        } catch {
          resolve({ ok: res.statusCode === 200 });
        }
      });
    });
    req.on("error", () => resolve({ ok: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false });
    });
  });
}

function clearRestart() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function stop(reason = "stop requested", by = "main") {
  wanted = false;
  clearRestart();
  if (!child) {
    if (journal) {
      journal.stopped("local-voice", { by, reason: `${reason} (already stopped)` });
    }
    return { ok: true, already: true };
  }
  const proc = child;
  const pid = proc.pid;
  child = null;
  if (journal) {
    journal.killed("local-voice", { pid, by, reason });
  }
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  return { ok: true, killed: pid };
}

function start(env = {}, opts = {}) {
  const by = opts.by || "main";
  const reason = opts.reason || "start local voice";
  wanted = true;
  lastEnv = env || {};
  if (child) {
    if (journal) {
      journal.record({
        kind: "process",
        type: "start_skipped",
        name: "local-voice",
        pid: child.pid,
        by,
        reason: "already running",
      });
    }
    return { ok: true, already: true, pid: child.pid };
  }

  if (!fs.existsSync(VENV_PY) || !fs.existsSync(SERVER)) {
    log("not installed — run: powershell -File scripts/setup-local-voice.ps1");
    if (journal) {
      journal.record({
        kind: "process",
        type: "start_failed",
        name: "local-voice",
        by,
        reason: "not_installed",
      });
    }
    return { ok: false, error: "not_installed" };
  }

  const childEnv = {
    ...process.env,
    ...env,
    COG_VOICE_HOST: HOST,
    COG_VOICE_PORT: String(PORT),
    PYTHONUTF8: "1",
  };

  child = spawn(VENV_PY, [SERVER], {
    cwd: VOICE_DIR,
    env: childEnv,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pid = child.pid;
  if (journal) {
    journal.started("local-voice", {
      pid,
      by,
      reason,
      meta: {
        model: env.OLLAMA_MODEL || null,
        thinkModel: env.OLLAMA_THINK_MODEL || null,
        port: PORT,
      },
    });
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    String(chunk)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => console.log(line));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    String(chunk)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => console.warn(line));
  });
  child.on("exit", (code) => {
    const wasWanted = wanted;
    const exitedPid = pid;
    if (child) child = null;
    log("exited", code);
    if (journal) {
      journal.exited("local-voice", {
        pid: exitedPid,
        code,
        by: "self",
        reason: wasWanted ? "unexpected exit" : "stopped",
      });
    }
    if (!wasWanted) return;
    clearRestart();
    if (journal) {
      journal.restartScheduled("local-voice", {
        by: "auto-restart",
        reason: `exited with code ${code}; restarting in 2s`,
      });
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start(lastEnv, { by: "auto-restart", reason: `respawn after exit ${code}` });
    }, 2000);
  });

  return { ok: true, url: `ws://${HOST}:${PORT}/v1/voice`, pid };
}

async function waitReady(ms = 90000) {
  const startAt = Date.now();
  while (Date.now() - startAt < ms) {
    const h = await health();
    if (h.ok) return h;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, error: "timeout" };
}

function wsUrl() {
  return `ws://${HOST}:${PORT}/v1/voice`;
}

function pid() {
  return child ? child.pid : null;
}

module.exports = {
  start,
  stop,
  health,
  waitReady,
  wsUrl,
  setJournal,
  pid,
  PORT,
};
