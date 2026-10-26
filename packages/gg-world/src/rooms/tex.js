// @ts-check
// Procedural canvas textures for the cozy rooms: night window views, posters, rugs, walls, floors, screens.
// Everything is drawn once at build time and cached by key. All return sRGB CanvasTextures.
import * as THREE from 'three';

const cache = new Map();
/** @param {string} key @param {number} w @param {number} h @param {(x:CanvasRenderingContext2D,w:number,h:number)=>void} draw */
export function canvasTex(key, w, h, draw, o = {}) {
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')); draw(x, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (o.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (o.nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; } // mipmaps: no shimmer when small
  cache.set(key, t); return t;
}
export function rand(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const FONT = 'm5x7'; // the body pixel font (owner: in-room text in m5x7)
const DISPLAY = 'm5x7';

/** subtle grain over any canvas */
function grain(x, w, h, a = 0.06, seed = 3) { const r = rand(seed); for (let i = 0; i < w * h / 18; i++) { x.fillStyle = r() < 0.5 ? `rgba(0,0,0,${a * r()})` : `rgba(255,255,255,${a * r()})`; x.fillRect(r() * w, r() * h, 1 + r() * 1.5, 1 + r() * 1.5); } }

// ---------- walls & floors ----------
/** Painted plaster wall with soft mottling. */
export function plaster(base, seed = 1) {
  return canvasTex('plaster' + base + seed, 256, 256, (x, w, h) => {
    x.fillStyle = base; x.fillRect(0, 0, w, h); const r = rand(seed);
    for (let i = 0; i < 70; i++) { const g = x.createRadialGradient(r() * w, r() * h, 0, r() * w, r() * h, 20 + r() * 50); const a = 0.035 * r(); g.addColorStop(0, r() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); }
    grain(x, w, h, 0.05, seed);
  }, { repeat: true });
}
/** Vertical stripes wallpaper. */
export function stripes(a, b, seed = 2) {
  return canvasTex('stripes' + a + b, 256, 256, (x, w, h) => { x.fillStyle = a; x.fillRect(0, 0, w, h); x.fillStyle = b; for (let i = 0; i < 8; i++) x.fillRect(i * 32 + 4, 0, 10, h); grain(x, w, h, 0.05, seed); }, { repeat: true });
}
/** Small repeating motif wallpaper (dots / diamonds / stars). */
export function motif(bg, fg, kind = 'dots') {
  return canvasTex('motif' + bg + fg + kind, 256, 256, (x, w, h) => {
    x.fillStyle = bg; x.fillRect(0, 0, w, h); x.fillStyle = fg;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const cx = i * 32 + (j % 2) * 16 + 8, cy = j * 32 + 8;
      if (kind === 'dots') { x.beginPath(); x.arc(cx, cy, 3, 0, 7); x.fill(); }
      else if (kind === 'diamond') { x.beginPath(); x.moveTo(cx, cy - 6); x.lineTo(cx + 4, cy); x.lineTo(cx, cy + 6); x.lineTo(cx - 4, cy); x.fill(); }
      else { x.font = '18px m5x7'; x.fillText('✦', cx - 5, cy + 5); } }
    grain(x, w, h, 0.04, 9);
  }, { repeat: true });
}
/** Wood planks floor. */
export function planks(a, b, seed = 4) {
  return canvasTex('planks' + a + b + seed, 512, 512, (x, w, h) => {
    const r = rand(seed); const rows = 8, rh = h / rows;
    for (let j = 0; j < rows; j++) { let px = -r() * 200; while (px < w) { const len = 140 + r() * 220; const c = new THREE.Color(a).lerp(new THREE.Color(b), r()); x.fillStyle = '#' + c.getHexString(); x.fillRect(px, j * rh, len, rh);
      x.strokeStyle = 'rgba(0,0,0,0.05)'; for (let k = 0; k < 5; k++) { x.beginPath(); const yy = j * rh + r() * rh; x.moveTo(px, yy); x.bezierCurveTo(px + len * 0.3, yy + (r() - 0.5) * 6, px + len * 0.6, yy + (r() - 0.5) * 6, px + len, yy); x.stroke(); }
      x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(px, j * rh, 2, rh); px += len; }
      x.fillStyle = 'rgba(0,0,0,0.4)'; x.fillRect(0, j * rh, w, 2); }
    grain(x, w, h, 0.06, seed);
  }, { repeat: true });
}
/** Carpet: soft noise. */
export function carpet(a, b, seed = 5) {
  return canvasTex('carpet' + a + b, 256, 256, (x, w, h) => { x.fillStyle = a; x.fillRect(0, 0, w, h); const r = rand(seed); for (let i = 0; i < 9000; i++) { x.fillStyle = r() < 0.5 ? b : 'rgba(0,0,0,0.08)'; x.globalAlpha = 0.25; x.fillRect(r() * w, r() * h, 1.5, 1.5); } x.globalAlpha = 1; }, { repeat: true });
}
/** Checker tiles. */
export function tiles(a, b, n = 8) {
  return canvasTex('tiles' + a + b + n, 256, 256, (x, w, h) => { const s = w / n; for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { x.fillStyle = (i + j) % 2 ? a : b; x.fillRect(i * s, j * s, s, s); } x.strokeStyle = 'rgba(0,0,0,0.18)'; for (let i = 0; i <= n; i++) { x.beginPath(); x.moveTo(i * s, 0); x.lineTo(i * s, h); x.moveTo(0, i * s); x.lineTo(w, i * s); x.stroke(); } grain(x, w, h, 0.05, 2); }, { repeat: true });
}
/** Brick wall. */
export function brick(a = '#7a3e34', mortar = '#3a2622', seed = 6) {
  return canvasTex('brick' + a + seed, 256, 256, (x, w, h) => { x.fillStyle = mortar; x.fillRect(0, 0, w, h); const r = rand(seed); const bh = 16, bw = 42;
    for (let j = 0; j < h / bh; j++) for (let i = -1; i < w / bw + 1; i++) { const c = new THREE.Color(a).multiplyScalar(0.8 + r() * 0.35); x.fillStyle = '#' + c.getHexString(); x.fillRect(i * bw + (j % 2) * bw / 2 + 2, j * bh + 2, bw - 4, bh - 4); }
    grain(x, w, h, 0.08, seed); }, { repeat: true });
}
/** Wood panelling (wainscot). */
export function panels(a, b) {
  return canvasTex('panels' + a + b, 256, 256, (x, w, h) => { x.fillStyle = a; x.fillRect(0, 0, w, h); for (let i = 0; i < 4; i++) { x.fillStyle = b; x.fillRect(i * 64 + 8, 16, 48, h - 32); x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(i * 64 + 8, 16, 48, 3); x.fillRect(i * 64 + 8, 16, 3, h - 32); } grain(x, w, h, 0.05, 4); }, { repeat: true });
}

