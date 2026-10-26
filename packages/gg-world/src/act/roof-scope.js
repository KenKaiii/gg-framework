// @ts-check
// Roof telescope: a stargazing mini-game. Pan the eyepiece with the arrows across a night sky; tonight's three
// targets (seeded by the date) are constellations, a satellite and something odd (a red roadster drifting past,
// a teapot, a blinking 'deploy' satellite). Centre a target and hold Space to log it. Log all three for coins once a
// day; a rare shooting star is a bonus. Progress for the day + nights logged are saved (localStorage, try/catch).
import { SFX } from '../sfx.js';
import { text, loop, keys, rng, coins } from './util.js';

const W = 320, H = 180, SKY = 900, SKYH = 420;
const ODD = [['red roadster', 'someone launched a car. respect.'], ['teapot', 'Russell was right.'], ['deploy satellite', 'it blinks every time prod breaks.'], ['whale', 'it is not a whale. it is a whale.']];
const CON = [['The Rubber Duck', [[0, 0], [10, -6], [22, -4], [28, 6], [16, 12], [4, 10]]], ['Big Merge', [[0, 0], [14, 4], [28, 0], [14, 18], [14, 4]]],
  ['The Kettle', [[0, 8], [8, 0], [20, 0], [28, 8], [20, 16], [8, 16], [0, 8]]], ['Semicolon', [[0, 0], [0, 4], [2, 16], [0, 24]]], ['Orion-ish', [[0, 0], [24, 2], [8, 14], [12, 16], [16, 18], [0, 34], [26, 32]]]];
const day = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
const load = () => { try { return JSON.parse(localStorage.getItem('nr-scope') || '{}'); } catch { return {}; } };
const save = s => { try { localStorage.setItem('nr-scope', JSON.stringify(s)); } catch { /* private mode */ } };

