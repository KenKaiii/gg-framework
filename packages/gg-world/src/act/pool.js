// @ts-check
// Eight Ball at the bar's pool table: bird's-eye 3D view, real 2D physics (pool-phys.js), 3D balls/cue (pool-view.js),
// a transparent overlay with a small HUD strip. You vs 'House'. Esc puts the world back exactly as it was.
import { TOP as TOP_INSET, bottomOf } from './overlay.js';
import { hideBlockers } from './view.js';
import * as THREE from 'three';
import { setView, clearView, worldOf, hideOccluders } from './view.js';
import { text, loop, coins, rng } from './util.js';
import { FONT } from '../fonts.js';
import { gx } from './gx.js';
import * as P from './pool-phys.js';
import { SFX } from '../sfx.js';
import { buildView, TOP, colorOf } from './pool-view.js';

const NAMES = ['You', 'House'];
// score bar: dark lacquer panels like the table's own trim, Sora, the app's own type
const HUD_CSS = `
.pool-hud{position:fixed;left:50%;transform:translateX(-50%);display:grid;grid-template-columns:1fr auto 1fr;gap:8px;z-index:3;pointer-events:none;
  font-family:Sora,sans-serif;-webkit-font-smoothing:antialiased;color:#e8ebef}
.pool-hud .side,.pool-hud .mid{border-radius:12px;background:rgba(21,23,26,.74);-webkit-backdrop-filter:blur(12px) saturate(1.2);backdrop-filter:blur(12px) saturate(1.2);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 0 0 1px rgba(255,255,255,.07),0 10px 24px -12px rgba(0,0,0,.8)}
.pool-hud .side{padding:8px 14px;display:flex;flex-direction:column;justify-content:center;gap:6px;min-width:0;transition:box-shadow .3s}
.pool-hud .s1{text-align:right}.pool-hud .s1 .row{flex-direction:row-reverse}.pool-hud .s1 .pips{justify-content:flex-end}
.pool-hud .row{display:flex;justify-content:flex-start;align-items:baseline;gap:12px}
.pool-hud b{font:700 20px/1.1 Sora,sans-serif;letter-spacing:-.02em;color:#a1a8b1;transition:color .3s,text-shadow .3s}
.pool-hud i{font:600 11px/1.3 Sora,sans-serif;font-style:normal;color:#c2c7ce;white-space:nowrap;padding:3px 8px;border-radius:6px;background:#2c3035}
.pool-hud .s0.on{box-shadow:inset 0 1px 0 rgba(255,220,170,.14),inset 0 0 0 2px rgba(127,220,149,.55),0 0 22px rgba(127,220,149,.18),0 8px 24px rgba(0,0,0,.45)}
.pool-hud .s1.on{box-shadow:inset 0 1px 0 rgba(255,220,170,.14),inset 0 0 0 2px rgba(240,199,94,.55),0 0 22px rgba(240,199,94,.18),0 8px 24px rgba(0,0,0,.45)}
.pool-hud .s0.on b{color:#7fdc95;text-shadow:0 0 12px rgba(127,220,149,.45)}.pool-hud .s1.on b{color:#f0c75e;text-shadow:0 0 12px rgba(240,199,94,.45)}
.pool-hud .pips{display:flex;gap:4px;flex-wrap:wrap}
.pool-hud .pips span{width:14px;height:14px;border-radius:50%;opacity:.3;
  background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.75) 0 12%,transparent 30%),var(--c);box-shadow:inset 0 -2px 3px rgba(0,0,0,.45),0 1px 2px rgba(0,0,0,.5)}
.pool-hud .pips span.st{background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.75) 0 12%,transparent 30%),linear-gradient(#f2ead8 0 26%,var(--c) 26% 74%,#f2ead8 74%)}
.pool-hud .pips span.in{opacity:1}.pool-hud .pips span.gh{background:none;box-shadow:inset 0 0 0 1px rgba(255,220,170,.22);opacity:1}
.pool-hud .mid{padding:8px 16px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-width:180px}
.pool-hud .mid span{font:600 15px/1.25 Sora,sans-serif;white-space:nowrap}
.pool-hud .pw{width:100%;height:8px;border-radius:4px;background:#0c0806;box-shadow:inset 0 1px 2px rgba(0,0,0,.8),0 0 0 1px rgba(232,180,90,.35);overflow:hidden}
.pool-hud .pw u{display:block;height:100%;transform-origin:left;transform:scaleX(0);border-radius:4px;background:linear-gradient(90deg,#3fbf7a,#7fdc95)}
.pool-hud .pw u.warm{background:linear-gradient(90deg,#3fbf7a,#e8b04a)}.pool-hud .pw u.hot{background:linear-gradient(90deg,#e8b04a,#ff5a4a)}
.pool-hud.small b,.pool-hud.small .mid span{font-size:13px;line-height:1.2}.pool-hud.small .mid{min-width:120px;padding:6px 10px}
.pool-hud.small .side{padding:6px 10px}.pool-hud.small .pips span{width:10px;height:10px}
.pool-hud.tiny{grid-template-columns:1fr 1fr;row-gap:6px}.pool-hud.tiny .mid{grid-column:1 / span 2;grid-row:2;min-width:0}
`;
const QUIPS_WIN = ['House pays. House is not happy about it.', 'Clean. Like a rebase with no conflicts.', 'Ship it. The table is yours.'];
const QUIPS_LOSE = ['Skill issue. Rack again?', 'House always wins. Mostly.', 'That shot needed a code review.'];
const QUIPS_EARLY8 = ['Sank the 8 early. Bold. Wrong, but bold.', 'Black ball, prod deploy, Friday. Classic.'];

