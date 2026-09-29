import {
  BufferAttribute, BufferGeometry, CircleGeometry, Color, CylinderGeometry, Group, Matrix4, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Quaternion, TorusGeometry, Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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


// ---------------------------------------------------------------------------
// Nano Gauntlet (user-supplied model, decimated to ~18k tris and stored as a
// compact binary: [nVerts, nIndices] u32, positions f32 (mm), indices u32,
// part id u16 per vertex). Parts are classified by size/position and painted:
// red armour, gold hinges + wrist bands, glowing Infinity-Stone gems.
// Model space: fingers +Y, back of hand +Z, thumb -X (right hand).
// ---------------------------------------------------------------------------

export const NANO_FIT = { scale: 0.00092, x: 0, y: -0.005, z: 0.02 };

export async function loadNanoGauntlet() {
  try {
    const res = await fetch('models/nano-gauntlet.bin');
    const type = res.headers.get('content-type') || '';
    if (!res.ok || type.includes('text/html')) return null;
    const buf = await res.arrayBuffer();
    const [nv, ni] = new Uint32Array(buf, 0, 2);
    return {
      pos: new Float32Array(buf, 8, nv * 3),
      idx: new Uint32Array(buf, 8 + nv * 12, ni),
      part: new Uint16Array(buf, 8 + nv * 12 + ni * 4, nv),
    };
  } catch {
    return null;
  }
}

const STONE = {
  space: new Color(0.15, 0.35, 1.0), reality: new Color(1.0, 0.1, 0.12), power: new Color(0.7, 0.2, 1.0),
  mind: new Color(1.0, 0.85, 0.15), soul: new Color(1.0, 0.5, 0.08), time: new Color(0.15, 1.0, 0.35),
};

export class NanoGauntlet {
  constructor(side, data) {
    this.side = side;
    this.object = new Group();
    const { pos, idx, part } = data;
    const nv = pos.length / 3;
    // Per-part stats.
    const stats = new Map();
    for (let i = 0; i < nv; i++) {
      const p = part[i];
      let s = stats.get(p);
      if (!s) { s = { n: 0, x: 0, y: 0, z: 0 }; stats.set(p, s); }
      s.n++; s.x += pos[i * 3]; s.y += pos[i * 3 + 1]; s.z += pos[i * 3 + 2];
    }
    for (const s of stats.values()) { s.x /= s.n; s.y /= s.n; s.z /= s.n; }
    // Classify: gems sit on the back of the hand (+Z), small; tiny parts = hinges.
    const kind = new Map();
    const knuckles = [];
    for (const [p, s] of stats) {
      if (s.n < 24) kind.set(p, 'gold');
      else if (s.n < 400 && s.z > 5 && s.y > -20) { kind.set(p, 'gem'); knuckles.push([p, s.x]); }
      else if (s.n < 400 && s.z > 5) kind.set(p, STONE.soul);
      else if (s.n < 400 && s.x < -40) kind.set(p, STONE.time);
      else if (s.y < -100) kind.set(p, 'forearm');
      else kind.set(p, 'red');
    }
    knuckles.sort((a, b) => a[1] - b[1]);
    const order = [STONE.space, STONE.reality, STONE.power, STONE.mind];
    knuckles.forEach(([p], i) => kind.set(p, order[i % 4]));

    // Split triangles into armour vs gems, colour vertices.
    const armour = [], armourCol = [], gems = [], gemCol = [];
    const c = new Color();
    for (let t = 0; t < idx.length; t += 3) {
      const k = kind.get(part[idx[t]]);
      const isGem = k instanceof Color;
      // one colour per triangle (clean band edges): decide from the centroid
      const cy = (pos[idx[t] * 3 + 1] + pos[idx[t + 1] * 3 + 1] + pos[idx[t + 2] * 3 + 1]) / 3;
      if (k === 'gold') c.copy(GOLD);
      else if (k === 'forearm') c.copy(cy > -62 || (cy < -150 && cy > -165) ? GOLD : RED); // wrist rings + a band
      else c.copy(RED);
      for (let v = 0; v < 3; v++) {
        const i = idx[t + v];
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (isGem) {
          gems.push(x, y, z); gemCol.push(k.r, k.g, k.b);
          continue;
        }
        armour.push(x, y, z); armourCol.push(c.r, c.g, c.b);
      }
    }
    const mk = (p, col) => {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
      g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
      return toCreasedNormals(g, Math.PI / 5);
    };
    const armourMesh = new Mesh(mk(armour, armourCol), new MeshStandardMaterial({
      vertexColors: true, metalness: 0.88, roughness: 0.28, envMapIntensity: 1.6,
    }));
    this.gemMat = new MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: new Color(1.6, 1.6, 1.6) });
    const gemMesh = new Mesh(mk(gems, gemCol), this.gemMat);

    // Palm centre: middle of the hand shell, on its palm (-Z) surface.
    let hx = 0, hy = 0, hn = 0, hz = 0;
    for (let i = 0; i < nv; i++) {
      const y = pos[i * 3 + 1], x = pos[i * 3];
      if (y > -30 && y < 50 && x > -45 && x < 70) { hx += x; hy += y; hn++; }
    }
    hx /= hn; hy /= hn;
    hz = Infinity;
    for (let i = 0; i < nv; i++) {
      const dx = pos[i * 3] - hx, dy = pos[i * 3 + 1] - hy;
      if (dx * dx + dy * dy < 400) hz = Math.min(hz, pos[i * 3 + 2]);
    }

    // model (mm) -> grip space: fingers +Y -> -Z, back +Z -> +X, thumb -X -> +Y.
    const holder = new Group();
    holder.add(armourMesh, gemMesh);
    holder.position.set(-hx, -hy, -hz);
    const oriented = new Group();
    oriented.add(holder);
    oriented.quaternion.setFromRotationMatrix(new Matrix4().set(
      0, 0, 1, 0,
      -1, 0, 0, 0,
      0, -1, 0, 0,
      0, 0, 0, 1,
    ));
    oriented.scale.setScalar(NANO_FIT.scale);
    oriented.position.set(NANO_FIT.x, NANO_FIT.y, NANO_FIT.z);
    this.object.add(oriented);

    // Palm repulsor: sits on the palm surface (grip -X for the right hand).
    this.glowColor = new Color(0xbfe8ff);
    const ring = new Mesh(new TorusGeometry(0.016, 0.0035, 8, 24),
      new MeshStandardMaterial({ color: GOLD, metalness: 1, roughness: 0.22, envMapIntensity: 1.6 }));
    ring.rotation.y = Math.PI / 2;
    ring.position.set(NANO_FIT.x - 0.003, NANO_FIT.y, NANO_FIT.z + 0.014);
    const disc = new Mesh(new CircleGeometry(0.0135, 24), new MeshBasicMaterial({ color: this.glowColor, toneMapped: false }));
    disc.rotation.y = -Math.PI / 2;
    disc.position.copy(ring.position).x -= 0.001;
    this.object.add(ring, disc);
    if (side < 0) this.object.scale.x = -1; // left hand = mirrored right
    this.t = 0;
  }

  update(dt, open, glow) {
    this.t += dt;
    const gl = 0.35 + glow;
    this.glowColor.setRGB(0.55 * gl, 0.85 * gl, 1.0 * gl);
    const pulse = 1.3 + 0.35 * Math.sin(this.t * 3) + glow * 0.3;
    this.gemMat.color.setRGB(pulse, pulse, pulse);
  }
}
