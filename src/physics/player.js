import { Vector3 } from 'three';
import { FLIGHT } from '../config.js';

const _dir = new Vector3();
const _acc = new Vector3();

// Thrust model (grip g in 0..1):
//  * 0 .. hoverLo        : lift ramps up to exactly the hover level (gentle descent)
//  * hoverLo .. hoverHi  : hover PLATEAU: thrust == gravity, straight up, so a wide
//                          range of finger pressure holds you steady in the air
//  * hoverHi .. 1        : more power, and the thrust vector tilts toward where
//                          the head looks (look down = dive, look up = climb)
export function computeThrust(grip, look, boost, out) {
  const g = Math.pow(Math.min(Math.max(grip, 0), 1), FLIGHT.gripCurve);
  if (g <= 0) return out.set(0, 0, 0);
  const hover = FLIGHT.gravity / FLIGHT.thrustMax;
  const lo = FLIGHT.hoverLo, hi = FLIGHT.hoverHi;
  let f, t = 0;
  if (g < lo) f = hover * (g / lo);
  else if (g <= hi) f = hover;
  else {
    t = (g - hi) / (1 - hi);
    f = hover + (1 - hover) * t;
  }
  const tilt = t * t * (3 - 2 * t) * FLIGHT.thrustForwardGain;
  _dir.set(look.x * tilt, look.y * tilt + FLIGHT.thrustUpBias, look.z * tilt);
  const len = _dir.length();
  if (len < 1e-5) _dir.set(look.x, look.y, look.z); // pure-down dive
  else _dir.multiplyScalar(1 / len);
  return out.copy(_dir).multiplyScalar(f * FLIGHT.thrustMax * (boost ? FLIGHT.boostMult : 1));
}

// Smash events produced during a step (consumed by the game for FX).
export const SMASH_ENTER = 1, SMASH_EXIT = 2, SMASH_GROUND = 3;

export class PlayerBody {
  constructor(collision) {
    this.collision = collision;
    this.pos = new Vector3(); // feet position, horizontally under the head
    this.prevPos = new Vector3();
    this.vel = new Vector3();
    this.grounded = false;
    this.lastImpact = 0; // m/s of the last impact (read + clear by the game)
    this.accel = new Vector3(); // last applied acceleration (for banking)
    this.thrustAccel = 0;
    // up to 4 smash events per step: type, x, y, z, nx, ny, nz, speed, box
    this.events = new Float32Array(4 * 9);
    this.eventCount = 0;
    this.smashAge = new Float32Array(4);
    this.smashIn = new Uint8Array(4);
  }

  reset(x, y, z) {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.collision.ignore.fill(-1);
  }

  impulse(x, y, z) {
    this.vel.x += x; this.vel.y += y; this.vel.z += z;
  }

  _event(type, x, y, z, nx, ny, nz, sp, box = -1) {
    if (this.eventCount >= 4) return;
    const e = this.events, o = this.eventCount++ * 9;
    e[o] = type; e[o + 1] = x; e[o + 2] = y; e[o + 3] = z;
    e[o + 4] = nx; e[o + 5] = ny; e[o + 6] = nz; e[o + 7] = sp; e[o + 8] = box;
  }

