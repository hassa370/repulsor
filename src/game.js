import { Group, Quaternion, Vector3 } from 'three';
import { ENEMY, FLIGHT, PLAYER, WORLD } from './config.js';
import { PlayerBody } from './physics/player.js';
import { cullChunks } from './world/city.js';
import { U } from './world/shared.js';
import { SpriteBatch } from './fx/sprites.js';
import { Particles } from './fx/particles.js';
import { GoonRenderer } from './enemy/goonRenderer.js';
import { Enemies } from './enemy/enemies.js';
import { Bats } from './enemy/bats.js';
import { Debris } from './enemy/debris.js';
import { Waves } from './enemy/waves.js';
import { Weapons } from './weapons/weapons.js';
import { Hud } from './hud/hud.js';
import { makeGauntlet } from './hud/hands.js';

const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _look = new Vector3();
const _thrustLook = new Vector3(0, 0, -1);
const _right = new Vector3();
const _fwd = new Vector3();
const _headW = new Vector3();
const _up = new Vector3();
const UP = new Vector3(0, 1, 0);

class Flash {
  constructor() { this.x = 0; this.y = 0; this.z = 0; this.r = 0; this.life = 0; this.max = 1; }
}
class Wave3D {
  constructor() { this.x = 0; this.y = 0; this.z = 0; this.r = 0; this.t = 1; }
}

// Owns the player rig, fixed-step simulation and per-frame orchestration.
export class Game {
  constructor({ renderer, scene, camera, input, collision, city, perf, audio, goonAssets }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.input = input;
    this.collision = collision;
    this.city = city;
    this.perf = perf;
    this.audio = audio;

    // rig (feet + yaw) -> bank (roll into turns) -> inner -> camera / controllers
    this.rig = new Group();
    this.bank = new Group();
    this.inner = new Group();
    this.rig.add(this.bank);
    this.bank.add(this.inner);
    this.inner.add(camera);
    for (let i = 0; i < 2; i++) {
      this.inner.add(input.controllers[i]);
      this.inner.add(input.grips[i]);
    }
    camera.add(input.deskAimL);
    camera.add(input.deskAimR);
    scene.add(this.rig);

    this.body = new PlayerBody(collision);
    this.headLocal = new Vector3(0, 1.7, 0);
    this.lastOffset = new Vector3();
    this.wasXR = false;
    this.deskPitch = 0;
    this.roll = 0;
    this.prevVel = new Vector3();
    this.latAcc = 0;
    this.physAcc = 0;
    this.step = 1 / FLIGHT.physicsHz;
    this.time = 0;
    this.state = 'playing'; // 'playing' | 'paused' | 'dead'
    this.boostMeter = 1;
    this.boostIdle = 0;
    this.gripSmooth = 0;
    this.hp = PLAYER.maxHp;
    this.hurtTimer = 0;
    this.score = 0;
    this.wave = 0;
    this.deathTimer = 0;
    this.snapPulse = 0;
    this.audioTimer = 0;
    this.stepInput = {
      grip: 0, boost: false, look: _thrustLook, stickX: 0, stickY: 0, right: _right, fwd: _fwd,
    };
    this.options = { vignette: true, bank: FLIGHT.bankEnabled, debug: false };

    // Systems
    this.sprites = new SpriteBatch(640);
    scene.add(this.sprites.mesh);
    this.overlaySprites = new SpriteBatch(128, { depthTest: false, renderOrder: 999 });
    scene.add(this.overlaySprites.mesh);
    this.particles = new Particles(scene);
    const cap = ENEMY.maxActive;
    const debrisCap = 110;
    this.goonRenderer = new GoonRenderer(scene, goonAssets.atlas, goonAssets.parts, {
      head: cap + debrisCap, body: cap + debrisCap, armL: cap + debrisCap, armR: cap + debrisCap,
      legL: cap + debrisCap, legR: cap + debrisCap, bat: cap * 2 + debrisCap, silhouette: cap, sprite: cap,
    }, goonAssets.spriteImage, goonAssets.spriteTexture);
    this.debris = new Debris(collision, debrisCap);
    this.enemies = new Enemies(this);
    this.bats = new Bats(this);
    this.weapons = new Weapons(this, scene);
    this.hud = new Hud(this);
    this.waves = new Waves(this);
    this.flashes = [];
    for (let i = 0; i < 24; i++) this.flashes.push(new Flash());
    this.rings = [];
    for (let i = 0; i < 4; i++) this.rings.push(new Wave3D());

    // Gauntlets: on grips in VR, on the fake aim points on desktop.
    this.gauntL = makeGauntlet(-1);
    this.gauntR = makeGauntlet(1);
    this.gauntParentL = null;
    this.gauntParentR = null;

    this.respawn();
  }

