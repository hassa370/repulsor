import {
  BufferAttribute, CanvasTexture, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry,
  InstancedMesh, Mesh, ShaderMaterial, SRGBColorSpace,
} from 'three';
import { COMMON_GLSL, U } from '../world/shared.js';
import { PART_NAMES, REGIONS } from './goonModel.js';

// All Log Goons (and their debris / thrown bats) render through one
// InstancedMesh per part type sharing ONE material + ONE atlas texture:
// 7 part meshes + 1 silhouette LOD + 1 sprite LOD = 9 draw calls max.

const VS = /* glsl */ `
attribute vec3 aFx; // glow, flash, fade
varying vec2 vUv;
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vFx;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(m) * normal);
  vUv = uv;
  vFx = aFx;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FS = /* glsl */ `
${COMMON_GLSL}
uniform sampler2D tAtlas;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vFx;
void main() {
  if (vFx.z > 0.0 && hash12(gl_FragCoord.xy) < vFx.z) discard; // dithered fade, no sorting
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 N = normalize(vN);
  vec3 col = texture2D(tAtlas, vUv).rgb * lightDiffuse(N);
  // rim light so goons read against the bright sky
  col += uSunColor * 0.12 * pow(1.0 - max(dot(N, toCam / dist), 0.0), 3.0);
  if (vFx.x > 0.0) {
    // glowing tattoo lines (boss / fire bat)
    float pat = smoothstep(0.93, 1.0, sin(vUv.x * 110.0 + sin(vUv.y * 70.0) * 2.5));
    col += vec3(1.0, 0.42, 0.08) * vFx.x * (0.04 + pat * (1.4 + 0.5 * sin(uTime * 7.0)));
  }
  col = mix(col, vec3(1.0, 0.95, 0.85), vFx.y);
  col = applyFog(col, dist, -toCam / dist);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

// Camera-facing (Y-locked) sprite for far LOD.
const SPRITE_VS = /* glsl */ `
attribute vec4 aPos; // feet xyz, height
attribute float aFlash;
varying vec2 vUv;
varying vec3 vWorld;
varying float vFlash;
void main() {
  vec3 toCam = cameraPosition - aPos.xyz;
  vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
  float h = aPos.w;
  vec3 wp = aPos.xyz + right * position.x * h * 0.3 + vec3(0.0, position.y * h, 0.0);
  vUv = uv;
  vWorld = wp;
  vFlash = aFlash;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const SPRITE_FS = /* glsl */ `
${COMMON_GLSL}
uniform sampler2D tSprite;
varying vec2 vUv;
varying vec3 vWorld;
varying float vFlash;
void main() {
  vec4 t = texture2D(tSprite, vUv);
  if (t.a < 0.5) discard;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 col = t.rgb * (uAmbientSky * 1.4 + uSunColor * 0.5);
  col = mix(col, vec3(1.0), vFlash);
  col = applyFog(col, dist, -toCam / dist);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

// Painted far-LOD sprite (used when no reference image is available).
function paintSprite(atlasCanvas) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  const R = REGIONS;
  const src = atlasCanvas;
  // legs
  g.fillStyle = '#7a4f2e'; g.fillRect(24, 100, 6, 26); g.fillRect(35, 100, 6, 26);
  // robe
  g.fillStyle = '#e6e0d4';
  g.beginPath(); g.moveTo(20, 50); g.lineTo(44, 50); g.lineTo(52, 104); g.lineTo(12, 104); g.closePath(); g.fill();
  g.fillStyle = '#3a2418'; g.fillRect(16, 74, 32, 6);
  // arms + bat
  g.fillStyle = '#e6e0d4'; g.fillRect(10, 52, 8, 24); g.fillRect(46, 52, 8, 24);
  g.fillStyle = '#c79a62'; g.save(); g.translate(52, 78); g.rotate(-0.5); g.fillRect(-3, -34, 6, 36); g.restore();
  // head log with face
  if (src) g.drawImage(src, R.face[0], R.face[1], R.face[2], R.face[3], 22, 8, 20, 36);
  else { g.fillStyle = '#94623a'; g.fillRect(22, 8, 20, 36); }
  g.fillStyle = '#16161a'; g.fillRect(20, 42, 24, 7);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export class GoonRenderer {
  // capacities: { head: n, body: n, ... , silhouette: n, sprite: n }
  constructor(scene, atlas, parts, capacities, refImage) {
    this.material = new ShaderMaterial({
      uniforms: { ...U, tAtlas: { value: atlas } },
      vertexShader: VS,
      fragmentShader: FS,
    });
    this.meshes = [];
    this.fx = [];
    this.counts = new Int32Array(PART_NAMES.length + 1);
    const names = [...PART_NAMES, 'silhouette'];
    for (let i = 0; i < names.length; i++) {
      const cap = capacities[names[i]];
      const geo = parts[names[i]];
      const fx = new Float32Array(cap * 3);
      const attr = new InstancedBufferAttribute(fx, 3).setUsage(DynamicDrawUsage);
      geo.setAttribute('aFx', attr);
      const m = new InstancedMesh(geo, this.material, cap);
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false; // instances move; we cull per enemy ourselves
      m.count = 0;
      m.name = `goon_${names[i]}`;
      scene.add(m);
      this.meshes.push(m);
      this.fx.push({ array: fx, attr });
    }
    this.SIL = PART_NAMES.length;

    // Sprite LOD
    const spriteTex = refImage ? new CanvasTexture(refImage) : paintSprite(atlas.image);
    spriteTex.colorSpace = SRGBColorSpace;
    const cap = capacities.sprite;
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.spritePos = new Float32Array(cap * 4);
    this.spriteFlash = new Float32Array(cap);
    this.spriteAttrs = [
      new InstancedBufferAttribute(this.spritePos, 4).setUsage(DynamicDrawUsage),
      new InstancedBufferAttribute(this.spriteFlash, 1).setUsage(DynamicDrawUsage),
    ];
    g.setAttribute('aPos', this.spriteAttrs[0]);
    g.setAttribute('aFlash', this.spriteAttrs[1]);
    g.instanceCount = 0;
    this.spriteGeo = g;
    this.spriteCap = cap;
    this.spriteCount = 0;
    this.spriteMesh = new Mesh(g, new ShaderMaterial({
      uniforms: { ...U, tSprite: { value: spriteTex } }, vertexShader: SPRITE_VS, fragmentShader: SPRITE_FS,
    }));
    this.spriteMesh.frustumCulled = false;
    scene.add(this.spriteMesh);
  }

  begin() {
    this.counts.fill(0);
    this.spriteCount = 0;
  }

  // part: index into PART_NAMES, or this.SIL for the silhouette mesh.
  push(part, matrix, glow, flash, fade) {
    const m = this.meshes[part];
    const n = this.counts[part];
    if (n >= m.instanceMatrix.count) return;
    matrix.toArray(m.instanceMatrix.array, n * 16);
    const fx = this.fx[part].array;
    fx[n * 3] = glow; fx[n * 3 + 1] = flash; fx[n * 3 + 2] = fade;
    this.counts[part] = n + 1;
  }

  pushSprite(x, y, z, height, flash) {
    if (this.spriteCount >= this.spriteCap) return;
    const o = this.spriteCount * 4;
    this.spritePos[o] = x; this.spritePos[o + 1] = y; this.spritePos[o + 2] = z; this.spritePos[o + 3] = height;
    this.spriteFlash[this.spriteCount] = flash;
    this.spriteCount++;
  }

  end() {
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      const n = this.counts[i];
      m.count = n;
      m.visible = n > 0;
      if (n > 0) {
        m.instanceMatrix.needsUpdate = true;
        this.fx[i].attr.needsUpdate = true;
      }
    }
    this.spriteGeo.instanceCount = this.spriteCount;
    this.spriteMesh.visible = this.spriteCount > 0;
    if (this.spriteCount > 0) {
      this.spriteAttrs[0].needsUpdate = true;
      this.spriteAttrs[1].needsUpdate = true;
    }
  }

  visibleInstances() {
    let n = this.spriteCount;
    for (let i = 0; i < this.counts.length; i++) n += this.counts[i];
    return n;
  }
}
