// @ts-check
// Tavern card duel (GX kit, concept showcase/minigames/concepts/tavern.html: a felt table under the lamp, the innkeeper's
// portrait across it, real parchment cards in your hand) vs the innkeeper: 5 turns, mana = turn, hand of 3. Most HP after turn 5 (or 0 HP) decides. Streak saved.
import { SFX } from '../sfx.js';
import { coins, rng } from './util.js';
import { load, save } from './tavern-ui.js';
import { CARDS } from './tavern-cards.js';
import { gx } from './gx.js';

const HP = 14;
/** card effect sound @param {any} k @param {number} [delay] */
const cardSfx = (k, delay = 0) => { SFX.play('card.flip', { delay }); SFX.play(k.ic === 'fire' ? 'fire' : k.ic === 'spark' ? 'zap' : k.ic === 'fish' ? 'gurgle' : k.d ? 'punch' : k.h ? 'pour' : 'block', { delay: delay + 0.18, vol: 0.8 }); };
const ART = {
  ale: '<path d="M48 52h36v44q0 8-8 8H56q-8 0-8-8z" fill="#e8a83a"/><path d="M48 52h36v10H48z" fill="#fff6e0"/><circle cx="54" cy="50" r="7" fill="#fffaf0"/><circle cx="66" cy="47" r="8" fill="#fffaf0"/><circle cx="78" cy="50" r="7" fill="#fffaf0"/><path d="M84 62h8q8 0 8 10v8q0 10-8 10h-8" fill="none" stroke="#c98a2a" stroke-width="6"/><path d="M54 66v30" stroke="#fff" stroke-opacity=".35" stroke-width="4" stroke-linecap="round"/>',
  shield: '<path d="M46 50h40v50q0 6-6 6H52q-6 0-6-6z" fill="#9aa8b8"/><path d="M44 46h44v8H44z" fill="#c9d3de"/><path d="M60 40h18l4 6H58z" fill="#b2bfcc"/><path d="M86 58h8q8 0 8 10v12q0 10-8 10h-8" fill="none" stroke="#7d8a99" stroke-width="6"/><path d="M46 70h40M46 88h40" stroke="#6c7887" stroke-width="3"/><path d="M52 56v42" stroke="#fff" stroke-opacity=".45" stroke-width="3" stroke-linecap="round"/>',
  fist: '<path d="M44 66q0-10 10-10h30q10 0 10 10v18q0 18-20 18H58q-14 0-14-14z" fill="#e9b08a"/><path d="M54 56v14M66 56v14M78 56v14" stroke="#b5785a" stroke-width="2.5"/><path d="M44 74q10-4 18 2" stroke="#b5785a" stroke-width="2.5" fill="none"/><path d="M100 44l8-6M104 58l12 0M100 72l8 6M30 44l-6-6M28 60h-10" stroke="#ffd29a" stroke-width="3.5" stroke-linecap="round"/>',
  spark: '<path d="M70 26l-20 40h16l-8 34 30-44H72l10-30z" fill="#fff1c0" stroke="#ffb36b" stroke-width="3" stroke-linejoin="round"/><circle cx="40" cy="40" r="3" fill="#fff"/><circle cx="96" cy="84" r="3" fill="#fff"/>',
  fish: '<path d="M36 60q26-26 56 0q-30 26-56 0z" fill="#5aa86a"/><path d="M92 60l16-14v28z" fill="#3f8a50"/><circle cx="50" cy="56" r="4" fill="#fff"/><circle cx="51" cy="56" r="2" fill="#123"/><path d="M60 50q8 10 0 20M70 48q8 12 0 24" stroke="#2f6a3e" stroke-width="2.5" fill="none"/>',
  fire: '<circle cx="66" cy="62" r="30" fill="#ff5a2a"/><circle cx="66" cy="62" r="20" fill="#ffb36b"/><circle cx="62" cy="58" r="10" fill="#fff1c0"/><path d="M96 62q14-10 20-24M92 78q16 0 24 10M94 46q4-16 0-24" stroke="#ffd29a" stroke-width="4" stroke-linecap="round" fill="none"/>',
};
let uid = 0;
/** parchment card SVG (concept tavern.html) @param {any} k */
const cardSVG = k => { const id = 'td' + uid++; return `<svg viewBox="0 0 140 196" aria-hidden="true"><defs>
<linearGradient id="f${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e7c27a"/><stop offset=".5" stop-color="#a8743a"/><stop offset="1" stop-color="#5c3a18"/></linearGradient>
<linearGradient id="p${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6ead2"/><stop offset="1" stop-color="#e2cfa8"/></linearGradient>
<radialGradient id="a${id}" cx=".5" cy=".3"><stop offset="0" stop-color="#ffe0b0"/><stop offset=".6" stop-color="${k.c}"/><stop offset="1" stop-color="#2a1608"/></radialGradient>
<radialGradient id="g${id}" cx=".35" cy=".3"><stop offset="0" stop-color="#bfe9ff"/><stop offset=".5" stop-color="#3a8ee0"/><stop offset="1" stop-color="#123a7a"/></radialGradient></defs>
<rect x="1" y="1" width="138" height="194" rx="12" fill="url(#f${id})"/><rect x="6" y="6" width="128" height="184" rx="8" fill="url(#p${id})"/>
<rect x="12" y="14" width="116" height="86" rx="6" fill="url(#a${id})"/><g transform="translate(4 0)">${ART[k.ic] || ''}</g>
<rect x="12" y="14" width="116" height="86" rx="6" fill="none" stroke="#5c3a18" stroke-width="2"/><path d="M40 125h60" stroke="#a8743a" stroke-opacity=".5"/>
<path d="M18 4l14 12-14 14-14-14z" transform="translate(0 2)" fill="url(#g${id})" stroke="#e7c27a" stroke-width="2"/></svg>
<span class="cost">${k.m}</span><span class="nm">${k.n}</span><span class="tx">${k.t}</span>`; };
const INN = `<svg viewBox="0 0 160 170" aria-label="The Innkeeper"><defs>
<radialGradient id="tdskin" cx=".45" cy=".35"><stop offset="0" stop-color="#ffd8b0"/><stop offset="1" stop-color="#c98a5e"/></radialGradient>
<linearGradient id="tdapron" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1e6d0"/><stop offset="1" stop-color="#b9a787"/></linearGradient>
<linearGradient id="tdvest" x1="0" x2="1"><stop offset="0" stop-color="#5a2a22"/><stop offset=".5" stop-color="#8a3b2c"/><stop offset="1" stop-color="#4a201a"/></linearGradient>
<radialGradient id="tdframe" cx=".5" cy=".4"><stop offset="0" stop-color="#3a2a22"/><stop offset="1" stop-color="#170f0c"/></radialGradient><clipPath id="tdcl"><circle cx="80" cy="80" r="70"/></clipPath></defs>
<circle cx="80" cy="80" r="76" fill="url(#tdframe)" stroke="#c9944f" stroke-width="4"/><g clip-path="url(#tdcl)"><ellipse cx="80" cy="40" rx="60" ry="40" fill="#ffd29a" opacity=".12"/>
<path d="M18 170q4-52 62-56q58 4 62 56z" fill="url(#tdvest)"/><path d="M58 118q22 10 44 0l6 52h-56z" fill="url(#tdapron)"/><path d="M68 114h24l-12 14z" fill="#e9dcc2"/><rect x="74" y="98" width="12" height="18" fill="#c08560"/>
<ellipse cx="80" cy="72" rx="30" ry="34" fill="url(#tdskin)"/><ellipse cx="49" cy="74" rx="6" ry="9" fill="#d89a6c"/><ellipse cx="111" cy="74" rx="6" ry="9" fill="#d89a6c"/>
<path d="M50 60q2-30 30-30t30 30q-6-14-30-14t-30 14z" fill="#7a7068"/><path d="M58 90q22 34 44 0q4 22-22 30q-26-8-22-30z" fill="#b8aea4"/><path d="M64 88q16-8 32 0q-6 6-16 4q-10 2-16-4z" fill="#8f857c"/>
<path d="M62 62q6-4 12 0M86 62q6-4 12 0" stroke="#4a3a30" stroke-width="3" stroke-linecap="round" fill="none"/><ellipse cx="68" cy="70" rx="3" ry="3.4" fill="#2a1d16"/><ellipse cx="92" cy="70" rx="3" ry="3.4" fill="#2a1d16"/>
<path d="M80 70q-6 10 0 13q5 0 4-3" fill="#d9926a"/><ellipse cx="62" cy="80" rx="6" ry="3" fill="#ff8a7a" opacity=".35"/><ellipse cx="98" cy="80" rx="6" ry="3" fill="#ff8a7a" opacity=".35"/><path d="M73 95q7 4 14 0" stroke="#5a3a2a" stroke-width="2" fill="none" stroke-linecap="round"/></g>
<circle cx="80" cy="80" r="74" fill="none" stroke="#ff5fd2" stroke-opacity=".22" stroke-width="2" stroke-dasharray="60 400" transform="rotate(130 80 80)"/></svg>`;
const GRAIN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .22 0'/%3E%3C/filter%3E%3Crect width='128' height='128' filter='url(%23n)'/%3E%3C/svg%3E")`;
const CSS = `
.td{position:absolute;inset:0;--s:1cqw}
.td .table{position:absolute;left:50%;top:47%;width:82cqw;height:42cqw;translate:-50% -50%;border-radius:50%/46%;background:radial-gradient(ellipse at 50% 30%,#8a5a34,#5a3519 60%,#2e190b);box-shadow:0 3cqw 6cqw rgba(0,0,0,.7),inset 0 2px 0 rgba(255,220,170,.35),inset 0 -6px 14px rgba(0,0,0,.5)}
.td .table::before{content:"";position:absolute;inset:2.2cqw;border-radius:inherit;background:${GRAIN},radial-gradient(ellipse 60% 70% at 50% 34%,#3f7a52,#24513a 55%,#123024);box-shadow:inset 0 0 0 2px rgba(240,190,110,.25),inset 0 1cqw 4cqw rgba(0,0,0,.65)}
.td .candle{position:absolute;left:73%;top:30%;width:6cqw}
.td .flame{transform-origin:50% 100%;animation:td-flick 2.4s ease-in-out infinite alternate}@keyframes td-flick{to{transform:scale(.94,1.06) skewX(2deg)}}
.td .inn{position:absolute;left:50%;top:2%;translate:-50% 0;width:17cqw;text-align:center}
.td .inn svg{width:100%;display:block;filter:drop-shadow(0 10px 18px rgba(0,0,0,.6))}
.td .tdw{margin-top:4px;font-size:12px;font-weight:600;color:#c2c7ce}
.td .bar{position:relative;display:flex;align-items:center;gap:8px;font-size:max(11px,1.2cqw);font-weight:700;font-variant-numeric:tabular-nums}
.td .track{position:relative;flex:1;height:14px;border-radius:7px;background:rgba(10,8,6,.75);box-shadow:inset 0 1px 3px #000,0 0 0 1px rgba(255,220,170,.18)}
.td .fill{position:absolute;inset:2px auto 2px 2px;border-radius:5px;background:linear-gradient(#ff9a7a,#d9433a 60%,#a82a2a);box-shadow:inset 0 1px 0 rgba(255,255,255,.35);transition:width .5s cubic-bezier(.22,1,.36,1)}
.td .me .fill{background:linear-gradient(#a8f0b8,#4fb86a 60%,#2a7a40)}
.td .gem{width:16px;height:16px;rotate:45deg;border-radius:3px;background:linear-gradient(135deg,#ffd9a0,#c47a2a);box-shadow:0 0 0 1.5px #3a2310,0 2px 4px #000}
.td .shield{position:absolute;right:-4px;top:-12px;font-size:11px;padding:2px 6px;border-radius:6px;background:#3d5a8a;color:#e8f0ff;opacity:0;transition:opacity .3s}.td .shield.on{opacity:1}
.td .inn .bar{margin:.6cqw 0 0 -2.5cqw;width:22cqw}
.td .me{position:absolute;left:1.5cqw;bottom:2cqw;width:max(19cqw,170px)}.td .mana b{white-space:nowrap}
.td .mana{display:flex;gap:5px;margin-top:10px;align-items:center}.td .mana svg{width:14px;height:20px;transition:opacity .3s}
.td .mana svg.off{opacity:.25;filter:grayscale(1)}.td .mana svg.on{filter:drop-shadow(0 0 6px #6fd3ff)}.td .mana b{margin-left:4px;font-size:13px;color:#a9e6ff}
.td .turn{position:absolute;left:50%;top:69%;translate:-50% -50%;padding:6px 14px;border-radius:999px;background:rgba(18,12,8,.6);box-shadow:inset 0 0 0 1px rgba(255,210,154,.25);font-size:12px;font-weight:600;color:#ffd29a;white-space:nowrap}
.td .played{position:absolute;left:50%;top:47%;translate:-50% 0;display:flex;gap:1cqw;pointer-events:none}
.td .hand{position:absolute;left:50%;bottom:1cqw;translate:-50% 0;display:flex;gap:1.6cqw}
.td .c{all:unset;position:relative;width:11cqw;aspect-ratio:140/196;cursor:pointer;color:#2a1a0c;transition:transform .24s cubic-bezier(.22,1,.36,1),filter .24s;filter:drop-shadow(0 8px 10px rgba(0,0,0,.55))}
.td .hand .c:nth-child(1){transform:rotate(-5deg) translateY(6px)}.td .hand .c:nth-child(3){transform:rotate(5deg) translateY(6px)}
.td .hand .c:hover:not(.no),.td .hand .c:focus-visible{transform:translateY(-22px) scale(1.06);filter:drop-shadow(0 26px 22px rgba(0,0,0,.5));z-index:2}
.td .c.no{filter:drop-shadow(0 8px 10px rgba(0,0,0,.55)) saturate(.35) brightness(.7);cursor:not-allowed}
.td .c svg{position:absolute;inset:0;width:100%;height:100%}
.td .c .nm{position:absolute;left:8%;right:8%;top:53.5%;font-size:1.05cqw;line-height:1.1;font-weight:700;text-align:center}
.td .c .tx{position:absolute;left:12%;right:12%;top:68%;font-size:.95cqw;line-height:1.3;font-weight:600;text-align:center;color:#8a2b1c}
.td .c .cost{position:absolute;left:3%;top:1.5%;width:23%;aspect-ratio:1;display:grid;place-items:center;font-size:1.4cqw;font-weight:800;color:#fff;text-shadow:0 1px 2px #013}
.td .c .gx-key{position:absolute;top:-10px;right:-6px}
.td .played .c{width:11cqw;margin:0 -1.8cqw;zoom:.7;animation:td-in .45s cubic-bezier(.22,1,.36,1) both;cursor:default}
.td .played .c.ai{animation-name:td-flip}
@keyframes td-in{from{transform:translateY(18cqw) scale(1.3) rotate(-8deg);opacity:0}}@keyframes td-flip{from{transform:translateY(-12cqw) rotateY(180deg) scale(.7);opacity:0}}
.td .endb{position:absolute;right:1.5cqw;bottom:3cqw}
.td .shake{animation:td-sh .38s}@keyframes td-sh{20%{translate:-6px 0}40%{translate:5px 0}60%{translate:-3px 0}80%{translate:2px 0}}
.td .inn.shake{animation:td-sh2 .38s}@keyframes td-sh2{20%{translate:calc(-50% - 6px) 0}40%{translate:calc(-50% + 5px) 0}60%{translate:calc(-50% - 3px) 0}}
@media (prefers-reduced-motion:reduce){.td .c,.td .fill{transition:none}.td .flame,.td .played .c,.td .shake,.td .inn.shake{animation:none}}
`;

