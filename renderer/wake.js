// Thin bridge: main process owns the Windows wake-word mic loop.
// Renderer just pauses/resumes it around voice calls and reacts to hits.

window.CogWake = {
  init(hooks) {
    const bridge = window.workbuddy;
    if (!bridge || !bridge.onWake) return;
    bridge.onWake((payload) => {
      const phrase = payload && payload.phrase;
      if (typeof hooks.onWake === "function") hooks.onWake(phrase || "hey cog");
    });
  },
  start() {
    if (window.workbuddy && window.workbuddy.wakeResume) {
      window.workbuddy.wakeResume();
    }
  },
  stop() {
    if (window.workbuddy && window.workbuddy.wakePause) {
      window.workbuddy.wakePause();
    }
  },
  available() {
    return Boolean(window.workbuddy && window.workbuddy.onWake);
  },
};
