// @ts-check
// World extras: activity builders add props, characters, hotspots and seat activities WITHOUT editing room files.
// Each extras module exports default { id, install(ctx) } where ctx = { A, rooms, scene, renderer, THREE }.
// install() may:
//   - add meshes to rooms[id].live (moving / interactive things; never to .static, it's already baked)
//   - push hotspots into rooms[id].interact  ({ id, x, z, r, label, kind })   -> opens the matching activity on E
//   - tag seats: set slot.act = '<activityId>' and slot.actLabel = 'Watch TV' on an entry of rooms[id].slots
//     (members never take activity seats; the player sits there and the activity starts)
//   - remove seats (filter rooms[id].slots) or block floor (rooms[id].block(x0, z0, x1, z1)) for new furniture
//   - return a tick(t, dt, S) function (called every frame while the room's floor is visible)
// Coordinates are room-local (same as the room files). Errors are caught per module so one bad extra can't break the game.
import { placeHotspots } from '../rooms/focus.js';
import * as THREE from 'three';
import poolX from './extras-pool.js';
import screensX from './extras-screens.js';
import tvX from './extras-tv.js';
import codeX from './extras-gg-coder.js';
import pinballX from './extras-pinball.js';
import barmenuX from './extras-barmenu.js';
import filmsAX from './extras-films-a.js';
import filmsBX from './extras-films-b.js';
import roomsX from './extras-rooms.js';

const MODULES = [poolX, screensX, tvX, codeX, pinballX, barmenuX, filmsAX, filmsBX, roomsX].filter(Boolean);

/** @param {{A:any, rooms:Record<string, any>, scene:any, renderer:any}} ctx */
export function installExtras(ctx) {
  for (const m of MODULES) {
    try {
      const tick = m.install({ ...ctx, THREE });
      if (typeof tick === 'function') { const byFloor = new Set(); for (const id in ctx.rooms) byFloor.add(ctx.rooms[id]); EXTRA_TICKS.push(tick); }
    } catch (e) { console.warn('extras ' + m.id + ' failed', e); }
  }
  // hotspots the extras added (pool, pinball, film props...): put their hover rings on their objects too
  for (const R of Object.values(ctx.rooms)) try { placeHotspots(R); } catch (e) { console.warn('placeHotspots ' + R.id, e); }
}
/** @type {((t:number, dt:number, S:any) => void)[]} */
export const EXTRA_TICKS = [];
export function tickExtras(t, dt, S) { for (const f of EXTRA_TICKS) { try { f(t, dt, S); } catch (e) { if (!f.err) { f.err = 1; console.warn('extras tick', e); } } } }
