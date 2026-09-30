// Asset pipeline: `npm run assets`
//
// Turns the raw downloads in public/models/source/ into small, GPU-friendly GLBs in public/models/:
//   dedup + weld + prune, meshopt-compressed geometry, KTX2 (Basis ETC1S) textures capped at
//   1024px (512px for enemies/cars), scale fixed to metres and pivots at the feet.
// Every asset prints tris / draw calls / texture MB before and after.
//
// Sources that are missing are skipped with a note, so the script can run on a partial set.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, flatten, join, reorder, resample, getBounds,
  clearNodeTransform, transformMesh, simplifyPrimitive,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import { encodeToKTX2 } from 'ktx2-encoder';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'public/models/source');
const OUT = path.join(ROOT, 'public/models');
const TMP = path.join(ROOT, 'node_modules/.cache/repulsor-assets');

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
});

const only = process.argv.slice(2);
const report = [];

// ---------------------------------------------------------------------------------------------
// Stats

function texGpuBytes(w, h, bpp) { return w * h * bpp * 4 / 3; } // + mip chain

function stats(doc, { scene = true, lodFilter = null } = {}) {
  const root = doc.getRoot();
  let tris = 0, draws = 0;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (lodFilter && !lodFilter(node)) continue;
    for (const p of mesh.listPrimitives()) {
      const n = p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount();
      tris += n / 3;
      draws++;
    }
  }
  let texRaw = 0, texFile = 0;
  for (const t of root.listTextures()) {
    const img = t.getImage();
    if (!img) continue;
    texFile += img.byteLength;
    const size = t.getMimeType() === 'image/ktx2' ? ktx2Size(img) : t.getSize();
    if (!size) continue;
    // KTX2/Basis transcodes to ASTC 4x4 on Quest (1 byte/px); PNG/JPG upload as RGBA8 (4 bytes/px).
    texRaw += texGpuBytes(size[0], size[1], t.getMimeType() === 'image/ktx2' ? 1 : 4);
  }
  return { tris: Math.round(tris), draws, texGpuMB: texRaw / 1048576, texFileMB: texFile / 1048576 };
}

function ktx2Size(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return [dv.getUint32(20, true), dv.getUint32(24, true)];
}

function addReport(name, before, after, note = '') {
  report.push({ name, before, after, note });
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

/** Bake every node transform into its mesh so all geometry sits in scene space. */
async function bake(doc) {
  await doc.transform(flatten());
  const done = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) { continue; }
    if (done.has(mesh)) { node.setMesh(deepCloneMesh(mesh)); }
    done.add(node.getMesh());
    clearNodeTransform(node);
  }
}

/** Apply a column-major 4x4 to every (baked) mesh in the document. */
function transformAll(doc, m) {
  const done = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || done.has(mesh)) continue;
    done.add(mesh);
    transformMesh(mesh, m);
  }
}

const mat = {
  scaleTranslate(s, tx, ty, tz) { return [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, s * tx, s * ty, s * tz, 1]; },
  rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; },
  mul(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
  },
};

/** Scale so the chosen axis spans `size` metres, then put the pivot at the feet (or centre). */
function normalize(doc, { height, length, pivot = 'feet', yaw = 0 }) {
  const scene = doc.getRoot().listScenes()[0];
  transformAll(doc, mat.rotY(yaw));
  const b = getBounds(scene);
  const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const s = height ? height / ext[1] : length / Math.max(...ext);
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const cy = pivot === 'feet' ? b.min[1] : (b.min[1] + b.max[1]) / 2;
  transformAll(doc, mat.scaleTranslate(s, -cx, -cy, -cz));
  return s;
}

/** Remove every texture slot except base colour (and optionally emissive); drop tangents. */
function keepBaseColor(doc, { emissive = false } = {}) {
  for (const m of doc.getRoot().listMaterials()) {
    m.setNormalTexture(null).setOcclusionTexture(null).setMetallicRoughnessTexture(null);
    if (!emissive) m.setEmissiveTexture(null).setEmissiveFactor([0, 0, 0]);
  }
  // Unused morph targets (the AK ships one at weight 0) cost vertex fetch and inflate bounds.
  for (const a of doc.getRoot().listAnimations()) for (const c of a.listChannels()) {
    if (c.getTargetPath() === 'weights') { c.getSampler()?.dispose(); c.dispose(); }
  }
  for (const mesh of doc.getRoot().listMeshes()) {
    mesh.setWeights([]);
    mesh.setExtras({});
    for (const p of mesh.listPrimitives()) for (const t of p.listTargets()) { p.removeTarget(t); t.dispose(); }
  }
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    p.setAttribute('TANGENT', null);
    for (const s of p.listSemantics()) if (/^TEXCOORD_[1-9]/.test(s)) p.setAttribute(s, null);
  }
}

