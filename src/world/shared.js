import { Color, Vector3 } from 'three';
import { WORLD } from '../config.js';

// Uniform objects shared (by reference) across every custom shader so the
// lighting / fog stays consistent and is updated in one place.
export const U = {
  uSunDir: { value: new Vector3().fromArray(WORLD.sunDir).normalize() },
  uSunColor: { value: new Color(WORLD.sunColor).multiplyScalar(1.0) },
  uFogColor: { value: new Color(0.6, 0.45, 0.4) },
  uFogDensity: { value: WORLD.fogDensity },
  uSkyTop: { value: new Color(0.1, 0.13, 0.3) },
  uSkyHorizon: { value: new Color(0.9, 0.5, 0.3) },
  uAmbientSky: { value: new Color(0.27, 0.26, 0.37) },
  uAmbientGround: { value: new Color(0.16, 0.12, 0.1) },
  uTime: { value: 0 },
};

export const COMMON_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform float uTime;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Analytic sky for reflections (no texture fetch / trig).
vec3 skyReflect(vec3 r) {
  float t = clamp(r.y, 0.0, 1.0);
  vec3 c = mix(uSkyHorizon, uSkyTop, sqrt(t));
  float s = max(dot(r, uSunDir), 0.0);
  c += uSunColor * (pow(s, 8.0) * 0.35 + pow(s, 120.0) * 2.0);
  return r.y < 0.0 ? uSkyHorizon * 0.55 : c;
}
vec3 lightDiffuse(vec3 n) {
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 amb = mix(uAmbientGround, uAmbientSky, n.y * 0.5 + 0.5);
  return amb + uSunColor * ndl;
}
vec3 applyFog(vec3 col, float dist, vec3 viewDir) {
  float fd = uFogDensity * dist;
  float f = 1.0 - exp(-fd * fd);
  float s = pow(max(dot(viewDir, uSunDir), 0.0), 6.0);
  return mix(col, uFogColor + uSunColor * s * 0.2, clamp(f, 0.0, 1.0));
}
`;
