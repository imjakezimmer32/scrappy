// Durable Cog conversation store for deep analysis.
//
// Every call writes:
//   conversations/<sessionId>.jsonl   — full event stream
//   conversations/<sessionId>.meta.json — rolled-up summary on end
//   conversations/index.jsonl         — one-line index per session
//
// Also mirrors under Electron userData so it survives project cleans.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let projectDir = null;
let userDataDir = null;

function init({ projectRoot, userData }) {
  projectDir = path.join(projectRoot, "conversations");
  userDataDir = path.join(userData, "conversations");
  for (const dir of [projectDir, userDataDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn("[conversations] mkdir failed:", dir, err.message);
    }
  }
}

function newSessionId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `cog-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function pathsFor(sessionId) {
  const id = String(sessionId || "").replace(/[^\w.\-]+/g, "_");
  return {
    id,
    projectJsonl: path.join(projectDir, `${id}.jsonl`),
    projectMeta: path.join(projectDir, `${id}.meta.json`),
    userJsonl: path.join(userDataDir, `${id}.jsonl`),
    userMeta: path.join(userDataDir, `${id}.meta.json`),
    index: path.join(projectDir, "index.jsonl"),
  };
}

function appendLine(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`, "utf8");
  } catch (err) {
    console.warn("[conversations] write failed:", filePath, err.message);
  }
}

function writeJson(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn("[conversations] meta write failed:", filePath, err.message);
  }
}

function recordEvent(sessionId, event) {
  if (!projectDir) return { ok: false, error: "not_ready" };
  const id = String(sessionId || "").trim();
  if (!id) return { ok: false, error: "no_session" };
  const payload = {
    ts: Date.now() / 1000,
    session_id: id,
    ...(event && typeof event === "object" ? event : { type: "note", text: String(event || "") }),
  };
  const p = pathsFor(id);
  appendLine(p.projectJsonl, payload);
  appendLine(p.userJsonl, payload);
  return { ok: true, sessionId: id, path: p.projectJsonl };
}

function readEvents(sessionId, limit = 5000) {
  const p = pathsFor(sessionId);
  const file = fs.existsSync(p.projectJsonl) ? p.projectJsonl : p.userJsonl;
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const slice = lines.slice(Math.max(0, lines.length - limit));
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip bad line
    }
  }
  return out;
}

function buildMeta(sessionId, extra = {}) {
  const events = readEvents(sessionId);
  const users = events.filter((e) => e.type === "user" || e.role === "jake");
  const assistants = events.filter((e) => e.type === "assistant" || e.role === "cog");
  const tools = events.filter((e) => e.type === "tool");
  const errors = events.filter((e) => e.type === "error" || e.type === "recover" || e.type === "turn_error");
  const rewrites = events.filter((e) => e.type === "rewrite");
  const start = events[0]?.ts || null;
  const end = events[events.length - 1]?.ts || null;
  const transcript = [];
  for (const e of events) {
    if (e.type === "user" || e.role === "jake") transcript.push({ role: "jake", text: e.text || "", ts: e.ts });
    if (e.type === "assistant" || e.role === "cog") {
      transcript.push({
        role: "cog",
        text: e.text || "",
        ts: e.ts,
        route: e.route,
        model: e.model,
      });
    }
  }
  return {
    session_id: sessionId,
    started_at: start ? new Date(start * 1000).toISOString() : null,
    ended_at: end ? new Date(end * 1000).toISOString() : null,
    duration_sec: start && end ? Math.max(0, Math.round(end - start)) : null,
    backend: extra.backend || events.find((e) => e.backend)?.backend || null,
    model: extra.model || events.find((e) => e.model)?.model || null,
    turns_jake: users.length,
    turns_cog: assistants.length,
    tool_calls: tools.length,
    errors: errors.length,
    rewrites: rewrites.length,
    event_count: events.length,
    transcript,
    analysis_hints: {
      flat_assistant_rewrites: rewrites.length,
      recoveries: events.filter((e) => e.type === "recover").length,
      think_routes: assistants.filter((e) => e.route === "think").length,
      fast_routes: assistants.filter((e) => e.route === "fast").length,
      tools_used: [...new Set(tools.map((t) => t.name).filter(Boolean))],
    },
    ...extra,
  };
}

function endSession(sessionId, extra = {}) {
  if (!projectDir) return { ok: false, error: "not_ready" };
  const id = String(sessionId || "").trim();
  if (!id) return { ok: false, error: "no_session" };
  recordEvent(id, { type: "session_end", ...extra });
  const meta = buildMeta(id, extra);
  const p = pathsFor(id);
  writeJson(p.projectMeta, meta);
  writeJson(p.userMeta, meta);
  appendLine(p.index, {
    ts: Date.now() / 1000,
    session_id: id,
    started_at: meta.started_at,
    ended_at: meta.ended_at,
    duration_sec: meta.duration_sec,
    turns_jake: meta.turns_jake,
    turns_cog: meta.turns_cog,
    backend: meta.backend,
    model: meta.model,
    path: p.projectJsonl,
    meta_path: p.projectMeta,
  });
  return { ok: true, sessionId: id, meta, path: p.projectJsonl, metaPath: p.projectMeta };
}

function listRecent(limit = 20) {
  if (!projectDir || !fs.existsSync(projectDir)) return [];
  const files = fs
    .readdirSync(projectDir)
    .filter((f) => f.endsWith(".meta.json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(projectDir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.ended_at || "").localeCompare(String(a.ended_at || "")));
  return files.slice(0, limit);
}

function getSession(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const metaPath = path.join(projectDir, `${id.replace(/[^\w.\-]+/g, "_")}.meta.json`);
  if (fs.existsSync(metaPath)) {
    try {
      return JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      // fall through
    }
  }
  return buildMeta(id);
}

function formatSessionList(sessions) {
  return (sessions || [])
    .map((s) => {
      return `${s.session_id} | ${s.started_at || "?"} | jake=${s.turns_jake || 0} cog=${s.turns_cog || 0} | ${s.backend || "?"} | ${s.model || "?"}`;
    })
    .join("\n");
}

function formatTranscript(meta, maxTurns = 40) {
  if (!meta) return "(not found)";
  const lines = [`Session ${meta.session_id}`, `Started ${meta.started_at || "?"}`, ""];
  const turns = (meta.transcript || []).slice(-maxTurns);
  for (const t of turns) {
    lines.push(`${t.role === "jake" ? "Jake" : "Cog"}: ${t.text || ""}`);
  }
  return lines.join("\n");
}

function projectPath() {
  return projectDir;
}

module.exports = {
  init,
  newSessionId,
  recordEvent,
  endSession,
  listRecent,
  getSession,
  formatSessionList,
  formatTranscript,
  buildMeta,
  readEvents,
  projectPath,
};
