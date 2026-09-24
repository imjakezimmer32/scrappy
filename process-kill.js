// Kill a spawned process and its children (Windows voice/wake/recall stacks).

const { spawn } = require("child_process");

function killProcessTree(proc, { force = true } = {}) {
  if (!proc || !proc.pid) return;
  try {
    proc.stdout?.removeAllListeners();
    proc.stderr?.removeAllListeners();
    proc.removeAllListeners();
  } catch {
    /* ignore */
  }
  try {
    if (process.platform === "win32") {
      const flags = force ? ["/F"] : [];
      spawn("taskkill", ["/pid", String(proc.pid), "/T", ...flags], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      proc.kill(force ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { killProcessTree };
