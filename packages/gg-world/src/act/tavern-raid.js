// @ts-check
// Raid plan: the leader explains the plan for 20 s. The hothead's impatience climbs; press Space to hold him back
// (only works once he's twitching; spamming annoys him). If he snaps he charges in shouting his own name: 50 DKP minus.
import { SFX } from '../sfx.js';
import { loop, text, coins } from './util.js';
import { panel, backdrop, button, onClick, onKey, hit, load, save, pops, INK, GOLDC } from './tavern-ui.js';

const PLAN = ['Okay team, listen up.', 'Tanks pull to the left.', 'Healers stay back.', 'Mages: sheep the adds.', 'We run the numbers...', '32.33% chance. Repeating.', 'On my mark. Nobody move.', 'Three... two...'];
const LEN = 20;
// the hothead's battle cry: a soft rising vocal-ish buzz (no shrill top)
SFX.define('tav.charge', (o, t, p, K) => { K.tone(o, t, { type: 'sawtooth', f: 160 * p, f1: 260 * p, v: 0.08, a: 0.05, d: 0.7 }); K.tone(o, t, { type: 'sawtooth', f: 240 * p, f1: 390 * p, v: 0.05, a: 0.05, d: 0.7 }); K.hiss(o, t, { ft: 'bandpass', f: 700 * p, q: 2, v: 0.04, a: 0.05, d: 0.6 }); });

