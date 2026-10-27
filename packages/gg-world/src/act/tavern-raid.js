// @ts-check
// Raid plan (GX kit: a parchment plan on a wooden easel, the hothead's portrait beside it): the leader explains the plan for 20 s. The hothead's impatience climbs; press Space to hold him back
// (only works once he's twitching; spamming annoys him). If he snaps he charges in shouting his own name: 50 DKP minus.
import { SFX } from '../sfx.js';
import { loop, coins } from './util.js';
import { load, save } from './tavern-ui.js';
import { gx, svg as S, GX } from './gx.js';

const PLAN = ['Okay team, listen up.', 'Tanks pull to the left.', 'Healers stay back.', 'Mages: sheep the adds.', 'We run the numbers...', '32.33% chance. Repeating.', 'On my mark. Nobody move.', 'Three... two...'];
const LEN = 20;
// the hothead's battle cry: a soft rising vocal-ish buzz (no shrill top)
SFX.define('tav.charge', (o, t, p, K) => { K.tone(o, t, { type: 'sawtooth', f: 160 * p, f1: 260 * p, v: 0.08, a: 0.05, d: 0.7 }); K.tone(o, t, { type: 'sawtooth', f: 240 * p, f1: 390 * p, v: 0.05, a: 0.05, d: 0.7 }); K.hiss(o, t, { ft: 'bandpass', f: 700 * p, q: 2, v: 0.04, a: 0.05, d: 0.6 }); });

