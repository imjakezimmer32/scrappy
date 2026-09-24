// Try the tools he already has before asking a question. Ask only when every
// relevant tool has been tried and one fact is still missing.

const TOOLS = ["recall", "cursor-chats", "system-context", "agent-status"];

function shouldAsk(input = {}) {
  const missing = asList(input.missingFacts);
  if (!missing.length) return { ask: false, nextTool: null, question: null };
  const tried = new Set(asList(input.toolsTried));
  const nextTool = TOOLS.find((name) => !tried.has(name)) || null;
  if (nextTool) return { ask: false, nextTool, question: null };
  return {
    ask: true,
    nextTool: null,
    question: `I need ${missing[0]} before I can continue.`,
  };
}

function asList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

module.exports = { TOOLS, shouldAsk };
