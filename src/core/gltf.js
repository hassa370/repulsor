// Shared glTF loading for the optimized assets produced by `npm run assets`:
// GLTFLoader + MeshoptDecoder (EXT_meshopt_compression) + KTX2Loader (KHR_texture_basisu).
// The Basis transcoder (JS + WASM) lives in public/basis/.

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

let loader = null;
let ktx2 = null;

export function gltfLoader(renderer) {
  if (loader) return loader;
  ktx2 = new KTX2Loader().setTranscoderPath('basis/').detectSupport(renderer);
  loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2);
  return loader;
}

/** Load a GLB, resolving to null (with a console warning) when it is missing or broken. */
export async function loadGLB(renderer, url) {
  try {
    return await gltfLoader(renderer).loadAsync(url);
  } catch (e) {
    console.warn('GLB load failed', url, e?.message || e);
    return null;
  }
}

/** Optional asset: HEAD-check first so a missing file is silent instead of a 404 parse error. */
export async function loadOptionalGLB(renderer, url) {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    const type = head.headers.get('content-type') || '';
    if (!head.ok || type.includes('text/html')) return null;
  } catch {
    return null;
  }
  return loadGLB(renderer, url);
}

/** Triangle / draw-call / texture stats for a loaded glTF scene (debug overlay + viewer). */
export function sceneStats(root) {
  let tris = 0, draws = 0, texBytes = 0;
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    draws++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) for (const k of ['map', 'emissiveMap', 'normalMap']) {
      const t = m[k];
      if (!t || seen.has(t)) continue;
      seen.add(t);
      const img = t.image || {};
      // Compressed textures: ASTC 4x4 / ETC2 on Quest ~1 byte per texel (+1/3 for mips).
      texBytes += (img.width || 0) * (img.height || 0) * (t.isCompressedTexture ? 1 : 4) * 4 / 3;
    }
  });
  return { tris: Math.round(tris), draws, texMB: texBytes / 1048576 };
}

export function disposeGltfLoader() {
  ktx2?.dispose();
  ktx2 = null;
  loader = null;
}
