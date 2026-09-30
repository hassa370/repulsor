import { Matrix4, Quaternion, Vector3 } from 'three';
import { ENEMY, FLIGHT } from '../config.js';
import { P_BAT } from './pose.js';

// Thrown bats: spinning ballistic projectiles. The player can shoot them down.
const BAT_GRAVITY = 9.8 * 0.45;
const _q = new Quaternion();
const _m = new Matrix4();
const _m2 = new Matrix4();
const _v = new Vector3();
const _s = new Vector3();

class Bat {
  constructor() {
    this.active = false;
    this.asleep = false;
    this.pos = new Vector3();
    this.prevPos = new Vector3();
    this.vel = new Vector3();
    this.axis = new Vector3(1, 0, 0);
    this.angle = 0;
    this.spin = 14;
    this.fire = false;
    this.scale = 1;
    this.life = 0;
  }
}

export class Bats {
  constructor(game, capacity = 48) {
    this.game = game;
    this.list = [];
    for (let i = 0; i < capacity; i++) this.list.push(new Bat());
    this.radius = 0.55;
  }

  spawn(x, y, z, vx, vy, vz, fire, scale) {
    for (let i = 0; i < this.list.length; i++) {
      const b = this.list[i];
      if (b.active || b.asleep) continue;
      b.active = true;
      b.pos.set(x, y, z);
      b.prevPos.copy(b.pos);
      b.vel.set(vx, vy, vz);
      // spin about the horizontal axis perpendicular to travel
      b.axis.set(vz, 0, -vx);
      if (b.axis.lengthSq() < 1e-6) b.axis.set(1, 0, 0);
      b.axis.normalize();
      b.angle = Math.random() * 6;
      b.spin = 12 + Math.random() * 6;
      b.fire = fire;
      b.scale = scale;
      b.life = 8;
      return b;
    }
    return null;
  }

  destroy(b, burst) {
    b.active = false;
    if (burst) {
      const g = this.game;
      g.particles.woodBurst(b.pos.x, b.pos.y, b.pos.z, b.vel.x * 0.02, 0.2, b.vel.z * 0.02, 10, 7, -1000);
      if (b.fire) g.particles.sparkBurst(b.pos.x, b.pos.y, b.pos.z, 16, 9, 1.0, 0.45, 0.1, 0.9);
      g.audio.play('crack', b.pos.x, b.pos.y, b.pos.z, 0.7);
    }
  }

  fixed(dt) {
    const g = this.game;
    const c = g.collision;
    const body = g.body;
    const pr = FLIGHT.capsuleRadius;
    for (let i = 0; i < this.list.length; i++) {
      const b = this.list[i];
      if (!b.active) continue;
      b.prevPos.copy(b.pos);
      b.vel.y -= BAT_GRAVITY * dt;
      b.pos.addScaledVector(b.vel, dt);
      b.angle += b.spin * dt;
      b.life -= dt;
      if (b.fire && Math.random() < 0.5) {
        g.particles.ember(b.pos.x, b.pos.y, b.pos.z, (Math.random() - 0.5) * 2, 1 + Math.random(), (Math.random() - 0.5) * 2, 1.0, 0.4 + Math.random() * 0.2, 0.08, 0.7);
      }
      // vs player capsule (vertical segment)
      const py0 = body.pos.y + pr, py1 = body.pos.y + FLIGHT.capsuleHeight - pr;
      const cy = Math.min(Math.max(b.pos.y, py0), py1);
      const dx = b.pos.x - body.pos.x, dy = b.pos.y - cy, dz = b.pos.z - body.pos.z;
      const rr = pr + this.radius * b.scale;
      if (dx * dx + dy * dy + dz * dz < rr * rr) {
        _v.copy(b.vel).normalize();
        g.damagePlayer(ENEMY.batDamage * (b.fire ? 1.5 : 1), _v.x, _v.y, _v.z, 6);
        this.destroy(b, true);
        continue;
      }
      if (b.life <= 0 || c.pointInside(b.pos.x, b.pos.y, b.pos.z) !== -1) {
        this.destroy(b, b.life > 0);
      }
    }
  }

  render(renderer, alpha) {
    for (let i = 0; i < this.list.length; i++) {
      const b = this.list[i];
      if (!b.active) continue;
      _v.lerpVectors(b.prevPos, b.pos, alpha);
      _q.setFromAxisAngle(b.axis, b.angle);
      _s.set(b.scale, b.scale, b.scale);
      _m.compose(_v, _q, _s);
      // spin about the bat's middle (geometry pivot is at the grip)
      _m2.makeTranslation(0, -0.37, 0);
      _m.multiply(_m2);
      renderer.push(P_BAT, _m, b.fire ? 1.2 : 0, 0, 0);
      if (b.fire) this.game.sprites.pushPoint(_v.x, _v.y, _v.z, 0.9 * b.scale, 1.0, 0.4, 0.08, 0.6, 0.2);
    }
  }

  clear() {
    for (let i = 0; i < this.list.length; i++) { this.list[i].active = false; this.list[i].asleep = false; }
  }

  sleep() {
    for (let i = 0; i < this.list.length; i++) { const b = this.list[i]; if (b.active) { b.active = false; b.asleep = true; } }
  }

  wake() {
    for (let i = 0; i < this.list.length; i++) { const b = this.list[i]; if (b.asleep) { b.asleep = false; b.active = true; } }
  }
}
