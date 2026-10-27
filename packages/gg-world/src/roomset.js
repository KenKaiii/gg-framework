// @ts-check
// Builds every room (stub fallback on error), places it at its floorplan position and groups rooms into floors.
import * as THREE from 'three';
import { ROOM_MODULES, ROOM_IDS } from './rooms/index.js';
import { stubRoom } from './rooms/stub.js';
import { FLOORS, JOINED, PASSAGES, roomInfo, floorOf } from './rooms/floorplan.js';
import { floorSlab } from './rooms/kit.js';

const LINKS = { engine: [], bar: ['roof'], den: ['basement'], bedroom: [], kitchen: [], studio: [], screening: [], diner: [], library: [], garage: [], overlook: [], hawkins: [], biolab: [], hackers: [], computer: [], fightclub: [], inception: [], tavern: [], roof: ['bar'], basement: ['den'] };
const NAMES = { bar: 'The Bar', den: 'The Den', bedroom: 'Your Bedroom', kitchen: 'The Kitchen', studio: 'The Studio', screening: 'The Screening Room', diner: 'Jackrabbit Diner', library: 'The Restricted Section', garage: "Doc's Garage", overlook: 'The Overlook Hall', hawkins: 'Hawkins Living Room', biolab: 'Lab 426', roof: 'The Roof', basement: 'The Basement', hackers: 'Club Cyberdelia', computer: 'The Computer Lab', fightclub: 'Paper Street', inception: 'Limbo', tavern: 'The Prancing Murloc', engine: 'The Engine Room' };
const FLOOR_ORDER = ['main', 'roof', 'basement'];

/** open the grid cells of every archway on the room's side (a room that skips a shared wall gets none from the kit) */
function openPassages(R) {
  const info = roomInfo(R.id); if (!info || !R.info) return;
  const w = R.w, d = R.d;
  for (const p of info.passages) {
    if (p.side === 'e' || p.side === 'w') { const z = p.side === 'e' ? p.at : -p.at, x = p.side === 'e' ? w / 2 : -w / 2; R.grid.rect(x - 0.7, z - p.w / 2 + 0.3, x + 0.7, z + p.w / 2 - 0.3, 0); }
    else { const x = p.side === 'n' ? p.at : -p.at, z = p.side === 'n' ? -d / 2 : d / 2; R.grid.rect(x - p.w / 2 + 0.3, z - 0.7, x + p.w / 2 - 0.3, z + 0.7, 0); }
  }
}

/** world-space archways of a floor: each link has a crossing point and the room on each side */
function floorLinks(f) {
  const rooms = FLOORS[f].rooms, out = [];
  for (const p of PASSAGES) {
    if (p.west && rooms[p.west] && rooms[p.east]) { const W = rooms[p.west]; out.push({ a: p.west, b: p.east, x: W.x + W.w / 2, z: p.z, nx: 1, nz: 0 }); }
    if (p.north && rooms[p.north] && rooms[p.south]) { const N = rooms[p.north]; out.push({ a: p.north, b: p.south, x: p.x, z: N.z + N.d / 2, nx: 0, nz: 1 }); }
  }
  return out;
}

/** @param {any} ctx @returns {{rooms: Record<string, any>, failed: string[], floors: Record<string, any>}} */
/**
 * Build every room. Async and yielding between rooms: World shares the app's main thread (a sealed iframe in WebKit
 * runs in the same process), so one long build froze the whole app for ~1.3 s. Yielding lets the app paint (its
 * loading dots keep moving) and stay responsive while World loads.
 * @param {any} ctx
 */
export async function buildRooms(ctx) {
  const yieldNow = () => new Promise(r => setTimeout(r, 0));
  let slice = performance.now();
  /** @type {Record<string, any>} */ const rooms = {}; const failed = [];
  /** @type {Record<string, any>} */ const floors = {};
  for (const f of FLOOR_ORDER) {
    const root = new THREE.Group(); root.name = 'floor-' + f; root.visible = false; ctx.scene.add(root);
    floors[f] = { id: f, name: FLOORS[f].name, root, rooms: [], links: floorLinks(f), joined: JOINED.has(f) };
    if (JOINED.has(f)) root.add(floorSlab(Object.values(FLOORS[f].rooms)));
  }
  await yieldNow(); slice = performance.now(); // the floor slabs above, then the rooms
  for (const id of ROOM_IDS) {
    let R; const f = floorOf(id) || 'main', fp = FLOORS[f].rooms[id];
    const tb = performance.now();
    try { R = /** @type {any} */ (ROOM_MODULES)[id].build(ctx); if (!R || !R.root || !R.grid) throw new Error('invalid room'); }
    catch (e) { console.warn('room ' + id + ' failed, using stub:', e); failed.push(id); R = stubRoom(ctx, { id, name: NAMES[id], to: LINKS[id] }); }
    if (R.live) R.live.traverse(o => { o.castShadow = false; }); // animated -> no stepping shadows (shadow map refreshes at 2 Hz)
    R.id = id; R.floorId = f; R.meta = R.meta || { id, name: NAMES[id], blurb: '' }; if (typeof R.meta.name !== 'string' || R.meta.name.length > 32 || /[,\n]/.test(R.meta.name)) R.meta.name = NAMES[id];
    R.slots = R.slots || []; R.interact = R.interact || []; R.tick = R.tick || (() => {});
    R.camera = R.camera || { zoom: 6, target: new THREE.Vector3(0, 0.6, 0) };
    R.spawn = R.spawn || { x: 0, z: 0, face: 0 };
    R.w = R.w || fp.w; R.d = R.d || fp.d;
    R.box = { x0: fp.x - fp.w / 2, x1: fp.x + fp.w / 2, z0: fp.z - fp.d / 2, z1: fp.z + fp.d / 2 };
    if (R.root.parent) R.root.parent.remove(R.root);
    R.root.position.set(fp.x, 0, fp.z); floors[f].root.add(R.root); R.root.updateMatrixWorld(true);
    openPassages(R);
    R.exits = (R.doors || []).filter(d => d.to).map(d => {
      const p = d.group.localToWorld(new THREE.Vector3(d.at, 0, 0)); R.root.worldToLocal(p);
      const c = new THREE.Vector3(-p.x, 0, -p.z).normalize();
      const inside = R.grid.nearestFree(p.x + c.x * 0.8, p.z + c.z * 0.8);
      return { to: d.to, label: d.label || NAMES[d.to] || d.to, door: { x: p.x, z: p.z }, inside, face: Math.atan2(c.x, c.z), stairs: floorOf(d.to) !== f };
    });
    for (const ex of R.exits) R.grid.rect(Math.min(ex.door.x, ex.inside.x) - 0.25, Math.min(ex.door.z, ex.inside.z) - 0.25, Math.max(ex.door.x, ex.inside.x) + 0.25, Math.max(ex.door.z, ex.inside.z) + 0.25, 0);
    floors[f].rooms.push(R); rooms[id] = R; /** @type {any} */ (window).__boot?.push(['room ' + id, Math.round(performance.now() - tb)]);
    ctx.onRoom?.(ROOM_IDS.indexOf(id) + 1, ROOM_IDS.length, roomLabel(R));
    if (performance.now() - slice > 50) { await yieldNow(); slice = performance.now(); } // the app's loading screen gets a turn
  }
  return { rooms, failed, floors };
}
/** "the bar", "the Den"...: a room's name for the loading screen. @param {any} R */
function roomLabel(R) { const n = String(R?.meta?.name || R?.id || 'the rooms').trim(); return /^the\s/i.test(n) ? 'the ' + n.slice(4) : n; }
export { NAMES, FLOOR_ORDER };
