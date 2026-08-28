const { test } = require("node:test");
const assert = require("node:assert/strict");
const hunt = require("../renderer/cursor-hunt");

test("cursor is in grab range near the floor and not when it is high", () => {
  const floor = 1000;
  assert.equal(hunt.inGrabBand(floor - 40, floor, false), true);
  assert.equal(hunt.inGrabBand(floor - 160, floor, false), true);
  assert.equal(hunt.inGrabBand(floor - 200, floor, false), false);
  assert.equal(hunt.inGrabBand(floor - 200, floor, true), true);
  assert.equal(hunt.inGrabBand(floor + 30, floor, false), false);
});

test("dwell requires the cursor to linger", () => {
  assert.equal(hunt.dwellReady(0, 1000), false);
  assert.equal(hunt.dwellReady(1000, 1200), false);
  assert.equal(hunt.dwellReady(1000, 1000 + hunt.DWELL_MS), true);
});

test("hand snaps only when the cursor is close", () => {
  const hand = { x: 100, y: 900 };
  assert.equal(hunt.handCanGrab(hand, { x: 110, y: 910 }), true);
  assert.equal(hunt.handCanGrab(hand, { x: 400, y: 900 }), false);
});

test("a straight flick does not shake him off", () => {
  const s = hunt.createShake();
  let t = 0;
  hunt.tickShake(s, 0, 0, t);
  t += 16;
  hunt.tickShake(s, 40, 0, t);
  t += 16;
  hunt.tickShake(s, 90, 0, t);
  t += 16;
  hunt.tickShake(s, 160, 0, t);
  assert.equal(hunt.shouldBreakOff(s.energy, false), false);
});

test("vigorous reversals build enough energy to break off", () => {
  const s = hunt.createShake();
  let t = 0;
  let x = 0;
  hunt.tickShake(s, x, 0, t);
  for (let i = 0; i < 10; i += 1) {
    t += 40;
    x = i % 2 === 0 ? 80 : -80;
    hunt.tickShake(s, x, 0, t);
  }
  assert.ok(s.energy >= hunt.SHAKE_NEED);
  assert.equal(hunt.shouldBreakOff(s.energy, false), true);
});

test("smashing through a monitor always lets go", () => {
  assert.equal(hunt.shouldBreakOff(0, true), true);
  assert.equal(hunt.shouldBreakOff(0, false), false);
});

test("cursor has to be on his monitor", () => {
  const screen = { left: 0, right: 1920 };
  assert.equal(hunt.onScreen(200, screen), true);
  assert.equal(hunt.onScreen(2200, screen), false);
});
