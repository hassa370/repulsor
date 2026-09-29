import { Matrix4, Vector3 } from 'three';
import { ENEMY, FLIGHT } from '../config.js';
import { WATER_LEVEL } from '../physics/collision.js';
import { buildPose, Pose, rootMatrix, P_BAT } from './pose.js';

// Log Goon pool: physics at the fixed rate, AI "think" at 20 Hz (4 Hz when
// far) with staggered timers, procedural animation + LOD at render rate.

export const ST = {
  IDLE: 0, TAUNT: 1, LEAP: 2, WINDUP: 3, RECOVER: 4, RETRIEVE: 5, CLIMB: 6, RUN: 7, LUNGE: 8, SLAM_UP: 9, DROP: 10,
};
const AIRBORNE = [false, false, true, false, false, false, false, false, true, true, true];

const G = 9.8;
const RADIUS = 0.35;
const HEIGHT = 2.05;
const HEAD_Y = 1.45; // above this (x scale) a hit is a headshot

const _v = new Vector3();
const _root = new Matrix4();
const _m = new Matrix4();
const _pp = new Vector3();

class Enemy {
  constructor(index) {
    this.index = index;
    this.active = false;
    this.boss = false;
    this.scale = 1;
    this.hp = 0;
    this.pos = new Vector3();
    this.prevPos = new Vector3();
    this.vel = new Vector3();
    this.walk = new Vector3();
    this.target = new Vector3();
    this.wallN = new Vector3();
    this.yaw = 0;
    this.faceYaw = 0;
    this.state = ST.IDLE;
    this.stateTime = 0;
    this.nextThink = 0;
    this.grounded = false;
    this.roofBox = -1;
    this.climber = false;
    this.climbTop = 0;
    this.hasBat = true;
    this.released = false;
    this.swung = false;
    this.spotted = false;
    this.leapCd = 0;
    this.throwCd = 0;
    this.slamCd = 0;
    this.tauntCd = 0;
    this.flinch = 0;
    this.flash = 0;
    this.phase = Math.random() * 6;
    this.distance = 0;
    this.unibeamAcc = 0;
    this.climbBox = -1;
    this.pose = new Pose();
    this.mats = [];
    for (let i = 0; i < 7; i++) this.mats.push(new Matrix4());
  }
}

export class Enemies {
  constructor(game) {
    this.game = game;
    this.list = [];
    for (let i = 0; i < ENEMY.maxActive; i++) this.list.push(new Enemy(i));
    this.activeCount = 0;
    this.visibleCount = 0;
  }

  // ---------------------------------------------------------------- spawning
  spawn(roof, boss, climber) {
    let e = null;
    for (let i = 0; i < this.list.length; i++) if (!this.list[i].active) { e = this.list[i]; break; }
    if (!e) return null;
    const g = this.game;
    e.active = true;
    e.boss = boss;
    e.scale = boss ? ENEMY.bossScale : ENEMY.goonScale * (0.95 + Math.random() * 0.15);
    e.hp = boss ? ENEMY.bossHp : ENEMY.hp;
    e.hasBat = true;
    e.spotted = false;
    e.flinch = 0; e.flash = 0;
    e.leapCd = 1 + Math.random() * 2;
    e.throwCd = 1.5 + Math.random() * 2;
    e.slamCd = 3;
    e.tauntCd = 2 + Math.random() * 4;
    e.climber = climber;
    e.unibeamAcc = 0;
    e.vel.set(0, 0, 0);
    e.walk.set(0, 0, 0);
    e.nextThink = g.time + Math.random() / ENEMY.thinkHz;
    e.pose.reset();
    const b = g.collision.boxes, o = roof.box * 6;
    if (climber && b[o + 1] < 0.5) {
      // Start at the foot of a wall and climb it.
      const side = Math.floor(Math.random() * 4);
      const t = 0.2 + Math.random() * 0.6;
      const x0 = b[o], z0 = b[o + 2], x1 = b[o + 3], z1 = b[o + 5];
      const off = RADIUS * e.scale + 0.05;
      if (side === 0) { e.pos.set(x0 - off, 0, z0 + (z1 - z0) * t); e.wallN.set(-1, 0, 0); }
      else if (side === 1) { e.pos.set(x1 + off, 0, z0 + (z1 - z0) * t); e.wallN.set(1, 0, 0); }
      else if (side === 2) { e.pos.set(x0 + (x1 - x0) * t, 0, z0 - off); e.wallN.set(0, 0, -1); }
      else { e.pos.set(x0 + (x1 - x0) * t, 0, z1 + off); e.wallN.set(0, 0, 1); }
      e.climbTop = b[o + 4];
      this.setState(e, ST.CLIMB);
      e.yaw = e.faceYaw = Math.atan2(-e.wallN.x, -e.wallN.z);
    } else {
      e.pos.set(
        roof.x + (Math.random() - 0.5) * Math.max(0, roof.hx - 2),
        roof.y + 25 + Math.random() * 15,
        roof.z + (Math.random() - 0.5) * Math.max(0, roof.hz - 2),
      );
      this.setState(e, ST.DROP);
      e.yaw = e.faceYaw = Math.random() * 6.28;
    }
    e.prevPos.copy(e.pos);
    e.grounded = false;
    this.activeCount++;
    return e;
  }

