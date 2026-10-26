// @ts-check
// Tavern Duel art: wooden table + felt, pixel portraits, illustrated cards (frame, mana gem, icon, rarity border).
import { text } from './util.js';
import { RARITY, INK } from './tavern-ui.js';

/** @typedef {{ n:string, m:number, d?:number, h?:number, b?:number, c:string, t:string, ic:string, r:number }} Card */
/** @type {Card[]} */
export const CARDS = [
  { n: 'Spark', m: 1, d: 2, c: '#ffb36b', t: 'Deal 2', ic: 'spark', r: 1 },
  { n: 'Mug of Ale', m: 1, h: 3, c: '#e0a458', t: 'Heal 3', ic: 'ale', r: 1 },
  { n: 'Murloc Pal', m: 2, d: 3, c: '#5aa86a', t: 'Deal 3', ic: 'fish', r: 2 },
  { n: 'Tankard Shield', m: 2, b: 4, c: '#8aa0c8', t: 'Block 4', ic: 'shield', r: 2 },
  { n: 'Fireball', m: 3, d: 5, c: '#ff5a2a', t: 'Deal 5', ic: 'fire', r: 3 },
  { n: 'Bar Brawl', m: 4, d: 7, c: '#a8302a', t: 'Deal 7', ic: 'fist', r: 4 },
];
export const CW = 68, CH = 92;

/** @param {CanvasRenderingContext2D} x */
export function table(x, W, H) {
  x.fillStyle = '#4a2a14'; x.fillRect(0, 0, W, H);
  for (let i = 0; i < H; i += 18) { x.fillStyle = i % 36 ? '#5e3a1e' : '#563418'; x.fillRect(0, i, W, 17); x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(0, i + 17, W, 1);
    for (let k = 0; k < 6; k++) { x.fillStyle = 'rgba(255,200,140,0.06)'; x.fillRect((i * 13 + k * 83) % W, i + 5 + (k % 3) * 4, 30, 1); } }
  x.fillStyle = '#2a1408'; x.fillRect(22, 14, W - 44, H - 28);
  x.fillStyle = '#2f5a3a'; x.fillRect(26, 18, W - 52, H - 36);
  x.strokeStyle = '#d8a43a'; x.lineWidth = 1; x.strokeRect(31.5, 23.5, W - 63, H - 47);
  x.fillStyle = 'rgba(0,0,0,0.12)'; for (let i = 0; i < 300; i++) x.fillRect(26 + ((i * 97) % (W - 52)), 18 + ((i * 61) % (H - 36)), 1, 1);
  // candle glow corners
  for (const [cx, cy] of [[14, 14], [W - 14, H - 14]]) { const g = x.createRadialGradient(cx, cy, 0, cx, cy, 70); g.addColorStop(0, 'rgba(255,180,90,0.35)'); g.addColorStop(1, 'rgba(255,180,90,0)'); x.fillStyle = g; x.fillRect(cx - 70, cy - 70, 140, 140);
    x.fillStyle = '#f0e6c8'; x.fillRect(cx - 3, cy - 8, 6, 12); x.fillStyle = '#ffd070'; x.fillRect(cx - 1, cy - 12, 3, 4); }
}

/** Pixel portrait. kind 'keep' (bearded innkeeper) or 'you' (hooded coder with glowing laptop). @param {CanvasRenderingContext2D} x */
export function portrait(x, px, py, kind, hurt = 0) {
  x.fillStyle = '#d8a43a'; x.fillRect(px - 2, py - 2, 48, 48); x.fillStyle = '#2a1a10'; x.fillRect(px, py, 44, 44);
  x.fillStyle = kind === 'keep' ? '#5a3418' : '#1e2240'; x.fillRect(px + 2, py + 2, 40, 40);
  const sk = hurt > 0 ? '#ff8a7a' : '#d8a888';
  if (kind === 'keep') { x.fillStyle = sk; x.fillRect(px + 12, py + 8, 20, 18); x.fillStyle = '#7a3a1a'; x.fillRect(px + 10, py + 20, 24, 14); x.fillRect(px + 12, py + 6, 20, 4);
    x.fillStyle = '#1a1010'; x.fillRect(px + 16, py + 14, 3, 3); x.fillRect(px + 25, py + 14, 3, 3); x.fillStyle = '#e8d6a8'; x.fillRect(px + 8, py + 34, 28, 8); }
  else { x.fillStyle = '#3a4a8a'; x.fillRect(px + 9, py + 6, 26, 26); x.fillStyle = sk; x.fillRect(px + 14, py + 12, 16, 16);
    x.fillStyle = '#1a1010'; x.fillRect(px + 17, py + 18, 3, 3); x.fillRect(px + 24, py + 18, 3, 3); x.fillStyle = '#6ee7a0'; x.fillRect(px + 10, py + 34, 24, 8); x.fillStyle = '#1e2240'; x.fillRect(px + 12, py + 36, 20, 1); }
}