function deepClonePrim(p) {
  const q = p.clone();
  for (const s of q.listSemantics()) q.setAttribute(s, q.getAttribute(s).clone());
  if (q.getIndices()) q.setIndices(q.getIndices().clone());
  return q;
}

function deepCloneMesh(mesh) {
  const m = mesh.clone();
  for (const p of m.listPrimitives()) { m.removePrimitive(p); m.addPrimitive(deepClonePrim(p)); }
  return m;
}

function tris(prim) { return prim.getIndices().getCount() / 3; }

/** Simplify a primitive (in place) towards `target` triangles, falling back to sloppy mode. */
function simplifyTo(doc, prim, target) {
  const start = tris(prim);
  if (start <= target) return;
  simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: target / start, error: 0.02 });
  if (tris(prim) > target * 1.15) {
    simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: target / tris(prim), error: 0.08 });
  }
  if (tris(prim) > target * 1.15) {
    // Last resort: sloppy simplification ignores topology (fine for distant LODs).
    const idx = prim.getIndices();
    const pos = prim.getAttribute('POSITION').getArray();
    const [out] = MeshoptSimplifier.simplifySloppy(new Uint32Array(idx.getArray()), pos, 3, null, target * 3, 0.2);
    idx.setArray(out);
  }
}

// ---------------------------------------------------------------------------------------------
// Textures

