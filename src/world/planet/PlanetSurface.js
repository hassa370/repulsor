import {
  BatchedMesh, BufferAttribute, BufferGeometry, Matrix4, Quaternion, ShaderMaterial, Sphere, Vector3,
} from 'three';
import { PLANET, TERRAIN, WORLD_BUDGET } from '../../config.js';
import { COMMON_GLSL, U } from '../shared.js';
import { buildChunkIndex, faceDir, nodeKey, nodeSize, skirtSource } from './CubeSphere.js';
import { MAX_TERRAIN_HEIGHT, sampleSurface, surfaceColor } from './TerrainGenerator.js';

// Streams the planet surface as a cube-sphere quadtree of fixed-resolution
// chunks. The same system is the high-detail ground under your feet and the
// whole planet seen from orbit: as you climb, the selected leaves simply get
// coarser (and fewer) until only a handful of face-level chunks remain.
//
//  * Selection is best-first under hard budgets (leaf count, high-detail
//    count): the most urgent splits (near, in view, ahead of your velocity)
//    win, so the tree can never grow past WORLD_BUDGET.
//  * Chunks live in a fixed pool of BatchedMesh slots (one draw call per depth
//    pass for the whole terrain). A slot is regenerated in place: no Mesh or
//    geometry objects are created or disposed while flying.
//  * Generation is time-sliced through the GenerationScheduler, coarse-first
//    and nearest-first. Missing chunks fall back to the nearest ready
//    ancestor, so there are never holes; skirts hide LOD cracks.
//  * Chunk vertices are float32 offsets from a float64 chunk centre; the
//    per-instance matrix is rebuilt from global coordinates on every origin
//    shift, so the terrain is precise at any distance from the city.

const terrainVS = /* glsl */ `
#include <batching_pars_vertex>
attribute vec4 aColor; // linear albedo, alpha = water
varying vec3 vWorld;
varying vec3 vN;
varying vec4 vCol;
void main() {
  mat4 m = modelMatrix;
  #ifdef USE_BATCHING
    #include <batching_vertex>
    m = m * batchingMatrix;
  #endif
  vec4 wp = m * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = mat3(m) * normal;
  vCol = aColor;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const terrainFS = /* glsl */ `
${COMMON_GLSL}
uniform vec3 uPlanetC; // planet centre in the local frame
varying vec3 vWorld;
varying vec3 vN;
varying vec4 vCol;
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 up = normalize(vWorld - uPlanetC);
  float sunUp = dot(up, uSunDir);
  float day = smoothstep(-0.12, 0.1, sunUp);
  vec3 col;
  if (vCol.a > 0.5) {
    // Ocean: fresnel sky reflection + sun glint (no textures).
    vec3 R = reflect(-V, up);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(up, V), 0.0), 5.0);
    vec3 body = vCol.rgb * (uAmbientSky * mix(0.05, 0.8, day) + uSunColor * max(sunUp, 0.0));
    col = mix(body, skyReflect(R) * mix(0.03, 1.0, day), clamp(fres * 1.2 + 0.05, 0.0, 1.0));
    col += uSunColor * pow(max(dot(R, uSunDir), 0.0), 220.0) * 3.0 * day;
  } else {
    vec3 N = normalize(vN);
    float ndl = max(dot(N, uSunDir), 0.0) * day;
    vec3 amb = mix(uAmbientGround, uAmbientSky, dot(N, up) * 0.5 + 0.5) * mix(0.05, 1.0, day);
    col = vCol.rgb * (amb + uSunColor * ndl);
  }
  // Height haze; darker on the night side of the planet.
  float f = fogFactor(dist, -V);
  float s = pow(max(dot(-V, uSunDir), 0.0), 6.0);
  col = mix(col, (uFogColor + uSunColor * s * 0.2) * mix(0.04, 1.0, day), f);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const R = PLANET.radius;
const N = TERRAIN.vertsPerSide;
const G = N + 2; // sample grid with a one-vertex border for normals
const NV = N * N + 4 * N;
const INDEX = buildChunkIndex(N);
const NI = INDEX.length;
const HORIZON_R = R - 10;
const HORIZON_NODE = Math.acos(HORIZON_R / (R + MAX_TERRAIN_HEIGHT));

