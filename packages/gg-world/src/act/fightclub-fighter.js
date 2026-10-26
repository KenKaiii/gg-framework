// @ts-check
// Pixel-art fighters + basement backdrop for the sparring overlay. Art pixels are 2x2 canvas pixels; every part gets a
// dark outline, a base tone, a shade band and a highlight. Poses: guard, wind, jab, block, dodge, hit, down, open.
const U = 2, OL = '#140e10';

/** One outlined, 3-tone part (art px, relative to the fighter origin). */
function part(x, px, py, w, h, base, shade, hi) {
  x.fillStyle = OL; x.fillRect((px - 1) * U, (py - 1) * U, (w + 2) * U, (h + 2) * U);
  x.fillStyle = base; x.fillRect(px * U, py * U, w * U, h * U);
  if (shade && w > 1) { x.fillStyle = shade; x.fillRect((px + Math.ceil(w * 0.6)) * U, py * U, Math.floor(w * 0.4) * U, h * U); x.fillRect(px * U, (py + h - 1) * U, w * U, U); }
  if (hi) { x.fillStyle = hi; x.fillRect(px * U, py * U, Math.max(1, w - 1) * U, U); }
}
/** Wrapped fist: tan wrap with white tape stripes. */
function fist(x, px, py) { part(x, px, py, 5, 5, '#e8dcc0', '#b8a888', '#fff8e8'); x.fillStyle = '#c8b898'; x.fillRect(px * U, (py + 2) * U, 5 * U, U); }

/**
 * @param {CanvasRenderingContext2D} x @param {number} cx @param {number} gy ground y (canvas px) @param {number} dir 1 faces right
 * @param {string} pose @param {number} t @param {{top:string,topS:string,topH:string,skin:string,skinS:string,hair:string,pants:string,pantsS:string}} c
 */
