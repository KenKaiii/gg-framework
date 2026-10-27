// @ts-check
// Sparring (GX kit: a basement ring under one bare bulb, two SVG fighters): a cartoony timing duel vs a cocky NPC. Read the wind-up, then block (high), dodge (low) or jab (open guard).
// No blood: a knock-down is a comic stagger with stars. Win streak + best saved.
import { loop } from './util.js';
import { SFX } from '../sfx.js';
import { load, save, AMBER, GREEN } from './fightclub-util.js';
import { gx, svg as S, GX } from './gx.js';
const YOU = { top: '#e8e4dc', topS: '#b0aca4', topH: '#ffffff', skin: '#e8b890', skinS: '#c08a64', hair: '#5a3a22', pants: '#4a5a7a', pantsS: '#34405a' };
const TYR = { top: '#c0402a', topS: '#8a2a1a', topH: '#e86a4a', skin: '#c88a5a', skinS: '#9a6440', hair: '#e0c060', pants: '#2a2a30', pantsS: '#18181c' };

const MOVES = { high: { key: 'block', tip: 'HIGH! block', c: AMBER }, low: { key: 'dodge', tip: 'LOW! dodge', c: '#7fd6ff' }, open: { key: 'jab', tip: 'OPEN! jab', c: GREEN } };
const KEYMAP = { ArrowUp: 'block', KeyW: 'block', ArrowDown: 'dodge', KeyS: 'dodge', ArrowRight: 'jab', KeyD: 'jab', Space: 'jab' };
const TAUNT = ['Is that all?', 'I am Jack\'s smirking face.', 'Hit me. I dare you.', 'You\'re not your khakis.'];

