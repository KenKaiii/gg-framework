// @ts-check
// Raid plan: the leader explains the plan for 20 s. The hothead's impatience climbs; press Space to hold him back
// (only works once he's twitching; spamming annoys him). If he snaps he charges in shouting his own name: 50 DKP minus.
import { SFX } from '../sfx.js';
import { loop, text, coins } from './util.js';
import { panel, backdrop, button, onClick, onKey, hit, load, save, pops, INK, GOLDC } from './tavern-ui.js';
import { PAL, shaker, particles, title, glow, panel as artPanel } from './art.js';
import { cardFlow } from './fightclub-ui.js';
const SURF = (x, X, Y, w, h) => panel(x, X + 5, Y + 5, w - 10, h - 10);

const PLAN = ['Okay team, listen up.', 'Tanks pull to the left.', 'Healers stay back.', 'Mages: sheep the adds.', 'We run the numbers...', '32.33% chance. Repeating.', 'On my mark. Nobody move.', 'Three... two...'];
const LEN = 20;
// the hothead's battle cry: a soft rising vocal-ish buzz (no shrill top)
SFX.define('tav.charge', (o, t, p, K) => { K.tone(o, t, { type: 'sawtooth', f: 160 * p, f1: 260 * p, v: 0.08, a: 0.05, d: 0.7 }); K.tone(o, t, { type: 'sawtooth', f: 240 * p, f1: 390 * p, v: 0.05, a: 0.05, d: 0.7 }); K.hiss(o, t, { ft: 'bandpass', f: 700 * p, q: 2, v: 0.04, a: 0.05, d: 0.6 }); });

