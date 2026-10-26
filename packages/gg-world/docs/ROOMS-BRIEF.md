# Night Rooms: shared brief (iso-rooms)

## The product
A coding-agent desktop app (Tauri) gives its community XP and levels for coding (prompts, commits, deploys).
**Game mode** is a small social place inside that app: members hang out, chat, show off their level and
customise their character with coins earned from coding. Members who are coding in the app at that moment are
shown in the game too: their character sits somewhere with a laptop, typing. So the place is never empty.

The owner picked the **isometric dollhouse-rooms** style and wants it to become **cozy night rooms**.

## Who it's for (this sets the mood)
Vibe coders, not office workers. They game, make money, code with AI, drink, have real lives, and they open this
at night while they code. So:
- **Not an office.** There are no desk rows. People code on laptops wherever they hang out: couch, bar stool,
  beanbag, bed, floor.
- **Darker, grungier and cozier.** Night time. Lifted shadows (deep indigo and violet, never pitch black), pools
  of warm amber lamp light, screens and neon glowing. Lived-in clutter: cans, pizza boxes, cables, clothes,
  VHS tapes, stickers, worn rugs, taped posters. It should look like the owner's reference images: a messy 90s
  night bedroom with a CRT, posters, blinds and a moonbeam, and a purple retro gaming den with a CRT, beanbag
  and game shelves.
- **Subtle Matrix touches**, one or two per room, never the whole theme and **never falling code rain**:
  green-phosphor CRTs and terminals, server LEDs, an old payphone, a black leather armchair, round black shades
  left on a shelf, a red pill / blue pill pair, a small "follow the white rabbit" sticker or tiny neon, green-tinted glass.
- **Easy on tired eyes**: no bright white walls or pastel bubblegum. Keep the brightest things small (bulbs,
  screens, neon).
- **Adult tone** is fine: beer, cocktails, shots, dark dev humour on posters and signs. No slurs, sexual or
  hateful content.

