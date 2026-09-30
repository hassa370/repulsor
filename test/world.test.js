import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { ORIGIN, PLANET, SPEED_CURVE, TERRAIN, WORLD, WORLD_BUDGET } from '../src/config.js';
import { FloatingOrigin, GlobalPosition, SECTOR_SIZE } from '../src/world/core/FloatingOrigin.js';
import { GenerationScheduler } from '../src/world/core/GenerationScheduler.js';
import { PlanetSurface } from '../src/world/planet/PlanetSurface.js';
import { FACES, faceDir } from '../src/world/planet/CubeSphere.js';
import { sampleSurface, surfaceRadius } from '../src/world/planet/TerrainGenerator.js';
import { FlightRegime, REGIME, sampleCurve } from '../src/world/FlightRegime.js';
import { PlayerBody } from '../src/physics/player.js';
import { CollisionWorld, WATER_LEVEL } from '../src/physics/collision.js';

const R = PLANET.radius;

test('floating origin: global positions survive shifts; local stays small; local up = radial', () => {
  const fo = new FloatingOrigin(R);
  const p = new Vector3(), g = new Vector3(), ref = new Vector3(), tmp = new Vector3();
  // A stored local point (e.g. a projectile) and the player, both shifted by listeners.
  const proj = new Vector3(5, 20, -3);
  fo.onShift(() => { fo.applyPoint(p); fo.applyPoint(proj); });
  const projG = fo.localToGlobal(proj, new Vector3());
  // Fly the player 300 km east and 200 km up in 250 m steps (float64 reference in G).
  ref.set(0, R + 60, 0);
  fo.globalToLocal(ref, p);
  let maxLocal = 0;
  for (let i = 0; i < 1600; i++) {
    ref.x += 190; ref.y += 125;
    fo.globalToLocal(ref, tmp);
    p.copy(tmp);
    fo.update(p, g);
    if (!fo.anchored) maxLocal = Math.max(maxLocal, p.length());
  }
  assert.ok(!fo.anchored);
  assert.ok(fo.shiftCount > 300, `shifts ${fo.shiftCount}`);
  assert.ok(maxLocal <= ORIGIN.shiftDistance + 300, `max local ${maxLocal}`);
  fo.localToGlobal(p, g);
  assert.ok(g.distanceTo(ref) < 1e-6, `player drift ${g.distanceTo(ref)}`);
  fo.localToGlobal(proj, g);
  assert.ok(g.distanceTo(projG) < 1e-6, `projectile drift ${g.distanceTo(projG)}`);
  // Local +Y is the planet's up at the origin.
  const upG = fo.localDirToGlobal(new Vector3(0, 1, 0), new Vector3());
  const radial = fo.origin.clone().normalize();
  assert.ok(upG.dot(radial) > 1 - 1e-9);
});

test('floating origin: returning to the city re-anchors exactly (L == C)', () => {
  const fo = new FloatingOrigin(R);
  const p = new Vector3(), g = new Vector3();
  fo.onShift(() => fo.applyPoint(p));
  p.set(0, 100, 0);
  // leave the bubble upward, wander, come back down
  for (let y = 100; y < 9000; y += 200) { p.y += 200; fo.update(p, g); }
  assert.ok(!fo.anchored);
  for (let i = 0; i < 60; i++) { p.x += 300; fo.update(p, g); }
  for (let i = 0; i < 400; i++) {
    const c = fo.localToCity(p, new Vector3());
    const step = new Vector3(-c.x, 150 - c.y, -c.z).clampLength(0, 300);
    const dG = fo.localDirToGlobal(step, new Vector3());
    fo.globalDirToLocal(dG, step);
    p.add(step);
    fo.update(p, g);
  }
  assert.ok(fo.anchored);
  assert.equal(fo.q.w, 1);
  assert.deepEqual(fo.origin.toArray(), [0, R, 0]);
  const c = fo.localToCity(p, new Vector3());
  assert.ok(c.distanceTo(p) < 1e-9);
});

