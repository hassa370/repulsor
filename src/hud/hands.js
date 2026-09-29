import {
  BufferAttribute, CircleGeometry, Color, CylinderGeometry, Group, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Quaternion, TorusGeometry, Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Iron Man-style gauntlets built on a real skinned hand (WebXR "generic-hand",
// MIT, see public/models/LICENSE-hands.md):
//   * armour paint baked into vertex colours from the skin weights: red plates,
//     gold proximal knuckle segments, gunmetal palm, dark seams at every joint
//   * wrist cuff + forearm, glowing palm repulsor with a gold ring
//   * fingers curl procedurally (relaxed at rest, flat open when thrusting/firing)
// Grip-space convention used by the game: fingers -Z, thumb side +Y,
// right palm -X / left palm +X (thrust pushes away from the palm).

const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
const PHALANX = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];
const THUMB = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];

// Placement of the hand in grip space (tweak if it sits oddly on your controller).
export const HAND_FIT = { x: 0, y: -0.012, z: 0.045, scale: 1.08 };

const RED = new Color(0x9e1414), GOLD = new Color(0xe0a838), GUN = new Color(0x2e2e34), SEAM = new Color(0x120808);

const _m2 = new Matrix4();
const _rot = new Matrix4();
const _s = new Vector3();
const _x = new Vector3(1, 0, 0);
const _y = new Vector3(0, 1, 0);

export async function loadHandModels() {
  const loader = new GLTFLoader();
  try {
    const [l, r] = await Promise.all([loader.loadAsync('models/hand-left.glb'), loader.loadAsync('models/hand-right.glb')]);
    return { left: l.scene, right: r.scene };
  } catch (e) {
    console.warn('Hand models failed to load, using fallback gauntlets', e);
    return null;
  }
}

export class Gauntlet {
  // side: -1 left, +1 right; scene: loaded glTF scene for that hand.
  constructor(side, scene) {
    this.side = side;
    this.object = new Group();
    let skinned = null;
    scene.traverse((o) => { if (o.isSkinnedMesh) skinned = o; });
    const bones = skinned.skeleton.bones;
    const byName = {};
    for (const b of bones) byName[b.name] = b;
    this.bones = byName;

    // Bind-pose joint matrices (bones are flat children of the armature).
    this.bind = new Map();
    for (const b of bones) { b.updateMatrix(); this.bind.set(b, b.matrix.clone()); }
    const pos = (n) => new Vector3().setFromMatrixPosition(this.bind.get(byName[n]));

    // Hand basis in model space -> grip space.
    const fingerDir = pos('middle-finger-tip').sub(pos('middle-finger-metacarpal')).normalize();
    const thumbSide = pos('index-finger-phalanx-proximal').sub(pos('pinky-finger-phalanx-proximal'));
    thumbSide.addScaledVector(fingerDir, -thumbSide.dot(fingerDir)).normalize();
    const third = new Vector3().crossVectors(fingerDir, thumbSide);
    // model basis columns (fingerDir, thumbSide, third) must map to (-Z, +Y, +X)
    const modelBasis = new Matrix4().makeBasis(third, thumbSide, fingerDir.clone().negate());
    const toGrip = modelBasis.clone().invert();
    const palmCenter = pos('middle-finger-metacarpal').add(pos('index-finger-phalanx-proximal')).add(pos('pinky-finger-phalanx-proximal')).multiplyScalar(1 / 3);
    // back of hand direction in model space (joint +Y axis of the middle proximal)
    const backDir = _y.clone().applyQuaternion(new Quaternion().setFromRotationMatrix(this.bind.get(byName['middle-finger-phalanx-proximal'])));

    this.paint(skinned, bones, backDir);
    skinned.material = new MeshStandardMaterial({
      vertexColors: true, metalness: 0.88, roughness: 0.27, envMapIntensity: 1.6,
    });
    skinned.frustumCulled = false;

    const holder = new Group(); // model space
    holder.add(scene);
    holder.position.copy(palmCenter).negate();
    const oriented = new Group();
    oriented.add(holder);
    oriented.quaternion.setFromRotationMatrix(toGrip);
    oriented.scale.setScalar(HAND_FIT.scale);
    oriented.position.set(HAND_FIT.x, HAND_FIT.y, HAND_FIT.z);
    this.object.add(oriented);

    // Palm repulsor (grip space): palm normal is -X (right) / +X (left).
    const palmSign = side > 0 ? -1 : 1;
    const ring = new Mesh(new TorusGeometry(0.0145, 0.0032, 8, 24),
      new MeshStandardMaterial({ color: GOLD, metalness: 1, roughness: 0.22, envMapIntensity: 1.6 }));
    ring.rotation.y = Math.PI / 2;
    ring.position.set(HAND_FIT.x + palmSign * 0.019, HAND_FIT.y, HAND_FIT.z - 0.004);
    this.glowColor = new Color(0xbfe8ff);
    const disc = new Mesh(new CircleGeometry(0.0125, 24), new MeshBasicMaterial({ color: this.glowColor, toneMapped: false }));
    disc.rotation.y = palmSign > 0 ? Math.PI / 2 : -Math.PI / 2;
    disc.position.copy(ring.position).x += palmSign * 0.001;
    this.object.add(ring, disc);

    // Wrist cuff + forearm (grip space, extending toward +Z), vertex-coloured.
    this.object.add(this.buildCuff());

    // Finger chains for procedural curl.
    this.chains = FINGERS.map((f) => PHALANX.map((p) => byName[`${f}-${p}`]));
    this.chains.push(THUMB.map((n) => byName[n]));
    this.world = new Map();
    for (const b of bones) this.world.set(b, new Matrix4());
    this.rel = new Map(); // bind-relative matrix of each joint to its chain parent
    for (const chain of this.chains) {
      for (let k = 1; k < chain.length; k++) {
        this.rel.set(chain[k], this.bind.get(chain[k - 1]).clone().invert().multiply(this.bind.get(chain[k])));
      }
    }
    this.curl = 0.5;
    this.spread = 0;
  }