export function drawFighter(x, cx, gy, dir, pose, t, c) {
  x.save(); x.translate(Math.round(cx), Math.round(gy)); x.scale(dir, 1);
  const idle = pose === 'guard' ? Math.floor(t * 3) % 2 : 0; // 2-frame idle: weight shift
  const bob = pose === 'down' ? 0 : Math.round(Math.sin(t * 7) * 1) + idle;
  let lean = 0, crouch = 0, tilt = 0;
  if (pose === 'jab') lean = 4; if (pose === 'hit') { lean = -5; tilt = -0.12; } if (pose === 'wind') lean = -3;
  if (pose === 'dodge') crouch = 9; if (pose === 'down') tilt = -1.45;
  if (pose === 'hit' || pose === 'down') { const w = pose === 'down' ? 0 : Math.sin(t * 40) * 1.5; x.translate(w * U, 0); }
  if (pose === 'down') x.translate(0, 16);
  if (tilt) { x.translate(-6 * U, 0); x.rotate(tilt); x.translate(6 * U, 0); }
  // legs + boots (stance)
  const ly = -20 + crouch;
  part(x, -8, ly, 6, 16 - crouch, c.pants, c.pantsS, null); part(x, 2, ly, 6, 16 - crouch, c.pants, c.pantsS, null);
  x.fillStyle = c.pantsS; x.fillRect(-6 * U, (ly + 6) * U, 2 * U, U); x.fillRect(4 * U, (ly + 9) * U, 2 * U, U); // folds
  part(x, -10, -5, 8, 5, '#3a2a22', '#22180f', '#5a4434'); part(x, 2, -5, 8, 5, '#3a2a22', '#22180f', '#5a4434');
  x.translate((lean + idle) * U, (crouch + bob) * U);
  // torso: tank top with folds, belt
  part(x, -8, -38, 16, 18, c.top, c.topS, c.topH);
  x.fillStyle = c.topS; x.fillRect(-4 * U, -30 * U, 3 * U, U); x.fillRect(1 * U, -26 * U, 4 * U, U);
  x.fillStyle = c.skin; x.fillRect(-5 * U, -38 * U, 3 * U, 2 * U); x.fillRect(2 * U, -38 * U, 3 * U, 2 * U); // tank straps show shoulders
  part(x, -8, -21, 16, 2, '#2a2020', null, '#4a3a30');
  // back arm (behind, shoulder at -6,-36)
  const ar = { guard: [[3, -33], [9, -38]], wind: [[-8, -36], [-12, -40]], jab: [[10, -35], [18, -36]], block: [[2, -42], [6, -48]], dodge: [[4, -32], [9, -36]], hit: [[-2, -30], [-6, -28]], open: [[-4, -26], [-8, -22]], down: [[-6, -30], [-10, -26]] }[pose] || [[3, -33], [9, -38]];
  const fr = { guard: [5, -36], wind: [-14, -42], jab: [19, -37], block: [8, -48], dodge: [9, -38], hit: [-8, -30], open: [-10, -22], down: [-12, -28] }[pose] || [5, -36];
  // rear arm (guard near chin)
  part(x, 2, -36, 4, 7, c.skin, c.skinS, null); fist(x, fr[0] - 6, fr[1] + 4);
  // head: skin, hair, eye, brow, mouth
  const hx = -6, hy = -50;
  part(x, hx, hy, 12, 12, c.skin, c.skinS, null);
  part(x, hx, hy - 2, 12, 4, c.hair, null, null); x.fillStyle = c.hair; x.fillRect((hx - 1) * U, hy * U, 3 * U, 5 * U);
  const ko = pose === 'down', ouch = pose === 'hit' || ko;
  x.fillStyle = OL;
  if (ouch) { x.fillRect(2 * U, (hy + 4) * U, 3 * U, U); x.fillRect(3 * U, (hy + 3) * U, U, 3 * U); } else { x.fillRect(2 * U, (hy + 4) * U, 2 * U, 2 * U); }
  x.fillRect(1 * U, (hy + 2) * U, 4 * U, U);
  x.fillRect(1 * U, (hy + 8) * U, (ouch ? 4 : 3) * U, U);
  if (pose === 'hit') { x.fillStyle = '#e88a8a'; x.fillRect(3 * U, (hy + 6) * U, 2 * U, U); }
  // lead arm (front)
  part(x, ar[0][0] - 2, ar[0][1], Math.max(4, Math.abs(ar[1][0] - ar[0][0]) + 2), 4, c.skin, c.skinS, null);
  fist(x, ar[1][0], ar[1][1]);
  if (pose === 'jab') { x.fillStyle = 'rgba(255,240,200,0.7)'; for (let i = 0; i < 3; i++) x.fillRect((10 + i * 3) * U, (-40 + i * 3) * U, 3 * U, U); }
  x.restore();
  if (pose === 'down') for (let i = 0; i < 4; i++) { const a = t * 5 + i * 1.57; star(x, cx - dir * 96 + Math.cos(a) * 16, gy - 26 + Math.sin(a) * 5); }
}
function star(x, px, py) { px = Math.round(px / 2) * 2; py = Math.round(py / 2) * 2; x.fillStyle = OL; x.fillRect(px - 4, py - 2, 10, 6); x.fillRect(px - 2, py - 4, 6, 10); x.fillStyle = '#ffe14a'; x.fillRect(px - 2, py, 6, 2); x.fillRect(px, py - 2, 2, 6); }

