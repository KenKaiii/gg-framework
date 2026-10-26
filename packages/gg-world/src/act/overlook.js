// @ts-check
// Activities for The Overlook Hall: Jack's typewriter close-up (the other homages react in-world via R.onInteract).
import { startTypewriter } from './overlook-type.js';

export default [
  { id: 'overlook-typewriter', match: (it, R) => R.id === 'overlook' && it.id === 'typewriter', label: () => 'Read the pages', sfx: 'paper', start: startTypewriter },
];