/** @param {any} ctx */
function start(ctx) {
  const ov = ctx.overlay({ title: 'Telescope', sub: 'the roof · tonight\'s sky', help: '<kbd>←↑↓→</kbd> pan <kbd>space</kbd> hold to log <kbd>drag</kbd> pan <kbd>hold click</kbd> log <kbd>esc</kbd> leave' });
  const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false; const k = keys(ov);
  const r = rng(day()), st = load(); if (st.day !== day()) { st.day = day(); st.found = []; st.paid = false; }
  const stars = Array.from({ length: 420 }, () => ({ x: r() * SKY, y: r() * SKYH, b: r(), s: r() < 0.08 ? 2 : 1 }));
  const con = CON[(r() * CON.length) | 0], odd = ODD[(r() * ODD.length) | 0];
  const targets = [
    { id: 'con', name: con[0], x: 120 + r() * 600, y: 60 + r() * 260, line: 'a constellation nobody else named.' },
    { id: 'sat', name: 'a satellite', x: 100 + r() * 700, y: 40 + r() * 300, line: 'probably running someone\'s cron job.', vx: 6 },
    { id: 'odd', name: odd[0], x: 100 + r() * 700, y: 50 + r() * 300, line: odd[1], vx: -3 },
  ];
  let cx = SKY / 2, cy = SKYH / 2, hold = 0, msg = '', msgT = 0, shoot = null, shake = 0;
  const say = (m, t = 2.6) => { msg = m; msgT = t; };
  // mouse: drag the sky to pan, hold the button to log (like holding space)
  let drag = null, mHeld = false; c.style.cursor = 'grab';
  c.addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); drag = [e.clientX, e.clientY]; mHeld = true; c.setPointerCapture?.(e.pointerId); c.style.cursor = 'grabbing'; });
  c.addEventListener('pointermove', e => { if (!drag) return; const b = c.getBoundingClientRect(); cx -= (e.clientX - drag[0]) / b.width * W; cy -= (e.clientY - drag[1]) / b.height * H; drag = [e.clientX, e.clientY]; });
  const mup = () => { drag = null; mHeld = false; c.style.cursor = 'grab'; }; c.addEventListener('pointerup', mup); c.addEventListener('pointercancel', mup);
  say(`tonight: ${con[0]}, a satellite, and... a ${odd[0]}?`, 4);
  loop(ov, (dt, t) => {
    const sp = 120 * dt; if (k.has('ArrowLeft')) cx -= sp; if (k.has('ArrowRight')) cx += sp; if (k.has('ArrowUp')) cy -= sp; if (k.has('ArrowDown')) cy += sp;
    cx = Math.max(60, Math.min(SKY - 60, cx)); cy = Math.max(50, Math.min(SKYH - 50, cy));
    for (const tg of targets) if (tg.vx) { tg.x += tg.vx * dt; if (tg.x < 40 || tg.x > SKY - 40) tg.vx *= -1; }
    if (!shoot && Math.random() < dt * 0.04) shoot = { x: cx - 80 + Math.random() * 160, y: cy - 60, life: 1.2 };
    // what's in the crosshair?
    let aim = null; for (const tg of targets) if (!st.found.includes(tg.id) && Math.hypot(tg.x - cx, tg.y - cy) < 16) aim = tg;
    const shot = shoot && Math.hypot(shoot.x - cx, shoot.y - cy) < 30;
    if ((k.has('Space') || mHeld) && (aim || shot)) hold += dt; else hold = Math.max(0, hold - dt * 2);
    if (hold > 0.9) { hold = 0; shake = 0.3; SFX.play(shot ? 'magic' : 'ping', { vol: 0.5 });
      if (shot) { shoot = null; coins(ctx.S).spend(-5); say('shooting star! made a wish: green CI. +5c'); }
      else if (aim) { st.found.push(aim.id); say(`logged ${aim.name}: ${aim.line}`, 3.4);
        if (st.found.length === 3 && !st.paid) { st.paid = true; st.nights = (st.nights || 0) + 1; SFX.play('success', { delay: 2.2 }); coins(ctx.S).spend(-15); setTimeout(() => say(`all three logged. night ${st.nights} in the book. +15c`, 4), 2200); }
        save(st); } }
    msgT -= dt; shake = Math.max(0, shake - dt);
    // draw the sky through the eyepiece
    const ox = cx - W / 2 + (shake ? (Math.random() - 0.5) * 3 : 0), oy = cy - H / 2;
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#070818'); g.addColorStop(1, '#1a1838'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = 'rgba(120,90,200,.08)'; x.beginPath(); x.ellipse(SKY * 0.55 - ox, SKYH * 0.5 - oy, 260, 50, -0.4, 0, 7); x.fill(); // milky way smear
    for (const s of stars) { const px = s.x - ox, py = s.y - oy; if (px < 0 || py < 0 || px > W || py > H) continue; const tw = 0.55 + 0.45 * Math.sin(t * 2 + s.b * 40);
      x.fillStyle = s.b > 0.9 ? `rgba(255,214,170,${tw})` : `rgba(210,220,255,${tw * 0.8})`; x.fillRect(px | 0, py | 0, s.s, s.s); }
    // targets
    const T0 = targets[0], cpx = T0.x - ox, cpy = T0.y - oy; const found = id => st.found.includes(id);
    x.strokeStyle = found('con') ? 'rgba(110,231,160,.8)' : 'rgba(200,210,255,.18)'; x.lineWidth = 1; x.beginPath();
    con[1].forEach(([a, b], i) => { const px = cpx - 14 + a, py = cpy - 10 + b; i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
    for (const [a, b] of con[1]) { x.fillStyle = '#fff6e0'; x.fillRect((cpx - 14 + a) | 0, (cpy - 10 + b) | 0, 2, 2); }
    const sat = targets[1], sx = sat.x - ox, sy = sat.y - oy; x.fillStyle = '#c8d0e8'; x.fillRect(sx - 1, sy, 3, 1); x.fillStyle = '#5a7ab8'; x.fillRect(sx - 4, sy, 2, 1); x.fillRect(sx + 3, sy, 2, 1); if ((t * 2 | 0) % 2) { x.fillStyle = '#ff5050'; x.fillRect(sx, sy - 1, 1, 1); }
    const od = targets[2], qx = (od.x - ox) | 0, qy = (od.y - oy) | 0;
    if (odd[0] === 'red roadster') { x.fillStyle = '#d23a3a'; x.fillRect(qx - 4, qy, 9, 2); x.fillRect(qx - 2, qy - 1, 4, 1); x.fillStyle = '#e8e8e8'; x.fillRect(qx - 1, qy - 2, 1, 1); }
    else if (odd[0] === 'teapot') { x.fillStyle = '#e8e0d0'; x.fillRect(qx - 3, qy - 2, 6, 4); x.fillRect(qx + 3, qy - 1, 2, 1); x.fillRect(qx - 5, qy - 1, 2, 2); x.fillRect(qx - 1, qy - 3, 2, 1); }
    else if (odd[0] === 'deploy satellite') { x.fillStyle = (t * 3 | 0) % 2 ? '#3ddc84' : '#ff4fd8'; x.fillRect(qx - 1, qy - 1, 3, 3); x.fillStyle = '#9aa'; x.fillRect(qx - 5, qy, 3, 1); x.fillRect(qx + 3, qy, 3, 1); }
    else { x.fillStyle = '#6a7ab8'; x.fillRect(qx - 6, qy - 1, 10, 3); x.fillRect(qx + 4, qy - 2, 2, 1); x.fillRect(qx + 4, qy + 2, 2, 1); x.fillStyle = '#fff'; x.fillRect(qx - 4, qy - 1, 1, 1); }
    if (shoot) { shoot.life -= dt; shoot.x += 160 * dt; shoot.y += 70 * dt; const px = shoot.x - ox, py = shoot.y - oy; x.strokeStyle = `rgba(255,240,200,${Math.max(0, shoot.life)})`; x.beginPath(); x.moveTo(px, py); x.lineTo(px - 18, py - 8); x.stroke(); if (shoot.life <= 0) shoot = null; }
    // eyepiece: round vignette + crosshair + hold ring
    x.fillStyle = '#05050c'; x.beginPath(); x.rect(0, 0, W, H); x.arc(W / 2, H / 2, 82, 0, Math.PI * 2, true); x.fill();
    x.strokeStyle = 'rgba(224,164,88,.6)'; x.beginPath(); x.arc(W / 2, H / 2, 82, 0, 7); x.stroke();
    x.strokeStyle = aim || shot ? '#6ee7a0' : 'rgba(224,164,88,.5)'; x.beginPath(); x.moveTo(W / 2 - 10, H / 2); x.lineTo(W / 2 - 3, H / 2); x.moveTo(W / 2 + 3, H / 2); x.lineTo(W / 2 + 10, H / 2); x.moveTo(W / 2, H / 2 - 10); x.lineTo(W / 2, H / 2 - 3); x.moveTo(W / 2, H / 2 + 3); x.lineTo(W / 2, H / 2 + 10); x.stroke();
    // a faint arrow on the rim points to the nearest target not logged yet (so it's a hunt, not a needle in a haystack)
    let nb = null, nd = 1e9; for (const tg of targets) if (!found(tg.id)) { const d = Math.hypot(tg.x - cx, tg.y - cy); if (d < nd) { nd = d; nb = tg; } }
    if (nb && nd > 70) { const a = Math.atan2(nb.y - cy, nb.x - cx), ax = W / 2 + Math.cos(a) * 74, ay = H / 2 + Math.sin(a) * 74;
      x.fillStyle = `rgba(255,214,150,${0.75 + 0.25 * Math.sin(t * 5)})`; x.beginPath(); x.moveTo(ax + Math.cos(a) * 8, ay + Math.sin(a) * 8); x.lineTo(ax + Math.cos(a + 2.5) * 6, ay + Math.sin(a + 2.5) * 6); x.lineTo(ax + Math.cos(a - 2.5) * 6, ay + Math.sin(a - 2.5) * 6); x.fill(); }
    if (hold > 0) { x.strokeStyle = '#6ee7a0'; x.lineWidth = 2; x.beginPath(); x.arc(W / 2, H / 2, 16, -Math.PI / 2, -Math.PI / 2 + (hold / 0.9) * Math.PI * 2); x.stroke(); x.lineWidth = 1; }
    // logbook on the left, line at the bottom
    text(x, 'LOG', 8, 14, { size: 16, title: true, color: '#e0a458' });
    targets.forEach((tg, i) => text(x, (found(tg.id) ? '[x] ' : '[ ] ') + tg.name, 8, 30 + i * 12, { size: 16, color: found(tg.id) ? '#6ee7a0' : '#8e9a88' }));
    if (aim) text(x, 'hold space', W / 2, H / 2 + 30, { size: 16, color: '#6ee7a0', align: 'center', shadow: '#000' });
    if (msgT > 0) text(x, msg, W / 2, H - 8, { size: 16, color: '#ffe2b0', align: 'center', shadow: '#000' });
  });
}

export default [{ id: 'roof-scope', label: 'Telescope', match: (it, R) => R.id === 'roof' && it.id === 'telescope', start }];
