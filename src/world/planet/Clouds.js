import {
  BufferAttribute, DoubleSide, BufferGeometry, DataTexture, LinearFilter, LinearMipmapLinearFilter, Mesh, RedFormat,
  RepeatWrapping, ShaderMaterial, SphereGeometry, UnsignedByteType, Vector3, Matrix3, Quaternion,
} from 'three';
import { PLANET, WORLD_BUDGET } from '../../config.js';
import { fbm } from '../../core/rand.js';
import { COMMON_GLSL, U } from '../shared.js';

// Clouds without ray marching:
//  * Local deck: up to 3 thin stacked sheets (one draw call) on a disc that
//    follows the player, bent to the exact planet curvature in the vertex
//    shader. Coverage comes from one tileable noise texture (2 samples),
//    addressed by planet-fixed cube-face coordinates, so clouds never swim
//    when the origin shifts. It is drawn twice (near + far depth pass) with a
//    distance split so distant peaks still occlude it correctly.
//  * Inside the deck, the fog thickens into a whiteout (driven from the CPU
//    by sampling the same texture under the player).
//  * From high altitude / orbit: one low-poly sphere shell with the same
//    coverage function. The local deck fades out as the shell fades in.

const TILE = 14000; // m per texture repeat
const DISC_R = 30000; // m, local deck radius
const TEX = 256;

const sheetVS = /* glsl */ `
uniform vec3 uCenterG;  // deck centre relative to the planet centre (global axes)
uniform mat3 uBasisG;   // deck frame -> global axes
uniform float uRc;      // radius of the lowest sheet
uniform float uLayerGap;
attribute float aLayer;
varying vec3 vDirG;
varying vec3 vWorld;
varying float vRho;
varying float vLayer;
void main() {
  float rc = uRc + aLayer * uLayerGap;
  vec2 xz = position.xz;
  float rho2 = dot(xz, xz);
  float drop = rho2 / (rc + sqrt(max(rc * rc - rho2, 0.0)));
  vec3 lp = vec3(xz.x, aLayer * uLayerGap - drop, xz.y);
  vDirG = uCenterG + uBasisG * lp;
  vRho = sqrt(rho2);
  vLayer = aLayer;
  vec4 wp = modelMatrix * vec4(lp, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const shellVS = /* glsl */ `
