import {
  AdditiveBlending, BoxGeometry, BufferAttribute, DynamicDrawUsage, InstancedBufferAttribute,
  InstancedBufferGeometry, Mesh, ShaderMaterial,
} from 'three';
import { COMMON_GLSL, U } from '../world/shared.js';

// GPU-simulated ballistic particles. The CPU only writes spawn parameters
// into a ring buffer; position / spin / fade are evaluated in the vertex
// shader from (uTime - spawnTime). No per-frame CPU work, no allocations.

const SPLINTER_VS = /* glsl */ `
${COMMON_GLSL}
attribute vec4 aP0; // spawn pos, spawn time
attribute vec4 aV0; // velocity, floor y
attribute vec4 aCol; // rgb, life
varying vec3 vN;
varying vec3 vCol;
varying vec3 vWorld;
mat3 rotAxis(vec3 ax, float a) {
  float s = sin(a), c = cos(a), oc = 1.0 - c;
  return mat3(oc*ax.x*ax.x + c, oc*ax.x*ax.y + ax.z*s, oc*ax.z*ax.x - ax.y*s,
              oc*ax.x*ax.y - ax.z*s, oc*ax.y*ax.y + c, oc*ax.y*ax.z + ax.x*s,
              oc*ax.z*ax.x + ax.y*s, oc*ax.y*ax.z - ax.x*s, oc*ax.z*ax.z + c);
}
void main() {
  float t = uTime - aP0.w;
  float life = aCol.w;
  if (t < 0.0 || t > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 p = aP0.xyz + aV0.xyz * t + vec3(0.0, -9.8, 0.0) * 0.5 * t * t;
  bool landed = p.y < aV0.w;
  p.y = max(p.y, aV0.w);
  float seed = fract(sin(dot(aP0.xyz, vec3(12.9898, 78.233, 37.719)) + aP0.w * 13.0) * 43758.5453);
  vec3 ax = normalize(vec3(seed - 0.5, fract(seed * 7.3) - 0.5, fract(seed * 3.1) - 0.5) + 0.001);
  float ang = landed ? seed * 6.0 : t * (8.0 + seed * 14.0);
  mat3 R = rotAxis(ax, ang);
  float shrink = 1.0 - smoothstep(life * 0.6, life, t);
  vec3 local = R * (position * (0.6 + seed) * shrink);
  vN = R * normal;
  vCol = aCol.rgb;
  vWorld = p + local;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;
const SPLINTER_FS = /* glsl */ `
${COMMON_GLSL}
varying vec3 vN;
varying vec3 vCol;
varying vec3 vWorld;
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 col = vCol * lightDiffuse(normalize(vN));
  col = applyFog(col, dist, -toCam / dist);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const SPARK_VS = /* glsl */ `
${COMMON_GLSL}
attribute vec4 aP0;
attribute vec4 aV0; // velocity, gravity scale
attribute vec4 aCol; // rgb, life
varying vec3 vCol;
varying vec2 vQ;
varying float vA;
void main() {
  float t = uTime - aP0.w;
  float life = aCol.w;
  if (t < 0.0 || t > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = t / life;
  // Drag-ish ease on velocity so bursts bloom then hang.
  float tt = (1.0 - exp(-3.0 * t)) / 3.0;
  vec3 p = aP0.xyz + aV0.xyz * tt + vec3(0.0, -9.8 * aV0.w, 0.0) * 0.5 * t * t;
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float size = mix(0.35, 0.05, k) * (0.5 + fract(aP0.w * 97.0));
  p += (camR * position.x + camU * position.y) * size;
  vQ = position.xy;
  vCol = aCol.rgb;
  vA = 1.0 - k;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
const SPARK_FS = /* glsl */ `
varying vec3 vCol;
varying vec2 vQ;
varying float vA;
void main() {
  float d = length(vQ);
  if (d > 1.0) discard;
  float g = (1.0 - d); g *= g;
  gl_FragColor = vec4(vCol * g * vA, 1.0);
}
`;

class GpuParticles {
  constructor(baseGeo, capacity, vs, fs, matOpts) {
    const g = new InstancedBufferGeometry();
    g.index = baseGeo.index;
    g.setAttribute('position', baseGeo.attributes.position);
    if (baseGeo.attributes.normal) g.setAttribute('normal', baseGeo.attributes.normal);
    this.p0 = new Float32Array(capacity * 4);
    this.v0 = new Float32Array(capacity * 4);
    this.col = new Float32Array(capacity * 4);
    for (let i = 0; i < capacity; i++) this.p0[i * 4 + 3] = -1e6; // dead
    this.attrs = [
      new InstancedBufferAttribute(this.p0, 4).setUsage(DynamicDrawUsage),
      new InstancedBufferAttribute(this.v0, 4).setUsage(DynamicDrawUsage),
      new InstancedBufferAttribute(this.col, 4).setUsage(DynamicDrawUsage),
    ];
    g.setAttribute('aP0', this.attrs[0]);
    g.setAttribute('aV0', this.attrs[1]);
    g.setAttribute('aCol', this.attrs[2]);
    g.instanceCount = capacity;
    this.capacity = capacity;
    this.mesh = new Mesh(g, new ShaderMaterial({ uniforms: U, vertexShader: vs, fragmentShader: fs, ...matOpts }));
    this.mesh.frustumCulled = false;
    this.next = 0;
    this.dirty = false;
    this.lastSpawn = -1e6;
    this.maxLife = 0;
  }

  spawn(time, x, y, z, vx, vy, vz, w, r, g, b, life) {
    const o = this.next * 4;
    this.next = (this.next + 1) % this.capacity;
    this.p0[o] = x; this.p0[o + 1] = y; this.p0[o + 2] = z; this.p0[o + 3] = time;
    this.v0[o] = vx; this.v0[o + 1] = vy; this.v0[o + 2] = vz; this.v0[o + 3] = w;
    this.col[o] = r; this.col[o + 1] = g; this.col[o + 2] = b; this.col[o + 3] = life;
    this.dirty = true;
    this.lastSpawn = time;
    if (life > this.maxLife) this.maxLife = life;
  }

  // Approximate number of live particles (for the debug overlay).
  alive(time) {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      const t = time - this.p0[i * 4 + 3];
      if (t >= 0 && t <= this.col[i * 4 + 3]) n++;
    }
    return n;
  }

  update(time) {
    if (this.dirty) {
      for (let i = 0; i < 3; i++) this.attrs[i].needsUpdate = true;
      this.dirty = false;
    }
    // Skip the draw entirely once everything has expired.
    this.mesh.visible = time - this.lastSpawn < this.maxLife + 0.1;
  }
}

export class Particles {
  constructor(scene) {
    const box = new BoxGeometry(0.05, 0.05, 0.3);
    this.splinters = new GpuParticles(box, 600, SPLINTER_VS, SPLINTER_FS, {});
    const quad = new InstancedBufferGeometry();
    quad.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.sparks = new GpuParticles(quad, 700, SPARK_VS, SPARK_FS, {
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
    this.sparks.mesh.renderOrder = 11;
    scene.add(this.splinters.mesh);
    scene.add(this.sparks.mesh);
    this.time = 0;
    this._seed = 1;
  }

  rand() {
    // xorshift, allocation free
    let x = this._seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._seed = x >>> 0 || 1;
    return (this._seed % 100000) / 100000;
  }

  // Wood splinters burst. dirx/y/z biases the spray (e.g. blast direction).
  woodBurst(x, y, z, dirx, diry, dirz, count, speed, floorY) {
    for (let i = 0; i < count; i++) {
      const vx = (this.rand() - 0.5) * speed + dirx * speed * 0.5;
      const vy = this.rand() * speed * 0.8 + diry * speed * 0.3 + 2;
      const vz = (this.rand() - 0.5) * speed + dirz * speed * 0.5;
      const shade = 0.6 + this.rand() * 0.5;
      const light = this.rand() < 0.3;
      this.splinters.spawn(this.time, x, y, z, vx, vy, vz, floorY,
        (light ? 0.75 : 0.45) * shade, (light ? 0.55 : 0.3) * shade, (light ? 0.35 : 0.16) * shade,
        1.4 + this.rand() * 1.2);
    }
  }

  sparkBurst(x, y, z, count, speed, r, g, b, life, gravity = 0.3) {
    for (let i = 0; i < count; i++) {
      const ux = this.rand() - 0.5, uy = this.rand() - 0.5, uz = this.rand() - 0.5;
      const s = speed * (0.4 + this.rand() * 0.6) / Math.max(0.1, Math.hypot(ux, uy, uz));
      this.sparks.spawn(this.time, x, y, z, ux * s, uy * s, uz * s, gravity, r, g, b, life * (0.6 + this.rand() * 0.4));
    }
  }

  ember(x, y, z, vx, vy, vz, r, g, b, life) {
    this.sparks.spawn(this.time, x, y, z, vx, vy, vz, -0.15, r, g, b, life);
  }

  frame(time) {
    this.time = time;
    this.splinters.update(time);
    this.sparks.update(time);
  }

  aliveCount() {
    return this.splinters.alive(this.time) + this.sparks.alive(this.time);
  }
}
