# GX rebuild: every mini-game, properly done

The owner: "Everything needs a redesign. Clean, properly done versions, not this pixelated nonsense." He approved the
concepts in `/Users/kenkai/.gg/goals/gaming/showcase/minigames/` (open `index.html`; the six `concepts/*.html` are the
bar). The reference conversion IN THE GAME is `src/act/barmenu-darts.js` (read it first, copy its pattern).

## What changes, what doesn't
- REBUILD the look entirely: no `ov.canvas(320,180)` / `ov.canvas(480,270)` pixel canvases, no `art.js` pixel
  panels/badges/banners/title(), no m5x7 or Alagard text, no `PAL` pixel palette, no `keyChip`. Text is Sora.
- KEEP the rules, rewards, coins, saved keys (`localStorage` keys stay exactly the same), activity ids, `match`
  functions, labels, and keyboard + mouse controls. Escape still closes (registry handles it).
- The game opens out of the object: the registry already leans the camera onto the object and adds `.lean` to the
  overlay; the world stays visible around the game. Don't paint a full-screen background over it. If an activity
  sets its own close-up (`setView`), keep it.

## The kit: `src/act/gx.js`
```js
import { gx, svg, GX, keys, countUp } from './gx.js';
const ov = ctx.overlay({ title, sub, help: '<kbd>mouse</kbd> aim <kbd>space</kbd> throw' }); // no <kbd>esc</kbd>: the leave button exists
const K = gx(ov);
const hud = K.hud([{ id: 'score', label: 'Score' }, { id: 'best', label: 'Best', value: best(), tone: 'gold' }], [{ id: 'turn', label: 'Turn', value: '1 / 5' }]);
hud.set('score', 120, { count: true });         // tones: gold, up, bad, cool, teal, pink
const scene = K.scene({ aspect: 16 / 9 });       // the object's box (fits between HUD and dock, resizes); put SVG/DOM in it
K.card({ title: 'Darts', text: 'One line.', how: [[['Mouse'], 'aim'], [['Click', 'Space'], 'throw']], cta: 'Throw', onGo });
K.result({ title: 'Round over', big: 87, best: isNewBest, line: 'Solid round.', stats: [[87, 'Best'], ['+4', 'Coins']], again: 'Throw again', onAgain });
K.pop(clientX, clientY, '+60', 'gold');          // floating feedback at a screen point
K.swell();                                       // the room light swells (big hit / win)
svg('circle', { r: 10, fill: GX.lamp }, parentEl) // SVG element helper
```
GX colours: app tokens (`GX.text`, `GX.s1/s2/s3`, `GX.primary`, `GX.success`, `GX.warning`, `GX.error`, `GX.key`) +
the world's light (`GX.lamp`, `GX.lampDeep`, `GX.pink`, `GX.teal`, `GX.violet`). Sounds: `SFX.play('ui.select' |
'ui.tap' | 'win' | 'ui.deny' | 'card.flip' | 'ball.clack' | ...)` (see `src/sfx.js`).

## How it should look (the bar)
1. The real object, close up, drawn at screen resolution (SVG preferred; DOM; or a canvas sized to its CSS box x
   devicePixelRatio, never a small canvas stretched). Real materials: wood grain, felt, brushed metal, glass, paper,
   via SVG gradients/filters (feTurbulence for grain), soft shadows. Lit like its room: a warm key light from above
   (`GX.lamp`), the room's neon as a rim where it has neon.
2. Around it, the app's UI from the kit: HUD plates, start card, result card, key chips, buttons. No custom pixel
   chrome. One start card -> play -> one result card (where the game has an end).
3. Feedback: hits pop numbers (`K.pop`), big moments `K.swell()`, things press/move when used (keys depress, cards
   lift, darts wobble). Nothing flickers faster than a 1.5 s cycle. Respect `prefers-reduced-motion`.
4. Retro only where the subject is retro (an arcade game's picture, a CRT's picture, the joke 90s OS). Then: the
   picture stays pixel art but CRISP (integer or >=4x scale, smoothing off only for it) inside a beautifully made
   modern machine; all text around it is Sora.
5. Performance: one `requestAnimationFrame` loop at most per game (or `loop()` from util.js), no per-frame
   gradient/filter rebuilds, SVG built once and only attributes updated. 60 fps.

## How to check your work
- Build: `cd /Users/kenkai/Documents/UnstableMind/gg-coder && node packages/gg-world/build.mjs` (after every file).
- Screenshot in the real game: `node /tmp/gxshot.mjs <activity-id> 1440x810 "<optional js to run after start>"`
  writes `/tmp/gx/<id>-1440-start.png` (start card over the world) and `-play.png` (after Enter + your js), and
  prints page errors. Also run it at `900x560`. VIEW the screenshots. Activity ids: `window.__actIds()` (or grep
  `id: '` in the file). Example: `node /tmp/gxshot.mjs bar-darts 1440x810`.
- Escape must still close; mouse and keyboard must both work; no page errors.
- Do not touch files outside your list (other builders work in parallel). Don't run git (no commit/stash/branch).
