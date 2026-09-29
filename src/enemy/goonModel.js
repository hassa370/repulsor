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

function paintWood(g, x, y, w, h, rnd, base, dark, light) {
  // base gradient (slightly darker at the edges = rounder look)
  const grad = g.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, dark); grad.addColorStop(0.5, base); grad.addColorStop(1, dark);
  g.fillStyle = base; g.fillRect(x, y, w, h);
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.globalAlpha = 0.25; g.fillStyle = grad; g.fillRect(x, y, w, h); g.globalAlpha = 1;
  // bark grooves (dark) + ridges (light), vertical with gentle waves
  for (let i = 0; i < 46; i++) {
    const isGroove = i % 3 !== 0;
    g.strokeStyle = isGroove ? dark : light;
    g.lineWidth = isGroove ? 1.5 + rnd() * 3 : 1 + rnd() * 1.5;
    g.globalAlpha = isGroove ? 0.45 + rnd() * 0.35 : 0.25 + rnd() * 0.25;
    const px = x + rnd() * w;
    const ph = rnd() * 6;
    g.beginPath();
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const qy = y + t * h;
      const ox = px + Math.sin(t * 7 + ph) * 3 + Math.sin(t * 23 + ph) * 1.2;
      if (t === 0) g.moveTo(ox, qy); else g.lineTo(ox, qy);
    }
    g.stroke();
  }
  // knots with rings
  for (let i = 0; i < 3; i++) {
    const kx = x + 10 + rnd() * (w - 20), ky = y + 10 + rnd() * (h - 20), r = 5 + rnd() * 6;
    g.globalAlpha = 0.85;
    g.fillStyle = dark;
    g.beginPath(); g.ellipse(kx, ky, r * 0.55, r, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = light; g.lineWidth = 1; g.globalAlpha = 0.4;
    g.beginPath(); g.ellipse(kx, ky, r * 0.9, r * 1.5, 0, 0, Math.PI * 2); g.stroke();
  }
  g.restore();
  g.globalAlpha = 1;
}

// Pupils of the carved face, in face-region pixels (made emissive via alpha).
const EYES = [[-44, 112, 9], [44, 112, 9]];

function paintFace(g, x, y, w, h) {
  // Deeply carved, angry log face.
  const cx = x + w / 2;
  const shade = (ex, ey, rx, ry, a) => {
    const gr = g.createRadialGradient(ex, ey, 0, ex, ey, Math.max(rx, ry));
    gr.addColorStop(0, `rgba(25,12,5,${a})`); gr.addColorStop(1, 'rgba(25,12,5,0)');
    g.fillStyle = gr;
    g.beginPath(); g.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2); g.fill();
  };
  // brow ridge shadow + eye sockets
  shade(cx, y + 108, 100, 48, 0.55);
  shade(cx - 44, y + 112, 34, 26, 0.9);
  shade(cx + 44, y + 112, 34, 26, 0.9);
  // heavy slanted brows (raised wood, lit from above)
  g.lineCap = 'round';
  for (const s of [-1, 1]) {
    g.strokeStyle = '#2a150a'; g.lineWidth = 18;
    g.beginPath(); g.moveTo(cx + s * 92, y + 66); g.quadraticCurveTo(cx + s * 50, y + 76, cx + s * 16, y + 96); g.stroke();
    g.strokeStyle = 'rgba(230,170,110,0.55)'; g.lineWidth = 5;
    g.beginPath(); g.moveTo(cx + s * 90, y + 60); g.quadraticCurveTo(cx + s * 50, y + 70, cx + s * 18, y + 89); g.stroke();
  }
  // eyes (dark holes, pupils filled later as glowing embers)
  g.fillStyle = '#0d0603';
  for (const [ex, ey] of EYES) { g.beginPath(); g.ellipse(cx + ex, y + ey, 20, 14, 0, 0, Math.PI * 2); g.fill(); }
  // nose: carved wedge with highlight
  g.fillStyle = 'rgba(35,18,8,0.7)';
  g.beginPath(); g.moveTo(cx, y + 116); g.lineTo(cx - 18, y + 166); g.lineTo(cx + 18, y + 166); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(235,180,120,0.6)'; g.lineWidth = 4;
  g.beginPath(); g.moveTo(cx + 2, y + 118); g.lineTo(cx + 14, y + 162); g.stroke();
  // mouth: jagged grimace with teeth
  g.fillStyle = '#120804';
  g.beginPath(); g.moveTo(cx - 62, y + 190); g.quadraticCurveTo(cx, y + 174, cx + 62, y + 190);
  g.quadraticCurveTo(cx, y + 232, cx - 62, y + 190); g.fill();
  g.fillStyle = '#eadcbc';
  for (let i = -3; i <= 3; i++) {
    g.beginPath();
    const tx = cx + i * 15;
    g.moveTo(tx - 6, y + 183 + Math.abs(i) * 1.5); g.lineTo(tx + 6, y + 183 + Math.abs(i) * 1.5); g.lineTo(tx, y + 197); g.closePath(); g.fill();
    g.beginPath();
    g.moveTo(tx - 6, y + 214 - Math.abs(i) * 2); g.lineTo(tx + 6, y + 214 - Math.abs(i) * 2); g.lineTo(tx + 1, y + 203); g.closePath(); g.fill();
  }
  // cracks
  g.strokeStyle = 'rgba(20,10,4,0.7)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx + 70, y + 20); g.lineTo(cx + 60, y + 50); g.lineTo(cx + 74, y + 72); g.stroke();
  g.beginPath(); g.moveTo(cx - 80, y + 150); g.lineTo(cx - 66, y + 176); g.stroke();
}

