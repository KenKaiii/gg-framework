---
name: match-reference
description: Job skill for a video like one the user supplies. Measures the reference's rhythm and style rules with reference-study.mjs, then makes an original video on the user's subject. Load once, before asking.
---

# One like my example

The user likes how some video feels and wants that, about their own subject. Take
its rules, never its scenes, words, order or assets. Build it as the `motion`
skill describes; this page adds the study step.

## Ask (on the motion skill's single card)

Use the shared visual-approach question from `motion` when unsettled, ahead of
an optional idea pitch. Adapt its choices to this job; keep the card to four
questions total and skip choices the brief or requested reference already settles.

- "What should the new video be about?" when the prompt doesn't say.
- "What do you like most about the example?" The pace · The look · How one
  scene flows into the next · All of it (recommended).
- "Where will people mostly watch this?" only if the example's shape doesn't
  answer it.
- "Which idea should we go with?" Pitches built on the reference's rules,
  plus "Let GG Motion choose".

If no example is attached, end with one plain line asking them to attach the
video file. A link to a page is not enough to measure.

## Study the reference

```bash
<node> "<motion bin>/reference-study.mjs" <reference.mp4> --out sources/reference
```

It writes `report.json` and `report.md` (how much of the video is still and
where it rests, where the hard cuts and bursts are, shot lengths and how even
they are, how much fast motion there is). It also writes `sheet-shots.jpg` (one frame per
shot) and `sheet-timeline.jpg` (evenly spaced). Look at the sheets and note
for yourself:

- **The one rule every element obeys** (everything sits on a card; every word
  arrives by typing; everything is drawn with one line). Applied to the new
  subject, that rule is the style.
- **Numbers, not impressions**: the palette from full frames, type size as a
  share of the frame height, how much of the frame the biggest element takes.
- **Rhythm**: the still share, the shot-length spread, where the bursts fall
  relative to the length.
- **Motion within a beat**: typing, ticks, a cursor, the camera.

## Make it yours

- Beats follow the new subject's story; the reference's scene sequence stays behind.
- Carry each boundary using pieces of the borrowed look, even where the reference
  hard-cuts. Its cuts are habits of the edit, not the look you are borrowing.
- Match its rhythm within reason.
- Never trace its frames, reuse its text or extract its assets or music.

## Pitfalls

- A scene-by-scene remake on a new topic. That is copying, and it reads as one.
- Matching surface details (a colour, a font) without the underlying rule.
- Inheriting the reference's bare cuts.