async function toPixels(img) {
  const { data, info } = await sharp(img).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

function pow2Floor(n) { return 2 ** Math.floor(Math.log2(n)); }

async function encodeKtx2(png, { srgb = true } = {}) {
  // The Basis wasm module prints per-slice logs through console.log; mute it while encoding.
  const log = console.log;
  console.log = () => {};
  try { return await encodeToKTX2(png, {
    isUASTC: false, qualityLevel: 160, compressionLevel: 2, generateMipmap: true,
    isSetKTX2SRGBTransferFunc: srgb, imageDecoder: toPixels,
  }); } finally { console.log = log; }
}

/** Resize every texture to <= maxSize (power of two) and encode it as KTX2/Basis. */
async function compressTextures(doc, maxSize) {
  const basisu = doc.createExtension(KHRTextureBasisu).setRequired(true);
  void basisu;
  for (const t of doc.getRoot().listTextures()) {
    if (t.getMimeType() === 'image/ktx2') continue;
    const [w, h] = t.getSize();
    const tw = Math.min(maxSize, pow2Floor(w)), th = Math.min(maxSize, pow2Floor(h));
    const png = await sharp(t.getImage()).resize(tw, th, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    const ktx = await encodeKtx2(new Uint8Array(png));
    t.setImage(ktx).setMimeType('image/ktx2');
    if (t.getURI()) t.setURI(t.getURI().replace(/\.[a-z]+$/i, '.ktx2'));
  }
}

async function write(doc, file) {
  await doc.transform(dedup(), prune({ keepAttributes: false }), reorder({ encoder: MeshoptEncoder }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await io.write(file, doc);
  return fs.statSync(file).size / 1048576;
}

function fileMB(f) { return fs.statSync(f).size / 1048576; }

// ---------------------------------------------------------------------------------------------
// Jobs

const jobs = {
  // Player suit: one mesh, one material. Split into body parts at load time (see src/player/suit.js).
  async ironman() {
    const src = path.join(SRC, 'ironman_full_body_-_detailed_-_suit.glb');
    if (!exists(src)) return;
    const doc = await io.read(src);
    const before = { ...stats(doc), fileMB: fileMB(src) };
    await bake(doc);
    keepBaseColor(doc);
    await doc.transform(weld(), join());
    normalize(doc, { height: 1.8, pivot: 'feet' });
    await compressTextures(doc, 1024);
    const out = path.join(OUT, 'ironman.glb');
    const mb = await write(doc, out);
    addReport('ironman.glb', before, { ...stats(doc), fileMB: mb }, '1.80 m tall, feet pivot');
  },

  // Villain: LOD0 ~3k tris, LOD1 ~800 tris, one 512px base-colour texture.
  async tung() {
    const src = path.join(SRC, 'sigma_tung_tung_sahur_roblox_bundle_r15.glb');
    if (!exists(src)) return;
    const doc = await io.read(src);
    const before = { ...stats(doc), fileMB: fileMB(src) };
    await bake(doc);
    keepBaseColor(doc);
    await doc.transform(weld(), join());
    normalize(doc, { height: 1.8, pivot: 'feet' });
    const scene = doc.getRoot().listScenes()[0];
    const node0 = doc.getRoot().listNodes().find((n) => n.getMesh());
    node0.setName('lod0');
    node0.getMesh().setName('tung_lod0');
    // Mesh.clone() shares primitives: deep-copy the primitive so LOD1 can be simplified on its own.
    const lod1Mesh = doc.createMesh('tung_lod1');
    for (const p of node0.getMesh().listPrimitives()) lod1Mesh.addPrimitive(deepClonePrim(p));
    const lod1 = doc.createNode('lod1').setMesh(lod1Mesh);
    scene.addChild(lod1);
    simplifyTo(doc, node0.getMesh().listPrimitives()[0], 3000);
    simplifyTo(doc, lod1.getMesh().listPrimitives()[0], 800);
    await compressTextures(doc, 512);
    const out = path.join(OUT, 'tung.glb');
    const mb = await write(doc, out);
    const lod1Tris = stats(doc, { lodFilter: (n) => n.getName() === 'lod1' }).tris;
    addReport('tung.glb', before, { ...stats(doc, { lodFilter: (n) => n.getName() === 'lod0' }), fileMB: mb, texGpuMB: stats(doc).texGpuMB },
      `1.80 m, LOD1 ${lod1Tris} tris`);
  },

  // Rifle: skinned version (6 clips) for the closest enemies + a static bind-pose mesh for instancing.
  async ak47() {
    const src = path.join(SRC, 'ak47.glb');
    if (!exists(src)) return;
    const KEEP = { 'idle': 'idle', 'draw': 'draw', 'reload': 'reload', 'run cycle': 'run', 'shooting': 'shoot', 'walk': 'walk' };
    const LENGTH = 0.9;

    // --- skinned
    const doc = await io.read(src);
    const before = { ...stats(doc), fileMB: fileMB(src) };
    keepBaseColor(doc);
    for (const a of doc.getRoot().listAnimations()) {
      const short = a.getName().replace(/^.*\|/, '');
      if (KEEP[short]) a.setName(KEEP[short]); else a.dispose();
    }
    const staticDoc = await io.read(src);
    const scene = doc.getRoot().listScenes()[0];
    const b = getBounds(scene);
    const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const s = LENGTH / Math.max(...ext);
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const wrap = doc.createNode('ak47').setScale([s, s, s]).setTranslation([-c[0] * s, -c[1] * s, -c[2] * s]);
    for (const child of scene.listChildren()) { scene.removeChild(child); wrap.addChild(child); }
    scene.addChild(wrap);
    await doc.transform(resample());
    await compressTextures(doc, 512);
    const out = path.join(OUT, 'ak47.glb');
    const mb = await write(doc, out);
    addReport('ak47.glb', before, { ...stats(doc), fileMB: mb }, `skinned, clips: ${doc.getRoot().listAnimations().map((a) => a.getName()).join('/')}`);

    // --- static (CPU-skinned bind pose, no joints) for the instanced field version
    const sd = staticDoc;
    keepBaseColor(sd);
    for (const node of sd.getRoot().listNodes()) {
      const skin = node.getSkin();
      if (!skin) continue;
      // Spare magazine (Bone.002) and ejected casings (Bone.004/.005) float beside the gun in the
      // bind pose; they only matter for the skinned reload/shoot clips, so drop them here.
      bakeSkin(node, skin, /^Bone\.00[245]/);
      node.setSkin(null);
    }
    for (const a of sd.getRoot().listAnimations()) a.dispose();
    for (const sk of sd.getRoot().listSkins()) sk.dispose();
    // Skinned positions are already in scene space: move the meshes to identity nodes at the root.
    const sscene = sd.getRoot().listScenes()[0];
    const meshNodes = sd.getRoot().listNodes().filter((n) => n.getMesh());
    for (const n of sd.getRoot().listNodes()) if (!n.getMesh()) n.dispose();
    for (const n of meshNodes) { n.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]); sscene.addChild(n); }
    await sd.transform(weld(), join());
    normalize(sd, { length: LENGTH, pivot: 'center' });
    await compressTextures(sd, 512);
    const outS = path.join(OUT, 'ak47_static.glb');
    const mbS = await write(sd, outS);
    addReport('ak47_static.glb', before, { ...stats(sd), fileMB: mbS }, `${LENGTH} m long, centre pivot, instancing`);
  },

  // Car pack: one GLB per type; body + wheels + glass + lights merged into one mesh/material via an atlas.
  async cars() {
    const src = path.join(SRC, 'generic_passenger_car_pack_1.glb');
    if (!exists(src)) return;
    const doc = await io.read(src);
    const packBefore = { ...stats(doc), fileMB: fileMB(src) };
    const root = doc.getRoot();
    const bodies = root.listNodes().filter((n) => /body$/i.test(n.getName()) && !n.getMesh());
    const wheels = root.listNodes().filter((n) => /^wheel/i.test(n.getName()) && !n.getMesh());
    const summary = [];
    let totalAfter = { tris: 0, draws: 0, texGpuMB: 0, fileMB: 0 };
    for (const body of bodies) {
      const type = body.getName().replace(/\s*body$/i, '').toLowerCase();
      const bb = getBounds(body);
      const pad = 0.3;
      const mine = wheels.filter((w) => {
        const wb = getBounds(w);
        const cx = (wb.min[0] + wb.max[0]) / 2, cz = (wb.min[2] + wb.max[2]) / 2;
        return cx > bb.min[0] - pad && cx < bb.max[0] + pad && cz > bb.min[2] - pad && cz < bb.max[2] + pad;
      });
      const parts = [body, ...mine];
      // The pack is authored Z-up with the tail along the body node's local +Y; rotate that onto +Z so
      // every car faces -Z (same as the camera). The coupe is modelled sideways and needs a quarter turn.
      // Some bodies are also baked a few degrees off-axis, so the long axis comes from the wheel centres.
      const wm = body.getWorldMatrix();
      const fix = CAR_YAW_FIX[type] || 0;
      let tail = [wm[4] * Math.cos(fix) + wm[6] * Math.sin(fix), -wm[4] * Math.sin(fix) + wm[6] * Math.cos(fix)];
      const axis = wheelAxis(mine);
      if (axis) {
        const d = tail[0] * axis[0] + tail[1] * axis[1];
        tail = d >= 0 ? axis : [-axis[0], -axis[1]];
      }
      const yaw = Math.atan2(tail[0], tail[1]);
      const car = await buildCar(doc, parts, yaw, bb);
      const out = path.join(OUT, 'cars', `${type}.glb`);
      const mb = await write(car.doc, out);
      const after = { ...stats(car.doc, { lodFilter: (n) => n.getName() === 'lod0' }), texGpuMB: stats(car.doc).texGpuMB, fileMB: mb };
      summary.push(`${type} ${after.tris}/${car.lod1Tris} tris ${car.size.map((v) => v.toFixed(1)).join('x')}m`);
      totalAfter.tris += after.tris; totalAfter.draws += after.draws; totalAfter.texGpuMB += after.texGpuMB; totalAfter.fileMB += mb;
      addReport(`cars/${type}.glb`, null, after, `LOD1 ${car.lod1Tris} tris, ${car.size.map((v) => v.toFixed(2)).join(' x ')} m (w x h x l)`);
    }
    addReport('cars (pack total)', packBefore, totalAfter, `${bodies.length} types`);
  },

  // Office tower: FBX -> glTF (FBX2glTF), furniture dropped, materials merged to opaque + interior + glass.
  async office() {
    const src = path.join(SRC, 'office/source/BLD_OFFICE.fbx');
    if (!exists(src)) return;
    const conv = path.join(TMP, 'office');
    fs.mkdirSync(TMP, { recursive: true });
    const bin = path.join(ROOT, 'node_modules/fbx2gltf/bin', process.platform === 'win32' ? 'Windows_NT' : process.platform === 'darwin' ? 'Darwin' : 'Linux', process.platform === 'win32' ? 'FBX2glTF.exe' : 'FBX2glTF');
    execFileSync(bin, ['--binary', '-i', src, '-o', conv], { stdio: 'pipe' });
    const doc = await io.read(`${conv}.glb`);
    const before = { ...stats(doc), fileMB: fileMB(src) + dirMB(path.join(SRC, 'office/textures')) };
    await buildOffice(doc);
    const out = path.join(OUT, 'office.glb');
    const mb = await write(doc, out);
    const ex = doc.getRoot().listScenes()[0].getExtras();
    addReport('office.glb', before, { ...stats(doc), fileMB: mb }, `${ex.floors} floors @ ${ex.floorHeight.toFixed(2)} m, ${ex.size.map((v) => v.toFixed(1)).join(' x ')} m`);
  },
};

function exists(f) {
  if (fs.existsSync(f)) return true;
  console.log(`  - skip: ${path.relative(ROOT, f)} not found`);
  return false;
}

function dirMB(d) { return fs.readdirSync(d).reduce((a, f) => a + fileMB(path.join(d, f)), 0); }

// ---------------------------------------------------------------------------------------------
// Skinning bake (bind pose)

function m4mul(a, b) { return mat.mul(a, b); }
function m4apply(m, x, y, z, w) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w];
}

