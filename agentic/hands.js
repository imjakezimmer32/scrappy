// Narrow local actions. Anything else is refused.

const ALLOWED = new Set(["read-log", "run-known-script", "open-pr-url"]);

function isAllowed(name) {
  return ALLOWED.has(String(name || ""));
}

function describe(name) {
  if (!isAllowed(name)) return { ok: false, error: "not_allowed" };
  return { ok: true, name: String(name), local: true };
}

module.exports = { ALLOWED, isAllowed, describe };
