// Sanity checks on the optimized GLBs produced by `npm run assets` (reads only the JSON chunk).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const DIR = new URL('../public/models/', import.meta.url);

function gltfJson(file) {
  const b = fs.readFileSync(new URL(file, DIR));
  assert.equal(b.readUInt32LE(0), 0x46546c67, `${file}: not a GLB`);
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
}

function triangles(j, meshIndex) {
  return j.meshes[meshIndex].primitives.reduce((a, p) => a + j.accessors[p.indices].count / 3, 0);
}

function meshByNode(j, name) {
  const n = j.nodes.find((x) => x.name === name);
  assert.ok(n, `node ${name} missing`);
  return n.mesh;
}

const CARS = ['compact', 'coupe', 'hatchback', 'minivan', 'offroad', 'pickup', 'sedan', 'sport', 'suv', 'wagon'];
const ALL = ['ironman.glb', 'tung.glb', 'ak47.glb', 'ak47_static.glb', 'office.glb', ...CARS.map((c) => `cars/${c}.glb`)];

test('every optimized asset uses meshopt geometry and KTX2 textures only', () => {
  for (const f of ALL) {
    const j = gltfJson(f);
    assert.ok(j.extensionsRequired.includes('EXT_meshopt_compression'), `${f}: meshopt`);
    for (const img of j.images || []) assert.equal(img.mimeType, 'image/ktx2', `${f}: texture not KTX2`);
    for (const m of j.meshes) for (const p of m.primitives) assert.ok(!p.targets, `${f}: morph targets left`);
  }
});

test('tris / materials stay inside the budget', () => {
  const tung = gltfJson('tung.glb');
  assert.ok(triangles(tung, meshByNode(tung, 'lod0')) <= 3100);
  assert.ok(triangles(tung, meshByNode(tung, 'lod1')) <= 900);
  for (const c of CARS) {
    const j = gltfJson(`cars/${c}.glb`);
    assert.equal(j.materials.length, 1, `${c}: one material`);
    const l0 = triangles(j, meshByNode(j, 'lod0')), l1 = triangles(j, meshByNode(j, 'lod1'));
    assert.ok(l1 <= l0 * 0.3, `${c}: LOD1 ${l1} vs ${l0}`);
    const [w, h, l] = j.scenes[0].extras.size;
    assert.ok(l > w && l > 3 && l < 6 && h < 2.2, `${c}: size ${w}x${h}x${l}`);
  }
  const office = gltfJson('office.glb');
  assert.ok(office.materials.length <= 3);
  assert.ok(office.meshes.reduce((a, _, i) => a + triangles(office, i), 0) < 20000);
  assert.ok(office.scenes[0].extras.floors >= 3);
});

test('rifle keeps its clips; the static copy has no skin', () => {
  const ak = gltfJson('ak47.glb');
  const names = ak.animations.map((a) => a.name).sort();
  assert.deepEqual(names, ['draw', 'idle', 'reload', 'run', 'shoot', 'walk']);
  assert.equal(ak.skins.length, 1);
  const st = gltfJson('ak47_static.glb');
  assert.ok(!st.skins && !st.animations);
});