function bakeSkin(node, skin, dropJoints = null) {
  const joints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices();
  const jm = joints.map((j, i) => {
    const inv = ibm ? ibm.getElement(i, []) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return m4mul(j.getWorldMatrix(), inv);
  });
  const mesh = node.getMesh();
  for (const p of mesh.listPrimitives()) {
    const P = p.getAttribute('POSITION'), N = p.getAttribute('NORMAL');
    const J = p.getAttribute('JOINTS_0'), W = p.getAttribute('WEIGHTS_0');
    const pos = new Float32Array(P.getCount() * 3), nrm = N ? new Float32Array(N.getCount() * 3) : null;
    const v = [], n = [], j = [], w = [];
    for (let i = 0; i < P.getCount(); i++) {
      P.getElement(i, v); J.getElement(i, j); W.getElement(i, w);
      if (N) N.getElement(i, n);
      let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < 4; k++) {
        if (!w[k]) continue;
        const m = jm[j[k]];
        const a = m4apply(m, v[0], v[1], v[2], 1);
        px += a[0] * w[k]; py += a[1] * w[k]; pz += a[2] * w[k];
        if (N) { const b = m4apply(m, n[0], n[1], n[2], 0); nx += b[0] * w[k]; ny += b[1] * w[k]; nz += b[2] * w[k]; }
      }
      pos.set([px, py, pz], i * 3);
      if (N) { const l = Math.hypot(nx, ny, nz) || 1; nrm.set([nx / l, ny / l, nz / l], i * 3); }
    }
    const doc = Document.fromGraph(p.getGraph());
    p.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(P.getBuffer()));
    if (N) p.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(nrm).setBuffer(N.getBuffer()));
    if (dropJoints) {
      // Remove triangles whose vertices are dominated by a dropped joint.
      const drop = new Uint8Array(P.getCount());
      for (let i = 0; i < P.getCount(); i++) {
        J.getElement(i, j); W.getElement(i, w);
        const k = w.indexOf(Math.max(...w));
        drop[i] = dropJoints.test(joints[j[k]].getName()) ? 1 : 0;
      }
      const src = p.getIndices().getArray();
      const kept = [];
      for (let i = 0; i < src.length; i += 3) {
        if (drop[src[i]] || drop[src[i + 1]] || drop[src[i + 2]]) continue;
        kept.push(src[i], src[i + 1], src[i + 2]);
      }
      p.getIndices().setArray(new Uint32Array(kept));
    }
    p.setAttribute('JOINTS_0', null).setAttribute('WEIGHTS_0', null);
  }
}

