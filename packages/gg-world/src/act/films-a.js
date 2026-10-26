// @ts-check
// Films A (Matrix + sci-fi): wake-up-Neo terminal, the red eye, W.O.P.R. tic-tac-toe and small homage props.
import { startTerminal } from './films-a-term.js';
import { startHal } from './films-a-hal.js';
import { startWopr } from './films-a-wopr.js';
import { SFX } from '../sfx.js';

const SND = {
  saber: (o) => { SFX.play('laser', { ...o, vol: 0.5, pitch: 0.6 }); SFX.play('hum', { ...o, vol: 0.4, delay: 0.15 }); SFX.play('swoosh', { ...o, vol: 0.4, delay: 0.6 }); },
  flux: (o) => { SFX.play('zap', { ...o, vol: 0.5 }); setTimeout(() => SFX.play('zap', { ...o, vol: 0.4, pitch: 1.3 }), 250); SFX.play('hum', { ...o, vol: 0.3, delay: 0.4 }); },
  spice: (o) => { SFX.play('rattle', { ...o, vol: 0.4 }); SFX.play('magic', { ...o, vol: 0.4, delay: 0.4 }); },
};

/** In-world prop: fire its effect (extras-films-a tick animates it), say a line, end at once. */
const prop = (room, id, line) => ({
  id: 'films-a-' + id, sfx: false, match: (it, R) => R.id === room && it.id === id,
  /** @param {any} ctx */
  start(ctx) { const o = ctx.R.root.position, it = ctx.it; SND[id]?.(it ? { at: { x: o.x + it.x, y: 1, z: o.z + it.z } } : {}); ctx.R.filmsA?.fire(id); ctx.api.toast(line); ctx.done(); },
});

export default [
  { id: 'films-a-neo', match: (it, R) => R.id === 'bedroom' && it.id === 'pc', label: () => 'Check terminal', start: startTerminal },
  { id: 'films-a-hal', match: (it, R) => R.id === 'basement' && it.id === 'hal', label: () => 'Talk to the red eye', start: startHal },
  { id: 'films-a-wopr', match: (it, R) => R.id === 'basement' && it.id === 'wopr', label: () => 'Shall we play a game?', start: startWopr },
  prop('den', 'saber', 'Vrrmmm. An elegant weapon, for a more civilized age.'),
  prop('basement', 'flux', '1.21 gigawatts!?'),
  prop('kitchen', 'spice', 'The spice must flow. (It\'s paprika.)'),
];
