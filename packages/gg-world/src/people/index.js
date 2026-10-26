// @ts-check
// Loads the people content (written to PEOPLE-BRIEF.md) and gives safe defaults if a file is missing.
import personasA from './personas-a.js';
import personasB from './personas-b.js';
import ROOM_LINES from './rooms.js';
import CONVOS from './convos.js';
import residentsA from './residents-a.js';
import residentsB from './residents-b.js';
import residentsEngine from './residents-engine.js';

export const PERSONAS = [...(personasA || []), ...(personasB || [])];
// owner (2026-10-26): keep only NPCs that serve the game: Pat (Prompt School), Lyra (quest board), Oz (server room); Dex is separate.
// The other residents stay written in residents-a/b.js and can come back by adding their id here.
export const KEEP_RESIDENTS = ['pat', 'lyra', 'oz', 'ken'];
export const RESIDENTS = [...(residentsA || []), ...(residentsB || []), ...(residentsEngine || [])].filter(r => KEEP_RESIDENTS.includes(r.id));
export { ROOM_LINES, CONVOS };
