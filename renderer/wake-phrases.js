// Shared wake-phrase matching for "hey cog" (browser + node tests).

const WAKE_PHRASES = [
  /\bhey[\s,]+cog\b/i,
  /\bhey[\s,]+chief\b/i,
  /\bhi[\s,]+cog\b/i,
  /\bok[\s,]+cog\b/i,
  /\ba[\s,]+cog\b/i,
];

function matchesWakePhrase(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return WAKE_PHRASES.some((re) => re.test(t));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { WAKE_PHRASES, matchesWakePhrase };
}

if (typeof window !== "undefined") {
  window.CogWakePhrases = { matchesWakePhrase };
}
