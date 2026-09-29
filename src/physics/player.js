import { Vector3 } from 'three';
import { FLIGHT } from '../config.js';

const _dir = new Vector3();
const _acc = new Vector3();

// Thrust direction model:
//  * light squeeze (below FLIGHT.tiltStart) pushes straight up -> stable hover
//  * squeezing harder tilts the thrust vector toward where the head looks,
//    up to lookDir * thrustForwardGain + up * thrustUpBias at full grip.
// Looking down at full grip therefore dives, looking up climbs.
export function computeThrust(grip, look, boost, out) {
  const g = Math.pow(Math.min(Math.max(grip, 0), 1), FLIGHT.gripCurve);
  if (g <= 0) return out.set(0, 0, 0);
  const t = Math.min(Math.max((g - FLIGHT.tiltStart) / (1 - FLIGHT.tiltStart), 0), 1);
  const tilt = t * t * (3 - 2 * t) * FLIGHT.thrustForwardGain;
  _dir.set(look.x * tilt, look.y * tilt + FLIGHT.thrustUpBias, look.z * tilt);
  const len = _dir.length();
  if (len < 1e-5) _dir.set(look.x, look.y, look.z); // pure-down dive
  else _dir.multiplyScalar(1 / len);
  return out.copy(_dir).multiplyScalar(g * FLIGHT.thrustMax * (boost ? FLIGHT.boostMult : 1));
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