  // ---------------------------------------------------------------- lifecycle
  onStart() {
    this.audio.start();
    this.restart();
  }

  restart() {
    this.enemies.clear();
    this.bats.clear();
    this.debris.clear();
    this.weapons.clear();
    this.waves.reset();
    this.hp = PLAYER.maxHp;
    this.score = 0;
    this.wave = 0;
    this.state = 'playing';
    this.hud.fade = 0;
    this.hud.setMenu(false);
    this.respawn();
    this.hud.showMessage('REPULSOR', 'Squeeze LEFT GRIP to fly · triggers to fire', 4);
  }

  respawn() {
    const s = this.city.startPos;
    this.body.reset(s.x, s.y + 0.05, s.z + 4);
    this.rig.rotation.set(0, this.city.startYaw, 0);
    this.headOffset(this.lastOffset);
    this.rig.position.copy(this.body.pos).sub(this.lastOffset);
    this.boostMeter = 1;
  }

  get headWorld() { return _headW; }
  // Raw head look direction (aiming, culling). Thrust uses a smoothed copy.
  get look() { return _look; }

  // ------------------------------------------------------------ game events
  damagePlayer(amount, dx, dy, dz, knock) {
    if (this.state !== 'playing') return;
    this.hp -= amount;
    this.hurtTimer = 0;
    this.hud.damage = 1;
    this.body.impulse(dx * knock, Math.max(dy, 0.2) * knock, dz * knock);
    this.input.haptic('both', 0.9, 160);
    this.audio.playLocal('hurt', 1);
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'dead';
      this.deathTimer = 0;
      this.hud.showMessage('LOGGED OUT', `Score ${this.score} · wave ${this.wave}`, 4);
    }
  }

  addScore(n) {
    this.score += n;
  }

  hitMarker(head, killed) {
    this.input.haptic('right', killed ? 0.5 : 0.25, killed ? 60 : 25);
    if (killed) this.audio.playLocal('pickup', 0.25);
  }

  flashAt(x, y, z, r, life) {
    let best = this.flashes[0];
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      if (f.life <= 0) { best = f; break; }
      if (f.life < best.life) best = f;
    }
    best.x = x; best.y = y; best.z = z; best.r = r; best.life = life; best.max = life;
  }

  shockwave(x, y, z, r) {
    let best = this.rings[0];
    for (let i = 0; i < this.rings.length; i++) if (this.rings[i].t > best.t) best = this.rings[i];
    best.x = x; best.y = y; best.z = z; best.r = r; best.t = 0;
    this.particles.sparkBurst(x, y + 0.5, z, 40, 18, 0.9, 0.5, 0.25, 1.0, 0.2);
    this.audio.play('boom', x, y, z, 1);
    this.input.haptic('both', 0.6, 200);
  }

  // ------------------------------------------------------------------- rig
  updateHead() {
    const cam = this.camera;
    if (this.input.xr) {
      this.rig.updateMatrixWorld();
      this.renderer.xr.updateCamera(cam);
      this.headLocal.copy(cam.position);
    } else {
      cam.position.set(0, 1.7, 0);
      cam.rotation.set(this.deskPitch, 0, 0, 'YXZ');
      this.headLocal.copy(cam.position);
      this.rig.updateMatrixWorld();
    }
    cam.updateMatrixWorld();
    cam.getWorldPosition(_headW);
    cam.getWorldDirection(_look);
    _up.set(0, 1, 0).applyQuaternion(cam.getWorldQuaternion(_q));
    _fwd.set(_look.x, 0, _look.z);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1).applyAxisAngle(UP, this.rig.rotation.y);
    _fwd.normalize();
    _right.crossVectors(_fwd, UP).normalize();
  }

  headOffset(out) {
    out.set(this.headLocal.x, 0, this.headLocal.z).applyAxisAngle(UP, this.rig.rotation.y);
    return out;
  }

  snapTurn(sign) {
    // The rig is re-placed from the body every frame, so changing yaw alone
    // keeps the head where it is; just don't count the offset change as walking.
    this.rig.rotation.y += -sign * FLIGHT.snapTurnDeg * Math.PI / 180;
    this.headOffset(this.lastOffset);
    this.snapPulse = 0.35;
  }

  attachGauntlets() {
    const input = this.input;
    // VR only: on desktop the crosshair is enough.
    const pl = input.xr ? input.gripObject('left') : null;
    const pr = input.xr ? input.gripObject('right') : null;
    if (pl !== this.gauntParentL) { if (pl) pl.add(this.gauntL); else this.gauntL.removeFromParent(); this.gauntParentL = pl; }
    if (pr !== this.gauntParentR) { if (pr) pr.add(this.gauntR); else this.gauntR.removeFromParent(); this.gauntParentR = pr; }
  }

  // ------------------------------------------------------------------ frame
  frame(dt) {
    const input = this.input;
    input.update();
    if (!input.xr) {
      if (this.state === 'playing') {
        this.rig.rotation.y += input.lookDX;
        this.deskPitch = Math.max(-1.45, Math.min(1.45, this.deskPitch + input.lookDY));
      }
      input.lookDX = 0; input.lookDY = 0;
    }
    this.handleMenu();
    if (this.state === 'playing' && input.snapTurn !== 0) this.snapTurn(input.snapTurn);
    if (input.vignettePressed) {
      this.options.vignette = !this.options.vignette;
      this.hud.showMessage('Comfort vignette', this.options.vignette ? 'ON' : 'OFF', 1.2);
    }
    this.updateHead();
    this.attachGauntlets();
    this.weapons.updateAim();

    // Room-scale steps move the capsule with the head. When entering / leaving
    // VR the offset jumps, so re-baseline instead of moving the body.
    this.headOffset(_v);
    if (input.xr !== this.wasXR) { this.lastOffset.copy(_v); this.wasXR = input.xr; }
    const dx = _v.x - this.lastOffset.x, dz = _v.z - this.lastOffset.z;
    this.lastOffset.copy(_v);
    this.body.pos.x += dx; this.body.pos.z += dz;
    this.body.prevPos.x += dx; this.body.prevPos.z += dz;

    if (this.state !== 'paused') {
      this.time += dt;
      U.uTime.value = this.time;
      this.physAcc += dt;
      let n = 0;
      while (this.physAcc >= this.step && n < FLIGHT.maxSubSteps) {
        this.fixed(this.step);
        this.physAcc -= this.step;
        n++;
      }
      if (n === FLIGHT.maxSubSteps) this.physAcc = 0;
    }
    const alpha = this.physAcc / this.step;
    // Interpolated rig placement.
    this.headOffset(_v);
    const b = this.body;
    this.rig.position.set(
      b.prevPos.x + (b.pos.x - b.prevPos.x) * alpha - _v.x,
      b.prevPos.y + (b.pos.y - b.prevPos.y) * alpha,
      b.prevPos.z + (b.pos.z - b.prevPos.z) * alpha - _v.z,
    );
    this.updateBank(dt);
    this.updateHead();
    this.weapons.updateAim();

    this.renderFrame(dt, alpha);
    cullChunks(this.city, _headW, WORLD.drawDistance);
  }

  handleMenu() {
    const input = this.input;
    const hud = this.hud;
    if (input.pausePressed && this.state !== 'dead') {
      this.state = this.state === 'paused' ? 'playing' : 'paused';
      hud.setMenu(this.state === 'paused');
      hud.menuIndex = 0;
      if (this.state === 'paused') hud.drawMenu();
      return;
    }
    if (this.state !== 'paused') return;
    if (input.menuStep !== 0) {
      const n = hud.menuItemCount();
      hud.menuIndex = (hud.menuIndex + input.menuStep + n) % n;
      hud.drawMenu();
    }
    if (input.confirmPressed) {
      const o = this.options;
      switch (hud.menuIndex) {
        case 0: this.state = 'playing'; hud.setMenu(false); break;
        case 1: o.vignette = !o.vignette; break;
        case 2: o.bank = !o.bank; break;
        case 3: o.debug = !o.debug; break;
        case 4: this.restart(); break;
        default: break;
      }
      if (this.state === 'paused') hud.drawMenu();
    }
  }

  fixed(dt) {
    const input = this.input;
    const si = this.stepInput;
    const alive = this.state === 'playing';
    // Boost meter.
    const wantBoost = alive && input.boost && this.boostMeter > 0.02 && input.grip > 0.05;
    if (wantBoost) {
      this.boostMeter = Math.max(0, this.boostMeter - FLIGHT.boostDrainPerSec * dt);
      this.boostIdle = 0;
    } else {
      this.boostIdle += dt;
      if (this.boostIdle > FLIGHT.boostRefillDelay) this.boostMeter = Math.min(1, this.boostMeter + FLIGHT.boostRefillPerSec * dt);
    }
    // Smooth the grip (analog triggers are noisy) and the thrust direction, so
    // glancing around doesn't yank the flight path.
    const rawGrip = alive && input.grip > FLIGHT.gripDeadzone ? input.grip : 0;
    this.gripSmooth += (rawGrip - this.gripSmooth) * Math.min(1, dt * FLIGHT.gripSmoothing);
    const lk = Math.min(1, dt * FLIGHT.lookSmoothing);
    _thrustLook.x += (_look.x - _thrustLook.x) * lk;
    _thrustLook.y += (_look.y - _thrustLook.y) * lk;
    _thrustLook.z += (_look.z - _thrustLook.z) * lk;
    _thrustLook.normalize();
    si.grip = this.gripSmooth;
    si.boost = wantBoost;
    si.stickX = alive ? input.stickX : 0;
    si.stickY = alive ? input.stickY : 0;
    this.prevVel.copy(this.body.vel);
    this.body.step(dt, si);
    const lat = ((this.body.vel.x - this.prevVel.x) * _right.x + (this.body.vel.z - this.prevVel.z) * _right.z) / dt;
    this.latAcc += (lat - this.latAcc) * Math.min(1, dt * 4);
    if (this.body.lastImpact > FLIGHT.impactHapticSpeed) {
      const k = Math.min(1, this.body.lastImpact / 30);
      input.haptic('both', 0.3 + 0.7 * k, 60 + 120 * k);
      this.audio.play('land', this.body.pos.x, this.body.pos.y, this.body.pos.z, 0.3 + 0.7 * k);
    }
    this.body.lastImpact = 0;

    if (alive) this.weapons.fixed(dt);
    else this.weapons.hands[0].down = this.weapons.hands[1].down = false;
    this.enemies.fixed(dt);
    this.bats.fixed(dt);
    this.debris.fixed(dt);
    if (alive) this.waves.fixed(dt);

    // Health regen / death sequence
    this.hurtTimer += dt;
    if (alive && this.hurtTimer > PLAYER.regenDelay) this.hp = Math.min(PLAYER.maxHp, this.hp + PLAYER.regenPerSec * dt);
    if (this.state === 'dead') {
      this.deathTimer += dt;
      this.hud.fade = Math.min(1, Math.max(0, (this.deathTimer - 1.5) / 1.5));
      if (this.deathTimer > 4) this.restart();
    }
    for (let i = 0; i < this.flashes.length; i++) if (this.flashes[i].life > 0) this.flashes[i].life -= dt;
    for (let i = 0; i < this.rings.length; i++) if (this.rings[i].t < 1) this.rings[i].t += dt / 0.7;
  }

  updateBank(dt) {
    let target = 0;
    if (this.options.bank && !this.body.grounded) {
      const sp = this.body.vel.length();
      const speedK = Math.min(1, sp / 30);
      target = Math.max(-FLIGHT.bankMax, Math.min(FLIGHT.bankMax, this.latAcc * FLIGHT.bankGain * sp * 0.1)) * speedK;
    }
    this.roll += (target - this.roll) * Math.min(1, dt * 3);
    // Roll about the view axis through the head so the eyes don't swing.
    const h = this.headLocal;
    _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    _v.y = 0;
    if (_v.lengthSq() < 1e-6) _v.set(0, 0, -1);
    _v.normalize();
    _q.setFromAxisAngle(_v, this.roll);
    this.bank.quaternion.copy(_q);
    _v2.copy(h).applyQuaternion(_q);
    this.bank.position.set(h.x - _v2.x, h.y - _v2.y, h.z - _v2.z);
  }

  // Enemy markers (drawn through walls): a glowing tag above goons in view,
  // and a pip at the edge of vision pointing toward goons outside it.
  renderMarkers() {
    if (this.state !== 'playing') return;
    const ov = this.overlaySprites;
    const head = _headW, look = _look;
    const cosIn = Math.cos(ENEMY.markerAngle * Math.PI / 180);
    const list = this.enemies.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.active) continue;
      const tx = e.pos.x, ty = e.pos.y + 2.4 * e.scale + 0.6, tz = e.pos.z;
      const dx = tx - head.x, dy = ty - head.y, dz = tz - head.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 10) continue;
      const c = (dx * look.x + dy * look.y + dz * look.z) / d;
      const r = e.boss ? 1.0 : 1.0, gg = e.boss ? 0.15 : 0.55, b = e.boss ? 0.1 : 0.12;
      const pulse = 0.75 + 0.25 * Math.sin(this.time * 6 + i);
      if (c > cosIn) {
        const size = d * (e.boss ? 0.016 : 0.011);
        ov.pushPoint(tx, ty, tz, size, r, gg, b, 0.85 * pulse, 0.5);
      } else {
        // direction perpendicular to the view axis, placed on a 35 deg ring
        let px = dx / d - look.x * c, py = dy / d - look.y * c, pz = dz / d - look.z * c;
        const pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
        px /= pl; py /= pl; pz /= pl;
        const R = 1.2;
        ov.pushPoint(head.x + (look.x * 0.82 + px * 0.57) * R, head.y + (look.y * 0.82 + py * 0.57) * R,
          head.z + (look.z * 0.82 + pz * 0.57) * R, e.boss ? 0.03 : 0.018, 1.0, 0.25, 0.12, 0.9 * pulse, 0.5);
      }
    }
  }

  renderFrame(dt, alpha) {
    const sp = this.sprites;
    sp.begin();
    this.overlaySprites.begin();
    const gr = this.goonRenderer;
    gr.begin();
    this.enemies.render(gr, dt, alpha);
    this.debris.render(gr, alpha);
    this.bats.render(gr, alpha);
    gr.end();
    this.weapons.render(dt, alpha);
    this.renderMarkers();
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      if (f.life <= 0) continue;
      const k = f.life / f.max;
      sp.pushPoint(f.x, f.y, f.z, f.r * (1.3 - 0.3 * k), 0.5, 0.8, 1.0, k, 0.5);
    }
    for (let i = 0; i < this.rings.length; i++) {
      const w = this.rings[i];
      if (w.t >= 1) continue;
      const rad = w.r * (0.15 + 0.85 * Math.sqrt(w.t));
      const a = 1 - w.t;
      const N = 28;
      for (let s = 0; s < N; s++) {
        const a0 = (s / N) * Math.PI * 2, a1 = ((s + 1) / N) * Math.PI * 2;
        sp.push(w.x + Math.cos(a0) * rad, w.y, w.z + Math.sin(a0) * rad, w.x + Math.cos(a1) * rad, w.y, w.z + Math.sin(a1) * rad,
          1.2 + 1.5 * a, 1.0, 0.45, 0.15, a, 0.25);
      }
    }
    sp.end();
    this.overlaySprites.end();
    this.particles.frame(this.time);

    // Comfort vignette: speed + turning + snap turns.
    const speed = this.body.vel.length();
    this.snapPulse = Math.max(0, this.snapPulse - dt);
    let vig = Math.min(1, Math.max(0, (speed - 6) / 40)) * 0.65 + Math.min(1, Math.abs(this.latAcc) / 30) * 0.35;
    vig = Math.max(vig, this.snapPulse * 2);
    if (this.body.grounded && speed < 4) vig = 0;
    this.hud.vignette += (Math.min(1, vig) - this.hud.vignette) * Math.min(1, dt * 5);
    this.hud.frame(dt);

    this.audioTimer -= dt;
    if (this.audioTimer <= 0) {
      this.audioTimer = 1 / 15;
      const grip = this.state === 'playing' ? this.input.grip : 0;
      this.audio.update(_headW, _look, _up, speed, grip, this.stepInput.boost);
    }
  }
}
