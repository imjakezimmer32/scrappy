// Passive "hey cog" listener — lightweight Web Speech API, not ElevenLabs.
// Starts a full voice session via buddy.js when the wake phrase is heard.

const COOLDOWN_MS = 2500;
const RESTART_DELAY_MS = 350;

let recognition = null;
let listening = false;
let paused = false;
let hooks = {};
let lastWake = 0;
let restartTimer = null;

function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function matchesWake(text) {
  if (window.CogWakePhrases && window.CogWakePhrases.matchesWakePhrase) {
    return window.CogWakePhrases.matchesWakePhrase(text);
  }
  return /\bhey[\s,]+cog\b/i.test(String(text || ""));
}

function ensureRecognition() {
  const SR = getSpeechRecognition();
  if (!SR) return null;
  if (recognition) return recognition;

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.maxAlternatives = 3;

  recognition.onresult = (event) => {
    if (paused || !listening) return;
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = (result[0] && result[0].transcript) || "";
      if (!matchesWake(transcript)) continue;
      const now = Date.now();
      if (now - lastWake < COOLDOWN_MS) return;
      lastWake = now;
      pause();
      if (typeof hooks.onWake === "function") hooks.onWake(transcript.trim());
      return;
    }
  };

  recognition.onend = () => {
    if (!listening || paused) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!listening || paused) return;
      try {
        recognition.start();
      } catch {
        // already running
      }
    }, RESTART_DELAY_MS);
  };

  recognition.onerror = (event) => {
    const code = event && event.error ? event.error : "unknown";
    if (code === "not-allowed") {
      listening = false;
      paused = false;
      if (typeof hooks.onError === "function") hooks.onError("mic_denied");
      return;
    }
    if (code === "aborted") return;
    if (code === "no-speech" || code === "audio-capture") {
      recognition.onend();
      return;
    }
    if (typeof hooks.onError === "function") hooks.onError(code);
    recognition.onend();
  };

  return recognition;
}

function start() {
  const rec = ensureRecognition();
  if (!rec) {
    if (typeof hooks.onError === "function") hooks.onError("unsupported");
    return { ok: false, error: "unsupported" };
  }
  listening = true;
  paused = false;
  try {
    rec.start();
    if (typeof hooks.onListenStart === "function") hooks.onListenStart();
    return { ok: true };
  } catch (err) {
    const msg = err && err.message ? err.message : "start_failed";
    if (/already/i.test(msg)) return { ok: true, already: true };
    return { ok: false, error: msg };
  }
}

function stop() {
  listening = false;
  paused = false;
  clearTimeout(restartTimer);
  try {
    if (recognition) recognition.stop();
  } catch {
    // ignore
  }
  if (typeof hooks.onListenStop === "function") hooks.onListenStop();
}

function pause() {
  if (!listening) return;
  paused = true;
  clearTimeout(restartTimer);
  try {
    if (recognition) recognition.stop();
  } catch {
    // ignore
  }
}

function resume() {
  if (!listening) return;
  paused = false;
  try {
    if (recognition) recognition.start();
  } catch {
    ensureRecognition()?.onend?.();
  }
}

window.CogWake = {
  init(callbacks) {
    hooks = callbacks || {};
  },
  start,
  stop,
  pause,
  resume,
  isListening: () => listening && !paused,
  isSupported: () => Boolean(getSpeechRecognition()),
};
