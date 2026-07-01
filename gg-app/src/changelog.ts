/**
 * Human-readable, hype-toned release notes shown in the dedicated, screen-centered
 * "What's new" window after the app updates to a new version (opened by
 * `WhatsNewModal.tsx`, rendered by `WhatsNewWindow.tsx`).
 *
 * MAINTENANCE: this list is rewritten by the `/release` flow — see
 * `.gg/commands/release.md` (Track B). When cutting a desktop release, the diff
 * since the last `v*` tag is parsed and rephrased into exciting, non-technical
 * copy, then a new entry is PREPENDED here for the new version. Keep entries
 * newest-first and the voice punchy — every line should make the update sound
 * worth installing, never a dry technical note.
 */
export interface ChangelogEntry {
  /** App version this entry ships in, e.g. "0.4.1" (no leading "v"). */
  version: string;
  /** Release date, ISO `YYYY-MM-DD`. */
  date: string;
  /** Hype-toned bullet points, one user-facing win per line. */
  items: string[];
}

/** Newest first. Prepended by the `/release` flow. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.12.0",
    date: "2026-07-02",
    items: [
      'Autopilot got sharper. I now know the difference between real work and a quick hello. Small talk, a plain answer, or a routine commit and push no longer get a pointless "all clear" from me, I just stay quiet and let you keep moving.',
      "Flipping Autopilot mid-run is off the table now, and that is a good thing. The switch locks while I am working or reviewing so you never yank the rug out from under your own build.",
      "You'll know exactly when I'm watching. A bold KEN IS ON banner flashes across the chat the moment you flip Autopilot on, and KEN IS OFF when you pull me back, so there is never any doubt whose eyes are on the work.",
    ],
  },
  {
    version: "0.11.1",
    date: "2026-07-02",
    items: [
      "Fixed a spot where your sub-agents would refuse to launch. If you called on bee, owl, researcher, or worker they could hit a wall and fail outright. I tracked it down and cleared the path, so they run clean every time now.",
      "Cleaned up the model picker. Opening it while you had a longer message typed used to let the chat box paint right over the dropdown. Now it always sits on top where you can actually read it.",
    ],
  },
  {
    version: "0.11.0",
    date: "2026-07-02",
    items: [
      "Meet Autopilot. Flip it on and I stay in the room after every job, reviewing what GG Coder just built the moment it finishes. If something is broken or half-done I send it right back in with a sharp fix, if it nailed it I call it clear, and if it is a real judgment call I tap you on the shoulder. You get a second set of eyes on every single turn without lifting a finger.",
      "You can watch me work now too. While I review, a little Ken line lights up in the status bar, and my verdict lands right in the chat like I am talking straight to you. No mystery, no black box.",
      "Your workspace tidies itself. The second a task is done it slips out of your Tasks list on its own, so all you ever see is what still needs doing. No more hunting for the checkbox.",
      "Un-minimizing one window now brings the whole crew back. Click a single GG Coder window back up and its siblings rise with it, so you are never left digging through the dock for the rest.",
    ],
  },
  {
    version: "0.10.3",
    date: "2026-07-02",
    items: [
      "Your helper agents just got a lot more capable. I gave them room to run five times longer, so instead of quitting halfway through a real job they now see it all the way to the finish. And if one ever does run out of road, it tells you straight up instead of handing back a mysterious blank.",
      "Read-only agents are now genuinely read-only. When I send a scout out to explore your code, it physically cannot touch or change a thing. Peace of mind baked right in.",
      "The tips GG Coder gives you now actually match the app. No more being told to press some terminal shortcut that does not exist here. It points you at the real buttons you can see and click.",
    ],
  },
  {
    version: "0.10.2",
    date: "2026-07-01",
    items: [
      "Anthropic occasionally drops a tool call mid-stream with nothing in it, and it used to make GG Coder throw up its hands and blame itself. I taught it to recognize that exact glitch and just quietly pick the work back up, so a rare hiccup doesn't kill your session anymore.",
      "When something really does go wrong, I fixed the message so it points at the actual culprit instead of guessing it's a GG Coder bug. Clearer errors, less confusion about who to blame.",
    ],
  },
  {
    version: "0.10.1",
    date: "2026-07-01",
    items: [
      "Big sessions on GPT-5.5 just got sturdier. I fixed a bug where long chats could blow past the real context limit right after a compaction and choke with a context-window error. Now I always leave enough headroom, so those marathon sessions keep running instead of stalling out.",
      "The context meter in the footer is honest now too. It reads the real window for however you're connected, so the percentage you see actually means something.",
    ],
  },
  {
    version: "0.10.0",
    date: "2026-07-01",
    items: [
      "Claude Fable 5 is back on the menu. I flipped it back on in the model picker so you can jump straight to it again, no workarounds needed.",
      "Error messages just got a whole lot friendlier. When a provider hiccups, I stopped showing you scary raw error dumps and started telling you exactly what happened, whether it's on their end or mine, and when things reset if you hit a usage limit.",
    ],
  },
  {
    version: "0.9.0",
    date: "2026-07-01",
    items: [
      "Xiaomi just got a turbo button. MiMo-V2.5-Pro-UltraSpeed is in the model picker now, built for when you want answers fast and don't mind paying a bit more for the speed.",
      "Connecting Xiaomi now gives you a real choice. Pick Token Plan or API Credits right in the login screen, and I'll route every MiMo model to whichever one you've actually got set up. No more guessing which key goes where.",
    ],
  },
  {
    version: "0.8.0",
    date: "2026-07-01",
    items: [
      "Claude Sonnet 5 just landed. I wired up Anthropic's newest brain so you can pick it the moment you launch, with a roomy 1M context and double the room to think out loud. Smarter answers, longer memory, same one-click switch.",
      "Long, heavy sessions no longer choke. I hunted down a nasty error that could halt big agent runs mid-task and erased it, so the toughest jobs now run all the way through without a hiccup.",
    ],
  },
  {
    version: "0.7.2",
    date: "2026-06-30",
    items: [
      "GG Coder just got faster at the boring part. When it needs to read a few files or search around, it now grabs them all at once instead of one at a time. Less waiting on every step, more time actually building.",
    ],
  },
  {
    version: "0.7.1",
    date: "2026-06-30",
    items: [
      "I made @Ken much easier to remember right when you are about to type. The input now quietly rotates in helpful Ken hints, then shuffles into place instead of snapping.",
      "Ken now follows your model switch. Pick a new model and @Ken uses it too, so his advice comes from the same brain you chose for the main agent.",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-06-30",
    items: [
      "Say hey to Ken. I put myself right inside the app as your mentor. Type @Ken and I'll tell you what to build next, call out when something is off, and hand you the exact prompt to run. I am not the one writing the code, I am the one keeping you on the rails.",
      "I do not guess and I do not just nod along. When I size up your code or a plan I actually go check it. I search real shipping repos and read the live docs before I answer, and if something smells unverified I dig in and tell you what I found.",
      "I have taste and I am hard on tools. Ask me what to use and I will not parrot whatever is trendy. I research what is actually good right now and steer you to the lean pick that fits your project, not the bloated mainstream one.",
      "Every prompt I write comes with a Send to GG Coder button. One click and it runs. No copy paste, no fuss. I keep it one focused step at a time so nothing snowballs into a mess.",
      "Our chats stick around. Close the app, come back later, and my advice plus everything you sent is right where you left it.",
    ],
  },
  {
    version: "0.6.1",
    date: "2026-06-29",
    items: [
      "The agent stops leaving your tests behind. When it changes code that already has a test, it now notices the test wasn't updated and fixes it right then, before handing back to you. No more silently stale tests passing green while your code moved on.",
    ],
  },
  {
    version: "0.6.0",
    date: "2026-06-29",
    items: [
      "Finding code in your project just got scary fast. I taught the agent a brand new way to search that reads your code by what it actually means, jumping straight to the right function or class instead of skimming whole files. It burns a fraction of the tokens, so answers land quicker and your bill stays lighter.",
      "Your files are safer than ever during edits. I added a guard that catches when a file has shifted since the agent last looked, so it stops and re-checks instead of plowing ahead and scrambling your code. Fewer botched edits, more trust.",
    ],
  },
  {
    version: "0.5.4",
    date: "2026-06-28",
    items: [
      "Type a follow-up mid-task and it actually gets respected now. I fixed a big one: when you fired off a second message while the agent was working, it used to latch onto that new note and quietly forget what you originally asked. Now it folds both together, whether you are adding more or course-correcting, and finishes everything you told it.",
    ],
  },
  {
    version: "0.5.3",
    date: "2026-06-28",
    items: [
      "Your home screen just got a whole lot funnier. I loaded up a fresh stack of memes built for how we actually code in 2026, accepting every suggestion, praying through npm install, and letting the agent cook. Refresh and you will catch new ones every few seconds.",
      "This window now remembers way more. I cranked the history up to the last 50 updates so you can scroll back through everything I have been shipping, not just the latest handful.",
    ],
  },
  {
    version: "0.5.2",
    date: "2026-06-27",
    items: [
      "Now you can sharpen your next prompt while the agent is still working. The Enhance button shows up the moment you start typing a follow-up, so you line up a polished, ready-to-fire message without breaking stride.",
    ],
  },
  {
    version: "0.5.1",
    date: "2026-06-27",
    items: [
      "Squashed a nasty one. On some Macs, clicking Enhance could black out the whole app. I tracked it down and killed it for good, so the screen stays rock solid every single time.",
      "The Enhance button found its home. It now rides the top edge of your chat box and sticks around the moment you start typing, gliding in and out smooth as glass instead of crowding your words.",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-06-26",
    items: [
      "Every time I ship an update, you now get a little celebration. This very window pops up to walk you through exactly what is new, confetti and all. Reopen it anytime from the home screen.",
      "Polished the top bar. The Radio and Windows icons now light up clean and steady when you hover, no more jittery shimmer.",
    ],
  },
  {
    version: "0.4.1",
    date: "2026-06-24",
    items: [
      "The Prompt Enhancer now glides in glassy-smooth. I hunted down the split-second flash on handoff and erased it. Pure silk.",
      "Your input gently dims while the enhancer works its magic, so you always know exactly when it's cooking.",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-06-22",
    items: [
      "Say hello to the Prompt Enhancer. Turn a half-formed thought into a razor-sharp prompt with one click, complete with a gorgeous dissolve animation.",
      "Rock-solid image handling. Tricky attachments that used to trip up a turn now sail straight through.",
      "Plan mode feels crisp again. Accepting a plan resets the session cleanly so you start every build with a fresh head of steam.",
    ],
  },
  {
    version: "0.3.1",
    date: "2026-06-19",
    items: [
      "Long conversations just got cheaper and snappier. I squeezed a full hour of smart caching out of every chat so you spend less and wait less.",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-06-17",
    items: [
      "Brand-new per-project Notes. Pop open a clean notebook for any project and jot ideas, todos, or scratch thoughts that stick around.",
      "Every modal now closes with the same satisfying, consistent button. Small touch, big polish.",
      "The commit button slid to its natural home on the right, right where your thumb expects it.",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-06-14",
    items: [
      "Fresh AI firepower: the Sakana Fugu and Fugu Ultra models are now one tap away in the model menu.",
      "More creative range under the hood means more ways to get exactly the answer you're chasing.",
    ],
  },
];

/**
 * The most recent changelog bullets for the modal, capped at `maxItems` total
 * bullet points (default 50) across versions — newest first, version grouping
 * preserved. A version whose bullets would spill past the cap is included with
 * only the bullets that fit.
 */
export function recentChangelog(maxItems = 50): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  let count = 0;
  for (const entry of CHANGELOG) {
    if (count >= maxItems) break;
    const items = entry.items.slice(0, maxItems - count);
    if (items.length === 0) break;
    out.push({ ...entry, items });
    count += items.length;
  }
  return out;
}
