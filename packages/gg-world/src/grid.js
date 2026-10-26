// @ts-check
// Walkability grid (0.5 cells) + A* pathing for click-to-walk, members and the NPC.
export const CELL = 0.5;
export class Grid {
  constructor(minX, minZ, maxX, maxZ) {
    this.minX = minX; this.minZ = minZ; this.w = Math.round((maxX - minX) / CELL); this.h = Math.round((maxZ - minZ) / CELL);
    this.block = new Uint8Array(this.w * this.h);
  }
  ix(x) { return Math.floor((x - this.minX) / CELL); }
  iz(z) { return Math.floor((z - this.minZ) / CELL); }
  cx(i) { return this.minX + (i + 0.5) * CELL; }
  cz(j) { return this.minZ + (j + 0.5) * CELL; }
  /** mark rect (world) blocked (v=1) or free (v=0) */
  rect(x0, z0, x1, z1, v = 1) {
    for (let i = Math.max(0, this.ix(x0)); i <= Math.min(this.w - 1, this.ix(x1 - 1e-3)); i++)
      for (let j = Math.max(0, this.iz(z0)); j <= Math.min(this.h - 1, this.iz(z1 - 1e-3)); j++) this.block[j * this.w + i] = v;
  }
  free(x, z) { const i = this.ix(x), j = this.iz(z); return i >= 0 && j >= 0 && i < this.w && j < this.h && !this.block[j * this.w + i]; }
  /** nearest free cell centre */
  nearestFree(x, z) {
    if (this.free(x, z)) return { x, z };
    for (let r = 1; r < 8; r++) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      const px = x + di * CELL, pz = z + dj * CELL; if (this.free(px, pz)) return { x: this.cx(this.ix(px)), z: this.cz(this.iz(pz)) };
    }
    return { x, z };
  }
  /** A* from world a to world b, returns list of world points (smoothed) or null */
  path(ax, az, bx, bz) {
    const s = this.nearestFree(ax, az), g = this.nearestFree(bx, bz);
    const si = this.ix(s.x), sj = this.iz(s.z), gi = this.ix(g.x), gj = this.iz(g.z), W = this.w;
    const N = this.w * this.h, gs = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const open = [sj * W + si]; gs[open[0]] = 0; const goal = gj * W + gi;
    const hf = k => Math.hypot((k % W) - gi, Math.floor(k / W) - gj);
    let guard = 0;
    while (open.length && guard++ < 6000) {
      let bi = 0; for (let i = 1; i < open.length; i++) if (gs[open[i]] + hf(open[i]) < gs[open[bi]] + hf(open[bi])) bi = i;
      const k = open.splice(bi, 1)[0]; if (k === goal) break; closed[k] = 1;
      const i = k % W, j = (k - i) / W;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue; const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= this.h) continue;
        const nk = nj * W + ni; if (this.block[nk] || closed[nk]) continue;
        if (di && dj && (this.block[j * W + ni] || this.block[nj * W + i])) continue;
        const ng = gs[k] + (di && dj ? 1.414 : 1); if (ng < gs[nk]) { gs[nk] = ng; from[nk] = k; if (!open.includes(nk)) open.push(nk); }
      }
    }
    if (from[goal] < 0 && goal !== open[0]) { if (goal !== sj * W + si) return null; }
    const pts = []; for (let k = goal; k >= 0 && k !== sj * W + si; k = from[k]) pts.push({ x: this.cx(k % W), z: this.cz(Math.floor(k / W)) });
    pts.reverse(); pts.push({ x: bx, z: bz });
    // string-pull: drop points with line of sight
    const out = []; let cur = { x: ax, z: az }, i = 0;
    while (i < pts.length) { let j = pts.length - 1; while (j > i && !this.los(cur, pts[j])) j--; out.push(pts[j]); cur = pts[j]; i = j + 1; }
    return out;
  }
  los(a, b) { const d = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(d / (CELL * 0.4)); for (let k = 1; k < n; k++) { const t = k / n; if (!this.free(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false; } return true; }
}
