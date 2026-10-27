// @ts-check
// What every TV in the world shows (owner: "play youtubes rick roll for all of em"): a "now playing" screen for Rick
// Astley's "Never Gonna Give You Up". The real video plays when you watch a TV (act/rickroll.js); the room TVs show
// this drawn version (our own art: a little 80s dancer with a quiff and a trench coat, a dusk stage, a red progress
// bar) so a room full of TVs costs one small texture instead of seven video players.
// One shared CanvasTexture for all TVs, redrawn ~10 times a second, and only while a room with a TV is ticking.
import * as THREE from 'three';

const W = 512, H = 288, LEN = 213; // song length in seconds (3:33)
let tex = /** @type {THREE.CanvasTexture | null} */ (null), x = /** @type {CanvasRenderingContext2D | null} */ (null), bg = /** @type {HTMLCanvasElement | null} */ (null), last = -1;

/** The shared TV texture (created on first use). */
export function rickTex() {
  if (tex) return tex;
  const c = document.createElement('canvas'); c.width = W; c.height = H; x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  draw(0); return tex;
}

/** Advance the screen; call from any TV room's tick (repeat calls in a frame are free). @param {number} t seconds */
export function tickRick(t) {
  if (!tex) return; const f = Math.floor(t * 10); if (f === last) return; last = f; draw(t); tex.needsUpdate = true;
}

