# Night Rooms: interactive world brief (activities, close-ups, film easter eggs)

## What we're building
Night Rooms is an isometric social hangout inside a coding-agent app. Vibe coders' characters hang out while they
code. It's a cozy, grungy-but-warm night world with subtle Matrix touches. The ground floor is one house: bar, den,
bedroom (the player's), kitchen and studio. The roof and basement are other floors.

The owner wants the world **alive and interactive**, so that objects are things you can do something with:
- Go to the pool table and play a simple game of **8-ball**, from a bird's-eye view of the table.
- Look at a monitor and get a **close-up you can read**. Sit on the sofa and you actually **watch the TV**.
- Play **pinball**. Order at the bar from a **2-page menu**.
- Add **film references people know**, brought to life. For example, the "wake up, Neo" terminal also has
  **Neo asleep at the desk**.

Everything must keep the look: dark, warm, night, cozy-grungy; green phosphor (#6ee7a0 / #3ddc84), amber
(#e0a458 / #ffb36b), plum and indigo (#2a2440 / #1e2240), magenta neon (#ff4fd8) used sparingly. The tone is adult
dev humour, with mild swearing fine. No slurs, no sexual content, nothing hateful.

## Fonts (owner's request, from his GG Royale game)
Use only these, already loaded by `src/fonts.js` (pixel fonts, crisp only at multiples of 16 px):
- **m5x7** (Daniel Linssen, CC0) for all body text, menus, labels and numbers: `FONT.body` in CSS, `CFONT.body(16)`
  on canvas.
- **Alagard** (Hewett Tsoi, free with credit) for titles, names and big headings: `FONT.title`, `CFONT.title(16|32)`.
- `act/util.js` → `text(ctx2d, str, x, y, { size: 16|32|48, title?, color, align, shadow })` draws crisp pixel text.
- On canvas, disable smoothing for pixel art (`x.imageSmoothingEnabled = false`). Overlay canvases are shown
  scaled up with `image-rendering: pixelated`, so draw at a low internal resolution (e.g. 320×180 or 480×270) and
  let the overlay scale it up.

## Framework (already in the game; read these files)
Game folder: `/Users/kenkai/.gg/goals/gaming/showcase/games/iso-rooms/`, code in `src/`.

**`src/act/registry.js`**: pressing E near an interactable calls `tryStart(it, R)`. The first activity whose
`match(it, R)` returns true starts. While it runs, world input is blocked, the HUD fades out, and Esc ends it.

An **activity** is `{ id, label?, match(it, R), start(ctx) }`.
- `ctx = { S, U, it, R, api: { toast, bubble }, done(), overlay(opts) }`.
- `ctx.overlay({ title, sub, help })` opens a full-screen overlay (`src/act/overlay.js`). It returns `ov` with:
  - `ov.canvas(w, h)` gives `{ c, x }`: a pixel canvas, auto-scaled.
  - `ov.stage` (an HTML container), plus `ov.setHelp(html)`, `ov.setSub(text)`, `ov.onClose(fn)`, `ov.close()`.
- Esc or the "leave" button closes the overlay and calls `done()` for you. If an activity has no overlay (in-world
  only), call `ctx.done()` yourself and handle Esc.
- `src/act/util.js` provides `text()`, `coins(S)` (same wallet as the wardrobe: `.balance`, `.spend(n)`), `rng()`,
  `keys(ov)` (key set) and `loop(ov, (dt, t) => ...)` (a rAF loop that stops on close).

**`src/act/view.js`**: camera close-ups in the 3D world.
- `setView(S, { target, dir, up?, zoom })` blends the camera to look at `target` from direction `dir`. `zoom` is half
  the visible height in world units: about 1.5 for one table, 1.2 for a TV.
- `clearView(S)` blends back. **Always call it on exit** (put it in `ov.onClose` or before `done()`).
- `hideOccluders(S)` drops every wall to its stub while the view is on.
- `worldOf(R, x, y, z)` converts room-local to world coordinates.
- Straight down: `dir {0, 1, 0.001}` with `up {1, 0, 0}` (tested: a bird's-eye of the bar pool table looks great).
  Over the shoulder: e.g. `dir {0.9, 0.35, 0.3}`.

**`src/act/extras.js`**: add props, characters, hotspots and seat activities **without editing room files**. Your
`act/extras-<you>.js` exports `default { id, install(ctx) }` with `ctx = { A, rooms, scene, renderer, THREE }`.
- Add moving or interactive meshes to `rooms[id].live`.
- Push hotspots into `rooms[id].interact` as `{ id, x, z, r, label, kind }`. These are room-local; `r` is the
  reach radius.
- Tag seats with `slot.act = '<activityId>'` and `slot.actLabel`. Members never take those seats; the player sees
  "E Watch TV" and the activity starts.
- Block floor for new furniture with `rooms[id].block(x0, z0, x1, z1)`. Remove member slots by filtering
  `rooms[id].slots`.
- Return `tick(t, dt, S)` for animation.
- Seat items arrive at `match` as `{ kind: 'seat', act, slot, id, x, z }`. `src/act/sit.js` →
  `sitPlayer(S, R, slot)` sits the player and returns a stand-up function.

**Characters**: `import { Avatar } from '../avatar.js'`, then `new Avatar(A, look)`.
- `look` is `{ body: 'rogue'|'knight'|'mage'|'barbarian', head: same or 'hooded', skin, hair, top, bottom, acc:
  'none'|'glasses'|'headphones'|'fur', accColor, silly?: ['shades','coat','cone',...] }`.
- `av.root` goes into `rooms[id].live`. Call `av.play('Sit_Chair_Idle' | 'Sit_Floor_Idle' | 'Idle' | 'Cheer' |
  'Interact' | ...)` and `av.update(dt)` every tick.
- Procedural layers: `av.fx.type = 1` (typing), `av.fx.think = 1`, and `av.bone('head')` for extra poses (e.g. head
  down on the desk asleep: rotate the head and chest bones forward a little every frame after `update`).
- Props in hand: `attachProp(av, 'laptop'|'beer'|'cocktail'|'controller'|'phone'|'mug')` from
  `src/rooms/props-hand.js`.

**Room look and geometry**: rooms are built with `src/rooms/kit.js` (`mat`, `glowMat`, `rbox`, `put`, `mesh`),
`kit-fx.js` (`glow` sprites, `steam`, `flicker`) and `tex.js` (canvas textures, `label`, `neon`, `termScreen`,
`codeScreen`, `gameScreen`). Room-local coordinates and the slot/interactable lists are in each room file
(`src/rooms/<room>.js`, `bar-layout.js`, etc.). Read them before placing anything. Floor y = 0, characters are about
1.9 units tall, and counter height is about 1.05.

## Your files (strict ownership: edit ONLY these)
- `src/act/<you>.js` exports `default` = an **array** of activities. It's already imported by `act/index.js`.
- `src/act/<you>-*.js`: any helper modules you need.
- `src/act/extras-<you>.js`: world props, hotspots and seat tags (already imported by `act/extras.js`).

Never edit `src/rooms/*`, `main.js`, `night-ui.js`, `ui.css.js`, `registry.js`, `overlay.js`, `view.js`, `util.js`,
`extras.js` or `index.js`. If you need a framework change, write it in your report and the coordinator will make it.

## Test tools (run from `/Users/kenkai/.gg/goals/gaming/showcase`)
- `node games/iso-rooms/tools/act-shot.mjs <activityId | roomId:interactableId> [--keys=Space,ArrowLeft,hold:Space;600,click:640;360,type:hi] [--wait=1500] [--out=name] [--webkit]`
  builds the game, opens your activity directly (no walking), presses keys, and saves
  `games/iso-rooms/shots/act-<out>.png`. Exit 1 on page errors. **Open the PNGs with the read tool and judge them
  like an art director and a player.**
- `node tools/check.mjs iso-rooms` is the full game smoke test (Chromium + WebKit, fps, errors). It must keep passing.
- Room preview with your extras is not available; use act-shot and look at the world behind the overlay, or set a
  view.

## Quality bar and performance
- Feels like a real little game: clear goal, juicy feedback (sounds aren't available, so use visual juice: shake,
  flashes, particles, numbers popping), and readable at a glance.
- 60 fps. Overlay canvases render at low internal resolution. In-world extras add very few draw calls (merge or
  instance, under ~25 per module) and no new lights (use glow sprites, emissive and additive planes).
- Close/Esc always restores everything: view, HUD, player standing, and props removed.
- Adult humour, film references with **short** quotes only (under ~10 words), homage props, no copyrighted images
  or logos.

## Report back
Files, what each activity does and how to trigger it in-game (room + what to press), act-shot commands you ran and
what the PNGs showed, check.mjs result lines, and anything left or any framework request.
