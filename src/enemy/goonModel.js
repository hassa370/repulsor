import {
  BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, ConeGeometry, CylinderGeometry, LinearMipmapLinearFilter,
  SphereGeometry, SRGBColorSpace, Matrix4,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/rand.js';
import { FACE_CROP } from '../config.js';

// ---------------------------------------------------------------------------
// One 512px atlas for every enemy part (wood, face, robe, sash, scarf, bat...).
// Regions are in canvas pixels (top-left origin).
// ---------------------------------------------------------------------------
const S = 512;
export const REGIONS = {
  wood: [0, 0, 256, 256],
  face: [256, 0, 256, 256],
  robe: [0, 256, 256, 128],
  scarf: [256, 256, 128, 128],
  sash: [384, 256, 128, 128],
  endgrain: [0, 384, 128, 128],
  limb: [128, 384, 128, 128],
  bat: [256, 384, 128, 128],
  sandal: [384, 384, 128, 128],
};

function uvRect(name) {
  const [x, y, w, h] = REGIONS[name];
  // half-texel inset to avoid bleeding with mipmaps
  const i = 2;
  return [(x + i) / S, 1 - (y + h - i) / S, (x + w - i) / S, 1 - (y + i) / S];
}

function paintWood(g, x, y, w, h, rnd, base, dark, vertical = true) {
  g.fillStyle = base;
  g.fillRect(x, y, w, h);
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  for (let i = 0; i < 70; i++) {
    g.strokeStyle = rnd() < 0.5 ? dark : 'rgba(255,220,170,0.12)';
    g.lineWidth = 1 + rnd() * 3;
    g.globalAlpha = 0.25 + rnd() * 0.4;
    g.beginPath();
    const p = (vertical ? x : y) + rnd() * (vertical ? w : h);
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const q = (vertical ? y : x) + t * (vertical ? h : w);
      const o = p + Math.sin(t * 6 + i) * 2.5;
      if (vertical) (t === 0 ? g.moveTo(o, q) : g.lineTo(o, q));
      else (t === 0 ? g.moveTo(q, o) : g.lineTo(q, o));
    }
    g.stroke();
  }
  // knots
  for (let i = 0; i < 4; i++) {
    const kx = x + rnd() * w, ky = y + rnd() * h, r = 4 + rnd() * 7;
    g.globalAlpha = 0.6;
    g.fillStyle = dark;
    g.beginPath(); g.ellipse(kx, ky, r * 0.6, r, 0, 0, Math.PI * 2); g.fill();
  }
  g.restore();
  g.globalAlpha = 1;
}

function paintFace(g, x, y, w, h) {
  // Carved, grumpy log face.
  const cx = x + w / 2;
  g.fillStyle = '#2a170c';
  // brows
  g.lineWidth = 12; g.lineCap = 'round'; g.strokeStyle = '#2a170c';
  g.beginPath(); g.moveTo(cx - 80, y + 70); g.lineTo(cx - 22, y + 92); g.stroke();
  g.beginPath(); g.moveTo(cx + 80, y + 70); g.lineTo(cx + 22, y + 92); g.stroke();
  // eyes
  g.fillStyle = '#140a05';
  g.beginPath(); g.ellipse(cx - 46, y + 112, 17, 13, 0.15, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(cx + 46, y + 112, 17, 13, -0.15, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#f2e6c8';
  g.beginPath(); g.arc(cx - 42, y + 109, 4, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(cx + 42, y + 109, 4, 0, Math.PI * 2); g.fill();
  // nose
  g.fillStyle = 'rgba(40,20,8,0.55)';
  g.beginPath(); g.moveTo(cx, y + 118); g.lineTo(cx - 13, y + 160); g.lineTo(cx + 13, y + 160); g.closePath(); g.fill();
  // mouth (toothy grimace)
  g.fillStyle = '#1a0c05';
  g.beginPath(); g.moveTo(cx - 55, y + 188); g.quadraticCurveTo(cx, y + 172, cx + 55, y + 188);
  g.quadraticCurveTo(cx, y + 222, cx - 55, y + 188); g.fill();
  g.fillStyle = '#e8dcc0';
  for (let i = -3; i <= 3; i++) g.fillRect(cx + i * 13 - 4, y + 181 + Math.abs(i) * 1.5, 8, 9);
}

// faceImage: optional HTMLImageElement / ImageBitmap of the reference art.
export function createAtlas(faceImage) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rnd = mulberry32(42);
  const R = REGIONS;
  paintWood(g, ...R.wood, rnd, '#8a5a33', 'rgba(60,32,14,0.9)');
  paintWood(g, ...R.face, rnd, '#94623a', 'rgba(60,32,14,0.8)');
  if (faceImage) {
    const iw = faceImage.width, ih = faceImage.height;
    const [u0, v0, u1, v1] = FACE_CROP;
    const [fx, fy, fw, fh] = R.face;
    g.drawImage(faceImage, u0 * iw, v0 * ih, (u1 - u0) * iw, (v1 - v0) * ih, fx, fy, fw, fh);
  } else {
    paintFace(g, ...R.face);
  }
  // robe: off-white cloth with folds
  {
    const [x, y, w, h] = R.robe;
    g.fillStyle = '#e9e4da'; g.fillRect(x, y, w, h);
    for (let i = 0; i < 18; i++) {
      g.fillStyle = `rgba(120,110,100,${0.05 + rnd() * 0.12})`;
      g.fillRect(x + rnd() * w, y, 2 + rnd() * 8, h);
    }
  }
  g.fillStyle = '#16161a'; g.fillRect(...R.scarf);
  for (let i = 0; i < 12; i++) { g.fillStyle = 'rgba(80,80,90,0.25)'; g.fillRect(R.scarf[0], R.scarf[1] + rnd() * 128, 128, 2); }
  g.fillStyle = '#3a2418'; g.fillRect(...R.sash);
  for (let i = 0; i < 10; i++) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(R.sash[0] + rnd() * 128, R.sash[1], 3, 128); }
  {
    const [x, y, w, h] = R.endgrain;
    g.fillStyle = '#b98a58'; g.fillRect(x, y, w, h);
    for (let r = 4; r < 64; r += 5 + rnd() * 3) {
      g.strokeStyle = 'rgba(90,50,20,0.6)'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2); g.stroke();
    }
  }
  paintWood(g, ...R.limb, rnd, '#8f5f38', 'rgba(60,32,14,0.8)');
  paintWood(g, ...R.bat, rnd, '#c79a62', 'rgba(110,70,30,0.7)');
  g.fillStyle = '#9c7a4f'; g.fillRect(...R.sandal);

  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------------------
// Geometry. Every part is built around its joint pivot; the model faces +Z.
// ---------------------------------------------------------------------------

// Remap a geometry's [0,1] uvs into an atlas region.
function mapUv(geo, region) {
  const [u0, v0, u1, v1] = uvRect(region);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  return geo;
}

function prep(geo, region) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  return mapUv(g, region);
}

