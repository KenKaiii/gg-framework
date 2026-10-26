# Mini-game style: the real deal

Owner: "We have good graphics in the game, then they go in the mini-game and it looks like shit. Make them all
actually worth playing. I'm not after GTA 6, but the fonts, the graphics in them are bland and basic. Up all of it."
And: "I want to expand on more mini-games shortly", so every game must be built from the shared kit, not one-offs.

## The kit (read it first)
- `src/act/art.js`: backdrops (`bg.vignette`, `bg.room`), framed `panel` (wood / metal / paper / neon / glass / felt / crt),
  stat `badge`, bevelled `button`, animated `banner` (results), `title` (outlined Alagard), `glow`, `noise`, `shine`,
  `coin`, `particles()` (burst / sparkle / confetti), `shaker()`, `ease`, `PAL` colours.
- `src/act/util.js`: `text`, `loop`, `keys`, `coins`, `mouse` (hover / click areas), `scroller` (smooth lists).
- Reference: `src/act/inception-totem.js` (rebuilt with the kit) + `src/rooms/inception-props.js` `topTable` / `spinTop`
  (3D props rebuilt properly: lathe profiles, bevels, real materials). Copy that level.

## The bar every game must clear
1. **No flat boxes, no default grey.** Every surface is a kit panel or a drawn scene: gradient + bevel + texture +
   shadow. Backgrounds are a lit scene (`bg.room` / `bg.vignette` / a themed drawing), never a flat fill.
2. **Themed to its room and film/game.** The diner menu is a laminated diner menu with chrome trim; the pool HUD is
   felt and brass; Hackers is neon; Fight Club is grimy cardboard and duct tape; the tavern is parchment and wood;
   Prompt School is a CRT. Draw the theme (props, icons, textures), don't just tint it.
3. **Juice.** Every action has feedback: hover glow on anything clickable, a press animation, a sound, particles on
   a win / coin, a screen shake on a hit or fail, numbers that count up instead of jumping, a `banner` on results.
   Idle things breathe (slow pulses, nothing that flickers faster than 1.5 s).
4. **Typography.** Alagard (`title()`) for titles and big numbers, m5x7 for everything else; 16 px multiples only;
   always outlined or on a panel so it's readable on any background. No tiny grey text on dark grey.
5. **Clear start and end.** A short title card with how to play (one or two lines, the controls as key chips AND the
   mouse), then the game, then a result card with the score, the best, and Play again / Leave buttons.
6. **Mouse and keyboard both work** (already wired: keep it), buttons drawn with `button()` and registered with `mouse()`.
7. **3D close-ups (games that use `setView`)**: frame the subject big and centred; hide anyone between the camera and
   the subject (other people, the player: see the totem); upgrade crude props in that close-up (they're seen up close
   now): lathe / bevelled shapes, real materials, small details. Keep draw calls low: merge or reuse materials.
8. **Performance.** One canvas, redraw per frame is fine; no per-frame allocations of big gradients you can cache
   (cache backgrounds on an offscreen canvas when static); 60 fps on a MacBook Air.
9. **Don't change the rules** (scores, odds, rewards) unless something is broken; this is a presentation pass.

## How to check
`node packages/gg-world/build.mjs`, then open it with Playwright over http (not file://):
`window.__openAct('<activity id>')`, screenshots at 2x of the start card, mid-game and the result card; look at them.
`window.__actIds()` lists every activity id.