class Node {
  constructor() {
    this.face = 0; this.level = 0; this.ix = 0; this.iy = 0; this.key = 0;
    this.dx = 0; this.dy = 0; this.dz = 0; // unit centre direction
    this.cx = 0; this.cy = 0; this.cz = 0; // approximate global centre
    this.size = 0; this.bound = 0;
    this.dist = 0; this.prio = 0; this.visible = true;
    this.splitFrame = -1; this.seen = 0;
    this.requestFrame = -1;
    this.priority = 0; // scheduler priority (lower = sooner)
    this.run = null; // scheduler job (bound once)
  }
}

class Chunk {
  constructor(slot, geometryId, instanceId) {
    this.slot = slot; this.geometryId = geometryId; this.instanceId = instanceId;
    this.key = -1; this.node = null; this.ready = false;
    this.cx = 0; this.cy = 0; this.cz = 0; // global centre (float64)
    this.radius = 0;
    this.lx = 0; this.ly = 0; this.lz = 0; // centre in the local frame
    this.lastUsed = 0; this.renderFrame = -1; this.near = true; this.shown = false;
  }
}

// Binary max-heap on node.prio (preallocated, reused every frame).
class NodeHeap {
  constructor() { this.a = []; this.n = 0; }
  clear() { this.n = 0; }
  push(x) {
    const a = this.a;
    let i = this.n++;
    a[i] = x;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].prio >= a[i].prio) break;
      const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a[--this.n];
    if (this.n > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.n && a[l].prio > a[m].prio) m = l;
        if (r < this.n && a[r].prio > a[m].prio) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  }
}

const _m = new Matrix4();
const _p = new Vector3();
const _one = new Vector3(1, 1, 1);
const _dir = new Float64Array(3);
const _surf = { r: 0, ground: 0, water: 0, urban: 0, flat: 0 };

export class PlanetSurface {
  constructor(origin, scheduler) {
    this.origin = origin;
    this.scheduler = scheduler;
    this.frame = 0;
    this.maxLeaves = WORLD_BUDGET.maxLeafChunks;
    this.maxHigh = WORLD_BUDGET.maxHighDetailChunks;
    this.splitFactor = TERRAIN.splitFactor;
    this.maxLevel = TERRAIN.maxLevel;
    this.nodes = new Map();
    this.nodePool = [];
    this.heap = new NodeHeap();
    this.kids = [null, null, null, null];
    this.chunks = new Map(); // key -> Chunk
    this.slots = []; // every Chunk (fixed pool)
    this.freeChunks = [];
    this.render = []; // chunks drawn this frame
    this.renderCount = 0;
    this.prevRender = [];
    this.stats = { loaded: 0, leaves: 0, high: 0, rendered: 0, near: 0, far: 0, generated: 0, evicted: 0, nodes: 0 };
    this.nearMax = 0; this.farMin = Infinity; this.farMax = 0;
    this.visDist = Infinity;
    this.camG = new Vector3(); this.predG = new Vector3(); this.lookG = new Vector3(0, 0, -1);
    this.camL = new Vector3();

    // Scratch geometry reused for every chunk build.
    this.gp = new Float64Array(G * G * 3); // global positions of the sample grid
    this.gw = new Uint8Array(G * G); // water flags
    this.gc = new Float32Array(G * G * 4); // colour inputs: ground h, urban, flat, (unused)
    this.pos = new Float32Array(NV * 3);
    this.nrm = new Float32Array(NV * 3);
    this.col = new Uint8Array(NV * 4);
    this.tmpCol = new Float32Array(3);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new BufferAttribute(this.nrm, 3));
    g.setAttribute('aColor', new BufferAttribute(this.col, 4, true));
    g.setIndex(new BufferAttribute(new Uint16Array(INDEX), 1));
    g.boundingSphere = new Sphere(new Vector3(), 1);
    this.scratch = g;