// ---------------------------------------------------------------------------------------------
// Cars

const ATLAS = 512;
const CAR_YAW_FIX = { coupe: Math.PI / 2 };

async function buildCar(src, parts, yaw, bb) {
  // Collect primitives with world matrices.
  const prims = [];
  for (const part of parts) {
    part.traverse((n) => {
      const m = n.getMesh();
      if (!m) return;
      for (const p of m.listPrimitives()) prims.push({ p, wm: n.getWorldMatrix(), mat: p.getMaterial() });
    });
  }
  // Atlas layout: the body texture takes the top 3/4, other textures share the bottom strip, and
  // untextured materials (glass) get flat colour cells in the last bottom tile.
  const texOf = (m) => m && m.getBaseColorTexture();
  const texList = [];
  for (const { mat: m } of prims) { const t = texOf(m); if (t && !texList.includes(t)) texList.push(t); }
  const bodyTex = texOf(prims.find((q) => /^body/i.test(q.mat.getName()))?.mat) || texList[0];
  const others = texList.filter((t) => t !== bodyTex);
  const strip = ATLAS / 4;
  const tiles = new Map();
  tiles.set(bodyTex, [0, 0, ATLAS, ATLAS - strip]);
  const tw = ATLAS / (others.length + 1);
  others.forEach((t, i) => tiles.set(t, [i * tw, ATLAS - strip, tw, strip]));
  const solidX = others.length * tw;
  const solids = [];
  const comps = [];
  for (const [t, [x, y, w, h]] of tiles) {
    comps.push({ input: await sharp(t.getImage()).resize(Math.round(w), Math.round(h), { fit: 'fill' }).png().toBuffer(), left: Math.round(x), top: Math.round(y) });
  }
  const solidCell = (m) => {
    const f = m.getBaseColorFactor();
    let i = solids.findIndex((s) => s.m === m);
    if (i < 0) { i = solids.length; solids.push({ m, rgb: glassTint(m, f) }); }
    const per = 4, cw = tw / per, ch = strip / per;
    return [solidX + (i % per) * cw, ATLAS - strip + Math.floor(i / per) * ch, cw, ch];
  };
  const inset = 2;
  const cyaw = Math.cos(-yaw), syaw = Math.sin(-yaw);
  const cx = (bb.min[0] + bb.max[0]) / 2, cz = (bb.min[2] + bb.max[2]) / 2;

  const P = [], N = [], UV = [], I = [];
  let minY = Infinity;
  const tmp = [], tn = [], tuv = [];
  for (const { p, wm, mat: m } of prims) {
    const t = texOf(m);
    const rect = t ? tiles.get(t) : solidCell(m);
    const pa = p.getAttribute('POSITION'), na = p.getAttribute('NORMAL'), ua = p.getAttribute('TEXCOORD_0');
    const base = P.length / 3;
    for (let i = 0; i < pa.getCount(); i++) {
      pa.getElement(i, tmp);
      const w = m4apply(wm, tmp[0], tmp[1], tmp[2], 1);
      const x = w[0] - cx, z = w[2] - cz;
      P.push(x * cyaw + z * syaw, w[1], -x * syaw + z * cyaw);
      minY = Math.min(minY, w[1]);
      na.getElement(i, tn);
      const n = m4apply(wm, tn[0], tn[1], tn[2], 0);
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      N.push((n[0] * cyaw + n[2] * syaw) / l, n[1] / l, (-n[0] * syaw + n[2] * cyaw) / l);
      let u = 0.5, v = 0.5;
      if (t && ua) { ua.getElement(i, tuv); u = tuv[0] - Math.floor(tuv[0] * 0.999999); v = tuv[1] - Math.floor(tuv[1] * 0.999999); }
      UV.push((rect[0] + inset + u * (rect[2] - 2 * inset)) / ATLAS, (rect[1] + inset + v * (rect[3] - 2 * inset)) / ATLAS);
    }
    const idx = p.getIndices().getArray();
    for (let i = 0; i < idx.length; i++) I.push(base + idx[i]);
  }
  for (let i = 1; i < P.length; i += 3) P[i] -= minY;
  // Solid colour cells
  for (let i = 0; i < solids.length; i++) {
    const [x, y, w, h] = solidCell(solids[i].m);
    const [r, g, b] = solids[i].rgb;
    comps.push({ input: { create: { width: Math.round(w), height: Math.round(h), channels: 3, background: { r, g, b } } }, left: Math.round(x), top: Math.round(y) });
  }
  const atlas = await sharp({ create: { width: ATLAS, height: ATLAS, channels: 3, background: { r: 40, g: 40, b: 44 } } })
    .composite(comps).png().toBuffer();

  // Build the output document: lod0 + lod1 sharing one material/texture.
  const doc = new Document();
  const buf = doc.createBuffer();
  const tex = doc.createTexture('atlas').setImage(new Uint8Array(atlas)).setMimeType('image/png');
  const material = doc.createMaterial('car').setBaseColorTexture(tex).setRoughnessFactor(0.45).setMetallicFactor(0.2);
  const mkPrim = (indices) => doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(P)).setBuffer(buf))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(N)).setBuffer(buf))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(UV)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buf))
    .setMaterial(material);
  const scene = doc.createScene('car');
  const p0 = mkPrim(I), p1 = mkPrim(I);
  scene.addChild(doc.createNode('lod0').setMesh(doc.createMesh('lod0').addPrimitive(p0)));
  scene.addChild(doc.createNode('lod1').setMesh(doc.createMesh('lod1').addPrimitive(p1)));
  await doc.transform(weld());
  const lod0 = doc.getRoot().listMeshes()[0].listPrimitives()[0];
  const lod1 = doc.getRoot().listMeshes()[1].listPrimitives()[0];
  simplifyTo(doc, lod1, Math.round(tris(lod0) * 0.25));
  await compressTextures(doc, ATLAS);
  const b = getBounds(scene);
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  scene.setExtras({ size, forward: '-Z' });
  return { doc, lod1Tris: tris(lod1), size };
}

