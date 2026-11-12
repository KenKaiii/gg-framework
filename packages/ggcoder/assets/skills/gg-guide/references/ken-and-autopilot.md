# Ken, helpers and extras

Ken is GG Coder's second agent in a Code window. GG does the building; Ken is a mentor and reviewer who reads what GG has been doing and gives you a second opinion. This page also covers helper agents (critters), trophies, your level, the radio and celebrations.

## Who Ken is

- Ken is a separate, read-only agent that sits alongside GG in the same Code window. He can read GG's conversation, but GG never sees what you say to Ken.
- Ken doesn't edit your code. He answers questions, reviews work and reviews plans.
- Ken is available in Code windows only. In Chat and Motion there is no Ken. In Goals, Ken is the face of GG Goals on the farm (see `references/chat-motion-goals.md`).
- Ken's messages appear in the chat with his little pixel face and the name Ken on top, with a teal stripe, so you can tell them apart from GG's replies.

## Talking to Ken with @Ken

- Start your message with `@Ken` followed by your question, for example `@Ken is this approach sound?`. Upper or lower case both work, and a colon after it is fine.
- The composer placeholder reminds you: **Type a message, / commands, @ files, @Ken for help**. Sometimes it shows a tip such as **Need a second opinion? Ask @Ken** instead.
- `@Ken` only counts at the very start of the message. While it's there, typing `@` doesn't open the file picker.
- Your `@Ken` message shows as a solid teal bubble, and Ken's reply streams in below it.
- Ken can't take attachments. If you attach files to an `@Ken` message you'll see "Ken cannot receive attachments. Remove @Ken to send them to GG."
- Ken can answer while GG is in the middle of a run; the two work at the same time.
- An `@Ken` message with nothing after it isn't sent.

## Ken's activity bar

- While Ken is answering, an activity bar shows **Ken is thinking…** in Ken's colour, with the elapsed time and his output token count.
- It has the same tool panel toggle as GG's bar. The red Stop button on the composer stops whichever of GG, Autopilot or Ken is busy.
- During an Autopilot review the bar reads "Ken reviewing…".

## Ken's model

- Ken uses GG's model by default. You can pin a different model for him in the **Model** panel: pick the Ken target, then choose "Follow GG" or a specific model.
- The choice is saved per project.
- You can't change Ken's model while GG, Ken or an Autopilot review is running; the control dims until they finish.
- If Ken or Autopilot hits a model error, the error notice offers a "Switch Ken's model" picker.
- Paid fast modes are never used by Ken. Details: `references/models-and-sign-in.md`.

## Autopilot

- Autopilot makes Ken review GG's work automatically. Turn it on or off with the **Autopilot** switch in the **More** panel, the ⋯ key on the bottom bar. Its light is lit when on. Its tooltip says: **Autopilot: after each run, Ken reviews the work and GG continues if it needs changes**.
- The setting is saved per project and only exists in Code windows.
- You can't flip the switch while GG is running or Ken is reviewing.
- Flipping it shows a brief line over the chat: **Ken is on.** (Ken wakes up with a hop) or **Ken is off.** (he nods off).

### What happens on each run

- After GG finishes a run, Ken looks at what you asked for, what GG did and which files changed.
- If the work needs more, Ken sends GG back in. His message in the chat starts with "Sending GG Coder back in:" followed by what he asked GG to do. GG then runs again and Ken reviews again.
- If the work is done, Ken posts a short all-clear line.
- If he thinks you need to decide something, he says so (for example "Need you to weigh in on this one.") and stops.
- After 3 review rounds for one message, Autopilot pauses with "Paused autopilot after 3 rounds. Take a look before I keep going."
- Busywork such as commits or status checks isn't reviewed.
- Ken checks for unfinished work and what you actually asked for; he doesn't chase optional polish.
- Failed or unfinished checks stay marked Unverified; Ken won't paper over them.
- Pressing Stop also stops an Autopilot review in progress.
- If GG asks you a question while Autopilot is on and you don't answer within 2 minutes, it carries on with its best guess (10 minutes without Autopilot). Your later answer still gets sent.

## Plan decisions

- When GG submits a plan and Autopilot is on, Ken reviews the plan before you see it in Plan review.
- He looks for steps that don't need to be there, bad ordering, things split in the wrong place and unhandled cases. He doesn't nitpick taste.
- If he approves it, he posts "Plan looks solid. Approved it — implementation is underway." and GG starts building.
- If he has feedback, GG revises the plan in read-only mode, so no code changes before approval.
- If he hands the plan back to you, the accept controls appear as normal. Your decision always wins. Plan review itself is covered in `references/code-mode.md`.
- After a decision, a small critter line is left in the chat:
  - Accepted: for example "Plan accepted. The critters are building it".
  - Feedback: for example "Feedback sent. A critter is redrafting the plan".
  - Rejected: for example "Plan rejected. Nothing was built".

## Helper agents (critters)

