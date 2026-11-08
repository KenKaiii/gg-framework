# Build sheet

Everything needed to write a composition with the move kit and to score it,
in one place. It is the complete public surface: you do not need to open
`moves.js`, `score-synth.mjs` or any helper's `--help` to use them.

## Move kit (`window.GGMotionKit`)

Install with `<node> "<motion bin>/library.mjs" kit <project>`, load
`assets/kit/moves.js` after GSAP, then `const kit = window.GGMotionKit;`.
Every move adds tweens to `tl` from time `at` and returns the time of its key
moment, so the next move can start from it. Options are all optional; the
value after `=` is the default.

### Arrivals

| Call                         | Options                                                                                                       | Returns                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `liftWords(tl, el, at, o)`   | `stagger=0.07`, `spring="snappy"`, `duration`, `from=115` (start yPercent)                                    | when the last word has mostly risen |
| `dropLetters(tl, el, at, o)` | `height=260`, `fall=0.38`, `stagger=0.05`, `squash=0.24`, `spring="bouncy"`                                   | the last landing                    |
| `reveal(tl, el, at, o)`      | `from="bottom"` (top, bottom, left, right), `duration=0.8`, `ease="snap"`                                     | end                                 |
| `typewrite(tl, el, at, o)`   | `text` (default the element's text), `cps=22`, `jitter=0.4`, `seed=11`, `caret="▍"` or `false`, `caretHold=0` | when typing ends                    |
| `tick(tl, path, at, o)`      | `duration=0.34`, `ease="snap"` (an SVG path)                                                                  | end                                 |
| `pop(tl, el, at, o)`         | `from=0.3` (start scale), `spring="bouncy"`                                                                   | when it reads as arrived            |
| `stamp(tl, el, at, o)`       | `duration=0.2`, `rotate=-4`, `from=2.4`                                                                       | the contact                         |

### Handoffs

| Call                               | Options                                                                                                              | Returns               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `reshape(tl, el, at, to, o)`       | `to` is `{ x, y, w, h, r }` or an element; `duration=0.85`, `ease="travel"`, or `spring`                             | when the change reads |
| `openFrom(tl, stage, at, o)`       | `x`, `y` (default the centre), `width=1920`, `height=1080`, `from=0`, `duration=0.9`, `ease="travel"`                | end                   |
| `diveThrough(tl, layer, at, o)`    | `x=960`, `y=540`, `zoom=16`, `duration=1`, `ease="drop"`, `next` (element shown at the end)                          | end                   |
| `converge(tl, els, at, target, o)` | `target` is `{ x, y }`; `duration=0.85`, `stagger=0.05`, `bow=0.28`, `shrink=0.12`, `seed=5`, `ease="drop"`, `space` | the last arrival      |

`converge` and `hop` own the element's transform: wrap an element to also
pop or move it.

**What each move animates**, so two moves on one element never fight:
`liftWords` yPercent of its word spans; `dropLetters` y, scaleX, scaleY and
opacity of its letters; `reveal` and `openFrom` clip-path; `tick`
stroke-dashoffset; `pop` scale and opacity; `stamp` scale, rotation and
opacity; `reshape` left, top, width, height and border-radius (position the
element absolutely); `diveThrough` the layer's scale and the `next`
element's visibility; `knock` rotation; `impact` the shake layer's x and
rotation; `converge`, `hop` and `cursorPath` write `style.transform`
directly. `typewrite` changes only the text.

### Contact

| Call                    | Options                                                                                                    | Returns          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| `hop(tl, el, at, o)`    | `height=140`, `duration=0.5` (air time), `squash=0.2`                                                      | the landing      |
| `impact(tl, at, o)`     | `shake` (a layer, not the camera world), `amount=16`, `duration=0.6`, `split: [left, right]`, `spread=140` | `at`             |
| `knock(tl, els, at, o)` | `push=48`, `gap=0.11`, `tilt=7`, `axis="x"` or `"y"`                                                       | the last contact |

### Camera

`const cam = kit.camera(tl, world, keys, o)` drives `world`, a layer holding
the whole scene in world pixels. It returns `{ plan, at(t), toScreen(t, x, y) }`.
Make `world` an absolutely positioned element at left 0, top 0 (any size;
place scenes inside it at their world coordinates). The camera owns its
transform and sets its transform-origin to 0 0: never animate `world`
yourself; move things inside it. A key's `x, y` is the world point shown at
the centre of the frame, so `{ x: 960, y: 540, zoom: 1 }` shows the first
1920 × 1080 of the world unchanged.

- **Keys**: `[{ x, y, zoom=1, rotate=0 }, { at, x, y, zoom, rotate, move, duration }, ...]`.
  The first key is the start. `move` is a curve name (`whip` by default,
  `glide` for slow pushes, `cut` for a jump); `duration=0.9`.
- **Options**: `width=1920`, `height=1080`, `duration` (default the last move),
  `lead` (seconds each move starts early), `handheld: { amp=6, rotate=0.2, rate=0.5, seed=7 }`,
  `rests: [[from, to], ...]` (exactly still there), `shakes: [{ at, amount=14, decay=9 }]`,
  `layers: [{ el, depth }]` (0 pinned, 0.5 far, 1 the world, above 1 near).
- Pure helpers: `cameraAt(plan, t, o)`, `atDepth(cam, depth)`, `toScreen(cam, x, y)`.

### Deep zoom, light, texture

| Call                                | Options                                                                                                                                                                                                                                              | Returns                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `deepZoom(tl, world, at, o)`        | `anchor={x,y}` (world point, default the centre), `from=1`, `to=100` (any factor, up to about 1000), `screenFrom`, `screenTo` (where the anchor sits on screen; default the centre), `duration=3`, `ease="glide"`, `width`, `height`                 | end                         |
| `lightGround(tl, el, at, o)`        | `rise=0.9`, `hold=0.6`, `drain=0.9`, `x`, `y` (default below the frame), `reach=1.15`, `color` (an `r, g, b` string), `ease="glide"`; on a canvas it paints, on other elements it sets `--light`, `--light-r`, `--light-x`, `--light-y` (with units) | the flood                   |
| `rings(tl, el, at, o)`              | `count=4`, `duration=1.2`, `stagger=0.14`, `x`, `y` (default the centre), `ease="snap"`; reveals `el` (the next scene) through expanding rings                                                                                                       | fully shown                 |
| `silk(tl, canvas, at, duration, o)` | `colors` (two or more hex), `seed=1`, `speed=0.08`, `scale=2.2`, `warp=1.2`, `cols=64`, `rows`                                                                                                                                                       | end                         |
| `belt(tl, items, at, o)`            | `speed=240` (px/s), `stop` (timeline time it comes to rest), `spacing=360`, `axis="x"`, `direction=-1`, `rampIn=0.6`, `rampOut=0.9`, `origin`, `wrap`                                                                                                | `{ stop, at(t), clock(t) }` |
| `brushStroke(tl, canvas, at, o)`    | `path` (SVG path) or `points`, `width=28`, `bristles=48`, `dryness=0.65`, `color`, `duration=0.8`, `seed=3`, `ease`                                                                                                                                  | when the brush lifts        |
| `grain(el, o)`                      | `amount=0.05`, `seed=9`, `size=128`; a fixed overlay so dark gradients do not band; identical on every frame                                                                                                                                         | the tile's data URL         |

### Print look (riso, screen print)

| Call                             | Options                                                                                                                                                                                                                 | Returns              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `printInk(el, o)`                | `offset={x:0,y:0}` (fixed misregistration), `cell=7` (halftone spacing px), `angle=15`, `amount=0.86` (ink coverage), `rough=0.18`, `seed=3`; sets multiply blending and a halftone mask, so overlapping inks overprint | the tile's data URL  |
| `misregister(tl, layers, at, o)` | `distance=26` px (or `from: [{x,y}, ...]`, one per layer), `seed=11`, `spring="soft"` or `ease` with `duration=0.8`, `apart=false` (true drifts apart instead of settling)                                              | when the inks settle |
| `paperTexture(el, o)`            | `size=256`, `amount=0.06`, `tint="#fdf8ee"`, `fibres=160`, `seed=5`; identical on every frame                                                                                                                           | the tile's data URL  |

Give each ink its own layer (one flat colour per layer, e.g. fluorescent pink
and blue), lay them over paper, and let them settle into register on the beat.
`printInk` uses the element's `mask-image` and `translate`. Pure helpers:
`halftoneTile`, `misregisterAt`, `paperTile`.

`deepZoom` owns `world`'s transform like the camera does: a dive or pull-out
keeps its anchor exactly where it is keyed on screen at any depth. Pure
helpers: `deepZoomAt`, `lightLevel`, `ringsAt`, `silkField`, `beltAt`,
`grainTile`.

### Cursor

`const { end, presses } = kit.cursorPath(tl, cursor, at, stops, o)`. Stops are
`{ x, y }` or `{ el }`, each with optional `click: true`, `hold=0.15` and
`duration`. Options: `speed=1500` (px/s), `press=0.09`, `release=0.26`,
`bow=0.12`, `tip=[6, 4]` (the hotspot), `space`. Script each pressed state and
its sound from `presses`.

### Sound

`kit.cue(tl, at, sfx, { gain=1, x, pan, send, name })` marks a sound where the
event happens. `x` is the object's screen x and pans with it; `pan` (-1..1)
overrides it; `send` (0..1) is its distance. Then run
`<node> "<motion bin>/cues.mjs" <project>`.

### Timing and helpers

- **Springs** (`spring` options): `snappy`, `bouncy`, `soft`, `heavy`, `whip`.
  `kit.springEase(name)` gives a GSAP ease; `kit.settleTime(name)` gives its length.
- **Curves** (`ease` and `move`): `snap`, `drop`, `glide`, `travel`, `whip`,
  `settle`, `bounce`, `firm`, `cut`.
- `drive(tl, at, duration, draw)`: calls `draw(localTime)` every frame, seeks
  included; draw anything (counters, canvas, SVG) as a pure function of time.
- `split(el, "words" | "chars", { mask })` returns spans; `centerOf(el, space)`
  and `rectOf(el, space)` measure layout without transforms; `rng(seed)` and
  `noise(seed, t)` are seeded.

## Score (`score.json` for `score-synth.mjs`)

Run `<node> "<motion bin>/score-synth.mjs" score.json assets/audio`. It writes
`music.wav`, `sfx.wav` and `tempo-map.json` (beats, bars, hits, merges,
balance) in under a second.

```json
{
  "bpm": 84,
  "duration": 24,
  "seed": 3,
  "style": "lofi",
  "key": "F",
  "scale": "major",
  "chords": ["Fmaj7", "Em7", "Dm7", "Cmaj7"],
  "sections": [
    { "name": "intro", "from": 0, "energy": 0.3 },
    { "name": "groove", "from": 2.9, "energy": 0.7 }
  ],
  "hits": [
    { "t": 3.0, "sfx": "tap" },
    { "beat": 8, "sfx": "chime" },
    { "bar": 4, "sfx": "impact" }
  ],
  "cues": "cues.json",
  "room": "room",
  "duck": 0.55,
  "ending": "resolve",
  "air": true,
  "music": true
}
```

- **bpm** 40–220; **duration** in seconds; **seed** any integer.
- **style**: `pulse` (four on the floor), `cinematic` (swells and low hits),
  `minimal` (sparse keys), `lofi` (swung eighths, dusty keys, round bass,
  soft kit, vinyl and tape wobble).
- **key** and **scale** (`major` or `minor`) pick default chords; `chords`
  overrides them.
- **sections**: energy 0–1 brings parts in. In `lofi`: keys and vinyl alone
  below 0.25, kick and snare from 0.25, hats from 0.4, the full kit from 0.5.
- **hits**: `t` (seconds), `beat` or `bar`, `sfx`, optional `gain` (0–2),
  `pan`, `send`, `name`. Sounds: `tap`, `press`, `knock`, `chime`, `thud`,
  `plip`, `paper`, `breath`, `click`, `tick`, `snap`, `pop`, `glitch`,
  `whoosh`, `whoosh-short`, `riser`, `swell`, `impact`, `sub-drop`, `sting`,
  `shimmer`, `typing`.
- **cues**: the file `cues.mjs` exported; its hits and camera air join these.
- **room**: `none`, `booth`, `room`, `hall`. **duck**: music level under the
  heaviest hit (1 = none). **ending**: `resolve` or `cut`. **air**: camera air
  on or off. **music**: false for effects only.

## Licensed or supplied music

To cut a track the user supplies to the picture instead of synthesising one:
`<node> "<motion bin>/music-fit.mjs" <track> --duration <s> [--land <trackTime>@<filmTime>] [--out assets/audio]`.
It finds the tempo and downbeats, cuts whole bars on downbeats with short
crossfades so the length is exact, lands the chosen downbeat (`--land`, snapped
to the nearest one) on a film time, and writes `music.wav` plus
`music-fit.json` with the downbeats in film time. Put hits on those downbeats.
Constant tempo and 4/4 only.

## Tall frame (1080 × 1920)

Fill the frame and go big. The feeds cover only a bar over the top 138 px, a
caption over the bottom 422 px and buttons over the right 179 px from y 840
down; keep words out from under those.

## Render

| Step            | Command                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Final with blur | `<node> "<motion bin>/motion-blur.mjs" <project> renders/<name>-v1.mp4` (the one render, at feed loudness; run it in the background) |
| Stills          | `<node> "<motion bin>/hyperframes.mjs" snapshot <project> --at 1,4,8,12 --describe false` (several at once)                          |