// Pupils glow: bright ember colour with alpha < 1 as an emissive mask.
function paintEmbers(g, x, y, w) {
  const cx = x + w / 2;
  const img = g.getImageData(x, y, w, w);
  const d = img.data;
  for (const [ex, ey, r] of EYES) {
    for (let py = -r; py <= r; py++) {
      for (let px = -r; px <= r; px++) {
        const q = Math.hypot(px, py) / r;
        if (q > 1) continue;
        const o = ((ey + py) * w + (cx - x + ex + px)) * 4;
        d[o] = 255; d[o + 1] = 150 + 90 * (1 - q); d[o + 2] = 40 + 60 * (1 - q);
        d[o + 3] = 150; // alpha < 1 marks emissive pixels (see goon shader)
      }
    }
  }
  g.putImageData(img, x, y);
}

// faceImage: optional HTMLImageElement / ImageBitmap of the reference art.
export function createAtlas(faceImage) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d', { willReadFrequently: true });
  const rnd = mulberry32(42);
  const R = REGIONS;
  paintWood(g, ...R.wood, rnd, '#8c5b33', '#3e2210', '#d49a62');
  paintWood(g, ...R.face, rnd, '#9a663c', '#442612', '#dca46a');
  if (faceImage) {
    const iw = faceImage.width, ih = faceImage.height;
    const [u0, v0, u1, v1] = FACE_CROP;
    const [fx, fy, fw, fh] = R.face;
    g.drawImage(faceImage, u0 * iw, v0 * ih, (u1 - u0) * iw, (v1 - v0) * ih, fx, fy, fw, fh);
  } else {
    paintFace(g, ...R.face);
    paintEmbers(g, R.face[0], R.face[1], R.face[2]);
  }
  // robe: off-white gi cloth, soft vertical folds, stitched hem
  {
    const [x, y, w, h] = R.robe;
    const gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, '#f1ede4'); gr.addColorStop(1, '#d8d2c6');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    for (let i = 0; i < 22; i++) {
      const fx = x + rnd() * w, fw = 4 + rnd() * 12;
      const fg = g.createLinearGradient(fx, 0, fx + fw, 0);
      fg.addColorStop(0, 'rgba(90,85,95,0)'); fg.addColorStop(0.5, `rgba(90,85,95,${0.12 + rnd() * 0.18})`); fg.addColorStop(1, 'rgba(90,85,95,0)');
      g.fillStyle = fg; g.fillRect(fx, y, fw, h);
    }
    g.fillStyle = 'rgba(120,110,100,0.5)';
    for (let i = 0; i < w; i += 6) g.fillRect(x + i, y + h - 8, 3, 1.5);
  }
  // scarf: black knit with sheen
  {
    const [x, y, w, h] = R.scarf;
    g.fillStyle = '#121216'; g.fillRect(x, y, w, h);
    for (let i = 0; i < h; i += 4) { g.fillStyle = `rgba(90,95,110,${0.12 + (i % 8 ? 0.05 : 0.12)})`; g.fillRect(x, y + i, w, 1.5); }
  }
  // sash: dark leather-brown with weave
  {
    const [x, y, w, h] = R.sash;
    g.fillStyle = '#34201a'; g.fillRect(x, y, w, h);
    for (let i = 0; i < w; i += 5) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x + i, y, 2, h); }
    for (let i = 0; i < h; i += 7) { g.fillStyle = 'rgba(150,100,70,0.18)'; g.fillRect(x, y + i, w, 2); }
  }
  {
    const [x, y, w, h] = R.endgrain;
    g.fillStyle = '#c29062'; g.fillRect(x, y, w, h);
    for (let r = 4; r < 64; r += 4 + rnd() * 3) {
      g.strokeStyle = `rgba(95,52,22,${0.4 + rnd() * 0.3})`; g.lineWidth = 1.2 + rnd();
      g.beginPath(); g.arc(x + w / 2 + rnd() * 2, y + h / 2 + rnd() * 2, r, 0, Math.PI * 2); g.stroke();
    }
    g.strokeStyle = '#4a2a12'; g.lineWidth = 8; // bark rim
    g.beginPath(); g.arc(x + w / 2, y + h / 2, 60, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(40,20,8,0.8)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x + w / 2, y + h / 2); g.lineTo(x + w / 2 + 40, y + h / 2 - 22); g.stroke();
  }
  paintWood(g, ...R.limb, rnd, '#8a5832', '#3e2210', '#c98d58');
  paintWood(g, ...R.bat, rnd, '#c99c64', '#6e4520', '#f0c890');
  {
    const [x, y, w, h] = R.sandal;
    g.fillStyle = '#a07c50'; g.fillRect(x, y, w, h);
    g.fillStyle = '#3a2416'; g.fillRect(x, y + h * 0.35, w, 10); g.fillRect(x + w * 0.45, y, 10, h);
  }

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
  head: [0, 1.52, 0],
  body: [0, 0.84, 0],
  armL: [-0.25, 1.4, 0],
  armR: [0.25, 1.4, 0],
  legL: [-0.1, 0.84, 0],
  legR: [0.1, 0.84, 0],
  batGrip: [0, -0.6, 0.02], // in right-arm space
};
export const PART_NAMES = ['head', 'body', 'armL', 'armR', 'legL', 'legR', 'bat'];

