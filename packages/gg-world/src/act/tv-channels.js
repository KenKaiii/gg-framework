// @ts-check
// Procedural pixel-art TV channels (night palette, dev parody). Each draws a full frame into a small buffer.
import { text } from './util.js';
import { title } from './art.js';

/** @typedef {{ name: string, glow: string, draw: (b: CanvasRenderingContext2D, W: number, H: number, t: number, S: any) => void }} Channel */
const R = (b, c, x, y, w, h) => { b.fillStyle = c; b.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); };
const hash = n => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
const cap = (b, W, H, s, c = '#f2e6c8') => { const g = b.createLinearGradient(0, H - 18, 0, H); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.4, 'rgba(0,0,0,.6)'); g.addColorStop(1, 'rgba(0,0,0,.75)'); b.fillStyle = g; b.fillRect(0, H - 18, W, 18); title(b, s, W / 2, H - 4, { size: 16, body: true, color: c }); };
const stars = (b, W, h, t, n = 24) => { for (let i = 0; i < n; i++) if (hash(i + Math.floor(t * 2 + i) * 0.01) > 0.15) R(b, hash(i * 3) > 0.7 ? '#e0a458' : '#8e8aa8', hash(i) * W, hash(i * 7) * h, 1, 1); };
/** Little pixel person. */
const guy = (b, x, y, skin, top, hair, k = 1) => { R(b, top, x - 3 * k, y - 9 * k, 6 * k, 7 * k); R(b, skin, x - 2 * k, y - 14 * k, 4 * k, 5 * k); R(b, hair, x - 2 * k, y - 15 * k, 4 * k, 2 * k); R(b, '#1a1824', x - 3 * k, y - 2 * k, 2 * k, 2 * k); R(b, '#1a1824', x + 1 * k, y - 2 * k, 2 * k, 2 * k); };

