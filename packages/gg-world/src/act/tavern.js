// @ts-check
// Activities for The Prancing Murloc: quest board, loot roll, card duel, raid plan. Small gags live in the room's onInteract.
import { startQuests } from './tavern-quest.js';
import { startLoot } from './tavern-loot.js';
import { startDuel } from './tavern-duel.js';
import { startRaid } from './tavern-raid.js';
import { setView, clearView, worldOf } from './view.js';

/** Wrap an activity start: blend the camera to a close-up of the prop behind the overlay; always clear it on exit. */
const withView = (start, y = 0.9, zoom = 2.2) => (/** @type {any} */ ctx) => {
  const { S, R, it } = ctx; setView(S, { target: worldOf(R, it.vx ?? it.x, y, it.vz ?? it.z), /* the table itself, not where you stand */ dir: { x: 1, y: 0.95, z: 1 }, zoom });
  const ov0 = ctx.overlay; ctx.overlay = (/** @type {any} */ o) => { const ov = ov0(o); ov.onClose(() => clearView(S)); return ov; };
  try { start(ctx); } catch (e) { clearView(S); throw e; }
};

const at = (/** @type {string} */ id) => (/** @type {any} */ it, /** @type {any} */ R) => R.id === 'tavern' && it.id === id;
export default [
  { id: 'tavern-quests', match: at('quests'), label: () => 'Read the quest board', start: withView(startQuests, 1.4) },
  { id: 'tavern-loot', match: at('loot'), label: () => 'Roll for loot', start: withView(startLoot, 0.8, 1.8) },
  { id: 'tavern-duel', match: at('duel'), label: () => 'Card duel vs the innkeeper', start: withView(startDuel, 0.8, 1.8) },
  { id: 'tavern-raid', match: at('raid'), label: () => 'Study the raid plan', start: withView(startRaid, 1.3) },
];