/** @param {CanvasRenderingContext2D} x */
function icon(x, ic, cx, cy, t) {
  const p = (c, a, b, w, h) => { x.fillStyle = c; x.fillRect(cx + a, cy + b, w, h); };
  if (ic === 'fire') { const f = 0.5 + 0.5 * Math.sin(t * 3); /* smooth flame bob, no hard toggle */ p('#a8302a', -10, -6 - f, 20, 18); p('#ff7a2a', -7, -3, 14, 14); p('#ffd070', -4, 2, 8, 8); p('#ff7a2a', -3, -12 - f, 6, 6); }
  else if (ic === 'ale') { p('#8a5a32', -9, -8, 16, 20); p('#5e3a20', -9, -2, 16, 2); p('#5e3a20', 7, -4, 5, 10); p('#e0a458', -7, -5, 12, 15); p('#f8f0d8', -10, -12, 18, 6); }
  else if (ic === 'shield') { p('#8aa0c8', -10, -12, 20, 16); p('#8aa0c8', -7, 4, 14, 5); p('#8aa0c8', -3, 9, 6, 3); p('#d8a43a', -2, -10, 4, 18); p('#d8a43a', -8, -4, 16, 3); }
  else if (ic === 'fish') { p('#5aa86a', -10, -8, 20, 18); p('#c8d890', -6, 0, 12, 8); p('#f8f0d8', -7, -5, 5, 5); p('#f8f0d8', 3, -5, 5, 5); p('#1a1a1a', -5, -3, 2, 2); p('#1a1a1a', 5, -3, 2, 2); p('#5a1a2a', -3, 4, 6, 3); p('#d86a4a', -2, -14, 4, 6); }
  else if (ic === 'fist') { p('#d8a888', -10, -8, 20, 14); p('#b88868', -10, -3, 20, 1); p('#d8a888', -6, 6, 12, 6); p('#ffd070', 10, -12, 3, 3); p('#ffd070', -14, -12, 3, 3); }
  else { p('#ffd070', -2, -12, 4, 24); p('#ffd070', -12, -2, 24, 4); p('#fff2c0', -2, -2, 4, 4); p('#ffb36b', -7, -7, 3, 3); p('#ffb36b', 4, 4, 3, 3); }
}

/** Card face (or back if back=true). sx scales x for the flip. @param {CanvasRenderingContext2D} x @param {Card} k */
export function card(x, k, px, py, o = {}) {
  const sx = o.sx ?? 1, t = o.t || 0; x.save(); x.translate(px + CW / 2, py + CH / 2); x.scale(Math.max(0.02, Math.abs(sx)), 1); x.translate(-CW / 2, -CH / 2);
  x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(3, 4, CW, CH);
  if (o.back || sx < 0) { x.fillStyle = '#3a2412'; x.fillRect(0, 0, CW, CH); x.fillStyle = '#6a2a3a'; x.fillRect(4, 4, CW - 8, CH - 8); x.strokeStyle = '#d8a43a'; x.strokeRect(8.5, 8.5, CW - 17, CH - 17);
    x.fillStyle = '#d8a43a'; x.fillRect(CW / 2 - 6, CH / 2 - 6, 12, 12); x.restore(); return; }
  const rc = RARITY[k.r][1];
  x.fillStyle = rc; x.fillRect(0, 0, CW, CH); x.fillStyle = '#3a2412'; x.fillRect(2, 2, CW - 4, CH - 4);
  x.fillStyle = o.dim ? '#a89878' : '#e8d6a8'; x.fillRect(4, 4, CW - 8, CH - 8);
  x.fillStyle = k.c; x.fillRect(8, 16, CW - 16, 36); x.fillStyle = 'rgba(0,0,0,0.25)'; x.fillRect(8, 48, CW - 16, 4);
  icon(x, k.ic, CW / 2, 34, t);
  x.fillStyle = '#1a3a8a'; x.beginPath(); x.moveTo(10, 2); x.lineTo(18, 10); x.lineTo(10, 18); x.lineTo(2, 10); x.closePath(); x.fill();
  x.fillStyle = '#6aa0ff'; x.fillRect(7, 6, 3, 3); text(x, String(k.m), 10, 15, { color: '#fff', align: 'center' });
  x.fillStyle = '#5e3a20'; x.fillRect(6, 54, CW - 12, 14); text(x, k.n.length > 11 ? k.n.split(' ')[0] : k.n, CW / 2, 65, { color: '#ffe8b0', align: 'center' });
  text(x, k.t, CW / 2, 84, { color: INK, align: 'center' });
  if (o.glow) { x.strokeStyle = `rgba(110,231,106,${0.6 + Math.sin(t * 5) * 0.3})`; x.lineWidth = 2; x.strokeRect(-1, -1, CW + 2, CH + 2); }
  x.restore();
}
