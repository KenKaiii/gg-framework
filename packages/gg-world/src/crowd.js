// @ts-check
// ~20 more deterministic fake members (vibe coders, dark looks, a few silly) spread over the building.
import { rng } from './rooms/kit.js';

const NAMES = ['nyx', 'dante', 'pixel', 'vex', 'rook', 'zara', 'cass', 'milo', 'echo', 'jinx', 'ozzy', 'tess', 'remy', 'kiko', 'blaze', 'ivy', 'lux', 'nova', 'gus', 'yuki', 'fern', 'sage', 'koda', 'wren', 'nico', 'pip', 'rhea', 'axel', 'moss', 'luna', 'otto', 'rook2', 'quinn', 'atlas', 'ember', 'onyx', 'pixie', 'jett', 'nori', 'cobalt', 'rune', 'vesper', 'kip', 'sable', 'zeno', 'lyra', 'orion', 'wisp', 'tank', 'mochi', 'drift', 'hex', 'glitch', 'byte'];
const TITLES = ['Vibe Coder', 'Midnight Merger', 'Yak Shaver', 'Prompt Goblin', 'Regex Necromancer', 'Hotfix Hero', 'Tab Hoarder', 'Semicolon Sommelier', 'Coffee Compiler', 'Merge Conflict Survivor', 'Lint Rebel', 'Side Project Collector'];
const BADGES = ['Hello world', '100 commits', 'Night owl', 'Bug squasher', 'Green CI', 'Streak 30d', 'First deploy', 'Rubber duck'];
const HOMES = ['hackers', 'hackers', 'hackers', 'computer', 'computer', 'computer', 'fightclub', 'fightclub', 'fightclub', 'inception', 'inception', 'inception', 'tavern', 'tavern', 'tavern', 'bar', 'bar', 'bar', 'bar', 'bar', 'bar', 'bar', 'bar', 'bar', 'den', 'den', 'den', 'den', 'den', 'roof', 'roof', 'roof', 'roof', 'basement', 'basement', 'bedroom', 'kitchen', 'kitchen', 'kitchen', 'kitchen', 'studio', 'studio', 'studio', 'studio', 'studio', 'bar', 'screening', 'screening', 'screening', 'screening', 'diner', 'diner', 'diner', 'diner', 'diner', 'library', 'library', 'library', 'garage', 'garage', 'garage', 'overlook', 'overlook', 'hawkins', 'hawkins', 'hawkins', 'biolab', 'biolab', 'biolab'];
const BODIES = ['rogue', 'knight', 'mage', 'barbarian'];
const TOPS = ['#1c1c1c', '#23262e', '#2a2440', '#3a2a34', '#1e2240', '#2d3a2e', '#4a2c2a', '#16171c', '#2b2d42'];
const BOTTOMS = ['#15111c', '#1b1b2f', '#22223b', '#1e2240', '#2a2440'];
const HAIR = ['#111111', '#1b1410', '#3a2618', '#6a4a2a', '#5a189a', '#7a1a1a', '#c9b79c', '#2a1a2a', '#1f3a2e'];
const SKIN = ['#f2c6a0', '#c68a5e', '#8d5a3b', '#6f4e37', '#f9dcc4', '#e0ac69', '#a8714f'];
const ACC = ['none', 'glasses', 'headphones', 'fur', 'none', 'headphones'];
const ACCENTS = ['#6ee7a0', '#e0a458', '#b04fd8', '#ff4fd8', '#8fa8ff'];
const SILLY = [['shades', 'coat'], ['cone'], ['moustache'], ['tinfoil'], ['clown'], ['cape'], ['sunglasses'], ['duck']];

/** @returns {any[]} */
export function extraMembers() {
  const r = rng(2077), pick = a => a[Math.floor(r() * a.length)];
  return NAMES.map((name, i) => {
    const body = pick(BODIES), level = 1 + Math.floor(Math.pow(r(), 1.8) * 199);
    const look = { body, head: r() < 0.35 ? 'hooded' : pick(BODIES), hair: pick(HAIR), skin: pick(SKIN), top: pick(TOPS), bottom: pick(BOTTOMS), acc: pick(ACC), accColor: pick(['#111111', '#3ddc84', '#b04fd8', '#2a1838']) };
    if (i % 4 === 1) look.silly = SILLY[(i >> 2) % SILLY.length];
    const nb = 1 + Math.floor(r() * 3), badges = []; for (let k = 0; k < nb; k++) { const b = pick(BADGES); if (!badges.includes(b)) badges.push(b); }
    return { id: name, name, home: HOMES[i % HOMES.length], level, title: pick(TITLES), accent: pick(ACCENTS), look, badges, shipped: Math.floor(level / 6) };
  });
}