/** @param {any} ctx */
export function startRaid(ctx) {
  const ov = ctx.overlay({ title: 'Raid Plan', sub: 'the easel by the west wall', help: '<kbd>space</kbd> hold the hothead back <kbd>enter</kbd> try again <kbd>click</kbd> hold / retry <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const rec = load('raid', { best: 0, clears: 0 }); const P = pops();
  let g, t = 0, againB = null;
  const reset = () => { g = { t: 0, imp: 0.1, rate: 0.12, over: '', shout: 0, holdT: -9, line: 0, red: false }; };
  const hold = () => { if (!g || g.over) return; if (g.imp > 0.6) { g.imp = 0.15; g.rate += 0.03; g.holdT = g.t; P.add('HOLD!', 150, 150, '#6ee76a'); SFX.play('block'); SFX.play('success', { delay: 0.1, vol: 0.6 }); }
    else { g.imp = Math.min(1, g.imp + 0.15); SFX.play('grunt'); P.add('"Stop poking me"', 150, 150, '#ff8a6a'); } };
  reset();
  onKey(ov, code => { if (code === 'Space') hold(); else if (code === 'Enter' && g.over) { reset(); SFX.play('ui.click'); } });
  onClick(ov, c, W, H, (px, py) => { if (g.over && hit(againB, px, py)) reset(); else hold(); });
  loop(ov, dt => {
    t += dt; if (!g.over) { g.t += dt; g.imp += dt * g.rate * (0.6 + Math.sin(g.t * 1.7) * 0.4 + g.t / LEN);
      if (g.imp >= 1) { g.over = 'charge'; g.shout = 0; SFX.play('tav.charge'); SFX.play('thud', { delay: 0.5 }); SFX.play('punch', { delay: 0.65 }); SFX.play('fail', { delay: 0.9 }); rec.best = Math.max(rec.best, Math.floor(g.t)); save('raid', rec); }
      else if (g.t >= LEN) { g.over = 'clear'; rec.clears++; rec.best = LEN; save('raid', rec); SFX.play('win'); coins(ctx.S).spend(-25); P.add('+25 coins', W / 2, 120, GOLDC); } }
    backdrop(x, W, H, t);
    panel(x, 20, 20, 300, 200);
    text(x, 'PLAN A', 34, 42, { title: true, color: INK });
    const lines = Math.min(PLAN.length, Math.floor(g.t / LEN * PLAN.length) + 1);
    if (!g.over && lines > g.line) { if (g.line) SFX.play('page', { vol: 0.5 }); g.line = lines; }
    if (!g.over && (g.imp > 0.6) !== g.red) { g.red = g.imp > 0.6; if (g.red) SFX.play('heartbeat', { vol: 0.6 }); }
    for (let i = 0; i < lines; i++) text(x, PLAN[i], 34, 64 + i * 18, { color: i === lines - 1 ? '#a8302a' : INK });
    x.strokeStyle = '#2e4a8a'; x.lineWidth = 2; x.beginPath(); x.arc(270, 70, 18, 0, 7); x.stroke(); text(x, 'BOSS', 270, 75, { color: '#a8302a', align: 'center' });
    // hothead portrait + impatience bar
    const tw = g.imp > 0.6 && !g.over ? Math.sin(t * 50) * 2 : 0;
    x.fillStyle = '#5a3a2a'; x.fillRect(350 + tw, 40, 100, 110); x.fillStyle = '#d8a888'; x.fillRect(370 + tw, 56, 60, 52);
    x.fillStyle = '#2a1a12'; x.fillRect(382 + tw, 74, 8, 6); x.fillRect(410 + tw, 74, 8, 6); x.fillRect(386 + tw, 94 - (g.imp > 0.6 ? 2 : 0), 28, g.imp > 0.6 ? 8 : 3);
    x.fillStyle = '#8a8a9a'; x.fillRect(360 + tw, 112, 80, 30);
    text(x, 'the hothead', 400, 166, { color: '#ffe8b0', align: 'center' });
    x.fillStyle = '#2a0a10'; x.fillRect(350, 176, 100, 10); x.fillStyle = g.imp > 0.6 ? '#ff5a2a' : '#e0a458'; x.fillRect(350, 176, 100 * Math.min(1, g.imp), 10);
    x.fillStyle = 'rgba(110,231,106,0.6)'; x.fillRect(410, 174, 1, 14); text(x, 'impatience', 400, 200, { color: '#c8a878', align: 'center' }); text(x, g.imp > 0.6 && !g.over ? 'NOW! press SPACE' : 'wait for red...', 400, 218, { color: g.imp > 0.6 ? '#6ee76a' : '#8a7a6a', align: 'center' });
    x.fillStyle = '#2a1a10'; x.fillRect(20, 232, 300, 8); x.fillStyle = GOLDC; x.fillRect(20, 232, 300 * Math.min(1, g.t / LEN), 8);
    text(x, `best ${rec.best}s  clears ${rec.clears}`, 460, 258, { color: '#c8a878', align: 'right' });
    if (g.over === 'charge') { g.shout += dt; x.fillStyle = `rgba(255,60,30,${Math.max(0, 0.5 - g.shout)})`; x.fillRect(0, 0, W, H);
      const k = Math.min(1, g.shout * 3); x.fillStyle = 'rgba(0,0,0,0.65)'; x.fillRect(0, 70, W, 130);
      text(x, 'HE CHARGES IN SHOUTING HIS NAME!', W / 2 + Math.sin(t * 40) * 3 * (1 - k), 104, { title: true, size: 16, color: '#ff8a4a', align: 'center', shadow: '#000' });
      text(x, '"At least I have chicken."', W / 2, 128, { color: '#ffe8b0', align: 'center' });
      if (g.shout > 0.8) text(x, '50 DKP MINUS!', W / 2, 160, { title: true, size: 32, color: '#ff4a4a', align: 'center', shadow: '#000' });
      againB = button(x, 'Wipe & retry (enter)', 170, 172 + 0 * k, 140, 22, { on: true }); }
    if (g.over === 'clear') { x.fillStyle = 'rgba(0,0,0,0.6)'; x.fillRect(0, 80, W, 110);
      text(x, 'PULL! Perfect plan executed.', W / 2, 118, { title: true, color: GOLDC, align: 'center', shadow: '#000' });
      text(x, 'Nobody charged early. A historic first.', W / 2, 140, { color: '#ffe8b0', align: 'center' });
      againB = button(x, 'Again (enter)', 180, 156, 120, 22, { on: true }); }
    P.draw(x, dt);
  });
}