/** @param {any} ctx */
export function startRaid(ctx) {
  const ov = ctx.overlay({ title: 'Raid Plan', sub: 'the easel by the west wall', help: '<kbd>space</kbd> hold the hothead back <kbd>enter</kbd> start / play again <kbd>click</kbd> hold / buttons' });
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rec = load('raid', { best: 0, clears: 0 });
  const hud = K.hud([{ id: 't', label: 'Plan', value: '0 / 20 s' }, { id: 'best', label: 'Best', value: rec.best + ' s', tone: 'gold' }], [{ id: 'clears', label: 'Clears', value: rec.clears }]);
  const scene = K.scene({ aspect: 16 / 9 });
  const root = S('svg', { viewBox: '0 0 1600 900', width: '100%', height: '100%' }, scene); root.style.position = 'absolute'; root.style.inset = '0'; root.style.overflow = 'visible'; root.style.cursor = 'pointer';
  root.innerHTML = `<defs>
    <filter id="tr-grain"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.3" numOctaves="3" seed="5"/><feColorMatrix values="0 0 0 0 .1  0 0 0 0 .05  0 0 0 0 .02  0 0 0 .45 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <filter id="tr-paper"><feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="4" seed="2"/><feColorMatrix values="0 0 0 0 .45  0 0 0 0 .3  0 0 0 0 .1  0 0 0 .22 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    <linearGradient id="tr-oak" x1="0" x2="1"><stop offset="0" stop-color="#4a2a16"/><stop offset=".5" stop-color="#7a4a2a"/><stop offset="1" stop-color="#4a2a16"/></linearGradient>
    <linearGradient id="tr-parch" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6ead0"/><stop offset="1" stop-color="#d6bc86"/></linearGradient>
    <radialGradient id="tr-light" cx=".45" cy=".2" r=".9"><stop offset="0" stop-color="#fff3dc" stop-opacity=".25"/><stop offset="1" stop-color="#000" stop-opacity=".3"/></radialGradient>
    <radialGradient id="tr-mad" cx=".5" cy=".5" r=".6"><stop offset="0" stop-color="#ff5a2a" stop-opacity=".55"/><stop offset="1" stop-color="#ff5a2a" stop-opacity="0"/></radialGradient>
    <filter id="tr-soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10"/></filter></defs>
    <ellipse cx="560" cy="870" rx="420" ry="26" fill="#000" opacity=".5" filter="url(#tr-soft)"/>
    <g fill="url(#tr-oak)"><path d="M300 880 L420 60 L450 60 L340 880Z"/><path d="M820 880 L700 60 L670 60 L780 880Z"/><rect x="545" y="40" width="30" height="820"/></g>
    <path d="M300 880 L420 60 L450 60 L340 880ZM820 880 L700 60 L670 60 L780 880Z" fill="#000" filter="url(#tr-grain)"/>
    <rect x="150" y="760" width="820" height="34" rx="6" fill="url(#tr-oak)"/>
    <rect x="186" y="96" width="760" height="680" rx="6" fill="#000" opacity=".5" filter="url(#tr-soft)"/>
    <rect x="170" y="80" width="780" height="680" rx="6" fill="url(#tr-parch)"/><rect x="170" y="80" width="780" height="680" rx="6" fill="#000" filter="url(#tr-paper)"/>
    <rect x="170" y="80" width="780" height="680" rx="6" fill="url(#tr-light)"/>
    <text x="220" y="160" font-family="Sora" font-size="44" font-weight="800" fill="#a8302a" letter-spacing="4">PLAN A</text>
    <g fill="none" stroke="#2e4a8a" stroke-width="5" stroke-linecap="round"><circle cx="820" cy="190" r="56"/><path d="M640 300 Q720 280 770 230" stroke-dasharray="14 12"/><path d="M760 230 l14 -4 l-4 16"/></g>
    <text x="820" y="202" text-anchor="middle" font-family="Sora" font-size="30" font-weight="800" fill="#a8302a">BOSS</text>
    <rect x="1080" y="120" width="380" height="460" rx="14" fill="url(#tr-oak)"/><rect x="1080" y="120" width="380" height="460" rx="14" fill="#000" filter="url(#tr-grain)"/>`;
  const plan = S('g', { 'font-family': 'Sora', 'font-size': 34, 'font-weight': 600 }, root);
  const lines = PLAN.map((s, i) => { const t = S('text', { x: 220, y: 240 + i * 60, fill: '#3a2412', opacity: 0 }, plan); t.textContent = s; return t; });
  S('rect', { x: 220, y: 712, width: 680, height: 14, rx: 7, fill: '#3a2412', opacity: 0.2 }, root);
  const prog = S('rect', { x: 220, y: 712, width: 0, height: 14, rx: 7, fill: '#c98a10' }, root);
  const pic = S('g', {}, root);
  const bgp = S('rect', { x: 1104, y: 144, width: 332, height: 412, rx: 6, fill: '#2a1a2a' }, pic);
  const madG = S('rect', { x: 1104, y: 144, width: 332, height: 412, rx: 6, fill: 'url(#tr-mad)', opacity: 0 }, pic);
  const head = S('g', {}, pic);
  head.innerHTML = `<path d="M1130 556 Q1140 450 1270 440 Q1400 450 1410 556Z" fill="#7a828e"/><path d="M1270 440 Q1400 450 1410 556 L1330 556Z" fill="#5a626e"/>
    <ellipse cx="1150" cy="460" rx="50" ry="26" fill="#d8a43a"/><ellipse cx="1390" cy="460" rx="50" ry="26" fill="#d8a43a"/>`;
  const face = S('ellipse', { cx: 1270, cy: 330, rx: 92, ry: 110, fill: '#d8a888' }, head);
  head.insertAdjacentHTML('beforeend', `<path d="M1176 300 Q1180 200 1270 205 Q1360 200 1364 300 Q1330 250 1270 250 Q1210 250 1176 300Z" fill="#8a3a1a"/>
    <path d="M1180 360 Q1190 450 1270 456 Q1350 450 1360 360 Q1320 400 1270 400 Q1220 400 1180 360Z" fill="#8a3a1a"/><circle cx="1236" cy="320" r="10" fill="#2a1a12"/><circle cx="1304" cy="320" r="10" fill="#2a1a12"/>`);
  const brows = S('path', { d: 'M1214 296 L1252 296 M1288 296 L1326 296', stroke: '#2a1a12', 'stroke-width': 8, 'stroke-linecap': 'round' }, head);
  const mouth = S('rect', { x: 1248, y: 384, width: 44, height: 6, rx: 3, fill: '#3a0a0a' }, head);
  S('text', { x: 1270, y: 620, 'text-anchor': 'middle', 'font-family': 'Sora', 'font-size': 28, 'font-weight': 600, fill: GX.text }, root).textContent = 'the hothead';
  S('rect', { x: 1100, y: 650, width: 340, height: 22, rx: 11, fill: '#000', opacity: 0.5 }, root);
  const bar = S('rect', { x: 1100, y: 650, width: 0, height: 22, rx: 11 }, root);
  S('rect', { x: 1302, y: 644, width: 4, height: 34, fill: GX.success, opacity: 0.8 }, root);
  const cue = S('text', { x: 1270, y: 720, 'text-anchor': 'middle', 'font-family': 'Sora', 'font-size': 28, 'font-weight': 700 }, root);
  let g = /** @type {any} */ (null), playing = false;
  const reset = () => { g = { t: 0, imp: 0.1, rate: 0.12, over: '', holdT: -9, line: 0, red: false }; };
  const popAt = (txt, tone) => { const b = root.getBoundingClientRect(); K.pop(b.left + b.width * 0.79, b.top + b.height * 0.3, txt, tone); };
  const hold = () => { if (!g || g.over || !playing) return; if (g.imp > 0.6) { g.imp = 0.15; g.rate += 0.03; g.holdT = g.t; popAt('Hold!', 'up'); SFX.play('block'); SFX.play('success', { delay: 0.1, vol: 0.6 }); }
    else { g.imp = Math.min(1, g.imp + 0.15); SFX.play('grunt'); popAt('"Stop poking me"', 'bad'); } };
  const finish = (o) => setTimeout(() => { if (ov.el.isConnected) { playing = false; K.result(o); } }, 1400);
  const again = () => { reset(); playing = true; };
  reset();
  root.addEventListener('click', hold);
  const onKey = e => { if (playing && e.code === 'Space') { e.preventDefault(); hold(); } };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  loop(ov, dt => {
    if (playing && !g.over) { g.t += dt; g.imp += dt * g.rate * (0.6 + Math.sin(g.t * 1.7) * 0.4 + g.t / LEN);
      if (g.imp >= 1) { g.over = 'charge'; SFX.play('tav.charge'); SFX.play('thud', { delay: 0.5 }); SFX.play('punch', { delay: 0.65 }); SFX.play('fail', { delay: 0.9 }); rec.best = Math.max(rec.best, Math.floor(g.t)); save('raid', rec);
        popAt('He charges in shouting his name!', 'bad');
        finish({ title: '50 DKP minus', big: Math.floor(g.t) + ' s', line: 'He charged in shouting his name. "At least I have chicken."', stats: [[Math.floor(g.t) + ' s', 'Lasted'], [rec.best + ' s', 'Best'], [rec.clears, 'Clears']], again: 'Play again', onAgain: again }); }
      else if (g.t >= LEN) { g.over = 'clear'; rec.clears++; rec.best = LEN; save('raid', rec); SFX.play('win'); coins(ctx.S).spend(-25); popAt('+25 coins', 'gold'); K.swell();
        finish({ title: 'Pull!', big: '+25', line: 'Nobody charged early. A historic first.', stats: [['+25', 'Coins'], [rec.best + ' s', 'Best'], [rec.clears, 'Clears']], again: 'Play again', onAgain: again }); } }
    const n = Math.min(PLAN.length, Math.floor(g.t / LEN * PLAN.length) + 1);
    if (!g.over && n > g.line) { if (g.line) SFX.play('page', { vol: 0.5 }); g.line = n; }
    if (!g.over && (g.imp > 0.6) !== g.red) { g.red = g.imp > 0.6; if (g.red) SFX.play('heartbeat', { vol: 0.6 }); }
    lines.forEach((l, i) => { l.setAttribute('opacity', playing || g.t > 0 ? (i < n ? 1 : 0) : i === 0 ? 1 : 0); l.setAttribute('fill', i === n - 1 ? '#a8302a' : '#3a2412'); });
    prog.setAttribute('width', String(680 * Math.min(1, g.t / LEN)));
    const mad = g.imp > 0.6, tw = mad && !g.over && !reduce ? Math.sin(performance.now() / 22) * 4 : 0;
    head.setAttribute('transform', `translate(${tw} 0)`); face.setAttribute('fill', mad ? '#f09a7a' : '#d8a888'); bgp.setAttribute('fill', mad ? '#5a1a14' : '#2a1a2a'); madG.setAttribute('opacity', mad ? 1 : 0);
    brows.setAttribute('d', mad ? 'M1214 290 L1252 302 M1288 302 L1326 290' : 'M1214 296 L1252 296 M1288 296 L1326 296');
    mouth.setAttribute('height', mad ? 20 : 6); mouth.setAttribute('y', mad ? 378 : 384);
    bar.setAttribute('width', String(340 * Math.min(1, g.imp))); bar.setAttribute('fill', mad ? '#ff5a2a' : '#e0a458');
    cue.textContent = mad && !g.over ? 'Now! Space' : 'Wait for red…'; cue.setAttribute('fill', mad ? GX.success : GX.text2);
    hud.set('t', `${Math.min(LEN, Math.floor(g.t))} / 20 s`); hud.set('best', rec.best + ' s'); hud.set('clears', rec.clears);
  });
  K.card({ title: 'Raid Plan', text: 'Keep the hothead calm for 20 seconds. Hold him back only once his bar turns red; poking him early makes it worse.', how: [[['Space'], 'hold him back'], [['Click'], 'same']], cta: 'Start the briefing', onGo: () => { playing = true; } });
}
