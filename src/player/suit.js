import { Object3D } from 'three';
import { SUIT } from '../config.js';

// Player suit rig: the (future) visible Iron Man body and, today, the two boot
// thruster sockets. The rig lives in the same space as the camera and the
// controllers (Game.inner), hangs under the head and turns with the head yaw
// with a little lag, so the feet stay where your body is.
//
//   root (feet, body yaw)
//    ├── leftLeg  (hip pivot) ── leftBootSocket   (sole centre, -Z out of the sole)
//    └── rightLeg (hip pivot) ── rightBootSocket
//
// Socket positions come from public/models/ironman.glb (scene.extras.sockets,
// written by `npm run assets`). The suit isn't rigged, so the hips are plain
// pivots that swing the legs back into a flight pose while boosting. Once a
// rigged suit exists, parent the sockets to its foot bones instead; the
// get*Boot* methods stay the same.

// Measured from ironman.glb (model faces +Z, its left = +X, metres, 1.80 m tall).
export const DEFAULT_SUIT_SOCKETS = {
  leftBoot: [0.188, 0.024, 0.026], rightBoot: [-0.159, 0.019, -0.006],
  leftHip: [0.106, 0.905, -0.017], rightHip: [-0.106, 0.908, -0.021],
  eyeHeight: 1.645,
};

const TAU = Math.PI * 2;

export class SuitRig {
  constructor(parent, sockets = DEFAULT_SUIT_SOCKETS) {
    this.root = new Object3D();
    this.root.name = 'suitRoot';
    parent.add(this.root);
    this.yaw = 0;
    this.yawInit = false;
    this.flight = 0; // 0 standing .. 1 boost flight pose
    this.legs = [];
    this.bootSockets = [];
    this.setSockets(sockets);
    [this.leftBootSocket, this.rightBootSocket] = this.bootSockets;
  }

  // Build hip pivots + sole sockets from model-space points. The model faces +Z
  // and the rig faces -Z (like the camera), so x and z flip.
  setSockets(s) {
    const scale = SUIT.height / 1.8;
    this.eyeHeight = s.eyeHeight * scale;
    for (let i = 0; i < 2; i++) {
      const hip = i === 0 ? s.leftHip : s.rightHip;
      const boot = i === 0 ? s.leftBoot : s.rightBoot;
      let leg = this.legs[i];
      if (!leg) {
        leg = new Object3D();
        leg.name = i === 0 ? 'leftHip' : 'rightHip';
        this.root.add(leg);
        this.legs.push(leg);
        const socket = new Object3D();
        socket.name = i === 0 ? 'leftBootSocket' : 'rightBootSocket';
        socket.rotation.x = -Math.PI / 2; // local -Z points down, out of the sole
        leg.add(socket);
        this.bootSockets.push(socket);
      }
      leg.position.set(-hip[0] * scale, hip[1] * scale, -hip[2] * scale);
      this.bootSockets[i].position.set(-(boot[0] - hip[0]) * scale, (boot[1] - hip[1]) * scale - SUIT.bootOut,
        -(boot[2] - hip[2]) * scale);
    }
  }

  // headPos / headYaw in the parent's space (Game.inner); flight 0..1 (boost).
  update(dt, headPos, headYaw, flight) {
    if (!this.yawInit) { this.yaw = headYaw; this.yawInit = true; }
    let d = (headYaw - this.yaw) % TAU;
    if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
    this.yaw += d * Math.min(1, dt * SUIT.yawFollow);
    const r = this.root;
    r.rotation.set(0, this.yaw, 0);
    // Neck: the body hangs under the eyes, set back a little so you look down onto your chest.
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    r.position.set(headPos.x + sy * SUIT.neckBack, headPos.y - this.eyeHeight, headPos.z + cy * SUIT.neckBack);
    // Legs swing back into a flight pose while boosting.
    this.flight += (flight - this.flight) * Math.min(1, dt * 6);
    const a = -this.flight * SUIT.flightLegDeg * Math.PI / 180;
    this.legs[0].rotation.x = a;
    this.legs[1].rotation.x = a;
  }

  getLeftBootWorldPosition(out) { return socketPos(this.leftBootSocket, out); }
  getRightBootWorldPosition(out) { return socketPos(this.rightBootSocket, out); }
  // Out of the sole (visual reference only: boost physics never reads it).
  getLeftBootWorldDirection(out) { return socketDir(this.leftBootSocket, out); }
  getRightBootWorldDirection(out) { return socketDir(this.rightBootSocket, out); }
}

function socketPos(s, out) {
  s.updateWorldMatrix(true, false);
  return out.setFromMatrixPosition(s.matrixWorld);
}

function socketDir(s, out) {
  s.updateWorldMatrix(true, false);
  const e = s.matrixWorld.elements;
  return out.set(-e[8], -e[9], -e[10]).normalize();
}

// Pull the socket table out of a GLB's JSON chunk without decoding meshes or textures.
export async function loadSuitSockets(url = 'models/ironman.glb') {
  try {
    const res = await fetch(url);
    const type = res.headers.get('content-type') || '';
    if (!res.ok || type.includes('text/html')) return null;
    const buf = await res.arrayBuffer();
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) return null;
    const len = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
    return json.scenes?.[json.scene || 0]?.extras?.sockets || null;
  } catch {
    return null;
  }
}
