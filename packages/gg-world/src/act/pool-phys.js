// @ts-check
// 8-ball physics + rules + House AI, in table-local units (u along the long axis, v across; table centre = 0,0).
export const BR = 0.028;                       // ball radius
export const BX = 1.005, BZ = 0.48;            // cushion noses (half-extents of the playing area)
export const HEAD_U = -BX / 2;                 // head string (ball in hand goes behind it, u < HEAD_U)
export const FOOT_U = BX / 2;
export const POCKETS = [[-1.02, -0.495, 0.07], [0, -0.515, 0.068], [1.02, -0.495, 0.07], [-1.02, 0.495, 0.07], [0, 0.515, 0.068], [1.02, 0.495, 0.07]];
const MU = 0.26, E_BALL = 0.95, E_RAIL = 0.75, VMAX = 4.6;
export const SOLID = n => n >= 1 && n <= 7, STRIPE = n => n >= 9 && n <= 15;

/** @typedef {{n:number,u:number,v:number,vu:number,vv:number,on:boolean,sink:number,pocket:number[]|null}} Ball */
/** @param {()=>number} r @returns {Ball[]} */
export function rack(r) {
  const mk = (n, u, v) => ({ n, u, v, vu: 0, vv: 0, on: true, sink: 0, pocket: null });
  const balls = [mk(0, HEAD_U, 0)];
  const rest = [2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15]; for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  const g = 2 * BR + 0.002; let k = 0;
  for (let row = 0; row < 5; row++) for (let j = 0; j <= row; j++) {
    const n = row === 0 ? 1 : row === 2 && j === 1 ? 8 : row === 4 && j === 0 ? 9 : row === 4 && j === 4 ? (rest.splice(rest.findIndex(SOLID), 1)[0]) : rest[k++] ?? 0;
    balls.push(mk(n, FOOT_U + row * g * 0.866, (j - row / 2) * g));
  }
  // the 'rest[k++]' walk can skip the solid we spliced, so fix any 0s / duplicates
  const used = new Set(balls.map(b => b.n)); const miss = []; for (let n = 1; n <= 15; n++) if (!used.has(n)) miss.push(n);
  const seen = new Set(); for (const b of balls) { if (b.n === 0 && b !== balls[0] || seen.has(b.n)) b.n = /** @type {number} */ (miss.shift()); seen.add(b.n); }
  return balls;
}

/** Advance the table by dt. Returns events { hits:[{u,v,k}], pots:[Ball], firstHit:number|null updates via st }. */
export function step(balls, dt, st) {
  const N = 12, h = dt / N, ev = { hits: [], pots: [] };
  for (let s = 0; s < N; s++) {
    for (const b of balls) {
      if (!b.on) continue;
      const sp = Math.hypot(b.vu, b.vv); if (sp === 0) continue;
      b.u += b.vu * h; b.v += b.vv * h;
      const ns = Math.max(0, sp - MU * h - sp * 0.08 * h); const k = sp > 0 ? ns / sp : 0; b.vu *= k; b.vv *= k; if (ns < 0.004) b.vu = b.vv = 0;
      for (const p of POCKETS) if (Math.hypot(b.u - p[0], b.v - p[1]) < p[2]) { pot(b, p); ev.pots.push(b); break; }
      if (!b.on) continue;
      const nearP = POCKETS.some(p => Math.hypot(b.u - p[0], b.v - p[1]) < 0.095);
      if (!nearP) {
        if (b.u > BX - BR) { b.u = BX - BR; b.vu = -Math.abs(b.vu) * E_RAIL; st.rails++; }
        if (b.u < -BX + BR) { b.u = -BX + BR; b.vu = Math.abs(b.vu) * E_RAIL; st.rails++; }
        if (b.v > BZ - BR) { b.v = BZ - BR; b.vv = -Math.abs(b.vv) * E_RAIL; st.rails++; }
        if (b.v < -BZ + BR) { b.v = -BZ + BR; b.vv = Math.abs(b.vv) * E_RAIL; st.rails++; }
      } else if (Math.abs(b.u) > BX + 0.02 || Math.abs(b.v) > BZ + 0.03) { // slipped past the jaw: it's in
        let best = POCKETS[0], bd = 9; for (const p of POCKETS) { const d = Math.hypot(b.u - p[0], b.v - p[1]); if (d < bd) { bd = d; best = p; } }
        pot(b, best); ev.pots.push(b);
      }
    }
    for (let pass = 0; pass < 3; pass++) for (let i = 0; i < balls.length; i++) { const a = balls[i]; if (!a.on) continue;
      for (let j = i + 1; j < balls.length; j++) { const b = balls[j]; if (!b.on) continue;
        const du = b.u - a.u, dv = b.v - a.v, d2 = du * du + dv * dv; if (d2 >= 4 * BR * BR || d2 === 0) continue;
        const d = Math.sqrt(d2), nu = du / d, nv = dv / d, ov = 2 * BR - d;
        a.u -= nu * ov / 2; a.v -= nv * ov / 2; b.u += nu * ov / 2; b.v += nv * ov / 2;
        const vn = (b.vu - a.vu) * nu + (b.vv - a.vv) * nv; if (vn >= 0) continue;
        const jj = -(1 + E_BALL) * vn / 2; a.vu -= jj * nu; a.vv -= jj * nv; b.vu += jj * nu; b.vv += jj * nv;
        if (st.firstHit == null && (a.n === 0 || b.n === 0)) st.firstHit = a.n === 0 ? b.n : a.n;
        if (jj > 0.15) ev.hits.push({ u: a.u + nu * BR, v: a.v + nv * BR, k: Math.min(1, jj / 2) });
      } }
  }
  return ev;
}
function pot(b, p) { b.on = false; b.pocket = p; b.vu = b.vv = 0; }
export const moving = balls => balls.some(b => b.on && (b.vu || b.vv));
export function shoot(cue, ang, power) { const s = VMAX * (0.08 + 0.92 * power); cue.vu = Math.cos(ang) * s; cue.vv = Math.sin(ang) * s; }

