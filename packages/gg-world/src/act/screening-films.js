// @ts-check
// Procedural pixel-art PARODY trailers for the Screening Room big screen (320x136, 2.35:1). Each: { name, dur, draw }.
import { text } from './util.js';
import { title } from './art.js';

/** @typedef {{ name: string, dur: number, draw: (x: CanvasRenderingContext2D, W: number, H: number, t: number) => void }} Film */
const fade = (x, W, H, t, dur) => { const a = Math.max(0, 1 - t / 0.5, 1 - (dur - t) / 0.5); if (a > 0) { x.fillStyle = `rgba(0,0,0,${Math.min(1, a)})`; x.fillRect(0, 0, W, H); } };
const stars = (x, W, H, n, seed, drift = 0) => { let s = seed; for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; const px = s % W; s = (s * 1664525 + 1013904223) >>> 0; x.fillStyle = i % 7 ? '#8a90b0' : '#fff'; x.fillRect((px + drift * (1 + i % 3)) % W, s % H, 1, 1); } };
const card = (x, W, H, a, b, col = '#e0a458') => { const g = x.createRadialGradient(W / 2, H / 2, 4, W / 2, H / 2, W * 0.6); g.addColorStop(0, '#1a1418'); g.addColorStop(1, '#030305'); x.fillStyle = g; x.fillRect(0, 0, W, H); title(x, a, W / 2, H / 2 - 4, { size: 32, color: col, glow: col, glowR: 10 }); if (b) title(x, b, W / 2, H / 2 + 22, { size: 16, body: true, color: '#d8ccb8' }); };

