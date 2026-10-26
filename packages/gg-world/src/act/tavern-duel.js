// @ts-check
// Tavern card duel vs the innkeeper: 5 turns, mana = turn, hand of 3. Most HP after turn 5 (or 0 HP) decides. Streak saved.
import { SFX } from '../sfx.js';
import { loop, text, coins, rng } from './util.js';
import { button, onClick, onKey, hit, load, save, pops, GOLDC } from './tavern-ui.js';
import { CARDS, CW, CH, table, portrait, card } from './tavern-cards.js';
import { PAL, badge, title, particles, shaker } from './art.js';
import { cardFlow, parchment } from './fightclub-ui.js';

const HP = 14;
/** card effect sound @param {any} k @param {number} [delay] */
const cardSfx = (k, delay = 0) => { SFX.play('card.flip', { delay }); SFX.play(k.ic === 'fire' ? 'fire' : k.ic === 'spark' ? 'zap' : k.ic === 'fish' ? 'gurgle' : k.d ? 'punch' : k.h ? 'pour' : 'block', { delay: delay + 0.18, vol: 0.8 }); };

/** @param {any} ctx */
/** wood-framed parchment card surface */
const parchmentFramed = (x, X, Y, w, h) => { parchment(x, X, Y, w, h); x.fillStyle = 'rgba(40,20,8,0.55)'; x.fillRect(X + 4, Y + 4, w - 8, h - 8); };
export function startDuel(ctx) {
  const ov = ctx.overlay({ title: 'Tavern Duel', sub: 'vs the innkeeper · 5 turns', help: '<kbd>1-3</kbd> play card <kbd>space</kbd> end turn <kbd>enter</kbd> start / play again <kbd>click</kbd> cards / buttons <kbd>esc</kbd> leave' });
  const W = 480, H = 270; const { c, x } = ov.canvas(W, H); x.imageSmoothingEnabled = false;
  const rec = load('duel', { streak: 0, best: 0, wins: 0 });
  const r = rng((Date.now() & 0xffff) + 3); const P = pops(); const draw = () => CARDS[Math.floor(r() * (CARDS.length - 0.3))];
  /** @type {any} */ let g; let t = 0, shake = 0; /** @type {any[]} */ let hb = []; /** @type {any} */ let endB = null;
  /** @type {{k:any, fx:number, fy:number, tx:number, ty:number, t:number, ai:boolean}[]} */ let flying = [];
  const HX = i => 148 + i * 72, HY = 174, SLOT = i => 180 + (i % 3) * 74;
  let batch = 0;
  const reset = () => { g = { turn: 1, mana: 2, me: { hp: HP, blk: 0, hurt: 0 }, ai: { hp: HP, blk: 0, hurt: 0 }, hand: [draw(), draw(), draw()], over: '', overT: 0, log: ['Your turn.', 'Mana = turn + 1.'] }; flying = []; };
  /** @param {any} who */
  const hitP = (who, d, px, _py) => { const a = Math.min(who.blk, d); who.blk -= a; who.hp = Math.max(0, who.hp - (d - a)); who.hurt = 0.3; P.add(a ? `-${d - a} (${a} blocked)` : `-${d}`, px, who === g.me ? 236 : 84, '#ff6a4a'); shake = 0.25; };
  /** @param {any} k @param {any} me @param {any} foe */
  const apply = (k, me, foe, px, py, fx) => { if (k.d) hitP(foe, k.d, fx, 0); if (k.h) { me.hp = Math.min(HP, me.hp + k.h); P.add(`+${k.h}`, px, py, '#6ee76a'); } if (k.b) { me.blk += k.b; P.add(`+${k.b} block`, px, py, '#8ab0ff'); } };
  const finish = () => { if (g.over) return; const w = g.ai.hp <= 0 || (g.turn > 5 && g.me.hp > g.ai.hp), l = g.me.hp <= 0 || (g.turn > 5 && g.me.hp <= g.ai.hp);
    if (!w && !l) return; g.over = w ? 'win' : 'lose'; g.overT = 0; SFX.play(w ? 'win' : 'fail', { delay: 0.5 });
    if (w) { rec.streak++; rec.wins++; rec.best = Math.max(rec.best, rec.streak); coins(ctx.S).spend(-(10 + rec.streak * 5)); P.add(`+${10 + rec.streak * 5} coins`, W / 2, 150, GOLDC); } else rec.streak = 0;
    save('duel', rec); if (w) fx.burst(W / 2, 90, { n: 36 }); else sh.kick(6);
    setTimeout(() => F.finish({ title: w ? 'VICTORY!' : 'DEFEAT', sub: w ? '"Well played. Next round is on you."' : '"You are not prepared. Again?"', color: w ? PAL.gold : PAL.red, win: w,
      stats: [['you', g.me.hp, PAL.green], ['keeper', g.ai.hp, PAL.red], ['streak', rec.streak, PAL.gold], ['best', rec.best, PAL.cyan]] }), 900); };
  /** @param {number} i */
  const play = i => { const k = g.hand[i]; if (!g.over && k && k.m > g.mana) { SFX.play('ui.deny'); sh.kick(2); } if (g.over || !k || k.m > g.mana) return; g.mana -= k.m; cardSfx(k);
    flying = flying.filter(f => !f.ai); flying.push({ k, fx: HX(i) + 30, fy: HY, tx: SLOT(batch++), ty: 64, t: 0, ai: false }); apply(k, g.me, g.ai, 130, 236, 260); g.hand.splice(i, 1); g.log = ['You play', k.n + '.']; finish(); };
  const endTurn = () => { if (g.over) return; SFX.play('ui.click'); flying = []; batch = 0;
    let mana = g.turn + 1; const opts = CARDS.filter(k => k.m <= g.turn + 1).sort((a, b) => b.m - a.m); /** @type {string[]} */ const played = [];
    while (mana > 0 && played.length < 2) { const k = (g.ai.hp < 6 && !played.includes('Mug of Ale')) ? CARDS[1] : opts.filter(o => o.m <= mana)[Math.floor(r() * opts.filter(o => o.m <= mana).length)]; if (!k) break; mana -= k.m;
      flying.push({ k, fx: 380, fy: 20, tx: SLOT(played.length), ty: 64, t: -played.length * 0.35, ai: true }); played.push(k.n); cardSfx(k, 0.2 + (played.length - 1) * 0.35); apply(k, g.ai, g.me, 260, 84, 130); }
    g.log = ['Innkeeper plays', ...(played.length ? played.map(n => '· ' + n) : ['nothing.'])]; g.ai.blk = Math.min(g.ai.blk, 4);
    g.turn++; g.mana = g.turn + 1; g.me.blk = 0; while (g.hand.length < 3) g.hand.push(draw()); finish(); };
  const fx = particles(), sh = shaker();
  const F = cardFlow(ov, c, W, H, { surface: parchmentFramed, accent: PAL.goldD, again: () => { reset(); SFX.play('shuffle'); } });
  F.setCard({ title: 'TAVERN DUEL', sub: 'vs the innkeeper. five turns', lines: ['Mana = turn + 1. Most HP after turn 5 wins.'], chips: [['[1]', '[2]', '[3]', 'play a card', '|', '[space]', 'end turn'], ['[click]', 'cards and buttons']] });
  reset();
  onKey(ov, code => { if (F.phase !== 'play') return; if (/^Digit[1-3]$/.test(code)) play(+code.slice(-1) - 1); else if (code === 'Space') endTurn(); });
  onClick(ov, c, W, H, (px, py) => { if (F.phase !== 'play') return; hb.forEach((bb, i) => { if (hit(bb, px, py)) play(i); }); if (hit(endB, px, py)) endTurn(); });
  /** @param {any} who */
  const bar = (who, px, py, col) => { x.fillStyle = '#1a0a08'; x.fillRect(px - 1, py - 1, 102, 10); x.fillStyle = '#4a1a14'; x.fillRect(px, py, 100, 8);
    x.fillStyle = col; x.fillRect(px, py, 100 * who.hp / HP, 8); x.fillStyle = 'rgba(255,255,255,0.3)'; x.fillRect(px, py, 100 * who.hp / HP, 2);
    text(x, `${who.hp}/${HP}`, px + 104, py + 9, { color: '#ffe8b0', shadow: '#1a0a08' });
    if (who.blk) { const bx = who === g.me ? 86 : px + 142, by = who === g.me ? 222 : py - 3; x.fillStyle = '#8aa0c8'; x.fillRect(bx, by, 14, 14); text(x, String(who.blk), bx + 7, by + 12, { color: '#1a1a3a', align: 'center' }); } };
  loop(ov, dt => {
    t += dt; shake = Math.max(0, shake - dt); g.me.hurt = Math.max(0, g.me.hurt - dt); g.ai.hurt = Math.max(0, g.ai.hurt - dt);
    if (shake > 0.2) { sh.kick(5); shake = 0.2; }
    x.save(); sh.apply(x, dt);
    table(x, W, H);
    // innkeeper: portrait, hp, face-down hand
    portrait(x, 36, 26, 'keep', g.ai.hurt); title(x, 'Innkeeper', 90, 37, { size: 16, align: 'left', color: PAL.goldHi }); bar(g.ai, 90, 44, '#e0a458');
    for (let i = 0; i < 3; i++) { const bx = 300 + i * 22, by = 28; x.fillStyle = '#3a2412'; x.fillRect(bx, by, 26, 36); x.fillStyle = '#6a2a3a'; x.fillRect(bx + 2, by + 2, 22, 32); x.fillStyle = '#d8a43a'; x.fillRect(bx + 10, by + 15, 6, 6); }
    // turn + mana
    title(x, g.turn <= 5 ? `Turn ${g.turn}/5` : 'Last call!', 440, 116, { size: 16, color: GOLDC });
    for (let i = 0; i < Math.max(g.turn + 1, g.mana) && i < 6; i++) { const on = i < g.mana, mx = 412 + i * 12, my = 130;
      x.fillStyle = on ? '#4a8aff' : '#1a2a4a'; x.beginPath(); x.moveTo(mx, my - 5); x.lineTo(mx + 5, my); x.lineTo(mx, my + 5); x.lineTo(mx - 5, my); x.fill(); }
    g.log.forEach((l, i) => title(x, l, 36, 96 + i * 16, { size: 16, body: true, align: 'left', color: i ? PAL.cream : PAL.gold }));
    // played cards: slide in, AI cards flip from back to face, then fade
    flying = flying.filter(f => f.t < 3.2);
    for (const f of flying) { f.t += dt; if (f.t < 0) continue; const k = Math.min(1, f.t / 0.35), e = 1 - (1 - k) ** 3;
      const sx = f.ai ? Math.cos(Math.min(1, f.t / 0.6) * Math.PI) * -1 : 1;
      x.globalAlpha = f.t > 2.7 ? Math.max(0, (3.2 - f.t) / 0.5) : 1;
      card(x, f.k, f.fx + (f.tx - f.fx) * e, f.fy + (f.ty - f.fy) * e + 10, { sx, t }); x.globalAlpha = 1; }
    // you: portrait, hp, hand
    portrait(x, 36, 196, 'you', g.me.hurt); title(x, 'You', 36, 189, { size: 16, align: 'left', color: PAL.goldHi }); bar(g.me, 36, 246, '#6ee76a');
    hb = g.over ? [] : g.hand.map((k, i) => { const ok = k.m <= g.mana && !g.over, lift = ok ? -4 + Math.sin(t * 3 + i) * 1.5 : 4;
      card(x, k, HX(i) + 30, HY + lift, { dim: !ok, glow: ok, t }); title(x, String(i + 1), HX(i) + 30 + CW / 2, HY + lift - 4, { size: 16, body: true });
      return { x: HX(i) + 30, y: HY, w: CW, h: CH }; });
    endB = button(x, 'End turn', 404, 200, 66, 24, { on: !g.over });
    badge(x, 402, 228, 'run', rec.streak, { w: 34, h: 34, style: 'wood' }); badge(x, 438, 228, 'best', rec.best, { w: 34, h: 34, style: 'wood', color: PAL.cyan });
    P.draw(x, dt); fx.draw(x, dt); x.restore(); F.draw(x, dt);
  });
}
