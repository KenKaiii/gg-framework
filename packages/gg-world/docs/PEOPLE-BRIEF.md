# People brief: players (members) + NPCs (residents)

Owner: "NPCs are all saying the same nonsense, too often, not randomized enough, not real enough. Better AI overall.
Some are players and some are genuine NPCs which say/do random things. Give them different looks, uniqueness."

Night Rooms = a cozy late-night isometric hangout for vibe coders (they code with AI agents, ship side projects, game,
drink, joke). Two kinds of people:
- PLAYERS (members): other coders who are online. Their status comes from their real coding app (prompting, thinking,
  deploying, shipped, failed, on a break). They talk like real people in a Discord / at a meetup: about what they're
  building, their agent, bugs, deploys, the room, each other, the time of night, the weather outside, games, food.
- NPCs (residents): characters who live in one room (bartender, diner waitress, librarian...). They have a job, walk
  around their room, do things, and say in-character things. You can talk to them (they answer in character).

The coordinator writes the engine (src/people/talk.js etc.). You write CONTENT files in src/people/ in the exact format
below. Plain ES modules, `// @ts-check` header, `export const ...`. No imports needed.

## Writing rules (all lines)
- ASCII only: no emoji, no curly quotes, no em dashes (the pixel font has no glyphs for them). Straight quotes only.
- Short: max 56 characters per line (a bubble shows ~2 lines of ~30 chars). Most lines 15-40 chars.
- Sound like real people: lowercase is fine, fragments, typos-free, specific details (tool names, error types, food,
  games, times). Mild swearing ok sometimes ("damn", "hell", "shit", "wtf"). Never slurs, sexual or hateful content,
  no real people's names or likenesses, no brand logos. Film/game references = homage, short.
- Variety is the point: no two lines that say nearly the same thing; avoid filler ("lol" on its own, "nice"); every
  persona must be recognisable from its lines alone.