/** Principal XZ axis of the wheel centres (the car's long axis), or null with < 3 wheels. */
function wheelAxis(wheels) {
  const c = wheels.map((w) => { const b = getBounds(w); return [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2]; });
  if (c.length < 3) return null;
  const mx = c.reduce((a, p) => a + p[0], 0) / c.length, mz = c.reduce((a, p) => a + p[1], 0) / c.length;
  let xx = 0, xz = 0, zz = 0;
  for (const [x, z] of c) { xx += (x - mx) ** 2; xz += (x - mx) * (z - mz); zz += (z - mz) ** 2; }
  const ang = 0.5 * Math.atan2(2 * xz, xx - zz);
  return [Math.cos(ang), Math.sin(ang)];
}

function glassTint(m, f) {
  // Tinted, slightly bluish dark glass reads better than pure black at a distance.
  const a = f[3];
  return [Math.round(30 + 40 * (1 - a)), Math.round(38 + 45 * (1 - a)), Math.round(48 + 55 * (1 - a))];
}

// ---------------------------------------------------------------------------------------------
// Office

async function buildOffice(doc) {
  const root = doc.getRoot();
  // Interior furniture is ~630k tris of chairs: drop it, the glass shader fakes the interior.
  for (const n of root.listNodes()) if (/chair/i.test(n.getName())) n.dispose();
  await doc.transform(prune());
  await bake(doc);
  keepBaseColor(doc, { emissive: false });
  // Axis-align (the tower is authored with a slight yaw) using the exterior frame's edges.
  const yaw = dominantYaw(root);
  transformAll(doc, mat.rotY(-yaw));
  // Material merge: every untextured material becomes a vertex colour on one opaque material,
  // textured walls keep their UVs on a second material, glass stays its own material.
  const opaque = doc.createMaterial('office_frame').setRoughnessFactor(0.8).setMetallicFactor(0);
  const glass = doc.createMaterial('office_glass').setBaseColorFactor([0.05, 0.07, 0.09, 0.35]).setAlphaMode('BLEND');
  let interior = null;
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const m = p.getMaterial();
    const name = m.getName();
    if (/glass/i.test(name)) { p.setMaterial(glass); p.setAttribute('TEXCOORD_0', null); continue; }
    const t = m.getBaseColorTexture();
    if (t && /walls/i.test(name)) {
      interior = interior || doc.createMaterial('office_interior').setBaseColorTexture(t).setRoughnessFactor(0.9).setMetallicFactor(0);
      p.setMaterial(interior);
      continue;
    }
    const f = m.getBaseColorFactor();
    const e = m.getEmissiveFactor();
    const col = e[0] + e[1] + e[2] > 0 ? [0.95, 0.9, 0.78] : [f[0], f[1], f[2]];
    const n = p.getAttribute('POSITION').getCount();
    const c = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) c.set([col[0], col[1], col[2], 1], i * 4);
    p.setAttribute('COLOR_0', doc.createAccessor().setType('VEC4').setArray(c).setBuffer(p.getAttribute('POSITION').getBuffer()));
    p.setAttribute('TEXCOORD_0', null);
    p.setMaterial(opaque);
  }
  await doc.transform(prune(), weld(), join({ keepNamed: false }));
  // Scale: detect floor spacing from horizontal frame slabs and map it to 3.6 m per storey.
  const { floors, spacing, levels } = detectFloors(root);
  const s = 3.6 / spacing;
  const scene = root.listScenes()[0];
  const b = getBounds(scene);
  transformAll(doc, mat.scaleTranslate(s, -(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2));
  const b2 = getBounds(scene);
  // Storey slab heights (m) let the runtime stack towers by repeating the middle floors.
  scene.setExtras({
    floors, floorHeight: 3.6,
    levels: levels.map((y) => +((y - b.min[1]) * s).toFixed(3)),
    size: [b2.max[0] - b2.min[0], b2.max[1] - b2.min[1], b2.max[2] - b2.min[2]],
    glassFacing: '+Z',
  });
  await compressTextures(doc, 1024);
}

