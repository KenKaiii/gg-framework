# Sound + interactions brief (all rooms)

Owner: "generated sound effects for everything we interact with, subtle footsteps, nothing loud or annoying, related to
what it is, and in whatever pops up too: a sound for everything, across the board." Also: "objects being interactive:
a couch, we can't even sit on it. So many things are missing for interactions."

## Already done globally (coordinator)
- `src/sfx.js`: synthesised WebAudio sounds (no files). `SFX.play(name, { vol, pitch, at: worldPos, delay, jitter })`.
  ~107 named sounds: run `__sfx.list()` in the console or read sfx.js. Categories: ui.* (hover, click, tap, open, close,
  toast, deny, send, type, select, back), rewards (coin, buy, success, win, fail, levelup, score, tick, countdown, go),
  body (sit, stand, cushion, whoosh, swoosh, thud, punch, block, grunt), bar/home (glass, pour, fizz, can, menu, paper,
  page, door, fridge, microwave, espresso, register), tech (pc.boot, crt.on/off, static, beep, blip, key, typewriter,
  typewriter.ding, arcade.coin/shoot/boom/jump, laser, zap, hum, ping, dial, phone.pickup/ring, radio), games (cue,
  ball.clack/pocket/cushion, flipper, bumper, dart, dice, cards, card.flip, shuffle, chess), atmosphere (vinyl, chord,
  fire, engine, thunder, clock, chime, magic, eerie, sting, heartbeat, horn, splash, gurgle, snap, squeak, rattle, creak,
  meow, woof, bubble, wind), steps (step.wood/tile/carpet/concrete/metal/marble/grass).
- Room-specific sounds: `SFX.define('room.thing', (out, t, p, K) => { K.tone(out, t, {type, f, f1, v, a, d}); K.hiss(out, t, {ft, f, f1, q, v, a, d}); K.bell(out, t, {f, ratio, idx, v, d}); })`
  in YOUR files (define at module load). Keep v <= 0.3 per voice, decays short, nothing shrill or long.
- Automatic: footsteps per room surface; hover tick; clicks; overlay open/close; toasts; coins(S).spend (earn = coin,
  spend = buy, refused = deny); sitting/standing; and when an activity STARTS or a room reaction (R.onInteract) fires,
  `SFX.forItem(it)` plays a keyword-guessed sound. Override per interactable: `it.sfx = 'name'` (or `false` to silence the
  default and play your own in code), per activity: `sfx: 'name' | false` on the activity object.
- Mouse: every R.interact entry and every free seat slot (anim 'Sit_*', no .act) is hoverable (glow + label) and
  clickable (the player runs over, then uses it). E still works. Members are click-only (profile).

## Your job, for every room you own
1. SOUND EVERYTHING INSIDE ACTIVITIES: every overlay/minigame event gets a fitting sound. Menu moves (ui.select),
   back (ui.back), confirm, each key press where it's an input (key/typewriter), hits/misses, scoring, combos,
   timers (tick/countdown), win/lose (win/fail/success), reveals (sparkle/magic), card plays, dice, balls, punches, etc.
   In-world activities (close-ups, sit-to-watch): sounds for what happens (TV channel change = static + blip, etc.).
   Use `at:` with the object's world position for in-world sounds so they pan/fade. Don't double up with the automatic
   ones (open/close/coins are already played).
2. SOUND EVERY ROOM REACTION (R.onInteract): replace the generic guess with the right sound(s), timed to the animation
   (e.g. waffle pops: pop, then a soft thud on landing; amber: magic; jukebox: vinyl then chord).
3. MISSING INTERACTIONS: walk each room (room-shot + reading the build code). Every sofa, armchair, chair, stool, bench,
   bed, beanbag and booth seat should have free sit slots (kind: 'sofa'|'chair'|..., anim 'Sit_Chair_Idle' or
   'Sit_Floor_Idle', correct x/z/face/y so the character sits ON it, facing out). Not all seats need to be free of members:
   keep members' homes, but make sure every piece of seating has at least one seat a player can take. Every prominent
   prop that does nothing (a big lamp, a plant, a poster, a machine, a shelf...) gets a hotspot in R.interact with a small
   visual reaction + a fitting sound (and a short funny line where it suits). Keep labels short ("Sit on the couch",
   "Water the plant").
4. TEST: `node games/iso-rooms/tools/sfx-test.mjs` (all sounds render, hooks fire), act-shot your activities, room-shot
   your rooms (roomCalls must not grow by more than ~3), and finish with
   `node tools/build.mjs iso-rooms && node tools/check.mjs iso-rooms` passing (from /Users/kenkai/.gg/goals/gaming/showcase).
   To verify a sound fires, wrap SFX.play in a Playwright script (see tools/sfx-test.mjs) and count calls.

## Rules
- Files: only your rooms' files (src/rooms/<id>.js, <id>-*.js, src/act/<id>*.js, and the extra files named for you).
  Never edit sfx.js, pointer.js, night-ui.js, main.js, kit.js, registry.js, overlay.js, util.js or other rooms. Other
  agents work in parallel. Need a framework change? Describe it in your report.
- No new point lights. Keep perf: sounds are one-shots (no loops/intervals that run forever).
- Turns are ~10 min: room by room, build passing after each. If out of time, stop at a passing state and list what's left.
- Report (short): per room: sounds added (activities + reactions), seats/hotspots added, check result, what's left.