test('global position splits into sectors without losing precision', () => {
  const v = new Vector3(3.5e9 + 0.123, -2e6 - 7.25, 42.5);
  const gp = new GlobalPosition().setFromVector(v);
  assert.equal(gp.sx, Math.floor(v.x / SECTOR_SIZE));
  const back = gp.toVector(new Vector3());
  assert.ok(back.distanceTo(v) < 1e-5);
});

test('terrain is deterministic and exactly the city plane inside the flat zone', () => {
  for (const [x, z] of [[0, 0], [700, 400], [-1500, 900], [-600, -1500], [2000, 800]]) {
    const d = new Vector3(x, R, z).normalize();
    const s = sampleSurface(d.x, d.y, d.z);
    const planeY = z < WORLD.coastZ ? WATER_LEVEL : 0;
    // radius of the y = planeY plane in this direction
    const rPlane = (R + planeY) / d.y;
    assert.ok(Math.abs(s.r - rPlane) < 1e-6, `(${x},${z}) ${s.r - rPlane}`);
    assert.equal(surfaceRadius(d.x, d.y, d.z), s.r);
  }
  const d = new Vector3(0.3, 0.8, -0.52).normalize();
  assert.equal(surfaceRadius(d.x, d.y, d.z), surfaceRadius(d.x, d.y, d.z));
  const h = surfaceRadius(d.x, d.y, d.z) - R;
  assert.ok(h > -2000 && h < 9000, `height ${h}`);
});

