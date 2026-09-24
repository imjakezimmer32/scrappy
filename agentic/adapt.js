// Scrappy changes the next decision from what just happened.
// A correction makes him quieter and more careful. A run of successes
// lets him go further without asking. A failed approach is not repeated.

const store = require("./store");

const MAX_EVENTS = 40;

function record(filePath, input = {}) {
  const outcome = normalize(input.outcome);
  if (!outcome) return null;
  const event = {
    outcome,
    approach: String(input.approach || "").trim() || null,
    note: String(input.note || "").trim() || null,
    at: new Date().toISOString(),
  };
  store.update(filePath, (doc) => {
    const base = doc && typeof doc === "object" ? doc : {};
    const events = Array.isArray(base.adapt) ? base.adapt : [];
    events.unshift(event);
    return { ...base, adapt: events.slice(0, MAX_EVENTS) };
  });
  return event;
}

function stance(filePath) {
  const doc = store.read(filePath);
  const events = Array.isArray(doc.adapt) ? doc.adapt : [];
  const recent = events.slice(0, 5);
  const corrected = recent.filter((event) => event.outcome === "corrected").length;
  const worked = recent.filter((event) => event.outcome === "worked").length;
  const failed = recent.filter((event) => event.outcome === "failed");
  const avoid = [];
  const counts = {};
  failed.forEach((event) => {
    if (!event.approach) return;
    counts[event.approach] = (counts[event.approach] || 0) + 1;
    if (counts[event.approach] >= 2 && !avoid.includes(event.approach)) avoid.push(event.approach);
  });

  let autonomy = "act";
  let jokes = "normal";
  let maxHops = 3;
  if (corrected >= 2) {
    autonomy = "ask";
    jokes = "quiet";
    maxHops = 2;
  } else if (worked >= 3 && corrected === 0) {
    autonomy = "act";
    jokes = "normal";
    maxHops = 4;
  }

  const parts = [];
  if (autonomy === "ask") parts.push("Ask before the next step.");
  else parts.push("Proceed on reversible work.");
  if (jokes === "quiet") parts.push("Skip the joke.");
  if (avoid.length) parts.push(`Do not retry ${avoid.join(", ")}.`);
  return { autonomy, jokes, maxHops, avoid, speech: parts.join(" ") };
}

// Infer a lesson from what the person just said. No explicit rule required.
function hear(text) {
  const line = String(text || "").trim();
  if (!line) return null;
  if (/^(no|nope|stop|wrong|don'?t|do not|not that)\b/i.test(line) || /\b(that'?s wrong|that'?s not|you didn'?t|incorrect)\b/i.test(line)) {
    return { outcome: "corrected", approach: "last reply" };
  }
  if (/^(thanks|thank you|good|perfect|nice|yes|yep|great|exactly)\b/i.test(line)) {
    return { outcome: "worked", approach: null };
  }
  if (/\b(try again|not what i asked|you missed)\b/i.test(line)) {
    return { outcome: "failed", approach: "last reply" };
  }
  return null;
}

// If recent talk shows a miss, the next goal is to fix it. He sets this himself.
function selfFix(filePath) {
  const style = stance(filePath);
  if (style.avoid.length) {
    return { goal: `Fix this approach: ${style.avoid[0]}` };
  }
  if (style.autonomy === "ask") {
    return { goal: "Fix the last miss before taking the next step." };
  }
  return null;
}

function normalize(outcome) {
  const value = String(outcome || "").toLowerCase();
  if (value === "worked" || value === "success" || value === "completed") return "worked";
  if (value === "failed" || value === "error") return "failed";
  if (value === "corrected" || value === "no" || value === "stop") return "corrected";
  return null;
}

module.exports = { record, stance, hear, selfFix };