export default [{
  id: 'pool', label: () => 'Play pool',
  match: (it, R) => it.id === 'pool' && R.id === 'bar',
  start(ctx) {
    const { S, R } = ctx;
    const ov = ctx.overlay({ title: 'Eight Ball', sub: 'you vs the House', help: '<kbd>mouse</kbd>aim <kbd>hold click / space</kbd>power, release to shoot <kbd>&larr; &rarr;</kbd>fine aim' });
    const K = gx(ov);
    ov.el.style.background = 'transparent'; ov.el.style.cursor = 'crosshair';
    // ---- score bar: crisp HTML in Sora, sized to the table on screen ----
    if (!document.getElementById('pool-hud-css')) { const st = document.createElement('style'); st.id = 'pool-hud-css'; st.textContent = HUD_CSS; document.head.appendChild(st); }
    const hudEl = document.createElement('div'); hudEl.className = 'pool-hud';
    hudEl.innerHTML = [0, 1].map(s => `<div class="side s${s}"><div class="row"><b>${NAMES[s]}</b><i></i></div><div class="pips"></div></div>`).join('').replace('</div></div><div class="side s1">', '</div></div><div class="mid"><span></span><div class="pw"><u></u></div></div><div class="side s1">');
    ov.el.appendChild(hudEl);
    const sides = [...hudEl.querySelectorAll('.side')], midT = /** @type {HTMLElement} */ (hudEl.querySelector('.mid span')), pwU = /** @type {HTMLElement} */ (hudEl.querySelector('.pw u'));
    const help = /** @type {HTMLElement} */ (ov.el.querySelector('.help'));

    // ---- world: view, hide what sits above the felt ----
    const base = worldOf(R, 0.6, TOP, 1.0);
    setView(S, { target: base, dir: { x: 0, y: 1, z: 0.001 }, up: { x: 0, y: 0, z: -1 }, zoom: 0.95 }); hideOccluders(S);
    const people = hideBlockers(S, S.scene, base, { x: 0, y: 1, z: 0 }, { me: true, radius: 2.2 }); ov.onClose(() => people.restore()); // nobody's head over the felt
    const hidden = [];
    R.static.traverse(o => { if (o.isInstancedMesh && o.count === 12 && o.visible) hidden.push(o); });
    for (const o of R.live.children) if (o.visible && Math.hypot(o.position.x - 0.6, o.position.z - 1.0) < 0.4 && (o.position.y > 1.2 || (/** @type {any} */ (o).geometry?.type === 'CircleGeometry'))) hidden.push(o); // lamp, its glow sprite, the additive floor pool
    // the street / neighbour props (scene 'outside') sit beside the building and read as black slabs from straight above
    { const out = S.scene.getObjectByName('outside'); out?.traverse(c => { if ((c.isMesh || c.isSprite) && c.visible) hidden.push(c); }); }
    for (const o of hidden) o.visible = false;
    // the lamp's point light sits 0.6 above the felt and burns it white from straight above: dim it in the floor light pool
    const dimmed = []; for (const p of S.W?.lights?.[S.floor]?.pts || []) { const w = p.l.getWorldPosition(new THREE.Vector3()); if (p.R === R && Math.hypot(w.x - base.x, w.z - base.z) < 0.5) { dimmed.push([p, p.raw]); p.raw *= 0.3; } }
    const V = buildView(R.live);
    ov.onClose(() => { clearView(S); for (const o of hidden) o.visible = true; for (const [p, i] of dimmed) p.raw = i; V.dispose(); });

    // ---- popups + end panel (HTML, transparent) ----
    const pop = document.createElement('div'); pop.style.cssText = `position:fixed;left:0;right:0;top:22%;text-align:center;font:800 30px/1.2 ${FONT.app};letter-spacing:-.02em;z-index:3;color:#f0c75e;text-shadow:0 2px 12px rgba(0,0,0,.7);pointer-events:none;opacity:0;transition:opacity .3s`;
    ov.el.appendChild(pop); let popT = 0;
    const say = (s, col = '#f0c75e') => { pop.textContent = s; pop.style.color = col; pop.style.opacity = '1'; popT = 1.6; };

    let r = rng((Math.random() * 1e9) | 0);
    /** @type {any} */ let G;
    const newGame = () => {
      G = { balls: P.rack(r), turn: 0, groups: [null, null], pots: [[], []], phase: 'aim', ang: 0, power: 0, hold: -1, isBreak: true, shot: null, ai: null, pull: 0, lunge: 0, shake: 0, ring: 0, ringP: [0, 0], sinking: [] };
      say('Break!');
    };
    newGame();
    K.card({ title: 'Eight Ball', kicker: 'You vs the House', text: 'Solids or stripes, then the 8. Win a rack for 20 coins.', how: [[['Mouse'], 'aim'], [['Hold', 'Space'], 'power'], [['\u2190', '\u2192'], 'fine aim']], cta: 'Break', onGo: () => say('Break!') });
    // ---- layout, redone on every resize: score bar on top, the table zoomed + shifted to fill the space left between it
    // and the help bar, the cards fitted over the table at a crisp scale ----
    const TW = 2.3 * 1.03, TD = 1.25 * 1.03; // table incl. rails (+ a little air), world units
    const view = /** @type {any} */ (S.view), aimAt = base.clone();
    const layout = () => {
      const vw = innerWidth, vh = innerHeight, top = TOP_INSET(), bot = bottomOf(help), side = vw < 560 ? 8 : 16;
      hudEl.classList.toggle('small', vw < 760 || vh < 520); hudEl.classList.toggle('tiny', vw < 520);
      let ppu = 0, hudH = 0;
      for (let i = 0; i < 2; i++) { // the bar's height depends on its width, which follows the table: settle in two passes
        const barW = Math.min(vw - side * 2, Math.max(Math.min(560, vw - side * 2), TW * (ppu || 200))); hudEl.style.width = barW + 'px';
        hudH = hudEl.offsetHeight; ppu = Math.min((vw - side * 2) / TW, (vh - top - hudH - 10 - bot) / TD); }
      ppu = Math.max(40, ppu); const th0 = TD * ppu, y0 = top + Math.max(0, (vh - top - bot - (hudH + 10 + th0)) / 2); // bar + table as one centred block
      hudEl.style.top = Math.round(y0) + 'px'; const cy = y0 + hudH + 10 + th0 / 2; // where the table's centre goes on screen
      view.zoom = vh / (2 * ppu); aimAt.set(base.x, base.y, base.z - (cy - vh / 2) / ppu); // camera up = world -z
      const th = 1.25 * ppu;
      pop.style.top = Math.round(cy - th / 2 + th * 0.12) + 'px'; pop.style.fontSize = (vw < 640 ? 22 : 30) + 'px';
    };
    layout(); addEventListener('resize', layout); ov.onClose(() => removeEventListener('resize', layout)); requestAnimationFrame(layout);
    let best = 0; try { best = Number(localStorage.getItem('gg-pool-wins')) || 0; } catch { /* private */ }
    let noSave = false;
    const R0 = { reward: 0, wins: 0 };
    const finish = (win, why) => {
      SFX.play(win ? 'win' : 'fail');
      G.phase = 'over';
      if (win) { try { coins(S).spend(-20); R0.reward = 20; } catch { R0.reward = 0; } R0.wins++; if (R0.wins > best) { best = R0.wins; if (!noSave) try { localStorage.setItem('gg-pool-wins', String(best)); } catch { /* */ } } K.swell(); } else { R0.reward = 0; R0.wins = 0; }
      const q = win ? QUIPS_WIN : why === 'early8' ? QUIPS_EARLY8 : QUIPS_LOSE;
      K.result({ title: win ? 'You win' : 'House wins', big: win ? '+' + R0.reward : '0', line: q[(r() * q.length) | 0], stats: [[R0.wins, 'Streak'], [best, 'Best streak']], again: "Rack 'em", onAgain: again });
    };
    if (typeof (/** @type {any} */ (globalThis)).__actIds === 'function') /** @type {any} */ (globalThis).__pool = { finish: w => { noSave = true; finish(w, 'win'); } }; ov.onClose(() => { /** @type {any} */ (globalThis).__pool = null; }); // test hook
    function again() { newGame(); }
    // ---- input ----
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(TOP + P.BR)), hit = new THREE.Vector3();
    const toTable = e => { const rc = S.renderer.domElement.getBoundingClientRect(); ndc.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1); ray.setFromCamera(ndc, S.cam); if (!ray.ray.intersectPlane(plane, hit)) return null; const l = V.g.worldToLocal(hit.clone()); return [l.x, l.z]; };
    let mouse = null;
    const onMove = e => { mouse = toTable(e); aimAtMouse(); };
    const aimAtMouse = () => { if (!mouse || G.turn !== 0) return; const cb = G.balls[0];
      if (G.phase === 'place') { const [u, v] = P.placeCue(G.balls, mouse[0], mouse[1]); cb.u = u; cb.v = v; }
      else if (G.phase === 'aim') { const d = Math.hypot(mouse[0] - cb.u, mouse[1] - cb.v); if (d > 0.01) G.ang = Math.atan2(mouse[1] - cb.v, mouse[0] - cb.u); } };
    const press = () => { if (G.turn !== 0) return; if (G.phase === 'place') { G.phase = 'aim'; say('Your shot', '#7fdc95'); return; } if (G.phase === 'aim') { G.phase = 'charge'; G.hold = 0; } };
    const release = () => { if (G.phase !== 'charge') return; if (G.hold < 0.14) { G.phase = 'aim'; G.power = 0; return; } fire(G.power); };
    const onDown = e => { if (e.button !== 0 || G.phase === 'over' || /** @type {HTMLElement} */ (e.target).closest('button, .gx-layer')) return; onMove(e); press(); };
    const onUp = e => { if (e.button === 0) release(); };
    const held = new Set();
    const kd = e => { if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) press(); } if (/Arrow(Left|Right)/.test(e.code)) { e.preventDefault(); held.add(e.code); } };
    const ku = e => { if (e.code === 'Space') release(); held.delete(e.code); };
    ov.el.addEventListener('mousemove', onMove); ov.el.addEventListener('mousedown', onDown); addEventListener('mouseup', onUp); addEventListener('keydown', kd); addEventListener('keyup', ku);
    ov.onClose(() => { removeEventListener('mouseup', onUp); removeEventListener('keydown', kd); removeEventListener('keyup', ku); });

    // ---- shots + rules ----
    const fire = power => {
      const cb = G.balls[0]; G.shot = { by: G.turn, legal: P.targets(G.balls, G.groups[G.turn]).map(b => b.n), st: { firstHit: null, rails: 0 }, potted: [], brk: G.isBreak };
      SFX.play('cue', { vol: 0.4 + power * 0.6, pitch: 0.9 + power * 0.3 }); P.shoot(cb, G.ang, power); G.phase = 'roll'; G.lunge = 0.12; G.shake = 0.05 + power * (G.isBreak ? 0.25 : 0.1); G.power = 0; G.isBreak = false;
    };
    const resolve = () => {
      const { by, legal, st, potted, brk } = G.shot, other = 1 - by; const own = G.groups[by];
      const cuePot = potted.includes(0), eight = potted.includes(8), fh = st.firstHit;
      let foul = '';
      if (cuePot) foul = 'Scratch!'; else if (fh == null) foul = 'Foul: hit nothing'; else if (!legal.includes(fh)) foul = 'Foul: wrong ball first';
      if (eight) {
        const cleared = legal.length === 1 && legal[0] === 8;
        if (brk && !cuePot) return finish(by === 0, 'golden');
        if (cleared && !foul) return finish(by === 0, 'win');
        return finish(by !== 0, 'early8');
      }
      const obj = potted.filter(n => n !== 0);
      if (!own && !foul && obj.length) { const g = P.SOLID(obj[0]) ? 'solids' : 'stripes'; G.groups[by] = g; G.groups[other] = g === 'solids' ? 'stripes' : 'solids'; say(`${by ? 'House' : 'You'}: ${g}`, '#ffcf8a'); }
      for (const n of obj) { const g = P.SOLID(n) ? 'solids' : 'stripes'; const who = G.groups[0] ? (G.groups[0] === g ? 0 : 1) : by; G.pots[who].push(n); }
      const mine = G.groups[by]; const scored = obj.some(n => !mine || (mine === 'solids' ? P.SOLID(n) : P.STRIPE(n)));
      if (cuePot) { const cb = G.balls[0]; cb.on = true; cb.sink = 0; cb.pocket = null; const [u, v] = P.placeCue(G.balls, P.HEAD_U - 0.2, 0); cb.u = u; cb.v = v; V.balls[0].scale.setScalar(1); }
      if (foul) { SFX.play('fail', { vol: 0.5 }); say(foul + (other === 0 ? ' Ball in hand.' : ''), '#ff6b6b'); G.turn = other; G.inHand = true; }
      else if (scored) { SFX.play(by === 0 ? 'score' : 'ui.tap', { vol: 0.6 }); if (!G.groups[by] || obj.length) say(obj.length > 1 ? `${obj.length} down!` : by === 0 ? pick(['Nice pot', 'Clean', 'Filthy', 'Sunk']) : 'House pots', by === 0 ? '#7fdc95' : '#f0c75e'); G.inHand = false; }
      else { G.turn = other; G.inHand = false; if (!popT) say(other === 0 ? 'Your shot' : "House's shot", other === 0 ? '#7fdc95' : '#f0c75e'); }
      if (G.turn === 0) G.phase = G.inHand ? 'place' : 'aim'; else G.phase = 'ai', G.ai = null;
      aimAtMouse();
    };
    const pick = a => a[(r() * a.length) | 0];

    // ---- frame ----
    const q = new THREE.Quaternion(), ax = new THREE.Vector3();
    loop(ov, (dt) => {
      const B = G.balls, cb = B[0];
      if (popT > 0) { popT -= dt; if (popT <= 0) pop.style.opacity = '0'; }
      for (const k of held) if (G.phase === 'aim') G.ang += (k === 'ArrowLeft' ? -1 : 1) * dt * 0.35;
      if (G.phase === 'charge') { G.hold += dt; G.power = Math.min(1, G.hold / 1.1); }
      if (G.phase === 'ai') {
        if (!G.ai) { if (G.inHand) { const [u, v] = P.placeCue(B, P.HEAD_U - 0.15 - r() * 0.25, (r() - 0.5) * 0.6); cb.u = u; cb.v = v; G.inHand = false; }
          const plan = P.think(B, G.groups[1], r, G.shot == null); G.ai = { t: 0, plan, from: G.ang }; }
        const a = G.ai; a.t += dt; const k = Math.min(1, a.t / 0.9), e = k * k * (3 - 2 * k);
        let d = a.plan.ang - a.from; d = Math.atan2(Math.sin(d), Math.cos(d)); G.ang = a.from + d * e;
        if (a.t > 1.0) G.power = Math.min(a.plan.power, (a.t - 1.0) / 0.7);
        if (a.t > 1.0 + 0.7 * a.plan.power + 0.25) fire(a.plan.power);
      }
      if (G.phase === 'roll') {
        const rails0 = G.shot.st.rails; const ev = P.step(B, dt, G.shot.st);
        if (G.shot.st.rails > rails0) SFX.play('ball.cushion', { vol: 0.35, jitter: 0.1 });
        ev.hits.slice(0, 2).forEach((h, i) => SFX.play('ball.clack', { vol: 0.15 + h.k * 0.85, pitch: 0.9 + h.k * 0.25, delay: i * 0.02, jitter: 0.05 }));
        if (ev.pots.length) SFX.play('ball.pocket', { vol: 0.8 });
        for (const b of ev.pots) { G.shot.potted.push(b.n); G.sinking.push({ b, t: 0 }); G.ring = 1; G.ringP = [b.pocket[0], b.pocket[1]]; G.shake = Math.max(G.shake, 0.04); }
        for (const h of ev.hits) G.shake = Math.max(G.shake, h.k * 0.03);
        if (!P.moving(B) && !G.sinking.length) resolve();
      }
      // balls
      for (const b of B) { const m = V.balls[b.n];
        const sp = Math.hypot(b.vu, b.vv); if (b.on && sp > 0) { ax.set(b.vv, 0, -b.vu).normalize(); q.setFromAxisAngle(ax, sp * dt / P.BR); m.quaternion.premultiply(q); }
        if (b.on) { m.visible = true; m.position.set(b.u, TOP + P.BR, b.v); } }
      V.shadows(B, G.sinking);
      for (let i = G.sinking.length - 1; i >= 0; i--) { const s = G.sinking[i], m = V.balls[s.b.n]; s.t += dt; const k = Math.min(1, s.t / 0.3);
        m.position.set(m.position.x + (s.b.pocket[0] - m.position.x) * k, TOP + P.BR - k * 0.05, m.position.z + (s.b.pocket[1] - m.position.z) * k); m.scale.setScalar(1 - k * 0.6);
        if (k >= 1) { m.visible = false; m.scale.setScalar(1); G.sinking.splice(i, 1); } }
      // cue stick + aim
      const aiming = G.phase === 'aim' || G.phase === 'charge' || G.phase === 'ai';
      G.lunge = Math.max(0, G.lunge - dt);
      const show = aiming || G.lunge > 0;
      V.cue.visible = show; const du = Math.cos(G.ang), dv = Math.sin(G.ang);
      if (show) { const back = G.lunge > 0 ? -0.01 + (G.lunge / 0.12) * 0.05 : P.BR + 0.012 + G.power * 0.22;
        V.cue.position.set(cb.u - du * back, TOP + P.BR + 0.012, cb.v - dv * back); V.cue.rotation.set(0, -G.ang, 0); }
      const showAim = (G.phase === 'aim' || G.phase === 'charge') && G.turn === 0;
      V.aim.visible = V.ghost.visible = showAim; V.aim2.visible = false;
      if (showAim) { const tr = P.trace(B, cb, G.ang), gu = cb.u + du * tr.t, gv = cb.v + dv * tr.t;
        V.setLine(V.aim, cb.u, cb.v, gu, gv); V.ghost.position.set(gu, TOP + P.BR, gv);
        if (tr.ball) { const nu = (tr.ball.u - gu) / (2 * P.BR), nv = (tr.ball.v - gv) / (2 * P.BR); V.aim2.visible = true; V.setLine(V.aim2, tr.ball.u, tr.ball.v, tr.ball.u + nu * 0.3, tr.ball.v + nv * 0.3); } }
      V.cue.children[0].visible = true;
      // juice: pocket ring + camera shake
      if (G.ring > 0) { G.ring = Math.max(0, G.ring - dt * 2.2); V.ring.position.set(G.ringP[0], TOP + 0.002, G.ringP[1]); V.ring.scale.setScalar(0.04 + (1 - G.ring) * 0.12); /** @type {any} */ (V.ring.material).opacity = G.ring * 0.9; } else /** @type {any} */ (V.ring.material).opacity = 0;
      G.shake = Math.max(0, G.shake - dt * 0.4); if (S.view) S.view.target.set(aimAt.x + (Math.random() - 0.5) * G.shake * 0.2, aimAt.y, aimAt.z + (Math.random() - 0.5) * G.shake * 0.2); people.tick(dt);
      hud();
    });

    let hudKey = '';
    function hud() {
      const ph = G.phase, tt = performance.now() / 1000;
      const msg = ph === 'over' ? 'game over' : ph === 'place' ? 'ball in hand: click' : ph === 'roll' ? 'rolling...' : G.turn === 1 ? 'House lines up' + '...'.slice(0, ((tt / 0.3) | 0) % 4) : ph === 'charge' ? 'release to shoot' : 'aim, hold to shoot';
      const key = [msg, G.turn, ph, G.groups.join(), G.pots.map(p => p.join('.')).join('|')].join('/');
      pwU.style.transform = `scaleX(${G.power.toFixed(3)})`; pwU.className = G.power > 0.85 ? 'hot' : G.power > 0.5 ? 'warm' : '';
      if (key === hudKey) return; hudKey = key; midT.textContent = msg;
      for (const s of [0, 1]) {
        const el = sides[s], on = G.turn === s && ph !== 'over'; el.classList.toggle('on', on);
        /** @type {HTMLElement} */ (el.querySelector('i')).textContent = G.groups[s] || 'open';
        const set = G.groups[s] ? (G.groups[s] === 'solids' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15]) : G.pots[s];
        /** @type {HTMLElement} */ (el.querySelector('.pips')).innerHTML = set.map(n => `<span class="${P.STRIPE(n) ? 'st' : ''}${G.pots[s].includes(n) ? ' in' : ''}" style="--c:${colorOf(n)}"></span>`).join('') + '<span class="gh"></span>'.repeat(Math.max(0, 7 - set.length)); /* empty slots until a group is set */
      }
    }
  },
}];
