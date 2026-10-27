// @ts-check
// The neighbourhood round the house (owner: "a neighbourhood: greenery, grass round the building, then roads, not all
// roads, trees ... focus stays on the inside"). Layout by distance from the house's outer walls:
//   0..9.6     the plot: striped lawn, flower beds along the walls, flagstone paths, picket fence (street sides) / hedge
//   west+south a quiet two-lane street (footpaths both sides), the only traffic; across it front gardens, driveways (all
//              parked cars live on driveways, never on the road) and suburban houses with pitched roofs
//   north+east a small park: tree clumps, a pond, a gravel loop with benches, houses far back
// All MeshBasic with baked shading (patch() adds the time-of-day tint, focus dimming, edge fade). Instanced where repeated.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { carGeometry, CAR_KINDS, wheelGeometry } from './outside-cars.js';

const PALW = ['#d8cdb8', '#c9d4d0', '#e2d2c0', '#b9c6d4', '#d6c39c', '#c8b2a6', '#e4e0d4', '#b4c2a8'];  // siding colours
const PALR = ['#5a4a4a', '#6a3e34', '#48505a', '#3e4a44', '#7a5a48', '#4a4040'];                       // roofs

/** siding + windows texture: 4 x 2 cells of 3 m (one storey per row); glow = lit windows */
function sidingTextures(rand) {
  const CW = 96, CH = 96, NX = 4, NY = 2, mk = () => { const c = document.createElement('canvas'); c.width = CW * NX; c.height = CH * NY; return [c, /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'))]; };
  const [c1, f] = mk(), [c2, w] = mk(); f.fillStyle = '#f2efe8'; f.fillRect(0, 0, CW * NX, CH * NY); w.fillStyle = '#000'; w.fillRect(0, 0, CW * NX, CH * NY);
  for (let y = 0; y < CH * NY; y += 6) { f.fillStyle = 'rgba(0,0,0,0.10)'; f.fillRect(0, y + 5, CW * NX, 1); f.fillStyle = 'rgba(255,255,255,0.35)'; f.fillRect(0, y, CW * NX, 1); }
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const x = i * CW + 30, y = j * CH + 22, ww = 36, wh = 44;
    f.fillStyle = '#fbfaf6'; f.fillRect(x - 5, y - 5, ww + 10, wh + 12); f.fillStyle = '#3a4656'; f.fillRect(x, y, ww, wh); f.fillStyle = '#56667c'; f.fillRect(x, y, ww, 14);
    f.fillStyle = '#fbfaf6'; f.fillRect(x + ww / 2 - 2, y, 4, wh); f.fillRect(x, y + wh / 2 - 2, ww, 4);
    f.fillStyle = ['#4a6a5a', '#3a4a6a', '#6a3a3a', '#2e2e34'][(i + j) % 4]; f.fillRect(x - 14, y - 4, 8, wh + 8); f.fillRect(x + ww + 6, y - 4, 8, wh + 8); // shutters
    f.fillStyle = 'rgba(0,0,0,0.18)'; f.fillRect(x - 5, y + wh + 5, ww + 10, 3);
    if (rand() < 0.45) { w.fillStyle = `rgb(255,${190 + rand() * 40 | 0},${110 + rand() * 50 | 0})`; w.fillRect(x, y, ww, wh); w.fillStyle = 'rgba(0,0,0,1)'; w.fillRect(x + ww / 2 - 2, y, 4, wh); w.fillRect(x, y + wh / 2 - 2, ww, 4); } }
  const t1 = new THREE.CanvasTexture(c1), t2 = new THREE.CanvasTexture(c2); for (const t of [t1, t2]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; }
  return [t1, t2];
}

/** @param {any} ctx */
/** Async: yields between sections so building the town never blocks the app for long (World shares its thread). @param {any} ctx */
export async function buildHood(ctx) {
  const yieldNow = () => new Promise(res => setTimeout(res, 0));
  const { root, B, GY, P, patch, r, colored, quad, geo, radialTex } = ctx; const C = h => new THREE.Color(h);
  const cxB = (B.x0 + B.x1) / 2, czB = (B.z0 + B.z1) / 2;
  const Q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);
  const mtx = (yaw, x, z, y = GY, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), Q.clone().setFromAxisAngle(Y, yaw), new THREE.Vector3(s, s, s));
  const ROAD = [11.4, 18], FOOT_IN = 9.6, FOOT_OUT = 19.8, LANE_IN = 13.05, LANE_OUT = 16.35, ROADC = 14.7;
  const dW = x => B.x0 - x, dS = z => z - B.z1, bdOf = (x, z) => Math.max(B.x0 - x, x - B.x1, B.z0 - z, z - B.z1);
  const nearRoad = (x, z, pad) => (dW(x) > FOOT_IN - pad && dW(x) < FOOT_OUT + pad) || (dS(z) > FOOT_IN - pad && dS(z) < FOOT_OUT + pad);
  const POND = { x: B.x1 + 23, z: czB - 3, rx: 8.5, rz: 5.6 };
  const inPond = (x, z, pad = 0) => ((x - POND.x) / (POND.rx + pad)) ** 2 + ((z - POND.z) / (POND.rz + pad)) ** 2 < 1;
  // garden: the gate path from the street ends at a small patio (bench + table) on the lawn, never at a wall with no door
  const PATIO = [{ x: cxB, z: B.z1 + 3.5, yaw: 0 }, { x: B.x0 - 3.5, z: czB, yaw: -Math.PI / 2 }];
  const onPatio = (x, z, pad = 0) => PATIO.some(q => Math.hypot(x - q.x, z - q.z) < 2.3 + pad);
  const onPlotPath = (x, z, pad = 0) => (Math.abs(x - cxB) < 1.0 + pad && dS(z) > 4.4 && dS(z) < FOOT_IN + 0.2) || (Math.abs(z - czB) < 1.0 + pad && dW(x) > 4.4 && dW(x) < FOOT_IN + 0.2) || onPatio(x, z, pad);

  await yieldNow();
  // ---- houses (planned first: the ground paints their driveways) ----------------------------------------------------
  const houses = []; const lots = (along0, along1, cb) => { for (let a = along0; a < along1;) { const lw = 13 + r() * 4; cb(a + lw / 2, lw); a += lw; } };
  const SET = 5.5; // front garden depth
  lots(B.z0 - 46, B.z1 + 46, (a, lw) => { const d = 7 + r() * 2, x = B.x0 - (FOOT_OUT + SET + d / 2); if (Math.abs(dS(a)) < 30 && dS(a) > ROAD[0] - 9 && dS(a) < FOOT_OUT + 6) return; houses.push({ x, z: a, yaw: Math.PI / 2, w: lw - 4 - r() * 2, d, road: true }); });
  lots(B.x0 - 46, B.x1 + 46, (a, lw) => { const d = 7 + r() * 2, z = B.z1 + (FOOT_OUT + SET + d / 2); if (dW(a) > ROAD[0] - 9 && dW(a) < FOOT_OUT + 6) return; houses.push({ x: a, z, yaw: Math.PI, w: lw - 4 - r() * 2, d, road: true }); });
  lots(B.x0 - 8, B.x1 + 40, (a, lw) => { const d = 7 + r() * 2; houses.push({ x: a, z: B.z0 - (33 + d / 2), yaw: 0, w: lw - 4 - r() * 2, d, road: false }); });
  lots(B.z0 - 26, B.z1 + 6, (a, lw) => { const d = 7 + r() * 2; houses.push({ x: B.x1 + (37 + d / 2), z: a, yaw: -Math.PI / 2, w: lw - 4 - r() * 2, d, road: false }); });
  for (const h of houses) { h.floors = r() < 0.45 ? 2 : 1; h.wc = C(PALW[Math.floor(r() * PALW.length)]); h.rc = C(PALR[Math.floor(r() * PALR.length)]); h.fx = Math.sin(h.yaw); h.fz = Math.cos(h.yaw); h.rx = Math.cos(h.yaw); h.rz = -Math.sin(h.yaw);
    h.drive = h.road && r() < 0.75 ? (r() < 0.5 ? -1 : 1) : 0; } // driveway on the left / right of the house
  const inHouse = (x, z, pad) => houses.some(h => { const lx = (x - h.x) * h.rx + (z - h.z) * h.rz, lz = (x - h.x) * h.fx + (z - h.z) * h.fz; return Math.abs(lx) < h.w / 2 + pad && Math.abs(lz) < h.d / 2 + pad; });
  const driveRect = h => { const side = h.w / 2 + 1.9, len = SET + 0.4; return { cl: side * h.drive, cz: h.d / 2 + len / 2, w: 3.0, l: len }; };
  const inDrive = (x, z, pad) => houses.some(h => { if (!h.drive) return false; const D = driveRect(h), lx = (x - h.x) * h.rx + (z - h.z) * h.fx * 0 + (z - h.z) * h.rz, lz = (x - h.x) * h.fx + (z - h.z) * h.fz; return Math.abs(lx - D.cl) < D.w / 2 + pad && Math.abs(lz - D.cz) < D.l / 2 + pad; });

  await yieldNow();
  // ---- ground: one painted plane -------------------------------------------------------------------------------------
  const ppm = 6, X0 = B.x0 - P, Z0 = B.z0 - P, GW = Math.round((B.x1 - B.x0 + 2 * P) * ppm), GH = Math.round((B.z1 - B.z0 + 2 * P) * ppm);
  const cv = document.createElement('canvas'); cv.width = GW; cv.height = GH; const g = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  const img = g.createImageData(GW, GH), D = img.data; const nz = new Float32Array(256 * 256); for (let i = 0; i < nz.length; i++) nz[i] = r();
  const N = (x, z, s) => nz[((Math.floor(z * s) & 255) << 8) | (Math.floor(x * s) & 255)];
  const smooth = (x, z, s) => (N(x, z, s) + N(x + 1 / s, z, s) + N(x, z + 1 / s, s) + N(x + 1 / s, z + 1 / s, s)) / 4;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const x = X0 + (i + 0.5) / ppm, z = Z0 + (j + 0.5) / ppm, w = dW(x), s = dS(z), bd = bdOf(x, z), n = (N(x, z, 6) - 0.5) * 14;
    let c;
    const rW = w > ROAD[0] && w < ROAD[1], rS = s > ROAD[0] && s < ROAD[1];
    if (rW || rS) { // asphalt + markings
      const t = 62 + n * 0.7 + (smooth(x, z, 0.7) - 0.5) * 10; c = [t, t, t + 5];
      const both = rW && rS;
      if (!both) { const dd = rW ? w : s, al = rW ? z : x; if (Math.abs(dd - ROADC) < 0.08 && ((al % 3) + 3) % 3 < 1.6) c = [204, 196, 172]; if (Math.abs(dd - ROAD[0] - 0.25) < 0.06 || Math.abs(dd - ROAD[1] + 0.25) < 0.06) c = [150, 150, 150];
        const zc = rW ? czB : cxB; if (Math.abs(al - zc) < 1.6 && dd > ROAD[0] + 0.5 && dd < ROAD[1] - 0.5 && (((dd - ROAD[0]) % 0.9) + 0.9) % 0.9 < 0.45) c = [196, 196, 190]; }
    } else if ((w > ROAD[0] - 0.3 && w <= ROAD[0]) || (w >= ROAD[1] && w < ROAD[1] + 0.3) || (s > ROAD[0] - 0.3 && s <= ROAD[0]) || (s >= ROAD[1] && s < ROAD[1] + 0.3)) c = [176, 174, 170]; // kerb
    else if ((w > FOOT_IN && w < FOOT_OUT) || (s > FOOT_IN && s < FOOT_OUT)) { const al = (w > FOOT_IN && w < FOOT_OUT) ? z : x, dd = (w > FOOT_IN && w < FOOT_OUT) ? w : s; const jt = ((al % 1.5) + 1.5) % 1.5 < 0.05 || ((dd % 1.5) + 1.5) % 1.5 < 0.05; const t = jt ? 118 : 148 + n * 0.6; c = [t, t - 1, t + 2]; }
    else if (bd < FOOT_IN) { // the plot
      if (onPlotPath(x, z)) { const fx = ((x * 1.1) % 1 + 1) % 1, fz = ((z * 1.1 + Math.floor(x * 1.1) * 0.5) % 1 + 1) % 1; const jt = fx < 0.07 || fz < 0.07; const t = jt ? 108 : 166 + n + (N(x, z, 2) - 0.5) * 16; c = [t, t - 6, t - 16];
        if (onPatio(x, z) && !onPatio(x, z, -0.18)) c = [124, 116, 100]; }
      else if (bd > 0.3 && bd < 1.7) { c = [86 + n, 60 + n * 0.6, 42 + n * 0.5]; if (N(x, z, 9) > 0.86) c = [[226, 92, 112], [246, 210, 96], [236, 236, 240], [168, 120, 220], [250, 150, 80]][Math.floor(N(x + 3, z, 9) * 5)]; else if (N(x, z, 4) > 0.55) c = [64 + n, 104 + n, 56 + n]; }
      else { const stripe = (Math.floor((x - B.x0) / 2.2) % 2) ? 7 : -5, blade = (N(x, z, 14) - 0.5) * 22, patch2 = (smooth(x, z, 0.6) - 0.5) * 14; c = [84 + n + stripe + blade * 0.6 + patch2, 122 + n + stripe + blade + patch2, 62 + n * 0.8 + stripe * 0.5 + blade * 0.4]; }
    } else if (w > FOOT_OUT || s > FOOT_OUT) { const t = (smooth(x, z, 0.5) - 0.5) * 18, blade = (N(x, z, 14) - 0.5) * 18; c = [90 + n + t + blade * 0.5, 124 + n + t + blade, 68 + n * 0.8 + t]; } // front gardens across the street
    else { // the park
      const t = (smooth(x, z, 0.35) - 0.5) * 26, blade = (N(x, z, 14) - 0.5) * 20; c = [80 + n + t + blade * 0.5, 116 + n + t + blade, 62 + n * 0.8 + t * 0.8];
      const ex = (x - POND.x) / (POND.rx + 4.6), ez = (z - POND.z) / (POND.rz + 4.6), e = Math.sqrt(ex * ex + ez * ez); if (Math.abs(e - 1) < 0.08) { const tt = 166 + n; c = [tt, tt - 12, tt - 36]; }
      if (inPond(x, z, 0.9) && !inPond(x, z)) c = [94 + n, 84 + n, 58 + n];
    }
    const o = (j * GW + i) * 4; D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; D[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // driveways + front paths (canvas overlays)
  const toPx = (x, z) => [(x - X0) * ppm, (z - Z0) * ppm];
  const rectW = (h, cl, cz, ww, ll, fill) => { g.save(); const [px, pz] = toPx(h.x + h.rx * cl + h.fx * cz, h.z + h.rz * cl + h.fz * cz); g.translate(px, pz); g.rotate(-h.yaw); g.fillStyle = fill; g.fillRect(-ww / 2 * ppm, -ll / 2 * ppm, ww * ppm, ll * ppm); g.restore(); };
  for (const h of houses) { if (h.drive) { const Dr = driveRect(h); rectW(h, Dr.cl, Dr.cz, Dr.w, Dr.l, '#9e9a92'); rectW(h, Dr.cl, Dr.cz, Dr.w - 0.4, Dr.l, '#a8a49c'); }
    rectW(h, 0, h.d / 2 + SET / 2 + 0.2, 1.2, SET + 0.4, '#b0a898'); }
  const gtex = new THREE.CanvasTexture(cv); gtex.colorSpace = THREE.SRGBColorSpace; gtex.anisotropy = 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(B.x1 - B.x0 + 2 * P, B.z1 - B.z0 + 2 * P).rotateX(-Math.PI / 2), patch(new THREE.MeshBasicMaterial({ map: gtex }), { ground: true }));
  ground.position.set(cxB, GY, czB); root.add(ground);

  await yieldNow();
  // ---- static geometry, merged: kerbs, fence, hedges, houses, benches ---------------------------------------------------
  const solid = []; const wall = { pos: [], uv: [], col: [] }, glow = { pos: [], uv: [], col: [] };
  const LDIR = new THREE.Vector3(0.45, 1, 0.3).normalize(), sh = (nx, nz) => 0.58 + 0.42 * Math.max(0, nx * LDIR.x + nz * LDIR.z);
  const add = (geom, color, m) => { if (m) geom.applyMatrix4(m); solid.push(colored(geom, color instanceof THREE.Color ? color : C(color))); };
  // kerb strips (raised 8 cm) along both sides of both roads
  const EXT = P - 4;
  for (const dd of [ROAD[0] - 0.15, ROAD[1] + 0.15]) { add(new THREE.BoxGeometry(0.3, 0.1, B.z1 - B.z0 + 2 * EXT), '#b4b2ae', mtx(0, B.x0 - dd, czB, GY + 0.05)); add(new THREE.BoxGeometry(B.x1 - B.x0 + 2 * EXT, 0.1, 0.3), '#b4b2ae', mtx(0, cxB, B.z1 + dd, GY + 0.05)); }
  // picket fence on the street sides (gap at the path), hedges on the garden sides
  const fenceRun = (x0, z0, x1, z1) => { const L = Math.hypot(x1 - x0, z1 - z0), yaw = Math.atan2(x1 - x0, z1 - z0); for (let s = 0.25; s < L; s += 0.42) { const x = x0 + (x1 - x0) * s / L, z = z0 + (z1 - z0) * s / L; if (onPlotPath(x, z, 0.1)) continue; add(new THREE.BoxGeometry(0.09, 0.82, 0.05), '#ece8de', mtx(yaw, x, z, GY + 0.41)); }
    for (const yy of [0.32, 0.64]) { let s0 = 0; for (let s = 0; s <= L + 0.01; s += 0.1) { const x = x0 + (x1 - x0) * Math.min(s, L) / L, z = z0 + (z1 - z0) * Math.min(s, L) / L, gap = onPlotPath(x, z, 0.1) || s >= L; if (gap) { if (s - s0 > 0.3) { const a0 = s0, a1 = Math.min(s, L), mx = x0 + (x1 - x0) * (a0 + a1) / 2 / L, mz = z0 + (z1 - z0) * (a0 + a1) / 2 / L; add(new THREE.BoxGeometry(0.04, 0.06, a1 - a0), '#e4e0d6', mtx(yaw, mx, mz, GY + yy)); } s0 = s + 0.1; } } } };
  const F = 9.1; fenceRun(B.x0 - F, B.z0 - F, B.x0 - F, B.z1 + F); fenceRun(B.x0 - F, B.z1 + F, B.x1 + F, B.z1 + F);
  const hedgeRun = (x0, z0, x1, z1) => { const L = Math.hypot(x1 - x0, z1 - z0), yaw = Math.atan2(x1 - x0, z1 - z0); for (let s = 1; s < L; s += 2) { const x = x0 + (x1 - x0) * s / L, z = z0 + (z1 - z0) * s / L, k = 0.9 + r() * 0.25; add(new RoundedBoxGeometry(0.95, 1.05 * k, 2.15, 2, 0.32), C('#3e6438').multiplyScalar(0.9 + r() * 0.2), mtx(yaw, x, z, GY + 0.52 * k)); } };
  hedgeRun(B.x0 - F, B.z0 - F, B.x1 + F, B.z0 - F); hedgeRun(B.x1 + F, B.z0 - F, B.x1 + F, B.z1 + F);
  // houses
  for (const h of houses) {
    const H = h.floors * 2.9, T = (lx, ly, lz) => [h.x + lx * h.rx + lz * h.fx, GY + ly, h.z + lx * h.rz + lz * h.fz];
    const W2 = h.w / 2, D2 = h.d / 2, y0 = 0.3, faces = [[[-W2, D2], [W2, D2], h.w, [h.fx, h.fz]], [[W2, -D2], [-W2, -D2], h.w, [-h.fx, -h.fz]], [[W2, D2], [W2, -D2], h.d, [h.rx, h.rz]], [[-W2, -D2], [-W2, D2], h.d, [-h.rx, -h.rz]]];
    const u0 = Math.floor(r() * 4) / 4;
    for (const [[ax, az], [bx, bz], L, nrm] of faces) { const col = h.wc.clone().multiplyScalar(sh(nrm[0], nrm[1])); const ua = [u0, 0], ub = [u0 + L / 12, 0], uc = [u0 + L / 12, H / 5.8], ud = [u0, H / 5.8];
      quad(wall.pos, wall.uv, wall.col, T(ax, y0, az), T(bx, y0, bz), T(bx, y0 + H, bz), T(ax, y0 + H, az), ua, ub, uc, ud, col);
      const o = 0.02, P2 = (p2) => [p2[0] + nrm[0] * o, p2[1], p2[2] + nrm[1] * o]; quad(glow.pos, glow.uv, glow.col, P2(T(ax, y0, az)), P2(T(bx, y0, bz)), P2(T(bx, y0 + H, bz)), P2(T(ax, y0 + H, az)), ua, ub, uc, ud, C('#ffffff')); }
    const M = mtx(h.yaw, h.x, h.z);
    add(new THREE.BoxGeometry(h.w + 0.3, y0, h.d + 0.3).translate(0, y0 / 2, 0), '#8a847a', M.clone());
    // gable roof: ridge along the width, 0.45 m overhang; gable ends in the wall colour
    const rh = h.d * 0.38, ov = 0.45, prof = new THREE.Shape([new THREE.Vector2(-D2 - ov, 0), new THREE.Vector2(D2 + ov, 0), new THREE.Vector2(0, rh + 0.1)]);
    const roof = new THREE.ExtrudeGeometry(prof, { depth: h.w + 2 * ov, bevelEnabled: false }); roof.rotateY(Math.PI / 2); roof.translate(-W2 - ov, y0 + H - 0.05, 0); // profile in local z/y
    // ExtrudeGeometry shape x -> after rotateY(90) maps to -z; it's symmetric so fine
    add(roof, h.rc, M.clone());
    const gab = new THREE.Shape([new THREE.Vector2(-D2, 0), new THREE.Vector2(D2, 0), new THREE.Vector2(0, rh - 0.12)]); for (const sx of [-1, 1]) { const ge = new THREE.ShapeGeometry(gab); ge.rotateY(sx * Math.PI / 2); ge.translate(sx * (W2 + 0.005), y0 + H, 0); add(ge, h.wc.clone().multiplyScalar(0.92), M.clone()); }
    add(new THREE.BoxGeometry(h.w + 2 * ov + 0.1, 0.12, 0.22).translate(0, y0 + H + rh, 0), h.rc.clone().multiplyScalar(0.8), M.clone()); // ridge cap
    if (r() < 0.7) add(new THREE.BoxGeometry(0.7, 1.6, 0.7).translate(W2 * (r() < 0.5 ? -0.55 : 0.55), y0 + H + rh * 0.6, -D2 * 0.3), '#8a5a4a', M.clone());
    // door, porch roof + posts, step, porch light
    add(new THREE.BoxGeometry(1.0, 2.0, 0.08).translate(0, y0 + 1.0, D2 + 0.04), ['#5a3a2a', '#2e4a5a', '#7a2a2a', '#3a4a3a'][Math.floor(r() * 4)], M.clone());
    add(new THREE.BoxGeometry(2.4, 0.12, 1.5).translate(0, y0 + 2.55, D2 + 0.75), h.rc, M.clone());
    for (const px of [-1.05, 1.05]) add(new THREE.BoxGeometry(0.12, 2.5, 0.12).translate(px, y0 + 1.25, D2 + 1.4), '#ece8de', M.clone());
    add(new THREE.BoxGeometry(1.8, 0.18, 0.9).translate(0, 0.09, D2 + 0.6), '#a8a49c', M.clone());
    // garden bits: a bush or two by the door
    for (const sx of [-1, 1]) if (r() < 0.7) add(new THREE.IcosahedronGeometry(0.55 + r() * 0.25, 1).scale(1, 0.75, 1).translate(sx * (1.9 + r() * 0.6), 0.45, D2 + 0.6), C('#4a7040').multiplyScalar(0.85 + r() * 0.3), M.clone());
  }
  // park benches round the gravel loop
  for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2 + 0.3, bx = POND.x + Math.cos(a) * (POND.rx + 6.2), bz = POND.z + Math.sin(a) * (POND.rz + 6.2); if (nearRoad(bx, bz, 1.5) || bdOf(bx, bz) < 11) continue; const yaw = Math.atan2(POND.x - bx, POND.z - bz), M = mtx(yaw, bx, bz);
    add(new THREE.BoxGeometry(1.7, 0.08, 0.45).translate(0, 0.45, 0), '#8a6a4a', M.clone()); add(new THREE.BoxGeometry(1.7, 0.45, 0.07).translate(0, 0.75, -0.22), '#8a6a4a', M.clone()); for (const sx of [-0.7, 0.7]) add(new THREE.BoxGeometry(0.07, 0.45, 0.4).translate(sx, 0.22, 0), '#2a2c30', M.clone()); }
  for (const q of PATIO) { const fx = Math.sin(q.yaw), fz = Math.cos(q.yaw), M = mtx(q.yaw, q.x - fx * 0.9, q.z - fz * 0.9); // bench with its back to the house, facing the street
    add(new THREE.BoxGeometry(1.8, 0.08, 0.48).translate(0, 0.45, 0), '#9a7452', M.clone()); add(new THREE.BoxGeometry(1.8, 0.42, 0.07).translate(0, 0.74, -0.23), '#9a7452', M.clone());
    for (const sx of [-0.75, 0.75]) add(new THREE.BoxGeometry(0.07, 0.45, 0.44).translate(sx, 0.22, 0), '#2e3034', M.clone());
    const T2 = mtx(q.yaw, q.x + fx * 0.6, q.z + fz * 0.6); add(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 16).translate(0, 0.62, 0), '#d8d2c4', T2.clone()); add(new THREE.CylinderGeometry(0.05, 0.08, 0.6, 8).translate(0, 0.3, 0), '#3a3c40', T2.clone());
    for (const sx of [-1.75, 1.75]) { const PM = mtx(q.yaw, q.x + Math.cos(q.yaw) * sx, q.z - Math.sin(q.yaw) * sx); add(new THREE.CylinderGeometry(0.3, 0.24, 0.5, 10).translate(0, 0.25, 0), '#a8583a', PM.clone()); add(new THREE.IcosahedronGeometry(0.42, 1).scale(1, 0.85, 1).translate(0, 0.78, 0), C('#4e7a40'), PM.clone()); } }
  root.add(new THREE.Mesh(mergeGeometries(solid), patch(new THREE.MeshBasicMaterial({ vertexColors: true }), { grain: true })));
  const [sideT, glowT] = sidingTextures(r);
  root.add(new THREE.Mesh(geo(wall.pos, wall.uv, wall.col), patch(new THREE.MeshBasicMaterial({ map: sideT, vertexColors: true }))));
  const glowM = patch(new THREE.MeshBasicMaterial({ map: glowT, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }), { tint: false });
  const glows = new THREE.Mesh(geo(glow.pos, glow.uv, glow.col), glowM); glows.renderOrder = 1; root.add(glows);
  // pond water: reflects the sky colour
  const water = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), patch(new THREE.MeshBasicMaterial({ color: C('#3e5e6e') }), { water: true }));
  water.scale.set(POND.rx, 1, POND.rz); water.position.set(POND.x, GY + 0.03, POND.z); root.add(water);

  await yieldNow();
  // ---- trees: 3 leafy kinds + pines + bushes, instanced (trunks share one mesh) ---------------------------------------
  // foliage: per-face light/dark speckle (reads as clusters of leaves) + the underside of the crown in shade
  const leafy = (geom) => { const g2 = geom.index ? geom.toNonIndexed() : geom; g2.computeVertexNormals(); g2.computeBoundingBox(); const Pp = g2.attributes.position, Nn = g2.attributes.normal, n = Pp.count, a = new Float32Array(n * 3), bb = g2.boundingBox;
    for (let f = 0; f < n; f += 3) { const k = 0.74 + r() * 0.42; for (let v = f; v < f + 3; v++) { const sh2 = 0.55 + 0.45 * Math.max(0, Nn.getX(v) * LDIR.x + Nn.getY(v) * LDIR.y + Nn.getZ(v) * LDIR.z), ao = 0.55 + 0.45 * Math.min(1, (Pp.getY(v) - bb.min.y) / (bb.max.y - bb.min.y + 1e-3)); a[v * 3] = a[v * 3 + 1] = a[v * 3 + 2] = k * sh2 * ao; } }
    g2.deleteAttribute('normal'); if (g2.attributes.uv) g2.deleteAttribute('uv'); g2.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g2; };
  const blobs = (list, det = 2) => leafy(mergeGeometries(list.map(([x, y, z, rr, sy = 1]) => { const ge = new THREE.IcosahedronGeometry(rr, det).scale(1, sy, 1).translate(x, y, z); ge.deleteAttribute('uv'); return ge; })));
  const cones = (list) => leafy(mergeGeometries(list.map(([y, rr, hh]) => { const ge = new THREE.ConeGeometry(rr, hh, 10, 1).translate(0, y, 0).toNonIndexed(); ge.deleteAttribute('uv'); return ge; })));
  const KINDS = [
    { g: blobs([[0, 3.0, 0, 1.5], [0.8, 3.4, 0.3, 1.05], [-0.75, 3.3, -0.35, 1.1], [0.1, 4.1, -0.1, 1.0], [-0.3, 2.6, 0.7, 0.9]]), trunk: 2.6, rad: 1.7, col: ['#4e7a40', '#5a8442', '#46703c', '#628a46'], bark: '#6a5040' },   // oak
    { g: blobs([[0, 3.6, 0, 1.15, 1.5], [0.35, 4.6, 0.2, 0.85, 1.3], [-0.3, 3.0, -0.25, 0.9, 1.2]]), trunk: 2.8, rad: 1.4, col: ['#3e6a3a', '#4a7440', '#56783e'], bark: '#5e4636' },                                  // tall lime
    { g: blobs([[0, 2.6, 0, 1.9, 0.7], [1.2, 2.8, 0.4, 1.2, 0.75], [-1.1, 2.7, -0.5, 1.3, 0.7], [0.2, 3.3, -0.3, 1.2, 0.7]]), trunk: 2.2, rad: 2.4, col: ['#6a8a44', '#7a8e4a', '#b08440', '#b0663a', '#c49a46'], bark: '#6a5040' }, // wide (autumn tones)
    { g: cones([[2.0, 1.5, 2.0], [3.15, 1.12, 1.9], [4.25, 0.74, 1.7]]), trunk: 1.6, rad: 1.5, col: ['#2e5236', '#345a3a', '#2a4a32'], bark: '#4e3a2e' },                                                         // pine
    { g: blobs([[0, 0.55, 0, 0.75, 0.8], [0.55, 0.5, 0.2, 0.55, 0.8], [-0.5, 0.48, -0.15, 0.6, 0.8]]), trunk: 0, rad: 1.0, col: ['#4a7040', '#56783e', '#3e6438', '#5e8044'], bark: '#000' },                       // bush
    { g: blobs([[0, 4.3, 0, 0.75, 1.4], [0.45, 3.7, 0.15, 0.6, 1.2], [-0.35, 4.9, -0.1, 0.55, 1.3], [0.1, 3.3, -0.35, 0.5]]), trunk: 3.6, rad: 1.1, col: ['#7a9a4a', '#8aa452', '#6e9046'], bark: '#e2ddd2' },     // birch (white bark)
    { g: blobs([[0, 2.5, 0, 1.2, 0.85], [0.75, 2.7, 0.25, 0.85, 0.85], [-0.7, 2.6, -0.3, 0.9, 0.85], [0.05, 3.2, 0.1, 0.8, 0.8]]), trunk: 1.9, rad: 1.5, col: ['#e8a8bc', '#f0b8c8', '#dc98b0'], bark: '#5a3e36' },   // cherry blossom
    { g: blobs([[0, 2.2, 0, 0.62, 2.4], [0, 3.6, 0, 0.5, 2.0]], 1), trunk: 0.7, rad: 0.9, col: ['#2e4e30', '#36583a'], bark: '#4e3a2e' },                                                                       // cypress
  ];
  const WEIGHT = [0, 0, 0, 1, 1, 2, 3, 3, 5, 5, 6, 7]; const pickKind = () => WEIGHT[Math.floor(r() * WEIGHT.length)];
  const placed = []; const ok = (x, z, rad) => bdOf(x, z) > 2.2 + rad && !nearRoad(x, z, rad * 0.6) && !onPlotPath(x, z, rad) && !inPond(x, z, rad + 1) && !inHouse(x, z, rad + 0.6) && !inDrive(x, z, rad) && !(Math.abs(bdOf(x, z) - F) < rad * 0.7) && !placed.some(([px2, pz2, pr]) => Math.hypot(px2 - x, pz2 - z) < (pr + rad) * 0.8) && bdOf(x, z) < 50;
  const treeList = [];
  const tryPut = (x, z, kind, s) => { const rad = KINDS[kind].rad * s; if (!ok(x, z, rad)) return false; placed.push([x, z, rad]); treeList.push({ x, z, kind, s, yaw: r() * 6.28, sx: 0.85 + r() * 0.3, sy: 0.82 + r() * 0.4 }); return true; };
  // plot: a few ornamental trees + bushes on the lawn corners
  for (const [x, z] of [[B.x0 - 5, B.z0 - 5], [B.x1 + 5, B.z0 - 5], [B.x1 + 5, B.z1 + 5], [B.x0 - 5.5, B.z1 + 5.5], [cxB - 7, B.z1 + 5], [cxB + 8, B.z1 + 5.5], [B.x0 - 5, czB - 7], [B.x0 - 5, czB + 7], [B.x1 + 5, czB], [cxB, B.z0 - 5]]) tryPut(x + (r() - 0.5) * 2, z + (r() - 0.5) * 2, [0, 1, 5, 6][Math.floor(r() * 4)], 0.75 + r() * 0.25);
  for (let k = 0; k < 40; k++) { const side = Math.floor(r() * 4), t = r(); const x = side < 2 ? B.x0 + t * (B.x1 - B.x0) : side === 2 ? B.x0 - 2.6 - r() * 5 : B.x1 + 2.6 + r() * 5, z = side >= 2 ? B.z0 + t * (B.z1 - B.z0) : side === 0 ? B.z0 - 2.6 - r() * 5 : B.z1 + 2.6 + r() * 5; tryPut(x, z, 4, 0.8 + r() * 0.4); }
  // street trees along the footpaths (between lamps)
  for (let a = B.z0 - 44; a < B.z1 + 44; a += 16) { tryPut(B.x0 - 10.5, a + 8, r() < 0.5 ? 1 : 5, 0.85); tryPut(B.x0 - 18.9, a + 3, pickKind(), 0.9); }
  for (let a = B.x0 - 44; a < B.x1 + 44; a += 16) { tryPut(a + 8, B.z1 + 10.5, r() < 0.5 ? 1 : 5, 0.85); tryPut(a + 3, B.z1 + 18.9, pickKind(), 0.9); }
  // park: clumps
  for (let c = 0; c < 22; c++) { const cxp = B.x1 + 10 + r() * 36, czp = B.z0 - 40 + r() * (B.z1 - B.z0 + 50), cxn = B.x0 - 6 + r() * (B.x1 - B.x0 + 40), czn = B.z0 - 10 - r() * 22; for (const [qx, qz] of [[cxp, czp], [cxn, czn]]) { const k0 = pickKind(); for (let k = 0; k < 4; k++) tryPut(qx + (r() - 0.5) * 9, qz + (r() - 0.5) * 9, r() < 0.25 ? 4 : (k0 + (r() < 0.3 ? 1 : 0)) % 4, 0.8 + r() * 0.5); } }
  // gardens across the street
  for (const h of houses) for (let k = 0; k < 3; k++) { const lx = (r() - 0.5) * (h.w + 6), lz = h.d / 2 + 1.5 + r() * 3.5; tryPut(h.x + h.rx * lx + h.fx * lz, h.z + h.rz * lx + h.fz * lz, r() < 0.45 ? 4 : pickKind(), 0.7 + r() * 0.4); }
  const trunkGeo = colored(new THREE.CylinderGeometry(0.11, 0.19, 1, 7).translate(0, 0.5, 0), C('#ffffff'));
  const withTrunk = treeList.filter(t => KINDS[t.kind].trunk > 0), trunks = new THREE.InstancedMesh(trunkGeo, patch(new THREE.MeshBasicMaterial({ vertexColors: true })), withTrunk.length);
  withTrunk.forEach((t, i) => { trunks.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(t.x, GY, t.z), new THREE.Quaternion(), new THREE.Vector3(t.s * t.sx, KINDS[t.kind].trunk * t.s * t.sy, t.s * t.sx))); trunks.setColorAt(i, C(KINDS[t.kind].bark)); }); root.add(trunks);
  KINDS.forEach((K, ki) => { const list = treeList.filter(t => t.kind === ki); if (!list.length) return; const im = new THREE.InstancedMesh(K.g, patch(new THREE.MeshBasicMaterial({ vertexColors: true })), list.length);
    list.forEach((t, i) => { im.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(t.x, GY, t.z), new THREE.Quaternion().setFromAxisAngle(Y, t.yaw), new THREE.Vector3(t.s * t.sx, t.s * t.sy, t.s * t.sx))); im.setColorAt(i, C(K.col[Math.floor(r() * K.col.length)]).multiplyScalar(0.86 + r() * 0.26)); }); root.add(im); });

  await yieldNow();
  // ---- soft shadows on the ground (no shadow maps): offset away from the moon/sun, merged into one mesh ----------------
  const shTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x2 = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')); const gr = x2.createRadialGradient(32, 32, 4, 32, 32, 32); gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x2.fillStyle = gr; x2.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  const shadowQuads = []; const SHX = -0.35, SHZ = -0.25; // shadows fall a little north-west
  const blob = (x, z, sx, sz, yaw = 0, k = 1) => { const ge = new THREE.PlaneGeometry(sx, sz).rotateX(-Math.PI / 2).rotateY(yaw).translate(x, GY + 0.02 + shadowQuads.length * 0.00002, z); const n = ge.attributes.position.count, a = new Float32Array(n * 3).fill(k); ge.setAttribute('color', new THREE.BufferAttribute(a, 3)); shadowQuads.push(ge); };
  for (const t of treeList) { const K = KINDS[t.kind], rr = K.rad * t.s * t.sx * 2.3, hgt = (K.trunk + K.rad) * t.s * t.sy; blob(t.x + SHX * hgt * 0.35, t.z + SHZ * hgt * 0.35, rr, rr * 0.85, t.yaw, t.kind === 4 ? 0.8 : 1); }
  for (const h of houses) blob(h.x + SHX * 2.4, h.z + SHZ * 2.4, h.w + 3.2, h.d + 3.2, h.yaw, 0.9);
  // (the ground shader uses vertex colour as strength)
  await yieldNow();
  // ---- lamps: street lamps on the footpaths + porch lights -----------------------------------------------------------
  const lampsAt = []; for (let a = B.z0 - 40; a < B.z1 + 44; a += 16) lampsAt.push([B.x0 - 10.4, a, -Math.PI / 2]); for (let a = B.x0 - 36; a < B.x1 + 44; a += 16) lampsAt.push([a, B.z1 + 10.4, Math.PI]);
  const lampGeo = mergeGeometries([colored(new THREE.CylinderGeometry(0.07, 0.1, 4.0, 8).translate(0, 2.0, 0), C('#2e3036')), colored(new THREE.BoxGeometry(0.08, 0.08, 1.0).translate(0, 3.95, -0.45), C('#2e3036')), colored(new THREE.CylinderGeometry(0.24, 0.32, 0.22, 10).translate(0, 3.85, -0.92), C('#2e3036'))]);
  const lamps = new THREE.InstancedMesh(lampGeo, patch(new THREE.MeshBasicMaterial({ vertexColors: true })), lampsAt.length);
  const porch = houses.map(h => [h.x + h.fx * (h.d / 2 + 0.12) + h.rx * 0.75, h.z + h.fz * (h.d / 2 + 0.12) + h.rz * 0.75, h.yaw]);
  const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshBasicMaterial({ color: C('#ffe2a8') }), lampsAt.length + porch.length);
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: radialTex(), color: C('#ffcf8a'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }), lampsAt.length + porch.length);
  lampsAt.forEach(([x, z, ry], i) => { lamps.setMatrixAt(i, mtx(ry, x, z)); const hx = x - Math.sin(ry) * 0.92, hz = z - Math.cos(ry) * 0.92; bulbs.setMatrixAt(i, mtx(0, hx, hz, GY + 3.72)); pools.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(hx, GY + 0.05, hz), new THREE.Quaternion(), new THREE.Vector3(7, 1, 7))); });
  porch.forEach(([x, z], k) => { const i = lampsAt.length + k; bulbs.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(x, GY + 2.2, z), new THREE.Quaternion(), new THREE.Vector3(0.6, 0.6, 0.6))); pools.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(x, GY + 0.06, z), new THREE.Quaternion(), new THREE.Vector3(4, 1, 4))); });
  root.add(lamps, bulbs, pools);
  for (const [x, z] of lampsAt) blob(x + SHX * 1.2, z + SHZ * 1.2, 1.0, 1.0, 0, 0.6);

  await yieldNow();
  // ---- cars: parked on driveways; traffic only on the street ---------------------------------------------------------
  const CARC = ['#d8d4cc', '#a83434', '#2e5288', '#1e1e24', '#4a6a5a', '#8a8a92', '#c8b48a', '#6a3a5a', '#e0e0e4', '#5a7aa8', '#9a4a2a', '#2a3a2a', '#b8b0a0', '#7a1e2e'];
  const parked = houses.filter(h => h.drive).map(h => { const Dr = driveRect(h), lx = Dr.cl, lz = Dr.cz + (r() - 0.5) * 0.6; return { x: h.x + h.rx * lx + h.fx * lz, z: h.z + h.rz * lx + h.fz * lz, yaw: h.yaw + (r() < 0.5 ? 0 : Math.PI), kind: Math.floor(r() * 3) /* no taxis at home */, col: CARC[Math.floor(r() * CARC.length)] }; });
  // lanes (right-hand traffic): A comes down the west street and turns east onto the south street (outer lane);
  // B is the reverse (inner lane). Both arcs share one centre, so the lanes never cross.
  const RA = 9, xa = B.x0 - LANE_OUT, za = B.z1 + LANE_OUT, ccx = xa + RA, ccz = za - RA, RB = RA - (LANE_OUT - LANE_IN), FAR = 62;
  const pathOf = (pts) => { const seg = []; let L = 0; for (let i = 1; i < pts.length; i++) { const [x0, z0] = pts[i - 1], [x1, z1] = pts[i], l = Math.hypot(x1 - x0, z1 - z0); seg.push({ x0, z0, x1, z1, l, s: L, yaw: Math.atan2(x1 - x0, z1 - z0) }); L += l; }
    return { L, segs: seg, at(s) { let k = 0; while (k < seg.length - 1 && s > seg[k].s + seg[k].l) k++; const q = seg[k], t = Math.max(0, Math.min(1, (s - q.s) / q.l)); return [q.x0 + (q.x1 - q.x0) * t, q.z0 + (q.z1 - q.z0) * t, q.yaw]; } }; };
  const arc = (R, a0, a1, n = 14) => Array.from({ length: n + 1 }, (_, k) => { const a = a0 + (a1 - a0) * k / n; return [ccx + Math.cos(a) * R, ccz + Math.sin(a) * R]; });
  const laneA = pathOf([[xa, B.z0 - FAR], ...arc(RA, Math.PI, Math.PI / 2), [B.x1 + FAR, za]]);
  const laneB = pathOf([[B.x1 + FAR, B.z1 + LANE_IN], ...arc(RB, Math.PI / 2, Math.PI), [B.x0 - LANE_IN, B.z0 - FAR]]);
  const lanes = [laneA, laneB]; const cornerS = lanes.map(ln => { const k0 = 1, k1 = ln.segs.length - 2; return [ln.segs[k0].s - 6, ln.segs[k1].s + ln.segs[k1].l + 2]; });
  const POOL = 4, MAXCARS = 6;
  const kindsUsed = CAR_KINDS.map((k, ki) => { const cg = carGeometry(k); const n = parked.filter(p2 => p2.kind === ki).length + POOL; const cgm = carGeometry(k, { bakedWheels: false });
    const np = parked.filter(p2 => p2.kind === ki).length; const pm = new THREE.InstancedMesh(cg.paint, patch(new THREE.MeshBasicMaterial({ vertexColors: true })), n), fm = new THREE.InstancedMesh(cg.fixed, patch(new THREE.MeshBasicMaterial({ vertexColors: true })), Math.max(1, np)), fmm = new THREE.InstancedMesh(cgm.fixed, patch(new THREE.MeshBasicMaterial({ vertexColors: true })), POOL);
    fmm.frustumCulled = false; root.add(fmm); for (let q2 = 0; q2 < POOL; q2++) fmm.setMatrixAt(q2, new THREE.Matrix4().makeScale(0, 0, 0));
    pm.frustumCulled = fm.frustumCulled = false; root.add(pm, fm); return { pm, fm, fmm, np, next: 0, free: /** @type {number[]} */ ([]) }; });
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0), M4 = new THREE.Matrix4(), V = new THREE.Vector3();
  // wheels for the moving cars: 4 per car, spun by distance travelled (s / r), fronts steered by the yaw rate
  const wheelM = new THREE.InstancedMesh(wheelGeometry(), patch(new THREE.MeshBasicMaterial({ vertexColors: true })), MAXCARS * 4); wheelM.frustumCulled = false; root.add(wheelM);
  const carShadow = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.5, 5.2).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false, opacity: 0.55, color: C('#000000') }), MAXCARS); carShadow.frustumCulled = false; root.add(carShadow);
  for (let k = 0; k < MAXCARS * 4; k++) wheelM.setMatrixAt(k, HIDE); for (let k = 0; k < MAXCARS; k++) carShadow.setMatrixAt(k, HIDE);
  const CW = Object.fromEntries(CAR_KINDS.map(k => [k, carGeometry(k, { bakedWheels: false }).wheels]));
  const _qy = new THREE.Quaternion(), _qw = new THREE.Quaternion(), _qa = new THREE.Quaternion(), _m2 = new THREE.Matrix4(), _v2 = new THREE.Vector3(), _eu = new THREE.Euler(), XA = new THREE.Vector3(1, 0, 0);
  const setCar = (K, idx, x, z, yaw) => { M4.compose(V.set(x, GY, z), Q.setFromAxisAngle(Y, yaw), ONE); K.pm.setMatrixAt(idx, M4); if (idx < K.np) K.fm.setMatrixAt(idx, M4); else K.fmm.setMatrixAt(idx - K.np, M4); };
  parked.forEach(p2 => { const K = kindsUsed[p2.kind], idx = K.next++; setCar(K, idx, p2.x, p2.z, p2.yaw); K.pm.setColorAt(idx, C(p2.col)); blob(p2.x + SHX * 0.4, p2.z + SHZ * 0.4, 2.5, 5.2, p2.yaw, 0.95); });
  { const sm = new THREE.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false, vertexColors: true, color: C('#ffffff'), blending: THREE.MultiplyBlending, premultipliedAlpha: true });
    // multiply: dst * (1 - a*k) via a custom blend so it darkens whatever ground is under it
    sm.blending = THREE.CustomBlending; sm.blendEquation = THREE.AddEquation; sm.blendSrc = THREE.ZeroFactor; sm.blendDst = THREE.OneMinusSrcAlphaFactor;
    sm.onBeforeCompile = sh2 => { sh2.fragmentShader = sh2.fragmentShader.replace('#include <opaque_fragment>', 'diffuseColor.a *= vColor.r * 0.7;\n#include <opaque_fragment>'); };
    const shM = new THREE.Mesh(mergeGeometries(shadowQuads), sm); shM.renderOrder = 0.5; root.add(shM); }
  for (const K of kindsUsed) { for (let k = 0; k < POOL; k++) { const idx = K.next++; K.free.push(idx); K.pm.setMatrixAt(idx, HIDE); K.pm.setColorAt(idx, C('#ffffff')); } }
  const beams = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.2, 6).rotateX(-Math.PI / 2).translate(0, 0.05, 5.0), new THREE.MeshBasicMaterial({ map: radialTex(), color: C('#fff0c8'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }), MAXCARS);
  for (let k = 0; k < MAXCARS; k++) beams.setMatrixAt(k, HIDE); beams.frustumCulled = false; root.add(beams);
  const movers = []; let spawnT = 0.3;
  const spawn = () => { const li = r() < 0.5 ? 0 : 1; if (movers.some(m => m.li === li && m.s < 16)) return; const kind = r() < 0.12 ? 3 : Math.floor(r() * 3), K = kindsUsed[kind]; if (!K.free.length) return;
    const idx = K.free.pop(); K.pm.setColorAt(idx, C(kind === 3 ? '#f2c230' : CARC[Math.floor(r() * CARC.length)])); K.pm.instanceColor.needsUpdate = true;
    movers.push({ li, lane: lanes[li], s: 0, v: 4 + r() * 2, vMax: 5 + r() * 3.5, yaw: lanes[li].segs[0].yaw, kind, idx }); };
  for (let k = 0; k < 3; k++) { spawn(); if (movers[k]) movers[k].s = 20 + r() * (lanes[movers[k].li].L - 40); }
  const traffic = {
    update(dt, L, w) {
      if ((spawnT -= dt) < 0) { spawnT = 2 + r() * 7 + (r() < 0.2 ? 8 : 0); if (movers.length < MAXCARS) spawn(); }
      for (const m of movers) { let gap = 1e9; for (const o of movers) if (o !== m && o.li === m.li && o.s > m.s) gap = Math.min(gap, o.s - m.s);
        const [c0, c1] = cornerS[m.li], corner = m.s > c0 && m.s < c1; const target = Math.min(corner ? 3.2 : m.vMax, gap < 6.5 ? 0 : gap < 13 ? m.vMax * (gap - 6.5) / 6.5 : 1e9);
        m.v += (target - m.v) * Math.min(1, dt * (target < m.v ? 3.5 : 0.7)); m.s += Math.max(0, m.v) * dt; }
      for (let k = movers.length - 1; k >= 0; k--) { const m = movers[k]; if (m.s < m.lane.L) continue; const K = kindsUsed[m.kind]; K.pm.setMatrixAt(m.idx, HIDE); K.fmm.setMatrixAt(m.idx - K.np, HIDE); K.free.push(m.idx); movers.splice(k, 1); }
      for (let k = 0; k < MAXCARS; k++) { const m = movers[k]; if (!m) { beams.setMatrixAt(k, HIDE); carShadow.setMatrixAt(k, HIDE); for (let w4 = 0; w4 < 4; w4++) wheelM.setMatrixAt(k * 4 + w4, HIDE); continue; }
        const [x, z, yaw] = m.lane.at(m.s); let dy = yaw - m.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); const turn = dy * Math.min(1, dt * 5); m.yaw += turn;
        const yawRate = turn / Math.max(dt, 1e-3); m.steer = (m.steer || 0) + (Math.max(-0.5, Math.min(0.5, yawRate * 0.9)) - (m.steer || 0)) * Math.min(1, dt * 6);
        const acc = (m.v - (m.pv ?? m.v)) / Math.max(dt, 1e-3); m.pv = m.v; m.pitch = (m.pitch || 0) + (Math.max(-0.03, Math.min(0.03, -acc * 0.012)) - (m.pitch || 0)) * Math.min(1, dt * 4);
        m.roll = (m.roll || 0) + (Math.max(-0.04, Math.min(0.04, -yawRate * m.v * 0.006)) - (m.roll || 0)) * Math.min(1, dt * 4);
        // body: yaw + small lean (roll in turns, pitch when braking / pulling away), riding 1 cm higher than the wheels' contact
        const qb = Q.setFromEuler(_eu.set(m.pitch, m.yaw, m.roll, 'YXZ')); M4.compose(V.set(x, GY + 0.01, z), qb, ONE); const K = kindsUsed[m.kind]; K.pm.setMatrixAt(m.idx, M4); K.fmm.setMatrixAt(m.idx - K.np, M4); beams.setMatrixAt(k, M4);
        _qy.setFromAxisAngle(Y, m.yaw); _m2.compose(_v2.set(x + SHX * 0.4, GY + 0.025, z + SHZ * 0.4), _qy, ONE); carShadow.setMatrixAt(k, _m2);
        m.spin = ((m.spin || 0) + m.v * dt / 0.33) % (Math.PI * 2);
        const wl = CW[CAR_KINDS[m.kind]]; for (let w4 = 0; w4 < 4; w4++) { const wx = wl[w4][0], wy = wl[w4][1], wz = wl[w4][2], front = wz > 0, mirror = wx < 0;
          _qw.copy(_qy).multiply(_qa.setFromAxisAngle(Y, (front ? m.steer : 0) + (mirror ? Math.PI : 0))).multiply(_qa.setFromAxisAngle(XA, mirror ? -m.spin : m.spin));
          _v2.set(wx, wy, wz).applyQuaternion(_qy); _v2.x += x; _v2.y += GY; _v2.z += z; _m2.compose(_v2, _qw, ONE); wheelM.setMatrixAt(k * 4 + w4, _m2); } }
      wheelM.instanceMatrix.needsUpdate = true; carShadow.instanceMatrix.needsUpdate = true;
      for (const K of kindsUsed) { K.pm.instanceMatrix.needsUpdate = true; K.fmm.instanceMatrix.needsUpdate = true; } beams.instanceMatrix.needsUpdate = true;
      beams.material.opacity = Math.max(L.lamp, w.rain * 0.6) * 0.45; beams.material.visible = beams.material.opacity > 0.01 && movers.length > 0;
    },
    debug: () => ({ moving: movers.map(m => { const [x, z] = m.lane.at(m.s); return { x, z, li: m.li, v: m.v }; }), parked: parked.map(p2 => ({ x: p2.x, z: p2.z })) }),
  };
  return { glowM, pools, bulbs, traffic };
}
