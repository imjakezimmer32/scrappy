// Offline "Hey Cog" wake word using Windows System.Speech (no cloud, no API key).
// Spawns a small PowerShell loop that listens for a short grammar and prints WAKE lines.

const { spawn } = require("child_process");
const path = require("path");

const PHRASES = [
  // Longer phrases resist cough/throat-clear false wakes.
  "hey there cog",
  "okay then cog",
  "wake up cog",
];

const MIN_CONFIDENCE = 0.8;

let child = null;
let paused = false;
let wanted = false;
let onWake = null;
let restartTimer = null;
let lastWakeAt = 0;

function buildScript() {
  const choices = PHRASES.map((p) => p.replace(/'/g, "''")).map((p) => `'${p}'`).join(",");
  // RecognizeAsync would be nicer, but a blocking Recognize loop is simple and
  // releases the mic between attempts so ElevenLabs can take over cleanly.
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$phrases = @(${choices})
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
try {
  $engine.SetInputToDefaultAudioDevice()
} catch {
  Write-Output "WAKE_ERR:no-mic"
  exit 1
}
$choices = New-Object System.Speech.Recognition.Choices
foreach ($p in $phrases) { [void]$choices.Add($p) }
$gb = New-Object System.Speech.Recognition.GrammarBuilder
$gb.Append($choices)
$grammar = New-Object System.Speech.Recognition.Grammar($gb)
$engine.LoadGrammar($grammar)
$engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(3)
$engine.BabbleTimeout = [TimeSpan]::FromSeconds(2)
$engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(500)
Write-Output "WAKE_READY"
[Console]::Out.Flush()
while ($true) {
  try {
    $result = $engine.Recognize([TimeSpan]::FromSeconds(8))
    if ($null -ne $result -and $result.Confidence -ge ${MIN_CONFIDENCE}) {
      Write-Output ("WAKE:" + $result.Text.ToLowerInvariant() + ":" + $result.Confidence.ToString('0.00'))
      [Console]::Out.Flush()
      Start-Sleep -Milliseconds 1200
    }
  } catch {
    Start-Sleep -Milliseconds 400
  }
}
`.trim();
}

function clearRestart() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function killChild() {
  clearRestart();
  if (!child) return;
  const proc = child;
  child = null;
  try {
    proc.stdout.removeAllListeners();
    proc.stderr.removeAllListeners();
    proc.removeAllListeners();
  } catch {
    /* ignore */
  }
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      proc.kill();
    }
  } catch {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}

function handleLine(line) {
  const text = String(line || "").trim();
  if (!text) return;
  if (text === "WAKE_READY") {
    console.log("[wake] Windows speech listener ready");
    return;
  }
  if (text.startsWith("WAKE_ERR:")) {
    console.warn("[wake]", text);
    return;
  }
  if (!text.startsWith("WAKE:")) return;
  if (paused || !wanted) return;
  const now = Date.now();
  if (now - lastWakeAt < 2500) return;
  lastWakeAt = now;
  const parts = text.split(":");
  const phrase = parts[1] || "hey cog";
  console.log("[wake] detected:", phrase, parts[2] || "");
  if (typeof onWake === "function") onWake(phrase);
}

function spawnListener() {
  killChild();
  if (!wanted || paused) return;
  if (process.platform !== "win32") {
    console.warn("[wake] System.Speech wake word is Windows-only");
    return;
  }

  const script = buildScript();
  const proc = spawn(
    "powershell.exe",
    ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child = proc;

  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) handleLine(line);
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    const msg = String(chunk).trim();
    if (msg) console.warn("[wake:ps]", msg.slice(0, 300));
  });
  proc.on("exit", (code) => {
    if (child === proc) child = null;
    if (!wanted || paused) return;
    console.warn("[wake] listener exited", code, "— restarting");
    clearRestart();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnListener();
    }, 1500);
  });
}

module.exports = {
  init(hooks) {
    onWake = hooks && hooks.onWake;
  },
  start() {
    wanted = true;
    paused = false;
    spawnListener();
  },
  stop() {
    wanted = false;
    paused = false;
    killChild();
  },
  pause() {
    paused = true;
    killChild();
  },
  resume() {
    if (!wanted) return;
    paused = false;
    spawnListener();
  },
  phrases: PHRASES,
};