/** stage backdrop: dusk sky, soft spotlights, a floor with a perspective grid (drawn once) */
function backdrop() {
  if (bg) return bg;
  bg = document.createElement('canvas'); bg.width = W; bg.height = H; const g = /** @type {CanvasRenderingContext2D} */ (bg.getContext('2d'));
  const sky = g.createLinearGradient(0, 0, 0, H * 0.7); sky.addColorStop(0, '#2a2152'); sky.addColorStop(0.55, '#8a4a86'); sky.addColorStop(1, '#f09a6a');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  for (const [cx, col] of [[120, 'rgba(255,214,170,0.35)'], [392, 'rgba(170,200,255,0.3)']]) { // two spotlights
    const sp = g.createRadialGradient(+cx, 40, 4, +cx, 150, 170); sp.addColorStop(0, String(col)); sp.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = sp; g.fillRect(0, 0, W, H); }
  const fy = H * 0.68, fl = g.createLinearGradient(0, fy, 0, H); fl.addColorStop(0, '#3a2440'); fl.addColorStop(1, '#160f1e'); g.fillStyle = fl; g.fillRect(0, fy, W, H - fy);
  g.strokeStyle = 'rgba(255,170,200,0.22)'; g.lineWidth = 1.5;
  for (let i = -8; i <= 8; i++) { g.beginPath(); g.moveTo(W / 2 + i * 14, fy); g.lineTo(W / 2 + i * 70, H); g.stroke(); }
  for (let k = 1; k < 6; k++) { const y = fy + (H - fy) * Math.pow(k / 6, 1.7); g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  return bg;
}

/** the dancer: quiff, trench coat, striped shirt, swinging arms; s = sway phase */
function dancer(g, cx, fy, t) {
  const s = Math.sin(t * 2.6), arm = Math.sin(t * 5.2), bob = Math.abs(Math.sin(t * 2.6)) * 4;
  g.save(); g.translate(cx + s * 7, fy - bob);
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(-s * 4, bob + 2, 46, 9, 0, 0, 7); g.fill(); // shadow
  g.fillStyle = '#121019'; g.fillRect(-20, -62, 14, 62); g.fillRect(6, -62, 14, 62); // legs
  g.fillStyle = '#0b0a10'; g.fillRect(-24, -6, 20, 7); g.fillRect(4, -6, 20, 7);    // shoes
  g.rotate(s * 0.05);
  g.fillStyle = '#1d1b26'; g.beginPath(); g.moveTo(-30, -150); g.lineTo(30, -150); g.lineTo(38, -52); g.lineTo(-38, -52); g.closePath(); g.fill(); // coat
  g.fillStyle = '#f2ede4'; g.fillRect(-11, -150, 22, 46); g.fillStyle = '#16141c'; for (let k = 0; k < 6; k++) g.fillRect(-11, -146 + k * 8, 22, 3); // striped shirt
  g.fillStyle = '#2a2734'; g.beginPath(); g.moveTo(-12, -150); g.lineTo(-2, -110); g.lineTo(-30, -150); g.fill(); g.beginPath(); g.moveTo(12, -150); g.lineTo(2, -110); g.lineTo(30, -150); g.fill(); // lapels
  for (const sd of [-1, 1]) { g.save(); g.translate(sd * 30, -144); g.rotate(sd * (0.35 + arm * 0.45 * sd)); // arms
    g.fillStyle = '#1d1b26'; g.fillRect(-7, 0, 14, 58); g.fillStyle = '#f0c3a0'; g.beginPath(); g.arc(0, 62, 7, 0, 7); g.fill(); g.restore(); }
  g.fillStyle = '#f0c3a0'; g.fillRect(-7, -160, 14, 12); // neck
  g.beginPath(); g.ellipse(0, -176, 17, 20, 0, 0, 7); g.fill(); // head
  g.fillStyle = '#c95a28'; g.beginPath(); g.ellipse(2, -194, 19, 11, -0.2, 0, 7); g.fill(); g.beginPath(); g.ellipse(-12, -184, 7, 12, 0.3, 0, 7); g.fill(); // the quiff
  g.fillStyle = '#e8875a'; g.beginPath(); g.ellipse(6, -199, 10, 4, -0.3, 0, 7); g.fill();
  g.fillStyle = '#3a2420'; g.fillRect(-8, -178, 4, 3); g.fillRect(5, -178, 4, 3); g.fillRect(-4, -167, 9, 2); // face
  g.restore();
}

function draw(t) {
  const g = /** @type {CanvasRenderingContext2D} */ (x);
  g.drawImage(backdrop(), 0, 0);
  const fy = H * 0.86; dancer(g, W * 0.5, fy, t);
  g.fillStyle = '#2b2b33'; g.fillRect(W * 0.5 + 64, fy - 120, 4, 120); g.fillStyle = '#9aa0ac'; g.beginPath(); g.ellipse(W * 0.5 + 66, fy - 126, 6, 9, 0, 0, 7); g.fill(); // mic stand
  // player chrome: title strip on top, progress bar + time at the bottom
  const top = g.createLinearGradient(0, 0, 0, 60); top.addColorStop(0, 'rgba(0,0,0,0.7)'); top.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = top; g.fillRect(0, 0, W, 60);
  g.font = '32px m5x7'; g.textBaseline = 'alphabetic'; g.fillStyle = '#ffffff'; g.fillText('Never Gonna Give You Up', 16, 30);
  g.font = '16px m5x7'; g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText('Rick Astley', 16, 46);
  const bot = g.createLinearGradient(0, H - 56, 0, H); bot.addColorStop(0, 'rgba(0,0,0,0)'); bot.addColorStop(1, 'rgba(0,0,0,0.75)'); g.fillStyle = bot; g.fillRect(0, H - 56, W, 56);
  const p = (t % LEN) / LEN, bx = 16, bw = W - 32, by = H - 30;
  g.fillStyle = 'rgba(255,255,255,0.3)'; g.fillRect(bx, by, bw, 5); g.fillStyle = '#ff2a3d'; g.fillRect(bx, by, bw * p, 5);
  g.beginPath(); g.arc(bx + bw * p, by + 2.5, 7, 0, 7); g.fill();
  const tm = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(18, H - 18); g.lineTo(18, H - 6); g.lineTo(28, H - 12); g.closePath(); g.fill(); // play icon
  g.font = '16px m5x7'; g.fillText(tm(t % LEN) + ' / ' + tm(LEN), 38, H - 7);
}
