// Cube-sphere addressing. Six faces, each a quadtree; face coordinates
// (u, v) in [-1, 1] are warped with tan() (equal-angle cube map) before being
// projected onto the sphere, which keeps cells within ~1.4x of each other.
//
// Face bases satisfy fx x fy = fn, so a CCW triangle in (u, v) faces outward.
// The city sits at the centre of face 2 (+Y).

export const FACES = [
  { n: [1, 0, 0], x: [0, 0, -1], y: [0, 1, 0] },
  { n: [-1, 0, 0], x: [0, 0, 1], y: [0, 1, 0] },
  { n: [0, 1, 0], x: [1, 0, 0], y: [0, 0, -1] },
  { n: [0, -1, 0], x: [1, 0, 0], y: [0, 0, 1] },
  { n: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] },
  { n: [0, 0, -1], x: [-1, 0, 0], y: [0, 1, 0] },
];

const Q = Math.PI / 4;
const P21 = 2097152; // 2^21

// Unique numeric key (exact in float64) for a node.
export function nodeKey(face, level, ix, iy) {
  return ((face * 32 + level) * P21 + ix) * P21 + iy;
}

// Unit direction for face coords (u, v). Writes into out[o..o+2].
export function faceDir(face, u, v, out, o = 0) {
  const F = FACES[face];
  const a = Math.tan(u * Q), b = Math.tan(v * Q);
  const x = F.n[0] + a * F.x[0] + b * F.y[0];
  const y = F.n[1] + a * F.x[1] + b * F.y[1];
  const z = F.n[2] + a * F.x[2] + b * F.y[2];
  const inv = 1 / Math.sqrt(x * x + y * y + z * z);
  out[o] = x * inv; out[o + 1] = y * inv; out[o + 2] = z * inv;
  return out;
}

// Arc length (m) of one node edge at `level` on a sphere of radius R.
export function nodeSize(R, level) {
  return (Math.PI / 2) * R / (1 << level);
}

// Grid + skirt topology shared by every chunk (vertex indices in the chunk).
// Grid vertex (i, j) = j * N + i. Skirt vertices follow, one per edge vertex,
// in the order bottom (j=0), top (j=N-1), left (i=0), right (i=N-1).
export function buildChunkIndex(N) {
  const idx = [];
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const k = j * N + i;
      idx.push(k, k + 1, k + N, k + 1, k + N + 1, k + N);
    }
  }
  const base = N * N;
  // Each skirt quad: edge vertices a, b; skirt vertices a2, b2 (hanging down).
  // Winding chosen so each skirt faces away from the chunk.
  const edge = (e, outward) => {
    for (let t = 0; t < N - 1; t++) {
      let a, b;
      if (e === 0) { a = t; b = t + 1; }
      else if (e === 1) { a = (N - 1) * N + t; b = a + 1; }
      else if (e === 2) { a = t * N; b = (t + 1) * N; }
      else { a = t * N + N - 1; b = (t + 1) * N + N - 1; }
      const a2 = base + e * N + t, b2 = a2 + 1;
      if (outward) idx.push(a, a2, b, b, a2, b2);
      else idx.push(a, b, a2, b, b2, a2);
    }
  };
  edge(0, true); // bottom: outward = -fy
  edge(1, false); // top: outward = +fy
  edge(2, false); // left: outward = -fx
  edge(3, true); // right: outward = +fx
  return idx;
}

// Index of the grid vertex a skirt vertex hangs from.
export function skirtSource(N, e, t) {
  if (e === 0) return t;
  if (e === 1) return (N - 1) * N + t;
  if (e === 2) return t * N;
  return t * N + N - 1;
}