// Cylinder whose side is split into a front face decal and wood elsewhere,
// decided per triangle so no triangle straddles two atlas regions.
function faceLog(radius, height, segs, faceHalfAngle) {
  const geo = new CylinderGeometry(radius, radius * 1.04, height, segs, 1, true).toNonIndexed();
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const wood = uvRect('wood'), face = uvRect('face');
  for (let t = 0; t < pos.count; t += 3) {
    let cx = 0, cz = 0;
    for (let k = 0; k < 3; k++) { cx += pos.getX(t + k); cz += pos.getZ(t + k); }
    const center = Math.atan2(cx, cz); // 0 = +Z (front)
    const isFace = Math.abs(center) < faceHalfAngle;
    for (let k = 0; k < 3; k++) {
      const i = t + k;
      const y = pos.getY(i) / height + 0.5;
      if (isFace) {
        const a = Math.atan2(pos.getX(i), pos.getZ(i));
        const u = 0.5 + a / (2 * faceHalfAngle);
        uv.setXY(i, face[0] + u * (face[2] - face[0]), face[1] + y * (face[3] - face[1]));
      } else {
        const u = uv.getX(i);
        uv.setXY(i, wood[0] + u * (wood[2] - wood[0]), wood[1] + y * (wood[3] - wood[1]));
      }
    }
  }
  return geo;
}

function disc(radius, segs, y, region, up = true) {
  const g = new CylinderGeometry(radius, radius, 0.001, segs, 1, false).toNonIndexed();
  // keep only the cap facing the right way (drop side + other cap)
  const pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
  const keepP = [], keepN = [], keepU = [];
  for (let t = 0; t < pos.count; t += 3) {
    const ny = nrm.getY(t);
    if ((up && ny > 0.9) || (!up && ny < -0.9)) {
      for (let k = 0; k < 3; k++) {
        keepP.push(pos.getX(t + k), y, pos.getZ(t + k));
        keepN.push(0, up ? 1 : -1, 0);
        keepU.push(uv.getX(t + k), uv.getY(t + k));
      }
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(keepP), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(keepN), 3));
  out.setAttribute('uv', new BufferAttribute(new Float32Array(keepU), 2));
  return mapUv(out, region);
}

const T = (g, x, y, z) => g.applyMatrix4(new Matrix4().makeTranslation(x, y, z));

// Joint pivots (model space, feet at y = 0).
export const PIVOT = {
  head: [0, 1.5, 0],
  body: [0, 0.84, 0],
  armL: [-0.25, 1.4, 0],
  armR: [0.25, 1.4, 0],
  legL: [-0.1, 0.84, 0],
  legR: [0.1, 0.84, 0],
  batGrip: [0, -0.6, 0.02], // in right-arm space
};
export const PART_NAMES = ['head', 'body', 'armL', 'armR', 'legL', 'legR', 'bat'];

