// Shared wake-phrase matching for Scrappy (browser + node tests).

const WAKE_PHRASES = [
  /\bhey[\s,]+there[\s,]+scrappy\b/i,
  /\bokay[\s,]+then[\s,]+scrappy\b/i,
  /\bwake[\s,]+up[\s,]+scrappy\b/i,
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
  window.ScrappyWakePhrases = { matchesWakePhrase };
}
