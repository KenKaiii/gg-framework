// @ts-check
// Room preview harness: renders ONE room (location.hash = room id) with lights, bloom and test characters
// placed at the room's slots, from the default iso angle. Used by tools/room-shot.mjs; not part of the game.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadAssets } from './assets.js';
import { installFonts } from './fonts.js';
import { Avatar } from './avatar.js';
import { ROOM_MODULES } from './rooms/index.js';
import { attachProp } from './rooms/props-hand.js';
import { FLOORS } from './rooms/floorplan.js';
import { floorSlab } from './rooms/kit.js';

const id = (location.hash || '#bar').slice(1);
const errors = [];
addEventListener('error', e => errors.push(String(e.message)));
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
document.body.style.cssText = 'margin:0;overflow:hidden;background:#0d0b14';
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#0d0b14');
const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 200);

const LOOKS = [
  { body: 'rogue', head: 'rogue', skin: '#c68a5e', hair: '#1b1410', top: '#2b2d42', bottom: '#3d405b', acc: 'headphones', accColor: '#3ddc84' },
  { body: 'mage', head: 'knight', skin: '#f2c6a0', hair: '#d4a373', top: '#5a3e5d', bottom: '#22223b', acc: 'glasses', accColor: '#1b1b1b' },
  { body: 'barbarian', head: 'barbarian', skin: '#8d5a3b', hair: '#111111', top: '#283618', bottom: '#1b1b2f', acc: 'none' },
  { body: 'knight', head: 'mage', skin: '#e0ac69', hair: '#f4f1de', top: '#6b2737', bottom: '#2b2d42', acc: 'none' },
];

async function start() {
  const [A] = await Promise.all([loadAssets(), installFonts()]); // signs are drawn in m5x7: load it before building
  // '#floor:main' previews a whole floor (rooms placed by floorplan.js), otherwise '#<roomId>' previews one room
  const floorId = id.startsWith('floor:') ? id.slice(6) : null;
  const ids = floorId ? Object.keys(FLOORS[floorId].rooms) : [id];
  const ctx = { A, scene, renderer };
  const t0 = performance.now(); const built = [];
  for (const rid of ids) { const mod = ROOM_MODULES[rid]; if (!mod) throw new Error('unknown room ' + rid); const r = mod.build(ctx); if (floorId) { const p = FLOORS[floorId].rooms[rid]; r.root.position.set(p.x, 0, p.z); } scene.add(r.root); built.push(r); }
  if (floorId) scene.add(floorSlab(Object.values(FLOORS[floorId].rooms)));
  // whole-floor preview: like the game, one shadow moon per floor (17 room moons would exceed the GPU's 16 texture units)
  if (floorId) built.forEach((r, i) => { if (i && r.rig?.moon) { r.rig.moon.castShadow = false; r.rig.moon.visible = false; } });
  const buildMs = performance.now() - t0;
  const R = floorId ? { root: scene, slots: built.flatMap(r => (r.slots || []).map(s => ({ ...s, x: s.x + r.root.position.x, z: s.z + r.root.position.z }))), npc: null,
    meta: { name: FLOORS[floorId].name }, camera: (() => { const rs = Object.values(FLOORS[floorId].rooms); const x0 = Math.min(...rs.map(r => r.x - r.w / 2)), x1 = Math.max(...rs.map(r => r.x + r.w / 2)), z0 = Math.min(...rs.map(r => r.z - r.d / 2)), z1 = Math.max(...rs.map(r => r.z + r.d / 2));
      return { zoom: Math.max(6.5, Math.max(x1 - x0, z1 - z0) * 0.36), target: new THREE.Vector3((x0 + x1) / 2 - 1.1, 0.6, (z0 + z1) / 2 - 1.1) }; })(), cutaway: d => built.forEach(r => r.cutaway(d)), tick: (t, dt) => built.forEach(r => r.tick?.(t, dt)) } : built[0];
  const avs = [];
  (R.slots || []).forEach((s, i) => {
    const av = new Avatar(A, LOOKS[i % LOOKS.length]); av.root.position.set(s.x, s.y || 0, s.z); av.root.rotation.y = s.face || 0; (floorId ? scene : R.root).add(av.root);
    av.play(s.anim || 'Idle'); if (s.prop) attachProp(av, s.prop); if (s.anim === 'Sit_Chair_Idle' && s.prop === 'laptop') av.fx.type = 1; avs.push(av);
  });
  if (R.npc) { const av = new Avatar(A, { body: 'barbarian', head: 'barbarian', skin: '#a8714f', hair: '#3a2618', top: '#1b1b1b', bottom: '#2b2d42', acc: 'glasses', accColor: '#111' }); av.root.position.set(R.npc.x, 0, R.npc.z); av.root.rotation.y = R.npc.face || 0; R.root.add(av.root); av.play('Idle'); avs.push(av); }
  const comp = new EffectComposer(renderer); comp.addPass(new RenderPass(scene, cam));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.55, 0.6, 0.85); comp.addPass(bloom); comp.addPass(new OutputPass());
  const rot = Number(new URLSearchParams(location.search).get('rot') || 0);
  const a = Math.PI / 4 + rot * Math.PI / 2; const camDir = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a));
  const tgt = R.camera?.target || new THREE.Vector3(0, 0.6, 0), zoom = Number(new URLSearchParams(location.search).get('zoom') || 0) || R.camera?.zoom || 5.5;
  R.cutaway(camDir);
  let t = 0; const clock = new THREE.Timer();
  const frame = () => {
    clock.update(); const dt = Math.min(clock.getDelta(), 0.05); t += dt;
    cam.position.set(tgt.x + Math.sin(a) * 30, tgt.y + 30 * Math.SQRT1_2, tgt.z + Math.cos(a) * 30); cam.lookAt(tgt);
    const asp = innerWidth / innerHeight; cam.left = -zoom * asp; cam.right = zoom * asp; cam.top = zoom; cam.bottom = -zoom; cam.updateProjectionMatrix();
    R.tick?.(t, dt); for (const av of avs) av.update(dt);
    renderer.info.reset(); comp.render();
  };
  renderer.setAnimationLoop(frame);
  // @ts-ignore
  window.__preview = { ready: true, buildMs, errors, info: () => ({ calls: renderer.info.render.calls, roomCalls: (() => { for (const av of avs) av.root.visible = false; renderer.info.reset(); comp.render(); const c = renderer.info.render.calls; for (const av of avs) av.root.visible = true; return c; })(), tris: renderer.info.render.triangles, geos: renderer.info.memory.geometries, tex: renderer.info.memory.textures, name: R.meta?.name, slots: (R.slots || []).length }) };
}
start().catch(e => { errors.push(String(e && e.stack || e)); console.error(e); });
