import {
  BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CylinderGeometry, Group,
  InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry, ShaderMaterial,
  SRGBColorSpace, Vector3, Quaternion, InstancedBufferGeometry, InstancedBufferAttribute,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { WORLD } from '../config.js';
import { mulberry32 } from '../core/rand.js';
import { COMMON_GLSL, U } from './shared.js';
import { SpriteBatch } from '../fx/sprites.js';

// ---------------------------------------------------------------------------
// Facade shader: one material for every building. Windows are procedural
// (tiled by world-space metres), lit windows are emissive, glass vs concrete is
// a per-vertex attribute, fake AO is baked into a per-vertex float.
// ---------------------------------------------------------------------------
const facadeVS = /* glsl */ `
attribute float aAo;
attribute float aTop; // world height of this box's roof line
attribute vec4 aFacade; // type (0 concrete, 1 glass), seed, palette, window spacing
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vAo;
flat varying float vTop; // flat: interpolation noise would flip per-window hashes
flat varying vec4 vFacade;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normal;
  vUv = uv;
  vAo = aAo;
  vTop = aTop;
  vFacade = aFacade;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const facadeFS = /* glsl */ `
${COMMON_GLSL}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vAo;
flat varying float vTop; // flat: interpolation noise would flip per-window hashes
flat varying vec4 vFacade;
// Box-filtered 1-D pulse (1 inside [a,b] of a unit cell), width w = fwidth(x).
float pulse(float a, float b, float x, float w) {
  float x0 = x - w * 0.5, x1 = x + w * 0.5;
  float inside = max(0.0, min(x1, b) - max(x0, a));
  inside += max(0.0, min(x1, b - 1.0) - max(x0, a - 1.0)) + max(0.0, min(x1, b + 1.0) - max(x0, a + 1.0));
  return clamp(inside / w, 0.0, 1.0);
}
vec3 stonePalette(float p) {
  if (p < 1.0) return vec3(0.68, 0.6, 0.48);   // sandstone
  if (p < 2.0) return vec3(0.78, 0.76, 0.72);  // white stone
  if (p < 3.0) return vec3(0.56, 0.29, 0.22);  // red brick
  if (p < 4.0) return vec3(0.33, 0.33, 0.36);  // dark granite
  return vec3(0.55, 0.53, 0.5);                // grey concrete
}
vec3 glassPalette(float p) {
  if (p < 1.0) return vec3(0.07, 0.15, 0.27);  // blue
  if (p < 2.0) return vec3(0.07, 0.2, 0.2);    // teal
  if (p < 3.0) return vec3(0.2, 0.14, 0.08);   // bronze
  return vec3(0.05, 0.06, 0.08);               // black
}
void main() {
  vec3 N = normalize(vNormal);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 col;
  float glass = vFacade.x;
  float seed = vFacade.y;
  float pal = floor(vFacade.z * 4.999);
  float h = vUv.y;
  vec3 diffuse = lightDiffuse(N);
  vec3 stone = stonePalette(pal) * (0.92 + 0.16 * fract(seed * 7.3));
  if (N.y > 0.5) {
    // Roof: gravel with tar patches and a lighter coping strip.
    vec2 c = floor(vUv * 0.5);
    float n = hash12(c + seed * 91.0);
    col = vec3(0.3, 0.29, 0.28) * (0.8 + 0.3 * n);
    if (vWorld.y > vTop + 0.5) col = stone * 1.05; // parapet coping
    col *= diffuse;
  } else if (h > vTop - 0.01) {
    // Parapet: plain wall with a lit coping line on top.
    float coping = smoothstep(vTop + 0.95, vTop + 1.05, h);
    col = mix(stone * 0.85, stone * 1.15, coping) * diffuse;
  } else {
    vec2 cellSize = vec2(vFacade.w, 3.6);
    vec2 cell = vUv / cellSize;
    vec2 f = fract(cell);
    vec2 id = floor(cell);
    vec2 fw = max(fwidth(cell), vec2(1e-4));
    float aa = clamp(1.0 - max(fw.x, fw.y) * 1.2, 0.0, 1.0);
    vec3 R = reflect(-V, N);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    float litRnd = hash12(id + seed * 57.0);
    float lit = step(0.85, litRnd);
    vec3 litCol = mix(vec3(1.0, 0.7, 0.38), vec3(1.0, 0.9, 0.75), fract(litRnd * 13.0)) * 1.25;
    vec3 sky = skyReflect(R);
    if (h < 4.6) {
      // Ground floor shopfronts: big warm-lit panes under a coloured sign band.
      float sid = floor(vUv.x / (vFacade.w * 2.0));
      float fx = fract(vUv.x / (vFacade.w * 2.0));
      float fwx = max(fwidth(vUv.x / (vFacade.w * 2.0)), 1e-4);
      float pane = pulse(0.06, 0.94, fx, fwx) * (1.0 - smoothstep(3.3, 3.4, h)) * step(0.25, h);
      float shopLit = step(0.35, hash12(vec2(sid, seed * 13.0)));
      vec3 signCol = mix(vec3(0.8, 0.2, 0.15), vec3(0.15, 0.5, 0.8), hash12(vec2(sid * 3.1, seed)));
      vec3 inside = mix(vec3(0.04), vec3(1.0, 0.78, 0.5) * 0.9, shopLit);
      col = mix(stone * 0.7 * diffuse, inside + sky * 0.15 * fres, pane);
      float sign = smoothstep(3.5, 3.55, h) * (1.0 - smoothstep(4.25, 4.3, h));
      col = mix(col, signCol * (0.5 + 0.8 * shopLit), sign);
    } else if (glass > 0.5) {
      // Curtain wall: tinted panes, opaque spandrel band per floor, mullions.
      vec3 tint = glassPalette(floor(vFacade.z * 3.999)) * (0.85 + 0.3 * hash12(id * 1.7 + seed));
      float mx = pulse(0.05, 0.95, f.x, fw.x);
      float vis = pulse(0.22, 0.95, f.y, fw.y);
      float pane = mix(0.7, mx * vis, aa);
      vec3 glassCol = tint * diffuse * 0.5 + sky * (0.2 + 0.75 * fres);
      vec3 spandrel = tint * 1.6 * diffuse + sky * 0.1;
      vec3 frame = vec3(0.3, 0.31, 0.33) * diffuse;
      col = mix(mix(frame, spandrel, mix(0.5, mx, aa)), glassCol, pane);
      col += litCol * 0.6 * mix(0.15 * 0.7, lit * pane, aa);
    } else {
      // Masonry: recessed punched windows, floor ledges, pilasters, blinds.
      float pil = step(3.0, mod(id.x, 4.0)) * step(60.0, vTop);
      float wx = pulse(0.22, 0.78, f.x, fw.x) * (1.0 - pil);
      float wy = pulse(0.3, 0.85, f.y, fw.y);
      float w = wx * wy;
      float ledge = pulse(0.0, 0.07, f.y, fw.y);
      float underLedge = pulse(0.07, 0.13, f.y, fw.y);
      vec3 wall = stone * diffuse * (1.0 + 0.15 * ledge - 0.18 * underLedge) * (1.0 - 0.06 * pil);
      // recess shadow at the top of each window, blinds in some windows
      float recess = smoothstep(0.7, 0.85, f.y);
      float blind = step(0.72, hash12(id * 2.3 + seed)) * step(1.0 - fract(litRnd * 7.0) * 0.6, f.y + 0.3);
      vec3 winCol = vec3(0.04, 0.05, 0.07) + sky * (0.12 + 0.6 * fres);
      winCol = mix(winCol, vec3(0.62, 0.57, 0.48) * diffuse * 0.8, blind * (1.0 - lit));
      winCol *= 1.0 - 0.5 * recess;
      col = mix(wall, winCol, mix(0.3, w, aa));
      col += litCol * mix(0.15 * 0.3, lit * w * (1.0 - 0.4 * recess), aa);
    }
    // Crown: lit strip just under the roof of tall buildings.
    float crown = step(90.0, vTop) * smoothstep(vTop - 1.6, vTop - 1.4, h) * (1.0 - smoothstep(vTop - 0.9, vTop - 0.7, h));
    col = mix(col, vec3(1.0, 0.92, 0.78) * 1.2, crown * 0.85);
    // Weathering streaks.
    col *= 0.93 + 0.07 * hash12(vec2(floor(vUv.x * 0.8), seed * 31.0));
  }
  col *= vAo;
  col = min(col, vec3(1.0));
  col = applyFog(col, dist, -V);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

// Ground: roads, sidewalks, lane markings and beach, all procedural.
const groundFS = /* glsl */ `
${COMMON_GLSL}
uniform vec4 uCity; // minX, minZ, size, pitch
uniform vec2 uRoad; // road half width, sidewalk half width
uniform float uCoastZ;
varying vec3 vWorld;
float roadLine(float c, float pitch) { float l = mod(c, pitch); return min(l, pitch - l); }
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec2 p = vWorld.xz;
  vec2 lp = p - uCity.xy;
  bool inCity = lp.x > -12.0 && lp.y > -12.0 && lp.x < uCity.z + 12.0 && lp.y < uCity.z + 12.0;
  vec3 col;
  float n = hash12(floor(p * 0.25));
  if (inCity) {
    float dx = roadLine(lp.x, uCity.w), dz = roadLine(lp.y, uCity.w);
    float d = min(dx, dz);
    float fwd = fwidth(d);
    float road = 1.0 - smoothstep(uRoad.x - fwd, uRoad.x + fwd, d);
    float walk = 1.0 - smoothstep(uRoad.y - fwd, uRoad.y + fwd, d);
    vec3 asphalt = vec3(0.13, 0.13, 0.14) * (0.9 + 0.2 * n);
    vec3 pave = vec3(0.45, 0.43, 0.4);
    vec3 plaza = vec3(0.38, 0.37, 0.35) * (0.9 + 0.15 * n);
    col = mix(plaza, pave, walk);
    col = mix(col, asphalt, road);
    // dashed centre lines
    float along = dx < dz ? lp.y : lp.x;
    float cd = dx < dz ? dx : dz;
    float dash = step(fract(along / 6.0), 0.5) * (1.0 - smoothstep(0.12, 0.12 + fwd * 2.0, cd));
    float crossing = step(uRoad.x, max(dx, dz));
    col = mix(col, vec3(0.75, 0.62, 0.3), dash * crossing * clamp(1.0 - fwd * 3.0, 0.0, 1.0));
  } else {
    col = mix(vec3(0.2, 0.24, 0.12), vec3(0.28, 0.26, 0.15), n);
  }
  float beach = 1.0 - smoothstep(uCoastZ + 8.0, uCoastZ + 30.0, p.y);
  col = mix(col, vec3(0.7, 0.6, 0.45), beach);
  col *= lightDiffuse(vec3(0.0, 1.0, 0.0));
  col = applyFog(col, dist, -toCam / dist);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const worldVS = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// ---------------------------------------------------------------------------

class ChunkBuilder {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.ao = []; this.top = []; this.fac = []; this.idx = [];
    this.curTop = 0;
    this.v = 0;
  }
  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, uvs, aos, fac) {
    // Order so the face winds CCW when seen along -normal.
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const cxp = e1y * e2z - e1z * e2y, cyp = e1z * e2x - e1x * e2z, czp = e1x * e2y - e1y * e2x;
    const flip = cxp * nx + cyp * ny + czp * nz < 0;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 4; i++) {
      this.nrm.push(nx, ny, nz);
      this.fac.push(fac[0], fac[1], fac[2], fac[3]);
      this.top.push(this.curTop);
    }
    this.uv.push(...uvs);
    this.ao.push(...aos);
    const v = this.v;
    if (flip) this.idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    else this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    this.v += 4;
  }
  // Box with walls split at +6 m so AO can darken the base, plus a 1.1 m
  // parapet around the roof (outer + inner faces, visual only).
  box(x0, y0, z0, x1, y1, z1, fac, baseAo) {
    this.curTop = y1;
    const P = 1.1, T = 0.35;
    const ys = [y0, Math.min(y0 + 6, y1), y1, y1 + P];
    const aoAt = (y) => (y <= y0 + 0.01 ? baseAo : 1);
    const wx = x1 - x0, wz = z1 - z0;
    for (let r = 0; r < 3; r++) {
      const ya = ys[r], yb = ys[r + 1];
      if (yb - ya < 0.01) continue;
      const aa = aoAt(ya), ab = aoAt(yb);
      this.quad(x1, ya, z1, x1, ya, z0, x1, yb, z0, x1, yb, z1, 1, 0, 0,
        [0, ya, wz, ya, wz, yb, 0, yb], [aa, aa, ab, ab], fac);
      this.quad(x0, ya, z0, x0, ya, z1, x0, yb, z1, x0, yb, z0, -1, 0, 0,
        [0, ya, wz, ya, wz, yb, 0, yb], [aa, aa, ab, ab], fac);
      this.quad(x0, ya, z1, x1, ya, z1, x1, yb, z1, x0, yb, z1, 0, 0, 1,
        [0, ya, wx, ya, wx, yb, 0, yb], [aa, aa, ab, ab], fac);
      this.quad(x1, ya, z0, x0, ya, z0, x0, yb, z0, x1, yb, z0, 0, 0, -1,
        [0, ya, wx, ya, wx, yb, 0, yb], [aa, aa, ab, ab], fac);
    }
    // parapet inner faces (facing inward) and coping tops
    const ix0 = x0 + T, ix1 = x1 - T, iz0 = z0 + T, iz1 = z1 - T, yt = y1 + P;
    const ai = 0.8;
    this.quad(ix1, y1, iz0, ix1, y1, iz1, ix1, yt, iz1, ix1, yt, iz0, -1, 0, 0, [0, y1, wz, y1, wz, yt, 0, yt], [ai, ai, 1, 1], fac);
    this.quad(ix0, y1, iz1, ix0, y1, iz0, ix0, yt, iz0, ix0, yt, iz1, 1, 0, 0, [0, y1, wz, y1, wz, yt, 0, yt], [ai, ai, 1, 1], fac);
    this.quad(ix0, y1, iz0, ix1, y1, iz0, ix1, yt, iz0, ix0, yt, iz0, 0, 0, 1, [0, y1, wx, y1, wx, yt, 0, yt], [ai, ai, 1, 1], fac);
    this.quad(ix1, y1, iz1, ix0, y1, iz1, ix0, yt, iz1, ix1, yt, iz1, 0, 0, -1, [0, y1, wx, y1, wx, yt, 0, yt], [ai, ai, 1, 1], fac);
    this.quad(x0, yt, z1, x1, yt, z1, x1, yt, iz1, x0, yt, iz1, 0, 1, 0, [x0, z1, x1, z1, x1, iz1, x0, iz1], [1, 1, 1, 1], fac);
    this.quad(x0, yt, iz0, x1, yt, iz0, x1, yt, z0, x0, yt, z0, 0, 1, 0, [x0, iz0, x1, iz0, x1, z0, x0, z0], [1, 1, 1, 1], fac);
    this.quad(x0, yt, iz1, ix0, yt, iz1, ix0, yt, iz0, x0, yt, iz0, 0, 1, 0, [x0, iz1, ix0, iz1, ix0, iz0, x0, iz0], [1, 1, 1, 1], fac);
    this.quad(ix1, yt, iz1, x1, yt, iz1, x1, yt, iz0, ix1, yt, iz0, 0, 1, 0, [ix1, iz1, x1, iz1, x1, iz0, ix1, iz0], [1, 1, 1, 1], fac);
    // roof
    this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0,
      [x0, z1, x1, z1, x1, z0, x0, z0], [0.9, 0.9, 0.9, 0.9], fac);
  }
  geometry() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aAo', new BufferAttribute(new Float32Array(this.ao), 1));
    g.setAttribute('aTop', new BufferAttribute(new Float32Array(this.top), 1));
    g.setAttribute('aFacade', new BufferAttribute(new Float32Array(this.fac), 4));
    g.setIndex(this.v > 65535 ? new BufferAttribute(new Uint32Array(this.idx), 1) : new BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function helipadTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#3a3d40'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#e8e2d0'; g.lineWidth = 6;
  g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#e8e2d0';
  g.fillRect(40, 34, 12, 60); g.fillRect(76, 34, 12, 60); g.fillRect(40, 58, 48, 12);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Returns { group, chunks[], roofs[], startPos, startYaw, lights, stats }
export function buildCity(scene, collision) {
  const rnd = mulberry32(WORLD.seed);
  const half = WORLD.citySize / 2;
  const pitch = WORLD.blockSize + WORLD.roadWidth;
  const nBlocks = Math.floor(WORLD.citySize / pitch);
  const cs = WORLD.chunkSize;
  const nChunks = Math.ceil(WORLD.citySize / cs);
  const builders = [];
  for (let i = 0; i < nChunks * nChunks; i++) builders.push(new ChunkBuilder());

  const roofs = []; // { box, x, z, y, hx, hz }
  const acs = [], tanks = [], pads = [], antennas = [];
  const [dtx, dtz] = WORLD.downtown;
  const startTarget = new Vector3(0, 0, 230);
  let start = null, startD = Infinity;

  const addBuilding = (x0, z0, x1, z1, height, glass, facSeed) => {
    const fac = [glass ? 1 : 0, facSeed, rnd(), glass ? 3.0 : 2.6 + rnd() * 1.4];
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const ci = Math.min(nChunks - 1, Math.max(0, Math.floor((cx + half) / cs)));
    const cj = Math.min(nChunks - 1, Math.max(0, Math.floor((cz + half) / cs)));
    const b = builders[cj * nChunks + ci];
    // Setback tiers for tall towers.
    let tiers = height > 110 ? 3 : height > 60 ? 2 : 1;
    let y = 0, ax0 = x0, az0 = z0, ax1 = x1, az1 = z1;
    for (let t = 0; t < tiers; t++) {
      const frac = tiers === 1 ? 1 : t === 0 ? 0.55 + rnd() * 0.15 : t === tiers - 1 ? 1 : 0.8;
      const top = t === tiers - 1 ? height : Math.max(y + 12, Math.round(height * frac / 3.6) * 3.6);
      b.box(ax0, y, az0, ax1, top, az1, fac, t === 0 ? 0.42 : 0.72);
      const box = collision.addBox(ax0, y, az0, ax1, top, az1);
      roofs.push({ box, x: (ax0 + ax1) / 2, z: (az0 + az1) / 2, y: top, hx: (ax1 - ax0) / 2, hz: (az1 - az0) / 2 });
      y = top;
      const ix = Math.min((ax1 - ax0) * 0.15, 6) + 2, iz = Math.min((az1 - az0) * 0.15, 6) + 2;
      if (ax1 - ax0 - ix * 2 < 10 || az1 - az0 - iz * 2 < 10) break;
      ax0 += ix; ax1 -= ix; az0 += iz; az1 -= iz;
    }
    const roof = roofs[roofs.length - 1];
    const d = Math.hypot(roof.x - startTarget.x, roof.z - startTarget.z);
    if (roof.y > 40 && roof.y < 90 && roof.hx > 10 && roof.hz > 10 && d < startD) { startD = d; start = roof; }
    return roof;
  };

  for (let bj = 0; bj < nBlocks; bj++) {
    for (let bi = 0; bi < nBlocks; bi++) {
      const bx0 = -half + bi * pitch + WORLD.roadWidth / 2;
      const bz0 = -half + bj * pitch + WORLD.roadWidth / 2;
      const bx1 = bx0 + WORLD.blockSize, bz1 = bz0 + WORLD.blockSize;
      if (bz0 < WORLD.coastZ + 40) continue; // waterfront promenade
      const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
      const d = Math.hypot(cx - dtx, cz - dtz);
      const tower = Math.exp(-(d * d) / (2 * 300 * 300));
      if (rnd() < 0.05 && tower < 0.5) continue; // park / plaza
      const inset = 3;
      if (tower > 0.45 && rnd() < 0.7) {
        // Downtown: one or two big towers per block.
        const split = rnd() < 0.45;
        const lots = split
          ? [[bx0 + inset, bz0 + inset, bx1 - inset, (bz0 + bz1) / 2 - 2], [bx0 + inset, (bz0 + bz1) / 2 + 2, bx1 - inset, bz1 - inset]]
          : [[bx0 + inset + rnd() * 6, bz0 + inset + rnd() * 6, bx1 - inset - rnd() * 6, bz1 - inset - rnd() * 6]];
        for (const l of lots) {
          const h = Math.round((100 + 200 * tower * Math.pow(rnd(), 0.6)) / 3.6) * 3.6;
          addBuilding(l[0], l[1], l[2], l[3], h, rnd() < 0.75, rnd());
        }
      } else {
        // Low / mid rise: 2x2 lots.
        const mx = (bx0 + bx1) / 2, mz = (bz0 + bz1) / 2;
        const lots = [[bx0, bz0, mx, mz], [mx, bz0, bx1, mz], [bx0, mz, mx, bz1], [mx, mz, bx1, bz1]];
        for (const l of lots) {
          if (rnd() < 0.08) continue;
          const x0 = l[0] + inset + rnd() * 2, z0 = l[1] + inset + rnd() * 2;
          const x1 = l[2] - inset - rnd() * 2, z1 = l[3] - inset - rnd() * 2;
          const base = 10 + 50 * tower + rnd() * 25 * (0.4 + tower);
          const h = Math.max(7.2, Math.round(base / 3.6) * 3.6);
          const roof = addBuilding(x0, z0, x1, z1, h, rnd() < 0.2 + tower * 0.4, rnd());
          // Rooftop props on low roofs.
          const nAc = Math.floor(rnd() * 3);
          for (let a = 0; a < nAc; a++) {
            acs.push([roof.x + (rnd() - 0.5) * roof.hx, roof.y, roof.z + (rnd() - 0.5) * roof.hz, rnd() * Math.PI]);
          }
          if (rnd() < 0.15 && roof.y < 70) {
            const tx = roof.x + (rnd() - 0.5) * roof.hx * 0.8, tz = roof.z + (rnd() - 0.5) * roof.hz * 0.8;
            tanks.push([tx, roof.y, tz]);
            collision.addBox(tx - 2, roof.y, tz - 2, tx + 2, roof.y + 7, tz + 2);
          }
        }
      }
    }
  }

  // Tall roofs: helipads and antennas.
  for (const r of roofs) {
    if (r.y < 100) continue;
    if (rnd() < 0.3 && r.hx > 9 && r.hz > 9) pads.push([r.x, r.y, r.z, Math.min(r.hx, r.hz) * 0.8]);
    else if (rnd() < 0.5) antennas.push([r.x + (rnd() - 0.5) * r.hx, r.y, r.z + (rnd() - 0.5) * r.hz, 10 + rnd() * 25]);
  }
  if (!start) start = roofs[0];
  pads.push([start.x, start.y, start.z, Math.min(start.hx, start.hz, 12) * 0.85]);

  collision.build();

  const group = new Group();
  group.name = 'city';
  const facadeMat = new ShaderMaterial({
    uniforms: U,
    vertexShader: facadeVS,
    fragmentShader: facadeFS,
  });
  const chunks = [];
  let tris = 0;
  for (let j = 0; j < nChunks; j++) {
    for (let i = 0; i < nChunks; i++) {
      const b = builders[j * nChunks + i];
      if (b.v === 0) continue;
      const geo = b.geometry();
      tris += b.idx.length / 3;
      const m = new Mesh(geo, facadeMat);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.name = `chunk_${i}_${j}`;
      group.add(m);
      chunks.push({ mesh: m, box: geo.boundingBox });
    }
  }

  // Ground (land) plane.
  const groundGeo = new PlaneGeometry(4200, 2600 + 1600, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);
  groundGeo.translate(0, 0, WORLD.coastZ + (2600 + 1600) / 2);
  const groundMat = new ShaderMaterial({
    uniforms: {
      ...U,
      uCity: { value: [-half, -half, WORLD.citySize, pitch] },
      uRoad: { value: [WORLD.roadWidth / 2, WORLD.roadWidth / 2 + 3] },
      uCoastZ: { value: WORLD.coastZ },
    },
    vertexShader: worldVS,
    fragmentShader: groundFS,
  });
  const ground = new Mesh(groundGeo, groundMat);
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();
  group.add(ground);

  // Rooftop props (instanced, lambert, fogged).
  const m4 = new Matrix4(), q = new Quaternion(), s = new Vector3(), p = new Vector3(), up = new Vector3(0, 1, 0);
  const mkInst = (geo, mat, list, fn) => {
    const im = new InstancedMesh(geo, mat, Math.max(1, list.length));
    list.forEach((it, k) => { fn(it); im.setMatrixAt(k, m4.compose(p, q, s)); });
    im.count = list.length;
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.matrixAutoUpdate = false;
    group.add(im);
    tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3 * list.length;
    return im;
  };
  const propMat = new MeshLambertMaterial({ color: 0x8a8580 });
  const acGeo = new BoxGeometry(2.2, 1.3, 1.6); acGeo.translate(0, 0.65, 0);
  mkInst(acGeo, propMat, acs, (a) => { p.set(a[0], a[1], a[2]); q.setFromAxisAngle(up, a[3]); s.set(1, 1, 1); });
  const tankGeo = mergeGeometries([
    new CylinderGeometry(1.8, 1.8, 4, 10, 1, false).translate(0, 3.2, 0),
    new CylinderGeometry(0.2, 2.0, 1.6, 10, 1, true).translate(0, 6.0, 0),
    new BoxGeometry(2.6, 1.2, 0.2).translate(0, 0.6, 0),
    new BoxGeometry(0.2, 1.2, 2.6).translate(0, 0.6, 0),
  ].map((g) => g.toNonIndexed()));
  const tankMat = new MeshLambertMaterial({ color: 0x8a7a6a });
  mkInst(tankGeo, tankMat, tanks, (t) => { p.set(t[0], t[1], t[2]); q.identity(); s.set(1, 1, 1); });
  const padGeo = new CylinderGeometry(1, 1, 0.3, 20, 1);
  padGeo.translate(0, 0.15, 0);
  const padMat = new MeshLambertMaterial({ map: helipadTexture() });
  // Map the top cap to the H texture: CylinderGeometry cap uvs already form a disc.
  mkInst(padGeo, padMat, pads, (h) => { p.set(h[0], h[1], h[2]); q.identity(); s.set(h[3], 1, h[3]); });
  const antGeo = new CylinderGeometry(0.15, 0.4, 1, 5, 1);
  antGeo.translate(0, 0.5, 0);
  const antMat = new MeshBasicMaterial({ color: 0x222222 });
  mkInst(antGeo, antMat, antennas, (a) => { p.set(a[0], a[1], a[2]); q.identity(); s.set(1, a[3], 1); });

  // Streetlights: poles + emissive heads (no real lights), one instanced mesh.
  const pole = new BoxGeometry(0.18, 7, 0.18).translate(0, 3.5, 0).toNonIndexed();
  const arm = new BoxGeometry(1.6, 0.14, 0.14).translate(0.8, 7, 0).toNonIndexed();
  const head = new BoxGeometry(0.7, 0.2, 0.35).translate(1.5, 6.88, 0).toNonIndexed();
  const colorize = (g, r, gg, bb) => {
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) { c[k * 3] = r; c[k * 3 + 1] = gg; c[k * 3 + 2] = bb; }
    g.setAttribute('color', new BufferAttribute(c, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const lampGeo = mergeGeometries([colorize(pole, 0.12, 0.12, 0.13), colorize(arm, 0.12, 0.12, 0.13), colorize(head, 1.6, 1.25, 0.8)]);
  const lampMat = new MeshBasicMaterial({ vertexColors: true });
  const lamps = [];
  const off = WORLD.roadWidth / 2 + 1.5;
  for (let k = 0; k <= nBlocks; k++) {
    const line = -half + k * pitch;
    for (let t = -half + 20; t < half; t += 40) {
      if (t > WORLD.coastZ) lamps.push([line + off, t, Math.PI]);
      if (line > WORLD.coastZ) lamps.push([t, line + off, Math.PI / 2]);
    }
  }
  mkInst(lampGeo, lampMat, lamps, (l) => { p.set(l[0], 0, l[1]); q.setFromAxisAngle(up, l[2]); s.set(1, 1, 1); });

  // Static glows: warm streetlight heads + red aviation lights on towers.
  // Filled once, uploaded once, one additive draw call.
  const avi = roofs.filter((r) => r.y > 110);
  const glows = new SpriteBatch(lamps.length + avi.length * 4 + antennas.length);
  glows.begin();
  for (const l of lamps) {
    const hx = l[0] + Math.cos(l[2]) * 1.5, hz = l[1] - Math.sin(l[2]) * 1.5;
    glows.pushPoint(hx, 6.75, hz, 0.9, 1.0, 0.62, 0.3, 0.55, 0.3);
  }
  for (const r of avi) {
    const y = r.y + 1.4;
    glows.pushPoint(r.x - r.hx + 0.5, y, r.z - r.hz + 0.5, 1.6, 1.0, 0.08, 0.05, 0.9, 0.35);
    glows.pushPoint(r.x + r.hx - 0.5, y, r.z + r.hz - 0.5, 1.6, 1.0, 0.08, 0.05, 0.9, 0.35);
  }
  for (const a of antennas) glows.pushPoint(a[0], a[1] + a[3], a[2], 2.2, 1.0, 0.1, 0.05, 1, 0.4);
  glows.end();
  glows.mesh.renderOrder = 9;
  group.add(glows.mesh);

  group.add(buildTraffic(half, pitch, nBlocks));

  scene.add(group);
  const startPos = new Vector3(start.x, start.y, start.z);
  return {
    group, chunks, roofs, startPos, startYaw: 0,
    stats: { buildings: roofs.length, chunks: chunks.length, tris: Math.round(tris), lamps: lamps.length, boxes: collision.boxCount },
  };
}

// Per-frame chunk distance culling (frustum culling is done by three.js).
const _cp = new Vector3();
export function cullChunks(city, camPos, maxDist) {
  for (let i = 0; i < city.chunks.length; i++) {
    const c = city.chunks[i];
    c.box.clampPoint(camPos, _cp);
    c.mesh.visible = _cp.distanceToSquared(camPos) < maxDist * maxDist;
  }
}

// ---------------------------------------------------------------------------
// Traffic: cars animated entirely in the vertex shader (position along a road
// line = fract(offset + time * speed)), one instanced draw call, zero CPU.
// ---------------------------------------------------------------------------
const trafficVS = /* glsl */ `
${COMMON_GLSL}
attribute vec4 aLane; // origin x, origin z, axis (0 = along x, 1 = along z), length
attribute vec4 aCar;  // phase, speed (m/s, signed = direction), lane offset, colour seed
varying vec3 vCol;
varying vec3 vWorld;
varying vec3 vN;
varying float vLight; // 1 head, -1 tail
void main() {
  float dir = sign(aCar.y);
  float along = fract(aCar.x + uTime * aCar.y / aLane.w) * aLane.w;
  vec3 p = position;
  vec3 n = normal;
  // local car: length along +x, front at +x. Flip for the opposite direction.
  p.x *= dir; n.x *= dir;
  vec3 wp;
  if (aLane.z < 0.5) {
    wp = vec3(aLane.x + along + p.x, p.y, aLane.y + aCar.z + p.z);
    vN = n;
  } else {
    wp = vec3(aLane.x + aCar.z + p.z, p.y, aLane.y + along + p.x);
    vN = vec3(n.z, n.y, n.x);
  }
  float s = aCar.w;
  vCol = s < 0.25 ? vec3(0.75, 0.1, 0.08) : s < 0.5 ? vec3(0.9, 0.9, 0.88) : s < 0.7 ? vec3(0.1, 0.1, 0.12) : s < 0.85 ? vec3(0.15, 0.3, 0.6) : vec3(0.95, 0.75, 0.1);
  vLight = (position.y > 0.55 && position.y < 0.95) ? (normal.x * dir > 0.9 ? 1.0 : (normal.x * dir < -0.9 ? -1.0 : 0.0)) : 0.0;
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const trafficFS = /* glsl */ `
${COMMON_GLSL}
varying vec3 vCol;
varying vec3 vWorld;
varying vec3 vN;
varying float vLight;
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 N = normalize(vN);
  vec3 col = vCol * lightDiffuse(N);
  if (N.y > 0.5) col = mix(col, vec3(0.08, 0.1, 0.13), 0.55); // windscreen / roof glass
  if (vLight > 0.5) col = vec3(1.0, 0.95, 0.8);
  if (vLight < -0.5) col = vec3(1.0, 0.1, 0.05);
  col = applyFog(col, dist, -toCam / dist);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

function buildTraffic(half, pitch, nBlocks) {
  const rnd = mulberry32(WORLD.seed + 7);
  const body = new BoxGeometry(4.2, 1.1, 1.9).translate(0, 0.75, 0);
  const cabin = new BoxGeometry(2.2, 0.6, 1.7).translate(-0.3, 1.6, 0);
  const car = mergeGeometries([body.toNonIndexed(), cabin.toNonIndexed()]);
  car.deleteAttribute('uv');
  const lanes = [], cars = [];
  const zStart = Math.max(-half, WORLD.coastZ + 20);
  for (let k = 0; k <= nBlocks; k++) {
    const line = -half + k * pitch;
    // along x (road at z = line), and along z (road at x = line)
    const defs = [];
    if (line > WORLD.coastZ + 20) defs.push([-half, line, 0, half * 2]);
    defs.push([line, zStart, 1, half - zStart]);
    for (const d of defs) {
      for (let c = 0; c < 10; c++) {
        const fwd = c % 2 === 0;
        const laneOff = fwd ? (c % 4 === 0 ? 2.2 : 5.4) : (c % 4 === 1 ? -2.2 : -5.4);
        lanes.push(d[0], d[1], d[2], d[3]);
        cars.push(rnd(), (fwd ? 1 : -1) * (9 + rnd() * 8) * (d[2] < 0.5 ? 1 : -1) * (laneOff > 0 ? 1 : 1), laneOff, rnd());
      }
    }
  }
  // Right-hand traffic: lane sign decides direction.
  for (let i = 0; i < cars.length; i += 4) {
    const off = cars[i + 2];
    const axis = lanes[i + 2];
    const sp = Math.abs(cars[i + 1]);
    cars[i + 1] = (axis < 0.5 ? (off > 0 ? 1 : -1) : (off > 0 ? -1 : 1)) * sp;
  }
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', car.attributes.position);
  g.setAttribute('normal', car.attributes.normal);
  g.setAttribute('aLane', new InstancedBufferAttribute(new Float32Array(lanes), 4));
  g.setAttribute('aCar', new InstancedBufferAttribute(new Float32Array(cars), 4));
  g.instanceCount = cars.length / 4;
  const m = new Mesh(g, new ShaderMaterial({ uniforms: U, vertexShader: trafficVS, fragmentShader: trafficFS }));
  m.frustumCulled = false;
  m.name = 'traffic';
  return m;
}
