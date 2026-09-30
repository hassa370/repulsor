import { Matrix4 } from 'three';
import { setFarBuildingHeight } from './city.js';

// Destructible buildings. Each building has hit points; fireballs, charged
// shots, the unibeam and smashing through it wear them down. At zero the
// building collapses: its collision is removed at once (anything on the roof
// falls), its vertices sink into the ground over a few seconds inside its chunk
// mesh (only that building's vertex range is re-uploaded), rooftop props and
// warning lights vanish, and a dust cloud + debris pour out.

const ZERO = new Matrix4().makeScale(0, 0, 0);

export class Destruction {
  constructor(game, city) {
    this.game = game;
    this.city = city;
    this.active = []; // buildings currently collapsing
    this.destroyed = 0;
  }

  buildingOfBox(box) {
    return box >= 0 ? this.city.boxBuilding[box] : -1;
  }

  // Damage the building that owns collision box `box`. Returns true if it
  // started collapsing.
  damageBox(box, amount) {
    const id = this.buildingOfBox(box);
    if (id < 0) return false;
    const b = this.city.buildings[id];
    if (b.state !== 0) return false;
    b.hp -= amount;
    if (b.hp > 0) return false;
    this.collapse(b);
    return true;
  }

  // quiet: restore a saved ruin (no FX / score, finishes on the next frame).
  collapse(b, quiet = false) {
    const g = this.game;
    const c = g.collision;
    b.state = 1;
    b.t = 0;
    b.duration = 2.2 + Math.min(3, b.top / 90);
    // Collision gone immediately: things on the roof fall.
    b.boxY = [];
    for (const box of b.boxes) {
      const o = box * 6;
      b.boxY.push(c.boxes[o + 1], c.boxes[o + 4]);
      c.boxes[o + 1] = -1000;
      c.boxes[o + 4] = -1000;
    }
    for (const r of b.roofs) r.dead = true;
    setFarBuildingHeight(this.city, b, 0);
    // Remember original heights of this building's vertices.
    const mesh = this.city.chunkByBuilder[b.builder];
    b.mesh = mesh;
    if (mesh) {
      const pos = mesh.geometry.attributes.position;
      b.orig = new Float32Array(b.vEnd - b.vStart);
      for (let v = b.vStart; v < b.vEnd; v++) b.orig[v - b.vStart] = pos.getY(v);
    }
    // Rooftop props + warning lights disappear.
    const pm = this.city.propMeshes;
    b.propMats = [];
    for (let k = 0; k < b.props.length; k += 2) {
      const im = pm[b.props[k]];
      const saved = new Matrix4();
      im.getMatrixAt(b.props[k + 1], saved);
      b.propMats.push(saved);
      im.setMatrixAt(b.props[k + 1], ZERO);
      im.instanceMatrix.needsUpdate = true;
    }
    const glows = this.city.glows;
    for (const gi of b.glows) glows.c[gi * 4 + 3] = 0;
    if (b.glows.length) glows.attrs[2].needsUpdate = true;
    g.decals.hideInBox(b.x0 - 1, b.z0 - 1, b.x1 + 1, b.z1 + 1);
    this.destroyed++;
    if (quiet) {
      b.t = b.duration;
      b.quiet = true;
      this.active.push(b);
      return;
    }
    // Rumble + first dust wave.
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    g.audio.play('boom', cx, 5, cz, 1);
    g.audio.play('crack', cx, b.top * 0.5, cz, 1);
    g.shockwave(cx, 0.5, cz, Math.max(b.x1 - b.x0, b.z1 - b.z0) * 1.2);
    g.input.haptic('both', 0.8, 400);
    g.addScore(300);
    this.active.push(b);
  }

  // Put every destroyed building back (game restart).
  restoreAll() {
    const c = this.game.collision;
    const pm = this.city.propMeshes;
    const glows = this.city.glows;
    for (const b of this.city.buildings) {
      if (b.state === 0) { b.hp = b.maxHp; continue; }
      b.boxes.forEach((box, k) => { c.boxes[box * 6 + 1] = b.boxY[k * 2]; c.boxes[box * 6 + 4] = b.boxY[k * 2 + 1]; });
      for (const r of b.roofs) r.dead = false;
      setFarBuildingHeight(this.city, b, b.top);
      if (b.mesh && b.orig) {
        const attr = b.mesh.geometry.attributes.position;
        for (let v = b.vStart; v < b.vEnd; v++) attr.array[v * 3 + 1] = b.orig[v - b.vStart];
        attr.clearUpdateRanges();
        attr.addUpdateRange(b.vStart * 3, (b.vEnd - b.vStart) * 3);
        attr.needsUpdate = true;
      }
      for (let k = 0; k < b.props.length; k += 2) {
        pm[b.props[k]].setMatrixAt(b.props[k + 1], b.propMats[k / 2]);
        pm[b.props[k]].instanceMatrix.needsUpdate = true;
      }
      for (const gi of b.glows) glows.c[gi * 4 + 3] = 1;
      if (b.glows.length) glows.attrs[2].needsUpdate = true;
      b.state = 0; b.hp = b.maxHp; b.orig = null;
    }
    this.active.length = 0;
  }

  frame(dt) {
    if (this.active.length === 0) return;
    const p = this.game.particles;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      b.t += dt;
      const k = Math.min(1, b.t / b.duration);
      const ease = k * k * (3 - 2 * k);
      const drop = ease * (b.top - 1.5);
      if (b.mesh) {
        const attr = b.mesh.geometry.attributes.position;
        const arr = attr.array;
        for (let v = b.vStart; v < b.vEnd; v++) {
          arr[v * 3 + 1] = b.orig[v - b.vStart] - drop;
        }
        attr.clearUpdateRanges();
        attr.addUpdateRange(b.vStart * 3, (b.vEnd - b.vStart) * 3);
        attr.needsUpdate = true;
      }
      if (b.quiet) { b.quiet = false; b.state = 2; this.active.splice(i, 1); continue; }
      // Dust boiling out at street level + chunks raining from the falling top.
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      const topNow = b.top - drop;
      for (let n = 0; n < 3; n++) {
        const side = Math.random() * 4 | 0;
        const t = Math.random();
        const x = side === 0 ? b.x0 : side === 1 ? b.x1 : b.x0 + w * t;
        const z = side === 2 ? b.z0 : side === 3 ? b.z1 : b.z0 + d * t;
        p.concreteBurst(x, 1 + Math.random() * 4, z, side === 0 ? -1 : side === 1 ? 1 : 0, 0.4, side === 2 ? -1 : side === 3 ? 1 : 0, 2, 8);
      }
      // billowing dust cloud around the base
      if (Math.random() < 0.8) {
        const a = Math.random() * 6.283;
        const rx = w * 0.6 + 4, rz = d * 0.6 + 4;
        p.puff((b.x0 + b.x1) / 2 + Math.cos(a) * rx, 2 + Math.random() * 6, (b.z0 + b.z1) / 2 + Math.sin(a) * rz,
          Math.cos(a) * 8, 1 + Math.random() * 3, Math.sin(a) * 8, 14 + Math.random() * 14 + b.top * 0.1,
          0.55, 0.5, 0.45, 4 + Math.random() * 3);
      }
      if (topNow > 2 && Math.random() < 0.6) {
        p.concreteBurst(b.x0 + w * Math.random(), topNow, b.z0 + d * Math.random(), 0, 1, 0, 2, 6);
      }
      if (k >= 1) {
        b.state = 2;
        this.active.splice(i, 1);
      }
    }
  }
}
