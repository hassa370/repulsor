import {
  AdditiveBlending, CylinderGeometry, Mesh, ShaderMaterial, Vector3,
} from 'three';
import { FLIGHT, WEAPONS } from '../config.js';

// Repulsor blasts (quick / charged), unibeam and hand crosshairs.
// All projectiles are pooled; visuals go through the additive SpriteBatch.

const _o = new Vector3();
const _d = new Vector3();
const _v = new Vector3();
const _q0 = new Vector3();
const _q1 = new Vector3();
const _t = new Vector3(); // shot target point
const _p = new Vector3(); // shot origin (palm)
const _base = new Vector3();

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
    this.target = null;
    this.speed = 0;
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
    // Aim ray (where the player intends to shoot): controller pointing pose in
    // VR, the screen crosshair on desktop.
    this.pos = new Vector3(); // controller / desktop hand point
    this.dir = new Vector3(); // controller pointing direction
    this.aimO = new Vector3();
    this.aimD = new Vector3();
    // Projectile origin: the visible palm repulsor socket.
    this.palm = new Vector3();
    this.palmDir = new Vector3(); // out of the palm
    this.palmOff = new Vector3(); // palm relative to the rendered body position
    this.aimDist = 50;
  }
}

const BEAM_VS = /* glsl */ `
varying vec2 vUv;
varying float vFacing;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFacing = abs(dot(n, normalize(-mv.xyz))); // 1 at the centre line, 0 at the edges
  gl_Position = projectionMatrix * mv;
}
`;
const BEAM_FS = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uLength;
uniform vec3 uColor;
uniform float uSharp;
varying vec2 vUv;
varying float vFacing;
void main() {
  float along = vUv.y * uLength;
  float band = 0.75 + 0.25 * sin(along * 0.35 - uTime * 60.0) * sin(along * 0.11 + uTime * 23.0);
  float prof = pow(vFacing, uSharp);
  vec3 col = uColor * prof * band + vec3(1.0) * pow(vFacing, uSharp * 4.0) * 0.8;
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
    this.beamBurn = 0;
    this.beamOrigin = new Vector3();
    this.beamDir = new Vector3();
    this.beamLen = 0;

    // Unibeam: a white-hot core tube inside a wider cyan glow tube (soft
    // fresnel edges), plus sprite halos, spiral energy and an impact flare.
    const geo = new CylinderGeometry(1, 1, 1, 14, 1, true);
    geo.translate(0, 0.5, 0);
    geo.rotateX(-Math.PI / 2); // along -Z
    const mkBeam = (color, sharp) => {
      const mat = new ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uIntensity: { value: 1 }, uLength: { value: 100 }, uColor: { value: color }, uSharp: { value: sharp } },
        vertexShader: BEAM_VS, fragmentShader: BEAM_FS,
        transparent: true, depthWrite: false, blending: AdditiveBlending,
      });
      const m = new Mesh(geo, mat);
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = 12;
      scene.add(m);
      return m;
    };
    this.beamCore = mkBeam(new Vector3(0.7, 0.9, 1.0), 1.5);
    this.beamGlow = mkBeam(new Vector3(0.15, 0.5, 1.0), 2.5);
  }

  clear() {
    for (let i = 0; i < this.blasts.length; i++) this.blasts[i].active = false;
    this.unibeamTime = 0;
    this.unibeamCd = 0;
  }

  // Hand aim rays + palm repulsor poses in world space (called before physics
  // and again before rendering each frame).
  updateAim() {
    const g = this.game;
    const input = g.input;
    // Body position the rig was rendered at (the palm offset is stored relative
    // to it so shots can spawn at the palm for any physics sub-step).
    g.headOffset(_base);
    _base.set(g.rig.position.x + _base.x, g.rig.position.y, g.rig.position.z + _base.z);
    for (let i = 0; i < 2; i++) {
      const h = this.hands[i];
      const obj = input.aimObject(h.name);
      obj.updateWorldMatrix(true, false);
      h.pos.setFromMatrixPosition(obj.matrixWorld);
      const e = obj.matrixWorld.elements;
      h.dir.set(-e[8], -e[9], -e[10]).normalize();
      if (input.xr) {
        h.aimO.copy(h.pos);
        h.aimD.copy(h.dir);
      } else {
        // desktop: aim along the crosshair; both hands converge on it
        h.aimO.copy(g.headWorld);
        h.aimD.copy(g.look);
        h.dir.copy(g.look).multiplyScalar(60).add(g.headWorld).sub(h.pos).normalize();
      }
      // Palm repulsor socket, cached by Game.updatePalmSockets() (shared with the thruster FX).
      if (g.palmOk[i]) {
        h.palm.copy(g.palmPos[i]);
        h.palmDir.copy(g.palmDir[i]);
      } else {
        // no visible gauntlet (desktop / hand not tracked): the hand point
        h.palm.copy(h.pos);
        h.palmDir.copy(h.dir);
      }
      h.palmOff.copy(h.palm).sub(_base);
    }
  }

  // Where this hand's shot should land: the aim ray against the world, then
  // aim assist (with lead). Writes the point to out; returns the assisted goon.
  aimTarget(h, speed, out) {
    const c = this.game.collision;
    const o = h.aimO, d = h.aimD;
    const R = WEAPONS.aimRange;
    const dist = Math.min(c.raycast(o.x, o.y, o.z, d.x, d.y, d.z, R, true), R);
    out.copy(d).multiplyScalar(dist).add(o);
    return this.assistTarget(o, d, speed, out);
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
    // controller ray -> raw target -> aim assist -> final target
    b.target = this.aimTarget(h, sp, _t);
    // Origin: the palm repulsor where it is drawn at the start of this physics
    // step (weapons run after the body step, so body.prevPos is that position).
    _p.copy(g.body.prevPos).add(h.palmOff);
    // Direction: straight from the palm to the target.
    _d.copy(_t).sub(_p);
    const len = _d.length();
    if (len > WEAPONS.minAimDist) _d.multiplyScalar(1 / len);
    else _d.copy(h.aimD);
    b.pos.copy(_p).addScaledVector(_d, WEAPONS.spawnOffset);
    b.prevPos.copy(b.pos);
    // No inherited player velocity: the shot flies exactly along palm -> target.
    b.speed = sp;
    b.vel.copy(_d).multiplyScalar(sp);
    b.life = WEAPONS.life;
    b.age = 0;
    h.flash = charged ? 0.14 : 0.07;
    h.cooldown = WEAPONS.fireCooldown;
    const recoil = charged ? FLIGHT.recoilCharged * power : FLIGHT.recoilQuick;
    g.body.impulse(-_d.x * recoil, -_d.y * recoil, -_d.z * recoil);
    g.input.haptic(h.name, charged ? 0.9 : 0.4, charged ? 90 : 35);
    g.audio.play(charged ? 'charged' : 'blast', _p.x, _p.y, _p.z, 1);
  }

  // Best goon for aim assist near the ray (o, dir). If found and outPoint is
  // given, writes the lead-corrected aim point on the goon to outPoint.
  assistTarget(o, dir, speed, outPoint) {
    const list = this.game.enemies.list;
    const cosA = Math.cos(WEAPONS.assistDeg * Math.PI / 180);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.active) continue;
      const cx = e.pos.x - o.x, cy = e.pos.y + 1.1 * e.scale - o.y, cz = e.pos.z - o.z;
      const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (d > WEAPONS.assistRange || d < 1) continue;
      const along = (cx * dir.x + cy * dir.y + cz * dir.z);
      if (along <= 0) continue;
      const c = along / d;
      const miss = Math.sqrt(Math.max(0, d * d - along * along)); // distance from ray
      if (c < cosA && miss > WEAPONS.assistRadius * e.scale) continue;
      const score = c - d * 0.0002;
      if (score > bestScore) { bestScore = score; best = e; }
    }
    if (best && outPoint) {
      const cx = best.pos.x - o.x, cy = best.pos.y + 1.1 * best.scale - o.y, cz = best.pos.z - o.z;
      const T = Math.sqrt(cx * cx + cy * cy + cz * cz) / speed;
      outPoint.set(best.pos.x + best.vel.x * T, best.pos.y + 1.1 * best.scale + best.vel.y * T * 0.5, best.pos.z + best.vel.z * T);
    }
    return best;
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
      // Gentle homing toward the assisted target.
      const t = b.target;
      if (t && t.active) {
        _v.set(t.pos.x - b.pos.x, t.pos.y + 1.1 * t.scale - b.pos.y, t.pos.z - b.pos.z).normalize();
        const sp = b.vel.length();
        _o.copy(b.vel).multiplyScalar(1 / sp);
        if (_o.dot(_v) > 0.5) {
          const k = Math.min(1, (b.charged ? WEAPONS.homingCharged : WEAPONS.homingQuick) * dt);
          _o.lerp(_v, k).normalize();
          b.vel.copy(_o).multiplyScalar(sp);
        }
      }
      b.pos.addScaledVector(b.vel, dt);
      b.life -= dt;
      // fire trail: embers rising off the fireball, the odd smoke puff
      const P = g.particles;
      if (Math.random() < (b.charged ? 1 : 0.6)) {
        P.ember(b.pos.x, b.pos.y, b.pos.z, (Math.random() - 0.5) * 2, 0.5 + Math.random(), (Math.random() - 0.5) * 2,
          1.0, 0.35 + Math.random() * 0.3, 0.05, 0.35 + Math.random() * 0.3);
      }
      if (Math.random() < (b.charged ? 0.35 : 0.12)) {
        P.ember(b.prevPos.x, b.prevPos.y, b.prevPos.z, (Math.random() - 0.5), 1.2, (Math.random() - 0.5), 0.12, 0.1, 0.09, 1.4);
      }
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
      if (inside >= 0) this.hitBuilding(b, inside);
      else if (inside !== -1 || b.life <= 0) this.explode(b, inside !== -1);
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
      const look = g.look;
      const o = this.beamOrigin.copy(g.headWorld);
      o.y -= 0.35;
      o.addScaledVector(look, 0.3);
      this.beamDir.copy(look);
      const len = c.raycast(o.x, o.y, o.z, look.x, look.y, look.z, WEAPONS.unibeamRange);
      this.beamLen = len;
      if (c.hitBox >= 0) {
        this.beamBurn += dt;
        if (this.beamBurn > 0.25) {
          this.beamBurn = 0;
          g.destruction.damageBox(c.hitBox, WEAPONS.unibeamBuildingDps * 0.25);
          const n = c.hitNormal;
          g.decals.add(g.time, o.x + look.x * len, o.y + look.y * len, o.z + look.z * len, n[0], n[1], n[2], 2.5);
        }
      }
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

  // Fireball into a building: scorch mark on the face, chunks, building damage.
  hitBuilding(b, box) {
    const g = this.game;
    const c = g.collision;
    _d.copy(b.vel).normalize();
    const back = b.vel.length() * (1 / 90) + 1;
    const t = c.raycast(b.pos.x - _d.x * back, b.pos.y - _d.y * back, b.pos.z - _d.z * back, _d.x, _d.y, _d.z, back + 1);
    const n = c.hitNormal;
    if (t < back + 1) {
      b.pos.set(b.pos.x - _d.x * back + _d.x * t, b.pos.y - _d.y * back + _d.y * t, b.pos.z - _d.z * back + _d.z * t);
      g.decals.add(g.time, b.pos.x, b.pos.y, b.pos.z, n[0], n[1], n[2], b.charged ? 3.5 : 1.6);
      g.particles.concreteBurst(b.pos.x, b.pos.y, b.pos.z, n[0], n[1], n[2], b.charged ? 16 : 5, b.charged ? 10 : 6);
    }
    g.destruction.damageBox(box, b.charged ? WEAPONS.buildingDamageCharged * b.power : WEAPONS.buildingDamageQuick);
    this.explode(b, true);
  }

  explode(b, impact, enemyHit) {
    const g = this.game;
    b.active = false;
    if (!impact) return;
    const p = b.pos;
    if (b.charged) {
      // big fire explosion
      g.particles.sparkBurst(p.x, p.y, p.z, 45, 14, 1.0, 0.45, 0.08, 1.0, -0.1);
      g.particles.sparkBurst(p.x, p.y, p.z, 20, 7, 1.0, 0.85, 0.4, 0.6, 0);
      g.particles.puff(p.x, p.y, p.z, 0, 1, 0, 9 * b.power, 0.2, 0.18, 0.16, 2.5);
      g.particles.puff(p.x, p.y + 1, p.z, 1, 2, -1, 6 * b.power, 0.25, 0.22, 0.2, 3);
      g.flashAt(p.x, p.y, p.z, 5 * b.power, 0.35, 1.0, 0.55, 0.15);
      // splash also hurts nearby buildings
      const nb = g.collision.query(p.x - 4, p.z - 4, p.x + 4, p.z + 4);
      for (let k = 0; k < nb; k++) {
        const box = g.collision.result[k];
        if (g.collision.insideBox(box, p.x, p.y, p.z, 4) && box >= 0) g.destruction.damageBox(box, 1);
      }
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
      g.particles.sparkBurst(p.x, p.y, p.z, 14, 8, 1.0, 0.5, 0.1, 0.55, -0.1);
      g.particles.puff(p.x, p.y, p.z, 0, 1, 0, 3.5, 0.22, 0.2, 0.18, 1.8);
      g.flashAt(p.x, p.y, p.z, 1.8, 0.18, 1.0, 0.55, 0.15);
      g.audio.play('boom', p.x, p.y, p.z, 0.35, 1.6);
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
      // Fireball: white-yellow core in flickering orange flame, with a tail of
      // fire blobs fading to red behind it, along its own flight path.
      _v.copy(b.vel);
      const sp2 = _v.length() || 1;
      const R = b.charged ? b.radius * 1.4 : 0.42;
      const t = g.time * 25 + i * 3.7;
      sp.pushPoint(_o.x, _o.y, _o.z, R * (2.6 + 0.4 * Math.sin(t)), 1.0, 0.32, 0.04, 0.55, 0);
      sp.pushPoint(_o.x, _o.y, _o.z, R * (1.5 + 0.2 * Math.sin(t * 1.7)), 1.0, 0.55, 0.12, 0.95, 0.25);
      sp.pushPoint(_o.x, _o.y, _o.z, R * 0.75, 1.0, 0.9, 0.6, 1, 0.8);
      // licking flames around the core
      for (let k = 0; k < 3; k++) {
        const a = t * 0.6 + k * 2.1;
        const jx = Math.sin(a) * R * 0.6, jy = Math.cos(a * 1.3) * R * 0.6, jz = Math.sin(a * 0.7 + k) * R * 0.6;
        sp.pushPoint(_o.x + jx, _o.y + jy, _o.z + jz, R * 0.9, 1.0, 0.45, 0.06, 0.7, 0.1);
      }
      // tail
      const n = b.charged ? 7 : 5;
      const spacing = (b.charged ? 0.5 : 0.35) * R / 0.42;
      const maxTail = Math.min(n, Math.floor(b.age * sp2 / spacing));
      for (let k = 1; k <= maxTail; k++) {
        const f = k / (n + 1);
        const d = k * spacing;
        const w = Math.sin(t * 0.8 + k) * R * 0.25;
        sp.pushPoint(_o.x - _v.x / sp2 * d + w, _o.y - _v.y / sp2 * d, _o.z - _v.z / sp2 * d - w,
          R * (1.5 - f), 1.0, 0.5 - 0.35 * f, 0.08 * (1 - f), 0.8 * (1 - f), 0.1);
      }
    }
    const input = g.input;
    for (let i = 0; i < 2; i++) {
      const h = this.hands[i];
      if (h.flash > 0) {
        const k = h.flash / 0.1;
        const f = 0.03 + 0.05 * k; // flash bloom just out of the palm repulsor
        sp.pushPoint(h.palm.x + h.palmDir.x * f, h.palm.y + h.palmDir.y * f, h.palm.z + h.palmDir.z * f, 0.14 + 0.22 * k, 1.0, 0.55, 0.12, Math.min(1, k), 0.5);
      }
      if (h.down && h.held > 0.05) {
        const c = Math.min(1, h.held / WEAPONS.fullChargeTime);
        const pulse = 0.85 + 0.15 * Math.sin(g.time * 30);
        // fireball growing in the palm
        const r0 = 0.02 + 0.05 * c; // sits on the repulsor disc, bulging out as it grows
        const cx = h.palm.x + h.palmDir.x * r0, cy = h.palm.y + h.palmDir.y * r0, cz = h.palm.z + h.palmDir.z * r0;
        sp.pushPoint(cx, cy, cz, (0.05 + 0.16 * c) * pulse, 1.0, 0.35, 0.05, 0.7, 0);
        sp.pushPoint(cx, cy, cz, (0.03 + 0.08 * c) * pulse, 1.0, 0.8, 0.4, 1, 0.7);
        if (Math.random() < 0.3 + c) g.particles.ember(cx, cy, cz, (Math.random() - 0.5) * 0.6, 0.4 + Math.random() * 0.6, (Math.random() - 0.5) * 0.6, 1.0, 0.45, 0.08, 0.4);
      }
    }
    // Unibeam visual (starts ~1 m ahead of the chest so it never fills the view)
    if (this.unibeamTime > 0) {
      const o = this.beamOrigin, d = this.beamDir;
      const k = Math.min(1, this.unibeamTime / 0.2) * Math.min(1, (WEAPONS.unibeamDuration - this.unibeamTime) / 0.08);
      const start = Math.min(1.0, this.beamLen);
      const len = Math.max(0.01, this.beamLen - start);
      _o.copy(o).addScaledVector(d, start);
      _v.copy(_o).sub(d);
      const wob = 0.9 + 0.1 * Math.sin(g.time * 70);
      for (let m = 0; m < 2; m++) {
        const beam = m === 0 ? this.beamCore : this.beamGlow;
        beam.visible = true;
        beam.position.copy(_o);
        beam.lookAt(_v);
        const w = (m === 0 ? 0.28 : 0.9) * wob;
        beam.scale.set(w, w, len);
        const u = beam.material.uniforms;
        u.uTime.value = g.time; u.uIntensity.value = k; u.uLength.value = len;
      }
      // spiral energy around the beam
      _q0.set(0, 1, 0);
      if (Math.abs(d.y) > 0.9) _q0.set(1, 0, 0);
      _q1.crossVectors(d, _q0).normalize();
      _q0.crossVectors(_q1, d);
      const n = Math.min(40, Math.floor(len / 4));
      for (let s2 = 0; s2 < n; s2++) {
        const t = start + (s2 + 0.5) * (len / n);
        const ang = t * 0.5 - g.time * 25;
        const rr = 0.8;
        const ca = Math.cos(ang) * rr, sa = Math.sin(ang) * rr;
        sp.pushPoint(o.x + d.x * t + _q1.x * ca + _q0.x * sa, o.y + d.y * t + _q1.y * ca + _q0.y * sa,
          o.z + d.z * t + _q1.z * ca + _q0.z * sa, 0.22, 0.3, 0.7, 1.0, 0.6 * k, 0.4);
      }
      sp.pushPoint(_o.x, _o.y, _o.z, 0.35, 0.5, 0.8, 1.0, k, 0.6);
      _v.copy(o).addScaledVector(d, this.beamLen);
      const fl = 3 + Math.sin(g.time * 40) * 0.6;
      sp.pushPoint(_v.x, _v.y, _v.z, fl, 0.4, 0.75, 1.0, k, 0.5);
      sp.pushPoint(_v.x, _v.y, _v.z, fl * 2.2, 0.2, 0.45, 1.0, 0.4 * k, 0);
    } else {
      this.beamCore.visible = false;
      this.beamGlow.visible = false;
    }
    // Aim dot where each hand points (VR, finger on the trigger) and a lock-on
    // marker on the goon aim assist would hit. No beam line before firing.
    const ov = g.overlaySprites;
    if (input.xr) {
      for (let i = 0; i < 2; i++) {
        const h = this.hands[i];
        if (h.value < 0.02) continue;
        const c = g.collision;
        const dist = Math.min(c.raycast(h.pos.x, h.pos.y, h.pos.z, h.dir.x, h.dir.y, h.dir.z, WEAPONS.aimRange, true), WEAPONS.aimRange);
        const lock = this.assistTarget(h.pos, h.dir, WEAPONS.quickSpeed, null);
        const k = 0.35 + 0.65 * Math.min(1, h.value / 0.55);
        _v.copy(h.dir).multiplyScalar(Math.min(dist, 150)).add(h.pos);
        ov.pushPoint(_v.x, _v.y, _v.z, 0.004 * Math.min(dist, 150) + 0.01, 1.0, 0.9, 0.7, 0.8 * k, 0.5);
        if (lock) {
          const lx = lock.pos.x, ly = lock.pos.y + 1.1 * lock.scale, lz = lock.pos.z;
          const ld = Math.hypot(lx - g.headWorld.x, ly - g.headWorld.y, lz - g.headWorld.z);
          const pulse = 0.8 + 0.2 * Math.sin(g.time * 20);
          ov.pushPoint(lx, ly, lz, ld * 0.012 * pulse, 1.0, 0.2, 0.15, 0.6 * k, 0.15);
        }
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