function dominantYaw(root) {
  // Histogram of horizontal edge directions (mod 90 deg), weighted by length.
  const bins = new Float64Array(90);
  const v0 = [], v1 = [];
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION'), idx = p.getIndices().getArray();
    for (let i = 0; i < idx.length; i += 3) for (let k = 0; k < 3; k++) {
      pos.getElement(idx[i + k], v0); pos.getElement(idx[i + (k + 1) % 3], v1);
      const dx = v1[0] - v0[0], dz = v1[2] - v0[2], dy = v1[1] - v0[1];
      const l = Math.hypot(dx, dz);
      if (l < 1e-4 || Math.abs(dy) > l * 0.05) continue;
      let a = Math.atan2(dz, dx) * 180 / Math.PI;
      a = ((a % 90) + 90) % 90;
      bins[Math.floor(a) % 90] += l;
    }
  }
  let best = 0;
  for (let i = 1; i < 90; i++) if (bins[i] > bins[best]) best = i;
  // Refine with the weighted mean of neighbouring bins.
  let sw = 0, sa = 0;
  for (let d = -1; d <= 1; d++) { const i = (best + d + 90) % 90; sw += bins[i]; sa += bins[i] * (best + d + 0.5); }
  let deg = sa / sw;
  if (deg > 45) deg -= 90;
  return deg * Math.PI / 180;
}