  setState(e, s) {
    e.state = s;
    e.stateTime = 0;
    e.released = false;
    e.swung = false;
  }

  clear() {
    for (let i = 0; i < this.list.length; i++) this.list[i].active = false;
    this.activeCount = 0;
  }

  // ------------------------------------------------------------------ damage
  // Returns true if the enemy died.
  damage(e, amount, dx, dy, dz, headshot) {
    if (!e.active) return false;
    e.hp -= amount;
    e.flash = 1;
    e.flinch = 0.35;
    e.spotted = true;
    const g = this.game;
    if (e.hp <= 0) {
      this.kill(e, dx, dy, dz, amount);
      g.addScore(e.boss ? 2000 : 100 + (headshot ? 50 : 0), headshot);
      return true;
    }
    if (e.boss) { e.vel.x += dx * 1.5; e.vel.z += dz * 1.5; }
    else { e.vel.x += dx * 3; e.vel.y += 1.5; e.vel.z += dz * 3; e.grounded = false; }
    g.audio.play('thunk', e.pos.x, e.pos.y + 1.5, e.pos.z, 0.9);
    return false;
  }

  kill(e, dx, dy, dz, power) {
    const g = this.game;
    this.computePose(e, e.pos);
    const k = 5 + power * 3;
    for (let p = 0; p < 7; p++) {
      if (p === P_BAT && !e.hasBat) continue;
      g.debris.spawn(p, e.mats[p],
        e.vel.x + dx * k + (Math.random() - 0.5) * 4,
        e.vel.y + Math.max(0, dy) * k + 2 + Math.random() * 4,
        e.vel.z + dz * k + (Math.random() - 0.5) * 4,
        10, e.boss ? 1 : 0);
    }
    const s = e.scale;
    g.particles.woodBurst(e.pos.x, e.pos.y + 1.4 * s, e.pos.z, dx, dy, dz, e.boss ? 60 : 24, 8 * Math.sqrt(s), e.pos.y);
    if (e.boss) g.particles.sparkBurst(e.pos.x, e.pos.y + 3, e.pos.z, 60, 14, 1.0, 0.5, 0.15, 1.4);
    g.audio.play('crack', e.pos.x, e.pos.y + 1.5, e.pos.z, 1);
    e.active = false;
    this.activeCount--;
  }