// pose -> [torso lean deg, body dx, body dy, lead arm (reach, angle), rear arm (reach, angle)] (dir 1 faces right)
const POSE = {
  guard: [0, 0, 0, [34, -40], [28, -55]], jab: [8, 14, 0, [78, -8], [28, -55]], block: [-4, -6, 0, [30, -85], [30, -95]],
  dodge: [14, 0, 46, [30, -40], [26, -55]], hit: [-18, -22, 0, [30, 20], [26, 30]], wind: [-12, -10, 0, [24, -40], [40, -150]],
  open: [-6, 0, 0, [44, 35], [40, 50]], down: [-80, -40, 90, [40, 10], [40, 30]],
};
/** @param {any} p parent @param {any} c colours */
function fighter(p, c) {
  const g = S('g', {}, p), body = S('g', {}, g);
  S('ellipse', { cx: 0, cy: 4, rx: 70, ry: 12, fill: '#000', opacity: 0.45, filter: 'url(#fs-soft)' }, g);
  const legs = S('path', { d: 'M-22 0 L-14 -110 L14 -110 L22 0', fill: 'none', stroke: c.pants, 'stroke-width': 26, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, body);
  const up = S('g', { transform: 'translate(0 -110)' }, body);
  const rear = S('g', {}, up);
  S('path', { d: 'M-34 0 L-38 -110 Q0 -124 38 -110 L34 0 Z', fill: c.top }, up); S('path', { d: 'M10 -2 L14 -116 Q30 -114 38 -110 L34 0 Z', fill: c.topS, opacity: 0.6 }, up);
  S('circle', { cx: 0, cy: -150, r: 32, fill: c.skin }, up); S('path', { d: 'M-32 -156 Q-30 -190 0 -186 Q30 -190 32 -156 Q14 -172 -32 -156Z', fill: c.hair }, up);
  S('circle', { cx: 14, cy: -152, r: 3.5, fill: '#1a1210' }, up);
  const lead = S('g', {}, up);
  const arm = parent => { const a = S('g', { transform: 'translate(0 -96)' }, parent); const l = S('line', { x1: 0, y1: 0, x2: 30, y2: 0, stroke: c.skin, 'stroke-width': 18, 'stroke-linecap': 'round' }, a);
    const f = S('circle', { cx: 30, cy: 0, r: 17, fill: c.glove }, a); S('circle', { cx: 25, cy: -5, r: 6, fill: '#fff', opacity: 0.3 }, a); return { a, l, f }; };
  const A = arm(lead), B = arm(rear);
  const set = (dir, pose, bob) => { const [lean, dx, dy, [r1, a1], [r2, a2]] = POSE[pose] || POSE.guard;
    body.setAttribute('transform', `translate(${dx} ${dy + bob}) rotate(${lean})`); legs.setAttribute('d', dy > 30 && pose !== 'down' ? 'M-30 0 L-18 -64 L18 -64 L30 0' : 'M-22 0 L-14 -110 L14 -110 L22 0');
    if (pose === 'dodge') up.setAttribute('transform', 'translate(0 -64)'); else up.setAttribute('transform', 'translate(0 -110)');
    for (const [P2, r, an] of [[A, r1, a1], [B, r2, a2]]) { const x = Math.cos(an * Math.PI / 180) * r, y = Math.sin(an * Math.PI / 180) * r; P2.l.setAttribute('x2', x); P2.l.setAttribute('y2', y); P2.f.setAttribute('cx', x); P2.f.setAttribute('cy', y); }
    g.dataset.dir = String(dir); };
  return { g, set };
}

/** @param {any} ctx */
export function startSpar(ctx) {
  const ov = ctx.overlay({ title: 'The Ring', sub: 'sparring vs Tyrone', help: '<kbd>↑</kbd> block high <kbd>↓</kbd> dodge low <kbd>→</kbd>/<kbd>space</kbd> jab when open <kbd>click</kbd> high / middle / low third = block / jab / dodge <kbd>enter</kbd>/<kbd>click</kbd> start / play again' });
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rec = load('spar', { streak: 0, best: 0, wins: 0 });
  const hud = K.hud([{ id: 'you', label: 'You', value: '●●●', tone: 'up' }, { id: 'streak', label: 'Streak', value: rec.streak }, { id: 'best', label: 'Best', value: rec.best, tone: 'gold' }], [{ id: 'npc', label: 'Tyrone', value: '●●●●●', tone: 'bad' }]);
  const scene = K.scene({ aspect: 16 / 9 });
  const root = S('svg', { viewBox: '0 0 1600 900', width: '100%', height: '100%' }, scene); root.style.position = 'absolute'; root.style.inset = '0'; root.style.cursor = 'pointer';
  root.innerHTML = `<defs><filter id="fs-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>
    <filter id="fs-conc"><feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="4" seed="7"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .35 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <radialGradient id="fs-bulb" cx=".5" cy=".12" r=".75"><stop offset="0" stop-color="#ffd29a" stop-opacity=".45"/><stop offset=".5" stop-color="#ffb070" stop-opacity=".1"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></radialGradient>
    <linearGradient id="fs-mat" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6a5a4a"/><stop offset="1" stop-color="#3a3028"/></linearGradient>
    <linearGradient id="fs-wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3430"/><stop offset="1" stop-color="#24201e"/></linearGradient></defs>
    <rect x="0" y="0" width="1600" height="900" rx="24" fill="url(#fs-wall)"/><rect x="0" y="0" width="1600" height="900" rx="24" fill="#000" filter="url(#fs-conc)"/>
    <path d="M0 640 L1600 640 L1600 900 L0 900Z" fill="url(#fs-mat)"/><path d="M0 640 L1600 640 L1600 900 L0 900Z" fill="#000" filter="url(#fs-conc)"/>
    <g stroke="#c0402a" stroke-width="6" opacity=".85"><path d="M0 470 H1600"/><path d="M0 540 H1600"/></g><g stroke="#fff" stroke-opacity=".25" stroke-width="2"><path d="M0 467 H1600"/><path d="M0 537 H1600"/></g>
    <rect x="0" y="0" width="1600" height="900" rx="24" fill="url(#fs-bulb)"/>
    <path d="M800 0 V96" stroke="#111" stroke-width="3"/><circle cx="800" cy="114" r="20" fill="#fff4d0"/><circle cx="800" cy="114" r="46" fill="#ffd29a" opacity=".25"/>`;
  const crowd = S('g', { opacity: 0.55 }, root);
  for (let i = 0; i < 16; i++) S('ellipse', { cx: 50 + i * 100 + (i % 2) * 20, cy: 860 - (i % 3) * 14, rx: 50, ry: 70, fill: '#0e0b0a' }, crowd);
  const you = fighter(S('g', { transform: 'translate(620 790) scale(1.8)' }, root), { ...YOU, glove: '#e8e4dc' });
  const tyg = S('g', { transform: 'translate(980 790) scale(-1.8 1.8)' }, root);
  const tyr = fighter(tyg, { ...TYR, glove: '#c0402a' });
  const tip = S('text', { x: 1150, y: 230, 'text-anchor': 'middle', 'font-family': 'Sora', 'font-size': 64, 'font-weight': 800 }, root);
  const now = S('text', { x: 1150, y: 285, 'text-anchor': 'middle', 'font-family': 'Sora', 'font-size': 34, 'font-weight': 800 }, root);
  const say = S('text', { x: 800, y: 860, 'text-anchor': 'middle', 'font-family': 'Sora', 'font-size': 28, 'font-weight': 500, 'font-style': 'italic', fill: GX.text2 }, root);
  const flashR = S('rect', { width: 1600, height: 900, rx: 24, opacity: 0, 'pointer-events': 'none' }, root);
  /** @type {any} */ let st; let playing = false;
  const reset = () => { st = { t: 0, you: 3, npc: 5, phase: 'idle', pt: 0.9, move: 'high', tele: 1, done: false, res: '', ok: false, shake: 0, flashC: '', flash: 0, youPose: 'guard', npcPose: 'guard', poseT: 0, round: 0, say: 'Hit me. I dare you.', sayT: 2 }; };
  reset();
  /** test hook for tools/review-fightclub.mjs (read-only state) */
  /** @type {any} */ (window).__fcSpar = () => ({ phase: st.phase, move: st.move, pt: st.pt, you: st.you, npc: st.npc, done: st.done, ok: st.ok, rec: { ...rec } });
  ov.onClose(() => { delete /** @type {any} */ (window).__fcSpar; });
  const at = (x, y) => { const b = root.getBoundingClientRect(); return /** @type {[number, number]} */ ([b.left + b.width * x / 1600, b.top + b.height * y / 900]); };
  const pips = (n, m) => '●'.repeat(n) + '○'.repeat(m - n);
  const pick = () => { const r = Math.random(); st.move = st.round % 3 === 2 || r < 0.3 ? 'open' : r < 0.65 ? 'high' : 'low'; st.tele = Math.max(0.45, 1.0 - st.round * 0.04) + Math.random() * 0.3; };
  const resolve = (/** @type {string|null} */ act) => {
    const want = MOVES[st.move].key; st.phase = 'idle'; st.pt = 0.55; st.round++; st.poseT = 0.4;
    if (st.move === 'open') {
      if (act === 'jab') { st.npc--; st.youPose = 'jab'; st.npcPose = 'hit'; SFX.play('punch'); st.shake = 0.25; K.pop(...at(960, 380), 'Pow!', 'gold'); K.swell(); ctx?.R?.fc?.hit(); }
      else { st.npcPose = 'guard'; SFX.play('swoosh', { vol: 0.6 }); K.pop(...at(960, 380), act ? 'whiff' : 'missed it'); }
    } else if (act === want) { st.youPose = act; st.npcPose = 'swing'; SFX.play(act === 'block' ? 'block' : 'whoosh'); K.pop(...at(640, 380), act === 'block' ? 'Blocked' : 'Dodged', 'up'); }
    else { st.you--; st.youPose = 'hit'; st.npcPose = 'swing'; SFX.play('thud'); SFX.play('grunt', { delay: 0.05 }); st.shake = 0.4; st.flash = 1; st.flashC = GX.error; K.pop(...at(640, 380), 'Oof', 'bad'); }
    hud.set('you', pips(Math.max(0, st.you), 3)); hud.set('npc', pips(Math.max(0, st.npc), 5));
    if (st.npc <= 0 || st.you <= 0) {
      st.done = true; st.ok = st.npc <= 0; st.phase = 'end'; st.flash = 1; st.flashC = st.ok ? GX.warning : GX.error; SFX.play(st.ok ? 'win' : 'fail', { delay: 0.25 });
      if (st.ok) { rec.streak++; rec.wins++; rec.best = Math.max(rec.best, rec.streak); st.npcPose = 'down'; st.say = 'Ow. Same time next week?'; K.swell(); }
      else { rec.streak = 0; st.youPose = 'down'; st.say = TAUNT[Math.floor(Math.random() * TAUNT.length)]; }
      st.sayT = 4; save('spar', rec); hud.set('streak', rec.streak); hud.set('best', rec.best);
      setTimeout(() => { if (!st.done || !ov.el.isConnected) return; playing = false; K.result({ title: st.ok ? 'Tyrone is down' : 'You see stars', big: st.ok ? 'KO' : 'Down', line: st.ok ? 'Same time next week.' : '"' + st.say + '"', stats: [[rec.streak, 'Streak'], [rec.best, 'Best'], [rec.wins, 'Wins']], again: 'Rematch', onAgain: () => { reset(); hud.set('you', pips(3, 3)); hud.set('npc', pips(5, 5)); playing = true; } }); }, 1100);
    }
  };
  const kd = (/** @type {KeyboardEvent} */ e) => {
    if (!playing || st.done) return;
    const act = KEYMAP[e.code]; if (!act) return; e.preventDefault();
    if (st.phase === 'tele') { if (st.pt > 0.38) { SFX.play('ui.deny'); K.pop(...at(640, 330), 'too early!', 'bad'); resolve(st.move === 'open' ? null : '_early'); } else resolve(act); }
    else if (st.phase === 'strike') resolve(act);
  };
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  // mouse: click the top third = block, middle = jab, bottom third = dodge (same timing rules as the keys)
  root.addEventListener('click', e => { const b = root.getBoundingClientRect(), k = (e.clientY - b.top) / b.height; kd(/** @type {any} */ ({ code: k < 1 / 3 ? 'ArrowUp' : k < 2 / 3 ? 'Space' : 'ArrowDown', preventDefault() {} })); });
  loop(ov, (dt, t) => {
    st.t += dt; st.shake = Math.max(0, st.shake - dt); st.flash = Math.max(0, st.flash - dt * 2); st.sayT -= dt;
    st.poseT -= dt; if (st.poseT <= 0 && !st.done) { st.youPose = 'guard'; if (st.phase !== 'tele') st.npcPose = 'guard'; }
    if (!st.done && playing) {
      st.pt -= dt;
      if (st.phase === 'idle' && st.pt <= 0) { pick(); st.phase = 'tele'; st.pt = st.tele; st.npcPose = st.move === 'open' ? 'open' : 'wind'; SFX.play(st.move === 'open' ? 'tick' : 'swoosh', { vol: 0.35, pitch: 0.7 }); }
      else if (st.phase === 'tele' && st.pt <= 0) { st.phase = 'strike'; st.pt = 0.38; if (st.move !== 'open') st.npcPose = 'jab'; }
      else if (st.phase === 'strike' && st.pt <= 0) resolve(null);
    }
    const bob = reduce ? 0 : Math.sin(t * 4) * 4, sx = reduce ? 0 : Math.sin(t * 60) * st.shake * 18;
    root.style.transform = sx ? `translateX(${sx}px)` : '';
    you.set(1, st.youPose, bob); tyr.set(-1, st.npcPose === 'swing' ? 'jab' : st.npcPose, -bob);
    if (st.npcPose === 'jab' && st.move === 'low' && st.phase === 'strike') tyr.set(-1, 'jab', 50);
    if (st.phase === 'tele' || st.phase === 'strike') { const m = MOVES[st.move], ready = st.phase === 'strike' || st.pt <= 0.38;
      tip.textContent = m.tip; tip.setAttribute('fill', ready ? m.c : '#f0e6d0'); now.textContent = ready ? 'NOW!' : ''; now.setAttribute('fill', m.c); } else { tip.textContent = ''; now.textContent = ''; }
    say.textContent = st.sayT > 0 && playing ? '"' + st.say + '"' : '';
    flashR.setAttribute('opacity', String(st.flash * 0.3)); if (st.flashC) flashR.setAttribute('fill', st.flashC);
    crowd.setAttribute('transform', `translate(0 ${reduce ? 0 : Math.sin(t * 6) * (st.done && st.ok ? 10 : 2)})`);
  });
  K.card({ title: 'The Ring', text: 'Sparring vs Tyrone. No blood, just pride. Read his wind-up, then answer on NOW.', how: [[['↑'], 'block'], [['↓'], 'dodge'], [['→', 'Space'], 'jab when open'], [['Click'], 'top / middle / bottom']], cta: 'Fight', onGo: () => { playing = true; } });
}