/** @type {Channel[]} */
export const CHANNELS = [
  { name: 'Breaking Prod', glow: '#e0a458', draw(b, W, H, t) {
    const sc = Math.floor(t / 5) % 3, k = t % 5;
    const g = b.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#2a2440'); g.addColorStop(0.55, '#a8553a'); g.addColorStop(0.62, '#e0a458'); g.addColorStop(1, '#5a3a24'); b.fillStyle = g; b.fillRect(0, 0, W, H);
    R(b, '#3a2618', 0, H * 0.62, W, H); for (let i = 0; i < 12; i++) R(b, '#4a3020', hash(i) * W, H * 0.66 + hash(i + 9) * H * 0.3, 6, 1);
    if (sc === 2) { // title card
      R(b, 'rgba(10,12,8,.75)', 0, 0, W, H); const cx = W / 2 - 34;
      for (const [i, el, n] of [[0, 'Br', 35], [1, 'Pr', 59]]) { const x0 = cx + i * 36, y0 = H / 2 - 30 + i * 8; R(b, '#2f6b3a', x0, y0, 30, 30); R(b, '#3ddc84', x0 + 1, y0 + 1, 28, 1); text(b, String(n), x0 + 3, y0 + 10, { color: '#bde8c8' }); text(b, String(el), x0 + 15, y0 + 26, { size: 32, title: true, align: 'center', color: '#e8f5e0' }); }
      text(b, 'BREAKING PROD', W / 2, H / 2 + 26, { align: 'center', color: '#e8f5e0' }); cap(b, W, H, 'Season 5. Nobody reviews this PR.'); return;
    }
    // RV in the desert + a dev with a glowing blue database crystal
    const rx = W * 0.15; R(b, '#d8d0b0', rx, H * 0.42, 48, 22); R(b, '#8a7a5a', rx, H * 0.56, 48, 3); R(b, '#2a3040', rx + 6, H * 0.46, 10, 7); R(b, '#2a3040', rx + 20, H * 0.46, 10, 7); R(b, '#1a1410', rx + 6, H * 0.6, 7, 6); R(b, '#1a1410', rx + 34, H * 0.6, 7, 6);
    if (Math.sin(t * 3) > 0) R(b, '#ffb36b', rx + 40, H * 0.47, 4, 3);
    const px = W * 0.62, py = H * 0.68; guy(b, px, py, '#e8c8a0', '#e8d24a', '#e8c8a0', 2); R(b, '#141418', px - 5, py - 27, 10, 2); R(b, '#141418', px - 3, py - 30, 6, 3); // hat
    R(b, '#141418', px - 3, py - 25, 2, 1); R(b, '#141418', px + 1, py - 25, 2, 1);
    const cy = py - 16 + Math.sin(t * 2) * 1.5; b.globalCompositeOperation = 'lighter'; R(b, 'rgba(90,180,255,.35)', px + 6, cy - 6, 14, 14); b.globalCompositeOperation = 'source-over';
    R(b, '#5ab4ff', px + 9, cy - 3, 8, 8); R(b, '#bfe6ff', px + 11, cy - 1, 3, 3); text(b, 'DB', px + 13, cy - 7, { align: 'center', color: '#bfe6ff' });
    cap(b, W, H, sc === 0 ? (k < 2.5 ? 'Say my name.' : '"...root?"') : (k < 2.5 ? 'I am the one who DROPs.' : 'TABLE users; -- 0 rows'), sc === 1 && k >= 2.5 ? '#ff6a5a' : '#f2e6c8');
  } },
  { name: 'Planet Merge', glow: '#6ee7a0', draw(b, W, H, t) {
    const g = b.createLinearGradient(0, 0, 0, H * 0.4); g.addColorStop(0, '#1e2240'); g.addColorStop(1, '#3a4a5a'); b.fillStyle = g; b.fillRect(0, 0, W, H * 0.4); stars(b, W, H * 0.3, t, 18);
    R(b, '#2c4a30', 0, H * 0.32, W, H * 0.12); for (let i = 0; i < W; i += 7) R(b, '#1f3a24', i, H * 0.3 - hash(i) * 6, 5, 8);
    R(b, '#1d3a5a', 0, H * 0.44, W, H * 0.3); for (let i = 0; i < 30; i++) { const y = H * 0.46 + hash(i) * H * 0.26, x = ((hash(i + 3) * W + t * (20 + hash(i) * 30)) % (W + 20)) - 10; R(b, '#3d6a90', x, y, 6 + hash(i) * 8, 1); }
    R(b, '#3a3020', 0, H * 0.74, W, H * 0.26); for (let i = 0; i < W; i += 9) R(b, '#4a3e28', i + hash(i) * 4, H * 0.76 + hash(i * 2) * H * 0.18, 3, 1);
    // stepping stones + wild PRs hopping across
    const stones = [0.18, 0.38, 0.58, 0.78]; for (const s of stones) R(b, '#6a6a70', W * s - 6, H * 0.58, 12, 4);
    for (let n = 0; n < 4; n++) {
      const ph = (t * 0.35 + n * 0.27) % 1.25; if (ph > 1) continue; const xx = W * (0.02 + ph * 0.96), hop = Math.abs(Math.sin(ph * Math.PI * 5)) * 9, yy = H * 0.58 - hop;
      const c = n % 2 ? '#3ddc84' : '#e0a458'; R(b, c, xx - 5, yy - 6, 10, 6); R(b, '#141418', xx + 2, yy - 5, 2, 2); R(b, c, xx - 4, yy, 2, 2); R(b, c, xx + 2, yy, 2, 2);
      text(b, n % 2 ? '+42' : '-7', xx, yy - 8, { align: 'center', color: n % 2 ? '#6ee7a0' : '#ff8a6a' });
    }
    const snap = (t % 6) > 4.6, cx = W * 0.47; R(b, '#2f5a3a', cx - 14, H * 0.6, 28, 5); R(b, '#4f8a5a', cx + 8, H * 0.6 - (snap ? 6 : 1), 10, snap ? 6 : 2); R(b, '#e8e870', cx + 8, H * 0.59, 2, 2); text(b, 'CI', cx - 6, H * 0.6 + 14, { color: '#6ee7a0' });
    cap(b, W, H, (t % 12) < 6 ? 'Only the strongest PRs reach main.' : snap ? 'Nature... is brutal.' : 'The CI lurks beneath.');
  } },
  { name: "Hell's Commits", glow: '#ff6a3a', draw(b, W, H, t) {
    R(b, '#1c1418', 0, 0, W, H); for (let x = 0; x < W; x += 12) for (let y = 0; y < H * 0.6; y += 12) R(b, (x + y) % 24 ? '#2a1e24' : '#241a20', x, y, 11, 11);
    R(b, '#4a4650', 0, H * 0.62, W, 4); R(b, '#2e2a32', 0, H * 0.62 + 4, W, H);
    // stove flames + pan of raw code
    const sx = W * 0.62; for (let i = 0; i < 9; i++) { const h = 4 + Math.abs(Math.sin(t * 9 + i * 1.7)) * 9; R(b, i % 2 ? '#ff4a2a' : '#ffb36b', sx + i * 4, H * 0.62 - h, 3, h); }
    R(b, '#3a3a44', sx - 4, H * 0.62 - 12, 44, 4); R(b, '#3a3a44', sx + 38, H * 0.62 - 12, 16, 2); text(b, '{ };', sx + 18, H * 0.62 - 15, { align: 'center', color: '#ffb0c0' });
    // chef
    const ang = Math.floor(t * 2) % 2, cx = W * 0.3, cy = H * 0.62; R(b, '#f0f0f0', cx - 8, cy - 26, 16, 22); R(b, '#e8c0a0', cx - 5, cy - 36, 10, 10); R(b, '#f8f8f8', cx - 7, cy - 46, 14, 8); R(b, '#f8f8f8', cx - 5, cy - 50, 10, 5);
    R(b, '#e8d080', cx - 5, cy - 37, 10, 2); R(b, '#141418', cx - 3, cy - 33, 2, 1); R(b, '#141418', cx + 1, cy - 33, 2, 1); R(b, ang ? '#601010' : '#141418', cx - 2, cy - 29, 4, ang ? 2 : 1);
    R(b, '#f0f0f0', cx + 8, cy - 24 - ang * 8, 10, 4); // pointing arm
    const lines = ['This code is RAW!', "It's still in staging!", 'You donkey. No tests?!', 'Get OUT of my repo!', 'Finally. Delicious.'];
    const i = Math.floor(t / 2.4) % lines.length; R(b, '#f2e6c8', 6, 6, W - 12, 18); R(b, '#f2e6c8', cx, 24, 6, 4); text(b, lines[i], W / 2, 19, { align: 'center', color: i === 4 ? '#2f6b3a' : '#8a1a1a' });
    if (i === 3 && (t % 2.4) < 0.5) { R(b, 'rgba(255,80,40,.25)', 0, 0, W, H); }
    cap(b, W, H, "HELL'S COMMITS  ·  live, sadly", '#ffb36b');
  } },
  { name: 'Refactor Z', glow: '#ff4fd8', draw(b, W, H, t) {
    R(b, '#120c22', 0, 0, W, H);
    const cy = H * 0.5; b.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 40; i++) { const a = hash(i) * 6.28, r0 = 20 + ((t * 120 + hash(i + 1) * 200) % 140); R(b, i % 3 ? 'rgba(120,90,200,.45)' : 'rgba(255,79,216,.4)', W / 2 + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 0.6, 3, 1); }
    const p = (t % 4) / 4, clash = W / 2 + Math.sin(t * 3) * 14;
    for (let i = 0; i < 4; i++) { R(b, 'rgba(110,231,160,.5)', 28, cy - 3 - i, clash - 28, 6 + i * 2); R(b, 'rgba(255,79,216,.5)', clash, cy - 3 - i, W - 28 - clash, 6 + i * 2); }
    R(b, '#ffffff', clash - 4, cy - 6, 8, 12); b.globalCompositeOperation = 'source-over';
    // fighters with spiky hair
    for (const [x, hair, dir] of [[18, '#ffd84a', 1], [W - 18, '#6a4aff', -1]]) { guy(b, x, cy + 14, '#f0c8a0', dir > 0 ? '#e86a2a' : '#2a2a4a', hair, 2); for (let s = 0; s < 3; s++) R(b, hair, x - 5 + s * 4, cy - 22 - (s % 2) * 4, 3, 5); R(b, '#f0c8a0', x + dir * 5 - 2, cy - 2, 6, 3); }
    if (p > 0.85) R(b, 'rgba(255,255,255,.6)', 0, 0, W, H);
    const L = ['Not even my final refactor!', 'Your code... has no tests.', 'IT\'S OVER 9000 LINES!', '...to be continued'];
    text(b, 'EP.404', 4, 13, { color: '#ff4fd8' }); cap(b, W, H, L[Math.floor(t / 4) % L.length], '#ffe08a');
  } },
  { name: 'beats to debug to', glow: '#b48aff', draw(b, W, H, t) {
    R(b, '#1e2240', 0, 0, W, H);
    // window with night city + rain
    const wx = W * 0.5, ww = W * 0.44, wh = H * 0.5; R(b, '#0e1028', wx, 8, ww, wh);
    for (let i = 0; i < 10; i++) { const bh = 10 + hash(i) * wh * 0.6; R(b, '#1a1c38', wx + i * ww / 10, 8 + wh - bh, ww / 10 - 1, bh); if (hash(i + 5) > 0.4) R(b, '#e0a458', wx + i * ww / 10 + 2, 8 + wh - bh + 4, 1, 1); }
    for (let i = 0; i < 18; i++) { const x = wx + hash(i) * ww, y = 8 + ((t * 60 + hash(i + 2) * wh) % wh); R(b, '#5a6aa0', x, y, 1, 3); }
    R(b, '#2a2440', wx - 2, 6, ww + 4, 2); R(b, '#2a2440', wx - 2, 8 + wh, ww + 4, 3); R(b, '#2a2440', wx + ww / 2 - 1, 8, 2, wh);
    // desk, monitor, mug steam, girl with headphones
    R(b, '#3a2a30', 0, H * 0.7, W, 4); R(b, '#2a2028', 0, H * 0.7 + 4, W, H);
    const mx = W * 0.62; R(b, '#141418', mx, H * 0.7 - 26, 36, 24); R(b, '#0a1a10', mx + 2, H * 0.7 - 24, 32, 18); for (let i = 0; i < 5; i++) R(b, '#3ddc84', mx + 4, H * 0.7 - 22 + i * 3, 6 + hash(i + Math.floor(t)) * 20, 1);
    R(b, '#e0a458', W * 0.88, H * 0.7 - 7, 6, 7); for (let i = 0; i < 3; i++) R(b, 'rgba(220,220,240,.35)', W * 0.88 + 2 + Math.sin(t * 2 + i) * 2, H * 0.7 - 11 - i * 4 - (t * 6 % 4), 1, 3);
    const gx = W * 0.3, gy = H * 0.7, bob = Math.round(Math.sin(t * Math.PI * 1.4)) ; R(b, '#6a3a5a', gx - 9, gy - 16, 18, 16); R(b, '#f0c8a8', gx - 5, gy - 28 + bob, 10, 10); R(b, '#3a2030', gx - 7, gy - 31 + bob, 14, 6); R(b, '#3a2030', gx + 3, gy - 26 + bob, 5, 14);
    R(b, '#ff4fd8', gx - 8, gy - 26 + bob, 3, 5); R(b, '#ff4fd8', gx - 7, gy - 32 + bob, 13, 2); R(b, '#f0c8a8', gx + 6, gy - 9 + (Math.floor(t * 3) % 2), 6, 3);
    // cat on the sill
    R(b, '#141418', wx + ww - 16, 8 + wh - 6, 10, 6); R(b, '#141418', wx + ww - 16, 8 + wh - 9, 4, 3); R(b, '#141418', wx + ww - 6, 8 + wh - 8 + Math.sin(t * 2) * 2, 2, 6);
    text(b, 'lo-fi beats to debug to', 4, 13, { color: '#d8c8f0' }); R(b, '#ff3a3a', 4, 18, 3, 3); text(b, 'LIVE  ' + (3800 + Math.floor(t) % 50) + ' watching', 9, 24, { color: '#b0a8c8' });
  } },
  { name: 'Monday Night Deploys', glow: '#3ddc84', draw(b, W, H, t, S) {
    const on = (S?.members || []).filter(m => m.status !== 'offline'), dep = on.filter(m => m.status === 'deploying');
    R(b, '#0c1a10', 0, 0, W, H); R(b, '#1d4a28', 0, H * 0.3, W, H * 0.6); for (let i = 0; i < 6; i++) R(b, '#2a5a34', 0, H * 0.3 + i * H * 0.1, W, H * 0.05);
    for (let x = 10; x < W; x += W / 8) R(b, 'rgba(230,240,220,.5)', x, H * 0.3, 1, H * 0.6);
    for (let i = 0; i < 40; i++) R(b, hash(i + Math.floor(t * 4)) > 0.85 ? '#ffffff' : ['#3a2a4a', '#4a3a3a', '#2a3a4a'][i % 3], (i * 13) % W, 6 + (i % 3) * 5, 4, 4); // crowd + flashes
    // players carrying a package (the deploy)
    const n = Math.max(2, Math.min(5, dep.length + 2));
    for (let i = 0; i < n; i++) { const x = ((t * (26 + i * 5) + i * 40) % (W + 20)) - 10, y = H * 0.4 + (i * 17) % (H * 0.45); guy(b, x, y + 10, '#e8c0a0', i % 2 ? '#3ddc84' : '#ff4fd8', '#2a2030'); if (i === 0) { R(b, '#e0a458', x + 3, y - 2, 5, 4); } }
    R(b, 'rgba(0,0,0,.7)', W / 2 - 50, 22, 100, 22); R(b, '#3ddc84', W / 2 - 50, 22, 100, 1);
    text(b, 'DEPLOYS ' + dep.length + '  ·  BUGS 0', W / 2, 38, { align: 'center', color: '#e8f5e0' });
    const who = dep.length ? dep.map(m => m.d?.name || '?').join(', ') + ' driving to prod' : (S?.lastShip ? S.lastShip + ' scored a ship!' : 'warming up the pipeline');
    R(b, '#0a0a0e', 0, H - 15, W, 15); R(b, '#e0a458', 0, H - 15, 30, 15); text(b, 'LIVE', 15, H - 4, { align: 'center', color: '#1a1010' });
    b.save(); b.beginPath(); b.rect(32, H - 15, W - 32, 15); b.clip(); const msg = who + '   ·   ' + on.length + ' devs online   ·   no deploys after 2 drinks   ·   '; const w = msg.length * 5.2; const ox = 32 - (t * 30 % w); text(b, msg + msg, ox, H - 4, { color: '#e8f5e0' }); b.restore();
  } },
];
