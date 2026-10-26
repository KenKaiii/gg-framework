// @ts-check
// Activities for Limbo: the totem (push your luck), dream architect (daily circular maze), go under (3 dream levels).
// Small in-world reactions (mirrors, folding city, Penrose steps, floating sofa, sandcastle) are R.onInteract in rooms/inception.js.
import { startTotem } from './inception-totem.js';
import { startMaze } from './inception-maze.js';
import { startUnder } from './inception-under.js';

export default [
  { id: 'inception-totem', match: (it, R) => R.id === 'inception' && it.id === 'totem', label: () => 'Spin the top', start: startTotem, sfx: false },
  { id: 'inception-maze', match: (it, R) => R.id === 'inception' && it.id === 'draft', label: () => 'Design a maze', start: startMaze },
  { id: 'inception-under', match: (it, R) => R.id === 'inception' && it.kind === 'seat' && it.act === 'inception-under', label: () => 'Go under', start: startUnder },
];
