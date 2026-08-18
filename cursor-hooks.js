// Installs the Cursor hooks that ping Scrappy when an agent finishes.
// Works from a git checkout *and* from the packaged Windows app — the scripts
// are read out of this repo (or the asar) and written into ~/.cursor/hooks.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SESSION_START = `$ErrorActionPreference = "SilentlyContinue"
$startPath = Join-Path $env:USERPROFILE ".cursor\\hooks\\scrappy-session-start.txt"
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() | Set-Content -Path $startPath -NoNewline -Encoding UTF8
exit 0
`;

const SUBAGENT_START = `$ErrorActionPreference = "SilentlyContinue"
$startPath = Join-Path $env:USERPROFILE ".cursor\\hooks\\scrappy-subagent-start.txt"
[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString() | Set-Content -Path $startPath -NoNewline -Encoding UTF8
exit 0
`;

const HOOK_CMDS = {
  sessionStart: 'powershell -NoProfile -ExecutionPolicy Bypass -File "./hooks/scrappy-session-start.ps1"',
  subagentStart: 'powershell -NoProfile -ExecutionPolicy Bypass -File "./hooks/scrappy-subagent-start.ps1"',
  stop: 'powershell -NoProfile -ExecutionPolicy Bypass -File "./hooks/scrappy-agent-done.ps1"',
  subagentStop: 'powershell -NoProfile -ExecutionPolicy Bypass -File "./hooks/scrappy-agent-done.ps1"',
};

function hooksDir(home = os.homedir()) {
  return path.join(home, ".cursor", "hooks");
}

function hooksJsonPath(home = os.homedir()) {
  return path.join(home, ".cursor", "hooks.json");
}

function commandOf(item) {
  if (typeof item === "string") return item;
  if (item && typeof item.command === "string") return item.command;
  return "";
}

function mergeHooks(existing, commands = HOOK_CMDS) {
  const version = Number(existing && existing.version) || 1;
  const prev = (existing && existing.hooks) || {};
  const hooks = {};
  for (const [name, command] of Object.entries(commands)) {
    const kept = [];
    for (const item of Array.isArray(prev[name]) ? prev[name] : []) {
      const cmd = commandOf(item);
      if (cmd && !/scrappy-/.test(cmd)) kept.push({ command: cmd });
    }
    kept.push({ command });
    hooks[name] = kept;
  }
  // Keep any other hook names the user already had.
  for (const [name, list] of Object.entries(prev)) {
    if (hooks[name]) continue;
    hooks[name] = Array.isArray(list) ? list : [];
  }
  return { version, hooks };
}

function install({ token, home = os.homedir(), scriptsDir = path.join(__dirname, "scripts") } = {}) {
  const dir = hooksDir(home);
  fs.mkdirSync(dir, { recursive: true });

  const doneSrc = path.join(scriptsDir, "scrappy-agent-done.ps1");
  if (!fs.existsSync(doneSrc)) {
    return { ok: false, error: "missing_hook_script" };
  }
  fs.copyFileSync(doneSrc, path.join(dir, "scrappy-agent-done.ps1"));
  fs.writeFileSync(path.join(dir, "scrappy-session-start.ps1"), SESSION_START, "utf8");
  fs.writeFileSync(path.join(dir, "scrappy-subagent-start.ps1"), SUBAGENT_START, "utf8");

  if (token) {
    fs.writeFileSync(path.join(dir, "scrappy-token.txt"), String(token), "utf8");
  }

  const jsonPath = hooksJsonPath(home);
  let existing = {};
  if (fs.existsSync(jsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch {
      existing = {};
    }
  }
  const next = mergeHooks(existing);
  fs.writeFileSync(jsonPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  return { ok: true, hooksDir: dir, hooksJson: jsonPath };
}

module.exports = { install, mergeHooks, hooksDir, hooksJsonPath, HOOK_CMDS };
