import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { computeThrust, PlayerBody } from '../src/physics/player.js';
import { CollisionWorld } from '../src/physics/collision.js';
import { FLIGHT } from '../src/config.js';

const look = new Vector3(0, 0, -1);
const out = new Vector3();

function world() {
  const w = new CollisionWorld({ minX: -200, minZ: -200, size: 400, cell: 32, coastZ: -1e9 });
  w.addBox(10, 0, -10, 30, 50, 10); // building to +x, 50 m tall
  w.build();
  return w;
}

function input(grip, extra = {}) {
  return {
    grip, boost: false, look, stickX: 0, stickY: 0,
    right: new Vector3(1, 0, 0), fwd: new Vector3(0, 0, -1), ...extra,
  };
}

test('light squeeze is pure vertical lift', () => {
  computeThrust(0.25, look, false, out);
  assert.ok(Math.abs(out.x) < 1e-9 && Math.abs(out.z) < 1e-9);
  assert.ok(out.y > 0);
});

test('some grip value hovers (thrust.y == g) with no forward drift', () => {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    computeThrust(m, look, false, out);
    if (out.y < FLIGHT.gravity) lo = m; else hi = m;
  }
  computeThrust(lo, look, false, out);
  assert.ok(lo > 0.1 && lo <= 0.25, `hover grip ${lo}`);
  assert.ok(Math.abs(out.z) < 0.5, 'hover has little forward push');
});

test('full grip looking forward climbs and moves forward', () => {
  computeThrust(1, look, false, out);
  assert.ok(out.z < -10, 'forward component');
  assert.ok(out.y > FLIGHT.gravity, 'still climbs');
});

test('full grip looking straight down dives', () => {
  computeThrust(1, new Vector3(0, -1, 0), false, out);
  assert.ok(out.y < 0);
});

test('hover plateau: a wide grip range gives exactly hover thrust', () => {
  for (const g of [0.22, 0.3, 0.4, 0.45]) {
    computeThrust(g, look, false, out);
    assert.ok(Math.abs(out.y - FLIGHT.gravity) < 1e-6, `g=${g} y=${out.y}`);
    assert.ok(Math.abs(out.z) < 1e-9);
  }
});

test('boost multiplies thrust', () => {
  const a = computeThrust(1, look, false, new Vector3()).length();
  const b = computeThrust(1, look, true, new Vector3()).length();
  assert.ok(Math.abs(b / a - FLIGHT.boostMult) < 1e-6);
});

test('hover assist settles vertical speed', () => {
  const p = new PlayerBody(world());
  p.reset(-50, 30, 0);
  p.vel.y = 3;
  let hoverGrip = 0.35;
  for (let i = 0; i < 90 * 4; i++) p.step(1 / 90, input(hoverGrip));
  assert.ok(Math.abs(p.vel.y) < 1.0, `vy=${p.vel.y}`);
});

test('drag gives a natural top speed', () => {
  const p = new PlayerBody(world());
  p.reset(-100, 100, 150);
  const dive = input(1, { look: new Vector3(0, 0.2, -1).normalize() });
  for (let i = 0; i < 90 * 20; i++) {
    p.step(1 / 90, dive);
    if (p.pos.z < -150) p.pos.z += 300; // keep inside open space
    if (p.pos.y > 150) p.pos.y = 100;
  }
  const sp = p.vel.length();
  assert.ok(sp > 30 && sp < 90, `top speed ${sp}`);
});

test('free fall lands on the ground', () => {
  const p = new PlayerBody(world());
  p.reset(-50, 20, 0);
  for (let i = 0; i < 90 * 5; i++) p.step(1 / 90, input(0));
  assert.ok(p.grounded);
  assert.ok(Math.abs(p.pos.y) < 1e-3);
});

test('lands on a roof', () => {
  const p = new PlayerBody(world());
  p.reset(20, 70, 0);
  for (let i = 0; i < 90 * 5; i++) p.step(1 / 90, input(0));
  assert.ok(p.grounded);
  assert.ok(Math.abs(p.pos.y - 50) < 0.05, `y=${p.pos.y}`);
});

test('flying into a wall slowly pushes out and reflects', () => {
  const p = new PlayerBody(world());
  p.reset(0, 20, 0);
  p.vel.set(23, 0, 0); // just under FLIGHT.smashSpeed
  let impact = 0;
  for (let i = 0; i < 60; i++) {
    p.step(1 / 90, input(0.33));
    impact = Math.max(impact, p.lastImpact);
  }
  assert.ok(p.pos.x <= 10 - FLIGHT.capsuleRadius + 1e-3, `x=${p.pos.x}`);
  assert.ok(p.vel.x <= 0, 'velocity reflected');
  assert.ok(impact > 5);
});

test('raycast hits building face and ground', () => {
  const w = world();
  const d = w.raycast(0, 20, 0, 1, 0, 0, 500);
  assert.ok(Math.abs(d - 10) < 1e-4);
  assert.deepEqual(w.hitNormal, [-1, 0, 0]);
  const g = w.raycast(-50, 10, 0, 0, -1, 0, 500);
  assert.ok(Math.abs(g - 10) < 1e-4);
  const miss = w.raycast(0, 80, 0, 1, 0, 0, 500);
  assert.equal(miss, 500);
});

test('pointInside', () => {
  const w = world();
  assert.ok(w.pointInside(20, 10, 0) >= 0);
  assert.equal(w.pointInside(0, 10, 0), -1);
});

test('fast impact smashes through the building and out the far side', () => {
  const p = new PlayerBody(world());
  p.reset(0, 20, 0);
  p.vel.set(60, 0, 0);
  const types = [];
  for (let i = 0; i < 90; i++) {
    p.eventCount = 0;
    p.step(1 / 90, input(0.6));
    for (let k = 0; k < p.eventCount; k++) types.push(p.events[k * 9]);
  }
  assert.ok(p.pos.x > 30, `x=${p.pos.x}`);
  assert.deepEqual(types.slice(0, 2), [1, 2]);
});

test('hard ground landing produces a crater event', () => {
  const p = new PlayerBody(world());
  p.reset(-60, 40, 0);
  p.vel.set(0, -35, 0);
  let crater = false;
  for (let i = 0; i < 180; i++) {
    p.eventCount = 0;
    p.step(1 / 90, input(0));
    for (let k = 0; k < p.eventCount; k++) if (p.events[k * 9] === 3) crater = true;
  }
  assert.ok(crater);
  assert.ok(p.grounded);
});
