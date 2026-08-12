// Cog process journal — timestamped record of every process lifecycle +
// conversation beat + notes Jake adds by hand.
//
// Files (gitignored):
//   process-logs/YYYY-MM-DD.jsonl   — full day timeline
//   process-logs/latest.jsonl       — same events, rolling mirror of "today"
//   process-logs/ADD-NOTE-HERE.txt  — Jake drops notes here; we import them
//
// Event shape:
//   {
//     ts, iso, kind, type, name, pid?, by?, reason?, kills?, meta?
//   }

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

let rootDir = null;
let inboxPath = null;
let inboxTimer = null;
let lastInboxHash = "";

function init({ projectRoot }) {
  rootDir = path.join(projectRoot, "process-logs");
  try {
    fs.mkdirSync(rootDir, { recursive: true });
  } catch (err) {
    console.warn("[process-journal] mkdir failed:", err.message);
  }
  inboxPath = path.join(rootDir, "ADD-NOTE-HERE.txt");
  ensureInboxTemplate();
  startInboxWatcher();
  record({
    kind: "system",
    type: "journal_ready",
    name: "process-journal",
    by: "main",
    reason: "WorkBuddy started process logging",
  });
}

function ensureInboxTemplate() {
  if (!inboxPath) return;
  if (fs.existsSync(inboxPath)) return;
  const template = [
    "# Add a note below this line, save the file, and Cog will pull it into today's process log.",
    "# Example: Restarted because voice felt stuck after model switch.",
    "",
    "",
  ].join("\n");
  try {
    fs.writeFileSync(inboxPath, template, "utf8");
  } catch {
    // ignore
  }
}

function dayFile(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return path.join(rootDir, `${y}-${m}-${day}.jsonl`);
}

function latestFile() {
  return path.join(rootDir, "latest.jsonl");
}

function isoNow(ts = Date.now() / 1000) {
  return new Date(ts * 1000).toISOString();
}

function append(filePath, obj) {
  if (!rootDir) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, "utf8");
  } catch (err) {
    console.warn("[process-journal] write failed:", err.message);
  }
}

