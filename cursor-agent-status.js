// Pure status/timeout helpers for Cursor agents — testable without Electron or SDK.

function parseEnvMs(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DEFAULT_STALE_MS = 15 * 60 * 1000;

function getRunTimeoutMs() {
  return parseEnvMs("CURSOR_AGENT_RUN_TIMEOUT_MS", 0);
}

function getStaleMs() {
  return parseEnvMs("CURSOR_AGENT_STALE_MS", DEFAULT_STALE_MS);
}

function mapSdkRunStatus(status) {
  const s = String(status || "").toLowerCase();
  if (!s) return null;
  if (s === "running") return "running";
  if (s === "completed" || s === "complete" || s === "finished" || s === "success") return "finished";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "error" || s === "failed" || s === "failure") return "error";
  if (s === "timeout" || s === "timed_out") return "timeout";
  return s;
}

function ageMsFromIso(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Date.now() - t);
}

function isRegistryStale(updatedAt, staleMs = getStaleMs()) {
  if (!staleMs) return false;
  const age = ageMsFromIso(updatedAt);
  return age != null && age >= staleMs;
}

/**
 * Resolve the best-known status from registry + live SDK signals.
 */
function resolveEffectiveStatus({
  held,
  recentRuns = [],
  cloudStatus,
  registryStatus,
  registryUpdatedAt,
  staleMs = getStaleMs(),
}) {
  const runs = Array.isArray(recentRuns) ? recentRuns : [];
  const liveRun = runs.find((run) => mapSdkRunStatus(run.status) === "running") || null;
  const latestRun = runs[0] || null;
  const latestMapped = latestRun ? mapSdkRunStatus(latestRun.status) : null;
  const cloudMapped = mapSdkRunStatus(cloudStatus);
  const registryMapped = mapSdkRunStatus(registryStatus);
  const registrySaysRunning = registryMapped === "running";
  const heldActive = Boolean(held);

  let isStale = false;
  let isRunning = heldActive || Boolean(liveRun);

  if (!isRunning && registrySaysRunning) {
    if (isRegistryStale(registryUpdatedAt, staleMs)) {
      isStale = true;
    } else {
      isRunning = true;
    }
  }

  let effectiveStatus;
  if (isRunning) {
    effectiveStatus = "running";
  } else if (isStale) {
    effectiveStatus = latestMapped && latestMapped !== "running" ? latestMapped : "stale";
  } else if (latestMapped) {
    effectiveStatus = latestMapped;
  } else if (cloudMapped) {
    effectiveStatus = cloudMapped;
  } else if (registryMapped) {
    effectiveStatus = registryMapped;
  } else {
    effectiveStatus = "unknown";
  }

  return {
    effectiveStatus,
    isRunning,
    isStale,
    liveRun,
    latestRun,
    latestMapped,
    cloudMapped,
  };
}

function friendlyStatus(status, isRunning) {
  if (isRunning || status === "running") return "Working";
  if (status === "finished") return "Done";
  if (status === "cancelled") return "Stopped";
  if (status === "error") return "Error";
  if (status === "timeout") return "Timed out";
  if (status === "stale") return "Probably stopped";
  if (status === "archived") return "Archived";
  return status ? String(status) : "Unknown";
}

function formatDurationMs(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

function terminalRunStatus(result, timedOut) {
  if (timedOut || (result && result.status === "timeout")) return "timeout";
  if (result && result.status === "error") return "error";
  if (result && result.status === "cancelled") return "cancelled";
  return "finished";
}

function buildStatusNote({ isStale, liveError, checkedAt, registryUpdatedAt }) {
  const parts = [];
  if (isStale) parts.push("Saved status looked stuck — showing best guess from Cursor.");
  if (liveError) parts.push(`Live check failed: ${liveError}`);
  if (checkedAt && registryUpdatedAt) {
    const savedAge = ageMsFromIso(registryUpdatedAt);
    if (savedAge != null && savedAge > 60_000) {
      parts.push(`Last saved update ${formatDurationMs(savedAge)} ago.`);
    }
  }
  return parts.length ? parts.join(" ") : null;
}

async function waitWithTimeout(run, timeoutMs) {
  const ms = Number(timeoutMs) || 0;
  if (!ms || ms <= 0) {
    return { result: await run.wait(), timedOut: false };
  }

  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });

  try {
    const outcome = await Promise.race([
      run.wait().then((result) => ({ result, timedOut: false })),
      timeoutPromise,
    ]);
    if (outcome.timedOut) {
      try {
        if (run && run.status === "running") await run.cancel();
      } catch {
        // ignore cancel errors
      }
      return { result: { status: "timeout" }, timedOut: true };
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  getRunTimeoutMs,
  getStaleMs,
  mapSdkRunStatus,
  ageMsFromIso,
  isRegistryStale,
  resolveEffectiveStatus,
  friendlyStatus,
  formatDurationMs,
  terminalRunStatus,
  buildStatusNote,
  waitWithTimeout,
  DEFAULT_STALE_MS,
};
