// Cursor agents Cog can start for planning/research, then continue later.
// Uses @cursor/sdk. Needs CURSOR_API_KEY in .env.local (from cursor.com/settings).
//
// Runs stay alive in a registry so Cog can resume them. Cloud runs (ids
// starting with "bc-") also show up in Cursor's Agents Window so Jake can
// keep chatting there.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const statusHelpers = require("./cursor-agent-status");

const REGISTRY_PATH = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"),
  "workbuddy",
  "cursor-agents.json"
);

const MAX_AGENTS = 40;

/** In-memory handles for background runs Cog started this session (fast stop). */
const activeRuns = new Map();

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

function listAgents(options = 10) {
  const opts = typeof options === "number" ? { limit: options } : options || {};
  const limit = Math.max(1, Math.min(Number(opts.limit) || 10, 40));
  let agents = loadRegistry().agents;

  if (opts.status) {
    const wanted = String(opts.status).toLowerCase();
    agents = agents.filter((a) => String(a.status || "").toLowerCase() === wanted);
  }
  if (opts.kind) {
    agents = agents.filter((a) => String(a.kind || "") === String(opts.kind));
  }
  if (opts.runtime) {
    agents = agents.filter((a) => String(a.runtime || "") === String(opts.runtime));
  }
  if (opts.runningOnly || opts.running_only) {
    agents = agents.filter((a) => a.status === "running" || activeRuns.has(a.id));
  }
  if (opts.search) {
    const q = String(opts.search).toLowerCase();
    agents = agents.filter(
      (a) =>
        String(a.goal || "").toLowerCase().includes(q) ||
        String(a.kind || "").toLowerCase().includes(q) ||
        String(a.id || "").toLowerCase().includes(q)
    );
  }

  return agents.slice(0, limit).map(formatAgentForJake);
}

function missingApiKeyResponse() {
  return {
    ok: false,
    error: "missing_api_key",
    hint: "Add CURSOR_API_KEY to workbuddy/.env.local (create one at https://cursor.com/settings).",
  };
}

function formatAgentForJake(entry, overrides = {}) {
  if (!entry) return null;
  const status = overrides.status != null ? overrides.status : entry.status;
  const isRunning =
    overrides.isRunning != null
      ? overrides.isRunning
      : status === "running" || activeRuns.has(entry.id);
  return {
    id: entry.id,
    kind: entry.kind || null,
    goal: entry.goal || null,
    status: status || null,
    friendlyStatus: statusHelpers.friendlyStatus(status, isRunning),
    isRunning,
    runtime: entry.runtime || null,
    openUrl: entry.openUrl || null,
    runId: entry.runId || null,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
    resultPreview: entry.result ? String(entry.result).slice(0, 240) : null,
    error: entry.error || null,
    archived: Boolean(entry.archived),
  };
}

