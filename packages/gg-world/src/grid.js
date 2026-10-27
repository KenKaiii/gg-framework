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
    const goal = gj * W + gi;
    // normal search first; if the goal can't be reached (start or goal sits in a pocket boxed in by furniture), search
    // again letting the route squeeze through furniture at a high cost, so nobody is ever trapped or walks blindly through
    let from = this._astar(si, sj, gi, gj, false);
    if (from[goal] < 0 && goal !== sj * W + si) from = this._astar(si, sj, gi, gj, true);
    if (from[goal] < 0 && goal !== sj * W + si) return null;
    const pts = []; for (let k = goal; k >= 0 && k !== sj * W + si; k = from[k]) pts.push({ x: this.cx(k % W), z: this.cz(Math.floor(k / W)) });
    pts.reverse(); pts.push({ x: bx, z: bz });
    // string-pull: drop points with line of sight (in soft mode only through free cells, so the squeeze stays short)
    const out = []; let cur = { x: ax, z: az }, i = 0;
    while (i < pts.length) { let j = pts.length - 1; while (j > i && !this.los(cur, pts[j])) j--; out.push(pts[j]); cur = pts[j]; i = j + 1; }
    return out;
  }
  /** A* over cells; soft = blocked cells are passable at a high cost. Returns the parent array. */
  _astar(si, sj, gi, gj, soft) {
    const W = this.w, N = this.w * this.h, gs = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const open = [sj * W + si]; gs[open[0]] = 0; const goal = gj * W + gi;
    const hf = k => Math.hypot((k % W) - gi, Math.floor(k / W) - gj);
    let guard = 0;
    while (open.length && guard++ < 6000) {
      let bi = 0; for (let i = 1; i < open.length; i++) if (gs[open[i]] + hf(open[i]) < gs[open[bi]] + hf(open[bi])) bi = i;
      const k = open.splice(bi, 1)[0]; if (k === goal) break; closed[k] = 1;
      const i = k % W, j = (k - i) / W;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue; const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= this.h) continue;
        const nk = nj * W + ni; if (closed[nk] || (!soft && this.block[nk])) continue;
        if (!soft && di && dj && (this.block[j * W + ni] || this.block[nj * W + i])) continue;
        const ng = gs[k] + (di && dj ? 1.414 : 1) + (soft && this.block[nk] ? 30 : 0); if (ng < gs[nk]) { gs[nk] = ng; from[nk] = k; if (!open.includes(nk)) open.push(nk); }
      }
    }
    return from;
  }
  /** inside the grid, away from the outer wall strip (for letting a boxed-in player squeeze out, never through a wall) */
  inner(x, z) { const i = this.ix(x), j = this.iz(z); return i >= 1 && j >= 1 && i < this.w - 1 && j < this.h - 1; }
  /** Is (x,z) in a small walkable pocket cut off from the room's main floor (or inside furniture)? Cached per grid. */
  boxedIn(x, z) {
    const i = this.ix(x), j = this.iz(z); if (i < 0 || j < 0 || i >= this.w || j >= this.h) return false; const k = j * this.w + i;
    if (this.block[k]) return true;
    if (!this._comp || this._compSum !== this._sum()) this._label();
    return this._comp[k] !== this._main;
  }
  _sum() { let s = 0; for (let k = 0; k < this.block.length; k += 7) s += this.block[k] * k; return s; }
  _label() {
    const W = this.w, H = this.h, comp = new Int32Array(W * H).fill(-1), size = []; let nc = 0;
    for (let s = 0; s < W * H; s++) { if (this.block[s] || comp[s] >= 0) continue; const st = [s]; comp[s] = nc; let n = 0;
      while (st.length) { const k = st.pop(); n++; const i = k % W, j = (k - i) / W;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) { if (!di && !dj) continue; const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni;
          if (this.block[nk] || comp[nk] >= 0 || (di && dj && (this.block[j * W + ni] || this.block[nj * W + i]))) continue; comp[nk] = nc; st.push(nk); } }
      size.push(n); nc++; }
    this._comp = comp; this._main = size.indexOf(Math.max(0, ...size)); this._compSum = this._sum();
  }
  los(a, b) { const d = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(d / (CELL * 0.4)); for (let k = 1; k < n; k++) { const t = k / n; if (!this.free(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false; } return true; }
}
