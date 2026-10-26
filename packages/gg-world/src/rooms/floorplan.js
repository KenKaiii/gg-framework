// @ts-check
// The building: which rooms share a floor, their size and world position, and the open archways between them.
// Rooms on the same floor are all visible at once and you walk between them. Floors are joined by stairs (doors with `to`).
// Coordinates: x east, z south. Default camera looks from +x/+z, so north (n) and west (w) walls are the back walls.
// Rooms on one floor are ONE building: they share walls (a single wall line, no gap), stand on one continuous floor slab
// drawn by the game (rooms on a joined floor skip their own slab), and are linked by wide openings, not doors.
// Ground floor layout (v4, 3x the v3 area): one full rectangle, x -9..53, z -6..24 (62 x 30).
//   z -6..6   bar (-9..9) | den (9..22) | screening (22..38) | diner (38..53)
//   z  6..14  bedroom (-9..1) | kitchen (1..9) | studio (9..22) | library (22..38) | garage (38..53)
//   z 14..24  overlook (-9..13) | hawkins (13..31) | biolab (31..53)
// v5 (owner: "double it, to the left, one square"): south wing added, whole floor x -9..53, z -6..56 (62 x 62).
//   z 24..38  hackers (-9..13) | computer (13..31) | fightclub (31..53)
//   z 38..56  inception (-9..21) | tavern (21..53)
// Every room is a different place with its own film references; the scary ones (overlook, hawkins, biolab) are the
// front row. Your bedroom stays private: it only opens to the bar.

/** @type {Record<string, {name:string, rooms: Record<string,{w:number,d:number,x:number,z:number}>}>} */
export const FLOORS = {
  main: { name: 'Ground floor', rooms: {
    bar: { w: 18, d: 12, x: 0, z: 0 },           // The Terminal: x -9..9, z -6..6. Its n and w walls are the building's back walls.
    den: { w: 13, d: 12, x: 15.5, z: 0 },        // The Den: x 9..22, z -6..6. Shares the bar's east wall.
    bedroom: { w: 10, d: 8, x: -4, z: 10 },      // Night Shift: x -9..1, z 6..14. Shares the bar's south wall (west part).
    kitchen: { w: 8, d: 8, x: 5, z: 10 },        // The Kitchen: x 1..9, z 6..14. Shares the bar's south wall (east part) and the bedroom's east wall.
    studio: { w: 13, d: 8, x: 15.5, z: 10 },     // The Studio: x 9..22, z 6..14. Shares the den's south wall and the kitchen's east wall.
    screening: { w: 16, d: 12, x: 30, z: 0 },    // The Screening Room: x 22..38, z -6..6 (cinema)
    diner: { w: 15, d: 12, x: 45.5, z: 0 },      // Jackrabbit Diner: x 38..53, z -6..6 (50s diner, Pulp Fiction / Twin Peaks)
    library: { w: 16, d: 8, x: 30, z: 10 },      // The Restricted Section: x 22..38, z 6..14 (wizard library, Harry Potter / LOTR)
    garage: { w: 15, d: 8, x: 45.5, z: 10 },     // Doc's Garage: x 38..53, z 6..14 (Back to the Future / Ghostbusters)
    overlook: { w: 22, d: 10, x: 2, z: 19 },     // The Overlook Hall: x -9..13, z 14..24 (The Shining, scary)
    hawkins: { w: 18, d: 10, x: 22, z: 19 },     // Hawkins Living Room: x 13..31, z 14..24 (Stranger Things, scary)
    biolab: { w: 22, d: 10, x: 42, z: 19 },      // Lab 426: x 31..53, z 14..24 (Alien / Jurassic Park, scary)
    hackers: { w: 22, d: 14, x: 2, z: 31 },      // Club Cyberdelia: x -9..13, z 24..38 (Hackers, 1995)
    computer: { w: 18, d: 14, x: 22, z: 31 },    // The Computer Lab: x 13..31, z 24..38 (retro PCs, playable classics)
    fightclub: { w: 22, d: 14, x: 42, z: 31 },   // Paper Street: x 31..53, z 24..38 (Fight Club)
    inception: { w: 30, d: 18, x: 6, z: 47 },    // Limbo: x -9..21, z 38..56 (Inception)
    tavern: { w: 32, d: 18, x: 37, z: 47 },      // The Prancing Murloc: x 21..53, z 38..56 (World of Warcraft inn)
  } },
  roof: { name: 'Rooftop', rooms: { roof: { w: 20, d: 14, x: 0, z: 0 } } },
  // The Engine Room (owner: GG Coder itself, "how it all runs", with Ken fixing things) joins the basement to the east
  basement: { name: 'Basement', rooms: { basement: { w: 16, d: 11, x: 0, z: 0 }, engine: { w: 22, d: 14, x: 19, z: 0 } } },
};

