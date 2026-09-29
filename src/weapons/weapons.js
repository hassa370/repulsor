import {
  AdditiveBlending, CylinderGeometry, Mesh, ShaderMaterial, Vector3,
} from 'three';
import { FLIGHT, WEAPONS } from '../config.js';

// Repulsor blasts (quick / charged), unibeam and hand crosshairs.
// All projectiles are pooled; visuals go through the additive SpriteBatch.

const _o = new Vector3();
const _d = new Vector3();
const _v = new Vector3();

class Blast {
  constructor() {
    this.active = false;
    this.pos = new Vector3();
    this.prevPos = new Vector3();
    this.vel = new Vector3();
    this.charged = false;
    this.power = 1;
    this.radius = 0.3;
    this.life = 0;
    this.age = 0;
  }
}

class Hand {
  constructor(name) {
    this.name = name;
    this.held = 0; // seconds trigger held
    this.down = false;
    this.cooldown = 0;
    this.value = 0;
    this.flash = 0; // muzzle flash timer
    this.pos = new Vector3();
    this.dir = new Vector3();
    this.aimDist = 50;
  }
}

const BEAM_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const BEAM_FS = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uLength;
varying vec2 vUv;
void main() {
  float along = vUv.y * uLength;
  float band = 0.6 + 0.4 * sin(along * 0.6 - uTime * 40.0);
  float edge = 1.0 - abs(vUv.x * 2.0 - 1.0);
  vec3 col = mix(vec3(0.3, 0.7, 1.0), vec3(0.9, 0.97, 1.0), band) * (0.6 + edge * 0.8);
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`;

export class Weapons {
  constructor(game, scene) {
    this.game = game;
    this.blasts = [];
    for (let i = 0; i < WEAPONS.maxBlasts; i++) this.blasts.push(new Blast());
    this.hands = [new Hand('left'), new Hand('right')];
    this.activeCount = 0;
    this.unibeamCd = 0;
    this.unibeamTime = 0;
    this.beamOrigin = new Vector3();
    this.beamDir = new Vector3();
    this.beamLen = 0;

    const geo = new CylinderGeometry(1, 1, 1, 12, 1, true);
    geo.translate(0, 0.5, 0);
    geo.rotateX(-Math.PI / 2); // along -Z
    this.beamMat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 1 }, uLength: { value: 100 } },
      vertexShader: BEAM_VS, fragmentShader: BEAM_FS,
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
    this.beam = new Mesh(geo, this.beamMat);
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    this.beam.renderOrder = 12;
    scene.add(this.beam);
  }

  clear() {
    for (let i = 0; i < this.blasts.length; i++) this.blasts[i].active = false;
    this.unibeamTime = 0;
    this.unibeamCd = 0;
  }

  // Hand aim poses in world space (called before physics each frame).
  updateAim() {
    const input = this.game.input;
    for (let i = 0; i < 2; i++) {
      const h = this.hands[i];
      const obj = input.aimObject(h.name);
      obj.updateWorldMatrix(true, false);
      h.pos.setFromMatrixPosition(obj.matrixWorld);
      const e = obj.matrixWorld.elements;
      h.dir.set(-e[8], -e[9], -e[10]).normalize();
      if (!input.xr) {
        // desktop: both hands converge on the screen centre
        _v.copy(this.game.stepInput.look).multiplyScalar(60).add(this.game.headWorld).sub(h.pos).normalize();
        h.dir.copy(_v);
      }
    }
  }

  fire(h, charged, power) {
    const g = this.game;
    let b = null;
    for (let i = 0; i < this.blasts.length; i++) if (!this.blasts[i].active) { b = this.blasts[i]; break; }
    if (!b) return;
    b.active = true;
    b.charged = charged;
    b.power = power;
    b.radius = charged ? WEAPONS.chargedRadius * (0.6 + 0.4 * power) : WEAPONS.quickRadius;
    const sp = charged ? WEAPONS.chargedSpeed : WEAPONS.quickSpeed;
    b.pos.copy(h.pos).addScaledVector(h.dir, 0.15);
    b.prevPos.copy(b.pos);
    // inherit player velocity so shots don't lag when flying fast
    b.vel.copy(h.dir).multiplyScalar(sp).add(g.body.vel);
    b.life = WEAPONS.life;
    b.age = 0;
    h.flash = charged ? 0.14 : 0.07;
    h.cooldown = WEAPONS.fireCooldown;
    const recoil = charged ? FLIGHT.recoilCharged * power : FLIGHT.recoilQuick;
    g.body.impulse(-h.dir.x * recoil, -h.dir.y * recoil, -h.dir.z * recoil);
    g.input.haptic(h.name, charged ? 0.9 : 0.4, charged ? 90 : 35);
    g.audio.play(charged ? 'charged' : 'blast', h.pos.x, h.pos.y, h.pos.z, 1);
  }

  fixed(dt) {
    const g = this.game;
    const input = g.input;
    // ---- triggers: tap = quick shot, hold = charge (fires on release)
    for (let i = 0; i < 2; i++) {
      const h = this.hands[i];
      h.value = i === 0 ? input.trigL : input.trigR;
      h.cooldown -= dt;
      if (h.flash > 0) h.flash -= dt;
      const pressed = h.value > 0.55;
      if (pressed) {
        if (!h.down) { h.down = true; h.held = 0; }
        h.held += dt;
        if (h.held > WEAPONS.chargeTime && Math.floor(h.held * 20) !== Math.floor((h.held - dt) * 20)) {
          input.haptic(h.name, 0.1 + 0.3 * Math.min(1, h.held / WEAPONS.fullChargeTime), 20);
        }
      } else if (h.down && h.value < 0.35) {
        h.down = false;
        if (h.cooldown <= 0) {
          if (h.held >= WEAPONS.chargeTime) {
            const power = Math.min(1, (h.held - WEAPONS.chargeTime) / (WEAPONS.fullChargeTime - WEAPONS.chargeTime));
            this.fire(h, true, 0.4 + 0.6 * power);
          } else {
            this.fire(h, false, 1);
          }
        }
      }
    }

    // ---- blasts
    const enemies = g.enemies;
    const bats = g.bats;
    const c = g.collision;
    let n = 0;
    for (let i = 0; i < this.blasts.length; i++) {
      const b = this.blasts[i];
      if (!b.active) continue;
      n++;
      b.prevPos.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      b.life -= dt;
      b.age += dt;
      // bats in flight
      for (let k = 0; k < bats.list.length; k++) {
        const bat = bats.list[k];
        if (!bat.active) continue;
        if (segSphere(b.prevPos, b.pos, bat.pos, b.radius + bats.radius * bat.scale)) {
          bats.destroy(bat, true);
          g.addScore(25, false);
          if (!b.charged) { this.explode(b, false); break; }
        }
      }
      if (!b.active) continue;
      const e = enemies.segmentHit(b.prevPos.x, b.prevPos.y, b.prevPos.z, b.pos.x, b.pos.y, b.pos.z, b.radius);
      if (e) {
        const head = enemies.lastHeadshot;
        _d.copy(b.vel).normalize();
        const dmg = (b.charged ? WEAPONS.chargedDamage : WEAPONS.quickDamage) * (head ? WEAPONS.headshotMult : 1);
        g.particles.woodBurst(e.pos.x, enemies.lastHitY, e.pos.z, -_d.x, 0.3, -_d.z, head ? 14 : 8, 6, e.pos.y);
        const killed = enemies.damage(e, dmg, _d.x, _d.y, _d.z, head);
        if (head && !killed) g.audio.play('crack', e.pos.x, enemies.lastHitY, e.pos.z, 0.6);
        g.hitMarker(head, killed);
        this.explode(b, true, e);
        continue;
      }
      const inside = c.pointInside(b.pos.x, b.pos.y, b.pos.z);
      if (inside !== -1 || b.life <= 0) this.explode(b, inside !== -1);
    }
    this.activeCount = n;

    // ---- unibeam
    this.unibeamCd = Math.max(0, this.unibeamCd - dt);
    if (input.unibeamPressed && this.unibeamCd <= 0 && g.state === 'playing') {
      this.unibeamTime = WEAPONS.unibeamDuration;
      this.unibeamCd = WEAPONS.unibeamCooldown;
      g.audio.play('unibeam', g.headWorld.x, g.headWorld.y, g.headWorld.z, 1);
      input.haptic('both', 1, 300);
    }
    if (this.unibeamTime > 0) {
      this.unibeamTime -= dt;
      const look = g.stepInput.look;
      const o = this.beamOrigin.copy(g.headWorld);
      o.y -= 0.35;
      o.addScaledVector(look, 0.3);
      this.beamDir.copy(look);
      const len = c.raycast(o.x, o.y, o.z, look.x, look.y, look.z, WEAPONS.unibeamRange);
      this.beamLen = len;
      // damage everything along the beam
      _v.copy(o).addScaledVector(look, len);
      const R = WEAPONS.unibeamRadius;
      for (let k = 0; k < enemies.list.length; k++) {
        const e = enemies.list[k];
        if (!e.active) continue;
        const hit = segDistToEnemy(o, _v, e);
        if (hit < R + 0.4 * e.scale) {
          e.unibeamAcc += WEAPONS.unibeamDps * dt;
          if (e.unibeamAcc >= 1) {
            const dmg = Math.floor(e.unibeamAcc);
            e.unibeamAcc -= dmg;
            g.particles.woodBurst(e.pos.x, e.pos.y + 1.2 * e.scale, e.pos.z, look.x, 0.3, look.z, 5, 8, e.pos.y);
            if (enemies.damage(e, dmg, look.x, look.y, look.z, false)) g.hitMarker(false, true);
          }
        }
      }
      for (let k = 0; k < bats.list.length; k++) {
        const bat = bats.list[k];
        if (bat.active && segSphere(o, _v, bat.pos, R + 0.5)) bats.destroy(bat, true);
      }
      if (len < WEAPONS.unibeamRange && Math.random() < 0.6) {
        g.particles.sparkBurst(_v.x, _v.y, _v.z, 3, 10, 0.6, 0.85, 1.0, 0.6, 0.4);
      }
      // continuous recoil
      g.body.impulse(-look.x * 9 * dt, -look.y * 9 * dt, -look.z * 9 * dt);
    }
  }

  explode(b, impact, enemyHit) {
    const g = this.game;
    b.active = false;
    if (!impact) return;
    const p = b.pos;
    if (b.charged) {
      g.particles.sparkBurst(p.x, p.y, p.z, 30, 16, 0.5, 0.8, 1.0, 0.8, 0.3);
      g.flashAt(p.x, p.y, p.z, 4 * b.power, 0.25);
      // splash
      const enemies = g.enemies;
      const R = WEAPONS.chargedSplashRadius * (0.6 + 0.4 * b.power);
      for (let k = 0; k < enemies.list.length; k++) {
        const e = enemies.list[k];
        if (!e.active || e === enemyHit) continue;
        const dx = e.pos.x - p.x, dy = e.pos.y + e.scale - p.y, dz = e.pos.z - p.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < R) {
          const inv = 1 / Math.max(d, 0.1);
          if (enemies.damage(e, WEAPONS.chargedSplashDamage, dx * inv, dy * inv, dz * inv, false)) g.hitMarker(false, true);
        }
      }
      g.audio.play('boom', p.x, p.y, p.z, 0.9);
    } else {
      g.particles.sparkBurst(p.x, p.y, p.z, 8, 8, 0.5, 0.8, 1.0, 0.4, 0.3);
      g.flashAt(p.x, p.y, p.z, 1.2, 0.12);
    }
  }

  // Visuals: blasts with trails, muzzle flashes, charge orbs, beam, crosshairs.
  render(dt, alpha) {
    const g = this.game;
    const sp = g.sprites;
    for (let i = 0; i < this.blasts.length; i++) {
      const b = this.blasts[i];
      if (!b.active) continue;
      _o.lerpVectors(b.prevPos, b.pos, alpha);
      // short trail behind the blast (relative to the shooter's frame)
      const trail = b.charged ? 0.05 : 0.035;
      _v.copy(b.vel).sub(g.body.vel);
      const tl = Math.min(trail, b.age + 0.01);
      if (b.charged) {
        sp.push(_o.x - _v.x * tl, _o.y - _v.y * tl, _o.z - _v.z * tl, _o.x, _o.y, _o.z, b.radius, 0.35, 0.65, 1.0, 1, 0.45);
      } else {
        sp.push(_o.x - _v.x * tl, _o.y - _v.y * tl, _o.z - _v.z * tl, _o.x, _o.y, _o.z, b.radius, 0.45, 0.75, 1.0, 1, 0.35);
      }
    }
    const input = g.input;
    for (let i = 0; i < 2; i++) {
      const h = this.hands[i];
      if (h.flash > 0) {
        const k = h.flash / 0.1;
        sp.pushPoint(h.pos.x + h.dir.x * 0.08, h.pos.y + h.dir.y * 0.08, h.pos.z + h.dir.z * 0.08, 0.12 + 0.18 * k, 0.5, 0.8, 1.0, Math.min(1, k), 0.5);
      }
      if (h.down && h.held > 0.05) {
        const c = Math.min(1, h.held / WEAPONS.fullChargeTime);
        const pulse = 0.85 + 0.15 * Math.sin(g.time * 30);
        sp.pushPoint(h.pos.x + h.dir.x * 0.07, h.pos.y + h.dir.y * 0.07, h.pos.z + h.dir.z * 0.07, (0.03 + 0.09 * c) * pulse, 0.4, 0.7, 1.0, 0.6 + 0.4 * c, 0.5);
      } else if (input.xr) {
        // idle palm glow
        sp.pushPoint(h.pos.x, h.pos.y, h.pos.z, 0.03, 0.4, 0.7, 1.0, 0.5, 0.3);
      }
    }
    // Unibeam visual (starts ~1 m ahead of the chest so it never fills the view)
    if (this.unibeamTime > 0) {
      const o = this.beamOrigin, d = this.beamDir;
      const k = Math.min(1, this.unibeamTime / 0.2) * Math.min(1, (WEAPONS.unibeamDuration - this.unibeamTime) / 0.08);
      const start = Math.min(1.0, this.beamLen);
      const len = Math.max(0.01, this.beamLen - start);
      _o.copy(o).addScaledVector(d, start);
      this.beam.visible = true;
      this.beam.position.copy(_o);
      _v.copy(_o).sub(d);
      this.beam.lookAt(_v);
      const w = 0.22 * (0.85 + 0.15 * Math.sin(g.time * 50));
      this.beam.scale.set(w, w, len);
      this.beamMat.uniforms.uTime.value = g.time;
      this.beamMat.uniforms.uIntensity.value = k;
      this.beamMat.uniforms.uLength.value = len;
      const h0 = Math.min(3, this.beamLen);
      sp.push(o.x + d.x * h0, o.y + d.y * h0, o.z + d.z * h0, o.x + d.x * this.beamLen, o.y + d.y * this.beamLen, o.z + d.z * this.beamLen,
        0.7, 0.25, 0.55, 1.0, 0.35 * k, 0.15);
      sp.pushPoint(_o.x, _o.y, _o.z, 0.18, 0.5, 0.8, 1.0, k, 0.6);
      _v.copy(o).addScaledVector(d, this.beamLen);
      sp.pushPoint(_v.x, _v.y, _v.z, 2.5, 0.5, 0.8, 1.0, k, 0.4);
    } else {
      this.beam.visible = false;
    }
    // Crosshair dots where each hand points (only while a trigger is half-pressed, VR only)
    const ov = g.overlaySprites;
    if (input.xr) {
      for (let i = 0; i < 2; i++) {
        const h = this.hands[i];
        if (h.value < 0.1) continue;
        const c = g.collision;
        let dist = c.raycast(h.pos.x, h.pos.y, h.pos.z, h.dir.x, h.dir.y, h.dir.z, 400);
        _v.copy(h.dir).multiplyScalar(dist).add(h.pos);
        const e = g.enemies.segmentHit(h.pos.x, h.pos.y, h.pos.z, _v.x, _v.y, _v.z, 0.2);
        if (e) {
          dist = Math.max(0.5, Math.hypot(e.pos.x - h.pos.x, g.enemies.lastHitY - h.pos.y, e.pos.z - h.pos.z) - 0.3);
        }
        dist = Math.min(dist, 150);
        _v.copy(h.dir).multiplyScalar(dist).add(h.pos);
        const size = 0.004 * dist + 0.01;
        if (e) ov.pushPoint(_v.x, _v.y, _v.z, size * 1.6, 1.0, 0.35, 0.2, 1, 0.5);
        else ov.pushPoint(_v.x, _v.y, _v.z, size, 1.0, 0.85, 0.6, 0.9, 0.5);
      }
    }
  }
}

// Does segment a->b pass within r of point p?
function segSphere(a, b, p, r) {
  const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
  const l2 = sx * sx + sy * sy + sz * sz;
  let t = l2 > 1e-8 ? ((p.x - a.x) * sx + (p.y - a.y) * sy + (p.z - a.z) * sz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = a.x + sx * t - p.x, dy = a.y + sy * t - p.y, dz = a.z + sz * t - p.z;
  return dx * dx + dy * dy + dz * dz < r * r;
}

// Distance from segment a->b to an enemy's body centre line (sampled).
function segDistToEnemy(a, b, e) {
  const cx = e.pos.x, cz = e.pos.z;
  const y0 = e.pos.y + 0.4 * e.scale, y1 = e.pos.y + 1.7 * e.scale;
  const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
  const l2 = sx * sx + sy * sy + sz * sz;
  let t = l2 > 1e-8 ? ((cx - a.x) * sx + ((y0 + y1) * 0.5 - a.y) * sy + (cz - a.z) * sz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = a.x + sx * t, py = a.y + sy * t, pz = a.z + sz * t;
  const cy = py < y0 ? y0 : py > y1 ? y1 : py;
  return Math.hypot(px - cx, py - cy, pz - cz);
}
