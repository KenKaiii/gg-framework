// @ts-check
// The Studio: where vibe coders make money and content. Streaming/podcast corner (north-east) and a chill lounge
// (south-west). Free-standing everything: n (den) and w (kitchen) walls aren't ours, s and e are cut-down exterior walls.
// Matrix touch: the streamer's side monitor runs a green terminal.
import { SFX } from '../sfx.js';
import { roomGlow, liveProp } from './bar-glow.js';
import * as THREE from 'three';
import { makeRoom, lightRig, mat, put, mesh, bake } from './kit.js';
import * as FX from './kit-fx.js';
import * as TX from './tex.js';
import * as P from './studio-props.js';
import * as DP from './den-props.js';
import { rickTex, tickRick } from './rick-screen.js';


/** @param {any} ctx */
export function build(ctx) { void ctx;
  const R = makeRoom({ id: 'studio', floor: TX.planks('#3a2a3a', '#2c2030', 9), wall: TX.plaster('#2a2440', 13), trim: '#3a2a4a', base: '#160f1e', slab: '#140e1c',
    windows: [{ side: 's', at: 2.5, w: 1.8, h: 1.2, y: 1.1, frame: '#2a1f36' }, { side: 'e', at: 2.6, w: 1.6, h: 1.2, y: 1.1, frame: '#2a1f36', blinds: '#4a3a5a' }] });
  const S = R.static, L = R.live, H = Math.PI;
  const live = o => { o.userData.live = true; L.add(o); return o; };

  const plane = (w, h, m) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); p.rotation.x = -Math.PI / 2; p.receiveShadow = true; return p; };
  const solid = (o, pad = 0.05) => { R.blockObj(o, pad); return o; };

  // ---- ZONE 1: streaming corner (north-east) ----
  put(S, plane(4.4, 3.4, mat('#ffffff', { map: TX.rug('stripes', '#221a30', '#2e2244', '#b04fd8'), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })), 4.2, 0.014, -2.3);
  const overlay = TX.canvasTex('studio-overlay', 256, 144, (x) => { const g = x.createLinearGradient(0, 0, 256, 144); g.addColorStop(0, '#2a1450'); g.addColorStop(1, '#0c2a3a'); x.fillStyle = g; x.fillRect(0, 0, 256, 144);
    x.fillStyle = '#111'; x.fillRect(8, 30, 160, 96); x.fillStyle = '#3ddc84'; x.font = '14px m5x7'; ['> npm run ship', '> deploying...', '> 0 errors (lie)'].forEach((l, i) => x.fillText(l, 14, 48 + i * 14));
    x.fillStyle = '#ff4fd8'; x.fillRect(176, 30, 72, 54); x.fillStyle = '#ffffff'; x.font = '14px m5x7'; x.fillText('chat', 180, 42); x.font = '12px m5x7'; ['W', 'ship it', 'is it AI?', 'KEKW'].forEach((l, i) => x.fillText(l, 180, 54 + i * 9));
    x.fillStyle = '#c4142a'; x.fillRect(8, 8, 40, 14); x.fillStyle = '#fff'; x.font = '15px m5x7'; x.fillText('LIVE', 14, 19); x.fillText('👁 3 viewers', 56, 19); x.fillStyle = '#ffcf8a'; x.fillText('sub goal 2/1000', 176, 100); });
  const desk = solid(put(S, P.streamDesk(overlay, TX.termScreen(5)), 4.3, 0, -3.25));
  const chairA = put(S, P.gamingChair(), 4.25, 0, -2.35, H); R.block(4.0, -2.6, 4.5, -2.4); void desk; void chairA;
  const ring = P.ringLight(); put(S, ring.g, 3.0, 0, -2.0, 2.3); R.blockObj(ring.g, 0.15);
  const led1 = P.ledPanel(); put(S, led1.g, 5.4, 0, -3.6, -0.6); const led2 = P.ledPanel(); put(S, led2.g, 4.9, 0, -1.65, -2.4);
  const air = P.onAir(); put(S, air.g, 2.7, 0, -3.65, 0.4); const airGlow = live(FX.glow('#ff2030', 1.3, 0.0)); airGlow.position.set(2.7, 1.86, -3.55);
  const cam = put(S, P.tripodCam(), 3.9, 0, -1.2, H - 0.1); R.blockObj(cam, 0.15);
  const gs = put(S, P.greenScreen(), 6.1, 0, -2.45, -H / 2); solid(gs, 0.2);
  const foam = put(S, P.foamDivider(2.4), 1.85, 0, -2.55, H / 2); solid(foam, 0);
  S.add(DP.cable(new THREE.Vector3(4.0, 0.02, -3.0), new THREE.Vector3(3.0, 0.02, -2.0), 2, 4));
  const ledGlow = live(FX.glow('#b04fd8', 2.4, 0.3)); ledGlow.position.set(5.6, 1.6, -3.0);
  live(FX.glow('#fff1dc', 1.2, 0.35)).position.set(3.0, 1.62, -2.0);
  // podcast table
  put(S, plane(2.6, 2.0, mat('#ffffff', { map: TX.rug('persian', '#3a1a2a', '#7a2a5a', '#ffb36b'), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })), 4.0, 0.014, 1.8);
  solid(put(S, P.podTable(), 4.0, 0, 1.8), 0.1);
  put(S, P.chair('#4a2c3a'), 3.05, 0, 1.8, H / 2); put(S, P.chair('#2c3a5a'), 4.95, 0, 1.8, -H / 2);
  put(L, liveProp(P.neonStand('PODCAST', '#4fd8ff'), 'rx-neon'), 5.6, 0, 3.4, 0.7).scale.setScalar(0.8); R.block(5.4, 3.2, 5.8, 3.6);

  // ---- ZONE 2: lounge (south-west) ----
  put(S, plane(4.4, 3.0, mat('#ffffff', { map: TX.rug('persian', '#2a1840', '#5b2a86', '#4fd8ff'), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 })), -3.8, 0.014, 2.4);
  solid(put(S, P.tvUnit(rickTex()), -6.0, 0, 2.5, H / 2));
  const tvGlow = live(FX.glow('#4fd8ff', 2.6, 0.3)); tvGlow.position.set(-5.6, 1.2, 2.5);
  solid(put(S, P.sofa(2.6, '#3b2a5a', [true, false]), -1.95, 0, 2.3, -H / 2));
  solid(put(S, P.sofa(1.9, '#3b2a5a', [true, false]), -3.55, 0, 3.55, H));
  const ct = put(S, DP.sideTable(), -3.6, 0, 2.2); ct.scale.set(1.6, 0.7, 1.2); solid(ct);
  put(S, DP.controller(), -3.7, 0.43, 2.1, 0.4);
  const bb = put(S, DP.beanbag('#7a2a6a', 1), -3.9, 0, 0.9, -2.2); R.blockObj(bb, 0.3);
  solid(put(L, liveProp(P.floorLamp(), 'rx-lamp'), -1.7, 0, 0.75)); live(FX.glow('#ffb36b', 1.4, 0.5)).position.set(-1.7, 1.55, 0.75);
  const vs = P.vinylShelf(); put(S, vs.g, -5.95, 0, -3.0, H / 2); solid(vs.g); vs.platter.removeFromParent(); vs.platter.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), H / 2).add(new THREE.Vector3(-5.95, 0, -3.0)); live(vs.platter);
  solid(put(S, P.whiteboard(), -3.2, 0, -3.55), 0);
  put(S, P.neonStand('SHIP IT', '#ff4fd8'), -1.9, 0, -3.65, 0.2); R.block(-2.1, -3.85, -1.7, -3.45);
  solid(put(L, liveProp(P.moneyPlant(3), 'rx-plant'), -6.0, 0, 3.75)); solid(put(S, P.moneyPlant(7), -4.4, 0, -3.7)); solid(put(S, DP.plant(5), 6.1, 0, 3.6)); solid(put(S, DP.plant(9), -0.9, 0, 3.7));
  // notes for the turntable
  const noteM = new THREE.SpriteMaterial({ map: TX.label('♪', '#ffcf8a', null, 64, 64, '72px m5x7'), transparent: true, depthWrite: false, opacity: 0 });
  const notes = [0, 1, 2].map(() => { const s = new THREE.Sprite(noteM); s.scale.setScalar(0.25); live(s); return s; });
  live(FX.motes(40, new THREE.Vector3(-6, 0.4, -3.5), new THREE.Vector3(6, 2.6, 3.5), '#e0c8ff', 0.04));

  R.rig = lightRig(R.root, { room: R, sky: '#6a5a9a', ground: '#2a1a30', ambient: 2.6, moon: '#8fa8ff', moonI: 0.6, moonFrom: [9, 8, 6],
    points: [{ x: 3.0, y: 1.7, z: -2.0, color: '#ffe8d0', i: 7, d: 6 }, { x: 5.8, y: 1.6, z: -3.2, color: '#b04fd8', i: 10, d: 7 },
      { x: -1.7, y: 1.5, z: 0.9, color: '#ffb36b', i: 11, d: 7 }, { x: -5.2, y: 1.2, z: 2.5, color: '#4fd8ff', i: 8, d: 7 }] });

  R.meta = { id: 'studio', name: 'The Studio', blurb: 'Stream desk, podcast mics, a big TV that only plays one song.' };
  R.spawn = { x: 0, z: 0, face: H };
  const tvAt = (x, z) => Math.atan2(-6.0 - x, 2.5 - z);
  R.slots = [
    { id: 'studio-stream', kind: 'chair', x: 4.25, z: -2.35, face: H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Stream desk' },
    { id: 'studio-pod1', kind: 'chair', x: 3.05, z: 1.8, face: H / 2, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'Podcast mic 1' },
    { id: 'studio-pod2', kind: 'chair', x: 4.95, z: 1.8, face: -H / 2, anim: 'Sit_Chair_Idle', prop: 'mug', label: 'Podcast mic 2' },
    { id: 'studio-sofa1', kind: 'sofa', x: -2.0, z: 1.5, face: -H / 2, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'L-sofa' },
    { id: 'studio-sofa2', kind: 'sofa', x: -2.0, z: 2.3, face: -H / 2, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'L-sofa' },
    { id: 'studio-sofa3', kind: 'sofa', x: -2.0, z: 3.1, face: -H / 2, anim: 'Sit_Chair_Idle', prop: 'beer', label: 'L-sofa' },
    { id: 'studio-sofa4', kind: 'sofa', x: -3.2, z: 3.5, face: H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'L-sofa corner' },
    { id: 'studio-sofa5', kind: 'sofa', x: -4.0, z: 3.5, face: H, anim: 'Sit_Chair_Idle', prop: 'laptop', label: 'L-sofa end' },
    { id: 'studio-beanbag', kind: 'beanbag', x: -3.75, z: 1.1, y: 0.25, face: tvAt(-3.75, 1.1), anim: 'Sit_Floor_Idle', prop: 'controller', label: 'Beanbag' },
    { id: 'studio-tv', kind: 'stand', x: -4.9, z: 0.9, face: tvAt(-4.9, 0.9), anim: 'Idle', prop: 'beer', label: 'Watching TV' },
    { id: 'studio-vinyl', kind: 'stand', x: -5.0, z: -2.9, face: -H / 2, anim: 'Idle', prop: 'phone', label: 'Digging records' },
    { id: 'studio-board', kind: 'stand', x: -3.2, z: -2.8, face: H, anim: 'Idle', prop: 'phone', label: 'Whiteboard plans' },
    { id: 'studio-guest', kind: 'stand', x: 3.4, z: -0.6, face: H, anim: 'Idle', prop: 'beer', label: 'Watching the stream' },
  ];
  R.interact = [
    { id: 'onair', x: 2.7, z: -3.0, r: 1.0, label: 'Go live', kind: 'sign' },
    { id: 'turntable', x: -5.0, z: -3.0, r: 1.0, label: 'Drop the needle', kind: 'jukebox' },
    { id: 'tv', x: -4.6, z: 2.0, r: 1.3, label: 'Watch TV', kind: 'tv' },
  ];
  const st = { t: 0, live: -99, spin: -99 };
  R.onInteract = (id, api) => {
    if (id === 'onair') { st.live = st.t; api.bubble("We're live! Say hi to all 3 viewers."); }
    else if (id === 'turntable') { st.spin = st.t; api.bubble('*crackle* ...and the beat drops.'); }
    else if (id === 'tv') { const up = Math.sin(st.t) > 0; api.toast(up ? '$VIBE +420% · $SHIP +69% · $BUG -12% · NFA' : '$VIBE -42% · $HYPE -99% · $COPE +300% · just hodl'); }
  };  // reaction sounds, timed to the animations (the default keyword guess is silenced for these)
  /** @type {Record<string, () => void>} */
  const RSND = {
    onair: (at) => { SFX.play('ping', { at }); SFX.play('success', { at, vol: 0.4, delay: 0.3 }); },
    turntable: (at) => { SFX.play('vinyl', { at, vol: 0.6 }); SFX.play('chord', { at, vol: 0.5, delay: 0.6 }); },
  };
  for (const it of R.interact) if (RSND[it.id]) it.sfx = false;
  { const oi = R.onInteract; R.onInteract = (id, api) => { const it = R.interact.find(e => e.id === id), o = R.root.position; if (it) RSND[id]?.({ x: o.x + it.x, y: 1, z: o.z + it.z }); oi(id, api); }; }

  R.npc = null;
  R.camera = { zoom: 5.5, target: new THREE.Vector3(0, 0.8, 0) };
  const pal = ['#b04fd8', '#ff4fd8', '#4fd8ff', '#3ddc84'].map(c => new THREE.Color(c)); const tmp = new THREE.Color();
  R.tick = (t) => {
    st.t = t;
    const k = (t * 0.25) % 4, i = Math.floor(k); tmp.copy(pal[i]).lerp(pal[(i + 1) % 4], k - i);
    led1.face.color.copy(tmp).multiplyScalar(2.2); led2.face.color.copy(pal[(i + 2) % 4]).lerp(pal[(i + 3) % 4], k - i).multiplyScalar(2.2);
    R.rig.points[1].color.copy(tmp); /** @type {any} */ (ledGlow.material).color.copy(tmp);
    const liveOn = t - st.live < 12, pulse = 0.75 + 0.25 * Math.sin(t * 4);
    air.sign.color.set(liveOn ? '#ffffff' : '#552222').multiplyScalar(liveOn ? 2.2 * pulse : 1); /** @type {any} */ (airGlow.material).opacity = liveOn ? 0.6 * pulse : 0;
    const fast = t - st.spin < 8; vs.platter.rotation.y -= (fast ? 0.35 : 0.06);
    notes.forEach((n, j) => { const p = ((t * 0.5 + j / 3) % 1); n.position.set(-5.8 + Math.sin(p * 6 + j) * 0.15 + p * 0.3, 1.1 + p * 1.0, -3.2 + j * 0.15); });
    noteM.opacity = fast ? 0.9 : 0;
    tickRick(t);
    const f = (1 - 0.06 * (0.5 + 0.5 * Math.sin(t * 2.24))); R.rig.points[3].intensity = 8 * f; /** @type {any} */ (tvGlow.material).opacity = 0.3 * f;
  };
  const bx = new THREE.Box3(), sz = new THREE.Vector3(); S.updateMatrixWorld(true);
  S.traverse(o => { if (/** @type {any} */ (o).isMesh) { bx.setFromObject(o).getSize(sz); if (Math.max(sz.x, sz.y, sz.z) < 0.9) o.castShadow = false; } });
  void mesh;
  roomGlow(R, [{ at: [-4.7, 0.03, 2.5], w: 1.8, h: 2.4, c: '#4fd8ff', a: 0.12 },
    // neon stands wash their walls, stream screens light the desk top + wall, warm pool over the podcast table
    { at: [5.6, 1.2, 0], w: 1.8, h: 1.3, c: '#4fd8ff', a: 0.1, face: 's' }, { at: [5.6, 0.03, 3.1], w: 1.6, h: 1.0, c: '#4fd8ff', a: 0.06 },
    { at: [-1.9, 1.2, 0], w: 1.8, h: 1.3, c: '#ff4fd8', a: 0.1, face: 'n' }, { at: [-1.9, 0.03, -3.3], w: 1.6, h: 1.0, c: '#ff4fd8', a: 0.06 },
    { at: [4.3, 0.77, -3.1], w: 1.7, h: 0.7, c: '#7fc8ff', a: 0.08 }, { at: [4.3, 1.3, 0], w: 2.2, h: 1.3, c: '#7fc8ff', a: 0.07, face: 'n' },
    { at: [4.0, 0.03, 1.8], w: 2.6, h: 2.0, c: '#ffcf8a', a: 0.06 }]);
  R.finish();
  return R;
}