function detectFloors(root) {
  // Floor slabs show up as dense horizontal vertex rows on the textured interior walls
  // (the glass mullions run at half-storey spacing, so they would double the count).
  const counts = new Map();
  const v = [];
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    if (p.getMaterial().getName() !== 'office_interior') continue;
    const pos = p.getAttribute('POSITION');
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      const k = Math.round(v[1] * 100);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const rows = [...counts.entries()].sort((x, y) => x[0] - y[0]);
  const peak = Math.max(...rows.map((r) => r[1]));
  const levels = [];
  for (const [k, n] of rows) {
    if (n < peak * 0.4) continue;
    const y = k / 100;
    if (levels.length && y - levels[levels.length - 1] < 0.03) continue;
    levels.push(y);
  }
  const gaps = [];
  for (let i = 1; i < levels.length; i++) gaps.push(levels[i] - levels[i - 1]);
  gaps.sort((x, y) => x - y);
  const spacing = gaps[Math.floor(gaps.length / 2)];
  return { floors: levels.length - 1, spacing, levels };
}

// ---------------------------------------------------------------------------------------------
// Run

const t0 = Date.now();
for (const [name, fn] of Object.entries(jobs)) {
  if (only.length && !only.includes(name)) continue;
  console.log(`> ${name}`);
  await fn();
}

const fmt = (v, d = 0) => (v === undefined || v === null ? '-' : v.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
console.log('\nAsset report (texture MB = GPU memory incl. mips: RGBA8 before, ASTC-4x4 after)\n');
console.log(pad('asset', 22) + lpad('tris', 16) + lpad('draws', 12) + lpad('tex MB', 16) + lpad('file MB', 16) + '  notes');
for (const r of report) {
  const b = r.before || {};
  const a = r.after;
  console.log(
    pad(r.name, 22)
    + lpad(`${fmt(b.tris)} -> ${fmt(a.tris)}`, 16)
    + lpad(`${fmt(b.draws)} -> ${fmt(a.draws)}`, 12)
    + lpad(`${fmt(b.texGpuMB, 1)} -> ${fmt(a.texGpuMB, 2)}`, 16)
    + lpad(`${fmt(b.fileMB, 1)} -> ${fmt(a.fileMB, 2)}`, 16)
    + '  ' + r.note,
  );
}
fs.writeFileSync(path.join(OUT, 'assets-report.json'), JSON.stringify(report, null, 2));
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
