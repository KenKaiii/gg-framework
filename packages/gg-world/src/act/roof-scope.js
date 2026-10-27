// @ts-check
// Roof telescope, rebuilt on the GX kit: a real eyepiece, close up. The sky is a hi-DPI canvas sized to its CSS box
// (smooth stars at screen resolution) inside a circular brass eyepiece with a soft vignette; logbook + messages are
// GX plates in Sora. Rules as before: pan with arrows/drag, centre a target, hold Space/click to log it; all three for
// +15c once a day; a shooting star is +5c. State in 'nr-scope' (same key).
import { gx, svg as S, GX } from './gx.js';
import { SFX } from '../sfx.js';
import { loop, keys, rng, coins } from './util.js';

const SKY = 900, SKYH = 420, VIEW = 200; // sky units visible across the eyepiece
const ODD = [['red roadster', 'someone launched a car. respect.'], ['teapot', 'Russell was right.'], ['deploy satellite', 'it blinks every time prod breaks.'], ['whale', 'it is not a whale. it is a whale.']];
const CON = [['The Rubber Duck', [[0, 0], [10, -6], [22, -4], [28, 6], [16, 12], [4, 10]]], ['Big Merge', [[0, 0], [14, 4], [28, 0], [14, 18], [14, 4]]],
  ['The Kettle', [[0, 8], [8, 0], [20, 0], [28, 8], [20, 16], [8, 16], [0, 8]]], ['Semicolon', [[0, 0], [0, 4], [2, 16], [0, 24]]], ['Orion-ish', [[0, 0], [24, 2], [8, 14], [12, 16], [16, 18], [0, 34], [26, 32]]]];
const day = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
const load = () => { try { return JSON.parse(localStorage.getItem('nr-scope') || '{}'); } catch { return {}; } };
const save = s => { try { localStorage.setItem('nr-scope', JSON.stringify(s)); } catch { /* private mode */ } };