/** First thing the cue ball meets going along ang: { t, ball|null } (t = travel distance of the cue centre). */
export function trace(balls, cue, ang) {
  const du = Math.cos(ang), dv = Math.sin(ang); let t = 9, hit = null;
  for (const b of balls) { if (!b.on || b === cue) continue;
    const ou = b.u - cue.u, ov = b.v - cue.v, along = ou * du + ov * dv; if (along <= 0) continue;
    const perp2 = ou * ou + ov * ov - along * along, R2 = 4 * BR * BR; if (perp2 > R2) continue;
    const tt = along - Math.sqrt(R2 - perp2); if (tt < t) { t = tt; hit = b; } }
  // cushion
  const lim = (p, d, m) => d > 0 ? (m - BR - p) / d : d < 0 ? (-m + BR - p) / d : 9;
  const tc = Math.min(lim(cue.u, du, BX), lim(cue.v, dv, BZ)); if (tc < t) { t = Math.max(0, tc); hit = null; }
  return { t, ball: hit };
}
const segClear = (balls, skip, au, av, bu, bv, rad) => {
  const lu = bu - au, lv = bv - av, L2 = lu * lu + lv * lv || 1e-9;
  for (const o of balls) { if (!o.on || skip.includes(o)) continue;
    const t = Math.max(0, Math.min(1, ((o.u - au) * lu + (o.v - av) * lv) / L2)); if (Math.hypot(o.u - au - lu * t, o.v - av - lv * t) < rad) return false; }
  return true;
};
/** Legal target numbers for a side. */
export function targets(balls, group) {
  const left = balls.filter(b => b.on && b.n !== 0 && b.n !== 8 && (!group || (group === 'solids' ? SOLID(b.n) : STRIPE(b.n))));
  if (group && !left.length) return balls.filter(b => b.on && b.n === 8);
  return left;
}
/** House AI: best pot it can see, else a safe-ish hit. @returns {{ang:number, power:number, note:string}} */
export function think(balls, group, rnd, isBreak) {
  const cue = balls[0];
  if (isBreak) { const ap = balls.find(b => b.n === 1) || balls[1]; return { ang: Math.atan2(ap.v - cue.v, ap.u - cue.u) + (rnd() - 0.5) * 0.02, power: 0.92 + rnd() * 0.08, note: 'break' }; }
  let best = null;
  for (const b of targets(balls, group)) for (const p of POCKETS) {
    const pu = p[0] - b.u, pv = p[1] - b.v, pd = Math.hypot(pu, pv), gu = b.u - pu / pd * 2 * BR, gv = b.v - pv / pd * 2 * BR;
    const cu = gu - cue.u, cv = gv - cue.v, cd = Math.hypot(cu, cv); if (cd < 1e-3) continue;
    const cut = (cu * pu + cv * pv) / (cd * pd); if (cut < 0.3) continue;
    if (Math.abs(gu) > BX - BR || Math.abs(gv) > BZ - BR) continue;
    if (!segClear(balls, [cue, b], cue.u, cue.v, gu, gv, 2 * BR - 0.002) || !segClear(balls, [cue, b], b.u, b.v, p[0], p[1], 2 * BR - 0.002)) continue;
    const score = cut * cut / (0.4 + cd + pd * 1.4);
    if (!best || score > best.score) best = { score, ang: Math.atan2(cv, cu), power: Math.min(1, 0.22 + (cd + pd / Math.max(cut, 0.4)) * 0.28), note: b.n };
  }
  if (best) return { ang: best.ang + (rnd() + rnd() - 1) * 0.022, power: best.power, note: 'pot ' + best.note };
  const ts = targets(balls, group); let near = ts[0], nd = 9;
  for (const b of ts) { const d = Math.hypot(b.u - cue.u, b.v - cue.v); if (d < nd && segClear(balls, [cue, b], cue.u, cue.v, b.u, b.v, 2 * BR)) { nd = d; near = b; } }
  if (!near) return { ang: rnd() * Math.PI * 2, power: 0.5, note: 'pray' };
  return { ang: Math.atan2(near.v - cue.v, near.u - cue.u) + (rnd() - 0.5) * 0.05, power: 0.45 + rnd() * 0.2, note: 'safety' };
}
/** Free spot for ball in hand behind the head string, nearest to (u,v). */
export function placeCue(balls, u, v) {
  u = Math.max(-BX + BR, Math.min(HEAD_U, u)); v = Math.max(-BZ + BR, Math.min(BZ - BR, v));
  const ok = (a, b) => balls.every(o => !o.on || o.n === 0 || Math.hypot(o.u - a, o.v - b) > 2 * BR + 0.002);
  if (ok(u, v)) return [u, v];
  for (let r = 0.02; r < 0.5; r += 0.02) for (let a = 0; a < 6.28; a += 0.5) { const a2 = Math.max(-BX + BR, Math.min(HEAD_U, u + Math.cos(a) * r)), b2 = Math.max(-BZ + BR, Math.min(BZ - BR, v + Math.sin(a) * r)); if (ok(a2, b2)) return [a2, b2]; }
  return [HEAD_U, 0];
}