test('cube faces: outward orientation and seamless face directions', () => {
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  for (let f = 0; f < 6; f++) {
    faceDir(f, 0, 0, a);
    assert.deepEqual(a.map((x) => Math.round(x)), FACES[f].n);
    faceDir(f, 0.1, 0, b); faceDir(f, 0, 0.1, c);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    assert.ok(n[0] * a[0] + n[1] * a[1] + n[2] * a[2] > 0, `face ${f} winding`);
  }
  // Edge between +Y (u = 1) and +X (u = -1 on its x axis = -z...) meet at the same direction.
  faceDir(2, 1, 0.3, a);
  let best = 1;
  for (let f = 0; f < 6; f++) {
    if (f === 2) continue;
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
      const u = -1 + i / 20, v = -1 + j / 20;
      if (Math.abs(u) !== 1 && Math.abs(v) !== 1) continue;
      faceDir(f, u, v, b);
      best = Math.min(best, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  assert.ok(best < 0.03);
});

function makeSurface() {
  const fo = new FloatingOrigin(R);
  const sch = new GenerationScheduler(1e9);
  return { fo, sch, ps: new PlanetSurface(fo, sch) };
}

test('chunk geometry: grid faces outward, neighbour edges match, bounds contain vertices', () => {
  const { ps } = makeSurface();
  const N = TERRAIN.vertsPerSide;
  const nA = ps.getNode(2, 9, 255, 256), nB = ps.getNode(2, 9, 256, 256);
  const ca = ps.slots[0], cb = ps.slots[1];
  ps.buildChunk(nA, ca);
  const posA = Float64Array.from(ps.pos, (v, i) => v + [ca.cx, ca.cy, ca.cz][i % 3]);
  const nrmA = Float32Array.from(ps.nrm);
  ps.buildChunk(nB, cb);
  const posB = Float64Array.from(ps.pos, (v, i) => v + [cb.cx, cb.cy, cb.cz][i % 3]);
  // shared edge: right edge of A (i = N-1) == left edge of B (i = 0)
  let maxErr = 0;
  for (let j = 0; j < N; j++) {
    const a = (j * N + N - 1) * 3, b = (j * N) * 3;
    maxErr = Math.max(maxErr, Math.hypot(posA[a] - posB[b], posA[a + 1] - posB[b + 1], posA[a + 2] - posB[b + 2]));
  }
  assert.ok(maxErr < 0.05, `edge mismatch ${maxErr}`);
  // normals point away from the planet centre
  for (let v = 0; v < N * N; v++) {
    const o = v * 3;
    const r = Math.hypot(posA[o], posA[o + 1], posA[o + 2]);
    assert.ok((nrmA[o] * posA[o] + nrmA[o + 1] * posA[o + 1] + nrmA[o + 2] * posA[o + 2]) / r > 0.3);
  }
  // bounding radius contains every vertex
  for (let v = 0; v < ps.pos.length / 3; v++) {
    assert.ok(Math.hypot(ps.pos[v * 3], ps.pos[v * 3 + 1], ps.pos[v * 3 + 2]) <= cb.radius + 1e-3);
  }
});

test('terrain selection respects every budget from the ground to deep space', () => {
  const { ps } = makeSurface();
  const vel = new Vector3(), look = new Vector3(0, 0, -1);
  for (const alt of [2, 80, 2600, 12000, 40000, 150000, 1500000, 20000000]) {
    const cam = new Vector3(300, alt, -200);
    // same haze-limited view distance the WorldManager uses
    ps.prime(cam, vel, look, 2.6 / Math.max(1e-300, WORLD.fogDensity * Math.exp(-alt / PLANET.groundHazeHeight)) + 1500);
    const s = ps.stats;
    assert.ok(s.loaded <= WORLD_BUDGET.maxSurfaceChunks, `alt ${alt} loaded ${s.loaded}`);
    assert.ok(s.leaves <= WORLD_BUDGET.maxLeafChunks, `alt ${alt} leaves ${s.leaves}`);
    assert.ok(s.high <= WORLD_BUDGET.maxHighDetailChunks, `alt ${alt} high ${s.high}`);
    assert.ok(s.rendered > 0 && s.rendered <= s.loaded, `alt ${alt} rendered ${s.rendered} loaded ${s.loaded}`);
    if (alt <= 80) assert.ok(s.high > 0, 'full detail at the surface');
    if (alt >= 150000) assert.equal(s.high, 0, 'no surface detail in orbit');
  }
});

test('streaming: surface -> 1500 km -> surface keeps bounded state and restores detail', () => {
  const { fo, sch, ps } = makeSurface();
  const p = new Vector3(0, 60, 0), g = new Vector3(), vel = new Vector3(), look = new Vector3(0, -0.3, -1).normalize();
  fo.onShift(() => fo.applyPoint(p));
  ps.prime(p, vel, look, 8000);
  const nodes0 = ps.nodes.size;
  let maxLoaded = 0, maxNodes = 0, maxLocal = 0;
  const fly = (vy, until) => {
    for (let f = 0; f < 20000; f++) {
      const alt = fo.localToGlobal(p, g).length() - R;
      if (until(alt)) return;
      const speed = sampleCurve(SPEED_CURVE, alt, true) * 60;
      vel.set(0, vy * speed, -0.2 * speed);
      p.addScaledVector(vel, 1 / 90);
      fo.update(p, g);
      ps.update(p, vel, look, 8000 / Math.exp(-Math.max(0, alt) / 800));
      sch.run(1e9);
      maxLoaded = Math.max(maxLoaded, ps.stats.loaded);
      maxNodes = Math.max(maxNodes, ps.nodes.size);
      maxLocal = Math.max(maxLocal, p.length());
    }
    assert.fail('flight did not finish');
  };
  fly(1, (alt) => alt > 1500000);
  assert.equal(ps.stats.high, 0);
  fly(-1, (alt) => alt < 100);
  for (let i = 0; i < 30; i++) { ps.update(p, vel.set(0, 0, 0), look, 8000); sch.run(1e9); }
  assert.ok(maxLoaded <= WORLD_BUDGET.maxSurfaceChunks);
  assert.ok(maxNodes < 4000, `node cache ${maxNodes}`);
  assert.ok(maxLocal < ORIGIN.anchorRadius + ORIGIN.anchorAltitude + ORIGIN.shiftDistance, `local ${maxLocal}`);
  assert.ok(ps.stats.high > 0, 'surface detail streamed back in');
  assert.equal(ps.slots.length, WORLD_BUDGET.maxSurfaceChunks, 'pool never grows');
  assert.ok(nodes0 > 0);
});

test('generation scheduler: honours the time budget, always makes progress, sorts by priority', () => {
  let t = 0;
  const sch = new GenerationScheduler(1.0, () => t);
  const order = [];
  for (let i = 0; i < 10; i++) sch.request({ priority: 10 - i, run: () => { t += 0.4; order.push(10 - i); } });
  assert.equal(sch.run(), 3); // 0.4 + 0.4 + 0.4 >= 1.0 after the third
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(sch.pending, 7);
  sch.request({ priority: 0, run: () => { t += 50; } });
  assert.equal(sch.run(), 1, 'a single over-budget job still runs');
});

test('flight regimes: continuous speed curve, hysteresis on labels, gravity fades in space', () => {
  let prev = sampleCurve(SPEED_CURVE, 0, true);
  for (let a = 0; a < 6e6; a += Math.max(2, a * 0.002)) {
    const s = sampleCurve(SPEED_CURVE, a, true);
    assert.ok(s >= prev - 1e-9, `monotone at ${a}`);
    assert.ok(s / prev < 1.02, `no jumps at ${a}`);
    prev = s;
  }
  const r = new FlightRegime();
  r.update(100, 1 / 90);
  assert.equal(r.regime, REGIME.SURFACE);
  r.update(4050, 1 / 90);
  assert.equal(r.regime, REGIME.SURFACE, 'inside the hysteresis band');
  r.update(4300, 1 / 90);
  assert.equal(r.regime, REGIME.LOW_ATMOSPHERE);
  r.update(3950, 1 / 90);
  assert.equal(r.regime, REGIME.LOW_ATMOSPHERE);
  r.update(2e6, 1 / 90);
  assert.equal(r.regime, REGIME.SPACE);
  assert.equal(r.gravityScale, 0);
  // speed scale follows smoothly, never instantly
  const before = r.speedScale;
  assert.ok(before < r.targetSpeedScale);
});

test('physics: implicit drag never reverses velocity; speed scale raises top speed', () => {
  const w = new CollisionWorld({ minX: -200, minZ: -200, size: 400, cell: 32, coastZ: -1e9 });
  w.build();
  const body = new PlayerBody(w);
  body.reset(0, 50000, 0);
  body.vel.set(0, 0, -20000); // orbital-ish speed into thick air
  body.speedScale = 1;
  const input = { grip: 0, boost: false, look: new Vector3(0, 0, -1), stickX: 0, stickY: 0, right: new Vector3(1, 0, 0), fwd: new Vector3(0, 0, -1), handMode: false, handThrust: new Vector3() };
  body.step(1 / 90, input);
  assert.ok(body.vel.z < 0 && body.vel.z > -20000, `v ${body.vel.z}`);
  const top = (scale) => {
    body.reset(0, 50000, 0);
    body.speedScale = scale; body.gravityScale = 0;
    const inp = { ...input, handMode: true, handThrust: new Vector3(0, 0, -36) };
    for (let i = 0; i < 90 * 40; i++) body.step(1 / 90, inp);
    return -body.vel.z;
  };
  const t1 = top(1), t20 = top(20);
  assert.ok(t1 > 40 && t1 < 90, `top ${t1}`);
  assert.ok(t20 > t1 * 12, `scaled top ${t20}`);
});

test('collision: terrain callback + boxes disabled outside the city anchor', () => {
  const w = new CollisionWorld({ minX: -200, minZ: -200, size: 400, cell: 32, coastZ: -1e9 });
  w.addBox(10, 0, -10, 30, 50, 10);
  w.build();
  w.groundFn = (x) => 5 + x * 0.1;
  assert.equal(w.groundHeight(10, 0), 6);
  assert.ok(w.pointInside(20, 20, 0) >= 0);
  w.boxesEnabled = false;
  assert.equal(w.pointInside(20, 20, 0), -1);
  assert.equal(w.query(0, -20, 40, 20), 0);
  const t = w.raycast(0, 100, 0, 0, -1, 0, 500);
  assert.ok(Math.abs(t - 95) < 1e-6);
});