/** @param {any} ctx */
function start(ctx) {
  const ov = ctx.overlay({ title: 'Telescope', sub: 'the roof · tonight\'s sky', help: '<kbd>←↑↓→</kbd> / <kbd>drag</kbd> pan <kbd>space</kbd> / <kbd>hold click</kbd> log' });
  const K = gx(ov), k = keys(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const r = rng(day()), st = load(); if (st.day !== day()) { st.day = day(); st.found = []; st.paid = false; }
  const stars = Array.from({ length: 520 }, () => ({ x: r() * SKY, y: r() * SKYH, b: r(), s: r() < 0.08 ? 1.6 : r() < 0.4 ? 1 : 0.6 }));
  const con = CON[(r() * CON.length) | 0], odd = ODD[(r() * ODD.length) | 0];
  const targets = [
    { id: 'con', name: con[0], x: 120 + r() * 600, y: 60 + r() * 260, line: 'a constellation nobody else named.' },
    { id: 'sat', name: 'a satellite', x: 100 + r() * 700, y: 40 + r() * 300, line: 'probably running someone\'s cron job.', vx: 6 },
    { id: 'odd', name: odd[0], x: 100 + r() * 700, y: 50 + r() * 300, line: odd[1], vx: -3 },
  ];
  const found = id => st.found.includes(id);
  const hud = K.hud([{ id: 'log', label: 'Logged tonight', value: `${st.found.length} / 3`, tone: 'teal' }], [{ id: 'nights', label: 'Nights logged', value: st.nights || 0, tone: 'gold' }]);
  const scene = K.scene({ aspect: 1.6 });

  // eyepiece: canvas sky inside a circle, brass barrel + vignette in SVG on top
  const cv = document.createElement('canvas'); Object.assign(cv.style, { position: 'absolute', borderRadius: '50%', cursor: 'grab', touchAction: 'none' }); scene.appendChild(cv);
  const x = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  const ring = S('svg', { viewBox: '-100 -100 200 200' }, scene); Object.assign(ring.style, { position: 'absolute', overflow: 'visible', pointerEvents: 'none' });
  ring.innerHTML = `<defs><radialGradient id="gxs-vig" r="0.5"><stop offset="0.72" stop-color="#000" stop-opacity="0"/><stop offset="0.93" stop-color="#000" stop-opacity="0.7"/><stop offset="1" stop-color="#000"/></radialGradient>
    <linearGradient id="gxs-brass" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#ffe6a6"/><stop offset="0.35" stop-color="#c88a34"/><stop offset="0.7" stop-color="#6b4317"/><stop offset="1" stop-color="#2c1a08"/></linearGradient>
    <linearGradient id="gxs-glint" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bcd4ff" stop-opacity="0.14"/><stop offset="0.5" stop-color="#bcd4ff" stop-opacity="0"/></linearGradient>
    <filter id="gxs-sh" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter></defs>
    <circle r="112" fill="#000" opacity="0.55" filter="url(#gxs-sh)" cy="8"/>
    <circle r="100" fill="url(#gxs-vig)"/>
    <circle r="105" fill="none" stroke="url(#gxs-brass)" stroke-width="11"/>
    <circle r="110.5" fill="none" stroke="#1a0f05" stroke-width="1.2" stroke-dasharray="1.2 1.6" opacity="0.7"/>
    <circle r="99.6" fill="none" stroke="#000" stroke-width="1.5"/>
    <ellipse cx="-38" cy="-52" rx="46" ry="16" transform="rotate(-32 -38 -52)" fill="url(#gxs-glint)"/>`;
  const cross = S('g', { stroke: GX.lamp, 'stroke-opacity': 0.55, 'stroke-width': 0.6, 'stroke-linecap': 'round' }, ring);
  S('path', { d: 'M-14 0h9M5 0h9M0 -14v9M0 5v9' }, cross); S('circle', { r: 22, fill: 'none', 'stroke-opacity': 0.18 }, cross);
  const holdArc = S('circle', { r: 18, fill: 'none', stroke: GX.success, 'stroke-width': 1.6, transform: 'rotate(-90)', 'stroke-dasharray': '0 200', 'stroke-linecap': 'round' }, ring);
  const arrow = S('path', { d: 'M0 -5L4 3L-4 3Z', fill: GX.lamp, opacity: 0 }, ring);

  // logbook card + message line (DOM, Sora)
  const book = document.createElement('div'); book.className = 'gx-plate';
  Object.assign(book.style, { position: 'absolute', left: '0', top: '0', minWidth: '180px', padding: '12px 16px 14px', fontSize: '13px', lineHeight: '1.8' }); scene.appendChild(book);
  const msgEl = document.createElement('div'); msgEl.className = 'gx-plate';
  Object.assign(msgEl.style, { position: 'absolute', left: '50%', bottom: '0', transform: 'translateX(-50%)', fontSize: '14px', fontWeight: '600', color: GX.lamp, whiteSpace: 'nowrap', transition: 'opacity .4s' }); scene.appendChild(msgEl);
  const drawBook = () => {
    book.innerHTML = `<span class="l">Logbook</span>` + targets.map(t => `<div style="color:${found(t.id) ? GX.success : GX.text2}">${found(t.id) ? '✓' : '○'}&nbsp; ${t.name}</div>`).join('');
    hud.set('log', `${st.found.length} / 3`); hud.set('nights', st.nights || 0);
  };
  drawBook();
  let msgT = 0; const say = (m, t = 2.6) => { msgEl.textContent = m; msgT = t; };

  let D = 0, dpr = 1;
  const layout = () => {
    const w = scene.clientWidth, h = scene.clientHeight; D = Math.min(h * 0.9, w * 0.62); dpr = devicePixelRatio || 1;
    Object.assign(cv.style, { width: D + 'px', height: D + 'px', left: (w - D) / 2 + 'px', top: (h - D) / 2 - h * 0.02 + 'px' });
    Object.assign(ring.style, { width: D + 'px', height: D + 'px', left: cv.style.left, top: cv.style.top });
    const room = (w - D) / 2 - book.offsetWidth - 24; book.style.left = Math.max(0, room) + 'px'; book.style.top = room >= 0 ? (h - D) / 2 + 'px' : '0px'; book.style.transform = room >= 0 ? '' : `translateX(${Math.round(room)}px)`;
    cv.width = Math.round(D * dpr); cv.height = Math.round(D * dpr);
  };
  layout(); requestAnimationFrame(layout); addEventListener('resize', layout); ov.onClose(() => removeEventListener('resize', layout));

  let cx = SKY / 2, cy = SKYH / 2, hold = 0, shoot = null, shake = 0, playing = false;
  let drag = null, mHeld = false;
  cv.addEventListener('pointerdown', e => { if (e.button !== 0 || !playing) return; e.preventDefault(); drag = [e.clientX, e.clientY]; mHeld = true; cv.setPointerCapture?.(e.pointerId); cv.style.cursor = 'grabbing'; });
  cv.addEventListener('pointermove', e => { if (!drag) return; const u = VIEW / D; cx -= (e.clientX - drag[0]) * u; cy -= (e.clientY - drag[1]) * u; drag = [e.clientX, e.clientY]; });
  const mup = () => { drag = null; mHeld = false; cv.style.cursor = 'grab'; }; cv.addEventListener('pointerup', mup); cv.addEventListener('pointercancel', mup);

  let bgH = 0, bgG = /** @type {CanvasGradient | string} */ ('#0b0d24'); // built once per canvas size
  const bgGrad = h => { if (h !== bgH) { bgH = h; const g = x.createRadialGradient(h / 2, h * 0.4, 0, h / 2, h / 2, h * 0.7); g.addColorStop(0, '#1a1f48'); g.addColorStop(1, '#070818'); bgG = g; } return bgG; };
  loop(ov, (dt, t) => {
    if (playing) { const sp = 120 * dt; if (k.has('ArrowLeft')) cx -= sp; if (k.has('ArrowRight')) cx += sp; if (k.has('ArrowUp')) cy -= sp; if (k.has('ArrowDown')) cy += sp; }
    cx = Math.max(60, Math.min(SKY - 60, cx)); cy = Math.max(50, Math.min(SKYH - 50, cy));
    for (const tg of targets) if (tg.vx) { tg.x += tg.vx * dt; if (tg.x < 40 || tg.x > SKY - 40) tg.vx *= -1; }
    if (playing && !shoot && Math.random() < dt * 0.04) shoot = { x: cx - 80 + Math.random() * 160, y: cy - 60, life: 1.2 };
    let aim = null; for (const tg of targets) if (!found(tg.id) && Math.hypot(tg.x - cx, tg.y - cy) < 16) aim = tg;
    const shot = shoot && Math.hypot(shoot.x - cx, shoot.y - cy) < 30;
    if (playing && (k.has('Space') || mHeld) && (aim || shot)) hold += dt; else hold = Math.max(0, hold - dt * 2);
    if (hold > 0.9) { hold = 0; shake = 0.3; SFX.play(shot ? 'magic' : 'ping', { vol: 0.5 });
      const rc = cv.getBoundingClientRect(), px = rc.left + rc.width / 2, py = rc.top + rc.height / 2 - 30;
      if (shot) { shoot = null; coins(ctx.S).spend(-5); say('Shooting star! Made a wish: green CI. +5c'); K.pop(px, py, '+5c', 'gold'); K.swell(); }
      else if (aim) { st.found.push(aim.id); say(`Logged ${aim.name}: ${aim.line}`, 3.4); K.pop(px, py, aim.name, 'up');
        if (st.found.length === 3 && !st.paid) { st.paid = true; st.nights = (st.nights || 0) + 1; SFX.play('success', { delay: 2.2 }); coins(ctx.S).spend(-15); K.swell();
          setTimeout(() => { if (ov.el.isConnected) { say(`All three logged. Night ${st.nights} in the book. +15c`, 4); K.pop(px, py, '+15c', 'gold'); } }, 2200); }
        save(st); drawBook(); } }
    msgT -= dt; msgEl.style.opacity = msgT > 0 ? '1' : '0'; shake = Math.max(0, shake - dt);

    // the sky, at screen resolution: 1 sky unit = s px
    const s = (D * dpr) / VIEW, W = cv.width, H = cv.height;
    const ox = cx - VIEW / 2 + (shake && !reduce ? (Math.random() - 0.5) * 1.5 : 0), oy = cy - VIEW / 2;
    x.setTransform(1, 0, 0, 1, 0, 0); x.fillStyle = bgGrad(H); x.fillRect(0, 0, W, H);
    x.setTransform(s, 0, 0, s, -ox * s, -oy * s);
    x.fillStyle = 'rgba(120,90,200,.07)'; x.beginPath(); x.ellipse(SKY * 0.55, SKYH * 0.5, 260, 50, -0.4, 0, 7); x.fill();
    x.fillStyle = 'rgba(70,110,200,.05)'; x.beginPath(); x.ellipse(SKY * 0.5, SKYH * 0.52, 300, 26, -0.38, 0, 7); x.fill();
    for (const p of stars) { if (p.x < ox - 2 || p.y < oy - 2 || p.x > ox + VIEW + 2 || p.y > oy + VIEW + 2) continue;
      const tw = reduce ? 0.8 : 0.6 + 0.4 * Math.sin(t * 0.9 + p.b * 40);
      x.globalAlpha = Math.min(1, tw * (0.6 + p.b * 0.6)); x.fillStyle = p.b > 0.9 ? '#ffd9b0' : '#dde5ff'; x.beginPath(); x.arc(p.x, p.y, p.s * 0.6, 0, 7); x.fill(); }
    x.globalAlpha = 1;
    const T0 = targets[0]; x.lineWidth = 0.35; x.strokeStyle = found('con') ? 'rgba(127,220,149,.85)' : 'rgba(200,210,255,.28)'; x.beginPath();
    con[1].forEach(([a, b], i) => { const px = T0.x - 14 + a, py = T0.y - 10 + b; i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
    for (const [a, b] of con[1]) { x.fillStyle = 'rgba(255,240,210,.25)'; x.beginPath(); x.arc(T0.x - 14 + a, T0.y - 10 + b, 2.2, 0, 7); x.fill(); x.fillStyle = '#fff6e0'; x.beginPath(); x.arc(T0.x - 14 + a, T0.y - 10 + b, 0.9, 0, 7); x.fill(); }
    const sat = targets[1]; x.fillStyle = '#c8d0e8'; x.fillRect(sat.x - 1, sat.y - 0.6, 2, 1.2); x.fillStyle = '#5a7ab8'; x.fillRect(sat.x - 4, sat.y - 0.5, 2.4, 1); x.fillRect(sat.x + 1.6, sat.y - 0.5, 2.4, 1);
    x.fillStyle = `rgba(255,90,90,${0.5 + 0.5 * Math.sin(t * 3)})`; x.beginPath(); x.arc(sat.x, sat.y - 1.2, 0.5, 0, 7); x.fill();
    const od = targets[2], qx = od.x, qy = od.y;
    if (odd[0] === 'red roadster') { x.fillStyle = '#d23a3a'; x.beginPath(); x.roundRect(qx - 4, qy, 9, 2, 0.8); x.fill(); x.beginPath(); x.roundRect(qx - 2, qy - 1.2, 4, 1.4, 0.6); x.fill(); x.fillStyle = '#e8e8e8'; x.beginPath(); x.arc(qx - 0.5, qy - 1.8, 0.6, 0, 7); x.fill(); }
    else if (odd[0] === 'teapot') { x.fillStyle = '#e8e0d0'; x.beginPath(); x.ellipse(qx, qy, 3.2, 2.2, 0, 0, 7); x.fill(); x.fillRect(qx + 2.6, qy - 1, 2.4, 0.8); x.beginPath(); x.arc(qx - 3.6, qy, 1.2, 0, 7); x.fill(); x.beginPath(); x.arc(qx, qy - 2.6, 0.7, 0, 7); x.fill(); }
    else if (odd[0] === 'deploy satellite') { x.fillStyle = Math.sin(t * 2) > 0 ? '#7fdc95' : '#ff5fd2'; x.beginPath(); x.arc(qx, qy, 1.4, 0, 7); x.fill(); x.fillStyle = '#9aa'; x.fillRect(qx - 5, qy - 0.4, 3, 0.8); x.fillRect(qx + 2, qy - 0.4, 3, 0.8); }
    else { x.fillStyle = '#6a7ab8'; x.beginPath(); x.ellipse(qx - 1, qy, 5, 1.6, 0, 0, 7); x.fill(); x.beginPath(); x.moveTo(qx + 3.5, qy); x.lineTo(qx + 6, qy - 2); x.lineTo(qx + 6, qy + 2); x.fill(); x.fillStyle = '#fff'; x.beginPath(); x.arc(qx - 4, qy - 0.4, 0.4, 0, 7); x.fill(); }
    if (shoot) { shoot.life -= dt; shoot.x += 160 * dt; shoot.y += 70 * dt; const g = x.createLinearGradient(shoot.x, shoot.y, shoot.x - 18, shoot.y - 8); g.addColorStop(0, `rgba(255,240,200,${Math.max(0, shoot.life)})`); g.addColorStop(1, 'rgba(255,240,200,0)'); x.strokeStyle = g; x.lineWidth = 0.6; x.beginPath(); x.moveTo(shoot.x, shoot.y); x.lineTo(shoot.x - 18, shoot.y - 8); x.stroke(); if (shoot.life <= 0) shoot = null; }

    // eyepiece overlay state
    cross.setAttribute('stroke', aim || shot ? GX.success : GX.lamp);
    holdArc.setAttribute('stroke-dasharray', `${(hold / 0.9) * 113} 200`);
    let nb = null, nd = 1e9; for (const tg of targets) if (!found(tg.id)) { const d = Math.hypot(tg.x - cx, tg.y - cy); if (d < nd) { nd = d; nb = tg; } }
    if (nb && nd > 70 && playing) { const a = Math.atan2(nb.y - cy, nb.x - cx); arrow.setAttribute('transform', `translate(${Math.cos(a) * 88} ${Math.sin(a) * 88}) rotate(${a * 180 / Math.PI + 90})`); arrow.setAttribute('opacity', String(0.7 + 0.3 * Math.sin(t * 2.5))); }
    else arrow.setAttribute('opacity', '0');
    if (aim && msgT <= 0) { msgEl.textContent = `Hold Space to log ${aim.name}`; msgEl.style.opacity = '1'; }
  });
  K.card({ title: 'Telescope', kicker: 'Tonight\'s sky', text: `Find ${con[0]}, a satellite, and... a ${odd[0]}? Centre each one and hold to log it.`, how: [[['←↑↓→', 'Drag'], 'pan'], [['Space', 'Hold click'], 'log']], cta: 'Look', onGo: () => { playing = true; say(st.paid ? 'Already logged tonight. Enjoy the view.' : `Tonight: ${con[0]}, a satellite, and a ${odd[0]}.`, 4); } });
}

export default [{ id: 'roof-scope', label: 'Telescope', match: (it, R) => R.id === 'roof' && it.id === 'telescope', start }];