    this.material = new ShaderMaterial({
      uniforms: { ...U, uPlanetC: { value: origin.planetCenterLocal } },
      vertexShader: terrainVS,
      fragmentShader: terrainFS,
      // Coplanar city ground / water planes win over the terrain beneath them.
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4,
    });
    const slots = WORLD_BUDGET.maxSurfaceChunks;
    const mesh = new BatchedMesh(slots, slots * NV, slots * NI, this.material);
    mesh.frustumCulled = false; // per-instance culling instead
    mesh.perObjectFrustumCulled = true;
    mesh.sortObjects = false;
    mesh.name = 'planet-terrain';
    for (let s = 0; s < slots; s++) {
      const gid = mesh.addGeometry(g, NV, NI);
      const iid = mesh.addInstance(gid);
      mesh.setVisibleAt(iid, false);
      const ch = new Chunk(s, gid, iid);
      this.slots.push(ch);
      this.freeChunks.push(ch);
    }
    this.mesh = mesh;
    origin.onShift(() => this.onShift());
    this._trim = (n, key) => {
      if (n.seen >= this._trimBefore || n.level === 0 || this.chunks.has(key)) return;
      this.nodes.delete(key);
      this.nodePool.push(n);
    };
    this._trimBefore = 0;
  }

  // ------------------------------------------------------------------ nodes
  getNode(face, level, ix, iy) {
    const key = nodeKey(face, level, ix, iy);
    let n = this.nodes.get(key);
    if (n) { n.seen = this.frame; return n; }
    n = this.nodePool.pop() || new Node();
    if (!n.run) { const node = n; n.run = () => this.generate(node); }
    n.face = face; n.level = level; n.ix = ix; n.iy = iy; n.key = key;
    n.splitFrame = -1; n.requestFrame = -1; n.seen = this.frame;
    const cells = 1 << level;
    const s = 2 / cells;
    faceDir(face, -1 + (ix + 0.5) * s, -1 + (iy + 0.5) * s, _dir);
    n.dx = _dir[0]; n.dy = _dir[1]; n.dz = _dir[2];
    n.size = nodeSize(R, level);
    const r = sampleSurface(n.dx, n.dy, n.dz, n.size / 4).r;
    n.cx = n.dx * r; n.cy = n.dy * r; n.cz = n.dz * r;
    n.bound = n.size * 0.72 + Math.min(MAX_TERRAIN_HEIGHT, n.size * 0.25);
    this.nodes.set(key, n);
    return n;
  }

  // Split priority = chunk size / distance (a screen-space error proxy),
  // using the nearer of the current and velocity-predicted camera positions,
  // boosted for chunks in front of the view. prio > 1 / splitFactor => split.
  evaluate(n) {
    const c = this.camG, pr = this.predG;
    const dx = n.cx - c.x, dy = n.cy - c.y, dz = n.cz - c.z;
    const dc = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const ex = n.cx - pr.x, ey = n.cy - pr.y, ez = n.cz - pr.z;
    const d = Math.min(dc, Math.sqrt(ex * ex + ey * ey + ez * ez));
    n.dist = Math.max(0, d - n.bound);
    // Horizon culling (ocean-level horizon; mountains may peek over it).
    const camR = c.length();
    if (camR > HORIZON_R) {
      const cosA = (n.dx * c.x + n.dy * c.y + n.dz * c.z) / camR;
      const ang = Math.acos(Math.min(1, Math.max(-1, cosA)));
      n.visible = ang - n.bound / R < Math.acos(HORIZON_R / camR) + HORIZON_NODE;
    } else n.visible = true;
    // Fully hazed chunks are neither drawn nor split (the sky's horizon colour
    // matches the haze there).
    if (n.dist > this.visDist) n.visible = false;
    let view = 0;
    if (dc > 1) view = Math.max(0, (dx * this.lookG.x + dy * this.lookG.y + dz * this.lookG.z) / dc);
    n.prio = n.visible ? n.size / Math.max(d, 1) * (1 + TERRAIN.viewBias * view) : 0;
  }

  // Best-first split under the leaf / high-detail budgets. Only visible
  // leaves count: chunks behind the horizon or lost in the haze cost nothing.
  select() {
    const heap = this.heap;
    heap.clear();
    const frame = this.frame;
    const minPrio = 1 / this.splitFactor;
    const highLevel = this.maxLevel - 1;
    const kids = this.kids;
    let leaves = 0, high = 0;
    for (let f = 0; f < 6; f++) {
      const root = this.getNode(f, 0, 0, 0);
      root.splitFrame = -1;
      this.evaluate(root);
      if (root.visible) leaves++;
      if (root.prio > minPrio) heap.push(root);
    }
    while (heap.n > 0) {
      const n = heap.pop();
      if (n.prio <= minPrio) break;
      const cl = n.level + 1;
      let vis = 0;
      for (let k = 0; k < 4; k++) {
        const c = this.getNode(n.face, cl, n.ix * 2 + (k & 1), n.iy * 2 + (k >> 1));
        c.splitFrame = -1;
        this.evaluate(c);
        if (c.visible) vis++;
        kids[k] = c;
      }
      const addLeaves = vis - 1;
      if (leaves + addLeaves > this.maxLeaves) continue;
      const addHigh = cl >= highLevel ? vis - (n.level >= highLevel ? 1 : 0) : 0;
      if (addHigh > 0 && high + addHigh > this.maxHigh) continue;
      n.splitFrame = frame;
      leaves += addLeaves;
      high += addHigh;
      if (cl < this.maxLevel) for (let k = 0; k < 4; k++) if (kids[k].prio > minPrio) heap.push(kids[k]);
    }
    this.stats.leaves = leaves;
    this.stats.high = high;
  }

  // Coverage pass: every leaf area is drawn by the leaf's chunk, or the
  // nearest ready ancestor if the leaf isn't generated yet. Missing chunks are
  // requested (coarse gaps first so fallbacks refine progressively).
  collect(n) {
    const frame = this.frame;
    if (n.splitFrame !== frame) {
      if (!n.visible) return true;
      const ch = this.chunks.get(n.key);
      if (ch && ch.ready) { this.emit(ch); return true; }
      this.requestFor(n);
      return false;
    }
    const mark = this.renderCount;
    const cl = n.level + 1;
    let ok = true;
    for (let k = 0; k < 4; k++) {
      const c = this.getNode(n.face, cl, n.ix * 2 + (k & 1), n.iy * 2 + (k >> 1));
      if (!this.collect(c)) ok = false;
    }
    if (ok) return true;
    const ch = this.chunks.get(n.key);
    if (ch && ch.ready) {
      this.renderCount = mark;
      this.emit(ch);
      return true;
    }
    return false;
  }

  requestFor(leaf) {
    // Walk up to the deepest ready ancestor; if the gap is large, generate the
    // next level down from it first (progressive refinement, no long waits on
    // a planet-sized fallback).
    let target = leaf;
    let n = leaf, gap = 0;
    while (n.level > 0) {
      const p = this.getNode(n.face, n.level - 1, n.ix >> 1, n.iy >> 1);
      gap++;
      const ch = this.chunks.get(p.key);
      if (ch && ch.ready) break;
      if (gap > 2) target = p;
      n = p;
    }
    if (target.requestFrame === this.frame) return;
    target.requestFrame = this.frame;
    target.priority = target.level * 0.35 + (target.dist + 1) / target.size;
    this.scheduler.request(target);
  }

  emit(ch) {
    ch.lastUsed = this.frame;
    this.render[this.renderCount++] = ch;
  }

  // ------------------------------------------------------------- generation
  acquireChunk() {
    if (this.freeChunks.length) return this.freeChunks.pop();
    // Evict the least recently used chunk that isn't drawn and isn't a root.
    let best = null;
    for (let i = 0; i < this.slots.length; i++) {
      const ch = this.slots[i];
      if (!ch.ready || ch.renderFrame === this.frame || ch.node.level === 0) continue;
      if (!best || ch.lastUsed < best.lastUsed) best = ch;
    }
    if (!best || best.lastUsed >= this.frame - 1) return null; // everything in use: respect the cap
    this.chunks.delete(best.key);
    this.mesh.setVisibleAt(best.instanceId, false);
    best.shown = false;
    best.ready = false;
    this.stats.evicted++;
    return best;
  }

  generate(node) {
    if (this.chunks.has(node.key)) return;
    const ch = this.acquireChunk();
    if (!ch) return;
    this.buildChunk(node, ch);
    ch.key = node.key;
    ch.node = node;
    ch.ready = true;
    ch.lastUsed = this.frame;
    this.chunks.set(node.key, ch);
    this.updateChunkMatrix(ch);
    this.stats.generated++;
  }

  buildChunk(node, ch) {
    const cells = 1 << node.level;
    const span = 2 / cells;
    const step = span / (N - 1);
    const u0 = -1 + node.ix * span, v0 = -1 + node.iy * span;
    const minWl = (node.size / (N - 1)) * 2.5;
    const gp = this.gp, gw = this.gw, gc = this.gc;
    for (let gj = 0; gj < G; gj++) {
      for (let gi = 0; gi < G; gi++) {
        const k = gj * G + gi;
        faceDir(node.face, u0 + (gi - 1) * step, v0 + (gj - 1) * step, _dir);
        const s = sampleSurface(_dir[0], _dir[1], _dir[2], minWl);
        gp[k * 3] = _dir[0] * s.r; gp[k * 3 + 1] = _dir[1] * s.r; gp[k * 3 + 2] = _dir[2] * s.r;
        gw[k] = s.water;
        gc[k * 4] = s.ground; gc[k * 4 + 1] = s.urban; gc[k * 4 + 2] = s.flat;
      }
    }
    // Chunk centre = middle sample (N is odd).
    const mid = ((N - 1) / 2 + 1) * G + (N - 1) / 2 + 1;
    const cx = gp[mid * 3], cy = gp[mid * 3 + 1], cz = gp[mid * 3 + 2];
    ch.cx = cx; ch.cy = cy; ch.cz = cz;
    const pos = this.pos, nrm = this.nrm, col = this.col, tc = this.tmpCol;
    const surf = _surf;
    let r2 = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v = j * N + i;
        const k = (j + 1) * G + (i + 1);
        const px = gp[k * 3] - cx, py = gp[k * 3 + 1] - cy, pz = gp[k * 3 + 2] - cz;
        pos[v * 3] = px; pos[v * 3 + 1] = py; pos[v * 3 + 2] = pz;
        const d2 = px * px + py * py + pz * pz;
        if (d2 > r2) r2 = d2;
        // normal = d/du x d/dv (outward)
        const kl = k - 1, kr = k + 1, kd = k - G, ku = k + G;
        const ax = gp[kr * 3] - gp[kl * 3], ay = gp[kr * 3 + 1] - gp[kl * 3 + 1], az = gp[kr * 3 + 2] - gp[kl * 3 + 2];
        const bx = gp[ku * 3] - gp[kd * 3], by = gp[ku * 3 + 1] - gp[kd * 3 + 1], bz = gp[ku * 3 + 2] - gp[kd * 3 + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const nl = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
        nx *= nl; ny *= nl; nz *= nl;
        nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz;
        // colour from height / slope / zone
        const gr = Math.sqrt(gp[k * 3] * gp[k * 3] + gp[k * 3 + 1] * gp[k * 3 + 1] + gp[k * 3 + 2] * gp[k * 3 + 2]);
        const slope = 1 - (nx * gp[k * 3] + ny * gp[k * 3 + 1] + nz * gp[k * 3 + 2]) / gr;
        surf.water = gw[k]; surf.ground = gc[k * 4]; surf.urban = gc[k * 4 + 1]; surf.flat = gc[k * 4 + 2];
        surfaceColor(surf, surf.water ? 0 : slope, tc, 0);
        col[v * 4] = Math.min(255, tc[0] * 255 + 0.5);
        col[v * 4 + 1] = Math.min(255, tc[1] * 255 + 0.5);
        col[v * 4 + 2] = Math.min(255, tc[2] * 255 + 0.5);
        col[v * 4 + 3] = surf.water ? 255 : 0;
      }
    }
    // Skirts: copies of the edge vertices pushed down toward the planet centre.
    const skirt = Math.min(node.size * TERRAIN.skirtFactor, 3000) + 2;
    for (let e = 0; e < 4; e++) {
      for (let t = 0; t < N; t++) {
        const src = skirtSource(N, e, t);
        const v = N * N + e * N + t;
        const sx = pos[src * 3] + cx, sy = pos[src * 3 + 1] + cy, sz = pos[src * 3 + 2] + cz;
        const inv = skirt / Math.sqrt(sx * sx + sy * sy + sz * sz);
        pos[v * 3] = pos[src * 3] - sx * inv;
        pos[v * 3 + 1] = pos[src * 3 + 1] - sy * inv;
        pos[v * 3 + 2] = pos[src * 3 + 2] - sz * inv;
        nrm[v * 3] = nrm[src * 3]; nrm[v * 3 + 1] = nrm[src * 3 + 1]; nrm[v * 3 + 2] = nrm[src * 3 + 2];
        col[v * 4] = col[src * 4]; col[v * 4 + 1] = col[src * 4 + 1]; col[v * 4 + 2] = col[src * 4 + 2]; col[v * 4 + 3] = col[src * 4 + 3];
      }
    }
    ch.radius = Math.sqrt(r2) + skirt;
    this.scratch.boundingSphere.radius = ch.radius;
    this.mesh.setGeometryAt(ch.geometryId, this.scratch);
  }

  updateChunkMatrix(ch) {
    const o = this.origin;
    _p.set(ch.cx, ch.cy, ch.cz);
    o.globalToLocal(_p, _p);
    ch.lx = _p.x; ch.ly = _p.y; ch.lz = _p.z;
    _m.compose(_p, o.qInv, _one);
    this.mesh.setMatrixAt(ch.instanceId, _m);
  }

  onShift() {
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i].ready) this.updateChunkMatrix(this.slots[i]);
  }

  // -------------------------------------------------------------- per frame
  // camLocal: camera position (local); velLocal: player velocity; lookLocal:
  // view direction. visDist: distance beyond which the terrain is fully hazed.
  update(camLocal, velLocal, lookLocal, visDist) {
    this.frame++;
    const o = this.origin;
    this.camL.copy(camLocal);
    o.localToGlobal(camLocal, this.camG);
    _p.copy(velLocal).multiplyScalar(TERRAIN.lookaheadSeconds).add(camLocal);
    o.localToGlobal(_p, this.predG);
    o.localDirToGlobal(lookLocal, this.lookG);
    this.visDist = visDist;
    this.select();
    // Coverage + requests.
    this.renderCount = 0;
    for (let f = 0; f < 6; f++) this.collect(this.getNode(f, 0, 0, 0));
    this.render.length = this.renderCount;
    for (let i = 0; i < this.renderCount; i++) this.render[i].renderFrame = this.frame;
    this.assignPasses();
    this.stats.loaded = this.chunks.size;
    this.stats.rendered = this.renderCount;
    this.stats.nodes = this.nodes.size;
    if ((this.frame & 127) === 0) this.trimNodes();
  }

  // Prime: generate everything the current view needs (loading screen / respawn).
  prime(camLocal, velLocal, lookLocal, visDist) {
    for (let i = 0; i < 24; i++) {
      this.update(camLocal, velLocal, lookLocal, visDist);
      if (this.scheduler.count === 0) break;
      this.scheduler.flush();
    }
    this.update(camLocal, velLocal, lookLocal, visDist);
  }

  // Near/far depth-pass split + the depth ranges each pass needs.
  assignPasses() {
    const c = this.camL;
    let nearMax = 0, farMin = Infinity, farMax = 0, nn = 0, nf = 0;
    for (let i = 0; i < this.renderCount; i++) {
      const ch = this.render[i];
      const dx = ch.lx - c.x, dy = ch.ly - c.y, dz = ch.lz - c.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const dn = Math.max(0, d - ch.radius);
      ch.near = dn < TERRAIN.nearSplit;
      if (ch.near) { nn++; if (d + ch.radius > nearMax) nearMax = d + ch.radius; }
      else { nf++; if (dn < farMin) farMin = dn; if (d + ch.radius > farMax) farMax = d + ch.radius; }
    }
    // Hide chunks that dropped out of the draw set.
    for (let i = 0; i < this.prevRender.length; i++) {
      const ch = this.prevRender[i];
      if (ch.renderFrame !== this.frame && ch.shown) { this.mesh.setVisibleAt(ch.instanceId, false); ch.shown = false; }
    }
    const pr = this.prevRender;
    pr.length = this.renderCount;
    for (let i = 0; i < this.renderCount; i++) pr[i] = this.render[i];
    this.nearMax = nearMax; this.farMin = farMin; this.farMax = farMax;
    this.stats.near = nn; this.stats.far = nf;
  }

  // Show only the chunks belonging to one depth pass.
  setPass(near) {
    for (let i = 0; i < this.renderCount; i++) {
      const ch = this.render[i];
      const vis = ch.near === near;
      if (vis !== ch.shown) { this.mesh.setVisibleAt(ch.instanceId, vis); ch.shown = vis; }
    }
  }

  trimNodes() {
    this._trimBefore = this.frame - 240;
    this.nodes.forEach(this._trim);
  }

  setBudget(leaves, high, split) {
    this.maxLeaves = Math.min(leaves, WORLD_BUDGET.maxLeafChunks);
    this.maxHigh = Math.min(high, WORLD_BUDGET.maxHighDetailChunks);
    this.splitFactor = split;
  }
}
