import { Quaternion, Vector3 } from 'three';
import { ORIGIN } from '../../config.js';

// Coordinate frames (all CPU maths in float64 JS numbers; only GPU uploads are float32):
//
//   G  global, planet-centric. Home planet centre = (0, 0, 0). Unbounded.
//   C  city frame: G shifted up one planet radius (the city sits on the +Y pole).
//      Every legacy system (buildings, collision boxes, enemies) is authored here.
//   L  local / render frame: p_G = O + Q * p_L. Three.js renders and gameplay
//      simulates in L, so |p_L| stays small and float32 stays precise.
//
// Anchored mode (inside ORIGIN.anchorRadius / anchorAltitude of the city):
//   O = (0, R, 0), Q = identity, i.e. L == C exactly.
// Floating mode (anywhere else): whenever the player strays ORIGIN.shiftDistance
//   from O, the origin moves to the player and Q is parallel-transported so
//   local +Y is the planet's up at the new origin (gravity stays -Y).
//
// A shift maps every stored local point p -> M p + t and direction d -> M d,
// with M = Q'^-1 Q and t = Q'^-1 (O - O'). Systems register a listener and
// apply that (see applyPoint / applyDir). No allocations per shift.

export const SECTOR_SIZE = 1_000_000; // m, for the hierarchical global position

const _v = new Vector3();
const _up = new Vector3();
const _n = new Vector3();
const _dq = new Quaternion();
const _qi = new Quaternion();
const Y = new Vector3(0, 1, 0);

// Hierarchical global position: integer sectors + float64 offset inside the
// sector. Used for display and by future space-sector streaming; for the home
// planet the planet-centric float64 vector is exact to ~1e-10 m.
export class GlobalPosition {
  constructor() { this.sx = 0; this.sy = 0; this.sz = 0; this.x = 0; this.y = 0; this.z = 0; }
  setFromVector(v) {
    this.sx = Math.floor(v.x / SECTOR_SIZE); this.sy = Math.floor(v.y / SECTOR_SIZE); this.sz = Math.floor(v.z / SECTOR_SIZE);
    this.x = v.x - this.sx * SECTOR_SIZE; this.y = v.y - this.sy * SECTOR_SIZE; this.z = v.z - this.sz * SECTOR_SIZE;
    return this;
  }
  toVector(out) {
    return out.set(this.sx * SECTOR_SIZE + this.x, this.sy * SECTOR_SIZE + this.y, this.sz * SECTOR_SIZE + this.z);
  }
}

export class FloatingOrigin {
  constructor(planetRadius) {
    this.R = planetRadius;
    this.origin = new Vector3(0, planetRadius, 0); // O in G
    this.q = new Quaternion(); // Q: local -> global
    this.qInv = new Quaternion();
    this.anchored = true;
    this.shiftCount = 0;
    this.listeners = [];
    // The last shift (valid inside listeners): p' = shiftQ * p + shiftT.
    this.shiftQ = new Quaternion();
    this.shiftT = new Vector3();
    this.shiftRotates = false;
    this.planetCenterLocal = new Vector3(0, -planetRadius, 0);
  }

  // listener(fo) is called after every shift; read shiftQ / shiftT or use applyPoint.
  onShift(listener) { this.listeners.push(listener); }

  localToGlobal(p, out) {
    return out.copy(p).applyQuaternion(this.q).add(this.origin);
  }

  localDirToGlobal(d, out) { return out.copy(d).applyQuaternion(this.q); }
  globalDirToLocal(d, out) { return out.copy(d).applyQuaternion(this.qInv); }

  globalToLocal(g, out) {
    return out.copy(g).sub(this.origin).applyQuaternion(this.qInv);
  }

  // City frame <-> local (C axes == G axes, origin at (0, R, 0)).
  cityToLocal(p, out) {
    out.set(p.x, p.y + this.R, p.z);
    return this.globalToLocal(out, out);
  }

  localToCity(p, out) {
    this.localToGlobal(p, out);
    out.y -= this.R;
    return out;
  }

  // Apply the last shift to a stored point / direction, in place.
  applyPoint(v) {
    if (this.shiftRotates) v.applyQuaternion(this.shiftQ);
    return v.add(this.shiftT);
  }

  applyDir(v) {
    if (this.shiftRotates) v.applyQuaternion(this.shiftQ);
    return v;
  }

  // Same, for a raw xyz triple inside a typed array at offset o.
  applyPointArray(a, o) {
    _v.set(a[o], a[o + 1], a[o + 2]);
    this.applyPoint(_v);
    a[o] = _v.x; a[o + 1] = _v.y; a[o + 2] = _v.z;
  }

  applyDirArray(a, o) {
    if (!this.shiftRotates) return;
    _v.set(a[o], a[o + 1], a[o + 2]).applyQuaternion(this.shiftQ);
    a[o] = _v.x; a[o + 1] = _v.y; a[o + 2] = _v.z;
  }

  // Move the frame to (newOrigin, newQ) and notify every system.
  rebase(newOrigin, newQ) {
    // M = Q'^-1 Q ; t = Q'^-1 (O - O')
    _qi.copy(newQ).invert();
    this.shiftQ.copy(_qi).multiply(this.q);
    this.shiftT.copy(this.origin).sub(newOrigin).applyQuaternion(_qi);
    const w = Math.abs(this.shiftQ.w);
    this.shiftRotates = w < 1 - 1e-15;
    this.origin.copy(newOrigin);
    this.q.copy(newQ).normalize();
    this.qInv.copy(this.q).invert();
    this.planetCenterLocal.set(-this.origin.x, -this.origin.y, -this.origin.z).applyQuaternion(this.qInv);
    this.shiftCount++;
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](this);
  }

  // Re-centre on a global point, re-levelling by parallel transport (no
  // singularities anywhere on the planet; accumulated yaw is harmless).
  recenterAt(globalPoint) {
    _up.copy(Y).applyQuaternion(this.q);
    const len = globalPoint.length();
    if (len > 1) _n.copy(globalPoint).multiplyScalar(1 / len);
    else _n.copy(_up);
    _dq.setFromUnitVectors(_up, _n);
    _dq.multiply(this.q); // new Q = delta * Q
    this.rebase(globalPoint, _dq);
  }

  anchorToCity() {
    _v.set(0, this.R, 0);
    _dq.identity();
    this.anchored = true;
    this.rebase(_v, _dq);
  }

  // Decide whether the frame must change for a player at local position p.
  // Returns true if a shift happened. `playerGlobal` is scratch output.
  update(p, playerGlobal) {
    this.localToGlobal(p, playerGlobal);
    const r = playerGlobal.length();
    const alt = r - this.R;
    // Surface distance from the city (arc on the sea-level sphere).
    const cosA = Math.min(1, Math.max(-1, playerGlobal.y / r));
    const horiz = Math.acos(cosA) * this.R;
    if (this.anchored) {
      if (horiz > ORIGIN.anchorRadius || alt > ORIGIN.anchorAltitude) {
        this.anchored = false;
        this.recenterAt(playerGlobal);
        return true;
      }
      return false;
    }
    const h = ORIGIN.anchorHysteresis;
    if (horiz < ORIGIN.anchorRadius - h && alt < ORIGIN.anchorAltitude - h) {
      this.anchorToCity();
      return true;
    }
    if (p.lengthSq() > ORIGIN.shiftDistance * ORIGIN.shiftDistance) {
      this.recenterAt(playerGlobal);
      return true;
    }
    return false;
  }
}
