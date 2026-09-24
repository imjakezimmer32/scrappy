// A deadline nag names the verb he already took.

function nagLine(input = {}) {
  const sittingMs = Number(input.sittingMs) || 0;
  if (sittingMs < 60 * 60 * 1000) return null;
  const kind = String(input.kind || "work").trim() || "work";
  const action = String(input.actionTaken || "").trim();
  if (!action) return `${kind} has been sitting. I poked it.`;
  return `${kind} has been sitting. ${sentence(action)}`;
}

function sentence(action) {
  const text = action.replace(/\.$/, "");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

module.exports = { nagLine };
