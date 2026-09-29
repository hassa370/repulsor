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
  }

  reset(x, y, z) {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
    this.vel.set(0, 0, 0);
  }

  impulse(x, y, z) {
    this.vel.x += x; this.vel.y += y; this.vel.z += z;
  }

  // input: { grip, boost, look (Vector3), stickX, stickY, right (Vector3 flat), fwd (Vector3 flat) }
  step(dt, input) {
    this.prevPos.copy(this.pos);
    const v = this.vel;
    const thrust = computeThrust(input.grip, input.look, input.boost, _acc);
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
    const sp = v.length();
    const drag = FLIGHT.dragQuadratic * sp + FLIGHT.dragLinear;
    acc.x -= v.x * drag; acc.y -= v.y * drag; acc.z -= v.z * drag;

    v.x += acc.x * dt; v.y += acc.y * dt; v.z += acc.z * dt;

    if (!flying) {
      // Walking on a roof / street: stick sets a target horizontal velocity.
      const tx = (input.right.x * sx + input.fwd.x * sy) * FLIGHT.walkSpeed;
      const tz = (input.right.z * sx + input.fwd.z * sy) * FLIGHT.walkSpeed;
      const f = Math.min(1, FLIGHT.groundFriction * dt);
      v.x += (tx - v.x) * f;
      v.z += (tz - v.z) * f;
    }

    this.pos.x += v.x * dt; this.pos.y += v.y * dt; this.pos.z += v.z * dt;

    const c = this.collision;
    c.collideCapsule(this.pos, v, FLIGHT.capsuleRadius, FLIGHT.capsuleHeight, FLIGHT.restitution, FLIGHT.wallFriction);
    this.grounded = c.grounded;
    if (c.impactSpeed > this.lastImpact) this.lastImpact = c.impactSpeed;
  }
}
