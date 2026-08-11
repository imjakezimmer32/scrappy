// Cursor agents Cog can start for planning/research, then continue later.
// Uses @cursor/sdk. Needs CURSOR_API_KEY in .env.local (from cursor.com/settings).
//
// Runs stay alive in a registry so Cog can resume them. Cloud runs (ids
// starting with "bc-") also show up in Cursor's Agents Window so Jake can
// keep chatting there.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REGISTRY_PATH = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"),
  "workbuddy",
  "cursor-agents.json"
);

const MAX_AGENTS = 40;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadRegistry() {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) return { agents: [] };
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    return { agents: Array.isArray(raw.agents) ? raw.agents : [] };
  } catch {
    return { agents: [] };
  }
}

function saveRegistry(reg) {
  ensureDir(REGISTRY_PATH);
  reg.agents = (reg.agents || []).slice(0, MAX_AGENTS);
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), "utf8");
}

function upsertAgent(entry) {
  const reg = loadRegistry();
  const idx = reg.agents.findIndex((a) => a.id === entry.id);
  if (idx >= 0) reg.agents[idx] = { ...reg.agents[idx], ...entry };
  else reg.agents.unshift(entry);
  saveRegistry(reg);
  return entry;
}

function getAgent(id) {
  return loadRegistry().agents.find((a) => a.id === id) || null;
}

function listAgents(limit = 10) {
  return loadRegistry().agents.slice(0, Math.max(1, Math.min(limit, 40)));
}

function readApiKey(envFile = {}) {
  return (
    process.env.CURSOR_API_KEY ||
    envFile.CURSOR_API_KEY ||
    process.env.CURSOR_SDK_API_KEY ||
    envFile.CURSOR_SDK_API_KEY ||
    ""
  ).trim();
}

async function loadSdk() {
  // Package is ESM; Electron main is CJS.
  return import("@cursor/sdk");
}

function resolveCwd(cwd) {
  const wanted = String(cwd || "").trim();
  if (wanted && fs.existsSync(wanted)) return path.resolve(wanted);
  return path.resolve(__dirname);
}

function githubRemoteUrl(cwd) {
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    }).trim();
    if (!out) return null;
    if (out.startsWith("git@")) {
      // git@github.com:user/repo.git → https://github.com/user/repo
      const m = out.match(/git@[^:]+:(.+?)(?:\.git)?$/);
      if (m) return `https://github.com/${m[1].replace(/\.git$/, "")}`;
    }
    return out.replace(/\.git$/, "");
  } catch {
    return null;
  }
}

function buildPrompt(kind, goal) {
  const g = String(goal || "").trim();
  if (kind === "plan") {
    return [
      "You are a planning agent started by Cog (Jake's desk robot).",
      "Make a clear, practical plan. Do not implement code unless Jake asks.",
      "Prefer short sections and concrete next steps.",
      "",
      "Jake's request:",
      g,
    ].join("\n");
  }
  return [
    "You are a research agent started by Cog (Jake's desk robot).",
    "Investigate the codebase / context. Summarize findings clearly.",
    "Do not make code changes unless Jake explicitly asks you to.",
    "Prefer evidence (file paths, quotes) over guesses.",
    "",
    "Jake's request:",
    g,
  ].join("\n");
}

/**
 * Start a Cursor agent for planning or research.
 * Returns immediately with an id; the run continues in the background.
 */
