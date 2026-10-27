// @ts-check
// Jackrabbit Diner activities: a one-page diner menu ($5 shake, cherry pie + black coffee) and the twist contest.
import { coins } from './util.js';
import { gx, GX } from './gx.js';
import { FONT } from '../fonts.js';
import { holdProp } from '../rooms/props-hand.js';
import { moment } from './films-b-fx.js';
import { SFX } from '../sfx.js';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Tiny fries cone in the right hand: a red paper cone + a merged bunch of sticks (2 draw calls), cached like holdProp's. */
function holdFries(av) {
  const cache = av.root.userData.props || (av.root.userData.props = {});
  if (!cache.fries) { const g = new THREE.Group(); g.name = 'prop-fries';
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.045, 0.16, 8), new THREE.MeshStandardMaterial({ color: '#c8242c', roughness: 0.7 })); cone.position.y = 0.08; g.add(cone);
    const sticks = []; for (let i = 0; i < 9; i++) { const a = i * 2.4, r = 0.035 * (i % 3) / 2; sticks.push(new THREE.BoxGeometry(0.018, 0.13 + (i % 4) * 0.015, 0.018).rotateZ(Math.cos(a) * 0.25).rotateX(Math.sin(a) * 0.25).translate(Math.cos(a) * r, 0.2, Math.sin(a) * r)); }
    g.add(new THREE.Mesh(mergeGeometries(sticks), new THREE.MeshStandardMaterial({ color: '#f2c14e', roughness: 0.6, emissive: '#3a2000' })));
    ((av.bones?.['handslot.r'] || av.bones?.['handslotr']) || av.rig).add(g); cache.fries = g; }
  for (const k in cache) cache[k].visible = k === 'fries';
}

const MENU = [
  { id: 'shake', name: 'The $5 Shake', price: 5, prop: 'cocktail', desc: 'vanilla. cherry on top. pricey.', say: 'is that a five dollar shake?', after: "that's a pretty f***ing good milkshake." },
  { id: 'pie', name: 'Cherry Pie + Coffee', price: 3, prop: 'mug', desc: 'black as a moonless night', say: 'damn fine cup of coffee.', after: 'and hot! ...that pie, too.' },
  { id: 'fries', name: 'Fries, Extra Grease', price: 2, prop: 'fries', desc: 'reheated since 1958', say: 'fries. the debugger of hunger.', after: 'grease on the trackpad. worth it.' }];
const say = (S, U, t, s = 3.5) => { const B = S.ui?.bubble || U?.bubble; B?.(S.me, t, s); }; // once (bubble returns nothing)