/** @param {any} ctx */
export function startRaid(ctx) {
  const ov = ctx.overlay({ title: 'Raid Plan', sub: 'the easel by the west wall', help: '<kbd>space</kbd> hold the hothead back <kbd>enter</kbd> start / play again <kbd>click</kbd> hold / buttons <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const rec = load('raid', { best: 0, clears: 0 }); const P = pops();
  let g, t = 0;
  const reset = () => { g = { t: 0, imp: 0.1, rate: 0.12, over: '', shout: 0, holdT: -9, line: 0, red: false }; };
  const hold = () => { if (!g || g.over) return; if (g.imp > 0.6) { g.imp = 0.15; g.rate += 0.03; g.holdT = g.t; P.add('HOLD!', 150, 150, '#6ee76a'); SFX.play('block'); SFX.play('success', { delay: 0.1, vol: 0.6 }); }
    else { g.imp = Math.min(1, g.imp + 0.15); SFX.play('grunt'); P.add('"Stop poking me"', 150, 150, '#ff8a6a'); } };
  reset(); const sh = shaker(), fx = particles();
  const F = cardFlow(ov, c, W, H, { surface: (x, X, Y, w, h) => { panel(x, X + 5, Y + 5, w - 10, h - 10); x.fillStyle = 'rgba(40,20,8,0.5)'; x.fillRect(X + 5, Y + 5, w - 10, h - 10); }, accent: PAL.gold, again: () => reset() });
  F.setCard({ title: 'RAID PLAN', sub: 'keep the hothead calm for 20 seconds', lines: ['Hold him back only once his bar turns red.', 'Poking him early makes it worse.'], chips: [['[space]', 'hold him back', '|', '[click]', 'same']] });
  const end = (r) => setTimeout(() => F.finish(r), 1400);
  onKey(ov, code => { if (F.phase === 'play' && code === 'Space') hold(); });
  onClick(ov, c, W, H, () => { if (F.phase === 'play') hold(); });
  loop(ov, dt => {
    t += dt; if (!g.over && F.phase === 'play') { g.t += dt; g.imp += dt * g.rate * (0.6 + Math.sin(g.t * 1.7) * 0.4 + g.t / LEN);
      if (g.imp >= 1) { g.over = 'charge'; g.shout = 0; SFX.play('tav.charge'); SFX.play('thud', { delay: 0.5 }); SFX.play('punch', { delay: 0.65 }); SFX.play('fail', { delay: 0.9 }); rec.best = Math.max(rec.best, Math.floor(g.t)); save('raid', rec); sh.kick(9); end({ title: '50 DKP MINUS', sub: 'he charged in shouting his name', color: PAL.red, stats: [['lasted', Math.floor(g.t), PAL.cream, 's'], ['best', rec.best, PAL.cyan, 's'], ['clears', rec.clears, PAL.gold]] }); }
      else if (g.t >= LEN) { g.over = 'clear'; rec.clears++; rec.best = LEN; save('raid', rec); SFX.play('win'); coins(ctx.S).spend(-25); P.add('+25 coins', W / 2, 120, GOLDC); fx.burst(W / 2, 120, { n: 40 }); end({ title: 'PULL!', sub: 'nobody charged early. a historic first', color: PAL.gold, win: true, stats: [['coins', 25, PAL.gold, 'c'], ['best', rec.best, PAL.cyan, 's'], ['clears', rec.clears, PAL.green]] }); } }
    x.save(); sh.apply(x, dt); backdrop(x, W, H, t);
    panel(x, 20, 20, 300, 200);
    title(x, 'PLAN A', 34, 44, { size: 16, align: 'left', color: '#a8302a', ink: 'rgba(0,0,0,0)' });
    const lines = Math.min(PLAN.length, Math.floor(g.t / LEN * PLAN.length) + 1);
    if (!g.over && lines > g.line) { if (g.line) SFX.play('page', { vol: 0.5 }); g.line = lines; }
    if (!g.over && (g.imp > 0.6) !== g.red) { g.red = g.imp > 0.6; if (g.red) SFX.play('heartbeat', { vol: 0.6 }); }
    for (let i = 0; i < lines; i++) text(x, PLAN[i], 34, 64 + i * 18, { color: i === lines - 1 ? '#a8302a' : INK });
    x.strokeStyle = '#2e4a8a'; x.lineWidth = 2; x.beginPath(); x.arc(270, 70, 18, 0, 7); x.stroke(); text(x, 'BOSS', 270, 75, { color: '#a8302a', align: 'center' });
    // hothead portrait + impatience bar
    const tw = g.imp > 0.6 && !g.over ? Math.sin(t * 50) * 2 : 0;
    const mad = g.imp > 0.6;
    artPanel(x, 344, 34, 112, 120, { style: 'wood' }); x.fillStyle = mad ? '#5a1a14' : '#2a1a2a'; x.fillRect(350, 40, 100, 108); if (mad) glow(x, 400, 90, 60, '#ff5a2a', 0.25 + Math.sin(t * 4) * 0.1);
    const hx = 400 + tw; x.fillStyle = '#1a0e08'; x.fillRect(hx - 42, 106, 84, 42); x.fillStyle = '#7a828e'; x.fillRect(hx - 41, 107, 82, 41); x.fillStyle = '#a8b0bc'; x.fillRect(hx - 41, 107, 82, 3); x.fillStyle = '#5a626e'; x.fillRect(hx + 10, 110, 31, 38); // plate armour
    x.fillStyle = '#d8a43a'; x.fillRect(hx - 44, 104, 18, 10); x.fillRect(hx + 26, 104, 18, 10); // pauldrons
    x.fillStyle = '#1a0e08'; x.fillRect(hx - 31, 51, 62, 56); x.fillStyle = mad ? '#f09a7a' : '#d8a888'; x.fillRect(hx - 30, 52, 60, 54); x.fillStyle = mad ? '#c8705a' : '#b8886a'; x.fillRect(hx + 12, 52, 18, 54);
    x.fillStyle = '#8a3a1a'; x.fillRect(hx - 32, 46, 64, 12); x.fillRect(hx - 30, 88, 60, 20); x.fillStyle = '#a84a22'; x.fillRect(hx - 32, 46, 64, 3); // hair + beard
    x.fillStyle = '#2a1a12'; x.fillRect(hx - 18, 70, 8, 6); x.fillRect(hx + 10, 70, 8, 6); x.fillRect(hx - 20, mad ? 62 : 64, 12, 3); x.fillRect(hx + 8, mad ? 62 : 64, 12, 3);
    x.fillStyle = '#3a0a0a'; x.fillRect(hx - 12, 92 - (mad ? 2 : 0), 24, mad ? 8 : 3); if (mad) { x.fillStyle = '#fff'; x.fillRect(hx - 10, 90, 20, 2); }
    title(x, 'the hothead', 400, 166, { size: 16, body: true, color: PAL.cream });
    x.fillStyle = '#2a0a10'; x.fillRect(350, 176, 100, 10); x.fillStyle = g.imp > 0.6 ? '#ff5a2a' : '#e0a458'; x.fillRect(350, 176, 100 * Math.min(1, g.imp), 10);
    x.fillStyle = 'rgba(110,231,106,0.6)'; x.fillRect(410, 174, 1, 14); title(x, 'impatience', 400, 200, { size: 16, body: true, color: PAL.dim }); title(x, g.imp > 0.6 && !g.over ? 'NOW! SPACE' : 'wait for red...', 400, 218, { size: 16, body: true, color: g.imp > 0.6 ? PAL.green : PAL.cream });
    x.fillStyle = '#2a1a10'; x.fillRect(20, 232, 300, 8); x.fillStyle = GOLDC; x.fillRect(20, 232, 300 * Math.min(1, g.t / LEN), 8);
    title(x, `best ${rec.best}s  clears ${rec.clears}`, 460, 258, { size: 16, body: true, align: 'right', color: PAL.gold });
    if (g.over === 'charge') { g.shout += dt; x.fillStyle = `rgba(255,60,30,${Math.max(0, 0.5 - g.shout)})`; x.fillRect(0, 0, W, H);
      const k = Math.min(1, g.shout * 3); x.fillStyle = 'rgba(0,0,0,0.65)'; x.fillRect(0, 70, W, 130);
      text(x, 'HE CHARGES IN SHOUTING HIS NAME!', W / 2 + Math.sin(t * 40) * 3 * (1 - k), 104, { title: true, size: 16, color: '#ff8a4a', align: 'center', shadow: '#000' });
      text(x, '"At least I have chicken."', W / 2, 128, { color: '#ffe8b0', align: 'center' });
      if (g.shout > 0.8) text(x, '50 DKP MINUS!', W / 2, 160, { title: true, size: 32, color: '#ff4a4a', align: 'center', shadow: '#000' });
    }
    P.draw(x, dt); fx.draw(x, dt); x.restore(); F.draw(x, dt);
  });
}