async function startAgent({
  goal,
  kind = "research",
  cwd,
  mode = "auto", // auto | local | cloud
  apiKey,
}) {
  const key = String(apiKey || "").trim();
  if (!key) {
    return {
      ok: false,
      error: "missing_api_key",
      hint: "Add CURSOR_API_KEY to workbuddy/.env.local (create one at https://cursor.com/settings).",
    };
  }
  const text = String(goal || "").trim();
  if (!text) return { ok: false, error: "empty_goal" };

  const root = resolveCwd(cwd);
  const { Agent } = await loadSdk();
  const model = { id: process.env.CURSOR_AGENT_MODEL || "composer-2.5" };

  let runtime = mode;
  if (runtime === "auto") {
    const remote = githubRemoteUrl(root);
    runtime = remote ? "cloud" : "local";
  }

  const options = {
    apiKey: key,
    model,
    name: `Cog ${kind}: ${text.slice(0, 48)}`,
  };

  if (runtime === "cloud") {
    const url = githubRemoteUrl(root);
    if (!url) {
      runtime = "local";
    } else {
      options.cloud = {
        repos: [{ url, startingRef: "main" }],
        autoCreatePR: false,
      };
    }
  }

  if (runtime !== "cloud") {
    options.local = {
      cwd: root,
      // Research/plan: look around, don't shell-rampage.
      // (local-only restriction)
    };
    options.tools = ["read", "grep", "glob", "ls", "semSearch"];
  }

  const agent = await Agent.create(options);
  const agentId = agent.agentId;
  const entry = upsertAgent({
    id: agentId,
    kind,
    goal: text,
    cwd: root,
    runtime: runtime === "cloud" ? "cloud" : "local",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: null,
    error: null,
    openUrl:
      runtime === "cloud" || String(agentId).startsWith("bc-")
        ? `https://cursor.com/agents?id=${encodeURIComponent(agentId)}`
        : null,
  });

  // Background run — do not block Cog's voice tool call.
  (async () => {
    try {
      const run = await agent.send(buildPrompt(kind, text));
      const result = await run.wait();
      const summary =
        (result && (result.result || result.status)) ||
        (result && result.status) ||
        "finished";
      upsertAgent({
        id: agentId,
        status: result && result.status === "error" ? "error" : "finished",
        updatedAt: new Date().toISOString(),
        result: typeof summary === "string" ? summary.slice(0, 12000) : String(summary).slice(0, 12000),
        error: result && result.status === "error" ? (result.error && result.error.message) || "run_error" : null,
      });
    } catch (err) {
      upsertAgent({
        id: agentId,
        status: "error",
        updatedAt: new Date().toISOString(),
        error: err && err.message ? err.message : String(err),
      });
    } finally {
      try {
        if (agent && typeof agent[Symbol.asyncDispose] === "function") {
          await agent[Symbol.asyncDispose]();
        }
      } catch {
        // ignore dispose errors
      }
    }
  })();

  return {
    ok: true,
    id: agentId,
    kind,
    runtime: entry.runtime,
    status: "running",
    openUrl: entry.openUrl,
    hint:
      entry.runtime === "cloud"
        ? "Cloud agent started. Open it in Cursor's Agents Window (or openUrl) to watch and continue chatting."
        : "Local agent started. Use cursor_continue_agent with this id to keep the conversation going, or cursor_agent_status to check results.",
  };
}

async function continueAgent({ id, message, apiKey }) {
  const key = String(apiKey || "").trim();
  if (!key) {
    return {
      ok: false,
      error: "missing_api_key",
      hint: "Add CURSOR_API_KEY to workbuddy/.env.local.",
    };
  }
  const agentId = String(id || "").trim();
  const text = String(message || "").trim();
  if (!agentId) return { ok: false, error: "missing_id" };
  if (!text) return { ok: false, error: "empty_message" };

  const known = getAgent(agentId);
  const { Agent } = await loadSdk();
  const model = { id: process.env.CURSOR_AGENT_MODEL || "composer-2.5" };

  const resumeOpts = { apiKey: key, model };
  if (known && known.runtime !== "cloud" && known.cwd) {
    resumeOpts.local = { cwd: known.cwd };
    resumeOpts.tools = ["read", "grep", "glob", "ls", "semSearch"];
  }

  upsertAgent({
    id: agentId,
    status: "running",
    updatedAt: new Date().toISOString(),
  });

  try {
    const agent = await Agent.resume(agentId, resumeOpts);
    const run = await agent.send(text);
    const result = await run.wait();
    const summary =
      (result && result.result) ||
      (result && result.status) ||
      "finished";
    const entry = upsertAgent({
      id: agentId,
      status: result && result.status === "error" ? "error" : "finished",
      updatedAt: new Date().toISOString(),
      result: String(summary).slice(0, 12000),
      error: result && result.status === "error" ? (result.error && result.error.message) || "run_error" : null,
      openUrl:
        String(agentId).startsWith("bc-")
          ? `https://cursor.com/agents?id=${encodeURIComponent(agentId)}`
          : (known && known.openUrl) || null,
    });
    try {
      if (typeof agent[Symbol.asyncDispose] === "function") await agent[Symbol.asyncDispose]();
    } catch {
      // ignore
    }
    return {
      ok: true,
      id: agentId,
      status: entry.status,
      result: entry.result,
      openUrl: entry.openUrl,
    };
  } catch (err) {
    upsertAgent({
      id: agentId,
      status: "error",
      updatedAt: new Date().toISOString(),
      error: err && err.message ? err.message : String(err),
    });
    return {
      ok: false,
      error: err && err.message ? err.message : "continue_failed",
      id: agentId,
    };
  }
}

function agentStatus(id) {
  const agentId = String(id || "").trim();
  if (!agentId) return { ok: false, error: "missing_id" };
  const entry = getAgent(agentId);
  if (!entry) return { ok: false, error: "not_found", id: agentId };
  return { ok: true, agent: entry };
}

function openAgentInBrowser(id) {
  const entry = getAgent(id);
  const url =
    (entry && entry.openUrl) ||
    (String(id).startsWith("bc-")
      ? `https://cursor.com/agents?id=${encodeURIComponent(id)}`
      : "https://cursor.com/agents");
  try {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return { ok: true, openUrl: url };
  } catch (err) {
    return { ok: false, error: err.message || "open_failed", openUrl: url };
  }
}

module.exports = {
  startAgent,
  continueAgent,
  agentStatus,
  listAgents,
  openAgentInBrowser,
  readApiKey,
  REGISTRY_PATH,
};
