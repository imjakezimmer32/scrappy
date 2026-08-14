// A minimal MCP client so Scrappy can read Jake's Recall knowledge base.
//
// Recall ships a stdio MCP server (`recall.exe --mcp`) that is safe to run
// alongside the GUI — its own notes say WAL plus busy_timeout make concurrent
// access fine. We speak newline-delimited JSON-RPC to it over a long-lived
// child process, spawned lazily on first use and restarted if it dies.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const CANDIDATES = [
  "C:\\Users\\hella\\OneDrive\\Desktop\\Projects\\recall\\src-tauri\\target\\release\\recall.exe",
  "C:\\Users\\hella\\OneDrive\\Desktop\\Projects\\recall\\src-tauri\\target\\debug\\recall.exe",
  "C:\\Users\\hella\\OneDrive\\Desktop\\Projects\\recall\\dist\\Recall-portable\\recall.exe",
];

const CALL_TIMEOUT_MS = 60000;

let child = null;
let ready = null;
let nextId = 1;
const pending = new Map();
let buffer = "";

function exePath(override) {
  const wanted = override || process.env.RECALL_EXE;
  if (wanted && fs.existsSync(wanted)) return wanted;
  return CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // server logging, not a response
  }
  if (msg.id === undefined || !pending.has(msg.id)) return;
  const { resolve, timer } = pending.get(msg.id);
  clearTimeout(timer);
  pending.delete(msg.id);
  resolve(msg);
}

function teardown() {
  for (const { resolve, timer } of pending.values()) {
    clearTimeout(timer);
    resolve({ error: { message: "recall_exited" } });
  }
  pending.clear();
  child = null;
  ready = null;
  buffer = "";
}

function send(msg) {
  if (!child || !child.stdin.writable) return;
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: { message: "timeout" } });
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    send({ jsonrpc: "2.0", id, method, params: params || {} });
  });
}

function start(override) {
  if (ready) return ready;

  const exe = exePath(override);
  if (!exe) {
    return Promise.resolve({ ok: false, error: "recall_not_found" });
  }

  ready = new Promise((resolve) => {
    try {
      child = spawn(exe, ["--mcp"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      teardown();
      return resolve({ ok: false, error: "spawn_failed" });
    }

    child.on("exit", teardown);
    child.on("error", teardown);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let cut = buffer.indexOf("\n");
      while (cut !== -1) {
        handleLine(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 1);
        cut = buffer.indexOf("\n");
      }
    });

    request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "scrappy-scrappy", version: "1.0.0" },
    }).then((res) => {
      if (res.error) {
        teardown();
        return resolve({ ok: false, error: "initialize_failed" });
      }
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      resolve({ ok: true, server: res.result && res.result.serverInfo });
    });
  });

  return ready;
}

async function listTools() {
  const up = await start();
  if (!up.ok) return up;
  const res = await request("tools/list");
  if (res.error) return { ok: false, error: res.error.message || "list_failed" };
  return { ok: true, tools: (res.result && res.result.tools) || [] };
}

// Flatten MCP's content blocks into plain text — it's going into a voice
// agent's context, not a UI.
function flatten(result) {
  if (!result) return "";
  const blocks = result.content || [];
  return blocks
    .map((b) => (b && b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function call(name, args) {
  const up = await start();
  if (!up.ok) return up;
  const res = await request("tools/call", { name, arguments: args || {} });
  if (res.error) return { ok: false, error: res.error.message || "call_failed" };
  const text = flatten(res.result);
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return {
    ok: true,
    text,
    data,
    isError: Boolean(res.result && res.result.isError),
  };
}

function stop() {
  if (child) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
  teardown();
}

module.exports = { start, listTools, call, stop, exePath };
