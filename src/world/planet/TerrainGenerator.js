import { PLANET, WORLD } from '../../config.js';
import { WATER_LEVEL } from '../../physics/collision.js';

// Deterministic planet surface: radius(direction) for a unit direction in the
// planet-centric frame. Pure function of (seed, direction), so any chunk layout
// or LOD regenerates identical terrain and nothing needs to be saved.
//
// Cost control: a handful of value-noise octaves, and octaves shorter than
// ~2.5x the caller's vertex spacing are skipped (far chunks are very cheap).
// Inside PLANET.flatRadius of the city no noise is evaluated at all: the
// surface is exactly the city's y = 0 plane (so legacy collision, the ground
// plane and the water plane line up with it to the millimetre).

const SEED = PLANET.seed | 0;

function hash3(x, y, z, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177) ^ Math.imul(s, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1; // [-1, 1)
}

// Trilinear value noise in [-1, 1].
export function noise3(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const a = hash3(xi, yi, zi, s), b = hash3(xi + 1, yi, zi, s);
  const c = hash3(xi, yi + 1, zi, s), d = hash3(xi + 1, yi + 1, zi, s);
  const e = hash3(xi, yi, zi + 1, s), f = hash3(xi + 1, yi, zi + 1, s);
  const g = hash3(xi, yi + 1, zi + 1, s), h = hash3(xi + 1, yi + 1, zi + 1, s);
  const x0 = a + (b - a) * u, x1 = c + (d - c) * u, x2 = e + (f - e) * u, x3 = g + (h - g) * u;
  const y0 = x0 + (x1 - x0) * v, y1 = x2 + (x3 - x2) * v;
  return y0 + (y1 - y0) * w;
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const R = PLANET.radius;
const SEA = WATER_LEVEL; // sea surface height (m) relative to R
const FLAT_R = PLANET.flatRadius, BLEND_R = PLANET.blendRadius;
const COAST_Z = WORLD.coastZ;
export const MAX_TERRAIN_HEIGHT = PLANET.terrainAmplitude * 1.6 + 400;
export const MIN_TERRAIN_HEIGHT = -1800;

// Natural terrain height (m above sea) at planet point (px, py, pz) = dir * R.
// minWavelength: skip octaves shorter than this (LOD).
function naturalHeight(px, py, pz, minWavelength) {
  // Continents (400 km, 200 km).
  let f = 1 / 400000;
  let cont = noise3(px * f, py * f, pz * f, SEED) * 0.66;
  f = 1 / 190000;
  cont += noise3(px * f + 31.7, py * f, pz * f, SEED + 1) * 0.34;
  let h = cont * 1500 + 250;
  const land = smoothstep(-0.12, 0.45, cont);
  // Ridged mountains (38 km, 17 km).
  if (minWavelength < 38000) {
    f = 1 / 38000;
    let r = 1 - Math.abs(noise3(px * f, py * f + 7.1, pz * f, SEED + 2));
    let m = r * r;
    if (minWavelength < 17000) {
      f = 1 / 17000;
      r = 1 - Math.abs(noise3(px * f, py * f, pz * f + 3.3, SEED + 3));
      m = m * 0.7 + r * r * m * 0.6;
    }
    h += land * m * PLANET.terrainAmplitude;
  }
  // Hills (4.8 km, 2.1 km).
  if (minWavelength < 4800) {
    f = 1 / 4800;
    let n = noise3(px * f, py * f, pz * f, SEED + 4);
    if (minWavelength < 2100) {
      f = 1 / 2100;
      n = n * 0.7 + noise3(px * f, py * f, pz * f, SEED + 5) * 0.3;
    }
    h += n * (90 + 330 * land);
  }
  // Detail (520 m).
  if (minWavelength < 520) {
    f = 1 / 520;
    h += noise3(px * f, py * f, pz * f, SEED + 6) * (8 + 22 * land);
  }
  return h;
}

// Output of sampleSurface (reused, read immediately).
export const SURF = {
  r: 0, // radius of the rendered surface (ground or water)
  ground: 0, // ground height above sea (m, negative = sea floor)
  water: 0, // 1 if the rendered surface is water
  urban: 0, // 1 inside the city footprint
  flat: 0, // 1 inside the flat city zone
};

// Sample the surface in unit direction (dx, dy, dz).
export function sampleSurface(dx, dy, dz, minWavelength = 0) {
  // City plane coordinates (gnomonic projection onto the tangent plane at the
  // pole: the city's y = 0 plane is exactly radius R / dy in direction d).
  let rho = Infinity, cx = 0, cz = 0;
  if (dy > 0.2) {
    cx = R * dx / dy; cz = R * dz / dy;
    rho = Math.sqrt(cx * cx + cz * cz);
  }
  const w = rho <= FLAT_R ? 0 : smoothstep(FLAT_R, BLEND_R, rho);
  // Flat city zone: land at y = 0 north of the coast, a shelving sea floor south of it.
  let planeY = 0;
  if (w < 1 && cz < COAST_Z) planeY = Math.max(-45, SEA - 1.5 - (COAST_Z - cz) * 0.03);
  let ground = 0;
  if (w > 0) {
    ground = naturalHeight(dx * R, dy * R, dz * R, minWavelength);
    if (rho < 120000) {
      // Keep the region around the city gentle, with land north and sea south
      // (the sunset side), whatever the continents do further away.
      const k = 1 - smoothstep(25000, 110000, rho);
      const north = Math.max(-1, Math.min(1, (cz - COAST_Z) / 5000));
      const shaped = ground * (0.25 + 0.75 * smoothstep(4000, 90000, rho)) + north * 420 - 60;
      ground = ground + (shaped - ground) * k;
    }
  }
  // Blend the plane radius into the curved natural surface.
  const rPlane = dy > 0.2 ? (R + planeY) / dy : R + planeY;
  const rSeaPlane = dy > 0.2 ? (R + SEA) / dy : R + SEA;
  const rGround = rPlane + (R + ground - rPlane) * w;
  const rSea = rSeaPlane + (R + SEA - rSeaPlane) * w;
  const groundH = planeY + (ground - planeY) * w;
  SURF.ground = groundH;
  SURF.flat = 1 - w;
  SURF.urban = rho < 1e9 && Math.abs(cx) < WORLD.citySize / 2 + 20 && cz > COAST_Z && cz < WORLD.citySize / 2 + 20 ? 1 : 0;
  if (rGround < rSea) { SURF.r = rSea; SURF.water = 1; } else { SURF.r = rGround; SURF.water = 0; }
  return SURF;
}

// Full-detail ground/water radius for collision queries.
export function surfaceRadius(dx, dy, dz) {
  return sampleSurface(dx, dy, dz, 0).r;
}

// Linear albedo for a vertex (writes rgb into out[o..o+2]).
export function surfaceColor(s, slope, out, o) {
  let r, g, b;
  if (s.water) {
    const depth = Math.min(1, Math.max(0, -s.ground / 60));
    r = 0.02 + 0.04 * (1 - depth); g = 0.06 + 0.1 * (1 - depth); b = 0.09 + 0.07 * (1 - depth);
  } else if (s.urban) {
    r = 0.2; g = 0.2; b = 0.2;
  } else if (s.flat > 0.999) {
    // Matches the city ground shader outside the street grid.
    r = 0.24; g = 0.25; b = 0.135;
  } else {
    const h = s.ground;
    // grass / forest / dry plains by height, rock by slope, snow high up
    const t = Math.min(1, Math.max(0, h / 900));
    r = 0.16 + 0.12 * t; g = 0.21 + 0.03 * t; b = 0.09 + 0.06 * t;
    if (h < 7) { const k = 1 - Math.max(0, h) / 7; r += (0.62 - r) * k; g += (0.54 - g) * k; b += (0.38 - b) * k; }
    const rock = Math.min(1, Math.max(0, (slope - 0.16) / 0.2));
    r += (0.3 - r) * rock; g += (0.28 - g) * rock; b += (0.26 - b) * rock;
    const snow = Math.min(1, Math.max(0, (h - 2300 + slope * 1600) / 400));
    r += (0.9 - r) * snow; g += (0.92 - g) * snow; b += (0.95 - b) * snow;
    if (s.flat > 0) {
      const k = s.flat;
      r += (0.24 - r) * k; g += (0.25 - g) * k; b += (0.135 - b) * k;
    }
  }
  out[o] = r; out[o + 1] = g; out[o + 2] = b;
}