- Template slots the engine fills (use them; don't invent others):
  {me} speaker's name, {other} another person's name, {player} the human player's name, {room} current room name,
  {ver} a version string like v2.3, {hour} like "2am" / "11pm", {weather} like "rain" / "clear skies" / "fog",
  {A} / {B} in conversation scripts = the two speakers' names.

## Rooms (ids)
bar (The Terminal: bar, pool, darts, booths, open mic), den (purple retro gaming den: CRT couch, arcade row, pinball),
bedroom (Night Shift: someone's bedroom, CRT glow, rain on blinds), kitchen (ramen, fridge, leftovers), studio (stream
desk, podcast mics, growth chart), screening (indie cinema, parody trailers, popcorn), diner (Jackrabbit Diner: shakes,
cherry pie, twist contest, a red curtain you shouldn't open), library (candle-lit stacks, a talking hat, owl post),
garage (Doc's Garage: clocks, a time car, an amp to eleven), overlook (The Overlook Hall: typewriter, twins, room 237),
hawkins (80s living room: christmas lights alphabet, D&D table, a crack in the wall), biolab (Lab 426: alien eggs,
amber, MOTHER terminal), hackers (Club Cyberdelia: 90s rave, rollerblades, payphones), computer (The Computer Lab:
beige CRTs, LAN parties, Prompt School), fightclub (Paper Street: basement, soap, the rules), inception (Limbo:
spinning top, Penrose stairs, dream chairs), tavern (The Prancing Murloc: fantasy inn, quest board, card duels),
roof (The Roof: city lights, fire drum, telescope, hammock), basement (server room + hacker desks).

## FORMAT A: personas (players). Files: src/people/personas-a.js and src/people/personas-b.js
```js
// @ts-check
/** @type {import('./types').Persona[]} */  // (types optional; just keep the shape)
export default [
  {
    id: 'grind',                      // short, unique
    label: 'night-owl grinder',       // what kind of person this is (for us, not shown)
    pace: 1.0,                        // 0.5 quiet .. 1.6 chatty
    style: { lower: true, dots: false },  // lower: writes in lowercase; dots: trails off with "..." sometimes
    // things they say on their own, any time (30-40 lines, varied topics: their project, their agent, life, jokes)
    idle: ['...', '...'],
    // status lines (6-10 each): what they say when their coding status changes
    prompting: ['...'], thinking: ['...'], deploying: ['...use {ver}...'], shipped: ['...'], failed: ['...'], breakTime: ['...'],
    // reacting to someone else's ship / fail (5-8 each, use {other})
    cheer: ['...'], console: ['...'],
    // when the human player walks up close (5-8, may use {player})
    greet: ['...'],
    // late night / early morning / day (4-6 each, may use {hour})
    late: ['...'], morning: ['...'],
    // weather outside (3-5 each, may use {weather}): rain / clear / cloudy
    rain: ['...'], clear: ['...'],
    // looks: how this kind of person dresses (the engine mixes these with randomness)
    looks: { tops: ['#hex', ...], bottoms: ['#hex', ...], acc: ['none'|'glasses'|'headphones'|'fur'|'wizard'|'helmet', ...], heads: ['rogue'|'hooded'|'knight'|'mage'|'barbarian', ...], bodies: ['rogue'|'knight'|'mage'|'barbarian', ...], silly: [[], ['shades'], ...] }   // silly items: cone tinfoil clown moustache duck sunglasses cape shades coat
  },
]
```
Each file: 6 personas, all clearly different people (e.g. A: night-owl grinder, cheerful beginner, burnt-out senior,
indie hacker selling a SaaS, AI maximalist who trusts the agent too much, quiet designer. B: chaotic gamer who codes,
crypto-skeptic data nerd, open-source maintainer drowning in issues, student pulling an all-nighter, sarcastic devops
person, wholesome streamer). Write lines in each persona's own voice.

## FORMAT B: room lines. File: src/people/rooms.js
```js
// @ts-check
export default {
  bar: ['...', ...],   // 8-12 lines anyone in that room might say about the room itself (the drinks, the pool table...)
  den: [...], ...      // every room id listed above
}
```

## FORMAT C: conversations. File: src/people/convos.js
Two (sometimes three) people in the same room talk back and forth. 40+ short scripts, 2-6 turns each, varied topics
(bugs, agents rewriting code, deploy horror, games, food, the weather, gossip about the room, the time car, dreams,
side projects, music, the twins upstairs...). Some tagged to a room (only used there), most room-agnostic.
```js
// @ts-check
export default [
  { room: null, lines: [['A', 'did your agent just delete the tests'], ['B', 'it said they were "redundant"'], ['A', 'brave']] },
  { room: 'diner', lines: [['A', 'pie or shake'], ['B', 'yes'], ['A', 'correct answer']] },
]
```
(A/B are the speakers in order; use {A}/{B} in text to mention a name, and {player} rarely.)

## FORMAT D: residents (NPCs). Files: src/people/residents-a.js and src/people/residents-b.js
One resident per room in the given list. Each resident is a character with a job in that room.
```js
// @ts-check
export default [
  {
    id: 'mo', name: 'Mo', room: 'diner', role: 'night waitress',   // name: short, invented (no real people)
    personality: 'tired but warm, calls everyone hon, refills coffee nobody ordered', // for the AI brain
    look: { body: 'rogue'|'knight'|'mage'|'barbarian', head: 'rogue'|'hooded'|'knight'|'mage'|'barbarian', hair: '#hex', skin: '#hex', top: '#hex', bottom: '#hex', acc: 'none'|'glasses'|'headphones'|'fur'|'wizard'|'helmet', accColor: '#hex', silly: [] },
    // what they do while walking their room: each stop = a spot type + what they do there + optional line
    routine: [ { at: 'counter', act: 'Interact', say: ['...'] }, { at: 'booths', act: 'PickUp', say: [] }, { at: 'any', act: 'Idle', say: [] } ],
    //   at: a word that names a spot in that room (the engine finds the nearest interactable/seat whose id or label matches; 'any' = a random free spot)
    //   act: one of Idle, Interact, PickUp, Use_Item, Spellcasting, Cheer, Unarmed_Idle
    ambient: ['...'],      // 20-30 things they say out loud on their own (in character, room-specific)
    greet: ['...'],        // 6-10 when the player walks up (may use {player})
    reactShip: ['...'],    // 4-6 when someone in the room ships (use {other})
    talk: {                // their side of a conversation when the player chats with them (no AI connected):
      hello: ['...'], who: ['...'], room: ['...'], work: ['...'], joke: ['...'], bye: ['...'], unknown: ['...'],
      // + 4-8 own topic keys with keyword lists, e.g.  pie: { keys: ['pie','cherry'], lines: ['...'] }
      topics: { pie: { keys: ['pie', 'cherry'], lines: ['...'] } },
    },
  },
]
```
residents-a.js: diner, library, garage, overlook, hawkins, biolab, screening, kitchen.
residents-b.js: hackers, computer, fightclub, inception, tavern, roof, basement, den, studio.
(The bar already has Dex the bartender; don't make one for the bar.)
For rooms that already have built-in figures (tavern innkeeper, overlook twins), make a different character
(e.g. tavern: a wandering bard; overlook: a night caretaker).
