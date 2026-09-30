import { Color, Vector3 } from 'three';
import { PLANET, WORLD } from '../config.js';

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
  // Height fog: camera altitude above sea level and the ground-haze scale height.
  uCamAlt: { value: 0 },
  uFogHeight: { value: PLANET.groundHazeHeight },
  uLowCloudFade: { value: 1 }, // the city's low sunset billboards fade out as you climb
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
uniform float uCamAlt;
uniform float uFogHeight;

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
// Exponential height fog: the haze density falls off with altitude (scale
// height uFogHeight), integrated analytically along the view ray. At ground
// level it equals the original exp2 distance fog; from altitude the ground
// stays visible through a thin haze. viewDir: camera -> fragment (local +Y up).
float fogFactor(float dist, vec3 viewDir) {
  float k = 1.0 / uFogHeight;
  // mean of exp(-h / H) over the ray's altitude span (stable for any length)
  float h0 = max(uCamAlt, 0.0) * k;
  float h1 = max(uCamAlt + viewDir.y * dist, 0.0) * k;
  float dh = h1 - h0;
  float e0 = exp(-h0);
  float avg = abs(dh) < 1e-3 ? e0 * (1.0 - 0.5 * dh) : (e0 - exp(-h1)) / dh;
  float fd = uFogDensity * dist * avg;
  return clamp(1.0 - exp(-fd * fd), 0.0, 1.0);
}
vec3 applyFog(vec3 col, float dist, vec3 viewDir) {
  float f = fogFactor(dist, viewDir);
  float s = pow(max(dot(viewDir, uSunDir), 0.0), 6.0);
  return mix(col, uFogColor + uSunColor * s * 0.2, f);
}
`;