/** @param {any} ctx */
export function startDuel(ctx) {
  const ov = ctx.overlay({ title: 'Tavern Duel', sub: 'vs the innkeeper · 5 turns', help: '<kbd>1-3</kbd> play card <kbd>space</kbd> end turn <kbd>enter</kbd> start / play again <kbd>click</kbd> cards / buttons' });
  const K = gx(ov);
  if (!document.getElementById('td-style')) { const s = document.createElement('style'); s.id = 'td-style'; s.textContent = CSS; document.head.appendChild(s); }
  const rec = load('duel', { streak: 0, best: 0, wins: 0 });
  const r = rng((Date.now() & 0xffff) + 3); const draw = () => CARDS[Math.floor(r() * (CARDS.length - 0.3))];
  const hud = K.hud([{ id: 'run', label: 'Run', value: rec.streak }, { id: 'best', label: 'Best', value: rec.best, tone: 'gold' }], [{ id: 'turn', label: 'Turn', value: '1 / 5' }]);
  const scene = K.scene({ aspect: 16 / 9 });
  const root = document.createElement('div'); root.className = 'td'; scene.appendChild(root);
  const barH = `<div class="bar"><span class="gem"></span><span class="track"><span class="fill"></span></span><span class="v">14</span><span class="shield">Block 0</span></div>`;
  root.innerHTML = `<div class="table"></div>
<svg class="candle" viewBox="0 0 60 110" aria-hidden="true"><defs><radialGradient id="tdglow"><stop offset="0" stop-color="#ffd29a" stop-opacity=".7"/><stop offset="1" stop-color="#ffd29a" stop-opacity="0"/></radialGradient><linearGradient id="tdwax" x1="0" x2="1"><stop offset="0" stop-color="#e9d6b4"/><stop offset=".5" stop-color="#fff3dc"/><stop offset="1" stop-color="#b89c74"/></linearGradient></defs>
<circle cx="30" cy="30" r="30" fill="url(#tdglow)"/><ellipse cx="30" cy="100" rx="24" ry="7" fill="#6b4a2a"/><ellipse cx="30" cy="97" rx="24" ry="6" fill="#a9824f"/><rect x="20" y="45" width="20" height="52" rx="3" fill="url(#tdwax)"/><path d="M30 44v-6" stroke="#333" stroke-width="1.4"/>
<path class="flame" d="M30 14q8 12 0 24q-8-12 0-24z" fill="#ffc46a"/><path class="flame" d="M30 24q4 7 0 13q-4-6 0-13z" fill="#fff4d0"/></svg>
<div class="inn">${INN}${barH}<div class="tdw">The Innkeeper</div></div>
<div class="played"></div><div class="turn"></div>
<div class="me"><div class="tdw">You</div>${barH}<div class="mana"></div></div>
<div class="hand"></div><button class="gx-btn pri endb" type="button">End turn <span class="gx-key">Space</span></button>`;
  const $ = s => /** @type {HTMLElement} */ (root.querySelector(s));
  const innEl = $('.inn'), meEl = $('.me'), hand = $('.hand'), played = $('.played');
  /** @type {any} */ let g; let playing = false;
  const reset = () => { g = { turn: 1, mana: 2, me: { hp: HP, blk: 0 }, ai: { hp: HP, blk: 0 }, hand: [draw(), draw(), draw()], over: '', log: 'Your turn' }; played.replaceChildren(); render(); };
  const setBar = (el, o) => { /** @type {HTMLElement} */ (el.querySelector('.fill')).style.width = `calc(${o.hp / HP * 100}% - 4px)`; /** @type {HTMLElement} */ (el.querySelector('.v')).textContent = String(o.hp);
    const s = /** @type {HTMLElement} */ (el.querySelector('.shield')); s.textContent = 'Block ' + o.blk; s.classList.toggle('on', o.blk > 0); };
  const render = () => { setBar(meEl, g.me); setBar(innEl, g.ai); hud.set('turn', g.turn <= 5 ? `${g.turn} / 5` : 'Last call');
    const max = g.turn + 1; $('.mana').innerHTML = Array.from({ length: 6 }, (_, i) => `<svg viewBox="0 0 16 22" class="${i < g.mana ? 'on' : 'off'}" style="${i >= Math.max(max, g.mana) ? 'opacity:.08' : ''}"><path d="M8 0l7 8-7 14-7-14z" fill="#5fc4ff"/><path d="M8 0l7 8H1z" fill="#c8eeff"/></svg>`).join('') + `<b>${g.mana} / ${max}</b>`;
    hand.innerHTML = ''; g.hand.forEach((k, i) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'c' + (k.m > g.mana || g.over ? ' no' : ''); b.setAttribute('aria-label', k.n);
      b.innerHTML = cardSVG(k) + `<span class="gx-key">${i + 1}</span>`; b.onclick = () => { if (playing) play(i); }; hand.appendChild(b); });
    $('.turn').textContent = g.log; };
  const at = (el, dy = 0) => { const b = el.getBoundingClientRect(); return /** @type {[number, number]} */ ([b.left + b.width / 2, b.top + b.height / 2 + dy]); };
  const shake = el => { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); };
  /** @param {any} who */
  const hitP = (who, d) => { const a = Math.min(who.blk, d); who.blk -= a; who.hp = Math.max(0, who.hp - (d - a)); const el = who === g.me ? meEl : innEl;
    K.pop(...at(el, -20), a ? `-${d - a} (${a} blocked)` : `-${d}`, 'bad'); if (d - a) shake(el); };
  /** @param {any} k @param {any} me @param {any} foe */
  const apply = (k, me, foe) => { const el = me === g.me ? meEl : innEl; if (k.d) hitP(foe, k.d); if (k.h) { me.hp = Math.min(HP, me.hp + k.h); K.pop(...at(el, 10), `+${k.h}`, 'up'); } if (k.b) { me.blk += k.b; K.pop(...at(el, 10), `+${k.b} block`, 'cool'); } };
  const lay = (k, ai, delay = 0) => { const c = document.createElement('div'); c.className = 'c' + (ai ? ' ai' : ''); c.innerHTML = cardSVG(k); c.style.animationDelay = delay + 's'; played.appendChild(c); };
  const finish = () => { if (g.over) return; const w = g.ai.hp <= 0 || (g.turn > 5 && g.me.hp > g.ai.hp), l = g.me.hp <= 0 || (g.turn > 5 && g.me.hp <= g.ai.hp);
    if (!w && !l) return; g.over = w ? 'win' : 'lose'; g.log = 'Last orders'; SFX.play(w ? 'win' : 'fail', { delay: 0.5 });
    let gain = 0; if (w) { rec.streak++; rec.wins++; rec.best = Math.max(rec.best, rec.streak); gain = 10 + rec.streak * 5; coins(ctx.S).spend(-gain); K.pop(...at(innEl, 60), `+${gain} coins`, 'gold'); K.swell(); } else rec.streak = 0;
    save('duel', rec); hud.set('run', rec.streak, { count: true }); hud.set('best', rec.best, { count: true }); render();
    setTimeout(() => { if (!ov.el.isConnected) return; playing = false; K.result({ title: w ? 'You win the duel' : 'The Innkeeper wins', big: `${g.me.hp} - ${g.ai.hp}`, line: w ? '"Well played. Next round is on you."' : '"You are not prepared. Again?"',
      stats: [[w ? `+${gain}` : '0', 'Coins'], [rec.streak, 'Win run'], [rec.best, 'Best run']], again: 'Play again', onAgain: () => { reset(); SFX.play('shuffle'); playing = true; } }); }, 900); };
  /** @param {number} i */
  const play = i => { const k = g.hand[i]; if (!g.over && k && k.m > g.mana) { SFX.play('ui.deny'); shake(hand.children[i]); } if (g.over || !k || k.m > g.mana) return; g.mana -= k.m; cardSfx(k);
    played.querySelectorAll('.ai').forEach(e => e.remove()); lay(k, false); apply(k, g.me, g.ai); g.hand.splice(i, 1); g.log = 'You play ' + k.n; render(); finish(); };
  const endTurn = () => { if (g.over) return; SFX.play('ui.click'); played.replaceChildren();
    let mana = g.turn + 1; const opts = CARDS.filter(k => k.m <= g.turn + 1).sort((a, b) => b.m - a.m); /** @type {string[]} */ const pl = [];
    while (mana > 0 && pl.length < 2) { const k = (g.ai.hp < 6 && !pl.includes('Mug of Ale')) ? CARDS[1] : opts.filter(o => o.m <= mana)[Math.floor(r() * opts.filter(o => o.m <= mana).length)]; if (!k) break; mana -= k.m;
      lay(k, true, pl.length * 0.35); pl.push(k.n); cardSfx(k, 0.2 + (pl.length - 1) * 0.35); apply(k, g.ai, g.me); }
    g.log = 'Innkeeper plays ' + (pl.length ? pl.join(', ') : 'nothing'); g.ai.blk = Math.min(g.ai.blk, 4);
    g.turn++; g.mana = g.turn + 1; g.me.blk = 0; while (g.hand.length < 3) g.hand.push(draw()); render(); finish(); };
  $('.endb').addEventListener('click', () => { if (playing) endTurn(); });
  const onKey = e => { if (!playing) return; if (/^Digit[1-3]$/.test(e.code)) play(+e.code.slice(-1) - 1); else if (e.code === 'Space') { e.preventDefault(); endTurn(); } };
  addEventListener('keydown', onKey); ov.onClose(() => removeEventListener('keydown', onKey));
  reset();
  K.card({ title: 'Tavern Duel', text: 'Out-drink, out-block and out-brawl the Innkeeper. Five turns, 14 HP each, mana = turn + 1. Most HP after turn 5 wins.', how: [[['1', '2', '3'], 'play a card'], [['Space'], 'end turn'], [['Click'], 'cards and buttons']], cta: 'Deal me in', onGo: () => { SFX.play('shuffle'); playing = true; } });
}