  // Segment (a->b) vs enemy capsules. Returns the enemy hit (closest along the
  // segment); sets this.lastHeadshot / this.lastHitY for that hit.
  segmentHit(ax, ay, az, bx, by, bz, radius) {
    let best = null, bestT = 2;
    const sx = bx - ax, sy = by - ay, sz = bz - az;
    const lxz = sx * sx + sz * sz;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (!e.active) continue;
      const er = RADIUS * e.scale * ENEMY.hitRadiusScale;
      const r = er + radius;
      const ex = e.pos.x, ez = e.pos.z;
      if (ex < Math.min(ax, bx) - r || ex > Math.max(ax, bx) + r || ez < Math.min(az, bz) - r || ez > Math.max(az, bz) + r) continue;
      const ey0 = e.pos.y + er, ey1 = e.pos.y + HEIGHT * e.scale - er;
      if (Math.max(ay, by) < ey0 - r || Math.min(ay, by) > ey1 + r) continue;
      // Candidates: closest approach in XZ plus the ends / middle (steps are
      // short relative to r, so this never tunnels).
      let tx = lxz > 1e-8 ? ((ex - ax) * sx + (ez - az) * sz) / lxz : 0;
      tx = Math.min(Math.max(tx, 0), 1);
      for (let k = 0; k < 4; k++) {
        const t = k === 0 ? tx : (k - 1) * 0.5;
        const px = ax + sx * t, py = ay + sy * t, pz = az + sz * t;
        const cy = py < ey0 ? ey0 : py > ey1 ? ey1 : py;
        const dx = px - ex, dy = py - cy, dz = pz - ez;
        if (dx * dx + dy * dy + dz * dz < r * r && t < bestT) {
          best = e; bestT = t;
          this.lastHeadshot = py > e.pos.y + HEAD_Y * e.scale;
          this.lastHitY = py;
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------- simulation
  fixed(dt) {
    const g = this.game;
    const c = g.collision;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (!e.active) continue;
      e.prevPos.copy(e.pos);
      e.stateTime += dt;
      e.leapCd -= dt; e.throwCd -= dt; e.slamCd -= dt; e.tauntCd -= dt;
      if (e.flinch > 0) e.flinch -= dt;
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 6);

      if (g.time >= e.nextThink) {
        e.nextThink += e.distance > ENEMY.farDistance ? 1 / ENEMY.farThinkHz : 1 / ENEMY.thinkHz;
        if (e.nextThink < g.time) e.nextThink = g.time + 0.01;
        this.think(e);
      }

      if (e.state === ST.CLIMB) {
        e.pos.y += (e.boss ? 7 : 3.6) * dt;
        e.vel.set(0, 0, 0);
        if (e.pos.y >= e.climbTop - 0.2) {
          // Hop over the parapet onto the roof.
          e.vel.set(-e.wallN.x * 3.5, 5.5, -e.wallN.z * 3.5);
          this.setState(e, ST.LEAP);
          e.grounded = false;
        }
        continue;
      }

      const air = AIRBORNE[e.state] || !e.grounded;
      e.vel.y -= G * dt;
      if (!air) {
        // Walking on a roof / street: stay on the roof.
        e.vel.x = e.walk.x;
        e.vel.z = e.walk.z;
        if (e.roofBox >= 0 && (e.walk.x !== 0 || e.walk.z !== 0)) {
          const b = c.boxes, o = e.roofBox * 6, m = RADIUS * e.scale + 0.5;
          const nx = e.pos.x + e.vel.x * dt, nz = e.pos.z + e.vel.z * dt;
          if (nx < b[o] + m || nx > b[o + 3] - m) { e.vel.x = 0; e.walk.x = 0; }
          if (nz < b[o + 2] + m || nz > b[o + 5] - m) { e.vel.z = 0; e.walk.z = 0; }
        }
      } else {
        // light air drag
        e.vel.x *= 1 - 0.05 * dt;
        e.vel.z *= 1 - 0.05 * dt;
      }
      e.pos.addScaledVector(e.vel, dt);
      c.collideCapsule(e.pos, e.vel, RADIUS * e.scale, HEIGHT * e.scale, 0.1, 0.35);
      e.grounded = c.grounded;
      if (e.grounded) e.roofBox = c.groundBox;
      if (e.grounded && AIRBORNE[e.state] && e.stateTime > 0.15) this.land(e);
      if (e.grounded && !AIRBORNE[e.state]) { e.vel.x *= 0.8; e.vel.z *= 0.8; }

      if (e.state === ST.LUNGE && !e.swung) this.checkMelee(e);

      if (e.pos.y < WATER_LEVEL + 0.2 && c.groundHeight(e.pos.x, e.pos.z) < 0) {
        g.particles.sparkBurst(e.pos.x, WATER_LEVEL, e.pos.z, 12, 5, 0.7, 0.8, 0.9, 0.8, 1);
        e.active = false;
        this.activeCount--;
      }
    }
  }

  land(e) {
    const g = this.game;
    if (e.state === ST.SLAM_UP) {
      this.slam(e);
    } else if (e.boss || e.state === ST.DROP) {
      g.particles.sparkBurst(e.pos.x, e.pos.y + 0.1, e.pos.z, e.boss ? 20 : 6, e.boss ? 8 : 3, 0.55, 0.5, 0.45, 0.7, 0.5);
    }
    g.audio.play('land', e.pos.x, e.pos.y, e.pos.z, e.boss ? 1 : 0.4);
    this.setState(e, e.state === ST.DROP ? ST.TAUNT : ST.IDLE);
    e.walk.set(0, 0, 0);
  }

  slam(e) {
    const g = this.game;
    const body = g.body;
    g.shockwave(e.pos.x, e.pos.y + 0.2, e.pos.z, ENEMY.bossSlamRadius);
    const dx = body.pos.x - e.pos.x, dz = body.pos.z - e.pos.z, dy = body.pos.y - e.pos.y;
    const d = Math.hypot(dx, dz);
    if (d < ENEMY.bossSlamRadius && dy > -3 && dy < 14) {
      const f = 1 - d / ENEMY.bossSlamRadius;
      const nx = d > 0.01 ? dx / d : 1, nz = d > 0.01 ? dz / d : 0;
      g.damagePlayer(ENEMY.bossSlamDamage * (0.4 + 0.6 * f), nx, 0.5, nz, ENEMY.bossSlamKnock * (0.5 + 0.5 * f));
    }
    e.slamCd = 6 + Math.random() * 3;
  }

  checkMelee(e) {
    const g = this.game;
    const b = g.body;
    const reach = 1.6 * e.scale;
    const cy = Math.min(Math.max(e.pos.y + 1.2 * e.scale, b.pos.y), b.pos.y + FLIGHT.capsuleHeight);
    const dx = b.pos.x - e.pos.x, dy = cy - (e.pos.y + 1.2 * e.scale), dz = b.pos.z - e.pos.z;
    if (dx * dx + dy * dy + dz * dz < reach * reach) {
      e.swung = true;
      const d = Math.hypot(dx, dz) || 1;
      g.damagePlayer(ENEMY.meleeDamage, dx / d, 0.3, dz / d, 9);
      g.audio.play('thunk', b.pos.x, b.pos.y + 1.2, b.pos.z, 1);
    }
  }

  // ------------------------------------------------------------------ brain
  think(e) {
    const g = this.game;
    const head = g.headWorld;
    const dx = head.x - e.pos.x, dy = head.y - e.pos.y, dz = head.z - e.pos.z;
    const hd = Math.hypot(dx, dz);
    const dist = Math.hypot(hd, dy);
    e.distance = dist;
    e.faceYaw = Math.atan2(dx, dz);
    const s = e.state;
    const t = e.stateTime;
    if (s === ST.TAUNT) {
      if (t > 1.0) this.setState(e, ST.IDLE);
      return;
    }
    if (s === ST.WINDUP) {
      if (!e.released && t > 0.55) this.throwBat(e, dist);
      if (t > 0.85) this.setState(e, ST.RECOVER);
      return;
    }
    if (s === ST.RECOVER) {
      if (t > 0.5) this.setState(e, ST.IDLE);
      return;
    }
    if (s === ST.RETRIEVE) {
      e.walk.set(0, 0, 0);
      if (t > 1.5) { e.hasBat = true; this.setState(e, ST.IDLE); }
      return;
    }
    if (s === ST.RUN) {
      // run to the wall, then climb
      const tx = e.target.x - e.pos.x, tz = e.target.z - e.pos.z;
      const d = Math.hypot(tx, tz);
      if (d < 0.8 || t > 8) {
        this.startClimb(e);
      } else {
        const sp = e.boss ? 9 : 5.5;
        e.walk.set(tx / d * sp, 0, tz / d * sp);
        e.faceYaw = Math.atan2(tx, tz);
      }
      return;
    }
    if (AIRBORNE[s] || s === ST.CLIMB) return;

    // IDLE decisions
    if (!e.spotted) {
      if (dist < ENEMY.spotRange) {
        e.spotted = true;
        this.setState(e, ST.TAUNT);
        g.audio.play('taunt', e.pos.x, e.pos.y + 1.7, e.pos.z, e.boss ? 1 : 0.7, e.boss ? 0.6 : 1);
      }
      return;
    }
    // On the street: find a wall and climb or jump onto a roof.
    if (e.grounded && e.roofBox < 0) {
      if (!this.tryLeap(e, head, dist, true)) this.goClimb(e);
      return;
    }
    if (e.boss && e.slamCd <= 0 && hd < ENEMY.bossSlamRadius * 0.7 && dy > -4 && dy < 14) {
      this.setState(e, ST.SLAM_UP);
      e.vel.set(0, 15, 0);
      e.grounded = false;
      g.audio.play('taunt', e.pos.x, e.pos.y + 5, e.pos.z, 1, 0.5);
      return;
    }
    if (e.hasBat && dist < ENEMY.meleeRange * (e.boss ? 1.8 : 1) && Math.abs(dy) < 5 * e.scale) {
      // jump at the player and swing
      const T = 0.45;
      e.vel.set(dx / T, (dy - 1) / T + 0.5 * G * T, dz / T);
      this.setState(e, ST.LUNGE);
      e.grounded = false;
      return;
    }
    if (e.hasBat && dist < ENEMY.throwRange * (e.boss ? 1.3 : 1) && e.throwCd <= 0) {
      e.walk.set(0, 0, 0);
      this.setState(e, ST.WINDUP);
      g.audio.play('whoosh', e.pos.x, e.pos.y + 1.5, e.pos.z, 0.5);
      return;
    }
    if (!e.hasBat) {
      e.walk.set(0, 0, 0);
      this.setState(e, ST.RETRIEVE);
      return;
    }
    if (e.leapCd <= 0 && dist > 30) {
      if (this.tryLeap(e, head, dist, false)) return;
      e.leapCd = 1.5;
    }
    if (e.tauntCd <= 0) {
      e.tauntCd = 5 + Math.random() * 6;
      e.walk.set(0, 0, 0);
      this.setState(e, ST.TAUNT);
      g.audio.play('taunt', e.pos.x, e.pos.y + 1.7, e.pos.z, e.boss ? 1 : 0.6, e.boss ? 0.6 : 0.9 + Math.random() * 0.3);
      return;
    }
    // Pace toward the player-side edge of the roof.
    if (Math.random() < 0.1) {
      const sp = 1.2;
      e.walk.set(dx / (hd || 1) * sp, 0, dz / (hd || 1) * sp);
    }
  }

  throwBat(e, dist) {
    const g = this.game;
    e.released = true;
    e.hasBat = false;
    e.throwCd = 3 + Math.random() * 3;
    const s = e.scale;
    // hand position (right hand, above head at release)
    const cy = Math.cos(e.yaw), sy = Math.sin(e.yaw);
    const hx = e.pos.x + cy * 0.3 * s + sy * 0.2 * s;
    const hy = e.pos.y + 2.1 * s;
    const hz = e.pos.z - sy * 0.3 * s + cy * 0.2 * s;
    const b = g.body;
    const speed = ENEMY.batSpeed * (e.boss ? 1.25 : 1);
    const T = Math.max(0.4, dist / speed);
    const ax = g.headWorld.x + b.vel.x * T * 0.8;
    const ay = g.headWorld.y - 0.4 + b.vel.y * T * 0.5;
    const az = g.headWorld.z + b.vel.z * T * 0.8;
    g.bats.spawn(hx, hy, hz, (ax - hx) / T, (ay - hy) / T + 0.5 * 9.8 * 0.45 * T, (az - hz) / T, e.boss, s);
    g.audio.play('whoosh', hx, hy, hz, 0.8);
  }

  // Ballistic leap to a roof that brings the goon closer to the player.
  tryLeap(e, head, dist, fromStreet) {
    const g = this.game;
    const c = g.collision;
    const b = c.boxes;
    const dx = head.x - e.pos.x, dz = head.z - e.pos.z;
    const hd = Math.hypot(dx, dz) || 1;
    const reach = ENEMY.leapMaxHoriz * (e.boss ? 1.3 : 1);
    const probe = fromStreet ? 0 : Math.min(hd * 0.5, reach * 0.6);
    const cx = e.pos.x + dx / hd * probe, cz = e.pos.z + dz / hd * probe;
    const n = c.query(cx - reach * 0.6, cz - reach * 0.6, cx + reach * 0.6, cz + reach * 0.6);
    let best = -1, bestScore = fromStreet ? 1e9 : dist - 8;
    const maxUp = ENEMY.leapMaxUp * (e.boss ? 1.5 : 1);
    for (let k = 0; k < n; k++) {
      const i = c.result[k];
      if (i === e.roofBox) continue;
      const o = i * 6;
      const top = b[o + 4];
      const hx = (b[o + 3] - b[o]) * 0.5, hz = (b[o + 5] - b[o + 2]) * 0.5;
      if (hx < 3 * e.scale || hz < 3 * e.scale) continue;
      if (top > e.pos.y + maxUp || top < e.pos.y - 80) continue;
      const bx = b[o] + hx, bz = b[o + 2] + hz;
      const ld = Math.hypot(bx - e.pos.x, bz - e.pos.z);
      if (ld > reach || ld < 6) continue;
      if (c.pointInside(bx, top + 1, bz) !== -1) continue; // covered by an upper tier
      const nd = Math.hypot(head.x - bx, head.y - top, head.z - bz);
      const score = nd + Math.random() * 12;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return false;
    const o = best * 6;
    const hx = (b[o + 3] - b[o]) * 0.5, hz = (b[o + 5] - b[o + 2]) * 0.5;
    const tx = b[o] + hx + (Math.random() - 0.5) * (hx - 2);
    const tz = b[o + 2] + hz + (Math.random() - 0.5) * (hz - 2);
    const ty = b[o + 4];
    const ldx = tx - e.pos.x, ldz = tz - e.pos.z, ldy = ty - e.pos.y;
    const ld = Math.hypot(ldx, ldz);
    const T = Math.min(Math.max(ld / 17, 1.0), 2.8) + Math.max(0, ldy) * 0.012;
    e.vel.set(ldx / T, ldy / T + 0.5 * G * T, ldz / T);
    e.faceYaw = Math.atan2(ldx, ldz);
    e.yaw = e.faceYaw;
    this.setState(e, ST.LEAP);
    e.grounded = false;
    e.leapCd = 2.5 + Math.random() * 2.5;
    g.audio.play('whoosh', e.pos.x, e.pos.y + 1, e.pos.z, 0.35);
    return true;
  }

  goClimb(e) {
    // nearest ground-level box face
    const c = this.game.collision;
    const b = c.boxes;
    const n = c.query(e.pos.x - 40, e.pos.z - 40, e.pos.x + 40, e.pos.z + 40);
    let best = -1, bestD = 1e9;
    for (let k = 0; k < n; k++) {
      const i = c.result[k], o = i * 6;
      if (b[o + 1] > 0.5 || b[o + 4] < 6) continue;
      const qx = Math.min(Math.max(e.pos.x, b[o]), b[o + 3]);
      const qz = Math.min(Math.max(e.pos.z, b[o + 2]), b[o + 5]);
      const d = Math.hypot(qx - e.pos.x, qz - e.pos.z);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return;
    const o = best * 6;
    const qx = Math.min(Math.max(e.pos.x, b[o]), b[o + 3]);
    const qz = Math.min(Math.max(e.pos.z, b[o + 2]), b[o + 5]);
    e.target.set(qx, 0, qz);
    e.climbBox = best;
    this.setState(e, ST.RUN);
  }

  startClimb(e) {
    const b = this.game.collision.boxes;
    const i = e.climbBox;
    if (i < 0) { this.setState(e, ST.IDLE); return; }
    const o = i * 6;
    // wall normal = direction from the box to the goon
    const cx = (b[o] + b[o + 3]) * 0.5, cz = (b[o + 2] + b[o + 5]) * 0.5;
    const ex = (e.pos.x - cx) / Math.max(1, b[o + 3] - b[o]), ez = (e.pos.z - cz) / Math.max(1, b[o + 5] - b[o + 2]);
    if (Math.abs(ex) > Math.abs(ez)) e.wallN.set(Math.sign(ex), 0, 0); else e.wallN.set(0, 0, Math.sign(ez));
    e.climbTop = b[o + 4];
    e.walk.set(0, 0, 0);
    e.vel.set(0, 0, 0);
    e.faceYaw = Math.atan2(-e.wallN.x, -e.wallN.z);
    this.setState(e, ST.CLIMB);
  }

  // --------------------------------------------------------------- animation
  animate(e, dt, time) {
    const p = e.pose;
    p.reset();
    const hs = Math.hypot(e.vel.x, e.vel.z);
    const s = e.state;
    const t = e.stateTime;
    // turn toward the facing target
    let dy = e.faceYaw - e.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    e.yaw += dy * Math.min(1, dt * (s === ST.WINDUP ? 12 : 6));
    const air = AIRBORNE[s] || !e.grounded;
    if (s === ST.CLIMB) {
      e.phase += dt * 9;
      const sn = Math.sin(e.phase);
      p.armLx = -2.7 + sn * 0.5; p.armRx = -2.7 - sn * 0.5;
      p.legL = -0.6 - sn * 0.4; p.legR = -0.6 + sn * 0.4;
      p.bodyPitch = -0.15;
    } else if (air) {
      p.legL = -0.9; p.legR = -0.3;
      p.armLx = -2.2; p.armRx = s === ST.LUNGE ? -3.3 + Math.min(1, Math.max(0, (t - 0.15) / 0.25)) * 2.8 : -2.4;
      p.armLz = 0.5; p.armRz = -0.5;
      p.bodyPitch = s === ST.LUNGE ? 0.35 : 0.1;
      if (s === ST.SLAM_UP) { p.armLx = -3.0; p.armRx = -3.0; p.legL = -0.7; p.legR = -0.7; }
    } else {
      const run = Math.min(1, hs / 5);
      const walk = Math.min(1, hs / 1.2);
      e.phase += dt * (3 + hs * 2.2);
      const sn = Math.sin(e.phase);
      const amp = 0.45 + run * 0.5;
      p.legL = sn * amp * walk; p.legR = -sn * amp * walk;
      p.armLx = -sn * amp * 0.8 * walk; p.armRx = sn * amp * 0.8 * walk;
      p.bodyPitch = run * 0.3;
      p.bob = Math.abs(Math.cos(e.phase)) * 0.05 * walk + Math.sin(time * 2 + e.index) * 0.008;
      if (s === ST.WINDUP) {
        const k = Math.min(1, t / 0.55);
        p.armRx = t < 0.55 ? -3.6 * k : -3.6 + Math.min(1, (t - 0.55) / 0.12) * 2.6;
        p.armRz = -0.3;
        p.bodyYaw = t < 0.55 ? -0.5 * k : -0.5 + Math.min(1, (t - 0.55) / 0.12) * 0.9;
        p.bodyPitch = t < 0.55 ? -0.1 : 0.25;
        p.legL = -0.3; p.legR = 0.25;
      } else if (s === ST.RETRIEVE) {
        const k = Math.sin(Math.min(1, t / 1.5) * Math.PI);
        p.crouch = 0.25 * k;
        p.bodyPitch = 0.7 * k;
        p.armRx = -0.9 * k; p.armLx = -0.5 * k;
        p.legL = -0.5 * k; p.legR = -0.5 * k;
      } else if (s === ST.TAUNT) {
        p.headRoll = Math.sin(t * 18) * 0.28;
        p.armLz = 1.3 + Math.sin(t * 9) * 0.2; p.armRz = -1.3 - Math.sin(t * 9) * 0.2;
        p.armLx = -0.3; p.armRx = -0.3;
        p.bob = Math.abs(Math.sin(t * 9)) * 0.12;
      } else if (s === ST.RECOVER) {
        p.armRx = -1.0 + Math.min(1, t / 0.5);
      }
    }
    if (e.flinch > 0) {
      const k = e.flinch / 0.35;
      p.bodyPitch -= 0.45 * k;
      p.headPitch -= 0.4 * k;
      p.armLz += 0.6 * k; p.armRz -= 0.6 * k;
    }
    // Idle bat rests on the shoulder / points forward
    if (!air && s === ST.IDLE && hs < 0.3) { p.armRx = -0.5; p.batAngle = 2.4; }
  }

  computePose(e, pos) {
    rootMatrix(_root, pos.x, pos.y, pos.z, e.yaw, e.scale);
    buildPose(e.mats, _root, e.pose);
  }

  // ------------------------------------------------------------------ render
  render(renderer, dt, alpha) {
    const g = this.game;
    const head = g.headWorld;
    const look = g.look;
    let vis = 0;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (!e.active) continue;
      _pp.lerpVectors(e.prevPos, e.pos, alpha);
      _v.set(_pp.x - head.x, _pp.y + e.scale - head.y, _pp.z - head.z);
      const d = _v.length();
      e.distance = d;
      if (d > ENEMY.cullDistance) continue;
      // Cheap view-cone cull (VR FOV ~ 100 deg); keep anything close.
      if (d > 6 * e.scale && _v.dot(look) < 0.2 * d) continue;
      vis++;
      const glow = e.boss ? 1 : 0;
      const flash = e.flash;
      const lodK = e.boss ? 2.5 : 1;
      if (d < ENEMY.lodSilhouette * lodK) {
        this.animate(e, dt, g.time);
        this.computePose(e, _pp);
        for (let p = 0; p < 7; p++) {
          if (p === P_BAT && !e.hasBat) continue;
          renderer.push(p, e.mats[p], glow, flash, 0);
        }
      } else if (d < ENEMY.lodSprite * lodK) {
        e.phase += dt * 3;
        let dy = e.faceYaw - e.yaw;
        e.yaw += Math.atan2(Math.sin(dy), Math.cos(dy)) * Math.min(1, dt * 6);
        rootMatrix(_m, _pp.x, _pp.y, _pp.z, e.yaw, e.scale);
        renderer.push(renderer.SIL, _m, glow, flash, 0);
      } else {
        renderer.pushSprite(_pp.x, _pp.y, _pp.z, 2.1 * e.scale, flash);
      }
    }
    this.visibleCount = vis;
  }
}
