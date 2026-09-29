import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { PIVOT } from './goonModel.js';

// Procedural animation: per-part matrices from a handful of pose parameters.
// No skeletons: each part is an instance whose matrix = root * pivot * rotation.

export const P_HEAD = 0, P_BODY = 1, P_ARM_L = 2, P_ARM_R = 3, P_LEG_L = 4, P_LEG_R = 5, P_BAT = 6;

const _m = new Matrix4();
const _e = new Euler();
const _q = new Quaternion();
const _s = new Vector3();
const _p = new Vector3();
const UP = new Vector3(0, 1, 0);

export class Pose {
  constructor() {
    this.reset();
  }
  reset() {
    this.bob = 0; this.crouch = 0;
    this.bodyPitch = 0; this.bodyYaw = 0; this.bodyRoll = 0;
    this.headPitch = 0; this.headRoll = 0;
    this.armLx = 0; this.armLz = 0.12; this.armRx = 0; this.armRz = -0.12;
    this.legL = 0; this.legR = 0;
    this.batAngle = 1.4;
  }
}

function part(out, root, pv, rx, ry, rz, dy) {
  _e.set(rx, ry, rz, 'XYZ');
  _m.makeRotationFromEuler(_e);
  _m.elements[12] = pv[0]; _m.elements[13] = pv[1] + dy; _m.elements[14] = pv[2];
  out.multiplyMatrices(root, _m);
}

export function rootMatrix(out, x, y, z, yaw, scale) {
  _q.setFromAxisAngle(UP, yaw);
  _p.set(x, y, z);
  _s.set(scale, scale, scale);
  return out.compose(_p, _q, _s);
}

// mats: Matrix4[7]. Fills all part matrices for the given root + pose.
export function buildPose(mats, root, p) {
  const dy = p.bob - p.crouch;
  // Body leans; head/arms follow the upper body roughly (cheap: add pitch).
  part(mats[P_BODY], root, PIVOT.body, p.bodyPitch, p.bodyYaw, p.bodyRoll, dy);
  const lean = p.bodyPitch;
  const shoulderZ = Math.sin(lean) * 0.56; // shoulders move forward when leaning
  const shoulderDy = dy - (1 - Math.cos(lean)) * 0.56;
  _hp[0] = PIVOT.head[0]; _hp[1] = PIVOT.head[1]; _hp[2] = PIVOT.head[2] + Math.sin(lean) * 0.66;
  part(mats[P_HEAD], root, _hp, lean * 0.7 + p.headPitch, p.bodyYaw, p.headRoll, dy - (1 - Math.cos(lean)) * 0.66);
  _al[0] = PIVOT.armL[0]; _al[1] = PIVOT.armL[1]; _al[2] = PIVOT.armL[2] + shoulderZ;
  _ar[0] = PIVOT.armR[0]; _ar[1] = PIVOT.armR[1]; _ar[2] = PIVOT.armR[2] + shoulderZ;
  part(mats[P_ARM_L], root, _al, p.armLx, p.bodyYaw, p.armLz, shoulderDy);
  part(mats[P_ARM_R], root, _ar, p.armRx, p.bodyYaw, p.armRz, shoulderDy);
  part(mats[P_LEG_L], root, PIVOT.legL, p.legL, 0, 0.03, dy);
  part(mats[P_LEG_R], root, PIVOT.legR, p.legR, 0, -0.03, dy);
  // Bat in the right hand.
  _e.set(p.batAngle, 0, 0, 'XYZ');
  _m.makeRotationFromEuler(_e);
  _m.elements[12] = PIVOT.batGrip[0]; _m.elements[13] = PIVOT.batGrip[1]; _m.elements[14] = PIVOT.batGrip[2];
  mats[P_BAT].multiplyMatrices(mats[P_ARM_R], _m);
}
const _hp = [0, 0, 0], _al = [0, 0, 0], _ar = [0, 0, 0];
