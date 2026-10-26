// @ts-check
// Sparring: a cartoony timing duel vs a cocky NPC. Read the wind-up, then block (high), dodge (low) or jab (open guard).
// No blood: a knock-down is a comic stagger with stars. Win streak + best saved.
import { loop, text } from './util.js';
import { SFX } from '../sfx.js';
import { load, save, pops, INK, AMBER, GREEN, RED, PINK } from './fightclub-util.js';
import { drawFighter, drawBackdrop, drawCrowd, dust } from './fightclub-fighter.js';
const YOU = { top: '#e8e4dc', topS: '#b0aca4', topH: '#ffffff', skin: '#e8b890', skinS: '#c08a64', hair: '#5a3a22', pants: '#4a5a7a', pantsS: '#34405a' };
const TYR = { top: '#c0402a', topS: '#8a2a1a', topH: '#e86a4a', skin: '#c88a5a', skinS: '#9a6440', hair: '#e0c060', pants: '#2a2a30', pantsS: '#18181c' };

const MOVES = { high: { key: 'block', tip: 'HIGH! block', c: AMBER }, low: { key: 'dodge', tip: 'LOW! dodge', c: '#7fd6ff' }, open: { key: 'jab', tip: 'OPEN! jab', c: GREEN } };
const KEYMAP = { ArrowUp: 'block', KeyW: 'block', ArrowDown: 'dodge', KeyS: 'dodge', ArrowRight: 'jab', KeyD: 'jab', Space: 'jab' };
const TAUNT = ['Is that all?', 'I am Jack\'s smirking face.', 'Hit me. I dare you.', 'You\'re not your khakis.'];

/** @param {any} ctx */
export function startSpar(ctx) {
  const ov = ctx.overlay({ title: 'The Ring', sub: 'sparring vs Tyrone', help: '<kbd>↑</kbd> block high <kbd>↓</kbd> dodge low <kbd>→</kbd>/<kbd>space</kbd> jab when open <kbd>enter</kbd> rematch <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
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
      st.sayT = 4; save('spar', rec);
    }
  };
  const kd = (/** @type {KeyboardEvent} */ e) => {
    if (st.done) { if (e.code === 'Enter' || e.code === 'Space') { SFX.play('go'); reset(); } return; }
    const act = KEYMAP[e.code]; if (!act) return; e.preventDefault();
    if (st.phase === 'tele') { if (st.pt > 0.38) { SFX.play('ui.deny'); P.add('too early!', 180, 80, RED); resolve(st.move === 'open' ? null : '_early'); } else resolve(act); }
    else if (st.phase === 'strike') resolve(act);
  };
  st.ctx = ctx;
  addEventListener('keydown', kd); ov.onClose(() => removeEventListener('keydown', kd));
  const D = dust(); let hype = 0;
  loop(ov, (dt, t) => {
    st.t += dt; st.shake = Math.max(0, st.shake - dt); st.flash = Math.max(0, st.flash - dt * 2); st.sayT -= dt;
    st.poseT -= dt; if (st.poseT <= 0 && !st.done) { st.youPose = 'guard'; if (st.phase !== 'tele') st.npcPose = 'guard'; }
    if (!st.done) {
      st.pt -= dt;
      if (st.phase === 'idle' && st.pt <= 0) { pick(); st.phase = 'tele'; st.pt = st.tele; st.npcPose = st.move === 'open' ? 'open' : 'wind'; SFX.play(st.move === 'open' ? 'tick' : 'swoosh', { vol: 0.35, pitch: 0.7 }); }
      else if (st.phase === 'tele' && st.pt <= 0) { st.phase = 'strike'; st.pt = 0.38; if (st.move !== 'open') st.npcPose = 'jab'; }
      else if (st.phase === 'strike' && st.pt <= 0) resolve(null);
    }
    const sx = st.shake > 0 ? Math.round(Math.sin(t * 80) * 4) : 0;
    x.save(); x.translate(sx, 0);
    hype = Math.max(st.done && st.ok ? 0.6 : 0.1, hype - dt * 0.8);
    drawBackdrop(x, W, H, t, Math.sin(t * 0.8));
    const npcPose = st.npcPose === 'swing' ? 'jab' : st.npcPose;
    drawFighter(x, 180, 214, 1, st.youPose === 'block' ? 'block' : st.youPose === 'dodge' ? 'dodge' : st.youPose, t, YOU);
    drawFighter(x, 300, 214, -1, npcPose, t, TYR);
    D.draw(x, dt);
    drawCrowd(x, W, H, t, hype);
    if (st.phase === 'tele' || st.phase === 'strike') { const m = MOVES[st.move]; const ready = st.phase === 'strike' || st.pt <= 0.38;
      text(x, m.tip, 310, 112, { size: 32, color: ready ? m.c : '#e8e0cc', align: 'center', shadow: '#000' }); if (ready) text(x, 'NOW', 310, 128, { color: m.c, align: 'center' }); }
    for (let i = 0; i < 3; i++) { x.fillStyle = i < st.you ? GREEN : '#443'; x.fillRect(16 + i * 18, 14, 14, 10); x.fillStyle = '#140e10'; x.fillRect(16 + i * 18, 24, 14, 2); }
    for (let i = 0; i < 5; i++) { x.fillStyle = i < st.npc ? RED : '#443'; x.fillRect(W - 30 - i * 18, 14, 14, 10); }
    text(x, 'YOU', 16, 40, { color: INK }); text(x, 'TYRONE', W - 16, 40, { color: INK, align: 'right' });
    text(x, `streak ${rec.streak}  best ${rec.best}  wins ${rec.wins}`, 240, 20, { color: PINK, align: 'center' });
    if (st.sayT > 0) text(x, '"' + st.say + '"', 310, 146, { color: INK, align: 'center', shadow: '#000' });
    P.draw(x, dt);
    if (st.done) { x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(90, 52, 300, 70); text(x, st.ok ? 'TYRONE IS DOWN!' : 'YOU SEE STARS', 240, 84, { size: 32, title: true, color: st.ok ? '#ffe14a' : RED, align: 'center' }); text(x, 'enter: rematch', 240, 110, { color: INK, align: 'center' }); }
    x.restore();
    if (st.flash > 0) { x.fillStyle = `rgba(${st.flashC},${st.flash * 0.35})`; x.fillRect(0, 0, W, H); }
  });
}
