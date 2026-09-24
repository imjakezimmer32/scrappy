// First-run, live settings apply, staged updates, and local voice install — kept
// out of main.js so the lifecycle is testable.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const appUpdate = require("./app-update");

function pendingUpdateValid(prefs) {
  const pending = prefs && prefs.pendingUpdate;
  if (!pending || !pending.path || !pending.version) return false;
  try {
    return fs.existsSync(pending.path);
  } catch {
    return false;
  }
}

function clearPendingUpdate(prefs) {
  if (!prefs.pendingUpdate) return;
  const file = prefs.pendingUpdate.path;
  prefs.pendingUpdate = null;
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

function stashPendingUpdate(prefs, { version, dest }) {
  prefs.pendingUpdate = {
    version: String(version || ""),
    path: String(dest || ""),
    downloadedAt: Date.now(),
  };
}

function shouldOpenSetupIntro(prefs, configured) {
  if (configured) return false;
  if (prefs && prefs.setupIntroduced) return false;
  return true;
}

function markSetupIntroduced(prefs) {
  prefs.setupIntroduced = true;
}

function localVoiceInstalled(repoRoot) {
  return fs.existsSync(
    path.join(repoRoot, "local-voice", ".venv", "Scripts", "python.exe")
  );
}

function runLocalVoiceInstaller(repoRoot, { timeoutMs = 45 * 60 * 1000 } = {}) {
  const script = path.join(repoRoot, "scripts", "setup-local-voice.ps1");
  if (!fs.existsSync(script)) {
    return Promise.resolve({ ok: false, error: "script_missing" });
  }
  return new Promise((resolve) => {
    const lines = [];
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      {
        cwd: repoRoot,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: "timeout", output: lines.join("\n").slice(-4000) });
    }, timeoutMs);
    const onData = (chunk) => {
      String(chunk)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => lines.push(line));
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(err.message || err), output: lines.join("\n") });
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      const output = lines.join("\n").slice(-4000);
      if (code === 0 && localVoiceInstalled(repoRoot)) {
        resolve({ ok: true, output });
        return;
      }
      resolve({
        ok: false,
        error: code === 0 ? "install_incomplete" : `exit_${code}`,
        output,
      });
    });
  });
}

function summarizePendingForTray(prefs, currentVersion) {
  if (!pendingUpdateValid(prefs)) return null;
  const v = prefs.pendingUpdate.version;
  if (!appUpdate.isNewer(v, currentVersion)) {
    return null;
  }
  return prefs.pendingUpdate;
}

module.exports = {
  pendingUpdateValid,
  clearPendingUpdate,
  stashPendingUpdate,
  shouldOpenSetupIntro,
  markSetupIntroduced,
  localVoiceInstalled,
  runLocalVoiceInstaller,
  summarizePendingForTray,
};
