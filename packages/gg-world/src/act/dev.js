// @ts-check
// Test hook: window.__openAct('<activityId>' | '<roomId>:<interactableId>') opens an activity without walking there.
// Used by tools/act-shot.mjs. Harmless in the shipped game.
import { ACTIVITIES } from './index.js';
/** @param {any} S */
export function installDev(S) {
  // @ts-ignore
  window.__openAct = (key) => {
    const [rid, iid] = key.includes(':') ? key.split(':') : [null, null];
    for (const id in S.rooms) { const R = S.rooms[id]; if (rid && id !== rid) continue;
      const items = [...(R.interact || []), ...(R.interact || []).filter(i => i.id === 'tv').map(i => ({ ...i, id: 'tv-app' })) /* apps behind a TV's change channel */, ...(R.slots || []).filter(s => s.act).map(s => ({ id: s.id, kind: 'seat', act: s.act, slot: s, x: s.x, z: s.z, label: s.actLabel || 'Sit down' }))];
      for (const it of items) { if (iid ? it.id !== iid : !ACTIVITIES.some(a => a.id === key && a.match(it, R))) continue;
        if (S.room !== R) S.W.travel?.(id); return S.act.tryStart(it, R, { toast: S.ui?.toast || (() => {}), bubble: () => {} }); } }
    return false;
  };
  // @ts-ignore  every activity id (test sweeps)
  window.__actIds = () => ACTIVITIES.map(a => a.id);
}