Palette: walls deep indigo / plum / brick / dark wood (#1e2240, #2a2440, #3a2a34, #4a2c2a); floors dark wood /
worn carpet / concrete; warm practical lights #ffb36b / #ffcf8a; phosphor green accents #3ddc84 / #6ee7a0;
occasional magenta / purple #b04fd8 / #ff4fd8 (as in the den reference); cool moonlight #8fa8ff through windows.

## Folder and tools
`/Users/kenkai/.gg/goals/gaming/showcase/games/iso-rooms/` is a copy of the t4-iso game; its old Workshop
code is still in `src/` and gets replaced by the integration builder. Room code lives in `src/rooms/`.

- `src/rooms/kit.js`: `mat(color, opts)` (cached MeshStandardMaterial), `glowMat(color, power)` (self-lit;
  power > 1 blooms), `rbox(w,h,d,mat,r)` (rounded box), `put(parent,obj,x,y,z,ry)`, `mesh(geo,mat)`,
  `rng(seed)`, `bake(root)`, `makeRoom(opts)` (room shell: floor, slab, 4 walls with windows and doors,
  cut-away, walk grid, `R.onWall`, `R.block`, `R.blockObj`, `R.cutaway`, `R.finish`), `lightRig(parent, opts)`
  (hemisphere + moon with shadow + exactly 4 point lights).
- `src/rooms/kit-fx.js`: `windowUnit` (view, blinds, curtains, rain), `doorUnit` (glowing doorway + sign),
  `beam(from,to,...)` (additive light shaft, e.g. a moonbeam), `motes(n,min,max)` (dust),
  `glow(color,size)` (halo sprite), `flicker(t,seed,amp)`, `steam(at)`.
- `src/rooms/tex.js`: canvas textures: `plaster`, `stripes`, `motif`, `planks`, `carpet`, `tiles`, `brick`,
  `panels`, `rug(kind,...)`, `nightView`, `rainTex`, `poster(kind,title)` (kinds: maze, space, dragon, band,
  movie, retro, plants, ship, cat, wave), `gameScreen(frame)` (platformer CRT), `termScreen` (green terminal),
  `codeScreen`, `label`, `neon(text,color)`, `spines` (book or game-box spines).
- `src/rooms/props-hand.js`: `attachProp(avatar, 'laptop'|'controller'|'beer'|'cocktail'|'phone'|'mug')`.
- `src/rooms/stub.js`: a minimal valid room, used as the placeholder in each room file.
- **Preview one room** (from `/Users/kenkai/.gg/goals/gaming/showcase`):
  `node games/iso-rooms/tools/room-shot.mjs <roomId> [--rot=1|2|3] [--zoom=6] [--webkit]`
  It bundles the preview harness, builds only your room with bloom, places KayKit test characters at your
  slots (playing the slot's animation and holding its prop), prints draw calls, triangles and build ms, and
  saves `games/iso-rooms/shots/<roomId>.png`. Exit code 1 means a page error. **Open the PNG with the read tool
  and judge it like an art director.**
- Characters are KayKit Rig_Medium (CC0), about 1.9 units tall at the game's scale. Clips: Idle, Walking_A,
  Running_A, Sit_Chair_Idle, Sit_Chair_Down, Sit_Chair_StandUp, Sit_Floor_Idle, Cheer, Interact, Use_Item,
  PickUp, Spellcasting, Jump_Full_Short, Unarmed_Idle. `Sit_Chair_Idle` with the root at y=0 matches the KayKit
  chair seat height (about 0.45); raise or lower with the slot's `y` for stools, sofas and beds. Check it
  visually.
- KayKit furniture templates exist (`ctx.A.furniture[name]`, pastel and bubbly, so only use them if you tint
  them darker): armchair_pillows, bed_single_A, book_set, cabinet_medium_decorated, cactus_medium_A, chair_A,
  chair_stool, couch_pillows, lamp_standing, lamp_table, pictureframe_*, pillow_A, rug_*, shelf_A_big,
  shelf_B_large_decorated, table_low, table_medium, table_small. Clone with `.clone(true)` and scale by 0.72.
  Prefer your own well-modelled code props built from rounded boxes, lathes, extrusions and tubes, with
  bevels and details. Never raw default boxes, and nothing should read as primitives.

## The room contract
Each room file `src/rooms/<id>.js` exports `build(ctx)` (ctx = `{ A, scene, renderer }`) and returns the object
`R` from `makeRoom(...)`, extended with:

| field | meaning |
|---|---|
| `R.rig` | `lightRig(R.root, {...})`: required. Exactly 4 point lights (`i: 0` for unused ones). Lamps and screens light the room; the moon is a soft fill. |
| `R.meta` | `{ id, name, blurb }` (blurb is one short line for the map) |
| `R.spawn` | `{ x, z, face }`: where you appear when entering the room from the map (doors handle their own entry point) |
| doors | in `makeRoom({ doors: [{ side, at, to: '<roomId>', label: '<Room Name>' }] })`, on the back walls `'n'` or `'w'` only so they're visible from the default camera. Connections: **bar** ↔ den, roof, bedroom; **den** ↔ bar, basement; **bedroom** ↔ bar; **roof** ↔ bar; **basement** ↔ den. |
| `R.slots` | 6–10 places where members hang out: `{ id, kind, x, z, y?, face, anim: 'Sit_Chair_Idle'\|'Sit_Floor_Idle'\|'Idle', prop?: 'laptop'\|'controller'\|'beer'\|'cocktail'\|'phone'\|'mug', label }`. At least half must work with a laptop (people are coding there). `face` = yaw the character looks toward (0 = +z). Each slot also needs a free floor cell in front of it to walk to. |
| `R.npc` | bar only: `{ x, z, face, path: [{ x, z, face, act: 'Interact'\|'Use_Item'\|'Idle', say? }] }`: the bartender's routine spots behind and around the counter |
| `R.interact` | `[{ id, x, z, r, label, kind }]`: things the player can press E on (jukebox, arcade, payphone, TV, window, bed...). Optional `R.onInteract(id, api)` where `api = { toast(text), bubble(text) }` triggers a visual effect in the room. |
| `R.editables` | bedroom only: 5–8 movable furniture Object3Ds, kept in `R.live` (not baked) with footprints blocked, for edit mode |
| `R.camera` | `{ zoom, target: THREE.Vector3 }`: zoom = half the visible height in world units (about 4.5–6 frames a 9×7 room nicely) |
| `R.tick(t, dt)` | animation: flickers, CRT frames, LEDs, steam, rain offset, spinning records, lights pulsing |
| grid | block furniture with `R.blockObj(obj)` or `R.block(x0,z0,x1,z1)`. Keep a walkable route between every door, the spawn and every slot. |
| `R.finish()` | call once at the end (merges `R.static` and the walls) |

Static meshes go in `R.static` (baked together). Anything that moves, flickers or gets edited goes in `R.live`
with `userData.live = true`. Budget in the preview: **roomCalls < 180** (the room alone incl. shadow pass + bloom; room-shot prints it; test characters are excluded), build < 300 ms, triangles < 400k. Use `InstancedMesh` for repeated small items (cans, books, game
boxes, bottles, LEDs). Room size about 9–11 × 7–8 units, walls 3.2 high (the roof can use a low parapet instead).

## Rules
- Only edit your own room file(s): `src/rooms/<id>.js` plus any helpers you create named `src/rooms/<id>-*.js`.
  Do **not** edit kit.js, kit-fx.js, tex.js, props-hand.js, stub.js, index.js, preview.js or anything outside
  `src/rooms/`; other builders are working in parallel. If the kit has a bug that blocks you, work around it in
  your own file and report it.
- No network at runtime, no new npm installs. Everything is code-generated (canvas textures, geometry).
- Your file must always build: run room-shot right after each edit.

## How to work (turns are about 10 minutes; giant single writes time out)
Write several small steps, one tool call each, and keep files under about 350 lines (split into
`<id>-props.js` and similar). Get a first version rendering in the preview by about your 3rd tool call, then
iterate on the screenshot: composition from the default camera, lighting mood, clutter and detail, Matrix touch,
silhouettes. Check `--rot=2` once (the other side of the room). Before finishing, run once with `--webkit`.

## Report (short)
Files, the room-shot line (calls, tris, buildMs), what's in the room, slots and interactables, any kit issues, and
what you'd polish next.

## v2 (owner feedback): one joined ground floor, much bigger rooms
The owner liked the rooms, but each one felt like a tiny box in the middle of the screen: too small for a crowd
(think 50 people online). He wants the earlier dollhouse feel: **rooms joined and visible together on one floor,
and you walk between them**. Some places can be separate floors (stairs).

**The building lives in `src/rooms/floorplan.js`**; read it. Summary:
- **Ground floor:** **bar** 18×12 at the back corner (its n and w walls are the building's outer back walls),
  **den** 13×12 to its east, **bedroom** 10×10 to its south. On screen it reads as a wide V. Rooms are joined by
  **open archways**: bar↔den on the shared e/w wall, bar↔bedroom on the shared s/n wall.
- **Roof** 20×14 and **Basement** 16×11 are their own floors, reached by **stairs**: bar ↔ roof and den ↔ basement.
- `roomInfo(id)` gives your room's size, floor, world position, archways, **exterior** walls and stairs.

**What changes in your room file**
1. Call `makeRoom({ id: '<yourId>', ... })` **without w/d**; the size comes from floorplan.js and the archways are
   added for you on the right walls (`R.passages`). **Remove old doors to rooms on the same floor.** Stairs: one
   door per entry in `roomInfo(id).stairs`, on an exterior back wall (n or w), using the entry's `to` and `label`
   (e.g. `{ side: 'n', at: 4, to: 'roof', label: '↑ The Roof' }`). Dress it as a stairwell (stairs going up or down
   visible through the door frame if you can).
2. **Interior (shared) walls get lowered** when the room on the other side is in focus, so nothing tall stands
   against them (bottle shelves, bookcases, server racks, the CRT cabinet go against exterior walls). On interior
   walls use only wall-mounted decor added via `R.onWall(...)`: it hides with the wall. Keep 1.5 m clear in front
   of each archway, both sides.
3. **Capacity.** Bigger rooms, many more places to be:
   - bar: 22–26 slots
   - den: 12–14
   - bedroom: 5–6 (it's yours; friends visit)
   - roof: 16–18
   - basement: 10–12

   Mix sitting (laptop / beer / controller) with **standing groups** (kind `stand`, anim `Idle`, prop beer/phone)
   around high tables, the pool table, the fire, the arcade. Leave real open floor for people walking around.
   Zones, not one furniture cluster: e.g. the bar gets the counter, a booth row, pool and darts, a small stage or
   DJ corner, and high-tops near the den archway.
4. **Lighting:** keep calling `lightRig(...)` as now. In-game your room's hemisphere/moon values become the floor's
   ambience while you're in the room, and your 4 points join a shared pool (the game lights the 8 lamps nearest the
   camera). Make the 4 points your key lamps; everything else that glows stays emissive, glow sprites and floor pools.
5. **Budget per room at the new size: roomCalls < 160** (three ground-floor rooms render together). Instance
   repeated things, let only big pieces cast shadows, and reuse materials.
6. `R.camera.zoom` around 6–7 for the bigger rooms (the game follows the player across the floor anyway).

**Preview the whole ground floor:** `node games/iso-rooms/tools/room-shot.mjs floor:main` (the three rooms at their
real positions; your neighbours may still be mid-rebuild). Single room still works: `room-shot.mjs <roomId>`.

### v2.1: joined building (owner: "not side by side, it should all be joined")
The ground floor is **one L-shaped building**, not separate boxes:
- bar: x -9..9, z -6..6
- den: x 9..22, z -6..6. It shares the bar's whole east wall, joined by a **5 m wide opening**.
- bedroom: x -9..1, z 6..14. It shares the west half of the bar's south wall, joined by a 2.4 m opening.

There are no gaps between rooms and one continuous slab under the floor (rooms on the joined floor skip their own).
**A shared wall is drawn by only one room**: `roomInfo(id).shared[side].draw` says whether yours draws it.
- The bar draws its shared east and south walls.
- The den skips its west wall, and the bedroom skips its north wall.
- **Never put decor on a wall you don't draw.**

Since the den and bar read as one continuous space, line up the look at the seam: the floor material can
change at the opening, which is fine and reads as a new zone.

## v3 (owner: "make the main floor a big rectangle, not an L"): two new rooms + new openings
The ground floor is now **one full rectangle, x -9..22, z -6..14 (31 x 20)**.

| Row | Room | Position | Size |
|---|---|---|---|
| Back | bar | x -9..9, z -6..6 | 18 x 12 |
| Back | den | x 9..22, z -6..6 | 13 x 12 |
| Front | bedroom | x -9..1, z 6..14 | 10 x 8 |
| Front | **kitchen** (new) | x 1..9, z 6..14 | 8 x 8 |
| Front | **studio** (new) | x 9..22, z 6..14 | 13 x 8 |

New openings, all from floorplan.js:

| Between | Wall | At | Width |
|---|---|---|---|
| bar ↔ kitchen | bar's s wall | world x 5 | 3.0 m |
| kitchen ↔ studio | shared wall | world z 10 | 2.6 m |
| den ↔ studio | den's s wall | world x 15.5 | 3.0 m |

The bedroom has no opening to the kitchen, since it's your private room entered from the bar.

**Who draws what:** run `roomInfo(id)` to see your openings, the shared walls (and whether you draw them) and
your exterior walls.
- The bar now draws its whole s wall (bedroom + kitchen side).
- The den draws its s wall (studio side).
- The kitchen draws its e wall; its n and w walls are drawn by the bar and the bedroom.
- The studio draws nothing on its n or w (den and kitchen draw them); s and e are its exterior front walls.

**Interior rooms have low walls:** in the cut-away view, walls between rooms are usually shown as low stubs, and
front walls are always cut down. So in the front-row rooms, **floor-standing furniture of any height is fine, but
never mount anything on a wall you don't draw** (no wall cabinets, shelves or posters there). Put tall pieces such
as a fridge or bookcase against walls as free-standing objects. Use lamps on stands, pendants and practical light
sources, since most walls aren't available for mounting.

**Preview the whole floor** (camera now matches the game's whole-floor view): `room-shot.mjs floor:main`.
**Budget for the two new rooms: roomCalls < 130 each** (the floor now renders five rooms together).

## v4 (owner: "expand the main floor 3x, every room something different, film references people recognise, some scary")
The ground floor is now **x -9..53, z -6..14..24 (62 x 30)**: the old five rooms plus **seven new rooms**, all in
`src/rooms/floorplan.js` (read it; `roomInfo('<id>')` gives your size, world position, openings, shared walls and
whether you draw them, and your exterior walls).

```
z -6..6   bar (-9..9) | den (9..22) | screening (22..38) | diner (38..53)
z  6..14  bedroom (-9..1) | kitchen (1..9) | studio (9..22) | library (22..38) | garage (38..53)
z 14..24  overlook (-9..13) | hawkins (13..31) | biolab (31..53)          <- the front row: the scary rooms
```
Openings are automatic (makeRoom({ id }) with NO w/d). A wall you don't draw (roomInfo shared[side].draw === false)
is drawn by your neighbour: **never mount anything on it**; put free-standing furniture there instead. Keep 1.5 m clear
in front of every opening on your side. The front walls (s / e) are cut down by the camera: tall things go along n / w.

**Film references (the owner's ask):** each room has 2-4 references people instantly recognise ("hey, that's from X!"),
at least one of them CLICKABLE (E) with a fun reaction or a small activity, the way Neo asleep at the desk + the
"Wake up, Neo" terminal works (see src/act/films-a*.js for that example, src/act/films-b*.js for small props + E
reactions). Homage only: short quotes (< 10 words), no logos, no real actor likenesses claimed, parody names are fine.
Scary rooms are spooky and atmospheric with a small jump-scare at most: no gore.

**Budgets now that 12 rooms share the floor:** roomCalls < 110 for a new room (room-shot prints it), exactly 4 point
lights via lightRig (the game pools lights; use emissive + glow sprites + floor pools for the rest), at most 2 fixed
characters (Avatar) per room, instancing for repeated things, only big pieces cast shadows.

**Your files (strict):** `src/rooms/<id>.js` + `src/rooms/<id>-*.js` + `src/act/<id>.js` (export default an ARRAY of
activities; already imported by act/index.js) + `src/act/<id>-*.js`. Activities: read `ACT-BRIEF.md` (overlay,
view close-ups, sit-to-activity, util, act-shot tool). Never edit other files; report needed framework changes.

## v5 (owner: "double it, to the left, one square... hackers, fight club, inception, a computer room, WoW-inspired; interactive objects PROPERLY done, not press E to say hi")
The ground floor is now **one 62 x 62 square, x -9..53, z -6..56**. The south wing (lower-left on screen) holds five
new rooms, already in `src/rooms/floorplan.js` with their openings (placeholders exist; replace them):

```
z 24..38  hackers (-9..13, 22x14) | computer (13..31, 18x14) | fightclub (31..53, 22x14)
z 38..56  inception (-9..21, 30x18) | tavern (21..53, 32x18)
```
Same rules as v4 (roomInfo, openings automatic via makeRoom({ id }), never mount on a wall you don't draw, 1.5 m clear
in front of openings, tall things along n / w, homage only, short quotes < 10 words, no logos / real likenesses / gore).

**The bar for interactions is higher now.** Each room needs **at least 3 real activities** (an overlay mini-game, a
readable close-up you DO something in, or a sit-to-activity), each with a goal, feedback and a reason to come back
(score / best saved in localStorage with try/catch, a daily variation from the date, or coins via `coins(S)`).
On top of that, 3+ small in-world E reactions (prop animates, sound-free visual gag, bubble with a film line).
"Press E, see a bubble" is NOT an activity. Test every activity with the act-shot tool and look at the shot.

**Readable, not dark:** the owner keeps saying rooms are too dark. Floors and furniture must read clearly at the
default zoom (compare with shots/overlook.png brightness): light-coloured floor textures, emissive accents, additive
floor glow pools; still exactly 4 point lights via lightRig.

**Budgets:** roomCalls < 110 (hackers, computer, fightclub) and < 140 (inception, tavern, which are bigger); <= 2 fixed
Avatars; instancing for repeats; member seats (slots) for 8-14 members so the room feels lived in.