/** Open archways between neighbouring rooms on the same floor.
 * west/east pairs share a wall along z (`z` = world z of the opening centre); north/south pairs share a wall along x (`x`). */
export const PASSAGES = [
  { west: 'bar', east: 'den', z: 0, w: 5.0 },          // wide open, the two rooms read as one space
  { north: 'bar', south: 'bedroom', x: -3, w: 2.4 },   // a proper doorway-size opening into your room
  { north: 'bar', south: 'kitchen', x: 5, w: 3.0 },     // bar -> kitchen
  { west: 'kitchen', east: 'studio', z: 10, w: 2.6 },   // kitchen -> studio
  { north: 'den', south: 'studio', x: 15.5, w: 3.0 },   // den -> studio
  // v4 east wing
  { west: 'den', east: 'screening', z: 0, w: 3.0 },
  { west: 'screening', east: 'diner', z: 0, w: 3.0 },
  { west: 'studio', east: 'library', z: 10, w: 2.6 },
  { west: 'library', east: 'garage', z: 10, w: 2.4 },
  { north: 'screening', south: 'library', x: 30, w: 3.0 },
  { north: 'diner', south: 'garage', x: 45.5, w: 3.0 },
  // v4 south wing (scary row)
  { north: 'kitchen', south: 'overlook', x: 5, w: 2.4 },
  { north: 'studio', south: 'hawkins', x: 17.5, w: 2.6 },
  { north: 'library', south: 'hawkins', x: 27, w: 2.4 },
  { north: 'garage', south: 'biolab', x: 45.5, w: 3.0 },
  { west: 'overlook', east: 'hawkins', z: 19, w: 2.4 },
  { west: 'hawkins', east: 'biolab', z: 19, w: 2.4 },
  // v5 south wing
  { north: 'overlook', south: 'hackers', x: 2, w: 2.6 },
  { north: 'hawkins', south: 'computer', x: 22, w: 2.6 },
  { north: 'biolab', south: 'fightclub', x: 42, w: 2.6 },
  { west: 'hackers', east: 'computer', z: 31, w: 2.6 },
  { west: 'computer', east: 'fightclub', z: 31, w: 2.6 },
  { north: 'hackers', south: 'inception', x: 2, w: 3.0 },
  { north: 'computer', south: 'tavern', x: 26, w: 2.6 },
  { north: 'fightclub', south: 'tavern', x: 46, w: 3.0 },
  { west: 'inception', east: 'tavern', z: 47, w: 3.0 },
  { west: 'basement', east: 'engine', z: 0, w: 2.6 },
];
/** Floors whose rooms are joined into one building (shared walls + one slab). */
export const JOINED = new Set(['main', 'basement']); // basement + engine room are walked between


/** Stairs between floors (rendered as doors on a back wall; walking into one changes floor). */
export const STAIRS = [
  { from: 'bar', to: 'roof', label: '↑ The Roof' }, { from: 'roof', to: 'bar', label: '↓ The Terminal' },
  { from: 'den', to: 'basement', label: '↓ The Basement' }, { from: 'basement', to: 'den', label: '↑ The Den' },
];

