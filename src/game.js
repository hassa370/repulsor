import { Group, Quaternion, Vector3 } from 'three';
import { ENEMY, FLIGHT, PLAYER, WEAPONS, WORLD } from './config.js';
import { PlayerBody, SMASH_ENTER, SMASH_EXIT, SMASH_GROUND, computeThrust } from './physics/player.js';
import { Decals } from './fx/decals.js';
import { Destruction } from './world/destruction.js';
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
import { Gauntlet, NanoGauntlet, makeFallbackGauntlet } from './hud/hands.js';
import { DEFAULT_SUIT_SOCKETS, SuitRig } from './player/suit.js';

const _v = new Vector3();
const _v2 = new Vector3();
const _q = new Quaternion();
const _look = new Vector3();
const _thrustLook = new Vector3(0, 0, -1);
const _handThrust = new Vector3();
const _vdir = new Vector3();
const _right = new Vector3();
const _fwd = new Vector3();
const _headW = new Vector3();
const _up = new Vector3();
const _fxA = new Vector3();
const _fxB = new Vector3();
const UP = new Vector3(0, 1, 0);

class Flash {
  constructor() { this.x = 0; this.y = 0; this.z = 0; this.r = 0; this.life = 0; this.max = 1; this.cr = 0.5; this.cg = 0.8; this.cb = 1; }
}
class Wave3D {
  constructor() { this.x = 0; this.y = 0; this.z = 0; this.r = 0; this.t = 1; }
}

// Owns the player rig, fixed-step simulation and per-frame orchestration.
export class Game {
  constructor({ renderer, scene, camera, input, collision, city, perf, audio, goonAssets, handModels, suitSockets }) {
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
      grip: 0, boost: false, handMode: false, handThrust: _handThrust, look: _thrustLook, stickX: 0, stickY: 0, right: _right, fwd: _fwd,
    };
    this.options = { vignette: true, bank: FLIGHT.bankEnabled, debug: false, flightMode: FLIGHT.flightMode };
    // Hand repulsor thrusters: world thrust direction per hand (from the controller pose).
    this.handDir = [new Vector3(), new Vector3()];
    this.handOk = [false, false];
    this.handGrip = [0, 0];
    // Palm repulsor sockets in world space, read once per update from each
    // gauntlet's repulsorSocket: the one origin for blasts, charge FX and exhaust.
    this.palmPos = [new Vector3(), new Vector3()];
    this.palmDir = [new Vector3(), new Vector3()]; // out of the palm
    this.palmOk = [false, false];
    // Boost: direction the boots push along (physics-owned) and their thrust (m/s^2).
    this.boostDir = new Vector3(0, 0, -1);
    this.bootThrust = 0;
    this.bootFx = 0; // smoothed 0..1 for visuals

    // Systems
    this.sprites = new SpriteBatch(640);
    scene.add(this.sprites.mesh);
    this.overlaySprites = new SpriteBatch(200, { depthTest: false, renderOrder: 999 });
    scene.add(this.overlaySprites.mesh);
    this.particles = new Particles(scene);
    this.decals = new Decals(scene);
    this.destruction = new Destruction(this, city);
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
    // Iron Man gauntlets on a real skinned hand (fallback: simple armour block).
    // Preference: Nano Gauntlet model > armoured skinned hand > simple block.
    const mkHand = (side) => {
      if (handModels && handModels.nano) return new NanoGauntlet(side, handModels.nano);
      if (handModels && handModels.left) return new Gauntlet(side, side < 0 ? handModels.left : handModels.right);
      return makeFallbackGauntlet();
    };
    this.gauntL = mkHand(-1);
    this.gauntR = mkHand(1);
    this.gauntParentL = null;
    this.gauntParentR = null;
    // Suit rig (boot thruster sockets) in head/controller space.
    this.suit = new SuitRig(this.inner, suitSockets || DEFAULT_SUIT_SOCKETS);

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
    this.decals.clear();
    this.destruction.restoreAll();
    this.waves.reset();
    this.hp = PLAYER.maxHp;
    this.score = 0;
    this.wave = 0;
    this.state = 'playing';
    this.hud.fade = 0;
    this.hud.setMenu(false);
    this.respawn();
    this.hud.showMessage('REPULSOR', this.renderer.xr.isPresenting && this.options.flightMode === 'hands'
      ? 'Grips fire palm thrusters · palms DOWN to lift · look where you fly'
      : 'Squeeze LEFT GRIP to fly · triggers to fire', 5);
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

