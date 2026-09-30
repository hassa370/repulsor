// Static collision world: axis-aligned boxes in a uniform 2D (XZ) spatial hash.
// Built once after city generation (CSR layout: cellStart/cellItems), then
// queried with zero allocations.

export const WATER_LEVEL = -0.4;

export class CollisionWorld {
  constructor({ maxBoxes = 8192, minX, minZ, size, cell, coastZ }) {
    this.maxBoxes = maxBoxes;
    this.boxes = new Float32Array(maxBoxes * 6); // minx,miny,minz,maxx,maxy,maxz
    this.boxCount = 0;
    this.minX = minX;
    this.minZ = minZ;
    this.cell = cell;
    this.dim = Math.ceil(size / cell);
    this.coastZ = coastZ;
    this.cellStart = new Int32Array(this.dim * this.dim + 1);
    this.cellItems = null;
    this.stamp = new Uint32Array(maxBoxes);
    this.stampId = 1;
    this.result = new Int32Array(1024);
    this.resultCount = 0;
    // Outputs of the last collide / raycast call (read, don't hold).
    this.hitNormal = [0, 0, 0];
    this.hitBox = -1;
    this.grounded = false;
    this.groundBox = -1;
    this.impactSpeed = 0;
    // Boxes the player is currently smashing through (skipped by collideCapsule).
    this.ignore = new Int32Array(4).fill(-1);
    // World integration: the terrain height callback (planet surface), and
    // whether the city's boxes exist (only while the frame is anchored to the
    // city; far from it there is nothing but terrain to collide with).
    this.groundFn = null;
    this.boxesEnabled = true;
  }

  isIgnored(i) {
    const g = this.ignore;
    return g[0] === i || g[1] === i || g[2] === i || g[3] === i;
  }

  addIgnore(i) {
    const g = this.ignore;
    for (let k = 0; k < 4; k++) if (g[k] === i) return;
    for (let k = 0; k < 4; k++) if (g[k] < 0) { g[k] = i; return; }
    g[0] = g[1]; g[1] = g[2]; g[2] = g[3]; g[3] = i;
  }

  addBox(minx, miny, minz, maxx, maxy, maxz) {
    const i = this.boxCount++;
    const b = this.boxes;
    const o = i * 6;
    b[o] = minx; b[o + 1] = miny; b[o + 2] = minz;
    b[o + 3] = maxx; b[o + 4] = maxy; b[o + 5] = maxz;
    return i;
  }

  _cellRange(v, min) {
    let c = Math.floor((v - min) / this.cell);
    if (c < 0) c = 0;
    if (c >= this.dim) c = this.dim - 1;
    return c;
  }

