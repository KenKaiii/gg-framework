// @ts-check
// Club Cyberdelia activity helpers: safe localStorage, the player's hacker handle, today's seed, neon backdrop.
export const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch { return d; } };
export const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage off */ } };
/** @param {any} S */
export const handle = S => load('cyb-handle', null) || (S?.player?.name ? String(S.player.name).toUpperCase().slice(0, 12) : 'ANON');
export const today = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
/** Dark grid backdrop with scanlines. @param {CanvasRenderingContext2D} x */
export function backdrop(x, W, H, t = 0, tint = '#3ff0ff') {
  x.fillStyle = '#0b0a16'; x.fillRect(0, 0, W, H);
  x.strokeStyle = tint; x.globalAlpha = 0.12; x.beginPath();
  for (let i = 0; i <= W; i += 16) { x.moveTo(i + 0.5, 0); x.lineTo(i + 0.5, H); }
  for (let j = (t * 8) % 16; j <= H; j += 16) { x.moveTo(0, j + 0.5); x.lineTo(W, j + 0.5); }
  x.stroke(); x.globalAlpha = 1;
}
export function scan(x, W, H) { x.fillStyle = 'rgba(0,0,0,0.22)'; for (let y = 0; y < H; y += 2) x.fillRect(0, y, W, 1); }