function record(event = {}) {
  if (!rootDir) return { ok: false, error: "not_ready" };
  const ts = typeof event.ts === "number" ? event.ts : Date.now() / 1000;
  const payload = {
    ts,
    iso: isoNow(ts),
    kind: event.kind || "process",
    type: event.type || "note",
    name: event.name || "cog",
    ...(event.pid != null ? { pid: event.pid } : {}),
    ...(event.by ? { by: event.by } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(Array.isArray(event.kills) && event.kills.length ? { kills: event.kills } : {}),
    ...(event.session_id ? { session_id: event.session_id } : {}),
    ...(event.text ? { text: String(event.text).slice(0, 8000) } : {}),
    ...(event.meta && typeof event.meta === "object" ? { meta: event.meta } : {}),
  };
  append(dayFile(), payload);
  append(latestFile(), payload);
  return { ok: true, event: payload };
}

function started(name, { pid, by = "main", reason, meta } = {}) {
  return record({ kind: "process", type: "start", name, pid, by, reason, meta });
}

function stopped(name, { pid, by = "main", reason, kills, meta } = {}) {
  return record({
    kind: "process",
    type: "stop",
    name,
    pid,
    by,
    reason,
    kills: kills || (pid ? [`${name}:${pid}`] : undefined),
    meta,
  });
}

function killed(name, { pid, by = "main", reason, meta } = {}) {
  return record({
    kind: "process",
    type: "kill",
    name,
    pid,
    by,
    reason,
    kills: pid != null ? [`${name}:${pid}`] : [`${name}`],
    meta,
  });
}

function exited(name, { pid, code, by = "self", reason, meta } = {}) {
  return record({
    kind: "process",
    type: "exit",
    name,
    pid,
    by,
    reason: reason || `exit_code=${code}`,
    meta: { ...(meta || {}), code },
  });
}

function restartScheduled(name, { by = "auto-restart", reason, meta } = {}) {
  return record({
    kind: "process",
    type: "restart_scheduled",
    name,
    by,
    reason,
    meta,
  });
}

function conversation(type, { session_id, text, by = "voice", meta, name = "conversation" } = {}) {
  return record({
    kind: "conversation",
    type,
    name,
    session_id,
    text,
    by,
    meta,
  });
}

function note(text, { by = "user", reason, meta } = {}) {
  const line = String(text || "").trim();
  if (!line) return { ok: false, error: "empty" };
  return record({
    kind: "note",
    type: "user_note",
    name: "jake",
    text: line,
    by,
    reason: reason || "manual note",
    meta,
  });
}

function startInboxWatcher() {
  if (inboxTimer) return;
  inboxTimer = setInterval(() => {
    importInbox().catch(() => {});
  }, 4000);
  if (inboxTimer.unref) inboxTimer.unref();
}

async function importInbox() {
  if (!inboxPath || !fs.existsSync(inboxPath)) return;
  let raw = "";
  try {
    raw = fs.readFileSync(inboxPath, "utf8");
  } catch {
    return;
  }
  const hash = `${raw.length}:${raw.slice(-120)}`;
  if (hash === lastInboxHash) return;
  lastInboxHash = hash;

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return;

  const text = lines.join("\n").trim();
  if (!text) return;
  note(text, { by: "user", reason: "ADD-NOTE-HERE.txt" });
  // Reset template so Jake can drop another note without duplicating.
  ensureInboxFresh();
  lastInboxHash = "";
}

function ensureInboxFresh() {
  const template = [
    "# Add a note below this line, save the file, and Cog will pull it into today's process log.",
    "# Example: Voice died after I switched models — investigating.",
    "",
    "",
  ].join("\n");
  try {
    fs.writeFileSync(inboxPath, template, "utf8");
  } catch {
    // ignore
  }
}

function openInboxForUser() {
  ensureInboxTemplate();
  ensureInboxFresh();
  try {
    if (process.platform === "win32") {
      spawn("notepad.exe", [inboxPath], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [inboxPath], { detached: true, stdio: "ignore" }).unref();
    }
    record({
      kind: "note",
      type: "inbox_opened",
      name: "jake",
      by: "tray",
      reason: "Opened ADD-NOTE-HERE.txt for Jake",
    });
    return { ok: true, path: inboxPath };
  } catch (err) {
    return { ok: false, error: err.message || "open_failed", path: inboxPath };
  }
}

function recent(limit = 80) {
  const file = fs.existsSync(latestFile()) ? latestFile() : dayFile();
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const slice = lines.slice(Math.max(0, lines.length - limit));
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return out;
}

function search(query, limit = 40) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return recent(limit);
  const hay = recent(Math.max(limit * 8, 400));
  const matched = hay.filter((e) => {
    const blob = [
      e.kind,
      e.type,
      e.name,
      e.by,
      e.reason,
      e.text,
      Array.isArray(e.kills) ? e.kills.join(" ") : "",
      e.session_id,
      e.meta ? JSON.stringify(e.meta) : "",
    ]
      .join(" ")
      .toLowerCase();
    return blob.includes(q);
  });
  return matched.slice(-limit);
}

function formatEvents(events, max = 30) {
  const slice = (events || []).slice(-max);
  return slice
    .map((e) => {
      const kills = e.kills && e.kills.length ? ` kills=[${e.kills.join(",")}]` : "";
      const text = e.text ? ` :: ${String(e.text).slice(0, 180)}` : "";
      const reason = e.reason ? ` (${e.reason})` : "";
      const pid = e.pid != null ? ` pid=${e.pid}` : "";
      return `${e.iso || ""} [${e.kind}/${e.type}] ${e.name || "?"}${pid}${reason}${kills}${text}`;
    })
    .join("\n");
}

function dir() {
  return rootDir;
}

function inbox() {
  return inboxPath;
}

module.exports = {
  init,
  record,
  started,
  stopped,
  killed,
  exited,
  restartScheduled,
  conversation,
  note,
  openInboxForUser,
  recent,
  search,
  formatEvents,
  dir,
  inbox,
  importInbox,
};