/** Basement backdrop: concrete block wall, pipes, bare bulb + cone, ring floor. */
export function drawBackdrop(x, W, H, t, sway) {
  x.fillStyle = '#5a5450'; x.fillRect(0, 0, W, H);
  for (let r = 0; r < 12; r++) for (let k = 0; k < 14; k++) { const ox = (r % 2) * 20; x.fillStyle = (r * 7 + k * 3) % 5 ? '#625c56' : '#6a645c'; x.fillRect(k * 40 - ox + 1, r * 18 + 1, 38, 16); }
  x.fillStyle = 'rgba(40,30,24,0.25)'; x.fillRect(60, 40, 14, 150); x.fillRect(380, 60, 10, 120);
  // pipes
  for (const [y, col, sh] of [[50, '#8a6a4a', '#5a4430'], [64, '#6a7478', '#444c50']]) { x.fillStyle = OL; x.fillRect(0, y - 1, W, 10); x.fillStyle = col; x.fillRect(0, y, W, 8); x.fillStyle = sh; x.fillRect(0, y + 5, W, 3); x.fillStyle = 'rgba(255,255,255,0.25)'; x.fillRect(0, y + 1, W, 1); for (let k = 30; k < W; k += 110) { x.fillStyle = OL; x.fillRect(k, y - 3, 8, 14); x.fillStyle = sh; x.fillRect(k + 1, y - 2, 6, 12); } }
  x.fillStyle = OL; x.fillRect(420, 72, 10, 126); x.fillStyle = '#6a7478'; x.fillRect(421, 72, 8, 126); x.fillStyle = '#444c50'; x.fillRect(426, 72, 3, 126);
  // floor
  x.fillStyle = '#8a847a'; x.fillRect(0, 196, W, H - 196); x.fillStyle = '#6e685e'; x.fillRect(0, 196, W, 4);
  x.fillStyle = 'rgba(60,44,30,0.3)'; x.fillRect(120, 230, 40, 6); x.fillRect(330, 250, 30, 4);
  x.fillStyle = '#ece6d0'; for (let k = 70; k < 410; k += 26) x.fillRect(k, 222, 20, 3);
  // bulb + cone
  const bx = 240 + Math.round(sway * 6);
  x.fillStyle = OL; x.fillRect(239, 0, 2, 54); x.fillRect(bx - 12, 54, 24, 8); x.fillStyle = '#7a7e82'; x.fillRect(bx - 11, 55, 22, 6);
  x.fillStyle = '#fff2c0'; x.fillRect(bx - 4, 62, 8, 7);
  x.save(); x.globalCompositeOperation = 'lighter'; const g = x.createLinearGradient(0, 62, 0, 240); g.addColorStop(0, 'rgba(255,226,160,0.35)'); g.addColorStop(1, 'rgba(255,226,160,0.05)');
  x.fillStyle = g; x.beginPath(); x.moveTo(bx - 6, 62); x.lineTo(bx + 6, 62); x.lineTo(bx + 170, 240); x.lineTo(bx - 170, 240); x.closePath(); x.fill();
  const rg = x.createRadialGradient(bx, 230, 10, bx, 230, 170); rg.addColorStop(0, 'rgba(255,226,160,0.3)'); rg.addColorStop(1, 'rgba(255,226,160,0)'); x.fillStyle = rg; x.fillRect(0, 160, W, 110); x.restore();
}

/** Crowd silhouettes along the bottom edge; hype 0..1 makes them jump and raise fists. */
export function drawCrowd(x, W, H, t, hype) {
  for (let i = 0; i < 16; i++) {
    const px = i * 31 - 6 + (i % 3) * 4, jump = Math.max(0, Math.sin(t * 9 + i * 1.7)) * (2 + hype * 8), y = H - 26 - Math.round(jump) + (i % 2) * 6;
    x.fillStyle = i % 2 ? '#1c1418' : '#261c20';
    x.fillRect(px, y, 24, 40); x.fillRect(px + 5, y - 13, 14, 14);
    if (hype > 0.2 && (i + Math.floor(t * 4)) % 3 === 0) x.fillRect(px + (i % 2 ? 20 : 0), y - 22, 5, 22);
    x.fillStyle = 'rgba(255,200,140,0.18)'; x.fillRect(px + 5, y - 13, 14, 2);
  }
}

/** Dust puffs. */
export function dust() {
  /** @type {{x:number,y:number,vx:number,vy:number,t:number}[]} */ const D = [];
  return {
    burst(px, py, n = 10) { for (let i = 0; i < n; i++) D.push({ x: px, y: py, vx: (Math.random() - 0.5) * 120, vy: -Math.random() * 60, t: 0 }); },
    draw(x, dt) { for (let i = D.length - 1; i >= 0; i--) { const d = D[i]; d.t += dt; if (d.t > 0.7) { D.splice(i, 1); continue; } d.x += d.vx * dt; d.y += d.vy * dt; d.vy += 80 * dt; const s = 2 + Math.round(d.t * 6) * 2; x.fillStyle = `rgba(220,210,190,${0.6 * (1 - d.t / 0.7)})`; x.fillRect(Math.round(d.x / 2) * 2, Math.round(d.y / 2) * 2, s, s); } },
  };
}