- When GG splits work across helper agents (sub-agents), each helper appears as a little pixel critter above the chat. They beam in, wander, hop when they get a new task and wave goodbye when done. Click one to see it react.
- A line in the chat tracks the group, led by a critter, for example "Sent a critter off to help…" or "Launched 3 critters to dig in…".
- The line's colour and wording show the state:
  - Pink and shimmering: still working ("One critter is still on the case…").
  - Green: finished ("The critters are back with the goods").
  - Red: one or more failed ("The critter ran into trouble").
  - Amber: you stopped them ("The critters were called back"). That's not a failure.
- Small critters also lead rows in popovers such as **Background tasks** and Schedules. Their pose means the same everywhere: hopping is busy, standing is idle or done, sitting and dozing is waiting, and tipped over means something went wrong.
- Critters also greet you on an empty chat, appear on the Home screen and show up in error notices. They're decoration and don't need any action.

## Level and Scorecard

- The context key on the deck (the percentage) opens the **Usage** panel. It has a level row showing your level and rank name, and a **Next level** bar with your XP.
- Click the level to open the **Scorecard**: your level and rank, a **Streak** with **Your best**, and progress bars for **Prompts**, **Commits** and **Lines shipped** toward the next milestone.
- You earn XP by using GG Coder. Ranking up shows a "Rank up!" message with the new rank name, and crossing into a new tier fires a confetti burst.

## Trophies

- Trophies reward you for trying things GG Coder can do, from your first slash command to long daily streaks.
- To see them: click the context key on the deck to open **Usage**, then click the trophy button next to your level. It shows how many you've earned.
- The **Trophies** panel has two tabs: **Earned** and **To earn**. Trophies are grouped by category and graded **Bronze**, **Silver**, **Gold** or **Platinum**.
- Each trophy on **To earn** shows **How:** with what to do, and a progress bar where it counts up.
- With none yet, the panel says "No trophies yet. Open To earn to see how to get your first."
- When you earn one, a card lands in the corner, charges up and flips over with its own sound, then files itself into the context key. Use **Dismiss** to close it early.

## Radio

- GG Coder has a built-in internet radio with a list of stations.
- In a session window: open the **More** panel (the ⋯ key on the bottom bar) and choose **Radio**. Pick a station, then **Play** or **Pause**, and set the volume.
- If the app crashes or is force-quit, the next launch stops any leftover player.
- On the Home, Chat and Goals pickers, the radio icon button opens the **Internet Radio** player with a **Station** list, **Play**/**Pause** and **Volume**.
- While music plays, the deck shows an **On air** key; click it to open the player.

## Common questions

Q: Who is Ken?
A: Ken is GG Coder's second agent in Code windows, a read-only mentor and reviewer. He reads GG's conversation and gives you a second opinion, but never edits code.

Q: How do I ask Ken something?
A: Start your message with `@Ken`, for example `@Ken does this plan make sense?`. His reply appears in the chat with his pixel face.

Q: Does GG see what I say to Ken?
A: No. Ken can read GG's conversation, but your `@Ken` messages and his replies aren't sent to GG.

Q: Why can't I attach a file to Ken?
A: Ken doesn't accept attachments. Remove `@Ken` to send the files to GG instead.

Q: Can I use a different model for Ken?
A: Yes. Open the **Model** panel, choose the Ken target and pin a model, or pick "Follow GG" to match GG. It's saved per project.

Q: What does Autopilot do?
A: After each GG run, Ken reviews the work. If something is missing he sends GG back in, up to 3 rounds per message, then reports or hands it back to you.

Q: How do I turn Autopilot on?
A: Open the **More** panel (the ⋯ key on the bottom bar) and click **Autopilot**. You'll see **Ken is on.** over the chat. It's remembered for that project.

Q: Why did Autopilot stop after a few rounds?
A: It pauses after 3 review rounds for one message so it can't loop forever. Check the work, then send a new message to carry on.

Q: How do I stop Ken or an Autopilot review?
A: Press the red Stop button on the composer. It stops whichever of GG, Autopilot or Ken is working.

Q: Did Ken approve my plan without asking me?
A: With Autopilot on, Ken reviews plans and may approve them, saying "Plan looks solid. Approved it — implementation is underway." With Autopilot off, plans always wait for you in Plan review.

Q: What are the little critters above the chat?
A: They're GG's helper agents. Pink means working, green means done, red means a helper failed, and amber means you called them back.

Q: How do I see my trophies?
A: Click the context key (the percentage) on the deck, then the trophy button next to your level. Use the **To earn** tab to see how to get the rest.

Q: How do I earn trophies?
A: By trying GG Coder's features and using it regularly. Each trophy under **To earn** shows **How:** to get it.

Q: Where is my level and Scorecard?
A: Open **Usage** from the context key and click your level to open the **Scorecard** with your streak, prompts, commits and lines shipped.

Q: Why did confetti appear?
A: You ranked up into a new tier. Ordinary rank-ups show a "Rank up!" message without confetti.

Q: How do I play music?
A: Open **Radio** from the **More** panel (the ⋯ key on the bottom bar), or use the radio button on the Home screen,, pick a station and press **Play**.

Q: How do I turn the radio off?
A: Click the **On air** key on the deck and press **Pause**.