  build() {
    const dim = this.dim;
    const counts = new Int32Array(dim * dim);
    const b = this.boxes;
    for (let i = 0; i < this.boxCount; i++) {
      const o = i * 6;
      const cx0 = this._cellRange(b[o], this.minX), cx1 = this._cellRange(b[o + 3], this.minX);
      const cz0 = this._cellRange(b[o + 2], this.minZ), cz1 = this._cellRange(b[o + 5], this.minZ);
      for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) counts[z * dim + x]++;
    }
    let total = 0;
    for (let c = 0; c < dim * dim; c++) {
      this.cellStart[c] = total;
      total += counts[c];
    }
    this.cellStart[dim * dim] = total;
    this.cellItems = new Int32Array(total);
    const fill = counts;
    fill.fill(0);
    for (let i = 0; i < this.boxCount; i++) {
      const o = i * 6;
      const cx0 = this._cellRange(b[o], this.minX), cx1 = this._cellRange(b[o + 3], this.minX);
      const cz0 = this._cellRange(b[o + 2], this.minZ), cz1 = this._cellRange(b[o + 5], this.minZ);
      for (let z = cz0; z <= cz1; z++) {
        for (let x = cx0; x <= cx1; x++) {
          const c = z * dim + x;
          this.cellItems[this.cellStart[c] + fill[c]++] = i;
        }
      }
    }
  }

  groundHeight(x, z) {
    if (this.groundFn) return this.groundFn(x, z);
    return z < this.coastZ ? WATER_LEVEL : 0;
  }

  // Collect unique boxes overlapping an XZ rectangle into this.result.
  query(minx, minz, maxx, maxz) {
    if (!this.boxesEnabled) { this.resultCount = 0; return 0; }
    const id = ++this.stampId;
    const cx0 = this._cellRange(minx, this.minX), cx1 = this._cellRange(maxx, this.minX);
    const cz0 = this._cellRange(minz, this.minZ), cz1 = this._cellRange(maxz, this.minZ);
    const res = this.result;
    const cap = res.length;
    let n = 0;
    for (let z = cz0; z <= cz1; z++) {
      for (let x = cx0; x <= cx1; x++) {
        const c = z * this.dim + x;
        const end = this.cellStart[c + 1];
        for (let k = this.cellStart[c]; k < end; k++) {
          const i = this.cellItems[k];
          if (this.stamp[i] === id) continue;
          this.stamp[i] = id;
          if (n < cap) res[n++] = i;
        }
      }
    }
    this.resultCount = n;
    return n;
  }

  // Resolve a vertical capsule (feet at pos, segment from pos.y+r to pos.y+h-r)
  // against boxes + ground. Mutates pos & vel. Returns true if anything was hit.
  // restitution: bounce on normal velocity; friction: tangential loss (0..1).
  // bounceFloor: also bounce off floors/roofs (debris) instead of landing.
  collideCapsule(pos, vel, radius, height, restitution, friction, bounceFloor = false) {
    this.grounded = false;
    this.groundBox = -1;
    this.impactSpeed = 0;
    this.hitBox = -1;
    let hit = false;
    const b = this.boxes;
    const n = this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius);
    for (let iter = 0; iter < 2; iter++) {
      for (let k = 0; k < n; k++) {
        const i = this.result[k];
        if (this.isIgnored(i)) continue;
        const o = i * 6;
        const bminx = b[o], bminy = b[o + 1], bminz = b[o + 2];
        const bmaxx = b[o + 3], bmaxy = b[o + 4], bmaxz = b[o + 5];
        const y0 = pos.y + radius;
        const y1 = pos.y + Math.max(radius, height - radius);
        // Point on the capsule segment closest to the box's Y interval.
        let py;
        if (y1 < bminy) py = y1;
        else if (y0 > bmaxy) py = y0;
        else py = (Math.max(y0, bminy) + Math.min(y1, bmaxy)) * 0.5;
        const px = pos.x, pz = pos.z;
        const qx = px < bminx ? bminx : px > bmaxx ? bmaxx : px;
        const qy = py < bminy ? bminy : py > bmaxy ? bmaxy : py;
        const qz = pz < bminz ? bminz : pz > bmaxz ? bmaxz : pz;
        let dx = px - qx, dy = py - qy, dz = pz - qz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= radius * radius) continue;
        let nx, ny, nz, pen;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          nx = dx / d; ny = dy / d; nz = dz / d;
          pen = radius - d;
        } else {
          // Segment point inside the box: push out through the nearest face
          // (roof preferred when close, so landings are stable).
          const exPx = bmaxx - px, exNx = px - bminx;
          const exPz = bmaxz - pz, exNz = pz - bminz;
          const exPy = bmaxy - y0 + radius; // lift feet onto roof
          let best = exPy * 0.8; nx = 0; ny = 1; nz = 0;
          if (exPx < best) { best = exPx; nx = 1; ny = 0; nz = 0; }
          if (exNx < best) { best = exNx; nx = -1; ny = 0; nz = 0; }
          if (exPz < best) { best = exPz; nx = 0; ny = 0; nz = 1; }
          if (exNz < best) { best = exNz; nx = 0; ny = 0; nz = -1; }
          pen = ny === 1 ? exPy : best + radius;
        }
        pos.x += nx * pen; pos.y += ny * pen; pos.z += nz * pen;
        const vn = vel.x * nx + vel.y * ny + vel.z * nz;
        if (vn < 0) {
          if (-vn > this.impactSpeed) {
            this.impactSpeed = -vn;
            this.hitNormal[0] = nx; this.hitNormal[1] = ny; this.hitNormal[2] = nz;
          }
          const bounce = ny > 0.7 && !bounceFloor ? 0 : restitution;
          vel.x -= (1 + bounce) * vn * nx;
          vel.y -= (1 + bounce) * vn * ny;
          vel.z -= (1 + bounce) * vn * nz;
          const f = 1 - friction;
          const vn2 = vel.x * nx + vel.y * ny + vel.z * nz;
          vel.x = (vel.x - vn2 * nx) * f + vn2 * nx;
          vel.y = (vel.y - vn2 * ny) * f + vn2 * ny;
          vel.z = (vel.z - vn2 * nz) * f + vn2 * nz;
        }
        if (ny > 0.7) { this.grounded = true; this.groundBox = i; }
        this.hitBox = i;
        hit = true;
      }
    }
    const g = this.groundHeight(pos.x, pos.z);
    if (pos.y < g) {
      pos.y = g;
      if (vel.y < 0) {
        if (-vel.y > this.impactSpeed) {
          this.impactSpeed = -vel.y;
          this.hitNormal[0] = 0; this.hitNormal[1] = 1; this.hitNormal[2] = 0;
        }
        vel.y = bounceFloor ? -vel.y * restitution : 0;
        if (bounceFloor) { vel.x *= 1 - friction; vel.z *= 1 - friction; }
      }
      this.grounded = true;
      hit = true;
    }
    return hit;
  }

  // Index of a box containing the point, or -1.
  pointInside(x, y, z) {
    if (y < this.groundHeight(x, z)) return -2;
    if (!this.boxesEnabled) return -1;
    const c = this._cellRange(z, this.minZ) * this.dim + this._cellRange(x, this.minX);
    const b = this.boxes;
    const end = this.cellStart[c + 1];
    for (let k = this.cellStart[c]; k < end; k++) {
      const o = this.cellItems[k] * 6;
      if (x >= b[o] && x <= b[o + 3] && y >= b[o + 1] && y <= b[o + 4] && z >= b[o + 2] && z <= b[o + 5]) {
        return this.cellItems[k];
      }
    }
    return -1;
  }

  // Ray vs boxes + ground; returns distance or maxDist if nothing hit.
  // Walks grid cells with a 2D DDA so long rays stay cheap.
  raycast(ox, oy, oz, dx, dy, dz, maxDist, skipIgnored = false) {
    let best = maxDist;
    this.hitBox = -1;
    // ground: plane under the origin, refined once at the estimated hit so
    // rays also land on sloped terrain
    if (dy < -1e-6) {
      const g = this.groundHeight(ox, oz);
      let t = (g - oy) / dy;
      if (this.groundFn && t > 0 && t < best) {
        const g2 = this.groundHeight(ox + dx * t, oz + dz * t);
        t = (g2 - oy) / dy;
      }
      if (t >= 0 && t < best) { best = t; this.hitNormal[0] = 0; this.hitNormal[1] = 1; this.hitNormal[2] = 0; }
    }
    if (!this.boxesEnabled) return best;
    const id = ++this.stampId;
    const cs = this.cell;
    let cx = Math.floor((ox - this.minX) / cs);
    let cz = Math.floor((oz - this.minZ) / cs);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(dx) > 1e-9 ? cs / Math.abs(dx) : Infinity;
    const tDeltaZ = Math.abs(dz) > 1e-9 ? cs / Math.abs(dz) : Infinity;
    const nextX = this.minX + (cx + (dx > 0 ? 1 : 0)) * cs;
    const nextZ = this.minZ + (cz + (dz > 0 ? 1 : 0)) * cs;
    let tMaxX = Math.abs(dx) > 1e-9 ? (nextX - ox) / dx : Infinity;
    let tMaxZ = Math.abs(dz) > 1e-9 ? (nextZ - oz) / dz : Infinity;
    const b = this.boxes;
    let tCell = 0;
    for (let guard = 0; guard < 256; guard++) {
      if (tCell > best) break;
      if (cx >= 0 && cz >= 0 && cx < this.dim && cz < this.dim) {
        const c = cz * this.dim + cx;
        const end = this.cellStart[c + 1];
        for (let k = this.cellStart[c]; k < end; k++) {
          const i = this.cellItems[k];
          if (this.stamp[i] === id) continue;
          this.stamp[i] = id;
          if (skipIgnored && this.isIgnored(i)) continue;
          const o = i * 6;
          // slab test
          let tmin = 0, tmax = best, axis = -1, sign = 0;
          let ok = true;
          for (let a = 0; a < 3 && ok; a++) {
            const oa = a === 0 ? ox : a === 1 ? oy : oz;
            const da = a === 0 ? dx : a === 1 ? dy : dz;
            const lo = b[o + a], hi = b[o + 3 + a];
            if (Math.abs(da) < 1e-9) {
              if (oa < lo || oa > hi) ok = false;
            } else {
              let t1 = (lo - oa) / da, t2 = (hi - oa) / da;
              let s = -1;
              if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
              if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
              if (t2 < tmax) tmax = t2;
              if (tmin > tmax) ok = false;
            }
          }
          if (ok && tmin < best) {
            best = tmin;
            this.hitBox = i;
            this.hitNormal[0] = axis === 0 ? sign : 0;
            this.hitNormal[1] = axis === 1 ? sign : 0;
            this.hitNormal[2] = axis === 2 ? sign : 0;
          }
        }
      } else if ((cx < 0 && stepX < 0) || (cx >= this.dim && stepX > 0) || (cz < 0 && stepZ < 0) || (cz >= this.dim && stepZ > 0)) {
        break; // left the grid for good
      }
      if (tMaxX < tMaxZ) { tCell = tMaxX; tMaxX += tDeltaX; cx += stepX; }
      else { tCell = tMaxZ; tMaxZ += tDeltaZ; cz += stepZ; }
    }
    return best;
  }

  // Is a point inside box i (with margin)?
  insideBox(i, x, y, z, m = 0) {
    const b = this.boxes, o = i * 6;
    return x > b[o] - m && x < b[o + 3] + m && y > b[o + 1] - m && y < b[o + 4] + m && z > b[o + 2] - m && z < b[o + 5] + m;
  }

  // Top surface of a box (for AI roof logic).
  boxTop(i) { return this.boxes[i * 6 + 4]; }
}
