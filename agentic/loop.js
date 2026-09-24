// Pure follow-up choice for one agentic hop. No I/O.

function spoken(text) {
  return String(text == null ? "" : text)
    .replace(/\?/g, "")
    .replace(/want me to/gi, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function leftoverLine(result) {
  const text = result == null ? "" : String(result);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (
      line.startsWith("TODO") ||
      line.startsWith("leftover:") ||
      line.startsWith("still open:")
    ) {
      return spoken(line);
    }
  }
  return "";
}

function summaryOf(result) {
  const text = result == null ? "" : String(result);
  const flat = text
    .split(/\r?\n/)
    .map((line) => spoken(line))
    .filter(Boolean)
    .join(" ");
  return flat || "Nothing came back.";
}

function decideFollowUp({ goal, result, goalMet, hops, maxHops } = {}) {
  const limit = maxHops == null ? 3 : maxHops;
  const current = hops == null ? 0 : hops;
  const aim = spoken(goal) || "the goal";

  if (goalMet === true) {
    return {
      action: "stop",
      message: "I finished it. The goal is met.",
      hops: current,
    };
  }

  if (current >= limit) {
    return {
      action: "stop",
      message: "I'm stopping so this does not loop forever.",
      hops: current,
    };
  }

  const leftover = leftoverLine(result);
  if (leftover) {
    return {
      action: "continue",
      message: `Same agent, finish this: "${leftover}".`,
      hops: current + 1,
    };
  }

  return {
    action: "next",
    message: `New step toward ${aim}: build on this result. ${summaryOf(result)}`,
    hops: current + 1,
  };
}

module.exports = { decideFollowUp };
