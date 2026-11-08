---
name: app-walkthrough
description: Job skill for showing how an app or product is used, step by step, on rebuilt real screens. Adds walkthrough questions, the screen-rebuild method, moves and pitfalls. Load once, before asking.
---

# App walkthrough

A walkthrough is the product in use: open it, do the task, get the
result. Build it as the `motion` skill describes; this page adds what is
specific to walkthroughs.

## Ask (on the motion skill's single card)

Use the shared visual-approach question from `motion` when unsettled, ahead of
an optional idea pitch. Adapt its choices to this job; keep the card to four
questions total and skip choices the brief or requested reference already settles.

- "Which task should the video walk through?" Offer the two or three tasks the
  prompt or screenshots suggest, plus "Let GG Motion choose".
- "Where will people mostly watch this?" (from the `motion` skill).
- "Should it have music?" (from the `motion` skill).
- "Which idea should we go with?" Pitches below, recommended marked, plus "Let
  GG Motion choose".

Without screenshots, end with one plain line: "Send me a screenshot of each
step of that task, in order. Phone photos of the screen are fine." Do not ask
for a shot list.

## Rebuild the screens

Rebuild each screen as HTML at the screenshot's own size, with its states
scripted, its text big enough to read, one close-up per step and a cursor that
presses. Start from the `screen-replica-steps` piece. Hide account names,
emails and anything private. Data on screen comes from
their screenshots or files, never invented.

## Ideas that suit walkthroughs

- **Follow the hand.** One continuous camera that rides the cursor from step to
  step; each click opens the next framing.
- **The request becomes the result.** The thing the user types or picks grows
  into what the app gives back.
- **The app's own transition.** Use the app's real sheet, drawer or page
  animation as the handoff between steps.
- **Before the tap, after the tap.** Each step is a held "before" frame, one
  press, and the change it causes.

## Beats that work

- Open on the moment that matters most (the result), then rewind to how it is
  done, or open straight on the first step with the cursor already moving.
- One step per beat, with a close-up on the control being used.
- Hold still on the result long enough to read it. That is the rest.
- End on the app's name or icon and where to get it.

## Moves

`kit.cursorPath` with press and release; `kit.camera` following the cursor;
`kit.typewrite` for typed input; `kit.tick` for completed steps;
`kit.reshape` from the pressed control into the result. Pieces:
`screen-replica-steps`, `request-to-result`, `cursor-click`, `phone-frame`,
`browser-window`, `camera-rig`.

## Pitfalls

- Screenshots placed flat and slid around. Rebuild them.
- Whole screens shown small: text unreadable at phone size.
- The cursor teleporting, or changes happening without a click.
- Steps of equal length with no rest on the result.
- Made-up names, numbers or results.
