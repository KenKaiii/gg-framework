// @ts-check
// Sparring: a cartoony timing duel vs a cocky NPC. Read the wind-up, then block (high), dodge (low) or jab (open guard).
// No blood: a knock-down is a comic stagger with stars. Win streak + best saved.
import { loop, text, mouse } from './util.js';
import { SFX } from '../sfx.js';
import { load, save, pops, INK, AMBER, GREEN, RED, PINK } from './fightclub-util.js';
import { drawFighter, drawWall, drawBulb, drawCrowd, dust } from './fightclub-fighter.js';
import { PAL, title, glow, shaker, particles } from './art.js';
import { cardFlow, cardboard, cached, tape } from './fightclub-ui.js';
const YOU = { top: '#e8e4dc', topS: '#b0aca4', topH: '#ffffff', skin: '#e8b890', skinS: '#c08a64', hair: '#5a3a22', pants: '#4a5a7a', pantsS: '#34405a' };
const TYR = { top: '#c0402a', topS: '#8a2a1a', topH: '#e86a4a', skin: '#c88a5a', skinS: '#9a6440', hair: '#e0c060', pants: '#2a2a30', pantsS: '#18181c' };

const MOVES = { high: { key: 'block', tip: 'HIGH! block', c: AMBER }, low: { key: 'dodge', tip: 'LOW! dodge', c: '#7fd6ff' }, open: { key: 'jab', tip: 'OPEN! jab', c: GREEN } };
const KEYMAP = { ArrowUp: 'block', KeyW: 'block', ArrowDown: 'dodge', KeyS: 'dodge', ArrowRight: 'jab', KeyD: 'jab', Space: 'jab' };
const TAUNT = ['Is that all?', 'I am Jack\'s smirking face.', 'Hit me. I dare you.', 'You\'re not your khakis.'];

