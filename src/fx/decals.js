import {
  DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry, ShaderMaterial, Vector3,
} from 'three';
import { COMMON_GLSL, U } from '../world/shared.js';

// Smash holes in walls and craters in the ground: a pooled instanced quad with
// a procedural jagged hole, scorched cracked rim and a cooling molten edge.
const VS = /* glsl */ `
attribute vec2 aInfo; // spawn time, seed
varying vec2 vUv;
varying vec2 vInfo;
varying vec3 vWorld;
void main() {
  vUv = uv * 2.0 - 1.0;
  vInfo = aInfo;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FS = /* glsl */ `
${COMMON_GLSL}
varying vec2 vUv;
varying vec2 vInfo;
varying vec3 vWorld;
void main() {
  float r = length(vUv);
  float a = atan(vUv.y, vUv.x);
  float s = vInfo.y * 17.0;
  float jag = 0.08 * sin(a * 7.0 + s) + 0.05 * sin(a * 13.0 + s * 2.3) + 0.03 * sin(a * 29.0 + s * 0.7);
  float hole = 0.42 + jag;
  float rim = 0.78 + jag * 1.4;
  // cracks radiating out past the rim
  float crack = smoothstep(0.93, 1.0, sin(a * 9.0 + s + r * 3.0)) * step(r, 1.0) * (1.0 - smoothstep(0.6, 1.0, r));
  if (r > rim && crack < 0.5) discard;
  float age = uTime - vInfo.x;
  vec3 col;
  if (r < hole) col = vec3(0.015, 0.012, 0.012);                 // punched through: dark interior
  else col = vec3(0.12, 0.11, 0.1) * (0.6 + 0.4 * (r - hole) / (rim - hole)); // scorched rim
  // molten edge cooling over ~4 s
  float heat = exp(-age * 0.8) * (1.0 - smoothstep(0.0, 0.1, abs(r - hole)));
  col += vec3(1.0, 0.45, 0.1) * heat * 3.0;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  col = applyFog(col, dist, -toCam / dist);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const _m = new Matrix4();
const _e = new Vector3();
const _t = new Vector3();
const _up = new Vector3();

export class Decals {
  constructor(scene, capacity = 32) {
    const geo = new PlaneGeometry(1, 1);
    this.info = new Float32Array(capacity * 2).fill(-1e6);
    this.attr = new InstancedBufferAttribute(this.info, 2).setUsage(DynamicDrawUsage);
    geo.setAttribute('aInfo', this.attr);
    this.mesh = new InstancedMesh(geo, new ShaderMaterial({
      uniforms: U, vertexShader: VS, fragmentShader: FS,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }), capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.capacity = capacity;
    this.next = 0;
    scene.add(this.mesh);
  }

  // Place a hole of the given size at p facing along normal n.
  add(time, px, py, pz, nx, ny, nz, size) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    _e.set(px + nx * 0.05, py + ny * 0.05, pz + nz * 0.05);
    _t.set(_e.x - nx, _e.y - ny, _e.z - nz);
    if (Math.abs(ny) > 0.9) _up.set(0, 0, 1); else _up.set(0, 1, 0);
    _m.lookAt(_e, _t, _up);
    _m.scale(_t.set(size, size, size));
    _m.setPosition(_e);
    this.mesh.setMatrixAt(i, _m);
    this.info[i * 2] = time;
    this.info[i * 2 + 1] = Math.random();
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.attr.needsUpdate = true;
  }

  clear() {
    this.mesh.count = 0;
    this.next = 0;
  }
}
