// A turn ends with a tool already fired or one real question.
// "Want me to" is not a finished turn.

function closeTurn(input = {}) {
  const toolFired = input.toolFired === true;
  const question = String(input.question || "").trim();
  if (toolFired) return { ok: true, speech: null };
  if (!question) return { ok: false, error: "no_commitment" };
  if (/want me to/i.test(question)) return { ok: false, error: "not_a_commitment" };
  if (!question.endsWith("?")) return { ok: false, error: "not_a_question" };
  return { ok: true, speech: question };
}

module.exports = { closeTurn };
