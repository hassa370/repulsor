import {
  BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CylinderGeometry, DoubleSide, Group,
  InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, PlaneGeometry, ShaderMaterial,
  SRGBColorSpace, Vector3, Quaternion,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { WORLD } from '../config.js';
import { mulberry32 } from '../core/rand.js';
import { COMMON_GLSL, U } from './shared.js';

// ---------------------------------------------------------------------------
// Facade shader: one material for every building. Windows are procedural
// (tiled by world-space metres), lit windows are emissive, glass vs concrete is
// a per-vertex attribute, fake AO is baked into a per-vertex float.
// ---------------------------------------------------------------------------
const facadeVS = /* glsl */ `
attribute float aAo;
attribute vec4 aFacade; // type (0 concrete, 1 glass), seed, hue, window spacing
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
varying float vAo;
varying vec4 vFacade;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normal;
  vUv = uv;
  vAo = aAo;
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
varying vec4 vFacade;
void main() {
  vec3 N = normalize(vNormal);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 col;
  float glass = vFacade.x;
  float seed = vFacade.y;
  float hue = vFacade.z;
  if (N.y > 0.5) {
    // Roof: gravel with a few tar patches.
    vec2 c = floor(vUv * 0.5);
    float n = hash12(c + seed * 91.0);
    col = vec3(0.32, 0.31, 0.3) * (0.85 + 0.25 * n) * lightDiffuse(N);
  } else {
    vec2 cellSize = vec2(vFacade.w, 3.6);
    vec2 cell = vUv / cellSize;
    vec2 f = fract(cell);
    vec2 id = floor(cell);
    vec2 fw = fwidth(cell);
    float aa = clamp(1.0 - max(fw.x, fw.y) * 1.6, 0.0, 1.0);
    vec3 diffuse = lightDiffuse(N);
    vec3 R = reflect(-V, N);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    float litRnd = hash12(id + seed * 57.0);
    float lit = step(0.86, litRnd) * step(1.0, vUv.y - 0.5);
    vec3 litCol = mix(vec3(1.0, 0.72, 0.4), vec3(1.0, 0.88, 0.7), fract(litRnd * 13.0)) * 1.3;
    if (glass > 0.5) {
      // Curtain wall: thin mullions, reflective tinted glass.
      vec2 m = step(vec2(0.06, 0.1), f) * step(f, vec2(0.94, 0.9));
      float pane = mix(0.8, m.x * m.y, aa);
      vec3 tint = mix(vec3(0.1, 0.16, 0.22), vec3(0.18, 0.15, 0.12), hue);
      vec3 glassCol = tint * diffuse * 0.5 + skyReflect(R) * (0.25 + 0.7 * fres);
      vec3 frame = vec3(0.35, 0.36, 0.38) * diffuse;
      col = mix(frame, glassCol, pane);
      col += litCol * lit * 0.55 * mix(0.3 * 0.8, pane, aa);
    } else {
      // Concrete / brick with punched windows.
      vec3 wall = mix(vec3(0.62, 0.56, 0.48), vec3(0.55, 0.36, 0.28), hue) * diffuse;
      vec2 w = step(vec2(0.2, 0.28), f) * step(f, vec2(0.8, 0.86));
      float win = mix(0.35, w.x * w.y, aa);
      vec3 winCol = vec3(0.05, 0.06, 0.08) + skyReflect(R) * (0.15 + 0.6 * fres);
      col = mix(wall, winCol, win);
      col += litCol * lit * mix(0.35 * 0.3, w.x * w.y, aa);
    }
  }
  col *= vAo;
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
    this.pos = []; this.nrm = []; this.uv = []; this.ao = []; this.fac = []; this.idx = [];
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
    }
    this.uv.push(...uvs);
    this.ao.push(...aos);
    const v = this.v;
    if (flip) this.idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    else this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    this.v += 4;
  }
  // Box with walls split at +6 m so AO can darken the base.
  box(x0, y0, z0, x1, y1, z1, fac, baseAo) {
    const ys = [y0, Math.min(y0 + 6, y1), y1];
    const aoAt = (y) => (y <= y0 + 0.01 ? baseAo : 1);
    for (let r = 0; r < 2; r++) {
      const ya = ys[r], yb = ys[r + 1];
      if (yb - ya < 0.01) continue;
      const aa = aoAt(ya), ab = aoAt(yb);
      const wx = x1 - x0, wz = z1 - z0;
      // +x
      this.quad(x1, ya, z1, x1, ya, z0, x1, yb, z0, x1, yb, z1, 1, 0, 0,
        [0, ya, wz, ya, wz, yb, 0, yb], [aa, aa, ab, ab], fac);
      // -x
      this.quad(x0, ya, z0, x0, ya, z1, x0, yb, z1, x0, yb, z0, -1, 0, 0,
        [0, ya, wz, ya, wz, yb, 0, yb], [aa, aa, ab, ab], fac);
      // +z
      this.quad(x0, ya, z1, x1, ya, z1, x1, yb, z1, x0, yb, z1, 0, 0, 1,
        [0, ya, wx, ya, wx, yb, 0, yb], [aa, aa, ab, ab], fac);
      // -z
      this.quad(x1, ya, z0, x0, ya, z0, x0, yb, z0, x1, yb, z0, 0, 0, -1,
        [0, ya, wx, ya, wx, yb, 0, yb], [aa, aa, ab, ab], fac);
    }
    this.quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0,
      [x0, z1, x1, z1, x1, z0, x0, z0], [1, 1, 1, 1], fac);
  }
  geometry() {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('aAo', new BufferAttribute(new Float32Array(this.ao), 1));
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
