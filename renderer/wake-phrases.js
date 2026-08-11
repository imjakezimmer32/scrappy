// Shared wake-phrase matching for Cog (browser + node tests).

const WAKE_PHRASES = [
  /\bhey[\s,]+there[\s,]+cog\b/i,
  /\bokay[\s,]+then[\s,]+cog\b/i,
  /\bwake[\s,]+up[\s,]+cog\b/i,
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