export function buildGoonGeometries() {
  const parts = {};
  // HEAD: tall log with face decal, end-grain caps, black scarf + tail.
  {
    const logH = 0.58, r = 0.17;
    const log = T(faceLog(r, logH, 14, 0.9), 0, 0.08 + logH / 2, 0);
    const top = disc(r, 14, 0.08 + logH, 'endgrain', true);
    const scarf = T(prep(new CylinderGeometry(0.2, 0.21, 0.15, 14, 1, true), 'scarf'), 0, 0.07, 0);
    const scarfTop = disc(0.2, 14, 0.145, 'scarf', true);
    const tail = T(prep(new BoxGeometry(0.1, 0.34, 0.03), 'scarf'), 0.06, -0.1, -0.2);
    parts.head = mergeGeometries([log, top, scarf, scarfTop, tail]);
  }
  // BODY: robe (tapered), sash band, shoulders cap.
  {
    const robe = T(prep(new CylinderGeometry(0.2, 0.33, 0.95, 12, 1, true), 'robe'), 0, 0.2, 0);
    const shoulders = disc(0.2, 12, 0.675, 'robe', true);
    const hem = disc(0.33, 12, -0.275, 'robe', false);
    const sash = T(prep(new CylinderGeometry(0.28, 0.298, 0.13, 12, 1, true), 'sash'), 0, 0.12, 0);
    const knot = T(prep(new BoxGeometry(0.09, 0.2, 0.04), 'sash'), 0.11, 0.0, 0.29);
    parts.body = mergeGeometries([robe, shoulders, hem, sash, knot]);
  }
  // ARMS: white sleeve + wooden forearm + hand.
  const arm = (side) => {
    const sleeve = T(prep(new CylinderGeometry(0.075, 0.09, 0.3, 6, 1, true), 'robe'), 0, -0.15, 0);
    const fore = T(prep(new CylinderGeometry(0.05, 0.055, 0.28, 6, 1, false), 'limb'), 0, -0.42, 0);
    const hand = T(prep(new SphereGeometry(0.07, 6, 4), 'limb'), 0, -0.6, 0.01);
    const g = mergeGeometries([sleeve, fore, hand]);
    if (side < 0) g.translate(-0.01, 0, 0);
    return g;
  };
  parts.armL = arm(-1);
  parts.armR = arm(1);
  // LEGS: wooden shin + sandal.
  const leg = () => {
    const shin = T(prep(new CylinderGeometry(0.06, 0.05, 0.8, 6, 1, false), 'limb'), 0, -0.42, 0);
    const sandal = T(prep(new BoxGeometry(0.12, 0.04, 0.26), 'sandal'), 0, -0.82, 0.05);
    return mergeGeometries([shin, sandal]);
  };
  parts.legL = leg();
  parts.legR = leg();
  // BAT: tapered cylinder along +Y from the grip.
  {
    const shaft = T(prep(new CylinderGeometry(0.065, 0.028, 0.95, 8, 1, true), 'bat'), 0, 0.37, 0);
    const end = disc(0.065, 8, 0.845, 'endgrain', true);
    const knob = T(prep(new CylinderGeometry(0.045, 0.045, 0.04, 6, 1, false), 'bat'), 0, -0.12, 0);
    parts.bat = mergeGeometries([shaft, end, knob]);
  }
  // Silhouette LOD: whole goon in a neutral pose, very few segments.
  {
    const lowLog = T(faceLog(0.18, 0.66, 5, 0.9), 0, PIVOT.head[1] + 0.33, 0);
    const lowBody = T(prep(new ConeGeometry(0.34, 1.3, 5, 1, true), 'robe'), 0, 1.05, 0);
    const lowLegs = T(prep(new BoxGeometry(0.3, 0.6, 0.12), 'limb'), 0, 0.3, 0);
    const lowArms = T(prep(new BoxGeometry(0.72, 0.1, 0.1), 'robe'), 0, 1.25, 0.05);
    const lowBat = T(prep(new BoxGeometry(0.06, 0.06, 0.9), 'bat'), 0.3, 0.9, 0.35);
    parts.silhouette = mergeGeometries([lowLog, lowBody, lowLegs, lowArms, lowBat]);
  }
  for (const k in parts) {
    for (const name of Object.keys(parts[k].attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') parts[k].deleteAttribute(name);
    }
    parts[k].computeBoundingSphere();
  }
  return parts;
}

export function triangleCounts(parts) {
  const out = {};
  let total = 0;
  for (const k of PART_NAMES) {
    const n = parts[k].attributes.position.count / 3;
    out[k] = n;
    total += n;
  }
  out.total = total;
  out.silhouette = parts.silhouette.attributes.position.count / 3;
  return out;
}
