// Thin bridge: main process owns the Windows wake-word mic loop.
// Renderer just pauses/resumes it around voice calls and reacts to hits.

window.ScrappyWake = {
  init(hooks) {
    const bridge = window.scrappy;
    if (!bridge || !bridge.onWake) return;
    bridge.onWake((payload) => {
      const phrase = payload && payload.phrase;
      if (typeof hooks.onWake === "function") hooks.onWake(phrase || "hey scrappy");
    });
  },
  start() {
    if (window.scrappy && window.scrappy.wakeResume) {
      window.scrappy.wakeResume();
    }
  },
  stop() {
    if (window.scrappy && window.scrappy.wakePause) {
      window.scrappy.wakePause();
    }
  },
  available() {
    return Boolean(window.scrappy && window.scrappy.onWake);
  },
};