  flashAt(x, y, z, r, life, cr = 0.5, cg = 0.8, cb = 1.0) {
    let best = this.flashes[0];
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      if (f.life <= 0) { best = f; break; }
      if (f.life < best.life) best = f;
    }
    best.x = x; best.y = y; best.z = z; best.r = r; best.life = life; best.max = life;
    best.cr = cr; best.cg = cg; best.cb = cb;
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
    // Gauntlets ride the pointing pose so the palm repulsor faces where the
    // controller points (that's where shots and thrust exhaust come out).
    const il = input.xr ? input.hand('left') : -1, ir = input.xr ? input.hand('right') : -1;
    const pl = il < 0 ? null : input.controllers[il];
    const pr = ir < 0 ? null : input.controllers[ir];
    if (pl !== this.gauntParentL) { if (pl) pl.add(this.gauntL.object); else this.gauntL.object.removeFromParent(); this.gauntParentL = pl; }
    if (pr !== this.gauntParentR) { if (pr) pr.add(this.gauntR.object); else this.gauntR.object.removeFromParent(); this.gauntParentR = pr; }
  }

  // World pose of each palm repulsor socket (only when its gauntlet is shown).
  updatePalmSockets() {
    for (let h = 0; h < 2; h++) {
      const g = h === 0 ? this.gauntL : this.gauntR;
      const ok = !!g.object.parent && !!g.getRepulsorWorldPosition;
      this.palmOk[h] = ok;
      if (!ok) continue;
      g.getRepulsorWorldPosition(this.palmPos[h]);
      g.getRepulsorWorldDirection(this.palmDir[h]);
    }
  }

  // Body under the head, yaw following the head; legs swing back while boosting.
  updateSuit(dt) {
    const cam = this.camera;
    _v.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this.bootFx += ((this.stepInput.boost ? 1 : 0) - this.bootFx) * Math.min(1, dt * 10);
    this.suit.update(dt, cam.position, Math.atan2(-_v.x, -_v.z), this.bootFx);
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
    this.updatePalmSockets();
    this.weapons.updateAim();
    this.updateHandThrusters();

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
    this.updateSuit(dt);
    this.updatePalmSockets();
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
        case 1: o.flightMode = o.flightMode === 'hands' ? 'gaze' : 'hands'; break;
        case 2: o.vignette = !o.vignette; break;
        case 3: o.bank = !o.bank; break;
        case 4: o.debug = !o.debug; break;
        case 5: this.restart(); break;
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
    const handMode = input.xr && this.options.flightMode === 'hands';
    const anyGrip = handMode ? Math.max(input.gripL, input.gripR) : input.grip;
    const wantBoost = alive && input.boost && this.boostMeter > 0.02 && anyGrip > 0.05;
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
    si.handMode = handMode;
    _handThrust.set(0, 0, 0);
    if (handMode) {
      // Each grip fires that hand's repulsor, pushing you away from the palm.
      const kg = Math.min(1, dt * FLIGHT.gripSmoothing);
      let gmax = 0;
      for (let h = 0; h < 2; h++) {
        const raw = alive && this.handOk[h] ? (h === 0 ? input.gripL : input.gripR) : 0;
        const gr = raw > FLIGHT.gripDeadzone ? raw : 0;
        this.handGrip[h] += (gr - this.handGrip[h]) * kg;
        _handThrust.addScaledVector(this.handDir[h], this.handGrip[h] * FLIGHT.handThrustMax);
        if (this.handGrip[h] > gmax) gmax = this.handGrip[h];
      }
      // Boost: the palms push harder and the boot thrusters add the rest along
      // the combined hand thrust, so the total stays handThrust * boostMult.
      const handMag = _handThrust.length();
      if (handMag > 1e-3) this.boostDir.copy(_handThrust).multiplyScalar(1 / handMag);
      if (wantBoost) {
        this.bootThrust = handMag * (FLIGHT.boostMult - FLIGHT.boostHandMult);
        _handThrust.multiplyScalar(FLIGHT.boostHandMult).addScaledVector(this.boostDir, this.bootThrust);
      } else {
        this.bootThrust = 0;
      }
      si.grip = gmax;
    } else {
      this.handGrip[0] = this.handGrip[1] = 0;
      // Gaze flight (desktop / gaze mode): the body applies the boost itself;
      // the boots just show it, along the same thrust direction.
      computeThrust(this.gripSmooth, _thrustLook, false, _v);
      const m = _v.length();
      if (m > 1e-3) this.boostDir.copy(_v).multiplyScalar(1 / m);
      this.bootThrust = wantBoost ? m * (FLIGHT.boostMult - 1) : 0;
    }
    si.boost = wantBoost;
    si.stickX = alive ? input.stickX : 0;
    si.stickY = alive ? input.stickY : 0;
    this.prevVel.copy(this.body.vel);
    this.body.eventCount = 0;
    this.body.step(dt, si);
    for (let k = 0; k < this.body.eventCount; k++) {
      const e = this.body.events, o = k * 9;
      this.onSmash(e[o], e[o + 1], e[o + 2], e[o + 3], e[o + 4], e[o + 5], e[o + 6], e[o + 7], e[o + 8]);
    }
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

  // World pose of each hand's repulsor: thrust points away from the palm.
  // Grip space +X is the back of the right hand / the palm side of the left.
  // Each controller is a thruster nozzle: its repulsor fires out of the palm
  // along where the controller points, so the push is the OPPOSITE way.
  // Point your hands back -> fly forward; point forward -> brake / go back;
  // point down -> lift. (FLIGHT.thrustAxis 'palm' keeps the older palm-side axis.)
  updateHandThrusters() {
    const input = this.input;
    for (let h = 0; h < 2; h++) {
      const name = h === 0 ? 'left' : 'right';
      const idx = input.xr ? input.hand(name) : -1;
      const obj = idx < 0 ? null : FLIGHT.thrustAxis === 'palm' ? input.grips[idx] : input.controllers[idx];
      this.handOk[h] = !!obj;
      if (!obj) continue;
      const e = obj.matrixWorld.elements;
      if (FLIGHT.thrustAxis === 'palm') {
        const s = (h === 0 ? -1 : 1) * FLIGHT.palmSign;
        this.handDir[h].set(e[0] * s, e[1] * s, e[2] * s).normalize();
      } else {
        this.handDir[h].set(e[8], e[9], e[10]).normalize(); // +Z = opposite of pointing
      }
    }
  }

  // Omni-Man impacts: punching into / out of a building, or cratering the ground.
  onSmash(type, x, y, z, nx, ny, nz, speed, box) {
    const p = this.particles;
    const k = Math.min(1, speed / 60);
    if (type === SMASH_GROUND) {
      this.shockwave(x, y + 0.2, z, FLIGHT.craterRadius * (0.6 + 0.4 * k));
      p.concreteBurst(x, y + 0.3, z, 0, 1, 0, 40, 14 * (0.6 + k));
      for (let i = 0; i < 8; i++) {
        const a = i * 0.785;
        p.puff(x + Math.cos(a) * 3, y + 1, z + Math.sin(a) * 3, Math.cos(a) * 10, 1.5, Math.sin(a) * 10, 12, 0.5, 0.46, 0.42, 3.5);
      }
      this.decals.add(this.time, x, y + 0.02, z, 0, 1, 0, 7 + 5 * k);
      // Superhero landing hurts anything nearby.
      const list = this.enemies.list;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e.active) continue;
        const dx = e.pos.x - x, dz = e.pos.z - z, dy = e.pos.y - y;
        const d = Math.hypot(dx, dz);
        if (d < FLIGHT.craterRadius && Math.abs(dy) < 6) {
          const f = 1 - d / FLIGHT.craterRadius;
          if (this.enemies.damage(e, Math.ceil(3 * f + 0.5), dx / (d || 1), 0.8, dz / (d || 1), false)) this.hitMarker(false, true);
        }
      }
      this.input.haptic('both', 1, 250);
      this.snapPulse = 0.5;
      return;
    }
    // Building wall: debris sprays out of the face (entry: back toward us, exit: onward).
    p.concreteBurst(x, y, z, nx, ny, nz, type === SMASH_ENTER ? 45 : 35, 10 + 12 * k);
    p.sparkBurst(x, y, z, 14, 10, 1.0, 0.6, 0.3, 0.5, 0.5);
    p.puff(x, y, z, nx * 6, 1, nz * 6, 10, 0.5, 0.47, 0.43, 3);
    this.decals.add(this.time, x, y, z, nx, ny, nz, 5 + 3 * k);
    this.flashAt(x, y, z, 3, 0.18);
    this.audio.play('boom', x, y, z, 0.7 + 0.3 * k);
    this.audio.play('crack', x, y, z, 1);
    this.input.haptic('both', 1, 140);
    this.snapPulse = Math.max(this.snapPulse, 0.3);
    if (type === SMASH_ENTER) {
      this.addScore(25);
      this.destruction.damageBox(box, WEAPONS.buildingDamageSmash);
    }
  }

  // Head-locked crosshair + flight-path marker (where you are actually going).
  renderFlightHud() {
    const ov = this.overlaySprites;
    const h = _headW, L = _look;
    const D = 4;
    const cx = h.x + L.x * D, cy = h.y + L.y * D, cz = h.z + L.z * D;
    // crosshair: centre dot + 4 ticks with a gap
    _v.set(0, 1, 0).applyQuaternion(this.camera.getWorldQuaternion(_q));
    _v2.crossVectors(L, _v).normalize();
    const gap = 0.07, len = 0.1, w = 0.011;
    ov.pushPoint(cx, cy, cz, 0.022, 0.8, 0.95, 1.0, 0.9, 0.6);
    for (let i = 0; i < 4; i++) {
      const ax = i < 2 ? _v2 : _v;
      const sgn = i % 2 === 0 ? 1 : -1;
      ov.push(cx + ax.x * gap * sgn, cy + ax.y * gap * sgn, cz + ax.z * gap * sgn,
        cx + ax.x * (gap + len) * sgn, cy + ax.y * (gap + len) * sgn, cz + ax.z * (gap + len) * sgn, w, 0.7, 0.9, 1.0, 0.8, 0.6);
    }
    // flight-path marker: circle with wings along the velocity direction
    const v = this.body.vel;
    const sp = v.length();
    if (sp < 3 || this.body.grounded) return;
    _vdir.copy(v).multiplyScalar(1 / sp);
    if (_vdir.dot(L) < 0.2) return; // moving backward / sideways out of view
    const px = h.x + _vdir.x * D, py = h.y + _vdir.y * D, pz = h.z + _vdir.z * D;
    const r = 0.1;
    const cr = 0.15, cg = 1.0, cb = 0.35, al = Math.min(1, sp / 15);
    for (let i = 0; i < 10; i++) {
      const a0 = (i / 10) * Math.PI * 2, a1 = ((i + 1) / 10) * Math.PI * 2;
      const c0 = Math.cos(a0) * r, s0 = Math.sin(a0) * r, c1 = Math.cos(a1) * r, s1 = Math.sin(a1) * r;
      ov.push(px + _v2.x * c0 + _v.x * s0, py + _v2.y * c0 + _v.y * s0, pz + _v2.z * c0 + _v.z * s0,
        px + _v2.x * c1 + _v.x * s1, py + _v2.y * c1 + _v.y * s1, pz + _v2.z * c1 + _v.z * s1, 0.011, cr, cg, cb, al, 0.25);
    }
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      ov.push(px + _v2.x * r * sgn, py + _v2.y * r * sgn, pz + _v2.z * r * sgn,
        px + _v2.x * r * 2.4 * sgn, py + _v2.y * r * 2.4 * sgn, pz + _v2.z * r * 2.4 * sgn, 0.011, cr, cg, cb, al, 0.25);
    }
    ov.push(px + _v.x * r, py + _v.y * r, pz + _v.z * r, px + _v.x * r * 2, py + _v.y * r * 2, pz + _v.z * r * 2, 0.011, cr, cg, cb, al, 0.25);
  }

  // Hands open flat (Iron Man style) while thrusting or firing, relax otherwise;
  // the palm repulsor brightens with thrust, charge and muzzle flashes.
  animateGauntlets(dt) {
    const gaze = !this.stepInput.handMode;
    for (let h = 0; h < 2; h++) {
      const g = h === 0 ? this.gauntL : this.gauntR;
      if (!g.object.parent) continue;
      const wh = this.weapons.hands[h];
      const thrust = gaze ? (h === 0 ? this.gripSmooth : 0) : this.handGrip[h];
      const charge = wh.down ? Math.min(1, wh.held) : 0;
      const firing = wh.down || wh.flash > 0 ? 1 : 0;
      const open = Math.min(1, thrust * 3 + firing);
      const glow = thrust * 1.8 + charge * 1.5 + (wh.flash > 0 ? 3 : 0) + (this.stepInput.boost ? 1.4 * this.handGrip[h] + 0.4 : 0);
      g.update(dt, open, glow);
    }
  }

  // Exhaust FX. Palms: out of each palm repulsor socket while its grip is
  // squeezed, opposite that hand's thrust. Boots: out of the boot sockets while
  // boosting, opposite the boost direction. Physics decides every direction.
  renderThrusters() {
    const boosting = this.stepInput.boost;
    for (let h = 0; h < 2; h++) {
      const g = this.handGrip[h];
      if (!this.handOk[h] || !this.palmOk[h] || g < 0.03) continue;
      // exhaust leaves opposite to the thrust, starting on the repulsor disc
      _fxA.copy(this.handDir[h]).negate();
      this.jet(this.palmPos[h], _fxA, g * (boosting ? 1.35 : 1), false, h * 5);
    }
    const k = this.bootFx;
    if (k > 0.02) {
      const g = Math.max(0.35, this.stepInput.grip);
      _fxA.copy(this.boostDir).negate();
      this.suit.getLeftBootWorldPosition(_fxB);
      this.jet(_fxB, _fxA, g * k, true, 11);
      this.suit.getRightBootWorldPosition(_fxB);
      this.jet(_fxB, _fxA, g * k, true, 17);
    }
  }

  // One thruster flame: tight hot core at the nozzle p, widening and cooling
  // along the exhaust direction d. boot = the bigger, bluer-cored boot jet.
  jet(p, d, power, boot, seed) {
    const sp = this.sprites;
    const n = boot ? 8 : 6;
    const L = boot ? 0.7 + 1.5 * power : 0.2 + 0.55 * power;
    const r0 = boot ? 0.06 + 0.05 * power : 0.03 + 0.035 * power;
    const t = this.time * 30 + seed;
    const fade = Math.min(1, power * 3);
    for (let k = 0; k < n; k++) {
      const f = k / (n - 1);
      const dist = 0.004 + L * f;
      const r = r0 * (1 + 2.2 * f) * (1 - 0.55 * f) * (0.85 + 0.15 * Math.sin(t + k * 1.7));
      const cg = boot ? 0.85 - 0.5 * f : 0.8 - 0.45 * f;
      const cb = boot ? 0.7 - 0.62 * f : 0.4 - 0.35 * f;
      sp.pushPoint(p.x + d.x * dist, p.y + d.y * dist, p.z + d.z * dist, r,
        1.0, cg, cb, (1.0 - 0.55 * f) * fade, k === 0 ? 0.55 : 0.2);
    }
    // hot nozzle glow sitting on the socket
    sp.pushPoint(p.x, p.y, p.z, r0 * 0.9, 0.85, 0.95, 1.0, 0.85 * fade, 0.8);
    if (Math.random() < power * (boot ? 1.5 : 1)) {
      const s = boot ? 9 : 5;
      this.particles.ember(p.x + d.x * 0.05, p.y + d.y * 0.05, p.z + d.z * 0.05,
        d.x * s + (Math.random() - 0.5), d.y * s + (Math.random() - 0.5), d.z * s + (Math.random() - 0.5), 1.0, 0.5, 0.1, 0.35);
    }
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
    if (this.state === 'playing') this.renderFlightHud();
    this.renderThrusters();
    this.animateGauntlets(dt);
    this.destruction.frame(dt);
    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      if (f.life <= 0) continue;
      const k = f.life / f.max;
      sp.pushPoint(f.x, f.y, f.z, f.r * (1.3 - 0.3 * k), f.cr, f.cg, f.cb, k, 0.5);
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
      const hm = this.stepInput.handMode;
      const grip = this.state !== 'playing' ? 0 : hm ? Math.max(this.handGrip[0], this.handGrip[1]) : this.input.grip;
      this.audio.update(_headW, _look, _up, speed, grip, this.stepInput.boost);
    }
  }
}