// ---------- rugs ----------
/** @param {'stripes'|'persian'|'round'|'checker'|'shag'} kind */
export function rug(kind, a, b, c = '#f5e6c8', seed = 7) {
  return canvasTex('rug' + kind + a + b + c, 512, 512, (x, w, h) => {
    const r = rand(seed);
    if (kind === 'round') { for (let i = 9; i > 0; i--) { x.fillStyle = [a, b, c][i % 3]; x.beginPath(); x.arc(w / 2, h / 2, i * 27, 0, 7); x.fill(); } }
    else if (kind === 'stripes') { x.fillStyle = a; x.fillRect(0, 0, w, h); const cols = [b, c, b, a]; for (let i = 0; i < 12; i++) { x.fillStyle = cols[i % 4]; x.fillRect(0, 30 + i * 38, w, 14 + (i % 3) * 6); } }
    else if (kind === 'checker') { const s = w / 8; for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { x.fillStyle = (i + j) % 2 ? a : b; x.fillRect(i * s, j * s, s, s); } }
    else if (kind === 'shag') { x.fillStyle = a; x.fillRect(0, 0, w, h); for (let i = 0; i < 20000; i++) { x.fillStyle = r() < 0.5 ? b : 'rgba(0,0,0,0.12)'; x.globalAlpha = 0.3; x.fillRect(r() * w, r() * h, 2, 3); } x.globalAlpha = 1; }
    else { x.fillStyle = a; x.fillRect(0, 0, w, h); x.strokeStyle = c; x.lineWidth = 10; x.strokeRect(24, 24, w - 48, h - 48); x.lineWidth = 4; x.strokeStyle = b; x.strokeRect(46, 46, w - 92, h - 92);
      x.save(); x.translate(w / 2, h / 2); for (let i = 0; i < 8; i++) { x.rotate(Math.PI / 4); x.fillStyle = i % 2 ? b : c; x.beginPath(); x.ellipse(0, 70, 26, 70, 0, 0, 7); x.fill(); } x.fillStyle = a; x.beginPath(); x.arc(0, 0, 30, 0, 7); x.fill(); x.fillStyle = c; x.beginPath(); x.arc(0, 0, 14, 0, 7); x.fill(); x.restore();
      for (let i = 0; i < 4; i++) { x.save(); x.translate(i % 2 ? w - 90 : 90, i < 2 ? 90 : h - 90); x.fillStyle = b; x.beginPath(); x.moveTo(0, -26); x.lineTo(26, 0); x.lineTo(0, 26); x.lineTo(-26, 0); x.fill(); x.restore(); } }
    if (kind !== 'round') { x.fillStyle = c; for (let i = 0; i < w; i += 10) { x.fillRect(i, 0, 3, 10); x.fillRect(i, h - 10, 3, 10); } }
    grain(x, w, h, 0.1, seed);
  });
}

