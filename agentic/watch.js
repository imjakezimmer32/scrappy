"use strict";

// Pure snapshot watcher. No IO. Highest-priority case wins; otherwise null.
// Window changes alone are not worth speaking about.

const IDLE_NUDGE_MS = 20 * 60 * 1000;
const ERROR_CLIP = 72;
const WINDOW_CLIP = 48;

function text(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function clip(value, max) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

function act(reason, action, speech) {
  return { shouldAct: true, reason, action, speech };
}

function observe(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;

  const error = text(snapshot.lastError);
  const repeats = snapshot.errorRepeatCount;
  if (typeof repeats === "number" && repeats >= 2 && error) {
    return act(
      "repeated-error",
      "fix-repeat",
      `Same error again: ${clip(error, ERROR_CLIP)}.`
    );
  }

  const status = snapshot.agentStatus;
  if (status === "stale" || status === "error") {
    return act(
      status === "stale" ? "agent-stale" : "agent-error",
      "check-agent",
      status === "stale" ? "I'll check the stale agent." : "I'll check the agent error."
    );
  }

  const idleMs = snapshot.idleMs;
  const windowName = text(snapshot.activeWindow);
  if (typeof idleMs === "number" && idleMs >= IDLE_NUDGE_MS && windowName) {
    return act(
      "idle-too-long",
      "nudge-idle",
      `I'll nudge the idle work on ${clip(windowName, WINDOW_CLIP)}.`
    );
  }

  return null;
}

module.exports = { observe };