function buildJakeSummary(entry, extras = {}) {
  const formatted = formatAgentForJake(entry, {
    status: extras.effectiveStatus,
    isRunning: extras.isRunning,
  }) || {};
  const lines = [
    `${formatted.friendlyStatus || "Unknown"} — ${formatted.kind || "agent"}: ${(formatted.goal || "(no goal)").slice(0, 120)}`,
    `Id: ${formatted.id || extras.id || "?"}`,
  ];
  if (formatted.runtime) lines.push(`Runtime: ${formatted.runtime}`);
  if (formatted.isRunning) {
    const runningFor = statusHelpers.formatDurationMs(
      statusHelpers.ageMsFromIso(formatted.updatedAt)
    );
    lines.push(runningFor ? `Working for about ${runningFor}.` : "It is working right now.");
  }
  if (extras.runDurationMs != null) {
    const dur = statusHelpers.formatDurationMs(extras.runDurationMs);
    if (dur) lines.push(`Last run took ${dur}.`);
  }
  if (formatted.resultPreview) lines.push(`Latest result: ${formatted.resultPreview}`);
  if (extras.liveRunStatus) lines.push(`Live run status: ${extras.liveRunStatus}`);
  if (extras.statusNote) lines.push(extras.statusNote);
  if (formatted.openUrl) lines.push(`Open in Cursor: ${formatted.openUrl}`);
  if (extras.whatNext) lines.push(`Next: ${extras.whatNext}`);
  return lines.join("\n");
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

function isCloudAgentId(id) {
  return String(id || "").startsWith("bc-");
}

function resolveRuntime(agentId, known) {
  if (known && known.runtime) return known.runtime;
  return isCloudAgentId(agentId) ? "cloud" : "local";
}

function buildListRunsOptions(agentId, known, apiKey) {
  const runtime = resolveRuntime(agentId, known);
  if (runtime === "cloud") {
    return { runtime: "cloud", apiKey, limit: 5 };
  }
  return { runtime: "local", cwd: (known && known.cwd) || resolveCwd(), limit: 5 };
}

function buildGetRunOptions(agentId, known, apiKey) {
  const runtime = resolveRuntime(agentId, known);
  if (runtime === "cloud") {
    return { runtime: "cloud", agentId, apiKey };
  }
  return { runtime: "local", cwd: (known && known.cwd) || resolveCwd() };
}

function applyRunResult(agentId, result, timedOut) {
  const summary =
    (result && (result.result || result.status)) ||
    (result && result.status) ||
    (timedOut ? "timeout" : "finished");
  const nextStatus = statusHelpers.terminalRunStatus(result, timedOut);
  return upsertAgent({
    id: agentId,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
    result: typeof summary === "string" ? summary.slice(0, 12000) : String(summary).slice(0, 12000),
    error:
      nextStatus === "error"
        ? (result && result.error && result.error.message) || "run_error"
        : nextStatus === "timeout"
          ? "Agent run exceeded the time limit and was stopped."
          : null,
  });
}

async function runAgentLoop(agentId, agent, run) {
  activeRuns.set(agentId, { run, agent });
  upsertAgent({
    id: agentId,
    runId: run.id,
    status: "running",
    updatedAt: new Date().toISOString(),
  });
  try {
    const { result, timedOut } = await statusHelpers.waitWithTimeout(run, statusHelpers.getRunTimeoutMs());
    applyRunResult(agentId, result, timedOut);
  } catch (err) {
    upsertAgent({
      id: agentId,
      status: "error",
      updatedAt: new Date().toISOString(),
      error: err && err.message ? err.message : String(err),
    });
  } finally {
    activeRuns.delete(agentId);
    try {
      if (agent && typeof agent[Symbol.asyncDispose] === "function") {
        await agent[Symbol.asyncDispose]();
      }
    } catch {
      // ignore dispose errors
    }
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
      await runAgentLoop(agentId, agent, run);
    } catch (err) {
      upsertAgent({
        id: agentId,
        status: "error",
        updatedAt: new Date().toISOString(),
        error: err && err.message ? err.message : String(err),
      });
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
    const { result, timedOut } = await statusHelpers.waitWithTimeout(run, statusHelpers.getRunTimeoutMs());
    const entry = applyRunResult(agentId, result, timedOut);
    entry.openUrl =
      String(agentId).startsWith("bc-")
        ? `https://cursor.com/agents?id=${encodeURIComponent(agentId)}`
        : (known && known.openUrl) || null;
    upsertAgent({ id: agentId, openUrl: entry.openUrl });
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
  const agent = formatAgentForJake(entry);
  return {
    ok: true,
    agent,
    summary: buildJakeSummary(entry),
  };
}

/**
 * Stop/cancel a running Cursor agent by id.
 * Uses in-memory handle when available, otherwise Agent.listRuns + cancel.
 */
async function stopAgent({ id, apiKey }) {
  const key = String(apiKey || "").trim();
  if (!key) {
    return {
      ok: false,
      error: "missing_api_key",
      hint: "Add CURSOR_API_KEY to workbuddy/.env.local.",
    };
  }

  const agentId = String(id || "").trim();
  if (!agentId) return { ok: false, error: "missing_id" };

  const known = getAgent(agentId);
  const held = activeRuns.get(agentId);

  if (held && held.run) {
    try {
      if (held.run.status === "running") {
        await held.run.cancel();
      }
      upsertAgent({
        id: agentId,
        status: "cancelled",
        runId: held.run.id,
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: true,
        id: agentId,
        runId: held.run.id,
        status: "cancelled",
        message: "Agent run cancelled.",
      };
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (/not cancellable|already|terminal|409/i.test(msg)) {
        return {
          ok: true,
          id: agentId,
          runId: held.run.id,
          status: "already_stopped",
          message: msg,
        };
      }
      // Fall through to listRuns lookup.
    }
  }

  const { Agent } = await loadSdk();

  try {
    const runs = await Agent.listRuns(agentId, buildListRunsOptions(agentId, known, key));
    const items = runs.items || [];
    const activeRun = items.find((run) => run.status === "running");

    if (!activeRun && known && known.runId) {
      try {
        const run = await Agent.getRun(known.runId, buildGetRunOptions(agentId, known, key));
        if (run.status === "running") {
          await run.cancel();
          upsertAgent({
            id: agentId,
            status: "cancelled",
            runId: known.runId,
            updatedAt: new Date().toISOString(),
          });
          return {
            ok: true,
            id: agentId,
            runId: known.runId,
            status: "cancelled",
            message: "Agent run cancelled.",
          };
        }
      } catch {
        // ignore and continue
      }
    }

    if (!activeRun) {
      const registryStatus = known && known.status;
      if (registryStatus && registryStatus !== "running") {
        return {
          ok: true,
          id: agentId,
          status: "already_stopped",
          message: `Agent is already ${registryStatus}.`,
        };
      }
      return {
        ok: true,
        id: agentId,
        status: "not_running",
        message: "No active run found for this agent.",
      };
    }

    await activeRun.cancel();
    upsertAgent({
      id: agentId,
      status: "cancelled",
      runId: activeRun.id,
      updatedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      id: agentId,
      runId: activeRun.id,
      status: "cancelled",
      message: "Agent run cancelled.",
    };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/not cancellable|already|terminal|409|not found/i.test(msg)) {
      return {
        ok: true,
        id: agentId,
        status: "already_stopped",
        message: msg,
      };
    }
    return {
      ok: false,
      error: msg || "stop_failed",
      id: agentId,
    };
  }
}

async function continueAgentInBackground({ id, message, apiKey }) {
  const key = String(apiKey || "").trim();
  if (!key) return missingApiKeyResponse();

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

  (async () => {
    try {
      const agent = await Agent.resume(agentId, resumeOpts);
      const run = await agent.send(text);
      await runAgentLoop(agentId, agent, run);
    } catch (err) {
      upsertAgent({
        id: agentId,
        status: "error",
        updatedAt: new Date().toISOString(),
        error: err && err.message ? err.message : String(err),
      });
    }
  })();

  return {
    ok: true,
    id: agentId,
    status: "running",
    message: "Agent is working on your message in the background.",
    hint: "Use cursor_agent_status to check progress, or cursor_stop_agent to stop it.",
  };
}

/**
 * Pause = stop in Cursor's API (there is no separate pause).
 */
async function pauseAgent(args) {
  const out = await stopAgent(args);
  if (out.ok) {
    return {
      ...out,
      status: out.status === "cancelled" ? "paused" : out.status,
      message:
        out.status === "cancelled" || out.status === "paused"
          ? "Agent paused. You can restart it later with cursor_restart_agent."
          : out.message,
    };
  }
  return out;
}

/**
 * Stop the current run, then send a fresh continue message in the background.
 */
async function restartAgent({ id, message, apiKey }) {
  const agentId = String(id || "").trim();
  if (!agentId) return { ok: false, error: "missing_id" };

  const known = getAgent(agentId);
  await stopAgent({ id: agentId, apiKey });

  const restartMessage =
    String(message || "").trim() ||
    (known && known.goal
      ? `Please restart and continue this task.\n\nOriginal goal:\n${known.goal}`
      : "Please restart and continue where you left off.");

  return continueAgentInBackground({
    id: agentId,
    message: restartMessage,
    apiKey,
  });
}

async function agentStatusDetailed({ id, apiKey, autoFixStale = true }) {
  const agentId = String(id || "").trim();
  if (!agentId) return { ok: false, error: "missing_id" };

  const registry = getAgent(agentId);
  const held = activeRuns.get(agentId);
  const live = { recentRuns: [], cloud: null, checkedAt: new Date().toISOString() };

  const key = String(apiKey || "").trim();
  if (key) {
    try {
      const { Agent } = await loadSdk();
      const runtime = resolveRuntime(agentId, registry);
      if (runtime === "cloud" && isCloudAgentId(agentId)) {
        try {
          const info = await Agent.get(agentId, { apiKey: key });
          live.cloud = {
            name: info.name,
            status: info.status,
            archived: info.archived,
            repos: info.runtime === "cloud" ? info.repos : undefined,
            url: `https://cursor.com/agents?id=${encodeURIComponent(agentId)}`,
          };
        } catch {
          // ignore cloud metadata errors
        }
      }
      const runs = await Agent.listRuns(agentId, buildListRunsOptions(agentId, registry, key));
      live.recentRuns = (runs.items || []).slice(0, 5).map((run) => ({
        id: run.id,
        status: run.status,
        resultPreview: run.result ? String(run.result).slice(0, 400) : null,
        durationMs: run.durationMs || null,
      }));
    } catch (err) {
      live.error = err && err.message ? err.message : String(err);
    }
  }

  const resolved = statusHelpers.resolveEffectiveStatus({
    held: held && held.run,
    recentRuns: live.recentRuns,
    cloudStatus: live.cloud?.status,
    registryStatus: registry?.status,
    registryUpdatedAt: registry?.updatedAt,
  });

  let { effectiveStatus, isRunning, isStale, liveRun, latestRun } = resolved;

  if (autoFixStale && registry && registry.status === "running" && !isRunning && isStale) {
    upsertAgent({
      id: agentId,
      status: effectiveStatus,
      updatedAt: new Date().toISOString(),
    });
  }

  if (!registry && !live.cloud && live.recentRuns.length === 0) {
    return { ok: false, error: "not_found", id: agentId };
  }

  const merged = formatAgentForJake(
    registry || {
      id: agentId,
      kind: null,
      goal: live.cloud?.name || null,
      status: effectiveStatus,
      runtime: isCloudAgentId(agentId) ? "cloud" : "local",
      openUrl: isCloudAgentId(agentId)
        ? `https://cursor.com/agents?id=${encodeURIComponent(agentId)}`
        : null,
    },
    { status: effectiveStatus, isRunning }
  );

  let whatNext = "Use cursor_continue_agent to send another message.";
  if (isRunning) whatNext = "It is working now. Use cursor_stop_agent to pause it.";
  else if (effectiveStatus === "cancelled") whatNext = "It was stopped. Use cursor_restart_agent to pick back up.";
  else if (effectiveStatus === "finished") whatNext = "It finished. Use cursor_continue_agent if you want more.";
  else if (effectiveStatus === "timeout") whatNext = "It ran too long and stopped. Use cursor_restart_agent to try again.";
  else if (effectiveStatus === "stale") whatNext = "It may have stopped while Workbuddy was closed. Use cursor_agent_details or cursor_restart_agent.";

  const statusNote = statusHelpers.buildStatusNote({
    isStale,
    liveError: live.error,
    checkedAt: live.checkedAt,
    registryUpdatedAt: registry?.updatedAt,
  });

  return {
    ok: true,
    id: agentId,
    agent: merged,
    live,
    summary: buildJakeSummary(registry || merged, {
      id: agentId,
      effectiveStatus,
      isRunning,
      liveRunStatus: liveRun?.status || latestRun?.status || null,
      runDurationMs: latestRun?.durationMs ?? null,
      statusNote,
      whatNext,
    }),
  };
}

async function reconcileRunningAgents({ apiKey, silent = false } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) return { ok: false, error: "missing_api_key" };

  const running = loadRegistry().agents.filter((a) => a.status === "running");
  const updates = [];

  for (const agent of running) {
    if (activeRuns.has(agent.id)) continue;
    try {
      const detail = await agentStatusDetailed({ id: agent.id, apiKey: key, autoFixStale: true });
      if (!detail.ok) continue;
      const nextStatus = detail.agent?.status;
      if (nextStatus && nextStatus !== agent.status) {
        updates.push({ id: agent.id, from: agent.status, to: nextStatus });
      }
    } catch (err) {
      if (!silent) {
        console.warn("Agent reconcile failed for", agent.id, err.message || err);
      }
    }
  }

  return { ok: true, checked: running.length, updates };
}

let statusPollTimer = null;

function startStatusPolling(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key || statusPollTimer) return;
  statusPollTimer = setInterval(() => {
    reconcileRunningAgents({ apiKey: key, silent: true }).catch(() => {});
  }, 60_000);
  if (statusPollTimer.unref) statusPollTimer.unref();
}

function stopStatusPolling() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

async function listCloudAgents({ limit = 15, includeArchived = false, apiKey }) {
  const key = String(apiKey || "").trim();
  if (!key) return missingApiKeyResponse();

  const { Agent } = await loadSdk();
  const result = await Agent.list({
    runtime: "cloud",
    apiKey: key,
    limit: Math.max(1, Math.min(Number(limit) || 15, 50)),
    includeArchived: Boolean(includeArchived),
  });

  const registryById = new Map(loadRegistry().agents.map((a) => [a.id, a]));
  const agents = (result.items || []).map((info) => {
    const reg = registryById.get(info.agentId);
    const merged = formatAgentForJake({
      ...(reg || {}),
      id: info.agentId,
      kind: reg?.kind || null,
      goal: reg?.goal || info.name || info.summary || null,
      status: info.status || reg?.status || null,
      runtime: "cloud",
      openUrl: `https://cursor.com/agents?id=${encodeURIComponent(info.agentId)}`,
      archived: info.archived,
    });
    merged.name = info.name;
    merged.summary = info.summary;
    merged.archived = Boolean(info.archived);
    merged.startedByCog = Boolean(reg);
    return merged;
  });

  return {
    ok: true,
    agents,
    count: agents.length,
    hint: "These are Jake's cloud agents in Cursor. startedByCog=true means Cog started them.",
  };
}

async function archiveAgent({ id, apiKey }) {
  const key = String(apiKey || "").trim();
  if (!key) return missingApiKeyResponse();
  const agentId = String(id || "").trim();
  if (!agentId) return { ok: false, error: "missing_id" };
  if (!isCloudAgentId(agentId)) {
    return {
      ok: false,
      error: "cloud_only",
      message: "Only cloud agents (bc-...) can be archived. Local agents stay in Cog's list.",
    };
  }

  const { Agent } = await loadSdk();
  await Agent.archive(agentId, { apiKey: key });
  upsertAgent({
    id: agentId,
    archived: true,
    updatedAt: new Date().toISOString(),
  });
  return {
    ok: true,
    id: agentId,
    message: "Agent archived — hidden from the main Cursor list but not deleted.",
  };
}

async function unarchiveAgent({ id, apiKey }) {
  const key = String(apiKey || "").trim();
  if (!key) return missingApiKeyResponse();
  const agentId = String(id || "").trim();
  if (!agentId) return { ok: false, error: "missing_id" };
  if (!isCloudAgentId(agentId)) {
    return { ok: false, error: "cloud_only", message: "Only cloud agents can be unarchived." };
  }

  const { Agent } = await loadSdk();
  await Agent.unarchive(agentId, { apiKey: key });
  upsertAgent({
    id: agentId,
    archived: false,
    updatedAt: new Date().toISOString(),
  });
  return {
    ok: true,
    id: agentId,
    message: "Agent restored — it will show up in Cursor again.",
  };
}

async function deleteAgent({ id, confirm, apiKey }) {
  const key = String(apiKey || "").trim();
  if (!key) return missingApiKeyResponse();
  const agentId = String(id || "").trim();
  if (!agentId) return { ok: false, error: "missing_id" };

  const confirmed =
    confirm === true ||
    confirm === 1 ||
    String(confirm || "").toLowerCase() === "true" ||
    String(confirm || "").toLowerCase() === "yes";
  if (!confirmed) {
    return {
      ok: false,
      error: "need_confirm",
      message:
        "Permanent delete needs confirm=true. Only use when Jake clearly asks to delete an agent forever.",
    };
  }

  if (isCloudAgentId(agentId)) {
    await stopAgent({ id: agentId, apiKey: key }).catch(() => {});
    const { Agent } = await loadSdk();
    await Agent.delete(agentId, { apiKey: key });
  }

  const reg = loadRegistry();
  reg.agents = reg.agents.filter((a) => a.id !== agentId);
  saveRegistry(reg);
  activeRuns.delete(agentId);

  return {
    ok: true,
    id: agentId,
    message: isCloudAgentId(agentId)
      ? "Agent permanently deleted from Cursor."
      : "Agent removed from Cog's list.",
  };
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
  continueAgentInBackground,
  stopAgent,
  pauseAgent,
  restartAgent,
  agentStatus,
  agentStatusDetailed,
  reconcileRunningAgents,
  startStatusPolling,
  stopStatusPolling,
  listAgents,
  listCloudAgents,
  archiveAgent,
  unarchiveAgent,
  deleteAgent,
  openAgentInBrowser,
  readApiKey,
  REGISTRY_PATH,
};