// ---------- window views ----------
/** Night view through a window: gradient sky, stars, moon, skyline with lit windows. */
export function nightView(o = {}) {
  const sky = o.sky || ['#0b1030', '#1d2a6b', '#3b4a9a'], moon = o.moon !== false, seed = o.seed || 11;
  return canvasTex('night' + sky.join() + moon + seed + (o.city ?? 1), 256, 256, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, sky[0]); g.addColorStop(0.6, sky[1]); g.addColorStop(1, sky[2]); x.fillStyle = g; x.fillRect(0, 0, w, h);
    const r = rand(seed); for (let i = 0; i < 70; i++) { x.fillStyle = `rgba(255,255,255,${0.3 + r() * 0.7})`; x.fillRect(r() * w, r() * h * 0.6, r() < 0.15 ? 2 : 1, r() < 0.15 ? 2 : 1); }
    if (moon) { const mx = w * (0.62 + r() * 0.15), my = h * 0.28; const gl = x.createRadialGradient(mx, my, 6, mx, my, 70); gl.addColorStop(0, 'rgba(220,230,255,0.6)'); gl.addColorStop(1, 'rgba(220,230,255,0)'); x.fillStyle = gl; x.fillRect(0, 0, w, h); x.fillStyle = '#f4f1e6'; x.beginPath(); x.arc(mx, my, 20, 0, 7); x.fill(); x.fillStyle = 'rgba(180,180,200,0.35)'; x.beginPath(); x.arc(mx - 6, my - 4, 5, 0, 7); x.arc(mx + 7, my + 6, 3, 0, 7); x.fill(); }
    if (o.city ?? 1) { let px = 0; while (px < w) { const bw = 18 + r() * 34, bh = h * (0.18 + r() * 0.35); x.fillStyle = '#0a0d24'; x.fillRect(px, h - bh, bw, bh); for (let yy = h - bh + 6; yy < h - 4; yy += 8) for (let xx = px + 4; xx < px + bw - 4; xx += 7) if (r() < 0.32) { x.fillStyle = r() < 0.8 ? '#ffd27a' : '#9fd8ff'; x.fillRect(xx, yy, 3, 4); } px += bw + 2; } }
    if (o.trees) { x.fillStyle = '#060818'; for (let i = 0; i < 12; i++) { x.beginPath(); x.arc(r() * w, h, 20 + r() * 30, Math.PI, 0); x.fill(); } }
  });
}
/** Transparent rain-streak texture for an overlay plane (scroll its offset.y). */
export function rainTex() {
  return canvasTex('rain', 128, 256, (x, w, h) => { const r = rand(4); x.strokeStyle = 'rgba(200,220,255,0.55)'; for (let i = 0; i < 60; i++) { const xx = r() * w, yy = r() * h, l = 8 + r() * 18; x.lineWidth = r() < 0.3 ? 1.5 : 1; x.beginPath(); x.moveTo(xx, yy); x.lineTo(xx - 2, yy + l); x.stroke(); } x.fillStyle = 'rgba(210,230,255,0.5)'; for (let i = 0; i < 25; i++) { x.beginPath(); x.arc(r() * w, r() * h, 1.2 + r() * 1.5, 0, 7); x.fill(); } }, { repeat: true });
}
/** Soft vertical gradient used for light beams (additive). */
export function beamTex() {
  return canvasTex('beam', 64, 256, (x, w, h) => { const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); const g2 = x.createLinearGradient(0, 0, w, 0); g2.addColorStop(0, 'rgba(0,0,0,1)'); g2.addColorStop(0.2, 'rgba(0,0,0,0)'); g2.addColorStop(0.8, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,1)'); x.globalCompositeOperation = 'destination-out'; x.fillStyle = g2; x.fillRect(0, 0, w, h); });
}
/** Round soft dot for particles / glows. */
export function dotTex() {
  return canvasTex('dot', 64, 64, (x, w, h) => { const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.5)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, w, h); });
}

