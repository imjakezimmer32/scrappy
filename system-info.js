// What Scrappy can actually see about the machine he lives on.
//
// This is fed to him as ElevenLabs "contextual_update" events during a
// conversation, so he can talk about what's really happening instead of
// inventing it. Window titles leave the machine when he's in a call — see the
// privacy note in the README, and SCRAPPY_SYSTEM_CONTEXT=off to disable.

const os = require("os");
const { execFile } = require("child_process");

let lastCpu = null;

// os.loadavg() is always [0,0,0] on Windows, so CPU has to come from the
// delta between two cumulative tick samples.
function cpuPercent() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const k of Object.keys(c.times)) total += c.times[k];
    idle += c.times.idle;
  }
  const sample = { idle, total };
  if (!lastCpu) {
    lastCpu = sample;
    return null; // no baseline yet
  }
  const dIdle = idle - lastCpu.idle;
  const dTotal = total - lastCpu.total;
  lastCpu = sample;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
}

// One PowerShell round trip for everything: the focused window, the heaviest
// processes, and which apps are holding the microphone right now.
//
// Windows records mic usage in CapabilityAccessManager. LastUsedTimeStop of 0
// means "in use at this moment" — but stale zeros linger for apps that died
// without releasing it, so every hit is cross-checked against the running
// process list before it counts.
const PS_PROBE = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class WB {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);
}
"@
$h = [WB]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][WB]::GetWindowText($h, $sb, 512)
$procId = 0
[void][WB]::GetWindowThreadProcessId($h, [ref]$procId)
$fg = Get-Process -Id $procId

$procs = Get-Process
$running = @{}
foreach ($p in $procs) { $running[$p.ProcessName.ToLower()] = $true }

$best = @{}
$roots = @(
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone'
)
foreach ($r in $roots) {
  if (Test-Path $r) {
    foreach ($k in Get-ChildItem $r) {
      $v = Get-ItemProperty $k.PSPath
      if ($null -eq $v.LastUsedTimeStart) { continue }
      $full = $k.PSChildName
      if ($full -like '*scrappy*') { continue }
      $leaf = ($full -split '#')[-1] -replace '\.exe$',''
      if (-not $leaf) { continue }
      $key = $leaf.ToLower()
      if (-not $best.ContainsKey($key) -or $v.LastUsedTimeStart -gt $best[$key].start) {
        $best[$key] = @{ name = $leaf; start = $v.LastUsedTimeStart; stop = $v.LastUsedTimeStop }
      }
    }
  }
}

$mic = New-Object System.Collections.Generic.List[string]
foreach ($key in $best.Keys) {
  $e = $best[$key]
  if ($e.stop -eq 0 -and $running[$key]) { $mic.Add($e.name) }
}

$top = $procs | Sort-Object -Property WorkingSet64 -Descending |
  Select-Object -First 5 -Property ProcessName, @{n='mb';e={[int]($_.WorkingSet64/1MB)}}
[pscustomobject]@{
  active = $sb.ToString()
  activeProcess = $fg.ProcessName
  top = @($top)
  mic = @($mic | Select-Object -Unique)
} | ConvertTo-Json -Compress -Depth 3
`;

function probeWindows() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_PROBE],
      { timeout: 6000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

function human(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function uptimeWords(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} days`;
  if (h) return `${h}h ${m}m`;
  return `${m} minutes`;
}

// A compact paragraph rather than JSON — it lands in an LLM prompt, and prose
// costs fewer tokens and reads better than a serialised object.
async function snapshot() {
  const cpu = cpuPercent();
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const parts = [];

  const win = await probeWindows();
  if (win && win.active) {
    parts.push(`He is looking at "${win.active}" in ${win.activeProcess || "something"}.`);
  }

  const mem = `${human(usedMem)} of ${human(totalMem)} RAM in use (${Math.round((usedMem / totalMem) * 100)}%)`;
  parts.push(cpu === null ? `${mem}.` : `CPU ${cpu}%, ${mem}.`);

  if (win && Array.isArray(win.top) && win.top.length) {
    const list = win.top
      .filter((p) => p && p.ProcessName)
      .map((p) => `${p.ProcessName} ${p.mb}MB`)
      .join(", ");
    if (list) parts.push(`Biggest processes: ${list}.`);
  }

  // The one that matters most for not interrupting him.
  if (win && Array.isArray(win.mic) && win.mic.length) {
    parts.push(
      `He is TALKING RIGHT NOW — the microphone is live in ${win.mic.join(" and ")}. ` +
        `He is dictating or on a call. Do not start anything.`
    );
  }

  parts.push(`Machine up ${uptimeWords(os.uptime())}.`);
  return parts.join(" ");
}

// Prime the CPU sampler so the first real reading has a baseline.
cpuPercent();

module.exports = { snapshot };
