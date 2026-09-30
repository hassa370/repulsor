import {
  AdditiveBlending, BufferAttribute, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry,
  Mesh, ShaderMaterial,
} from 'three';

// Immediate-mode batch of additive glowing capsules ("beam sprites").
// Every frame the game pushes blasts (with trails), muzzle flashes, charge
// orbs, impact flashes, etc. One draw call, no allocations, no real lights.
const VS = /* glsl */ `
attribute vec4 aA;   // start xyz, radius
attribute vec4 aB;   // end xyz, core (0..1)
attribute vec4 aColor;
varying vec2 vQ;
varying float vLen;
varying float vCore;
varying vec4 vColor;
void main() {
  // modelMatrix is identity for the game's batches; the city's static glows
  // batch rides the city group when the floating origin moves it.
  vec3 a = (modelMatrix * vec4(aA.xyz, 1.0)).xyz, b = (modelMatrix * vec4(aB.xyz, 1.0)).xyz;
  vec3 mid = (a + b) * 0.5;
  // Never thinner than ~2 px so distant bolts stay visible glows, not hairlines.
  float r = max(aA.w, length(cameraPosition - mid) * 0.0016);
  vec3 viewDir = normalize(cameraPosition - mid);
  vec3 axis = b - a;
  float len = length(axis);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 dir = len > 1e-4 ? axis / len : camUp;
  vec3 side = cross(dir, viewDir);
  float sl = length(side);
  if (sl < 1e-3) { dir = camUp; side = cross(dir, viewDir); sl = length(side); len = 0.0; }
  side /= sl;
  vec3 ext = normalize(cross(viewDir, side));
  float L = len / r;
  // position.y: -1 = tail cap, +1 = head cap
  vec3 p = (position.y < 0.0 ? a - ext * r : a + ext * (len + r)) + side * position.x * r;
  vQ = vec2(position.x, position.y < 0.0 ? -1.0 : L + 1.0);
  vLen = L;
  vCore = aB.w;
  vColor = aColor;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
const FS = /* glsl */ `
varying vec2 vQ;
varying float vLen;
varying float vCore;
varying vec4 vColor;
void main() {
  float dy = max(0.0, max(-vQ.y, vQ.y - vLen));
  float d = length(vec2(vQ.x, dy));
  if (d > 1.0) discard;
  // Laser-style profile: white-hot core, saturated inner glow, soft halo.
  float halo = exp(-d * d * 5.0) * (1.0 - d);
  float hot = vCore > 0.0 ? 1.0 - smoothstep(vCore * 0.35, vCore, d) : 0.0;
  vec3 c = vColor.rgb * (halo * 1.3 + hot * 0.6) + vec3(1.0) * hot;
  gl_FragColor = vec4(c * vColor.a, 1.0);
}
`;

export class SpriteBatch {
  constructor(capacity = 512, { depthTest = true, renderOrder = 10 } = {}) {
    this.capacity = capacity;
    const g = new InstancedBufferGeometry();
    // 4 corners: x in {-1,1}, y in {-1 (tail), +1 (head)}
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.a = new Float32Array(capacity * 4);
    this.b = new Float32Array(capacity * 4);
    this.c = new Float32Array(capacity * 4);
    this.attrA = new InstancedBufferAttribute(this.a, 4).setUsage(DynamicDrawUsage);
    this.attrB = new InstancedBufferAttribute(this.b, 4).setUsage(DynamicDrawUsage);
    this.attrC = new InstancedBufferAttribute(this.c, 4).setUsage(DynamicDrawUsage);
    g.setAttribute('aA', this.attrA);
    g.setAttribute('aB', this.attrB);
    g.setAttribute('aColor', this.attrC);
    g.instanceCount = 0;
    this.geometry = g;
    this.attrs = [this.attrA, this.attrB, this.attrC];
    this.mesh = new Mesh(g, new ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, depthTest,
      blending: AdditiveBlending,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.count = 0;
  }

  begin() { this.count = 0; }

  // Glowing capsule from (ax,ay,az) to (bx,by,bz). core: white-hot centre size 0..1.
  push(ax, ay, az, bx, by, bz, radius, r, g, b, alpha, core = 0.35) {
    if (this.count >= this.capacity) return;
    const o = this.count++ * 4;
    this.a[o] = ax; this.a[o + 1] = ay; this.a[o + 2] = az; this.a[o + 3] = radius;
    this.b[o] = bx; this.b[o + 1] = by; this.b[o + 2] = bz; this.b[o + 3] = core;
    this.c[o] = r; this.c[o + 1] = g; this.c[o + 2] = b; this.c[o + 3] = alpha;
  }

  pushPoint(x, y, z, radius, r, g, b, alpha, core) {
    this.push(x, y, z, x, y, z, radius, r, g, b, alpha, core);
  }

  end() {
    const n = this.count;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    // Full re-upload (small buffers) avoids per-frame update-range objects.
    for (let i = 0; i < 3; i++) this.attrs[i].needsUpdate = true;
  }
}