// ---------- posters ----------
const POSTERS = {
  maze: ['SUPER MAZE', '#2a1b5e', '#ff9f1c', (x, w, h, r) => { x.strokeStyle = '#7b6cff'; x.lineWidth = 6; for (let i = 0; i < 6; i++) { x.beginPath(); x.moveTo(20 + r() * (w - 40), h * 0.45 + r() * h * 0.45); x.lineTo(20 + r() * (w - 40), h * 0.45 + r() * h * 0.45); x.stroke(); } x.fillStyle = '#ffb627'; x.beginPath(); x.moveTo(w / 2, h * 0.66); x.arc(w / 2, h * 0.66, w * 0.22, 0.6, Math.PI * 2 - 0.6); x.fill(); x.fillStyle = '#fff'; for (let i = 0; i < 4; i++) { x.beginPath(); x.arc(w * 0.78 + i * 0, h * 0.66, 0, 0, 7); } for (let i = 0; i < 3; i++) { x.beginPath(); x.arc(w * 0.82, h * (0.58 + i * 0.08), 5, 0, 7); x.fill(); } }],
  space: ['SPACE ADVENTURE', '#1b1f5e', '#ffd1e8', (x, w, h, r) => { const g = x.createLinearGradient(0, h * 0.4, 0, h); g.addColorStop(0, '#2a2f8f'); g.addColorStop(1, '#ff6f91'); x.fillStyle = g; x.fillRect(0, h * 0.35, w, h * 0.65); for (let i = 0; i < 40; i++) { x.fillStyle = '#fff'; x.fillRect(r() * w, h * 0.3 + r() * h * 0.4, 2, 2); } x.fillStyle = '#c86bfa'; x.beginPath(); x.arc(w * 0.28, h * 0.5, 22, 0, 7); x.fill(); x.save(); x.translate(w * 0.62, h * 0.66); x.rotate(-0.5); x.fillStyle = '#ffe0f0'; x.beginPath(); x.ellipse(0, 0, 16, 46, 0, 0, 7); x.fill(); x.fillStyle = '#ff4f79'; x.beginPath(); x.moveTo(-16, 20); x.lineTo(-30, 46); x.lineTo(-8, 34); x.fill(); x.beginPath(); x.moveTo(16, 20); x.lineTo(30, 46); x.lineTo(8, 34); x.fill(); x.fillStyle = '#7bdff2'; x.beginPath(); x.arc(0, -12, 8, 0, 7); x.fill(); x.fillStyle = '#ffb627'; x.beginPath(); x.moveTo(-8, 44); x.lineTo(0, 74); x.lineTo(8, 44); x.fill(); x.restore(); x.fillStyle = '#3d1e6d'; x.beginPath(); x.moveTo(0, h); x.lineTo(w * 0.3, h * 0.78); x.lineTo(w * 0.55, h); x.moveTo(w * 0.4, h); x.lineTo(w * 0.75, h * 0.74); x.lineTo(w, h); x.fill(); }],
  dragon: ['FANTASY QUEST', '#5e1b3a', '#ffcf70', (x, w, h, r) => { const g = x.createLinearGradient(0, h * 0.3, 0, h); g.addColorStop(0, '#b8336a'); g.addColorStop(1, '#ff8c42'); x.fillStyle = g; x.fillRect(0, h * 0.3, w, h * 0.7); x.fillStyle = '#ff5a36'; x.save(); x.translate(w / 2, h * 0.64); x.beginPath(); x.ellipse(0, 0, 34, 22, -0.3, 0, 7); x.fill(); x.beginPath(); x.moveTo(-10, -10); x.lineTo(-70, -60); x.lineTo(-30, -2); x.fill(); x.beginPath(); x.moveTo(10, -14); x.lineTo(60, -70); x.lineTo(34, -4); x.fill(); x.beginPath(); x.moveTo(28, -12); x.quadraticCurveTo(52, -40, 46, -46); x.lineTo(62, -40); x.lineTo(44, -24); x.fill(); x.beginPath(); x.moveTo(-30, 8); x.quadraticCurveTo(-70, 30, -60, 46); x.lineTo(-40, 20); x.fill(); x.restore(); }],
  band: ['THE NULL POINTERS', '#16161d', '#e8e8e8', (x, w, h, r) => { x.fillStyle = '#2b2d42'; x.fillRect(0, h * 0.25, w, h * 0.6); for (let i = 0; i < 4; i++) { const cx = w * (0.2 + i * 0.2), cy = h * 0.5; x.fillStyle = '#0d0d12'; x.beginPath(); x.arc(cx, cy - 22, 11, 0, 7); x.fill(); x.fillRect(cx - 14, cy - 10, 28, 52); } x.fillStyle = '#ef476f'; x.fillRect(0, h * 0.82, w, 4); }],
  movie: ['NIGHT DRIVE', '#0d1b2a', '#ff5d8f', (x, w, h, r) => { const g = x.createLinearGradient(0, h * 0.25, 0, h * 0.7); g.addColorStop(0, '#ff5d8f'); g.addColorStop(1, '#ffb347'); x.fillStyle = g; x.beginPath(); x.arc(w / 2, h * 0.58, w * 0.3, Math.PI, 0); x.fill(); x.fillStyle = '#0d1b2a'; for (let i = 0; i < 6; i++) x.fillRect(w * 0.18, h * 0.42 + i * 12, w * 0.64, 4); x.strokeStyle = '#00f5d4'; x.lineWidth = 2; for (let i = 0; i < 8; i++) { x.beginPath(); x.moveTo(w / 2, h * 0.6); x.lineTo(i * w / 7, h); x.stroke(); } x.beginPath(); x.moveTo(0, h * 0.6); x.lineTo(w, h * 0.6); x.stroke(); }],
  retro: ['PIXEL KNIGHTS', '#2b2d42', '#80ed99', (x, w, h, r) => { const s = 10; const art = ['..XXXX..', '.XXXXXX.', 'XX.XX.XX', 'XXXXXXXX', '.X.XX.X.', 'X......X']; x.fillStyle = '#80ed99'; art.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === 'X') x.fillRect(w / 2 - 40 + i * s, h * 0.4 + j * s, s, s); })); x.fillStyle = '#ffd166'; for (let i = 0; i < 12; i++) x.fillRect(r() * w, h * 0.75 + r() * h * 0.15, 6, 6); }],
  plants: ['GROW SLOW', '#e9edc9', '#3a5a40', (x, w, h, r) => { x.strokeStyle = '#3a5a40'; x.lineWidth = 4; x.beginPath(); x.moveTo(w / 2, h * 0.85); x.lineTo(w / 2, h * 0.35); x.stroke(); x.fillStyle = '#588157'; for (let i = 0; i < 6; i++) { x.save(); x.translate(w / 2, h * (0.4 + i * 0.07)); x.rotate((i % 2 ? 1 : -1) * 0.9); x.beginPath(); x.ellipse(18, 0, 22, 9, 0, 0, 7); x.fill(); x.restore(); } x.fillStyle = '#bc6c25'; x.fillRect(w * 0.38, h * 0.82, w * 0.24, h * 0.1); }],
  ship: ['SHIP IT', '#ffd166', '#1d3557', (x, w, h, r) => { x.fillStyle = '#e63946'; x.beginPath(); x.moveTo(w * 0.2, h * 0.6); x.lineTo(w * 0.8, h * 0.6); x.lineTo(w * 0.68, h * 0.75); x.lineTo(w * 0.32, h * 0.75); x.fill(); x.fillStyle = '#1d3557'; x.fillRect(w * 0.49, h * 0.3, 4, h * 0.3); x.fillStyle = '#f1faee'; x.beginPath(); x.moveTo(w * 0.51, h * 0.32); x.lineTo(w * 0.75, h * 0.55); x.lineTo(w * 0.51, h * 0.55); x.fill(); x.fillStyle = '#457b9d'; for (let i = 0; i < 4; i++) x.fillRect(0, h * (0.78 + i * 0.04), w, 3); }],
  cat: ['HANG IN THERE', '#a8dadc', '#1d3557', (x, w, h, r) => { x.strokeStyle = '#6d4c41'; x.lineWidth = 4; x.beginPath(); x.moveTo(0, h * 0.3); x.quadraticCurveTo(w / 2, h * 0.4, w, h * 0.28); x.stroke(); x.fillStyle = '#f4a261'; x.beginPath(); x.ellipse(w / 2, h * 0.58, 20, 30, 0, 0, 7); x.fill(); x.beginPath(); x.arc(w / 2, h * 0.47, 16, 0, 7); x.fill(); x.fillRect(w / 2 - 14, h * 0.36, 6, 12); x.fillRect(w / 2 + 8, h * 0.36, 6, 12); x.fillStyle = '#264653'; x.fillRect(w / 2 - 7, h * 0.46, 3, 3); x.fillRect(w / 2 + 4, h * 0.46, 3, 3); }],
  wave: ['RIDE THE WAVE', '#f1faee', '#264653', (x, w, h, r) => { x.fillStyle = '#e76f51'; x.beginPath(); x.arc(w * 0.7, h * 0.42, 22, 0, 7); x.fill(); x.fillStyle = '#2a9d8f'; x.beginPath(); x.moveTo(0, h * 0.85); for (let i = 0; i <= 20; i++) x.lineTo(i * w / 20, h * 0.62 + Math.sin(i * 0.9) * 18 - i * 2); x.lineTo(w, h * 0.85); x.fill(); x.fillStyle = '#264653'; x.fillRect(0, h * 0.82, w, h * 0.1); }],
};
export const POSTER_KINDS = Object.keys(POSTERS);
/** A poster texture (aspect 2:3). */
export function poster(kind, title) {
  const P = POSTERS[kind] || POSTERS.ship;
  return canvasTex('poster' + kind + (title || ''), 200, 300, (x, w, h) => {
    const r = rand(kind.length * 31); x.fillStyle = P[1]; x.fillRect(0, 0, w, h); P[3](x, w, h, r);
    x.fillStyle = P[2]; x.textAlign = 'center'; const t = title || P[0]; const words = t.split(' ');
    let size = 52; x.font = `${size}px ${DISPLAY}`; while (words.some(wd => x.measureText(wd).width > w - 24) && size > 20) { size -= 2; x.font = `${size}px ${DISPLAY}`; }
    words.forEach((wd, i) => x.fillText(wd, w / 2, 16 + size * (i + 1)));
    x.strokeStyle = 'rgba(255,255,255,0.15)'; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6);
    grain(x, w, h, 0.08, kind.length);
  });
}