  // Armour paint from skin weights: which joint dominates each vertex.
  paint(mesh, bones, backDir) {
    const g = mesh.geometry;
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, nrm = g.attributes.normal;
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const c = new Color();
    for (let i = 0; i < n; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) { bw = w; best = si.getComponent(i, k); }
      }
      const name = bones[best].name;
      const facing = nrm.getX(i) * backDir.x + nrm.getY(i) * backDir.y + nrm.getZ(i) * backDir.z;
      if (name.includes('phalanx-proximal')) c.copy(GOLD);
      else if ((name.includes('metacarpal') || name === 'wrist') && facing < -0.25) c.copy(GUN); // palm
      else if (name.includes('tip') || name.includes('distal')) c.copy(RED).multiplyScalar(1.1);
      else c.copy(RED);
      // Dark seams where two plates meet (weights shared between joints).
      const seam = 1 - Math.min(1, Math.max(0, (bw - 0.55) / 0.35));
      c.lerp(SEAM, seam * 0.85);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new BufferAttribute(col, 3));
  }

  buildCuff() {
    const parts = [];
    const add = (geo, color) => {
      const g = geo.toNonIndexed();
      g.deleteAttribute('uv');
      const n = g.attributes.position.count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
      g.setAttribute('color', new BufferAttribute(c, 3));
      parts.push(g);
    };
    const z0 = HAND_FIT.z + 0.075;
    const along = (geo, z) => geo.rotateX(Math.PI / 2).translate(0, HAND_FIT.y, z);
    add(along(new CylinderGeometry(0.036, 0.031, 0.055, 20, 1, true), z0 + 0.018), RED);
    add(along(new CylinderGeometry(0.0368, 0.0368, 0.008, 20, 1, true), z0 + 0.035), GOLD);
    add(along(new CylinderGeometry(0.035, 0.035, 0.006, 20, 1, true), z0 + 0.05), SEAM);
    add(along(new CylinderGeometry(0.046, 0.037, 0.14, 20, 1, true), z0 + 0.12), RED);
    add(along(new CylinderGeometry(0.0465, 0.0465, 0.006, 20, 1, true), z0 + 0.155), SEAM);
    add(along(new CylinderGeometry(0.047, 0.047, 0.01, 20, 1, true), z0 + 0.19), GOLD);
    const geo = mergeGeometries(parts);
    const m = new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, metalness: 0.88, roughness: 0.27, envMapIntensity: 1.6, side: 2 }));
    return m;
  }

  // open: 0 relaxed half-fist .. 1 flat open palm; glow: repulsor brightness.
  update(dt, open, glow) {
    const k = Math.min(1, dt * 14);
    this.curl += (0.62 * (1 - open) - this.curl) * k;
    this.spread += (open * 0.09 - this.spread) * k;
    const c = this.curl;
    for (let f = 0; f < this.chains.length; f++) {
      const chain = this.chains[f];
      const thumb = f === 4;
      const W = this.world;
      W.get(chain[0]).copy(this.bind.get(chain[0]));
      for (let j = 1; j < chain.length; j++) {
        const b = chain[j];
        // bend about the joint's local X; tips follow their parent
        let ang = 0;
        if (!b.name.endsWith('tip')) {
          if (thumb) ang = c * (j === 1 ? 0.35 : 0.55);
          else ang = c * (j === 1 ? 1.05 : j === 2 ? 1.35 : 0.9) * (1 + f * 0.06);
        }
        _rot.makeRotationAxis(_x, -ang);
        if (!thumb && j === 1) _rot.multiply(_m2.makeRotationAxis(_y, (1.5 - f) * this.spread));
        W.get(b).copy(W.get(chain[j - 1])).multiply(this.rel.get(b)).multiply(_rot);
        W.get(b).decompose(b.position, b.quaternion, _s);
      }
    }
    const gl = 0.35 + glow;
    this.glowColor.setRGB(0.55 * gl, 0.85 * gl, 1.0 * gl);
  }
}

// Fallback when the glTF hands can't load: a simple armoured block.
export function makeFallbackGauntlet() {
  const g = new Group();
  const m = new Mesh(new CylinderGeometry(0.035, 0.04, 0.16, 12).rotateX(Math.PI / 2).translate(0, 0, 0.05),
    new MeshStandardMaterial({ color: RED, metalness: 0.85, roughness: 0.3 }));
  g.add(m);
  return { object: g, update() {} };
}

