import { Matrix4, Quaternion, Vector3 } from 'three';
import { ENEMY } from '../config.js';

// Ragdoll-lite: on death a goon splits into its parts, each an independent
// pooled rigid piece (gravity, bounce off roofs/walls, spin), faded out by
// dithering after ENEMY.debrisLife seconds.

const _q = new Quaternion();
const _v = new Vector3();
const _m = new Matrix4();
const _s = new Vector3();
const PART_RADIUS = [0.22, 0.3, 0.12, 0.12, 0.1, 0.1, 0.08];
// Pivot -> centre of mass along local Y, per part.
const PART_CY = [0.37, 0.2, -0.32, -0.32, -0.42, -0.42, 0.37];
const _c = new Vector3();
const _cp = new Vector3();

class Piece {
  constructor() {
    this.active = false;
    this.part = 0;
    this.pos = new Vector3();
    this.prevPos = new Vector3();
    this.vel = new Vector3();
    this.quat = new Quaternion();
    this.ang = new Vector3();
    this.scale = 1;
    this.life = 0;
    this.glow = 0;
  }
}

export class Debris {
  constructor(collision, capacity = 90) {
    this.collision = collision;
    this.pieces = [];
    for (let i = 0; i < capacity; i++) this.pieces.push(new Piece());
    this.next = 0;
    this.activeCount = 0;
  }

  // matrix: world matrix of the part at death.
  spawn(part, matrix, vx, vy, vz, spin, glow) {
    let p = null;
    for (let k = 0; k < this.pieces.length; k++) {
      const c = this.pieces[(this.next + k) % this.pieces.length];
      if (!c.active) { p = c; this.next = (this.next + k + 1) % this.pieces.length; break; }
    }
    if (!p) { p = this.pieces[this.next]; this.next = (this.next + 1) % this.pieces.length; }
    matrix.decompose(p.pos, p.quat, _s);
    p.prevPos.copy(p.pos);
    p.scale = _s.x;
    p.part = part;
    p.vel.set(vx, vy, vz);
    p.ang.set((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin);
    p.life = ENEMY.debrisLife;
    p.glow = glow;
    p.active = true;
  }

  fixed(dt) {
    const c = this.collision;
    let n = 0;
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (!p.active) continue;
      n++;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      p.prevPos.copy(p.pos);
      p.vel.y -= 9.8 * dt;
      p.pos.addScaledVector(p.vel, dt);
      const r = PART_RADIUS[p.part] * p.scale;
      // Collide the part's centre as a sphere (capsule with no height).
      _c.set(0, PART_CY[p.part] * p.scale, 0).applyQuaternion(p.quat);
      _cp.copy(p.pos).add(_c);
      _cp.y -= r;
      if (c.collideCapsule(_cp, p.vel, r, 2 * r, 0.4, 0.2, true)) {
        p.ang.multiplyScalar(0.85);
        if (c.grounded && Math.abs(p.vel.y) < 0.8) { p.vel.x *= 0.96; p.vel.z *= 0.96; p.ang.multiplyScalar(0.9); }
      }
      _cp.y += r;
      p.pos.copy(_cp).sub(_c);
      const w = p.ang.length();
      if (w > 1e-4) {
        _v.copy(p.ang).multiplyScalar(1 / w);
        _q.setFromAxisAngle(_v, w * dt);
        p.quat.premultiply(_q);
      }
    }
    this.activeCount = n;
  }

  render(renderer, alpha) {
    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i];
      if (!p.active) continue;
      _v.lerpVectors(p.prevPos, p.pos, alpha);
      _s.set(p.scale, p.scale, p.scale);
      _m.compose(_v, p.quat, _s);
      const fade = p.life < 1 ? 1 - p.life : 0;
      renderer.push(p.part, _m, p.glow, 0, fade);
    }
  }

  clear() {
    for (let i = 0; i < this.pieces.length; i++) this.pieces[i].active = false;
  }
}
