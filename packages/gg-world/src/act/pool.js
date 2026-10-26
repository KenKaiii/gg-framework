// @ts-check
// Eight Ball at the bar's pool table: bird's-eye 3D view, real 2D physics (pool-phys.js), 3D balls/cue (pool-view.js),
// a transparent overlay with a small HUD strip. You vs 'House'. Esc puts the world back exactly as it was.
import * as THREE from 'three';
import { setView, clearView, worldOf, hideOccluders } from './view.js';
import { text, loop, coins, rng } from './util.js';
import { FONT } from '../fonts.js';
import * as P from './pool-phys.js';
import { SFX } from '../sfx.js';
import { buildView, TOP, colorOf } from './pool-view.js';

const NAMES = ['YOU', 'HOUSE'];
const QUIPS_WIN = ['House pays. House is not happy about it.', 'Clean. Like a rebase with no conflicts.', 'Ship it. The table is yours.'];
const QUIPS_LOSE = ['Skill issue. Rack again?', 'House always wins. Mostly.', 'That shot needed a code review.'];
const QUIPS_EARLY8 = ['Sank the 8 early. Bold. Wrong, but bold.', 'Black ball, prod deploy, Friday. Classic.'];

export default [{
  id: 'pool', label: () => 'Play pool',
  match: (it, R) => it.id === 'pool' && R.id === 'bar',
  start(ctx) {
    const { S, R } = ctx;
    const ov = ctx.overlay({ title: 'Eight Ball', sub: 'you vs the House', help: '<kbd>mouse</kbd>aim <kbd>hold click / space</kbd>power, release to shoot <kbd>&larr; &rarr;</kbd>fine aim <kbd>esc</kbd>leave' });
    ov.el.style.background = 'transparent'; ov.el.style.alignItems = 'flex-start'; ov.el.style.cursor = 'crosshair';
    ov.stage.style.marginTop = '12px';
    const { c: hc, x: hx } = ov.canvas(400, 40, 2); hc.style.boxShadow = 'none'; hc.style.borderRadius = '0';

    // ---- world: view, hide what sits above the felt ----
    const base = worldOf(R, 0.6, TOP, 1.0);
    setView(S, { target: base, dir: { x: 0, y: 1, z: 0.001 }, up: { x: 0, y: 0, z: -1 }, zoom: 0.95 }); hideOccluders(S);
    const hidden = [];
    R.static.traverse(o => { if (o.isInstancedMesh && o.count === 12 && o.visible) hidden.push(o); });
    for (const o of R.live.children) if (o.visible && Math.hypot(o.position.x - 0.6, o.position.z - 1.0) < 0.4 && (o.position.y > 1.2 || (/** @type {any} */ (o).geometry?.type === 'CircleGeometry'))) hidden.push(o); // lamp, its glow sprite, the additive floor pool
    for (const o of hidden) o.visible = false;
    // the lamp's point light sits 0.6 above the felt and burns it white from straight above: dim it in the floor light pool
    const dimmed = []; for (const p of S.W?.lights?.[S.floor]?.pts || []) { const w = p.l.getWorldPosition(new THREE.Vector3()); if (p.R === R && Math.hypot(w.x - base.x, w.z - base.z) < 0.5) { dimmed.push([p, p.raw]); p.raw *= 0.3; } }
    const V = buildView(R.live);
    ov.onClose(() => { clearView(S); for (const o of hidden) o.visible = true; for (const [p, i] of dimmed) p.raw = i; V.dispose(); });

    // ---- popups + end panel (HTML, transparent) ----
    const pop = document.createElement('div'); pop.style.cssText = `position:fixed;left:0;right:0;top:22%;text-align:center;font:32px/32px ${FONT.title};color:#ffb36b;text-shadow:0 3px 0 #3a2410,0 0 18px rgba(255,180,100,.4);pointer-events:none;opacity:0;transition:opacity .3s`;
    ov.el.appendChild(pop); let popT = 0;
    const say = (s, col = '#ffb36b') => { pop.textContent = s; pop.style.color = col; pop.style.opacity = '1'; popT = 1.6; };

    let r = rng((Math.random() * 1e9) | 0);
    /** @type {any} */ let G;
    const newGame = () => {
      G = { balls: P.rack(r), turn: 0, groups: [null, null], pots: [[], []], phase: 'aim', ang: 0, power: 0, hold: -1, isBreak: true, shot: null, ai: null, pull: 0, lunge: 0, shake: 0, ring: 0, ringP: [0, 0], sinking: [] };
      say('Break!');
    };
    newGame();
    const end = document.createElement('div');
    end.style.cssText = `position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);display:none;text-align:center;padding:20px 28px;border-radius:8px;background:rgba(14,16,20,.92);box-shadow:inset 0 0 0 1px #3d7a52,0 20px 60px rgba(0,0,0,.6);font:16px/16px ${FONT.body};color:#c9d1c4`;
    ov.el.appendChild(end);
    const finish = (win, why) => {
      SFX.play(win ? 'win' : 'fail');
      G.phase = 'over'; let reward = '';
      if (win) { try { coins(S).spend(-20); reward = '<div style="color:#ffb36b;margin-top:12px">+20 coins</div>'; } catch { /* no wallet */ } }
      const q = win ? QUIPS_WIN : why === 'early8' ? QUIPS_EARLY8 : QUIPS_LOSE;
      end.innerHTML = `<div style="font:32px/32px ${FONT.title};color:${win ? '#6ee7a0' : '#ff6b6b'};margin-bottom:12px">${win ? 'You win' : 'House wins'}</div><div>${q[(r() * q.length) | 0]}</div>${reward}<div style="margin-top:16px;display:flex;gap:10px;justify-content:center"><button class="x" data-a="again" style="margin:0">rack 'em again</button><button class="x" data-a="leave" style="margin:0">leave</button></div>`;
      end.style.display = 'block';
      end.querySelectorAll('button').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); if (b.dataset.a === 'again') { end.style.display = 'none'; newGame(); } else ov.close(); }));
    };

    // ---- input ----
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(TOP + P.BR)), hit = new THREE.Vector3();
    const toTable = e => { const rc = S.renderer.domElement.getBoundingClientRect(); ndc.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1); ray.setFromCamera(ndc, S.cam); if (!ray.ray.intersectPlane(plane, hit)) return null; const l = V.g.worldToLocal(hit.clone()); return [l.x, l.z]; };
    let mouse = null;
    const onMove = e => { mouse = toTable(e); aimAtMouse(); };
    const aimAtMouse = () => { if (!mouse || G.turn !== 0) return; const cb = G.balls[0];
      if (G.phase === 'place') { const [u, v] = P.placeCue(G.balls, mouse[0], mouse[1]); cb.u = u; cb.v = v; }
      else if (G.phase === 'aim') { const d = Math.hypot(mouse[0] - cb.u, mouse[1] - cb.v); if (d > 0.01) G.ang = Math.atan2(mouse[1] - cb.v, mouse[0] - cb.u); } };
    const press = () => { if (G.turn !== 0) return; if (G.phase === 'place') { G.phase = 'aim'; say('Your shot', '#6ee7a0'); return; } if (G.phase === 'aim') { G.phase = 'charge'; G.hold = 0; } };
    const release = () => { if (G.phase !== 'charge') return; if (G.hold < 0.14) { G.phase = 'aim'; G.power = 0; return; } fire(G.power); };
    const onDown = e => { if (e.button !== 0 || /** @type {HTMLElement} */ (e.target).closest('button')) return; onMove(e); press(); };
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
      else if (scored) { SFX.play(by === 0 ? 'score' : 'ui.tap', { vol: 0.6 }); if (!G.groups[by] || obj.length) say(obj.length > 1 ? `${obj.length} down!` : by === 0 ? pick(['Nice pot', 'Clean', 'Filthy', 'Sunk']) : 'House pots', by === 0 ? '#6ee7a0' : '#ffb36b'); G.inHand = false; }
      else { G.turn = other; G.inHand = false; if (!popT) say(other === 0 ? 'Your shot' : "House's shot", other === 0 ? '#6ee7a0' : '#ffb36b'); }
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
      G.shake = Math.max(0, G.shake - dt * 0.4); if (S.view) S.view.target.set(base.x + (Math.random() - 0.5) * G.shake * 0.2, base.y, base.z + (Math.random() - 0.5) * G.shake * 0.2);
      hud();
    });

    function hud() {
      const x = hx; x.clearRect(0, 0, 400, 40); x.imageSmoothingEnabled = false;
      x.fillStyle = 'rgba(14,16,20,.86)'; x.fillRect(0, 0, 400, 40); x.fillStyle = '#263228'; x.fillRect(0, 39, 400, 1);
      for (const s of [0, 1]) {
        const L = s === 0, x0 = L ? 6 : 394, al = L ? 'left' : 'right', on = G.turn === s && G.phase !== 'over';
        text(x, (on ? (L ? '> ' : '') : '') + NAMES[s] + (on && !L ? ' <' : ''), x0, 15, { title: true, color: on ? (L ? '#6ee7a0' : '#ffb36b') : '#6a7468', align: al });
        text(x, G.groups[s] || 'open table', L ? 70 : 330, 15, { color: '#8e9a88', align: al });
        // remaining group balls as dots (potted ones dimmed)
        const set = G.groups[s] ? (G.groups[s] === 'solids' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15]) : G.pots[s];
        set.forEach((n, i) => { const cx = L ? 10 + i * 11 : 390 - i * 11, gone = G.pots[s].includes(n);
          x.globalAlpha = gone ? 1 : 0.35; x.fillStyle = colorOf(n); x.beginPath(); x.arc(cx, 29, 4, 0, 7); x.fill();
          if (P.STRIPE(n)) { x.fillStyle = '#f2ead8'; x.fillRect(cx - 4, 25, 8, 2); x.fillRect(cx - 4, 31, 8, 2); } x.globalAlpha = 1; });
      }
      const ph = G.phase, cx = 200;
      const msg = ph === 'over' ? 'game over' : ph === 'place' ? 'ball in hand: click to place' : ph === 'roll' ? '...' : G.turn === 1 ? 'House is lining up' + '...'.slice(0, ((performance.now() / 300) | 0) % 4) : ph === 'charge' ? 'release to shoot' : 'aim + hold to shoot';
      text(x, msg, cx, 15, { color: '#c9d1c4', align: 'center' });
      x.fillStyle = '#1a201c'; x.fillRect(cx - 50, 24, 100, 8);
      const pw = G.power; if (pw > 0) { x.fillStyle = pw > 0.85 ? '#ff4fd8' : pw > 0.5 ? '#ffb36b' : '#3ddc84'; x.fillRect(cx - 50, 24, 100 * pw, 8); }
      x.fillStyle = '#3d7a52'; x.fillRect(cx - 51, 23, 102, 1); x.fillRect(cx - 51, 32, 102, 1);
    }
  },
}];
