// Read the user's Cursor chats from the local conversation search index and
// agent transcript files. Read-only — never modifies Cursor state.

const fs = require("fs");
const path = require("path");
const os = require("os");

function dbPath() {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Cursor",
    "User",
    "globalStorage",
    "conversation-search.db"
  );
}

function projectsRoot() {
  return path.join(os.homedir(), ".cursor", "projects");
}

function runPythonJson(script, args) {
  const { spawnSync } = require("child_process");
  const res = spawnSync("python", ["-c", script, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || "python_failed").trim();
    throw new Error(msg.slice(0, 500));
  }
  const out = (res.stdout || "").trim();
  if (!out) return null;
  return JSON.parse(out);
}

const PY_LIST = `
import json, sqlite3, sys, os
db=sys.argv[1]; limit=int(sys.argv[2]); include_archived=sys.argv[3]=="1"
con=sqlite3.connect(f"file:{db}?mode=ro", uri=True)
q="SELECT id, title, source, updated_at, is_archived FROM conversations"
if not include_archived: q+=" WHERE is_archived=0"
q+=" ORDER BY updated_at DESC LIMIT ?"
rows=con.execute(q,(limit,)).fetchall()
print(json.dumps([{"id":r[0],"title":r[1] or "(untitled)","source":r[2],"updated_at":r[3],"archived":bool(r[4])} for r in rows]))
`;

const PY_SEARCH = `
import json, sqlite3, sys
db=sys.argv[1]; query=sys.argv[2]; limit=int(sys.argv[3])
con=sqlite3.connect(f"file:{db}?mode=ro", uri=True)
# Escape FTS special chars lightly
safe=' '.join(w for w in query.replace('"',' ').split() if w)
if not safe:
  print(json.dumps([])); raise SystemExit
rows=con.execute(
  """SELECT c.id, c.title, c.source, c.updated_at, c.is_archived,
            snippet(conversation_fts, 1, '', '', ' … ', 24) AS snip
     FROM conversation_fts
     JOIN conversations c ON c.fts_rowid = conversation_fts.rowid
     WHERE conversation_fts MATCH ?
     ORDER BY c.updated_at DESC LIMIT ?""",
  (safe, limit)
).fetchall()
print(json.dumps([{"id":r[0],"title":r[1] or "(untitled)","source":r[2],"updated_at":r[3],"archived":bool(r[4]),"snippet":r[5]} for r in rows]))
`;

const PY_GET = `
import json, sqlite3, sys
db=sys.argv[1]; cid=sys.argv[2]
con=sqlite3.connect(f"file:{db}?mode=ro", uri=True)
row=con.execute(
  """SELECT c.id, c.title, c.source, c.updated_at, c.is_archived, f.c1
     FROM conversations c
     JOIN conversation_fts_content f ON f.id = c.fts_rowid
     WHERE c.id=? LIMIT 1""",
  (cid,)
).fetchone()
if not row:
  print("null")
else:
  print(json.dumps({"id":row[0],"title":row[1] or "(untitled)","source":row[2],"updated_at":row[3],"archived":bool(row[4]),"body":row[5] or ""}))
`;

function listChats({ limit = 15, includeArchived = false } = {}) {
  const lim = Math.max(1, Math.min(Number(limit) || 15, 50));
  const db = dbPath();
  if (!fs.existsSync(db)) return { ok: false, error: "conversation_db_missing" };
  try {
    const rows = runPythonJson(PY_LIST, [db, String(lim), includeArchived ? "1" : "0"]) || [];
    return {
      ok: true,
      count: rows.length,
      chats: rows.map(formatChatMeta),
    };
  } catch (err) {
    return { ok: false, error: err.message || "list_failed" };
  }
}

function searchChats({ query, limit = 10 } = {}) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "empty_query" };
  const lim = Math.max(1, Math.min(Number(limit) || 10, 40));
  const db = dbPath();
  if (!fs.existsSync(db)) return { ok: false, error: "conversation_db_missing" };
  try {
    const rows = runPythonJson(PY_SEARCH, [db, q, String(lim)]) || [];
    return {
      ok: true,
      query: q,
      count: rows.length,
      chats: rows.map((r) => ({ ...formatChatMeta(r), snippet: r.snippet || "" })),
    };
  } catch (err) {
    return { ok: false, error: err.message || "search_failed" };
  }
}

function getChat({ id, maxChars = 8000 } = {}) {
  const cid = String(id || "").trim();
  if (!cid) return { ok: false, error: "missing_id" };
  const db = dbPath();
  if (!fs.existsSync(db)) return { ok: false, error: "conversation_db_missing" };

  let indexed = null;
  try {
    indexed = runPythonJson(PY_GET, [db, cid]);
  } catch (err) {
    return { ok: false, error: err.message || "get_failed" };
  }

  const transcript = readTranscript(cid, maxChars);
  if (!indexed && !transcript) return { ok: false, error: "not_found", id: cid };

  const body = transcript
    ? transcript.text
    : String((indexed && indexed.body) || "").slice(0, maxChars);

  return {
    ok: true,
    id: cid,
    title: (indexed && indexed.title) || (transcript && transcript.title) || "(untitled)",
    source: (indexed && indexed.source) || "local",
    updated_at: indexed ? formatWhen(indexed.updated_at) : transcript && transcript.updated_at,
    archived: Boolean(indexed && indexed.archived),
    from_transcript: Boolean(transcript),
    text: body,
    truncated: body.length >= maxChars,
  };
}

function formatChatMeta(r) {
  return {
    id: r.id,
    title: r.title || "(untitled)",
    source: r.source || "local",
    updated_at: formatWhen(r.updated_at),
    archived: Boolean(r.archived),
  };
}

function formatWhen(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n).toISOString();
  } catch {
    return String(ms);
  }
}

function readTranscript(id, maxChars) {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return null;
  // Find .../agent-transcripts/<id>/<id>.jsonl
  let hit = null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === id) {
          const jsonl = path.join(full, `${id}.jsonl`);
          if (fs.existsSync(jsonl)) {
            hit = jsonl;
            stack.length = 0;
            break;
          }
        }
        // Only descend into project folders / agent-transcripts, not everything forever
        if (ent.name === "agent-transcripts" || ent.name.startsWith("c-") || ent.name === "empty-window") {
          stack.push(full);
        } else if (dir.endsWith("projects") || dir.includes(`${path.sep}projects${path.sep}`)) {
          stack.push(full);
        }
      }
    }
  }
  if (!hit) return null;
  try {
    const lines = fs.readFileSync(hit, "utf8").split(/\r?\n/).filter(Boolean);
    const parts = [];
    let title = null;
    for (const line of lines) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const role = msg.role || "unknown";
      const text = flattenMessage(msg);
      if (!text) continue;
      if (!title && role === "user") title = text.slice(0, 80).replace(/\s+/g, " ");
      parts.push(`${role}: ${text}`);
      if (parts.join("\n").length > maxChars) break;
    }
    const text = parts.join("\n\n").slice(0, maxChars);
    const st = fs.statSync(hit);
    return {
      title,
      text,
      updated_at: st.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function flattenMessage(msg) {
  const content = msg.message && msg.message.content;
  if (typeof msg.message === "string") return msg.message;
  if (!Array.isArray(content)) {
    if (typeof content === "string") return content;
    return "";
  }
  return content
    .filter((b) => b && b.type === "text" && b.text)
    .map((b) => String(b.text).replace(/<\/?[^>]+>/g, "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

module.exports = {
  listChats,
  searchChats,
  getChat,
  dbPath,
};