/** Display names (signs over openings, prompts). */
export const ROOM_NAMES = { bar: 'The Terminal', den: 'The Den', bedroom: 'Night Shift', kitchen: 'The Kitchen', studio: 'The Studio',
  screening: 'Screening Room', diner: 'Jackrabbit Diner', library: 'Restricted Section', garage: "Doc's Garage",
  overlook: 'The Overlook', hawkins: 'Hawkins', biolab: 'Lab 426',
  hackers: 'Club Cyberdelia', computer: 'The Computer Lab', fightclub: 'Paper Street', inception: 'Limbo', tavern: 'The Prancing Murloc', engine: 'The Engine Room', roof: 'The Roof', basement: 'The Basement' };
/** Every opening on a floor in WORLD coords: { floor, x, z, a, b, w } (a/b = the two rooms it joins). */
export function passagesWorld() {
  const out = [];
  for (const p of PASSAGES) {
    const A = p.west || p.north, B = p.east || p.south, f = floorOf(A); const r = FLOORS[f].rooms[A];
    if (p.west) out.push({ floor: f, x: r.x + r.w / 2, z: p.z, a: A, b: B, w: p.w });
    else out.push({ floor: f, x: p.x, z: r.z + r.d / 2, a: A, b: B, w: p.w });
  }
  return out;
}
/** @param {string} id */
export function floorOf(id) { for (const f in FLOORS) if (FLOORS[f].rooms[id]) return f; return null; }

/**
 * Everything a room needs to know about its place in the building.
 * passages: in the room's own wall terms ({side, at, w, to}) ready for makeRoom.
 * exterior: which of its walls face outside (put tall furniture against these; interior walls may be lowered when the
 * neighbour room is in focus, so keep only wall-mounted decor added via R.onWall on them).
 * @param {string} id
 */
export function roomInfo(id) {
  const f = floorOf(id); if (!f) return null; const r = FLOORS[f].rooms[id];
  const passages = [];
  for (const p of PASSAGES) {
    if (p.west === id) passages.push({ side: 'e', at: p.z - r.z, w: p.w, to: p.east });
    if (p.east === id) passages.push({ side: 'w', at: -(p.z - r.z), w: p.w, to: p.west });
    if (p.north === id) passages.push({ side: 's', at: -(p.x - r.x), w: p.w, to: p.south });
    if (p.south === id) passages.push({ side: 'n', at: p.x - r.x, w: p.w, to: p.north });
  }
  const interior = new Set(passages.map(p => p.side));
  // shared walls: a wall touching a neighbour on the same floor is drawn by only ONE room (the north / west one) so there's a single wall line
  const shared = {}; const R = FLOORS[f].rooms; const eps = 0.01;
  for (const oid in R) { if (oid === id) continue; const o = R[oid];
    const zOverlap = Math.min(r.z + r.d / 2, o.z + o.d / 2) - Math.max(r.z - r.d / 2, o.z - o.d / 2), xOverlap = Math.min(r.x + r.w / 2, o.x + o.w / 2) - Math.max(r.x - r.w / 2, o.x - o.w / 2);
    if (zOverlap > eps && Math.abs((r.x + r.w / 2) - (o.x - o.w / 2)) < eps) shared.e = { with: oid, draw: true };
    if (zOverlap > eps && Math.abs((r.x - r.w / 2) - (o.x + o.w / 2)) < eps) shared.w = { with: oid, draw: false };
    if (xOverlap > eps && Math.abs((r.z + r.d / 2) - (o.z - o.d / 2)) < eps) shared.s = { with: oid, draw: true };
    if (xOverlap > eps && Math.abs((r.z - r.d / 2) - (o.z + o.d / 2)) < eps) shared.n = { with: oid, draw: false }; }
  return { id, floor: f, ...r, joined: JOINED.has(f), passages, shared, exterior: ['n', 's', 'w', 'e'].filter(s => !interior.has(s) && !shared[s]), stairs: STAIRS.filter(s => s.from === id) };
}