/** Small SVG dish icons (viewBox 0 0 48 48). */
const DISH = {
  shake: '<path d="M14 16h20l-4 24h-12z" fill="url(#dn-glass)" stroke="#9fb4c0" stroke-width="1"/><path d="M15 18h18l-1 6H16z" fill="#fff6e6" opacity=".9"/><path d="M13 16c0-7 22-7 22 0z" fill="#fff4e0"/><circle cx="25" cy="8" r="3.4" fill="#d8203a"/><circle cx="24" cy="7" r="1" fill="#fff" opacity=".7"/><path d="M28 2l-3 16" stroke="#ff7ab8" stroke-width="2" stroke-linecap="round"/><rect x="17" y="40" width="14" height="3" rx="1.5" fill="#aab2bd"/>',
  pie: '<path d="M4 34L30 34L24 18z" fill="#e0a458"/><path d="M8 30h18" stroke="#a0182a" stroke-width="5" stroke-linecap="round"/><rect x="31" y="20" width="12" height="16" rx="3" fill="#f2efe8"/><path d="M43 24c4 0 4 7 0 7" fill="none" stroke="#f2efe8" stroke-width="2"/><rect x="32" y="21" width="10" height="3" rx="1.5" fill="#3a1a10"/><path d="M35 15c-2-3 2-4 0-7M39 15c-2-3 2-4 0-7" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.4" stroke-linecap="round"/>',
  fries: '<g stroke="#f2c14e" stroke-width="3" stroke-linecap="round"><path d="M17 22l-2-14M21 22l0-16M25 22l1-15M29 22l2-13M23 22l-3-12M27 22l4-11"/></g><path d="M12 20h24l-4 22H16z" fill="#c8242c"/><path d="M12 20h24l-1 4H13z" fill="#e8424a"/><circle cx="24" cy="31" r="4" fill="#fff"/>',
};
let dinerStyled = false;
function dinerStyle() {
  if (dinerStyled) return; dinerStyled = true;
  const st = document.createElement('style');
  st.textContent = `
.dn-menu{position:absolute;inset:0;border-radius:22px;padding:10px;background:linear-gradient(160deg,#f4f6f9,#8a909c 45%,#e2e5ea 60%,#7d838e);box-shadow:0 30px 60px -18px rgba(0,0,0,.85),0 0 40px -8px rgba(255,95,210,.35);font-family:${FONT.app};color:#3a2418}
.dn-vinyl{height:100%;box-sizing:border-box;border-radius:14px;padding:12px;background:radial-gradient(ellipse at 30% 0%,#e0404a,#8a1620 80%);box-shadow:inset 0 2px 0 rgba(255,255,255,.25),inset 0 -6px 14px rgba(0,0,0,.35)}
.dn-card{position:relative;height:100%;box-sizing:border-box;border-radius:8px;padding:4cqh 4.5cqw 3cqh;display:flex;flex-direction:column;background:linear-gradient(180deg,#fbf3df,#ecdab3);overflow:hidden;box-shadow:inset 0 0 0 1px rgba(120,60,20,.2)}
.dn-card::after{content:'';position:absolute;inset:0;pointer-events:none;background:linear-gradient(125deg,rgba(255,255,255,.5),rgba(255,255,255,0) 30%)}
.dn-card h2{margin:0;text-align:center;font-size:max(17px,5.6cqh);font-weight:800;letter-spacing:.06em;color:#c8242c;text-shadow:0 0 18px rgba(255,80,120,.35)}
.dn-card .tag{margin:.6cqh 0 0;text-align:center;font-size:max(11px,2.6cqh);font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#8a5a3a}
.dn-card .rule{height:5px;margin:1.8cqh 0 1cqh;border-top:2px solid #c8242c;border-bottom:1px solid #c8242c}
.dn-row{display:flex;align-items:center;gap:3cqw;padding:1.3cqh 2cqw;border-radius:12px;cursor:pointer;transition:background-color .2s,box-shadow .2s,transform .2s}
.dn-row svg{width:max(34px,10cqh);height:max(34px,10cqh);flex:none;transition:transform .3s cubic-bezier(.3,1.6,.6,1)}
.dn-row>span:nth-child(2){min-width:0}.dn-row .nm{white-space:nowrap;display:block;font-size:max(13px,4cqh);font-weight:700;letter-spacing:-.01em;color:#3a2418}
.dn-row .ds{display:block;margin-top:2px;font-size:max(10.5px,2.7cqh);color:#7a5a48;font-style:italic}
.dn-row .pr{margin-left:auto;min-width:max(44px,11cqh);height:max(44px,11cqh);display:grid;place-items:center;border-radius:50%;background:#c8242c;color:#fff;font-size:max(13px,3.6cqh);font-weight:800;box-shadow:0 3px 8px -3px rgba(120,0,0,.6)}
.dn-row.on{background:rgba(200,36,44,.1);box-shadow:inset 0 0 0 2px rgba(255,95,210,.65),0 0 22px -6px ${GX.pink}}
.dn-row.on svg{transform:translateY(-3px) rotate(-4deg) scale(1.08)}
.dn-row.on .pr{background:${GX.warning};color:#3a2418}
.dn-row.no .pr{background:#8a8494}
.dn-card .rows{margin:auto 0;display:grid;gap:.6cqh}.dn-foot{display:flex;align-items:center;gap:10px;padding-top:1.2cqh}
.dn-foot .wal{font-size:max(12px,3cqh);font-weight:600;color:#7a5a48}
.dn-foot .wal b{color:#3a2418;font-size:1.25em}
.dn-foot .msg{flex:1;text-align:center;font-size:max(12px,2.9cqh);font-weight:700;color:#c8242c;opacity:0;transition:opacity .3s}
.dn-shake{animation:dn-shake .35s}
@keyframes dn-shake{20%{transform:translateX(-8px)}40%{transform:translateX(7px)}60%{transform:translateX(-5px)}80%{transform:translateX(3px)}}
@media (prefers-reduced-motion: reduce){.dn-shake{animation:none}.dn-row svg{transition:none}}`;
  document.head.appendChild(st);
}

