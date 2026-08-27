// Silent updates when Scrappy is not in a conversation.
//
// Packaged installs use electron-updater + GitHub Releases.
// Git checkouts (the tray launching Electron against a clone) fast-forward
// relaunch. Never pull a dirty tree or a branch that isn't main.

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const SETTLE_MS = Number(process.env.SCRAPPY_UPDATE_SETTLE_MS || 20_000);
const CHECK_EVERY_MS = Number(process.env.SCRAPPY_UPDATE_CHECK_MS || 4 * 60 * 60 * 1000);
const STARTUP_DELAY_MS = Number(process.env.SCRAPPY_UPDATE_STARTUP_MS || 90_000);

function enabled() {
  const raw = String(process.env.SCRAPPY_AUTO_UPDATE || "on").trim().toLowerCase();
  return raw !== "off" && raw !== "0" && raw !== "false";
}

function inConversation({ conversationId, chatFocused, setupOpen } = {}) {
  return Boolean(conversationId || chatFocused || setupOpen);
}

function isGitCheckout(root) {
  try {
    return fs.existsSync(path.join(root, ".git"));
  } catch {
    return false;
  }
}

function runGit(root, args, exec = execFile) {
  return new Promise((resolve) => {
    exec("git", args, { cwd: root, timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
        error: err ? err.message : "",
      });
    });
  });
}

function lockfilePath(root) {
  return path.join(root, "package-lock.json");
}

function lockStamp(root) {
  try {
    const st = fs.statSync(lockfilePath(root));
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
}

async function inspectGit(root, exec = execFile) {
  if (!isGitCheckout(root)) return { kind: "none", updatable: false, reason: "not_git" };
  const git = (args) => runGit(root, args, exec);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) return { kind: "git", updatable: false, reason: "rev_parse_failed", error: branch.error };
  if (branch.stdout !== "main") {
    return { kind: "git", updatable: false, reason: "not_main", branch: branch.stdout };
  }
  const dirty = await git(["status", "--porcelain"]);
  if (!dirty.ok) return { kind: "git", updatable: false, reason: "status_failed", error: dirty.error };
  if (dirty.stdout) return { kind: "git", updatable: false, reason: "dirty" };
  const fetch = await git(["fetch", "origin", "main"]);
  if (!fetch.ok) return { kind: "git", updatable: false, reason: "fetch_failed", error: fetch.error || fetch.stderr };
  const local = await git(["rev-parse", "HEAD"]);
  const remote = await git(["rev-parse", "origin/main"]);
  if (!local.ok || !remote.ok || !remote.stdout) {
    return { kind: "git", updatable: false, reason: "rev_failed" };
  }
  if (local.stdout === remote.stdout) {
    return { kind: "git", updatable: false, reason: "current", from: local.stdout };
  }
  const base = await git(["merge-base", "HEAD", "origin/main"]);
  if (!base.ok || base.stdout !== local.stdout) {
    return { kind: "git", updatable: false, reason: "diverged", from: local.stdout, to: remote.stdout };
  }
  return {
    kind: "git",
    updatable: true,
    from: local.stdout,
    to: remote.stdout,
    lock: lockStamp(root),
  };
}

async function pullFastForward(root, exec = execFile) {
  return runGit(root, ["pull", "--ff-only", "origin", "main"], exec);
}

function npmCi(root, exec = execFile) {
  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve) => {
    exec(
      cmd,
      ["ci"],
      { cwd: root, timeout: 300_000, windowsHide: true, shell: process.platform === "win32" },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
          error: err ? err.message : "",
        });
      }
    );
  });
}

function needsNpmCi(root, beforeLock) {
  return lockStamp(root) !== beforeLock;
}

module.exports = {
  SETTLE_MS,
  CHECK_EVERY_MS,
  STARTUP_DELAY_MS,
  enabled,
  inConversation,
  isGitCheckout,
  inspectGit,
  pullFastForward,
  npmCi,
  needsNpmCi,
  lockStamp,
};
