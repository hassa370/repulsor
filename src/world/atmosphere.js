import {
  DataTexture, DirectionalLight, HemisphereLight,
  InstancedBufferAttribute, InstancedBufferGeometry, LinearMipmapLinearFilter, Mesh, NormalBlending,
  PlaneGeometry, RepeatWrapping, RGBAFormat, ShaderMaterial, UnsignedByteType,
} from 'three';
import { WORLD } from '../config.js';
import { fbm, mulberry32 } from '../core/rand.js';
import { COMMON_GLSL, U } from './shared.js';
import { WATER_LEVEL } from '../physics/collision.js';

// Tileable normal map generated once from fbm heights.
function makeWaterNormals(size = 256) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) h[y * size + x] = fbm(x / 32, y / 32, 4, 3, size / 32);
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)], r = h[y * size + ((x + 1) % size)];
      const d = h[((y - 1 + size) % size) * size + x], u = h[((y + 1) % size) * size + x];
      let nx = (l - r) * 6, nz = (d - u) * 6, ny = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const o = (y * size + x) * 4;
      data[o] = (nx * 0.5 + 0.5) * 255;
      data[o + 1] = (nz * 0.5 + 0.5) * 255;
      data[o + 2] = (ny * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  const t = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

const waterVS = /* glsl */ `
varying vec3 vWorld;
varying vec2 vObj;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vObj = position.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const waterFS = /* glsl */ `
${COMMON_GLSL}
uniform sampler2D tNormal;
varying vec3 vWorld;
varying vec2 vObj;
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 p = vObj; // city frame, so the waves don't slide when the origin moves
  vec3 n1 = texture2D(tNormal, p * 0.012 + vec2(uTime * 0.004, uTime * 0.006)).xyz;
  vec3 n2 = texture2D(tNormal, p * 0.037 - vec2(uTime * 0.009, -uTime * 0.005)).xyz;
  vec3 n = (n1 + n2) * 2.0 - 2.0;
  // Flatten normals with distance to fight shimmer.
  float flatK = clamp(dist / 900.0, 0.0, 0.85);
  vec3 N = normalize(vec3(n.x, n.z * (1.0 + flatK * 8.0) + 0.001, n.y));
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 deep = vec3(0.03, 0.07, 0.1) * lightDiffuse(vec3(0.0, 1.0, 0.0));
  vec3 col = mix(deep, skyReflect(R), clamp(fres * 1.2 + 0.1, 0.0, 1.0));
  float glint = pow(max(dot(R, uSunDir), 0.0), 350.0);
  col += uSunColor * glint * 6.0;
  col = applyFog(col, dist, -V);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

// Soft cloud billboards around 300 m, one instanced draw call.
const cloudVS = /* glsl */ `
attribute vec4 aCloud; // xyz centre, size
attribute float aSeed;
varying vec2 vUv;
varying float vSeed;
varying float vDist;
varying vec3 vDir;
void main() {
  vUv = uv;
  vSeed = aSeed;
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 wp = (modelMatrix * vec4(aCloud.xyz, 1.0)).xyz + camRight * position.x * aCloud.w + vec3(0.0, 1.0, 0.0) * position.y * aCloud.w * 0.35;
  vec3 d = wp - cameraPosition;
  vDist = length(d);
  vDir = d / vDist;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const cloudFS = /* glsl */ `
${COMMON_GLSL}
uniform float uLowCloudFade;
varying vec2 vUv;
varying float vSeed;
varying float vDist;
varying vec3 vDir;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float a = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(vSeed * 7.0 + fi * 2.1) * 0.45, cos(vSeed * 3.0 + fi * 1.7) * 0.25);
    float r = 0.35 + 0.15 * fract(vSeed * 11.0 + fi * 0.37);
    a = max(a, 1.0 - smoothstep(r * 0.4, r, length(p - c)));
  }
  a *= 1.0 - smoothstep(0.7, 1.0, abs(p.x));
  float s = pow(max(dot(vDir, uSunDir), 0.0), 4.0);
  vec3 col = mix(vec3(0.75, 0.45, 0.5), vec3(1.0, 0.65, 0.4), s + (1.0 - vUv.y) * 0.3);
  col = mix(col, uFogColor, clamp(vDist / 2400.0, 0.0, 0.6));
  a *= uLowCloudFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a * 0.7);
  #include <colorspace_fragment>
}
`;

function makeClouds() {
  const n = 28;
  const rnd = mulberry32(99);
  const g = new InstancedBufferGeometry();
  const plane = new PlaneGeometry(2, 2);
  g.index = plane.index;
  g.setAttribute('position', plane.attributes.position);
  g.setAttribute('uv', plane.attributes.uv);
  const c = new Float32Array(n * 4), s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, r = 500 + rnd() * 1300;
    c[i * 4] = Math.cos(a) * r;
    c[i * 4 + 1] = 280 + rnd() * 80;
    c[i * 4 + 2] = Math.sin(a) * r;
    c[i * 4 + 3] = 120 + rnd() * 160;
    s[i] = rnd();
  }
  g.setAttribute('aCloud', new InstancedBufferAttribute(c, 4));
  g.setAttribute('aSeed', new InstancedBufferAttribute(s, 1));
  g.instanceCount = n;
  const m = new Mesh(g, new ShaderMaterial({
    uniforms: U, vertexShader: cloudVS, fragmentShader: cloudFS,
    transparent: true, depthWrite: false, blending: NormalBlending,
  }));
  m.frustumCulled = false;
  m.renderOrder = -1;
  return m;
}

// Lights go in the scene; water and the low sunset clouds belong to the city
// (cityGroup) so they move with it under the floating origin. The old flat
// horizon hills ring is gone: the streamed planet terrain is the horizon now.
export function buildAtmosphere(scene, sky, cityGroup = scene) {
  // Lights: exactly one directional + one hemisphere for the whole scene
  // (only three.js built-in materials use them; custom shaders read U).
  const sun = new DirectionalLight(sky.sunColor, WORLD.sunIntensity);
  sun.position.copy(sky.sunDir).multiplyScalar(100);
  scene.add(sun);
  const hemi = new HemisphereLight(0x8a80b0, 0x3a2a22, 1.1);
  scene.add(hemi);

  U.uSunDir.value.copy(sky.sunDir);
  U.uSunColor.value.copy(sky.sunColor).multiplyScalar(1.35);
  U.uFogColor.value.copy(sky.fogColor).multiplyScalar(0.92);
  U.uSkyHorizon.value.copy(sky.fogColor).multiplyScalar(1.25);

  // Inside the planet's flat zone; the planet ocean continues beyond it.
  const water = new Mesh(
    new PlaneGeometry(3200, 1000).rotateX(-Math.PI / 2).translate(0, WATER_LEVEL, WORLD.coastZ - 500 + 20),
    new ShaderMaterial({ uniforms: { ...U, tNormal: { value: makeWaterNormals() } }, vertexShader: waterVS, fragmentShader: waterFS }),
  );
  water.matrixAutoUpdate = false;
  cityGroup.add(water);
  const clouds = makeClouds();
  cityGroup.add(clouds);
  return { sun, hemi, water, clouds };
}