  // input: { grip, boost, look, stickX, stickY, right, fwd,
  //          handMode, handThrust (Vector3 accel from both hand repulsors) }
  step(dt, input) {
    this.prevPos.copy(this.pos);
    const v = this.vel;
    const thrust = input.handMode ? _acc.copy(input.handThrust) : computeThrust(input.grip, input.look, input.boost, _acc);
    this.thrustAccel = thrust.length();
    const acc = this.accel.copy(thrust);
    acc.y -= FLIGHT.gravity;

    const flying = !this.grounded || thrust.y > FLIGHT.gravity * 0.8;
    const sx = input.stickX, sy = input.stickY;
    if (flying) {
      const s = FLIGHT.strafeAccel * (input.boost ? 1.5 : 1);
      acc.x += (input.right.x * sx + input.fwd.x * sy) * s;
      acc.z += (input.right.z * sx + input.fwd.z * sy) * s;
    }

    // Air brake: hovering (light grip, stick centred) bleeds off horizontal drift
    // so you can stop and hold position to aim.
    if (input.grip > 0.05 && input.grip < FLIGHT.hoverHi + 0.05 && Math.abs(sx) + Math.abs(sy) < 0.1 && !input.boost) {
      const k = Math.min(1, FLIGHT.airBrake * dt);
      v.x -= v.x * k; v.z -= v.z * k;
    }
    // Hover assist: when thrust roughly cancels gravity, bleed off vertical velocity.
    const netY = acc.y;
    if (input.grip > 0.05 && Math.abs(netY) < FLIGHT.hoverWindow) {
      const k = 1 - Math.abs(netY) / FLIGHT.hoverWindow;
      v.y -= v.y * Math.min(1, FLIGHT.hoverAssist * k * dt);
    }

    // Quadratic + linear drag.
    let sp = v.length();
    const drag = FLIGHT.dragQuadratic * sp + FLIGHT.dragLinear;
    acc.x -= v.x * drag; acc.y -= v.y * drag; acc.z -= v.z * drag;

    v.x += acc.x * dt; v.y += acc.y * dt; v.z += acc.z * dt;

    // Fly where you look: while thrusting in the air, the velocity vector
    // bends toward the head direction (speed is kept, only direction turns).
    sp = v.length();
    if (input.handMode && !this.grounded && sp > 4 && this.thrustAccel > 3) {
      const L = input.look;
      const d = (v.x * L.x + v.y * L.y + v.z * L.z) / sp;
      if (d > -0.3) {
        const k = Math.min(1, FLIGHT.gazeSteer * Math.min(1, this.thrustAccel / 15) * dt);
        _dir.set(v.x / sp + (L.x - v.x / sp) * k, v.y / sp + (L.y - v.y / sp) * k, v.z / sp + (L.z - v.z / sp) * k).normalize();
        v.x = _dir.x * sp; v.y = _dir.y * sp; v.z = _dir.z * sp;
      }
    }

    if (!flying) {
      // Walking on a roof / street: stick sets a target horizontal velocity.
      const tx = (input.right.x * sx + input.fwd.x * sy) * FLIGHT.walkSpeed;
      const tz = (input.right.z * sx + input.fwd.z * sy) * FLIGHT.walkSpeed;
      const f = Math.min(1, FLIGHT.groundFriction * dt);
      v.x += (tx - v.x) * f;
      v.z += (tz - v.z) * f;
    }

    const c = this.collision;
    const R = FLIGHT.capsuleRadius, H = FLIGHT.capsuleHeight;
    // Omni-Man: fast enough into a wall -> punch through it instead of bouncing.
    if (sp > FLIGHT.smashSpeed * 0.7) {
      const cy = this.pos.y + H * 0.5;
      const reach = sp * dt + R + 0.3;
      const t = c.raycast(this.pos.x, cy, this.pos.z, v.x / sp, v.y / sp, v.z / sp, reach, true);
      if (t < reach && c.hitBox >= 0) {
        const n = c.hitNormal;
        const into = -(v.x * n[0] + v.y * n[1] + v.z * n[2]);
        if (into > FLIGHT.smashSpeed) {
          const hb = c.hitBox;
          c.addIgnore(hb);
          v.multiplyScalar(FLIGHT.smashKeep);
          this._event(SMASH_ENTER, this.pos.x + v.x / sp * t, cy + v.y / sp * t, this.pos.z + v.z / sp * t, n[0], n[1], n[2], into, hb);
        }
      }
    }

    this.pos.x += v.x * dt; this.pos.y += v.y * dt; this.pos.z += v.z * dt;

    // Leaving a smashed box: exit hole on the far side.
    const ig = c.ignore;
    const cyNow = this.pos.y + H * 0.5;
    for (let k = 0; k < 4; k++) {
      const i = ig[k];
      if (i < 0) { this.smashAge[k] = 0; this.smashIn[k] = 0; continue; }
      this.smashAge[k] += dt;
      if (c.insideBox(i, this.pos.x, cyNow, this.pos.z, 0)) { this.smashIn[k] = 1; continue; }
      if (!this.smashIn[k]) {
        // not through the wall yet; give up if we stalled before getting in
        if (this.smashAge[k] > 0.4) ig[k] = -1;
        continue;
      }
      if (!c.insideBox(i, this.pos.x, cyNow, this.pos.z, R)) {
        const b = c.boxes, o = i * 6;
        let nx = 0, ny = 0, nz = 0;
        const x = this.pos.x, z = this.pos.z;
        if (x > b[o + 3]) nx = 1; else if (x < b[o]) nx = -1;
        else if (z > b[o + 5]) nz = 1; else if (z < b[o + 2]) nz = -1;
        else if (cyNow > b[o + 4]) ny = 1; else ny = -1;
        const px = nx > 0 ? b[o + 3] : nx < 0 ? b[o] : x;
        const pz = nz > 0 ? b[o + 5] : nz < 0 ? b[o + 2] : z;
        const py = ny > 0 ? b[o + 4] : cyNow;
        this._event(SMASH_EXIT, px, py, pz, nx, ny, nz, v.length(), i);
        ig[k] = -1;
        this.smashIn[k] = 0;
      }
    }

    const vyBefore = v.y;
    c.collideCapsule(this.pos, v, R, H, FLIGHT.restitution, FLIGHT.wallFriction);
    this.grounded = c.grounded;
    if (c.impactSpeed > this.lastImpact) this.lastImpact = c.impactSpeed;
    // Superhero landing: slam into the ground / a roof from high speed.
    if (c.grounded && -vyBefore > FLIGHT.craterSpeed) {
      this._event(SMASH_GROUND, this.pos.x, this.pos.y, this.pos.z, 0, 1, 0, -vyBefore);
    }
  }
}
