// @ts-check
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { StableBloomPass } from './bloom.js';
import { EMBED, fromApp, tellApp, applyProfile, flushSave } from './bridge.js';
import { onRadio, askRadio } from './act/radio.js';
import { makeOutside } from './outside.js';
import { SFX, SURFACE } from './sfx.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadAssets } from './assets.js';
import { buildRooms } from './roomset.js';
import { tickTipsy, leanBody, makeTipsyScreen, LEVELS } from './tipsy.js';
import { Agent } from './agent.js';
import { DEFAULT_LOOK } from './avatar.js';
import { initWorld } from './play.js';
import { initCrew } from './crew-run.js';
import { installFonts } from './fonts.js';
import { installExtras, tickExtras } from './act/extras.js';
import { makePerf, makeBlobs } from './perf.js';
import { Avatar } from './avatar.js';
import { makeCuller } from './cull.js';
import { initNet } from './net.js';
import { warmUp } from './warm.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio || 1); /* perf.js sets the real ratio (whole screen px per canvas px) */ renderer.setSize(innerWidth, innerHeight);
// stable transparent order (renderOrder, then creation id): sorting by camera depth made overlapping glows / glass swap
// order as you walked, which reads as popping. Additive glows don't care about order; this just never changes.
renderer.setTransparentSort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || a.id - b.id);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.3;
document.body.style.cssText = 'margin:0;overflow:hidden;background:#0b0a12;height:100vh';
document.body.appendChild(renderer.domElement);
const tipsyScreen = makeTipsyScreen(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#0b0a12');
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 200);
const G = { paused: false, hidden: false, ready: false };
let loopFn = () => {};
/** Where you were (room + spot + facing), kept in World's own storage so reopening World puts you back there. */
const SPOT_KEY = 'nr.spot';
/** @param {any} S */
function saveSpot(S) {
  const me = S?.me, R = S?.room; if (!me || !R?.id || S.fade) return;
  try { localStorage.setItem(SPOT_KEY, JSON.stringify({ room: R.id, x: +me.pos.x.toFixed(2), z: +me.pos.z.toFixed(2), face: +me.root.rotation.y.toFixed(2) })); } catch { /* storage off */ }
}
const sync = () => renderer.setAnimationLoop(G.paused || G.hidden || !G.ready ? null : loopFn);
// @ts-ignore
window.__game = { pause() { G.paused = true; sync(); SFX.suspend(); }, resume() { G.paused = false; sync(); SFX.resume(); }, get paused() { return G.paused; } };
// @ts-ignore
// ── App bridge (GG Coder) ─────────────────────────────────────────────────────────────────────────────────
// Inside the app, World runs in a same-origin frame. The app (gg-app WorldScreen) sends, and only it is listened to:
//   { gg: 'world', t: 'player', level, xp, percent?, name? }   your real coding level (coins = level x 80 - spent)
//   { gg: 'world', t: 'pause' } / { gg: 'world', t: 'resume' }  when you leave / come back to World
//   { gg: 'world', t: 'xp', amount, why? }                      you earned XP while coding: a small celebration
// The game sends { gg: 'world', t: 'ready' } once the first frame is drawn (the app fades World in then).
// Standalone (opened directly, no parent app) it keeps its demo player.
addEventListener('message', e => {
  if (!fromApp(e)) return; const d = e.data; if (!d || d.gg !== 'world') return;
  if (d.t === 'pause') { if (window.__S) { saveSpot(window.__S); flushSave(window.__S); } /** @type {any} */ (globalThis).__ggFlushStore?.(); window.__game.pause(); } else if (d.t === 'resume') window.__game.resume();
  else if (d.t === 'player' && window.__S?.player) { const P = window.__S.player; const lv = Math.max(1, Math.min(999, Math.floor(Number(d.level) || 1)));
    P.level = lv; P.xp = Math.max(0, Math.min(1, (Number(d.percent) || 0) / 100)); window.__S.ui?.refreshHud?.(); if (typeof d.name === 'string' && d.name.trim()) P.appName = d.name.trim().replace(/[^A-Za-z0-9 ]/g, '').slice(0, 14); }
  else if (d.t === 'profile' && window.__S) applyProfile(window.__S, d.profile);
  else if (d.t === 'radio') onRadio(d);
  // a key the app caught (focus was on the app, not the game): replay it here so the game's own handlers run
  else if (d.t === 'key' && d.key === 'Escape') { const ev = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }; (document.activeElement && document.activeElement !== document.body ? document.activeElement : window).dispatchEvent(new KeyboardEvent('keydown', ev)); dispatchEvent(new KeyboardEvent('keyup', ev)); }
  else if (d.t === 'note' && window.__S?.ui && typeof d.text === 'string') window.__S.ui.toast?.(d.text.slice(0, 90));
  else if (d.t === 'xp' && window.__S?.ui) { const n = Math.max(0, Math.floor(Number(d.amount) || 0)); if (n) window.__S.ui.toast?.(`+${n} XP${d.why ? ' · ' + String(d.why).slice(0, 30) : ''}`); }
});
addEventListener('pagehide', () => { if (window.__S) { saveSpot(window.__S); flushSave(window.__S); } /** @type {any} */ (globalThis).__ggFlushStore?.(); }); // Back unmounts the frame: send a pending save first
document.addEventListener('visibilitychange', () => { G.hidden = document.hidden; sync(); if (document.hidden) SFX.suspend(); else if (!G.paused) SFX.resume(); });

