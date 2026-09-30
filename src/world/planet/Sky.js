import { BackSide, Matrix3, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import { PLANET, WORLD } from '../../config.js';
import { U } from '../shared.js';

// One sky dome for every altitude, drawn first in the far depth pass (no depth
// test/write, one pass). It combines:
//  * the painted / HDRI sunset (texture, 1 sample) near the ground at the city,
//    rotated so its horizon stays level and its sun sits on the real sun;
//  * an analytic single-scattering approximation (Rayleigh-ish colour,
//    3-sample optical depth, sun-path extinction for sunset tints, Mie glow)
//    that takes over as you climb: blue -> dark blue -> black, and a thin
//    glowing rim around the planet from orbit;
//  * the sun disk.
// The texture branch is skipped (uniform-coherent branch) once it has faded.

const vs = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position; // unit sphere around the camera (rotation-free)
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const fs = /* glsl */ `
uniform sampler2D tSky;
uniform mat3 uTexRot;     // local dir -> painted-sky dir
uniform float uTexWeight; // 0..1
uniform vec3 uSunDir;
uniform vec3 uCamRel;     // camera - planet centre (local frame, metres)
uniform float uR;
uniform float uRa;
uniform float uHs;
uniform float uExposure;
uniform vec3 uHazeColor;  // what the sky shows below the horizon
varying vec3 vDir;

const float PI = 3.14159265;
const vec3 BETA = vec3(0.16, 0.37, 0.9); // relative Rayleigh extinction (R, G, B)

vec2 sphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return vec2(1.0, -1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

// Relative optical depth of the atmosphere toward the sun from height h (m),
// normalised to 1 = one vertical scale height at sea level.
float sunAirmass(float mu, float h) {
  float m = 1.0 / (max(mu, 0.0) + 0.15 * pow(max(93.885 - degrees(acos(clamp(mu, -1.0, 1.0))), 0.1), -1.253));
  return m * exp(-h / uHs);
}

vec3 analytic(vec3 rd) {
  vec3 ro = uCamRel;
  vec2 ta = sphere(ro, rd, uRa);
  if (ta.y < 0.0) return vec3(0.0);
  float t0 = max(ta.x, 0.0), t1 = ta.y;
  vec2 tp = sphere(ro, rd, uR);
  bool ground = tp.y > 0.0 && tp.x > 0.0;
  if (ground) t1 = min(t1, tp.x);
  float L = t1 - t0;
  // optical depth (in units of the sea-level scale height)
  float od = 0.0;
  vec3 mid = ro + rd * (t0 + L * 0.5);
  for (int i = 0; i < 3; i++) {
    vec3 p = ro + rd * (t0 + L * (float(i) + 0.5) / 3.0);
    od += exp(-(length(p) - uR) / uHs);
  }
  od *= L / 3.0 / uHs;
  vec3 up = normalize(mid);
  float sunUp = dot(up, uSunDir);
  float light = smoothstep(-0.18, 0.06, sunUp);
  vec3 sunT = exp(-BETA * 0.42 * sunAirmass(sunUp, length(mid) - uR));
  float mu = dot(rd, uSunDir);
  vec3 scat = (1.0 - exp(-BETA * od * 0.12)) * (0.8 + 0.6 * mu * mu);
  float mie = pow(max(mu, 0.0), 24.0) * (1.0 - exp(-od * 0.05)) * 2.5;
  vec3 col = (scat * 2.2 + mie * sqrt(sunT)) * sunT * light;
  if (ground) col = mix(col, uHazeColor * light, 0.15);
  return col * uExposure;
}

void main() {
  vec3 rd = normalize(vDir);
  vec3 col = analytic(rd);
  if (uTexWeight > 0.001) {
    vec3 d = normalize(uTexRot * rd);
    vec2 uv = vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
    col = mix(col, texture2D(tSky, uv).rgb, uTexWeight);
  }
  // sun disk (visible from everywhere; dimmed by the atmosphere near the ground)
  float s = dot(rd, uSunDir);
  float disk = smoothstep(0.99985, 0.99992, s);
  col += vec3(1.0, 0.92, 0.82) * disk * 6.0 * (1.0 - uTexWeight * 0.8);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const _a = new Vector3(), _b = new Vector3(), _c = new Vector3();
const _pa = new Vector3(), _pb = new Vector3(), _pc = new Vector3();
const _mL = new Matrix3(), _mP = new Matrix3();

export class Sky {
  constructor(skyTexture) {
    this.uniforms = {
      tSky: { value: skyTexture },
      uTexRot: { value: new Matrix3() },
      uTexWeight: { value: 1 },
      uSunDir: U.uSunDir,
      uCamRel: { value: new Vector3(0, PLANET.radius, 0) },
      uR: { value: PLANET.radius },
      uRa: { value: PLANET.radius + PLANET.atmosphereHeight },
      uHs: { value: PLANET.scaleHeight },
      uExposure: { value: 1 },
      uHazeColor: U.uFogColor,
    };
    this.material = new ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vs, fragmentShader: fs,
      side: BackSide, depthTest: false, depthWrite: false,
    });
    this.mesh = new Mesh(new SphereGeometry(1, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    this.mesh.name = 'sky';
    this.paintedSun = new Vector3().fromArray(WORLD.sunDir).normalize();
  }

  // camLocal: camera position; planetC: planet centre (local); up: local up at
  // the camera; radius: dome radius inside the far pass depth range.
  update(camLocal, planetC, up, sunLocal, altitude, sunElevation, radius) {
    const u = this.uniforms;
    u.uCamRel.value.copy(camLocal).sub(planetC);
    this.mesh.position.copy(camLocal);
    this.mesh.scale.setScalar(radius);
    // Painted sky: full weight near the ground at a sunset-like sun elevation.
    const paintedEl = this.paintedSun.y;
    const elK = 1 - Math.min(1, Math.max(0, (Math.abs(sunElevation - paintedEl) - 0.08) / 0.25));
    const altK = 1 - Math.min(1, Math.max(0, (altitude - 1500) / 11000));
    u.uTexWeight.value = elK * altK * altK;
    // Rotation local -> painted frame: up -> +Y, sun azimuth -> painted sun azimuth.
    _a.copy(sunLocal).addScaledVector(up, -sunLocal.dot(up));
    if (_a.lengthSq() < 1e-8) _a.set(1, 0, 0).addScaledVector(up, -up.x);
    _a.normalize();
    _b.copy(up);
    _c.crossVectors(_a, _b);
    _pa.set(this.paintedSun.x, 0, this.paintedSun.z).normalize();
    _pb.set(0, 1, 0);
    _pc.crossVectors(_pa, _pb);
    _mL.set(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z); // rows = local basis (L^T)
    _mP.set(_pa.x, _pb.x, _pc.x, _pa.y, _pb.y, _pc.y, _pa.z, _pb.z, _pc.z); // columns = painted basis
    u.uTexRot.value.multiplyMatrices(_mP, _mL);
  }
}
