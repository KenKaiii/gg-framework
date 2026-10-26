// @ts-check
// Dex the bartender: follows R.npc.path in the bar, faces the player when near.
import { Agent } from './agent.js';
import { NPC } from './brain.js';
import { draw } from './people/talk.js';
const DEX_GREET = ['what are we drinking?', 'evening, {player}. the usual?', 'stool is free. so is my judgement', 'you look like a failed deploy', 'Rollback IPA is on tap tonight', 'shades stay on. what can i get you', 'back again? the bug or the beer?', 'sit. talk. drink. in any order'];
const DEX_IDLE = ['glasses dont polish themselves', 'who left a laptop in the ice bin', 'tab is open. tab is always open', 'jukebox only knows sad synthwave', 'pager went off. muscle memory', 'one more IPA and you can push to main', 'the ice machine is load bearing', 'last call is a social construct', 'someone ordered a "vibe". gave them water', 'keg is low. so is my patience', 'this bar has better uptime than prod', 'tip jar takes coins and confessions'];

/** @param {any} S @param {any} W */
export function makeDex(S, W) {
  const R = S.rooms.bar; const N = R.npc || { x: R.spawn.x + 1, z: R.spawn.z - 1, face: 0 };
  const n = new Agent(S.A, { scene: R.root, grid: R.grid }, NPC.look, N.x, N.z); W.put(n, R); n.root.rotation.y = N.face || 0; n.face = N.face || 0;
  const path = Array.isArray(N.path) && N.path.length ? N.path : null;
  let i = 0, wait = 3, walking = false, greeted = -99;
  const tick = (dt, t) => {
    if (S.floor !== R.floorId) return;
    const me = S.me, d = S.room === R ? n.pos.distanceTo(me.pos) : 99;
    if (S.ui?.talking) { n.path = null; walking = false; n.face = Math.atan2(me.pos.x - n.pos.x, me.pos.z - n.pos.z); n.update(dt); return; }
    n.av.fx.look = d < 3.5 ? me.pos : null;
    if (d < 2.2 && !walking) { n.face = Math.atan2(me.pos.x - n.pos.x, me.pos.z - n.pos.z); if (t - greeted > 60) { greeted = t; if (Math.random() < 0.7) S.ui?.bubble(n, draw(DEX_GREET).replace('{player}', S.player?.name || 'you'), 3.2); } }
    if (path && !walking && (wait -= dt) < 0) {
      i = (i + 1) % path.length; const s = path[i]; walking = true;
      n.walkTo(s.x, s.z, () => { walking = false; n.face = s.face ?? n.face; wait = 4 + ((i * 7) % 5); if (s.act && s.act !== 'Idle') n.once(s.act, 2.2); if ((s.say || Math.random() < 0.35) && (!S.director || S.director.spend(S.t, 1))) S.ui?.bubble(n, draw(DEX_IDLE), 3.4); }, 1.5);
    }
    const seen = S.cull ? S.cull.sees(S.wpos(n)) : true; if (n.root.visible !== seen) n.root.visible = seen;
    n.update(dt, seen);
  };
  return { agent: n, tick, name: NPC.name };
}