export const LOOK_KEY = 'night-rooms-look';
const ZOOM_KEY = 'night-rooms-zoom';
/** follow-camera half-height in world units (the v3 whole-floor framing); wheel scales it by S.zoomMul */
const FOLLOW_ZOOM = 10.5;
function loadLook() { try { const s = localStorage.getItem(LOOK_KEY); return s ? { ...DEFAULT_LOOK, ...JSON.parse(s) } : { ...DEFAULT_LOOK, top: '#2b2d42', bottom: '#1b1b2f', accColor: '#3ddc84' }; } catch { return { ...DEFAULT_LOOK }; } }

/** boot timings (ms since page start), read by tools/tests as window.__boot */
const BOOT = /** @type {any} */ (window).__boot = [];
const mark = (/** @type {string} */ n) => BOOT.push([n, Math.round(performance.now())]);
/** Loading progress for the app's loading screen (0..1 + what's happening). */
const progress = (/** @type {number} */ p, /** @type {string} */ label) => tellApp({ t: 'progress', p, label });
async function start() {
  mark('start'); progress(0.03, 'Unpacking');
  const [A] = await Promise.all([loadAssets(), installFonts()]);
  mark('assets'); progress(0.08, 'Unpacking');
  const { rooms, failed, floors } = await buildRooms({ A, scene, renderer, onRoom: (/** @type {number} */ i, /** @type {number} */ n, /** @type {string} */ name) => progress(0.08 + 0.62 * (i / n), `Building ${name}`) });
  mark('rooms');
  installExtras({ A, rooms, scene, renderer });
  mark('extras');
  // Nothing above or inside a room's baked geometry ever moves after placement. three.js recomputes a subtree whenever
  // an ancestor has matrixAutoUpdate on (it flags 'world matrix changed' every frame), so freeze the scene, the floor
  // groups and the room roots: only things that really move (characters, live props) recompute their matrices now.
  for (const id in rooms) { for (let o = rooms[id].root; o; o = o.parent) { o.updateMatrix(); o.matrixAutoUpdate = false; } }
  scene.updateMatrixWorld(true);

  // in the app the real level arrives from the bridge right after load; standalone keeps a demo level
  const look0 = loadLook(); const player = { name: look0.name || 'You', level: EMBED ? 1 : 27, xp: EMBED ? 0 : 0.62, look: look0, namedHere: !!look0.name };
  // MSAA inside the composer: renderer({antialias}) only smooths the canvas, but the scene is drawn into the composer's
  // own render target, so without samples every edge (stair rails, cables, wall corners) aliased and crawled as you moved
  const pr0 = renderer.getPixelRatio(); const msaa = new THREE.WebGLRenderTarget(innerWidth * pr0, innerHeight * pr0, { type: THREE.HalfFloatType, samples: 4 });
  const comp = new EffectComposer(renderer, msaa); comp.addPass(new RenderPass(scene, cam));
  const bloom = new StableBloomPass(0.55, 0.6, 0.85); // stable under 1 px camera moves (bloom.js) comp.addPass(bloom); comp.addPass(new OutputPass());
  const perf = makePerf({ renderer, bloom, scene, onRatio: () => { comp.setPixelRatio(renderer.getPixelRatio()); comp.setSize(innerWidth, innerHeight); } }); const blobs = makeBlobs(scene);
  const S = { perfCtl: perf, comp, bloom, A, rooms, floors, floor: 'main', failed, room: rooms.bar, player, cam, renderer, scene, ui: null, keys: new Set(), rot: 0, rotSmooth: 0, zoom: 5.5, zoomMul: 1, target: new THREE.Vector3(), t: 0, me: /** @type {any} */ (null), hooks: [], fade: null };
  const me = new Agent(A, { scene: rooms.bar.root, grid: rooms.bar.grid }, player.look, rooms.bar.spawn.x, rooms.bar.spawn.z); me.isPlayer = true; S.me = me;
  mark('state');
  await new Promise(r => setTimeout(r, 0)); // let the app paint (World shares its thread)
  const W = initWorld(S); S.W = W;
  progress(0.72, 'Planting the street');
  await new Promise(r => setTimeout(r, 0));
  const OUT = await makeOutside(S, scene); S.outside = OUT;
  progress(0.86, 'Waking everyone up');
  await new Promise(r => setTimeout(r, 0)); // the city outside (outside.js); ?outside=0 turns it off
  try { initCrew(S, W); } catch (e) { console.warn('crew', e); }
  mark('outside+crew');
  // back where you left off (owner): the room + spot saved when you last left World, if it's still somewhere you can
  // stand; else the bar as before
  { let back = null; try { back = JSON.parse(localStorage.getItem(SPOT_KEY) || 'null'); } catch { back = null; }
    const R = back && typeof back.room === 'string' ? S.rooms[back.room] : null;
    const ok = R && Number.isFinite(back.x) && Number.isFinite(back.z) && R.grid.free(back.x, back.z);
    W.enter(ok ? back.room : 'bar', null);
    if (ok) { S.me.pos.set(back.x, 0, back.z); S.me.root.rotation.y = Number.isFinite(back.face) ? back.face : 0; S.target.set(back.x + R.root.position.x, 0.6, back.z + R.root.position.z); } }
  mark('enter'); progress(0.92, 'Turning the lights on');
  addEventListener('keydown', e => {
    const el = /** @type {HTMLElement} */ (document.activeElement); if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    S.keys.add(e.code);
    if (e.code === 'KeyQ') S.rot--; if (e.code === 'KeyR' && !S.ui?.editing) S.rot++;
    W.key(e);
  });
  addEventListener('keyup', e => S.keys.delete(e.code));
  addEventListener('blur', () => S.keys.clear());
  // wheel zoom: 0.45x (close) .. 1.6x (wide) of the follow zoom, remembered for the session
  try { const z = Number(sessionStorage.getItem(ZOOM_KEY)); if (z >= 0.45 && z <= 1.6) S.zoomMul = z; } catch { /* storage off */ }
  // smooth zoom: the wheel/trackpad moves a GOAL proportional to how far it scrolled (a mouse notch ~ 12%, trackpads in tiny
  // steps, pinch counts more), and the camera eases toward it (~0.22 s), so zoom glides instead of jumping per event
  S.zoomGoal = S.zoomMul;
  renderer.domElement.addEventListener('wheel', e => { e.preventDefault(); const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1) * (e.ctrlKey ? 2.5 : 1);
    S.zoomGoal = Math.max(0.45, Math.min(1.6, S.zoomGoal * Math.exp(Math.max(-80, Math.min(80, px)) * 0.0015))); try { sessionStorage.setItem(ZOOM_KEY, S.zoomGoal.toFixed(3)); } catch { /* storage off */ } }, { passive: false });
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); comp.setSize(innerWidth, innerHeight); bloom.resolution.set(innerWidth / 2, innerHeight / 2); });
  const camDir = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3(), tv = new THREE.Vector3();
  const _ip = new THREE.Vector3(), _vt = new THREE.Vector3(), _vp = new THREE.Vector3(), _lt = new THREE.Vector3(), _up = new THREE.Vector3();
  // level speed: +0.8% per level (owner: level 100 = ~80% faster); the walk/run clips play faster by the same factor
  const spdK = () => 1 + Math.max(0, (S.player?.level || 1) - 1) * 0.008; S.speedK = spdK;
  const _wp = new THREE.Vector3(), _sr = new THREE.Vector3(), _su = new THREE.Vector3(), _fs = new THREE.Vector3(), _ft = new THREE.Vector3(); S.wpos = a => a.root.getWorldPosition(_wp);
  S.zoomBase = FOLLOW_ZOOM; const cull = makeCuller(cam); S.cull = cull;
  /** walls facing the camera drop (room cutaway); shared walls of rooms you're not in drop so you see the neighbours */
  const cutaways = dir => {
    for (const Rm of S.floors[S.floor].rooms) {
      try { Rm.cutaway?.(dir); } catch { /* room mid-rebuild */ }
      const sh = Rm.info?.shared; if (!sh || Rm === S.room) continue;
      for (const side in sh) { const wl = Rm.walls?.[side]; if (!sh[side].draw || !wl || wl.skipped) continue; wl.full.visible = false; wl.stub.visible = true; }
    }
  };
  const clock = new THREE.Timer();
  S.perf = { ms: 0 }; // EMA of JS time per frame spent in this loop (measured by tools/perf-probe.mjs)
  loopFn = (now) => {
    if (!perf.gate(now ?? performance.now())) return; // 60 fps cap, 30 when unfocused
    const _pt = performance.now();
    clock.update(); const dt = S.freezeT ? 0 : Math.min(clock.getDelta(), 0.05); /* freezeT: debug (tools/flicker-scan.mjs) */ S.t += dt; const t = S.t; const R = S.room;
    S.rotSmooth += (S.rot - S.rotSmooth) * Math.min(1, dt * 8);
    const TP = tickTipsy(S, dt); // drinking: 5 levels of tipsy (tipsy.js)
    if ((S.spotT = (S.spotT ?? 4) - dt) <= 0) { S.spotT = 4; saveSpot(S); } // where you are, every few seconds (for an app that closes without warning)
    // a short note when the level changes, so the player knows what's happening
    if (TP.level !== (S.tipsyShown ?? 0)) { const up = TP.level > (S.tipsyShown ?? 0); S.tipsyShown = TP.level;
      S.ui?.toast?.(TP.level === 0 ? 'Sober again' : up ? `${LEVELS[TP.level]}${TP.level >= 4 ? '. Maybe some water?' : ''}` : `Sobering up: ${LEVELS[TP.level].toLowerCase()}`); }
    const a = Math.PI / 4 + S.rotSmooth * Math.PI / 2;
    // follow camera: fixed zoom (the v3 floor framing), target eases toward the player, nudged to the back walls so the HUD stays clear
    const rp = R.root.position, px = me.pos.x + rp.x, pz = me.pos.z + rp.z, back = 0.6;
    tv.set(px - Math.sin(a) * back, 0.6, pz - Math.cos(a) * back);
    S.target.lerp(tv, Math.min(1, dt * 3));
    S.zoomBase += (FOLLOW_ZOOM - S.zoomBase) * Math.min(1, dt * 1.5);
    // S.view (set by activities, see act/view.js) blends the camera to a close-up: bird's-eye over the pool table,
    // over-the-shoulder at a TV, etc. viewK goes 0 -> 1 smoothly; normal iso camera when it's 0.
    const V = S.view; S.viewK = (S.viewK || 0) + ((V ? 1 : 0) - (S.viewK || 0)) * Math.min(1, dt * (V?.speed ?? S.lastView?.speed ?? 3.2)); // lean-in views glide faster
    const isoPos = _ip.set(S.target.x + Math.sin(a) * 30, S.target.y + 30 * Math.SQRT1_2, S.target.z + Math.cos(a) * 30);
    S.zoomMul += ((S.zoomGoal ?? S.zoomMul) - S.zoomMul) * (1 - Math.exp(-dt / 0.22));
    let z = S.zoomBase * S.zoomMul;
    if (V || S.viewK > 0.002) {
      const vk = S.viewK * S.viewK * (3 - 2 * S.viewK); if (V) S.lastView = V; const L = S.lastView;
      _vt.copy(L.target); _vp.copy(L.dir).normalize().multiplyScalar(30).add(_vt);
      cam.position.lerpVectors(isoPos, _vp, vk); _lt.lerpVectors(S.target, _vt, vk);
      cam.up.set(0, 1, 0).lerp(_up.set(L.up?.x ?? 0, L.up?.y ?? 1, L.up?.z ?? 0), vk).normalize(); cam.lookAt(_lt);
      z = Math.exp(Math.log(z) + (Math.log(L.zoom) - Math.log(z)) * vk); // log-space: leaning in eases like a lens
    } else { cam.up.set(0, 1, 0); cam.position.copy(isoPos); cam.lookAt(S.target); }
    const asp = innerWidth / innerHeight; cam.left = -z * asp; cam.right = z * asp; cam.top = z; cam.bottom = -z; cam.updateProjectionMatrix();
    if (!V && S.viewK < 0.002 && Math.abs(S.rotSmooth - Math.round(S.rotSmooth)) < 1e-3) { // snap the camera to the device-pixel grid
      const e = (2 * z) / renderer.getContext().drawingBufferHeight; _sr.set(1, 0, 0).applyQuaternion(cam.quaternion); _su.set(0, 1, 0).applyQuaternion(cam.quaternion);
      const dr = cam.position.dot(_sr), du = cam.position.dot(_su); cam.position.addScaledVector(_sr, Math.round(dr / e) * e - dr).addScaledVector(_su, Math.round(du / e) * e - du); cam.updateMatrixWorld(); } if (S.camHook) S.camHook(cam); /* debug: sub-pixel camera nudges */
    const ra = Math.PI / 4 + Math.round(S.rotSmooth) * Math.PI / 2; camDir.set(-Math.sin(ra), 0, -Math.cos(ra)); cutaways(camDir);
    if (S.wallsDown) for (const Rm of S.floors[S.floor].rooms) for (const k in Rm.walls || {}) { const wl = Rm.walls[k]; if (wl && !wl.skipped) { wl.full.visible = false; wl.stub.visible = true; } }
    S.camDir = camDir; cull.update();
    fwd.set(-Math.sin(a), 0, -Math.cos(a)); right.set(-fwd.z, 0, fwd.x);
    let mx = 0, mz = 0; const k = S.keys;
    if (!S.ui?.blocking && !S.fade) {
      if (k.has('KeyW') || k.has('ArrowUp')) { mx += fwd.x; mz += fwd.z; } if (k.has('KeyS') || k.has('ArrowDown')) { mx -= fwd.x; mz -= fwd.z; }
      if (k.has('KeyD') || k.has('ArrowRight')) { mx += right.x; mz += right.z; } if (k.has('KeyA') || k.has('ArrowLeft')) { mx -= right.x; mz -= right.z; }
    }
    const run = !(k.has('ShiftLeft') || k.has('ShiftRight')); // run by default, hold Shift to walk
    if (mx || mz) {
      // tipsy: weave sideways as you walk (perpendicular to where you're going) and a little slower
      if (TP.level > 0) { const l0 = Math.hypot(mx, mz); const px = -mz / l0, pz = mx / l0; mx += px * TP.drift * 0.6; mz += pz * TP.drift * 0.6; }
      const l = Math.hypot(mx, mz), sp = (run ? 4.6 : 2.4) * spdK() * TP.speed * dt; if (S.seated) S.ui?.standUp?.(); S.pending = null; me.path = null; me.stand(); if (me.av.em) { me.av.endEmote(); me.lockAnim = 0; } /* walking ends an emote */
      const nx = me.pos.x + mx / l * sp, nz = me.pos.z + mz / l * sp;
      // boxed in by furniture (a pocket or inside a piece): let the player walk out instead of being stuck
      const loose = R.grid.boxedIn(me.pos.x, me.pos.z);
      if (W.freeAt(R, nx, me.pos.z) || (loose && R.grid.inner(nx, me.pos.z))) me.pos.x = nx; if (W.freeAt(R, me.pos.x, nz) || (loose && R.grid.inner(me.pos.x, nz))) me.pos.z = nz;
      me.turnTo(Math.atan2(mx, mz), dt, 12); me.av.play(run ? 'Running_A' : 'Walking_A', { fade: 0.15 }); { const _a = me.av.current; if (_a) _a.timeScale = spdK(); }; me.av.update(dt);
    } else { if (me.path) me.speed = (run ? 4.6 : 2.4) * spdK() * TP.speed; me.update(dt); }
    leanBody(me.av, TP.swayZ); tipsyScreen.update(TP.level, TP.k, S.tipsy?.sway || 0, t);
    W.update(dt, t);
    const FL = W.lights[S.floor]; FL?.pre();
    tickExtras(t, dt, S);
    for (const Rm of S.floors[S.floor].rooms) { const vis = cull.seesRoom(Rm); Rm.inView = vis; if (Rm.live && Rm.live.visible !== vis) Rm.live.visible = vis; if (!vis) continue; try { Rm.tick(t, dt); } catch (e) { if (!Rm.tickErr) { Rm.tickErr = 1; console.warn('tick ' + Rm.id, e); } } }
    // footsteps: one soft step each time a foot actually touches down in the walk/run animation (foot bone drops to its
    // lowest point, ~0.10 m above the root, in both clips), so sound and animation can't drift apart
    { const wpm = me.root.getWorldPosition(_fs); const an = me.av.currentName || '', moving = !me.sitting && !S.view && /Walking|Running/.test(an);
      if (moving) { const run = /Running/.test(an), base = me.root.position.y;
        for (const k of ['footl', 'footr']) { const b = me.av.bones[k]; if (!b) continue; const fy = b.getWorldPosition(_ft).y - wpm.y; const st = S._fsArm || (S._fsArm = { footl: false, footr: false });
          const py = st[k + 'y'] ?? fy; st[k + 'y'] = fy;
          // the moment of contact = the foot stops going down (lowest point), once it's near the floor
          if (st[k] && fy < 0.13 && fy >= py - 0.002) { st[k] = false; SFX.step(S.room.surface || SURFACE[S.room.id], run ? 1 : 0.75); }
          else if (!st[k] && fy > 0.15) st[k] = true; } }
      else if (S._fsArm) { S._fsArm.footl = S._fsArm.footr = false; }
      SFX.listen(wpm.x, wpm.z, Math.cos(a), -Math.sin(a)); /* screen-right = (cos a, -sin a) */ }
    OUT?.update(dt, t);
    FL?.post(dt, S.room, S.target, perf.maxLamps); if (FL?.moonMoving()) perf.shadowDirty();
    S.ui?.update(dt, t);
    // @ts-ignore Avatar.all is the live avatar registry (avatar.js)
    blobs.update(Avatar.all || []); perf.frame(dt);
    comp.render(); if (S.afterRender) S.afterRender(renderer); // debug: read the finished frame
    S.perf.ms += (performance.now() - _pt - S.perf.ms) * 0.05;
  };
  // @ts-ignore
  window.__S = S; S.scene = scene; S.renderer = renderer; S.THREE = THREE; // debug handles (tools)
  mark('pre-ui');
  try { const { initUI } = await import('./night-ui.js'); S.ui = initUI(S, W); } catch (e) { console.warn('ui', e); }
  try { S.net = initNet(S, W); } catch (e) { console.warn('net', e); } // multiplayer (net.js): idle until the app says 'online'
  // draw every floor once now, so roaming never stops to compile shaders or upload textures (warm.js). After the UI:
  // it adds the hover light, and the shaders must be compiled for the light count they'll really draw with. ?warm=0 skips it.
  if (new URLSearchParams(location.search).get('warm') !== '0') {
    await new Promise(r => setTimeout(r, 0));
    try { await warmUp(S, (i, n) => progress(0.92 + 0.06 * (i / n), 'Turning the lights on')); } catch (e) { console.warn('warm-up', e); }
  }
  mark('warm');
  // first visit: the wardrobe opens once the world is on screen. Inside the app, give the online save a moment to bring
  // an existing name first (the app sends 'profile' within a second or two when it has one); standalone: straight away.
  setTimeout(() => { try { S.ui?.maybeFirstSetup?.(); } catch (e) { console.warn('setup', e); } }, EMBED ? 2600 : 900);
  mark('ui');
  G.ready = true; sync();
  // tell the app once two frames are on screen (so it fades World in on a drawn scene, never a black frame)
  requestAnimationFrame(() => requestAnimationFrame(() => { progress(1, 'Ready'); tellApp({ t: 'ready' }); askRadio(); }));
}
start().catch(e => console.error(e));