varying vec3 vDirG;
varying vec3 vWorld;
varying float vRho;
varying float vLayer;
void main() {
  vDirG = position; // object space = global axes (the mesh is rotated by Q^-1)
  vRho = 0.0;
  vLayer = 1.0;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const cloudFS = /* glsl */ `
${COMMON_GLSL}
uniform sampler2D tCloud;
uniform float uCoverage;
uniform float uScale;     // planet radius / tile size
uniform vec2 uWind;
uniform float uAlpha;
uniform float uPassMin;   // draw only fragments with uPassMin <= dist < uPassMax
uniform float uPassMax;
uniform float uDiscR;
uniform float uFadeNear;  // shell: fade out where the local deck is drawn
uniform vec3 uPlanetC;
varying vec3 vDirG;
varying vec3 vWorld;
varying float vRho;
varying float vLayer;

// Coverage: one tile + a finer octave, minus a very low-frequency "weather"
// field (the same texture at ~1/16 scale) that breaks up the tiling into
// clear regions and storm systems when seen from orbit.
float coverage(vec3 d, out float weather) {
  vec3 a = abs(d);
  vec2 uv = a.y >= a.x && a.y >= a.z ? d.xz / a.y : (a.x >= a.z ? d.zy / a.x : d.xy / a.z);
  uv = uv * uScale + uWind;
  weather = texture2D(tCloud, uv * 0.061 + vec2(0.31, 0.77)).r;
  return texture2D(tCloud, uv).r * 0.68 + texture2D(tCloud, uv * 4.3 + 0.37).r * 0.32;
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  if (dist < uPassMin || dist >= uPassMax) discard;
  vec3 d = normalize(vDirG);
  float weather;
  float c = coverage(d, weather);
  float t = 1.0 - uCoverage + (abs(vLayer - 1.0)) * 0.07 + (0.5 - weather) * 0.55;
  float a = smoothstep(t, t + 0.16, c);
  a *= 1.0 - smoothstep(uDiscR * 0.72, uDiscR, vRho);
  a *= smoothstep(15.0, 140.0, dist);
  if (uFadeNear > 0.0) a *= smoothstep(uFadeNear * 0.75, uFadeNear, dist); // (edge0 < edge1 required)
  a *= uAlpha;
  if (a < 0.01) discard;
  vec3 up = normalize(vWorld - uPlanetC);
  float sunUp = dot(up, uSunDir);
  float day = smoothstep(-0.15, 0.1, sunUp);
  float dens = clamp((c - t) * 4.0, 0.0, 1.0);
  vec3 lit = uSunColor * (0.55 + 0.45 * vLayer * 0.5) + uAmbientSky * 0.6;
  vec3 shade = uAmbientSky * 0.55 + uAmbientGround * 0.35;
  vec3 col = mix(lit, shade, dens * 0.55) * mix(0.05, 1.0, day);
  col = min(applyFog(col, dist, -toCam / dist), vec3(0.95));
  gl_FragColor = vec4(col, a * 0.85);
  #include <colorspace_fragment>
}
`;

function makeCloudTexture() {
  const data = new Uint8Array(TEX * TEX);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const v = fbm(x / 32, y / 32, 4, 17, TEX / 32);
      data[y * TEX + x] = Math.max(0, Math.min(255, (v - 0.18) / 0.64 * 255));
    }
  }
  const t = new DataTexture(data, TEX, TEX, RedFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

// Polar disc: geometric rings (dense near the player, sparse far away),
// repeated per layer. Two index orders so sheets always blend far-to-near.
function makeDisc(layers) {
  const rings = 26, seg = 40, r0 = 60;
  const per = 1 + rings * seg;
  const pos = new Float32Array(per * layers * 3);
  const lay = new Float32Array(per * layers);
  for (let l = 0; l < layers; l++) {
    const b = l * per;
    lay[b] = l;
    for (let k = 0; k < rings; k++) {
      const r = r0 * Math.pow(DISC_R / r0, k / (rings - 1));
      for (let s = 0; s < seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const v = b + 1 + k * seg + s;
        pos[v * 3] = Math.cos(a) * r;
        pos[v * 3 + 2] = Math.sin(a) * r;
        lay[v] = l;
      }
    }
  }
  const sheet = (l) => {
    const idx = [];
    const b = l * per;
    for (let s = 0; s < seg; s++) idx.push(b, b + 1 + (s + 1) % seg, b + 1 + s);
    for (let k = 0; k < rings - 1; k++) {
      for (let s = 0; s < seg; s++) {
        const a0 = b + 1 + k * seg + s, a1 = b + 1 + k * seg + (s + 1) % seg;
        const c0 = a0 + seg, c1 = a1 + seg;
        idx.push(a0, a1, c0, a1, c1, c0);
      }
    }
    return idx;
  };
  const up = [], down = [];
  for (let l = 0; l < layers; l++) up.push(...sheet(l));
  for (let l = layers - 1; l >= 0; l--) down.push(...sheet(l));
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aLayer', new BufferAttribute(lay, 1));
  const idxUp = new BufferAttribute(new Uint32Array(up), 1);
  const idxDown = new BufferAttribute(new Uint32Array(down), 1);
  g.setIndex(idxUp);
  g.computeBoundingSphere();
  g.boundingSphere.radius = DISC_R * 1.2;
  return { g, idxUp, idxDown };
}

const _n = new Vector3();
const _q = new Quaternion();
const _m3 = new Matrix3();
const Y = new Vector3(0, 1, 0);

export class Clouds {
  constructor(origin) {
    this.origin = origin;
    const tex = makeCloudTexture();
    this.texData = tex.image.data;
    const layers = WORLD_BUDGET.maxCloudLayers;
    this.layerGap = layers > 1 ? (PLANET.cloudTop - PLANET.cloudBase) / (layers - 1) : 0;
    const shared = {
      tCloud: { value: tex },
      uCoverage: { value: PLANET.cloudCoverage },
      uScale: { value: PLANET.radius / TILE },
      uWind: { value: [0, 0] },
      uDiscR: { value: DISC_R },
      uPlanetC: { value: origin.planetCenterLocal },
      uCenterG: { value: new Vector3() },
      uBasisG: { value: new Matrix3() },
      uRc: { value: PLANET.radius + PLANET.cloudBase },
      uLayerGap: { value: this.layerGap },
    };
    const mk = (vs, passMin, passMax, alpha) => new ShaderMaterial({
      uniforms: {
        ...U, ...shared,
        uAlpha: { value: alpha }, uPassMin: { value: passMin }, uPassMax: { value: passMax }, uFadeNear: { value: 0 },
      },
      vertexShader: vs, fragmentShader: cloudFS, transparent: true, depthWrite: false,
    });
    const disc = makeDisc(layers);
    this.disc = disc;
    this.layers = layers;
    // Same geometry, two meshes: near pass (dist < split) and far pass (>= split).
    this.nearMesh = new Mesh(disc.g, mk(sheetVS, 0, 1e9, 1));
    this.farMesh = new Mesh(disc.g, mk(sheetVS, 0, 1e9, 1));
    this.nearMesh.material.side = DoubleSide;
    this.farMesh.material.side = DoubleSide;
    this.shell = new Mesh(new SphereGeometry(1, 96, 48), mk(shellVS, 0, 1e12, 0));
    for (const m of [this.nearMesh, this.farMesh, this.shell]) {
      m.frustumCulled = false;
      m.renderOrder = 5;
      m.name = 'clouds';
    }
    this.shell.renderOrder = 4;
    this.whiteout = 0;
    this.weather = 0.5;
    this.wind = shared.uWind.value;
    this.shared = shared;
  }

  setLayers(n) {
    // Quality: draw only the first n sheets (index ranges are per layer).
    const per = this.disc.idxUp.count / this.layers;
    const count = Math.max(1, Math.min(this.layers, n)) * per;
    this.disc.g.setDrawRange(0, count);
  }

  // CPU twin of the shader coverage (for the in-cloud whiteout).
  coverageAt(d) {
    const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
    let u, v;
    if (ay >= ax && ay >= az) { u = d.x / ay; v = d.z / ay; }
    else if (ax >= az) { u = d.z / ax; v = d.y / ax; }
    else { u = d.x / az; v = d.y / az; }
    const s = this.shared.uScale.value;
    const uu = u * s + this.wind[0], vv = v * s + this.wind[1];
    this.weather = this.sample(uu * 0.061 + 0.31, vv * 0.061 + 0.77);
    return this.sample(uu, vv) * 0.68 + this.sample(uu * 4.3 + 0.37, vv * 4.3 + 0.37) * 0.32;
  }

  sample(x, y) {
    const fx = (((x % 1) + 1) % 1) * TEX, fy = (((y % 1) + 1) % 1) * TEX;
    return this.texData[(Math.floor(fy) % TEX) * TEX + (Math.floor(fx) % TEX)] / 255;
  }

  // playerG: player global position; camLocal / planetC in local frame.
  update(time, playerG, camLocal, altitude, split, farRadius) {
    const o = this.origin;
    const R = PLANET.radius;
    this.wind[0] = time * 0.00012; this.wind[1] = time * 0.00005;
    // Deck centre under the player on the lowest sheet.
    _n.copy(playerG).normalize();
    this.shared.uCenterG.value.copy(_n).multiplyScalar(R + PLANET.cloudBase);
    const cLocal = this.nearMesh.position;
    o.globalToLocal(this.shared.uCenterG.value, cLocal);
    this.farMesh.position.copy(cLocal);
    // Orientation: local +Y -> local up at the deck centre.
    o.globalDirToLocal(_n, _n);
    _q.setFromUnitVectors(Y, _n);
    this.nearMesh.quaternion.copy(_q);
    this.farMesh.quaternion.copy(_q);
    // Deck frame -> global = Q * q.
    _m3.setFromMatrix4(this.nearMesh.matrix.makeRotationFromQuaternion(_q.premultiply(o.q)));
    this.shared.uBasisG.value.copy(_m3);
    // Blend order: sheets far-to-near.
    const mid = (PLANET.cloudBase + PLANET.cloudTop) / 2;
    const idx = altitude > mid ? this.disc.idxUp : this.disc.idxDown;
    if (this.disc.g.index !== idx) this.disc.g.setIndex(idx);
    // Local deck up to ~25 km, shell above ~8 km.
    const deckA = 1 - Math.min(1, Math.max(0, (altitude - 18000) / 12000));
    const shellA = Math.min(1, Math.max(0, (altitude - 8000) / 10000));
    this.nearMesh.visible = this.farMesh.visible = deckA > 0.01;
    this.nearMesh.material.uniforms.uAlpha.value = deckA;
    this.farMesh.material.uniforms.uAlpha.value = deckA;
    this.nearMesh.material.uniforms.uPassMax.value = split;
    this.farMesh.material.uniforms.uPassMin.value = split;
    const sh = this.shell;
    sh.visible = shellA > 0.01;
    sh.material.uniforms.uAlpha.value = shellA;
    sh.material.uniforms.uFadeNear.value = deckA > 0.01 ? DISC_R * 0.8 : 0;
    sh.position.copy(o.planetCenterLocal);
    sh.quaternion.copy(o.qInv);
    sh.scale.setScalar(R + (PLANET.cloudBase + PLANET.cloudTop) / 2);
    // Inside the deck: whiteout proportional to the local coverage.
    const inside = Math.min(Math.max(0, (altitude - PLANET.cloudBase + 60) / 120), Math.max(0, (PLANET.cloudTop + 60 - altitude) / 120), 1);
    if (inside > 0) {
      _n.copy(playerG).normalize();
      const c = this.coverageAt(_n);
      const t = 1 - PLANET.cloudCoverage + (0.5 - this.weather) * 0.55;
      const k = Math.min(1, Math.max(0, (c - t) / 0.16));
      this.whiteout = inside * k * k * (3 - 2 * k);
    } else this.whiteout = 0;
    this.farRadius = farRadius;
  }
}
