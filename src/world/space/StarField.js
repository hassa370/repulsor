import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three';
import { PLANET, WORLD_BUDGET } from '../../config.js';
import { mulberry32 } from '../../core/rand.js';

// Stars: one THREE.Points draw call. Directions are fixed in the global
// (planet-centric) frame and the cloud of points is re-centred on the camera
// every frame inside the far depth pass, rotated by Q^-1, so the sky is
// perfectly stable through origin shifts and never sits at huge coordinates.

const vs = /* glsl */ `
attribute float aMag; // 0 (faint) .. 1 (bright)
attribute vec3 aTint;
uniform float uVis;
uniform float uPx;
varying vec3 vCol;
void main() {
  vCol = aTint * (0.25 + 0.95 * aMag * aMag) * uVis;
  gl_PointSize = uPx * (1.0 + 1.6 * aMag);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const fs = /* glsl */ `
varying vec3 vCol;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = dot(q, q);
  if (d > 1.0) discard;
  gl_FragColor = vec4(vCol * (1.0 - d), 1.0);
}
`;

export class StarField {
  constructor(count = WORLD_BUDGET.maxStars) {
    const rnd = mulberry32(PLANET.seed + 11);
    const pos = new Float32Array(count * 3), mag = new Float32Array(count), tint = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Uniform on the sphere, with a denser "galactic band".
      let x, y, z;
      if (rnd() < 0.35) {
        const a = rnd() * Math.PI * 2, b = (rnd() - 0.5) * 0.35;
        x = Math.cos(a); y = b; z = Math.sin(a);
        // tilt the band
        const ty = y * 0.8 + z * 0.6, tz = -y * 0.6 + z * 0.8;
        y = ty; z = tz;
      } else {
        const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
        x = s * Math.cos(a); y = u; z = s * Math.sin(a);
      }
      const l = Math.hypot(x, y, z);
      pos[i * 3] = x / l; pos[i * 3 + 1] = y / l; pos[i * 3 + 2] = z / l;
      mag[i] = Math.pow(rnd(), 6);
      const t = rnd();
      tint[i * 3] = t < 0.2 ? 1.0 : t < 0.8 ? 0.95 : 0.75;
      tint[i * 3 + 1] = t < 0.2 ? 0.82 : 0.95;
      tint[i * 3 + 2] = t < 0.2 ? 0.7 : t < 0.8 ? 1.0 : 1.1;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aMag', new BufferAttribute(mag, 1));
    g.setAttribute('aTint', new BufferAttribute(tint, 3));
    this.uniforms = { uVis: { value: 0 }, uPx: { value: 1.6 } };
    this.points = new Points(g, new ShaderMaterial({
      uniforms: this.uniforms, vertexShader: vs, fragmentShader: fs,
      blending: AdditiveBlending, depthTest: false, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = -90;
    this.points.name = 'stars';
    this.count = count;
  }

  setCount(n) {
    this.points.geometry.setDrawRange(0, Math.min(this.count, n));
  }

  // visibility: 0 (daylight sky) .. 1 (space)
  update(camLocal, qInv, radius, visibility) {
    const p = this.points;
    p.position.copy(camLocal);
    p.quaternion.copy(qInv);
    p.scale.setScalar(radius);
    this.uniforms.uVis.value = visibility;
    p.visible = visibility > 0.01;
  }
}
