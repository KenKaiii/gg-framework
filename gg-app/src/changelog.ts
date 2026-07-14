/**
 * Human-readable, hype-toned release notes shown in the dedicated, screen-centered
 * "What's new" window after the app updates to a new version (opened by
 * `WhatsNewModal.tsx`, rendered by `WhatsNewWindow.tsx`).
 *
 * MAINTENANCE: this list is rewritten by the `/release` flow — see
 * `.gg/commands/release.md` (Track B). Each item is one distinct user-facing
 * feature, never one feature split into several bullets. Backticks wrap concrete
 * names, controls, models, and numbers that render as themed inline highlights.
 * Keep entries newest-first and the voice punchy — every line should make the
 * update sound worth installing, never a dry technical note.
 */
export interface ChangelogEntry {
  /** App version this entry ships in, e.g. "0.4.1" (no leading "v"). */
  version: string;
  /** Release date, ISO `YYYY-MM-DD`. */
  date: string;
  /** One cohesive bullet per distinct feature; backticks highlight specifics. */
  items: string[];
}

/** Newest first. Prepended by the `/release` flow. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.21.0",
    date: "2026-07-15",
    items: [
      "Your chat agents finally have a soul. I built `Jiwa` so they remember how you want them to speak, behave, and even what name to use, then tucked it beside Memories inside one clean `Brain` switcher where you can inspect or clear every instruction.",
      "Beautiful interfaces are no longer a lucky roll. I bundled `Evidence-Led UI` into every install, so GG Coder now checks real design craft, accessibility, and responsive behavior before it touches your frontend.",
      "Long jobs stay focused without getting slapped by a false alarm. I stopped healthy `background tasks` and iterative edits from tripping the stuck detector, while genuine no-progress loops still get snapped out fast.",
      "Chat gives you more room and more awareness. I added a collapsible `Chat` header and brought the `context meter` into view, so you can reclaim space and see exactly how much conversation room remains.",
    ],
  },
  {
    version: "0.20.1",
    date: "2026-07-13",
    items: [
      "Your coding history is back where it belongs. I fixed the `Projects` picker so moving through `Chat` no longer hides your recent coding sessions, and you can jump straight back into the work you left.",
    ],
  },
  {
    version: "0.20.0",
    date: "2026-07-13",
    items: [
      "Your conversation can now move to the right expert without missing a beat. I made `General`, `Therapist`, and `Research` hand off the active chat itself, keep every message, update the agent you see, and stay switched when you come back later.",
      "Finding your way around Chat is cleaner and faster. I rolled every conversation into one unified `Chats` list, removed the agent tabs, and made every new window begin on `Home` so Code and Chat are always one click away.",
      "Your `Memories` view just got tighter and calmer. I replaced the confusing limits with one clear count badge, reclaimed the extra space, and stopped the table header from bouncing when you scroll.",
    ],
  },
  {
    version: "0.19.0",
    date: "2026-07-13",
    items: [
      "Chat just became a whole new side of GG Coder. I built `General`, `Therapist`, and `Research` companions with their own conversation history, then gave them durable memory you can inspect and clean up anytime.",
      "Your windows now wake up exactly where you left them. I hardened restored sessions, rapid project switches, and reused window slots, so even a `4 window` workspace opens cleanly with every chat attached to the right place.",
      "Web research is faster, cleaner, and much harder to knock over. I made `Web Search` share fresh results across windows and gave `Web Fetch` smarter extraction, strict download guards, and quicker document discovery.",
      "Image batches finally deliver what you asked for. I fixed `Generate Image` so requests for up to `4 images` produce the full set instead of getting rejected by the provider.",
      "Your `Codex` limit meter tells the truth at a glance. I taught it to recognize weekly windows wherever the provider sends them and made long reset times read naturally in days.",
    ],
  },
  {
    version: "0.18.3",
    date: "2026-07-12",
    items: [
      "OpenAI sessions just got smarter about every token. I aligned `Codex` caching across your main chat and specialist crew, so long jobs stay snappy, reuse more work, and keep each agent safely in its own lane.",
    ],
  },
  {
    version: "0.18.2",
    date: "2026-07-12",
    items: [
      "Long sessions and `/compact` now bounce back faster instead of getting buried under giant old file edits. I slimmed down oversized history and cut off stalled cleanup attempts fast, so you spend less time waiting and more time shipping.",
      "`Apple silicon` is cleaner and ready for what comes next. I stripped unused Intel baggage out of the app bundle, cutting roughly `180 MB` before compression and keeping GG Coder fully native as macOS moves beyond Rosetta.",
    ],
  },
  {
    version: "0.18.1",
    date: "2026-07-12",
    items: [
      "Your `Radio` volume control is finally silky and instant. I stopped the music from cutting out, made every level change land right away, and kept the slider locked to your hand while you drag.",
    ],
  },
  {
    version: "0.18.0",
    date: "2026-07-11",
    items: [
      "`Ultra` now runs a real specialist crew. I made every expert visible while it works, steerable mid-job, and ready to pick up another mission with full context intact.",
      "`Radio` finally behaves like part of the app. I added a volume slider, made your level stick across windows, and guaranteed the music stops when GG Coder closes, even after a force quit.",
      "`What's new` is easier to scan. I put the latest release in one clean card, grouped each feature into a single story, and gave the details just enough emphasis to pop.",
    ],
  },
  {
    version: "0.17.0",
    date: "2026-07-11",
    items: [
      "`Ultra` just learned true teamwork. I gave it a visible crew of specialists that work at the same time, take new direction mid-job, recover cleanly, and keep their full context for the next mission.",
      "Settings feel cleaner and calmer. I moved sound controls where they belong and erased the strange shimmer from the home buttons.",
    ],
  },
  {
    version: "0.16.0",
    date: "2026-07-11",
    items: [
      "GPT-5.6 Ultra is here. I taught Sol and Terra to split big jobs across parallel specialists, pull the best work back together, and keep charging until the result is done right.",
    ],
  },
  {
    version: "0.15.2",
    date: "2026-07-11",
    items: [
      "GPT-5.6 is fully unlocked. I fixed the hidden handshake blocking Sol, Terra, and Luna, so every tier now answers the moment you pick it.",
    ],
  },
  {
    version: "0.15.1",
    date: "2026-07-10",
    items: [
      "Apps you launch through GG Coder can finally hear you. I unlocked microphone access for recorders, voice tools, and every other project you run, so testing audio now just works.",
    ],
  },
  {
    version: "0.15.0",
    date: "2026-07-10",
    items: [
      "Your `Claude` and `Codex` limits now live in one glowing title-bar meter. It follows the model you are using, shows the current window and reset time, and opens your weekly view with one tap.",
    ],
  },
  {
    version: "0.14.18",
    date: "2026-07-10",
    items: [
      "GPT-5.6's full power dial is finally yours. I opened every step from quick and light to maximum firepower, so you can choose exactly how hard Sol, Terra, or Luna thinks on every task.",
    ],
  },
  {
    version: "0.14.17",
    date: "2026-07-10",
    items: [
      "Sub-agents no longer quit when the faster, cheaper model is out of reach. I made them switch straight back to your active model and finish the job, so your workflow keeps moving without babysitting.",
    ],
  },
  {
    version: "0.14.16",
    date: "2026-07-10",
    items: [
      "`GPT-5.6` is here in all three tiers: `Sol` is the frontier heavyweight, `Terra` is your daily driver, and `Luna` is fast and affordable. I retired the older OpenAI lineup so the model picker stays clean.",
      "Error messages finally speak app, not terminal. Every hint now tells you to use the model selector or compact button instead of referencing slash commands that only exist in the CLI.",
    ],
  },
  {
    version: "0.14.15",
    date: "2026-07-09",
    items: [
      "Big sessions no longer hit a wall. When a chat grew too large for the model, the app used to just stop with an error. Now I catch it, quietly trim the history, and keep the conversation rolling so you never lose your flow.",
      "Error messages read like a human wrote them. Everything now says GG Coder in plain, friendly language, and points you to the exact button to click instead of some command you'd never type.",
    ],
  },
  {
    version: "0.14.14",
    date: "2026-07-08",
    items: [
      "`Gemini` is back and firing on all cylinders. I repaired sign-in after Google's model rename, added `Gemini 3.5 Flash` and `Gemini 3.1 Pro`, cleaned up every model name, and made unavailable-model errors point you straight to one that works.",
    ],
  },
  {
    version: "0.14.13",
    date: "2026-07-08",
    items: [
      "Your level finally reflects the real grind. If you've put in serious miles, you no longer get dumped at the same starting rank as everyone else. I reworked the way past work counts so heavy hitters climb higher right out of the gate, and the leveling curve feels earned instead of flat.",
    ],
  },
  {
    version: "0.14.12",
    date: "2026-07-07",
    items: [
      "Error messages finally speak desktop. When something goes wrong, the app now tells you exactly what to click instead of spitting out terminal commands you'd never run anyway. Clean, clear, and to the point.",
    ],
  },
  {
    version: "0.14.11",
    date: "2026-07-07",
    items: [
      "`Kencode search` is back. I fixed the silent startup failure, confirmed live searches flow again, and wired a build-time tripwire so this cannot quietly ship broken again.",
    ],
  },
  {
    version: "0.14.10",
    date: "2026-07-06",
    items: [
      "Edits just got surgical. I taught the agent to pin the exact lines it wants to change with tiny fingerprints instead of retyping your code, so edits land right the first time, burn fewer tokens, and can never scribble over a file that changed under its feet. On repetitive code it now says in 39 tokens what used to take 160.",
      "The agent's terminal grew a memory. Multi-step shell work can now run in one living session where cd, environment variables, and setup carry over between commands. Less repeating itself, more getting things done.",
    ],
  },
  {
    version: "0.14.9",
    date: "2026-07-06",
    items: [
      "Your session list is yours again. Ken's silent autopilot reviews were quietly leaving behind a fake 2-message session every few minutes, burying your real work under a wall of clones. I plugged the leak for good, so what you see in the picker is exactly what you built. Nothing else.",
      "`Autopilot` got tougher to derail. I made Ken's handoffs land even when they arrive wrapped in chatter, then tightened his reviews so cycles run leaner and stall less.",
    ],
  },
  {
    version: "0.14.8",
    date: "2026-07-05",
    items: [
      "Your search and `MCP` helpers just went on a diet. I removed a launcher that wasted around `90 MB` per tool, so built-in and custom tools now start lean and keep your machine snappy.",
    ],
  },
  {
    version: "0.14.7",
    date: "2026-07-05",
    items: [
      "Your machine breathes easier now. `GG Coder` hunts down leftover built-in and custom tool helpers on startup, so closed projects stop quietly eating your memory for days.",
      "Ken gives sharper advice. He now knows exactly what GG Coder can do under the hood, so his guidance is grounded in the real tools at hand instead of guesses, and his handoffs back to the agent come through clean.",
    ],
  },
  {
    version: "0.14.6",
    date: "2026-07-05",
    items: [
      "`Autopilot` just got more independent. GG Coder now proves its own work and handles the obvious safe next step without asking for a human who is not there, so more jobs finish in one run.",
    ],
  },
  {
    version: "0.14.5",
    date: "2026-07-04",
    items: [
      "Your research helpers just got faster and cheaper. I route quick lookups to the fastest model while code-changing helpers keep the big brain, so answers fly without trading away edit quality.",
    ],
  },
  {
    version: "0.14.4",
    date: "2026-07-03",
    items: [
      "Edits just got rock solid. I killed a nasty glitch where a big change could arrive half-broken and get rejected, so now it quietly retries and lands clean the first time you see it.",
      "Your projects stop disappearing. If a folder had an underscore in its name it could vanish from the picker even with all its sessions safe on disk, and I tracked down exactly why and fixed it. Every project shows up now.",
    ],
  },
  {
    version: "0.14.3",
    date: "2026-07-03",
    items: [
      "Big tool catalogs no longer slow down your first reply. I keep the essentials ready, then pull in the heavy stuff only when you actually need it.",
      "Connection hiccups feel way less annoying now. If a reply gets cut off after real progress, I keep what you already saw and continue instead of making you watch the same answer again.",
      "Streaming feels calmer and lighter. I tuned the live text updates so long answers stay smooth without making your machine work so hard.",
      "I trimmed the instruction stack again. GG Coder spends less attention on boilerplate and more attention on your code.",
    ],
  },
  {
    version: "0.14.2",
    date: "2026-07-03",
    items: [
      "Reopening a session now looks exactly like you never left. Every bubble, label, highlight, queued message, plan banner, task header, and error detail comes back clean, with ghost messages and leaked internals gone for good.",
    ],
  },
  {
    version: "0.14.1",
    date: "2026-07-03",
    items: [
      "XP feels punchier now. I swapped in a fresher sound for those little progress hits, so every step forward lands with more snap.",
    ],
  },
  {
    version: "0.14.0",
    date: "2026-07-03",
    items: [
      "`Autopilot` can handle plans on its own now. I review, approve, revise, and launch them without making you babysit a popup, while manual mode keeps the normal review screen.",
      "I got better at spotting fake blockers. If GG Coder asks permission for safe work that is already implied by your request, I tell it to keep going instead of dragging you back in.",
    ],
  },
  {
    version: "0.13.0",
    date: "2026-07-03",
    items: [
      "Coding just became a game. Real work earns `XP` from your existing git history, the `Scorecard` shows your climb, and every level-up lands with sound and confetti.",
    ],
  },
  {
    version: "0.12.4",
    date: "2026-07-02",
    items: [
      "Your sessions list is clean now. Reopening a project used to clone the whole conversation into a duplicate every single time, I fixed the leak so resuming just picks up right where you left off.",
    ],
  },
  {
    version: "0.12.3",
    date: "2026-07-02",
    items: [
      "I got a lot faster and cheaper to talk to. Your context now stays warm in my memory for a full hour instead of dropping every five minutes, so long sessions cost less and I answer quicker.",
      "Drag a folder straight onto the window and I will drop its path right into your message, no more typing paths by hand.",
      "Autopilot now skips reviewing pure busywork, like commits, pushes, and status checks, so I only chime in when there is real work worth judging.",
      "Added a Grant Permissions button in Settings for macOS so you can hand me full disk access in one click instead of clicking through a maze of prompts.",
    ],
  },
  {
    version: "0.12.2",
    date: "2026-07-02",
    items: [
      "`Autopilot` is calmer and harder to fool. I judge GG Coder against your original request, stop inventing work after the job is done, and call you in instead of answering real questions or plan decisions on your behalf.",
      "Ken gets his own model switch. Pin me to a different brain or let me follow GG Coder, right from the footer.",
      "Queued messages land cleaner now. If you send one while I am reviewing and there is no live run to steer, I treat it as a fresh turn instead of mixing it into the next unrelated job.",
    ],
  },
  {
    version: "0.12.1",
    date: "2026-07-02",
    items: [
      "The `KEN IS ON` banner now lands over exactly what you are viewing, even deep in a session, with full edge-to-edge coverage and no chat text peeking through.",
    ],
  },
  {
    version: "0.12.0",
    date: "2026-07-02",
    items: [
      "`Autopilot` got sharper and clearer. I skip pointless reviews for small talk and routine chores, lock the switch during active work, and flash `KEN IS ON` or `KEN IS OFF` so you always know who is watching.",
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
      "Meet `Autopilot`. I review every finished job, send broken work straight back with a sharp fix, call clear work done, and tap you for real judgment calls, all while a live Ken status and in-chat verdict show exactly what I am doing.",
      "Your workspace tidies itself. The second a task is done it slips out of your Tasks list on its own, so all you ever see is what still needs doing. No more hunting for the checkbox.",
      "Un-minimizing one window now brings the whole crew back. Click a single GG Coder window back up and its siblings rise with it, so you are never left digging through the dock for the rest.",
    ],
  },
  {
    version: "0.10.3",
    date: "2026-07-02",
    items: [
      "Your helper agents just got more capable and safer. They can run `5 times` longer, report clearly if they hit a limit, and read-only scouts physically cannot change your code.",
      "The tips GG Coder gives you now actually match the app. No more being told to press some terminal shortcut that does not exist here. It points you at the real buttons you can see and click.",
    ],
  },
  {
    version: "0.10.2",
    date: "2026-07-01",
    items: [
      "Rare empty tool calls from `Anthropic` no longer kill your session. GG Coder quietly picks the work back up, and real failures now name the actual culprit instead of blaming itself.",
    ],
  },
  {
    version: "0.10.1",
    date: "2026-07-01",
    items: [
      "Big sessions on `GPT-5.5` just got sturdier. Compaction now leaves the right headroom, and the footer reads the real context window for your connection, so marathon chats keep running with an honest meter.",
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
      "Xiaomi just got a turbo button. `MiMo-V2.5-Pro-UltraSpeed` is in the picker, and login now lets you choose `Token Plan` or `API Credits` so every MiMo model uses the right connection automatically.",
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
      "`@Ken` is easier to remember and stays in sync. Helpful hints rotate into the input, and every model switch carries over so his advice comes from the same brain you chose for GG Coder.",
    ],
  },
  {
    version: "0.7.0",
    date: "2026-06-30",
    items: [
      "Say hey to `@Ken`, your research-first mentor inside the app. I check real code and live docs, challenge shaky plans, recommend tools with taste, turn advice into one-click `Send to GG Coder` prompts, and keep our chats waiting for you after a restart.",
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
      "`Enhance` is rock solid and right where it belongs. I killed the Mac blackout bug and pinned the button to your chat box, where it glides in smoothly without crowding your words.",
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
      "The `Prompt Enhancer` now glides in glassy-smooth. I erased the handoff flash and gently dim the input while it works, so every transition feels deliberate. Pure silk.",
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
      "Fresh AI firepower: `Sakana Fugu` and `Fugu Ultra` are now one tap away, giving you more creative range for the exact answer you are chasing.",
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