// Bake a per-vertex shade (fake AO / form shading) from local position.
function shade(geo, fn) {
  const pos = geo.attributes.position;
  const a = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) a[i] = fn(pos.getX(i), pos.getY(i), pos.getZ(i));
  geo.setAttribute('aShade', new BufferAttribute(a, 1));
  return geo;
}
const sm = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const flat = (v) => () => v;

export function buildGoonGeometries() {
  const parts = {};
  // HEAD: big log with carved face, end-grain top, black scarf + hanging tail.
  {
    const logH = 0.62, r = 0.18;
    const log = shade(T(faceLog(r, logH, 14, 0.95), 0, 0.08 + logH / 2, 0), (x, y) => 0.72 + 0.28 * sm(0.1, 0.35, y));
    const top = shade(disc(r * 1.02, 14, 0.08 + logH, 'endgrain', true), flat(1));
    const scarf = shade(T(prep(new CylinderGeometry(0.215, 0.23, 0.16, 14, 1, true), 'scarf'), 0, 0.07, 0), (x, y) => 0.75 + 0.25 * sm(0, 0.15, y));
    const scarfTop = shade(disc(0.215, 14, 0.15, 'scarf', true), flat(0.85));
    const tail = shade(T(prep(new BoxGeometry(0.11, 0.38, 0.03), 'scarf'), 0.07, -0.12, -0.215), (x, y) => 0.7 + 0.3 * sm(-0.3, 0.05, y));
    parts.head = mergeGeometries([log, top, scarf, scarfTop, tail]);
  }
  // BODY: gi jacket + flared robe skirt, V collar, sash with knot + tails.
  {
    const skirtAO = (x, y) => 0.62 + 0.38 * sm(-0.5, 0.1, y);
    const skirt = shade(T(prep(new CylinderGeometry(0.255, 0.37, 0.62, 12, 1, true), 'robe'), 0, -0.19, 0), skirtAO);
    const hem = shade(disc(0.37, 12, -0.5, 'robe', false), flat(0.5));
    const jacket = shade(T(prep(new CylinderGeometry(0.215, 0.26, 0.62, 12, 1, true), 'robe'), 0, 0.35, 0),
      (x, y) => (0.8 + 0.2 * sm(0.05, 0.5, y)) * (1 - 0.15 * sm(0.15, 0.25, Math.abs(x)) * sm(0.4, 0.6, y)));
    const shoulders = shade(disc(0.215, 12, 0.66, 'robe', true), flat(0.95));
    const sash = shade(T(prep(new CylinderGeometry(0.268, 0.272, 0.15, 12, 1, true), 'sash'), 0, 0.12, 0), flat(0.9));
    const knot = shade(T(prep(new BoxGeometry(0.1, 0.09, 0.05), 'sash'), 0.1, 0.12, 0.27), flat(1));
    const tails = shade(T(prep(new BoxGeometry(0.08, 0.28, 0.02), 'sash'), 0.12, -0.04, 0.275), (x, y) => 0.75 + 0.25 * sm(-0.2, 0.1, y));
    const lapL = shade(prep(new BoxGeometry(0.055, 0.42, 0.02), 'scarf'), flat(0.9));
    lapL.rotateZ(0.42); lapL.translate(0.07, 0.45, 0.23);
    const lapR = shade(prep(new BoxGeometry(0.055, 0.42, 0.02), 'scarf'), flat(0.9));
    lapR.rotateZ(-0.42); lapR.translate(-0.07, 0.45, 0.23);
    parts.body = mergeGeometries([skirt, hem, jacket, shoulders, sash, knot, tails, lapL, lapR]);
  }
  // ARMS: wide kimono sleeve + wooden forearm + hand.
  const arm = (side) => {
    const sleeve = shade(T(prep(new CylinderGeometry(0.085, 0.13, 0.36, 7, 1, true), 'robe'), 0, -0.18, 0), (x, y) => 0.7 + 0.3 * sm(-0.36, -0.05, y));
    const fore = shade(T(prep(new CylinderGeometry(0.05, 0.058, 0.26, 6, 1, true), 'limb'), 0, -0.44, 0), (x, y) => 0.65 + 0.35 * sm(-0.3, -0.55, y));
    const hand = shade(T(prep(new SphereGeometry(0.075, 6, 4), 'limb'), 0, -0.6, 0.01), flat(0.95));
    const g = mergeGeometries([sleeve, fore, hand]);
    if (side < 0) g.translate(-0.01, 0, 0);
    return g;
  };
  parts.armL = arm(-1);
  parts.armR = arm(1);
  // LEGS: wooden shin (in the robe's shadow) + strapped sandal.
  const leg = () => {
    const shin = shade(T(prep(new CylinderGeometry(0.06, 0.052, 0.8, 6, 1, true), 'limb'), 0, -0.42, 0), (x, y) => 0.45 + 0.4 * sm(-0.3, -0.8, y));
    const sandal = shade(T(prep(new BoxGeometry(0.13, 0.045, 0.28), 'sandal'), 0, -0.82, 0.05), flat(0.9));
    return mergeGeometries([shin, sandal]);
  };
  parts.legL = leg();
  parts.legR = leg();
  // BAT: thick tapered club along +Y from the grip.
  {
    const shaft = shade(T(prep(new CylinderGeometry(0.075, 0.03, 1.0, 8, 1, true), 'bat'), 0, 0.4, 0), (x, y) => 0.85 + 0.15 * sm(-0.1, 0.9, y));
    const end = shade(disc(0.075, 8, 0.9, 'endgrain', true), flat(1));
    const knob = shade(T(prep(new CylinderGeometry(0.048, 0.048, 0.045, 6, 1, false), 'bat'), 0, -0.12, 0), flat(0.8));
    parts.bat = mergeGeometries([shaft, end, knob]);
  }
  // Silhouette LOD: whole goon in a neutral pose, very few segments.
  {
    const lowLog = shade(T(faceLog(0.19, 0.7, 5, 0.9), 0, PIVOT.head[1] + 0.35, 0), flat(1));
    const lowBody = shade(T(prep(new CylinderGeometry(0.22, 0.37, 1.25, 5, 1, true), 'robe'), 0, 0.95, 0), (x, y) => 0.65 + 0.35 * sm(0.3, 1.2, y));
    const lowLegs = shade(T(prep(new BoxGeometry(0.3, 0.4, 0.12), 'limb'), 0, 0.2, 0), flat(0.5));
    const lowArms = shade(T(prep(new BoxGeometry(0.78, 0.14, 0.14), 'robe'), 0, 1.25, 0.05), flat(0.85));
    const lowBat = shade(T(prep(new BoxGeometry(0.08, 0.08, 1.0), 'bat'), 0.33, 0.9, 0.35), flat(0.9));
    parts.silhouette = mergeGeometries([lowLog, lowBody, lowLegs, lowArms, lowBat]);
  }
  for (const k in parts) {
    for (const name of Object.keys(parts[k].attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'aShade') parts[k].deleteAttribute(name);
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