/** @type {Film[]} */
export const FILMS = [
  { name: 'Now showing', dur: 6, draw(x, W, H, t) {
    x.fillStyle = '#12060a'; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 40; i++) { const on = (i + Math.floor(t * 8)) % 3 === 0; const px = i < 20 ? 14 + i * 14.6 : 14 + (i - 20) * 14.6, py = i < 20 ? 10 : H - 10; x.fillStyle = on ? '#ffd98a' : '#5a3a20'; x.fillRect(px, py - 2, 4, 4); }
    title(x, 'NOW SHOWING', W / 2, 50, { size: 32, color: '#ffcf8a', glow: '#ff8a4a', glowR: 10 });
    ['JAWZ', 'DEPLOY ON FRIDAY', 'REPO WARS'].forEach((s, i) => text(x, (Math.floor(t * 2) % 3 === i ? '> ' : '  ') + s, W / 2, 78 + i * 16, { color: i === Math.floor(t * 2) % 3 ? '#6ee7a0' : '#d8ccb8', align: 'center' }));
    fade(x, W, H, t, this.dur);
  } },
  { name: 'JAWZ', dur: 11, draw(x, W, H, t) {
    if (t > 8.2) { card(x, W, H, 'JAWZ', 'this summer. on prod.', '#e8e0c8'); return fade(x, W, H, t, this.dur); }
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#081830'); g.addColorStop(0.45, '#123a5a'); g.addColorStop(1, '#0a2238'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = '#e8e0c0'; x.fillRect(250, 18, 10, 10);
    for (let y = 60; y < H; y += 6) for (let i = 0; i < 12; i++) { x.fillStyle = '#2a6a8a'; x.fillRect(((i * 41 + y * 7 + t * (10 + y / 8)) % (W + 20)) - 10, y + Math.sin(t * 2 + i) * 1.5, 8, 1); }
    // the boat: a tiny dev raft with a laptop glow
    x.fillStyle = '#4a2c1a'; x.fillRect(40, 62, 40, 5); x.fillStyle = '#6ee7a0'; x.fillRect(56, 57, 6, 4);
    const beat = Math.max(0.12, 0.7 - t * 0.07), on = (t % beat) < beat / 2, fx = W + 20 - t * 30;
    x.fillStyle = '#7a8690'; x.beginPath(); x.moveTo(fx, 72); x.lineTo(fx + 10, 50 + (on ? 1 : 0)); x.lineTo(fx + 18, 72); x.fill();
    x.fillStyle = '#cfe6ff'; x.fillRect(fx - 4, 72, 26, 1);
    title(x, on ? 'duh-DUM' : 'duh...', W / 2, 32, on ? { size: 32, color: '#ff6a5a', glow: 'rgba(255,60,40,0.6)', glowR: 10 } : { size: 16, color: '#8aa' });
    if (t > 5) { const g2 = x.createLinearGradient(0, H - 40, 0, H); g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, 'rgba(0,0,0,0.7)'); x.fillStyle = g2; x.fillRect(0, H - 40, W, 40); title(x, "You're gonna need a bigger repo.", W / 2, H - 12, { size: 16, body: true, color: '#fff6e0' }); }
    fade(x, W, H, t, this.dur);
  } },
  { name: 'Deploy on Friday', dur: 11, draw(x, W, H, t) {
    if (t > 8.4) { const jit = Math.round(Math.max(0, Math.sin(t * 1.3)) ** 6 * 2); card(x, W, H, 'DEPLOY ON FRIDAY', 'nobody rolls back alive.', '#ff3a3a'); x.fillStyle = '#a01020'; for (let i = 0; i < 6; i++) x.fillRect(80 + i * 30 + jit, 72, 2, 6 + ((t * 20 + i * 7) % 14)); return fade(x, W, H, t, this.dur); }
    x.fillStyle = '#0a0a12'; x.fillRect(0, 0, W, H);
    const flash = t > 6 && t < 6.25; if (flash) { x.fillStyle = '#ff2030'; x.fillRect(0, 0, W, H); }
    // office at night: a desk, a monitor, a wall clock
    x.fillStyle = '#1a1a26'; x.fillRect(0, 96, W, 40); x.fillStyle = '#2a2230'; x.fillRect(110, 92, 110, 6);
    x.fillStyle = '#0c1a10'; x.fillRect(132, 46, 112, 40); x.fillStyle = '#3a3a48'; x.fillRect(184, 86, 8, 6);
    const cmd = 'git push --force'.slice(0, Math.max(0, Math.floor((t - 0.6) * 6)));
    text(x, '$ ' + cmd + ((t * 3) % 1 < 0.5 ? '_' : ''), 136, 62, { color: '#6ee7a0' });
    if (t > 3.6) text(x, 'DEPLOYED', 136, 78, { color: '#3ddc84' });
    x.strokeStyle = '#8a8a96'; x.beginPath(); x.arc(60, 34, 14, 0, 7); x.stroke(); x.beginPath(); x.moveTo(60, 34); x.lineTo(60, 23); x.moveTo(60, 34); x.lineTo(68, 36); x.stroke();
    text(x, 'FRI 4:59 PM', 60, 64, { color: '#ffb36b', align: 'center' });
    if (t > 4.6) { const ring = Math.floor(t * 8) % 2; x.fillStyle = ring ? '#ff4040' : '#601010'; x.fillRect(236, 82, 14, 10); title(x, 'PAGER: 37 ALERTS', 243, 116, { size: 16, body: true, color: '#ff6a5a' }); }
    if (t > 6.4) { x.fillStyle = '#000'; x.fillRect(280, 30, 22, 66); x.beginPath(); x.arc(291, 28, 10, 0, 7); x.fill(); title(x, 'The call is coming from... prod.', W / 2, 18, { size: 16, body: true, color: '#fff6e0' }); }
    fade(x, W, H, t, this.dur);
  } },
  { name: 'Repo Wars', dur: 15, draw(x, W, H, t) {
    x.fillStyle = '#000'; x.fillRect(0, 0, W, H); stars(x, W, H, 90, 7);
    if (t < 3) { text(x, 'A long time ago, on a branch', W / 2, 60, { color: '#4fa8ff', align: 'center' }); text(x, 'far, far away...', W / 2, 76, { color: '#4fa8ff', align: 'center' }); return fade(x, W, H, t, this.dur); }
    if (t < 5.5) { const s = Math.max(0.2, 1 - (t - 3) / 2.5); x.save(); x.translate(W / 2, H / 2); x.scale(s, s); text(x, 'REPO WARS', 0, 10, { size: 48, title: true, color: '#ffd166', align: 'center' }); x.restore(); return; }
    const LINES = ['Episode IV', 'A NEW BRANCH', '', 'It is a period of civil merge.', 'Rebel devs, striking from a', 'hidden fork, have won their', 'first victory against the evil', 'LEGACY MONOLITH.', '', 'Pursued by the dreaded', 'Lord Vader of Code Review,', 'Princess Lint races home...'];
    const off = (t - 5.5) * 12;
    LINES.forEach((ln, i) => { const y = H + 10 + i * 16 - off; if (y < 8 || y > H + 10) return; const k = y / H, s = 0.35 + k * 0.75;
      x.save(); x.translate(W / 2, y); x.scale(s, s); x.globalAlpha = Math.min(1, k * 2); text(x, ln, 0, 0, { color: '#ffd166', align: 'center', title: i < 2 }); x.restore(); });
    fade(x, W, H, t, this.dur);
  } },
];