/** @param {any} ctx */
export function startSpar(ctx) {
  const ov = ctx.overlay({ title: 'The Ring', sub: 'sparring vs Tyrone', help: '<kbd>↑</kbd> block high <kbd>↓</kbd> dodge low <kbd>→</kbd>/<kbd>space</kbd> jab when open <kbd>click</kbd> high / middle / low third = block / jab / dodge <kbd>enter</kbd>/<kbd>click</kbd> start / play again <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { x, c } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const rec = load('spar', { streak: 0, best: 0, wins: 0 });
  const P = pops();
  /** @type {any} */ let st;
  const reset = () => { st = { t: 0, you: 3, npc: 5, phase: 'idle', pt: 0.9, move: 'high', tele: 1, done: false, res: '', ok: false, shake: 0, flashC: '', flash: 0, youPose: 'guard', npcPose: 'guard', poseT: 0, round: 0, say: 'Hit me. I dare you.', sayT: 2 }; };
  reset();
  /** test hook for tools/review-fightclub.mjs (read-only state) */
  /** @type {any} */ (window).__fcSpar = () => ({ phase: st.phase, move: st.move, pt: st.pt, you: st.you, npc: st.npc, done: st.done, ok: st.ok, rec: { ...rec } });
  ov.onClose(() => { delete /** @type {any} */ (window).__fcSpar; });
  const pick = () => { const r = Math.random(); st.move = st.round % 3 === 2 || r < 0.3 ? 'open' : r < 0.65 ? 'high' : 'low'; st.tele = Math.max(0.45, 1.0 - st.round * 0.04) + Math.random() * 0.3; };
  const resolve = (/** @type {string|null} */ act) => {
    const want = MOVES[st.move].key; st.phase = 'idle'; st.pt = 0.55; st.round++; st.poseT = 0.4;
    if (st.move === 'open') {
      if (act === 'jab') { st.npc--; st.youPose = 'jab'; st.npcPose = 'hit'; SFX.play('punch'); st.shake = 0.25; P.add('POW!', 300, 98, AMBER); D.burst(300, 150, 14); hype = 1; st.ctx?.R?.fc?.hit(); }
      else { st.npcPose = 'guard'; SFX.play('swoosh', { vol: 0.6 }); P.add(act ? 'whiff' : 'missed it', 300, 98, '#aaa'); }
    } else if (act === want) { st.youPose = act; st.npcPose = 'swing'; SFX.play(act === 'block' ? 'block' : 'whoosh'); P.add(act === 'block' ? 'BLOCKED' : 'DODGED', 180, 98, GREEN); }
    else { st.you--; st.youPose = 'hit'; st.npcPose = 'swing'; SFX.play('thud'); SFX.play('grunt', { delay: 0.05 }); st.shake = 0.4; st.flash = 1; st.flashC = '255,107,107'; P.add('OOF', 180, 98, RED); D.burst(180, 150, 10); hype = 0.7; }
    if (st.npc <= 0 || st.you <= 0) {
      st.done = true; st.ok = st.npc <= 0; st.phase = 'end'; st.flash = 1; st.flashC = st.ok ? '255,225,74' : '255,107,107'; SFX.play(st.ok ? 'win' : 'fail', { delay: 0.25 });
      if (st.ok) { rec.streak++; rec.wins++; rec.best = Math.max(rec.best, rec.streak); st.npcPose = 'down'; D.burst(330, 210, 24); hype = 1; st.say = 'Ow. Same time next week?'; }
      else { rec.streak = 0; st.youPose = 'down'; st.say = TAUNT[Math.floor(Math.random() * TAUNT.length)]; }
      st.sayT = 4; save('spar', rec); sh.kick(st.ok ? 5 : 8); if (st.ok) fx.burst(300, 150, { n: 40 });
      setTimeout(() => st.done && F.finish({ title: st.ok ? 'TYRONE IS DOWN' : 'YOU SEE STARS', sub: st.ok ? 'same time next week' : '"' + st.say + '"', color: st.ok ? PAL.gold : PAL.red, win: st.ok, stats: [['streak', rec.streak, PAL.green], ['best', rec.best, PAL.cyan], ['wins', rec.wins, PAL.gold]] }), 1100);
    }
  };
  const kd = (/** @type {KeyboardEvent} */ e) => {
    if (F.phase !== 'play') return;
    if (st.done) return;
    const act = KEYMAP[e.code]; if (!act) return; e.preventDefault();
    if (st.phase === 'tele') { if (st.pt > 0.38) { SFX.play('ui.deny'); P.add('too early!', 180, 80, RED); resolve(st.move === 'open' ? null : '_early'); } else resolve(act); }
    else if (st.phase === 'strike') resolve(act);
  };
  st.ctx = ctx;
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  // mouse: click the top third = block, middle = jab, bottom third = dodge (same timing rules as the keys); click when done = rematch
  const fake = code => ({ code, preventDefault() {} });
  mouse(ov, c, W, H).set([['ArrowUp', 0], ['Space', 1], ['ArrowDown', 2]].map(([code, i]) => ({ x: 0, y: +i * H / 3, w: W, h: H / 3, pick: () => kd(/** @type {any} */ (fake(code))) })));
  const D = dust(); let hype = 0; const sh = shaker(), fx = particles();
  const F = cardFlow(ov, c, W, H, { surface: cardboard, accent: '#ffb36b', again: () => reset() });
  F.setCard({ title: 'THE RING', sub: 'sparring vs Tyrone. no blood, just pride', lines: ['Read his wind-up, then answer on NOW.'], chips: [['[↑]', 'block', '|', '[↓]', 'dodge', '|', '[→]', '[space]', 'jab when open'], ['[click]', 'top / middle / bottom third']] });
  const wall = cached(W, H, cx => drawWall(cx, W, H));
  const pips = (X, n, max, col) => { for (let i = 0; i < max; i++) { const on = i < n, px = X + i * 18; x.fillStyle = '#1a1010'; x.fillRect(px, 27, 14, 12); x.fillStyle = on ? col : '#4a3a30'; x.fillRect(px + 1, 28, 12, 9); if (on) { x.fillStyle = 'rgba(255,255,255,0.35)'; x.fillRect(px + 2, 29, 10, 2); } } };
  loop(ov, (dt, t) => {
    st.t += dt; st.shake = Math.max(0, st.shake - dt); st.flash = Math.max(0, st.flash - dt * 2); st.sayT -= dt;
    st.poseT -= dt; if (st.poseT <= 0 && !st.done) { st.youPose = 'guard'; if (st.phase !== 'tele') st.npcPose = 'guard'; }
    if (!st.done && F.phase === 'play') {
      st.pt -= dt;
      if (st.phase === 'idle' && st.pt <= 0) { pick(); st.phase = 'tele'; st.pt = st.tele; st.npcPose = st.move === 'open' ? 'open' : 'wind'; SFX.play(st.move === 'open' ? 'tick' : 'swoosh', { vol: 0.35, pitch: 0.7 }); }
      else if (st.phase === 'tele' && st.pt <= 0) { st.phase = 'strike'; st.pt = 0.38; if (st.move !== 'open') st.npcPose = 'jab'; }
      else if (st.phase === 'strike' && st.pt <= 0) resolve(null);
    }
    if (st.shake > 0.3) { sh.kick(st.shake * 14); st.shake = 0.29; }
    x.save(); sh.apply(x, dt);
    hype = Math.max(st.done && st.ok ? 0.6 : 0.1, hype - dt * 0.8);
    wall(x, 0, 0); drawBulb(x, W, H, Math.sin(t * 0.8));
    const npcPose = st.npcPose === 'swing' ? 'jab' : st.npcPose;
    drawFighter(x, 180, 214, 1, st.youPose === 'block' ? 'block' : st.youPose === 'dodge' ? 'dodge' : st.youPose, t, YOU);
    drawFighter(x, 300, 214, -1, npcPose, t, TYR);
    D.draw(x, dt);
    drawCrowd(x, W, H, t, hype);
    if (st.phase === 'tele' || st.phase === 'strike') { const m = MOVES[st.move]; const ready = st.phase === 'strike' || st.pt <= 0.38;
      title(x, m.tip, 310, 112, { size: 32, color: ready ? m.c : PAL.cream, glow: ready ? m.c : undefined, glowR: 12 }); if (ready) title(x, 'NOW!', 310, 132, { size: 16, color: m.c }); }
    cardboard(x, 8, 8, 82, 38, { tape: false }); tape(x, 49, 9, 26, 0.05, 8); title(x, 'YOU', 14, 23, { size: 16, align: 'left', color: PAL.cream }); pips(14, st.you, 3, GREEN);
    cardboard(x, W - 108, 8, 100, 38, { tape: false }); tape(x, W - 58, 9, 26, -0.05, 8); title(x, 'TYRONE', W - 14, 23, { size: 16, align: 'right', color: PAL.cream }); pips(W - 102, st.npc, 5, RED);
    cardboard(x, 168, 8, 144, 26, { tape: false }); title(x, `STREAK ${rec.streak}   BEST ${rec.best}`, 240, 26, { size: 16, body: true, color: PAL.cream });
    if (st.sayT > 0 && F.phase === 'play') title(x, '"' + st.say + '"', 310, 150, { size: 16, body: true, color: PAL.cream });
    fx.draw(x, dt);
    P.draw(x, dt);
    x.restore();
    if (st.flash > 0) { x.fillStyle = `rgba(${st.flashC},${st.flash * 0.35})`; x.fillRect(0, 0, W, H); }
    F.draw(x, dt);
  });
}
