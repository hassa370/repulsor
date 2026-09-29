import {
  Color, DataTexture, DataUtils, EquirectangularReflectionMapping, LinearFilter,
  LinearMipmapLinearFilter, PMREMGenerator, RGBAFormat, SRGBColorSpace, UnsignedByteType, Vector3,
} from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { WORLD } from '../config.js';
import { fbm } from '../core/rand.js';

// Sky / environment. Uses public/hdri/sunset_1k.hdr (e.g. a Poly Haven CC0 sunset
// HDRI at 1K) when present, otherwise a procedurally painted sunset equirect.
// Either way the result is: background, one precomputed PMREM env map,
// an equirect texture custom shaders sample for cheap reflections, and a fog
// colour matching the horizon.

const W = 512, H = 256;

function smooth(e0, e1, x) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

function paintSky(sun) {
  const data = new Uint8Array(W * H * 4);
  const zen = [0.09, 0.12, 0.3], mid = [0.42, 0.3, 0.48], hor = [1.0, 0.52, 0.26], low = [0.3, 0.22, 0.25];
  const c = [0, 0, 0];
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    const lat = (v - 0.5) * Math.PI;
    const y = Math.sin(lat), cl = Math.cos(lat);
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W;
      const a = (u - 0.5) * 2 * Math.PI;
      const x = Math.cos(a) * cl, z = Math.sin(a) * cl;
      const sd = Math.max(0, x * sun.x + y * sun.y + z * sun.z);
      const hSun = Math.pow(Math.max(0, x * sun.x + z * sun.z) / Math.max(cl, 1e-3), 3) * 0.5 + 0.5;
      if (y >= 0) {
        const t1 = smooth(0, 0.35, y), t2 = smooth(0.25, 1, y);
        for (let k = 0; k < 3; k++) {
          const horK = hor[k] * (0.55 + 0.45 * hSun) + mid[k] * (1 - hSun) * 0.3;
          c[k] = horK * (1 - t1) + mid[k] * t1;
          c[k] = c[k] * (1 - t2) + zen[k] * t2;
        }
        // Streaky sunset clouds in a band above the horizon.
        const band = smooth(0.015, 0.06, y) * (1 - smooth(0.18, 0.4, y));
        if (band > 0) {
          const n = fbm(u * 18, y * 60, 4, 7, 18);
          const cov = smooth(0.52, 0.72, n) * band;
          const lit = 0.55 + 0.9 * Math.pow(sd, 3);
          c[0] = c[0] * (1 - cov) + 1.0 * lit * cov * 0.95;
          c[1] = c[1] * (1 - cov) + 0.45 * lit * cov * 0.95;
          c[2] = c[2] * (1 - cov) + 0.4 * lit * cov * 0.95;
        }
      } else {
        const t = smooth(0, 0.2, -y);
        for (let k = 0; k < 3; k++) c[k] = hor[k] * 0.7 * (1 - t) + low[k] * t;
      }
      // Sun glow + disk.
      const glow = Math.pow(sd, 12) * 0.6 + Math.pow(sd, 90) * 0.8;
      c[0] += glow * 1.0; c[1] += glow * 0.7; c[2] += glow * 0.35;
      if (sd > 0.9994) { c[0] = 1; c[1] = 0.95; c[2] = 0.8; }
      const o = (j * W + i) * 4;
      // Store sRGB-encoded (approximate gamma) so the GPU decodes to linear.
      data[o] = Math.min(255, Math.pow(Math.min(c[0], 1), 1 / 2.2) * 255);
      data[o + 1] = Math.min(255, Math.pow(Math.min(c[1], 1), 1 / 2.2) * 255);
      data[o + 2] = Math.min(255, Math.pow(Math.min(c[2], 1), 1 / 2.2) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new DataTexture(data, W, H, RGBAFormat, UnsignedByteType);
  tex.colorSpace = SRGBColorSpace;
  tex.mapping = EquirectangularReflectionMapping;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// Average linear colour of a horizontal band just above the horizon.
function horizonColorFromData(get, w, h) {
  const j = Math.floor(h * (0.5 + 0.03 / Math.PI * 2));
  const out = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < w; i += 4) {
    get(i, j, out);
    n++;
  }
  return new Color(out[0] / n, out[1] / n, out[2] / n);
}

async function tryLoadHdr() {
  try {
    const head = await fetch('hdri/sunset_1k.hdr', { method: 'HEAD' });
    if (!head.ok || (head.headers.get('content-type') || '').includes('text/html')) return null;
    return await new HDRLoader().loadAsync('hdri/sunset_1k.hdr');
  } catch {
    return null;
  }
}

export async function makeSky(renderer) {
  const sunDir = new Vector3().fromArray(WORLD.sunDir).normalize();
  let tex = await tryLoadHdr();
  let fogColor;
  if (tex) {
    tex.mapping = EquirectangularReflectionMapping;
    const { data, width, height } = tex.image;
    const isHalf = data instanceof Uint16Array;
    fogColor = horizonColorFromData((i, j, acc) => {
      const o = (j * width + i) * 4;
      for (let k = 0; k < 3; k++) acc[k] += Math.min(isHalf ? DataUtils.fromHalfFloat(data[o + k]) : data[o + k], 2);
    }, width, height);
  } else {
    tex = paintSky(sunDir);
    const d = tex.image.data;
    fogColor = horizonColorFromData((i, j, acc) => {
      const o = (j * W + i) * 4;
      for (let k = 0; k < 3; k++) acc[k] += Math.pow(d[o + k] / 255, 2.2);
    }, W, H);
  }
  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  return { texture: tex, env, fogColor, sunDir, sunColor: new Color(WORLD.sunColor) };
}
