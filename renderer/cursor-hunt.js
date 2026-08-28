// Pure hunt / cling math. Shared by the overlay and the site demo so a
// shake that lets go in one place lets go in the other. Loaded as a classic
// script in the renderer (window.ScrappyHunt) and as CommonJS in tests.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ScrappyHunt = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Cursor has to come down to his height. 168px above the floor is about
  // a hand's reach over his head; below the floor is the taskbar, which he
  // can still swipe at if you dip into it.
  const REACH_ABOVE_FLOOR = 168;
  const REACH_HYSTERESIS = 40;
  const DWELL_MS = 380;
  const GRAB_RADIUS = 42;
  const MISS_COOLDOWN_MS = 11000;
  const RELEASE_COOLDOWN_MS = 16000;
  const CHASE_MS = 5200;

  // A reversal only counts if both the inbound and outbound legs are fast.
  // Ordinary mouse travel is a few hundred px/s; a real shake is thousands.
  const SHAKE_SPEED = 1200;
  const SHAKE_NEED = 7.2;
  const SHAKE_DECAY = 2.4;
  const SHAKE_PUNCH_CAP = 2.2;

  function inGrabBand(pointerY, floorY, latched) {
    if (pointerY == null || floorY == null) return false;
    const above = floorY - pointerY;
    if (above < -18) return false;
    const max = latched ? REACH_ABOVE_FLOOR + REACH_HYSTERESIS : REACH_ABOVE_FLOOR;
    return above <= max;
  }

  function onScreen(pointerX, screen) {
    if (!screen || pointerX == null) return false;
    return pointerX >= screen.left && pointerX <= screen.right;
  }

  function dwellReady(enteredAt, now, dwellMs) {
    if (!enteredAt) return false;
    return now - enteredAt >= (dwellMs == null ? DWELL_MS : dwellMs);
  }

  function handCanGrab(hand, pointer, radius) {
    if (!hand || !pointer) return false;
    const r = radius == null ? GRAB_RADIUS : radius;
    return Math.hypot(pointer.x - hand.x, pointer.y - hand.y) <= r;
  }

  function cooldownMs(reason) {
    return reason === "miss" ? MISS_COOLDOWN_MS : RELEASE_COOLDOWN_MS;
  }

  function createShake() {
    return { energy: 0, lastX: null, lastY: null, lastT: 0, lastVx: 0, lastVy: 0 };
  }

  function tickShake(state, x, y, now) {
    if (!state) return 0;
    if (state.lastT) {
      const dt = Math.max(0.001, (now - state.lastT) / 1000);
      const vx = (x - state.lastX) / dt;
      const vy = (y - state.lastY) / dt;
      const speed = Math.hypot(vx, vy);
      const prev = Math.hypot(state.lastVx, state.lastVy);
      const reversed = state.lastVx * vx + state.lastVy * vy < 0 && speed > SHAKE_SPEED && prev > SHAKE_SPEED;
      if (reversed) {
        const punch = Math.min(SHAKE_PUNCH_CAP, (speed / SHAKE_SPEED) * 0.85);
        state.energy += punch;
      } else {
        state.energy = Math.max(0, state.energy - SHAKE_DECAY * dt);
      }
      state.lastVx = vx;
      state.lastVy = vy;
    }
    state.lastX = x;
    state.lastY = y;
    state.lastT = now;
    return state.energy;
  }

  function shouldBreakOff(energy, shattered) {
    return Boolean(shattered) || energy >= SHAKE_NEED;
  }

  return {
    REACH_ABOVE_FLOOR,
    REACH_HYSTERESIS,
    DWELL_MS,
    GRAB_RADIUS,
    MISS_COOLDOWN_MS,
    RELEASE_COOLDOWN_MS,
    CHASE_MS,
    SHAKE_SPEED,
    SHAKE_NEED,
    inGrabBand,
    onScreen,
    dwellReady,
    handCanGrab,
    cooldownMs,
    createShake,
    tickShake,
    shouldBreakOff,
  };
});