/** @param {any} ctx */
function menu(ctx) {
  const { S, U } = ctx; const wal = coins(S);
  let sel = MENU.findIndex(m => m.id === ctx.it.id); if (sel < 0) sel = 0;
  const ov = ctx.overlay({ title: 'Jackrabbit Diner', sub: 'open all night. no refunds.', help: '<kbd>&uarr;&darr;</kbd> / hover pick <kbd>enter</kbd> / click order' });
  dinerStyle();
  const K = gx(ov);
  const hud = K.hud([{ id: 'wal', label: 'Wallet', value: wal.balance, tone: 'gold' }], [{ id: 'ord', label: 'Your order', value: '$' + MENU[sel].price }]);
  const scene = K.scene({ aspect: 1.3, maxW: 720 });
  const box = document.createElement('div'); box.className = 'dn-menu';
  box.innerHTML = `<svg width="0" height="0" style="position:absolute"><defs><linearGradient id="dn-glass" x1="0" x2="1"><stop offset="0" stop-color="#dfeef5"/><stop offset=".5" stop-color="#fff"/><stop offset="1" stop-color="#b9d3de"/></linearGradient></defs></svg>
    <div class="dn-vinyl"><div class="dn-card"><h2>JACKRABBIT SLIM'S</h2><p class="tag">open all night · no refunds</p><div class="rule"></div><div class="rows"></div>
    <div class="dn-foot"><span class="wal">Wallet <b></b></span><span class="msg">Card declined. Go ship something.</span><button class="gx-btn pri" type="button">Order</button></div></div></div>`;
  scene.appendChild(box);
  const rowsEl = /** @type {HTMLElement} */ (box.querySelector('.rows')), walEl = /** @type {HTMLElement} */ (box.querySelector('.wal b')), msgEl = /** @type {HTMLElement} */ (box.querySelector('.msg')), btn = /** @type {HTMLButtonElement} */ (box.querySelector('.gx-btn'));
  const rows = MENU.map((m, i) => { const r = document.createElement('div'); r.className = 'dn-row';
    r.innerHTML = `<svg viewBox="0 0 48 48">${DISH[m.id]}</svg><span><span class="nm"></span><span class="ds"></span></span><span class="pr">$${m.price}</span>`;
    /** @type {HTMLElement} */ (r.querySelector('.nm')).textContent = m.name; /** @type {HTMLElement} */ (r.querySelector('.ds')).textContent = m.desc;
    r.addEventListener('pointerenter', () => pick(i)); r.addEventListener('click', () => { pick(i); order(); }); rowsEl.appendChild(r); return r; });
  const render = () => { const can = wal.balance >= MENU[sel].price;
    rows.forEach((r, i) => { r.classList.toggle('on', i === sel); r.classList.toggle('no', wal.balance < MENU[i].price); });
    walEl.textContent = String(wal.balance); btn.textContent = can ? `Order · $${MENU[sel].price}` : 'Too broke'; btn.className = 'gx-btn' + (can ? ' pri' : '');
    hud.set('wal', wal.balance); hud.set('ord', '$' + MENU[sel].price, { tone: can ? 'up' : 'bad' }); };
  const pick = i => { if (sel === i) return; sel = i; SFX.play('ui.select'); render(); };
  let msgTo = 0;
  const order = () => {
    const it = MENU[sel];
    if (wal.balance < it.price || !wal.spend(it.price, it.name)) { box.classList.remove('dn-shake'); void box.offsetWidth; box.classList.add('dn-shake'); msgEl.style.opacity = '1'; clearTimeout(msgTo); msgTo = setTimeout(() => { msgEl.style.opacity = '0'; }, 2500); SFX.play('ui.deny'); return; }
    ov.close(); SFX.play('register', { delay: 0.1 }); SFX.play(it.prop === 'mug' ? 'pour' : it.prop === 'fries' ? 'fizz' : 'espresso', { delay: 0.5, vol: 0.6 }); SFX.play(it.prop === 'fries' ? 'paper' : 'glass', { delay: 0.9, vol: 0.6 }); say(S, U, it.say); try { S.me.once?.('Interact', 1.2); } catch { /* anim */ }
    setTimeout(() => it.prop === 'fries' ? holdFries(S.me.av) : holdProp(S.me.av, it.prop), 400); setTimeout(() => say(S, U, it.after, 3), 4200);
  };
  btn.addEventListener('click', order);
  const onKey = e => { if (e.code === 'ArrowUp') { e.preventDefault(); pick((sel + MENU.length - 1) % MENU.length); } else if (e.code === 'ArrowDown') { e.preventDefault(); pick((sel + 1) % MENU.length); } else if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); order(); } };
  addEventListener('keydown', onKey); ov.onClose(() => { removeEventListener('keydown', onKey); clearTimeout(msgTo); });
  render();
}

/** Twist contest: a close-up on the dance floor while the player twists, then the floor crowns a winner. @param {any} ctx */
function twist(ctx) {
  const { S, U, R } = ctx; const av = S.me.av, p = S.me.pos;
  try { av.startEmote('cringe'); av.emT = 5.4; } catch { /* no emote */ }
  R.dinerSong = 1; R.onInteract?.('jukebox', { toast: () => {}, bubble: () => {} });
  let won = false, beat = 0;
  moment(ctx, { at: [p.x, 1.0, p.z], dir: { x: 1, y: 0.55, z: 0.35 }, zoom: 1.8, title: 'Twist contest', line: 'I want to dance. I want to win.', secs: 5.6,
    tick: (dt, t, api) => { if (t > 1.2 && t < 3.6 && Math.floor(t / 0.42) !== beat) { beat = Math.floor(t / 0.42); SFX.play('step.tile', { vol: 0.6, jitter: 0.1 }); if (beat % 2) SFX.play('squeak', { vol: 0.25 }); }
      if (t > 3.6 && !won) { won = true; api.shake(0.06); SFX.play('win'); SFX.play('sparkle', { delay: 0.4 }); api.cap.set('1st place!', 'The trophy is yours. Nobody else entered.'); say(S, U, 'You won the trophy. Everyone saw.', 3); } },
    end: () => { try { av.em = null; av.rig.rotation.z = 0; av.rig.position.y = 0; av.play('Idle'); } catch { /* */ } } });
}

/** @type {any[]} */
export default [
  { id: 'diner-menu', label: () => 'Order', match: (it, R) => R.id === 'diner' && (it.id === 'shake' || it.id === 'pie'), start: menu },
  { id: 'diner-twist', sfx: false, match: (it, R) => R.id === 'diner' && it.id === 'twist', start: twist },
];
