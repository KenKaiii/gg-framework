// @ts-check
// Activities for Paper Street: sparring in the ring, soap-making for coins, the rules board + daily homework,
// and the catalogue-corner personality quiz. Small gags (bag, TV, photo, helmet) live in the room's onInteract.
import { startSpar } from './fightclub-spar.js';
import { startSoap } from './fightclub-soap.js';
import { startRules } from './fightclub-rules.js';
import { startCatalogue } from './fightclub-cat.js';

const at = (id) => (/** @type {any} */ it, /** @type {any} */ R) => R.id === 'fightclub' && it.id === id;
export default [
  { id: 'fightclub-spar', match: at('ring'), label: () => 'Spar in the ring', sfx: 'go', start: startSpar },
  { id: 'fightclub-soap', match: at('soap'), label: () => 'Make soap', sfx: 'bubble', start: startSoap },
  { id: 'fightclub-rules', match: at('rules'), label: () => 'Read the rules', sfx: 'paper', start: startRules },
  { id: 'fightclub-catalogue', match: at('catalogue'), label: () => 'Take the furniture quiz', sfx: 'page', start: startCatalogue },
];
