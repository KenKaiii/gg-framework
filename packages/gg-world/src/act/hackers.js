// @ts-check
// Activities for Club Cyberdelia: Hack the Gibson, SLIPSTREAM racer, payphone phreaking, HANDLE.EXE + small reactions.
import { startHandle } from './hackers-handle.js';
import { startPhone } from './hackers-phone.js';
import { startGibson } from './hackers-gibson.js';
import { startRace } from './hackers-race.js';

const LINES = { blades: 'Rollerblades on. Never off.', decks: 'Wicka-wicka. The floor goes wild.', mess: '"Mess with the best..."' };
/** In-world reaction: animate the prop in the room, toast a line, end at once. */
const prop = id => ({
  id: 'hackers-' + id, sfx: false, match: (it, R) => R.id === 'hackers' && it.id === id,
  /** @param {any} ctx */
  start(ctx) { ctx.R.hackers?.fire(id); ctx.api.toast(LINES[id]); ctx.done(); },
});
const on = (id, item, label, start, sfx) => ({ id, match: (it, R) => R.id === 'hackers' && it.id === item, label: () => label, start, ...(sfx === undefined ? {} : { sfx }) });

export default [
  on('hackers-gibson', 'gibson', 'Hack the Gibson', startGibson, false),
  on('hackers-race', 'slipstream', 'Play SLIPSTREAM', startRace),
  on('hackers-phone', 'payphone', 'Phreak the payphone', startPhone, false),
  on('hackers-handle', 'handle', 'Pick a handle', startHandle),
  prop('blades'), prop('decks'), prop('mess'),
];