// ---------- screens ----------
/** Platformer game screen (like the reference CRTs). Several frames for gentle scrolling. */
export function gameScreen(frame = 0) {
  return canvasTex('game' + frame, 160, 120, (x, w, h) => {
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#5ec8ff'); g.addColorStop(1, '#a6e4ff'); x.fillStyle = g; x.fillRect(0, 0, w, h);
    const off = frame * 6;
    x.fillStyle = '#fff'; for (const [cx, cy] of [[30, 20], [100, 14], [150, 26]]) { const xx = ((cx - off * 0.5) % (w + 40) + w + 40) % (w + 40) - 20; x.fillRect(xx, cy, 22, 6); x.fillRect(xx + 4, cy - 4, 14, 4); }
    x.fillStyle = '#3fa34d'; for (let i = -1; i < 4; i++) { const cx = i * 60 - off % 60 + 30; x.beginPath(); x.arc(cx, h * 0.78, 34, Math.PI, 0); x.fill(); }
    x.fillStyle = '#c86b2e'; x.fillRect(0, h * 0.8, w, h * 0.2); x.fillStyle = '#8a4b1f'; for (let i = 0; i < w; i += 10) x.fillRect(i - off % 10, h * 0.8, 9, 3);
    x.fillStyle = '#d9822b'; for (let i = 0; i < 4; i++) { const xx = 50 + i * 12 - off % 200; x.fillRect(xx, h * 0.45, 11, 11); x.fillStyle = '#ffd166'; x.fillRect(xx + 4, h * 0.45 + 3, 3, 5); x.fillStyle = '#d9822b'; }
    x.fillStyle = '#2ecc71'; x.fillRect(120 - off % 160, h * 0.62, 14, h * 0.18); x.fillStyle = '#27ae60'; x.fillRect(118 - off % 160, h * 0.6, 18, 6);
    x.fillStyle = '#e63946'; x.fillRect(40, h * 0.66, 8, 10); x.fillStyle = '#f4a261'; x.fillRect(41, h * 0.62, 6, 5);
    for (let y = 0; y < h; y += 2) { x.fillStyle = 'rgba(0,0,0,0.12)'; x.fillRect(0, y, w, 1); }
  }, { nearest: true });
}
/** Terminal / DOS screen. */
export function termScreen(seed = 1, color = '#7CFC9A') {
  return canvasTex('term' + seed + color, 160, 120, (x, w, h) => {
    x.fillStyle = '#071a10'; x.fillRect(0, 0, w, h); x.fillStyle = color; x.font = '12px m5x7'; const r = rand(seed);
    const lines = ['C:\\> run build', 'compiling...', '[ok] 214 tests', 'deploy --prod', '> it works!', 'C:\\> _'];
    for (let i = 0; i < 12; i++) { if (i < lines.length) x.fillText(lines[i], 6, 12 + i * 9); else { x.fillRect(6, 4 + i * 9, 20 + r() * 100, 3); } }
    for (let y = 0; y < h; y += 2) { x.fillStyle = 'rgba(0,0,0,0.2)'; x.fillRect(0, y, w, 1); }
  });
}
/** Code editor screen (dark). */
export function codeScreen(seed = 1, accent = '#ff8fab') {
  return canvasTex('code' + seed + accent, 192, 120, (x, w, h) => {
    x.fillStyle = '#1b1d2e'; x.fillRect(0, 0, w, h); x.fillStyle = '#25283d'; x.fillRect(0, 0, 30, h); const r = rand(seed); const cols = [accent, '#7bdff2', '#c3f584', '#f6d365', '#b8b8d1'];
    for (let i = 0; i < 13; i++) { let px = 36 + (r() < 0.6 ? 8 * Math.floor(r() * 3) : 0); const n = 1 + Math.floor(r() * 4); for (let k = 0; k < n; k++) { const len = 8 + r() * 36; x.fillStyle = cols[Math.floor(r() * cols.length)]; x.fillRect(px, 6 + i * 8.6, len, 3.6); px += len + 4; } x.fillStyle = '#4a4e69'; x.fillRect(8, 6 + i * 8.6, 12, 3.6); }
  });
}
/** Label texture: text on a transparent or coloured background. */
export function label(text, fg = '#fff', bg = null, w = 256, h = 64, font = `700 45px ${FONT}`) {
  return canvasTex('label' + text + fg + bg + w + h + font, w, h, (x) => { if (bg) { x.fillStyle = bg; x.fillRect(0, 0, w, h); } x.fillStyle = fg; x.font = font; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, w / 2, h / 2 + 2); });
}
/** Neon sign text: bright core on transparent (use with glowMat-like additive material). */
export function neon(text, color = '#ff4fd8', w = 512, h = 128, font = `italic 700 96px ${FONT}`) {
  return canvasTex('neon' + text + color + w, w, h, (x) => { x.font = font; x.textAlign = 'center'; x.textBaseline = 'middle'; x.shadowColor = color; x.shadowBlur = 18; x.fillStyle = color; x.fillText(text, w / 2, h / 2); x.shadowBlur = 0; x.fillStyle = '#ffffff'; x.globalAlpha = 0.85; x.fillText(text, w / 2, h / 2); });
}
/** Book-spine-like vertical colour strips (for book rows seen from afar, e.g. on a far shelf). */
export function spines(seed = 1, palette = ['#e63946', '#f1c453', '#2a9d8f', '#8d6cab', '#f4a261', '#457b9d', '#e9edc9', '#6d597a']) {
  return canvasTex('spines' + seed, 256, 64, (x, w, h) => { const r = rand(seed); let px = 0; while (px < w) { const bw = 5 + r() * 10, bh = h * (0.6 + r() * 0.4); x.fillStyle = palette[Math.floor(r() * palette.length)]; x.fillRect(px, h - bh, bw, bh); x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(px + 1, h - bh + 6, bw - 2, 2); px += bw + 1; } });
}
