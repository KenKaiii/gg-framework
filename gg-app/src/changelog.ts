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
    version: "0.28.1",
    date: "2026-07-24",
    items: [
      "`Claude Opus 5` is now fully dialed in. You can cycle its thinking all the way from `low` up through `xhigh` and `max`, so you decide exactly how hard it pushes on any task. It was locked to one setting before. I also cleared the retired `Opus 4.8` out of the model menu, so you only ever see models worth picking.",
    ],
  },
  {
    version: "0.28.0",
    date: "2026-07-24",
    items: [
      "`Claude Opus 5` just landed, and you can pick it right now. It is Anthropic's newest flagship: near-frontier smarts at half the price of the model it replaces, a full `1M token` context so it holds way more of your project in mind, and image understanding baked in. Open the model menu and give it a spin.",
    ],
  },
  {
    version: "0.27.7",
    date: "2026-07-24",
    items: [
      "`/bullet-proof` now actually finishes the job. Some models used to chicken out halfway through the security review, so I reworked the whole flow and gave it two new specialist agents, `auditor` and `skeptic`, that hunt down real weaknesses and then try to disprove every single finding. You get a clean, verified report every time, and it runs leaner too.",
      "I put the agent's instructions on a diet. Less repeated fluff in every request means snappier replies and cheaper sessions, with zero smarts lost. I also retired the old `/setup` command so the menu only shows tools that earn their spot.",
    ],
  },
  {
    version: "0.27.6",
    date: "2026-07-24",
    items: [
      "Your title bar is now a launchpad. Click the `project name` to pop its folder straight open in Finder or Explorer, and click the `branch` to jump right to the repo on GitHub. It works the same on Mac and Windows.",
      "No more staring at a lonely `0`. Your `issues` and `PRs` chips now show up only when you actually have some, so the title bar stays clean and only tells you what matters.",
    ],
  },
  {
    version: "0.27.5",
    date: "2026-07-24",
    items: [
      "`Kimi` and `Moonshot` just got rock solid. They used to drop out mid-task with a bogus `API Key appears invalid` roughly every 15 minutes, especially with a few windows open at once. I now refresh your login well before it can ever expire, so your sessions just keep running.",
    ],
  },
  {
    version: "0.27.4",
    date: "2026-07-24",
    items: [
      "Your project's GitHub pulse now lives in the title bar. Open `issues` and `PRs` sit right next to your branch, and one click jumps you straight to them on GitHub.",
      "Your chat agents finally remember on their own. They now save the durable facts you share the moment you share them, no nagging required. I also fixed a nasty bug where a long memory update could abruptly kill your whole conversation.",
      "No more phantom stalls. Quiet `OpenAI` reasoning models used to look frozen while they were silently thinking. Now the app knows the difference between thinking and stuck.",
      "Resumed sessions tell the truth. Errors now land exactly where they happened instead of jumping to the bottom of the transcript.",
    ],
  },
  {
    version: "0.27.3",
    date: "2026-07-23",
    items: [
      "Your workspace windows now know exactly where they belong. I made every window recover its active project instead of dumping you on `Home`, and slow wake-ups now show `Restoring workspace` instead of an empty black screen.",
      "Your `rank badge` keeps the flex without the flicker. I rebuilt its color-shifting shine so your tier stays visible and smooth, even while other video-heavy apps are fighting for the screen.",
    ],
  },
  {
    version: "0.27.2",
    date: "2026-07-23",
    items: [
      "Windows and Linux menus are back in fighting shape. I fixed the `model picker` and `Arrange` controls so every click lands, every choice sticks, and keyboard navigation feels crisp, while keeping the exact clean controls you already know.",
    ],
  },
  {
    version: "0.27.1",
    date: "2026-07-23",
    items: [
      "Long builds no longer stall out waiting for you to type `Continue`. I taught GG Coder to catch runaway tool calls, retry them `2 times`, and keep your conversation moving without losing its place.",
      "GG's built-in coding senses are fully loaded again. I restored `TypeScript diagnostics` and `source inspection` inside the desktop app, then made search more forgiving, so it catches mistakes sooner and digs through dependencies without missing a beat.",
    ],
  },
  {
    version: "0.27.0",
    date: "2026-07-22",
    items: [
      "The `model picker` and `Arrange` button now open real native menus while keeping the exact clean controls you already know. They feel faster, behave properly with your keyboard, and look right at home on your machine.",
      "Reading while several `subagents` work in parallel just got silky smooth. I cut the pointless background chatter and keep every real activity update, so you can scroll through the conversation without fighting the app.",
      "Updates now show their work. Tap the new `Install` badge and both the footer and home screen turn into live percentage progress, with zero jumping around while GG Coder downloads the good stuff.",
      "The idle footer finally developed a personality. I added `10` dry little status lines, from professional napping to token polishing, so waiting around is at least mildly entertaining.",
    ],
  },
  {
    version: "0.26.1",
    date: "2026-07-22",
    items: [
      "Every answer now arrives whole. If your provider's connection drops mid-reply, I catch the cut-off and `retry` cleanly instead of quietly handing you half an answer dressed up as a finished one. No more silent half-answers.",
      "Random error popups, evicted. I hunted down a sneaky class of `400` rejections that could crash a chat out of nowhere, so your conversations just keep flowing.",
      "GG now runs lighter for longer. I capped runaway memory at `10 MB` per request and `50k` files per search, and plugged a background leak, so marathon sessions stay snappy instead of slowly bloating.",
    ],
  },
  {
    version: "0.26.0",
    date: "2026-07-22",
    items: [
      "The login screen just got a glow-up. Every AI provider now shows up as a glossy tile with its real logo, from `Claude` clay to the `DeepSeek` whale, so connecting a new brain feels like picking a fighter. Connected ones get a little green dot so you always know who is ready to roll.",
      "Kimi users, your quota is no longer a mystery. The title-bar usage meter now tracks your `Kimi For Coding` plan right alongside Claude and ChatGPT, so you can see exactly how much runway you have before you hit a wall.",
    ],
  },
  {
    version: "0.25.0",
    date: "2026-07-21",
    items: [
      "Kimi `K3` now lets you dial its brainpower with a full `low / high / max` thinking ladder, and you can switch thinking off entirely for quick asks. On the Kimi Code plan it starts at the friendlier `high` default, so your usage stretches further without you lifting a finger.",
      "GG now just gets on with it. I retuned its marching orders so it stops asking permission for safe, reversible steps and powers through to a verified finish. Fewer pauses, more done.",
      "Giant sessions stay on the rails. I fixed a compaction bug that could overshoot the context window on monster turns, so long hauls now compress cleanly instead of derailing mid-task.",
      "Resuming a project tells the truth now. If a session cannot resume, the `project picker` shows the real reason right there instead of leaving you staring at a loading screen that never arrives.",
    ],
  },
  {
    version: "0.24.5",
    date: "2026-07-21",
    items: [
      "Every interface GG Coder builds now starts with accessibility as a hard requirement. I made `WCAG 2.2 AA` and `ADA-aligned` design non-negotiable across keyboard navigation, screen readers, contrast, motion, forms, media, zoom, and complete user flows. Better UI now means more people can actually use it.",
    ],
  },
  {
    version: "0.24.4",
    date: "2026-07-21",
    items: [
      "GG Coder's `UI skill` just got pickier about color. I taught it to reject the muddy red-on-red and green-on-green `status pills` AI loves to repeat, then choose styling that actually fits your product instead of forcing another template. Your interfaces get cleaner without all looking the same.",
    ],
  },
  {
    version: "0.24.3",
    date: "2026-07-21",
    items: [
      "Interfaces GG Coder builds just got a serious taste upgrade. I taught the `UI skill` to lock navigation and content to one clean rail, give `dropdowns` proper breathing room, and kill sticky click outlines without sacrificing `keyboard focus`. The tiny details finally behave like they belong together.",
    ],
  },
  {
    version: "0.24.2",
    date: "2026-07-20",
    items: [
      "Your conversations now clean up after themselves without disappearing. I keep the last `30 days`, squeeze quiet sessions after `7 days`, and cap runaway saved tool output at `40,000 characters`. You get your disk space back and every archived chat still resumes right where you left it.",
      "GG Coder refuses to melt down in the background now. I give the engine `5 retries`, then stop it cleanly, and cap each run's logs at `10 MB` so a bad crash can never spiral into a process or disk-space storm.",
    ],
  },
  {
    version: "0.24.1",
    date: "2026-07-20",
    items: [
      "Your chat history just got six times deeper. I expanded the picker from `5` recent conversations to `30`, so the thread you want is far less likely to disappear while coding history stays lean.",
    ],
  },
  {
    version: "0.24.0",
    date: "2026-07-20",
    items: [
      "Long answers no longer vanish at the finish line. When a model hits its output limit, I now resume it automatically up to `2 times` and warn you plainly if anything is still incomplete.",
      "GG Coder knows when it is stuck now. I taught it to spot repeating tool cycles up to `5 steps` long, break the pattern once, then stop cleanly and tell you exactly what is blocking it instead of burning time on endless retries.",
      "Your workspace has a real safety rail. I now block writes outside your project by default and stop catastrophic commands like `rm -rf /` before they run, while keeping normal cleanup commands flowing.",
      "Project rules land in the right order every time. I added `AGENTS.override.md`, nearest-folder precedence, a smart `32 KiB` budget, and tougher plan checks so GG Coder follows the instructions you actually meant without silently losing them.",
    ],
  },
  {
    version: "0.23.7",
    date: "2026-07-19",
    items: [
      "`Error Mom` got a sharper nose. I taught it to ignore routine `429` checks, cancelled requests, and harmless edit retries, so real failures stand out instantly and I can fix what actually interrupted you.",
    ],
  },
  {
    version: "0.23.6",
    date: "2026-07-19",
    items: [
      "When an `LLM`, tool, or specialist agent stumbles, I now get the full story automatically. I expanded `Error Mom` across every conversation path so I can trace those mystery `502` errors and squash them faster without asking you to reconstruct the crash.",
    ],
  },
  {
    version: "0.23.5",
    date: "2026-07-19",
    items: [
      "When GG Coder hits a snag, I can see it faster now. I wired in `Error Mom` monitoring so startup failures and unexpected crashes reach me automatically, helping me squash problems before they derail you again.",
    ],
  },
  {
    version: "0.23.4",
    date: "2026-07-18",
    items: [
      "`Anthropic` image-heavy chats are rock-solid now. I automatically resize oversized screenshots to the safe `2000px` limit, including images already buried in restored conversations, so long visual sessions keep rolling instead of dying on a surprise error.",
    ],
  },
  {
    version: "0.23.3",
    date: "2026-07-18",
    items: [
      "`GPT-5.6` long chats just got dramatically tougher. I squeeze huge conversations down before sending them and recover automatically when `OpenAI` briefly stumbles, so massive prompts, images, and tool-heavy sessions keep moving instead of crashing into that request buffer error.",
    ],
  },
  {
    version: "0.23.2",
    date: "2026-07-17",
    items: [
      "Long chats just got another serious efficiency boost. I taught GG Coder to learn each model's real token footprint, wait until `85%` before compacting, then carry a leaner `8K` recent tail forward. In my live torture test, total input fell `31%` with the answer intact.",
      "Monster command output is no longer a dead end. I save the full result for `48 hours` and point GG Coder straight to the missing slice, so it can recover one buried line without rerunning the whole command or stuffing your context twice.",
    ],
  },
  {
    version: "0.23.1",
    date: "2026-07-17",
    items: [
      "Your token bill on OpenAI models just took a serious haircut. I capped how much raw tool output a single turn can dump into context, so those runaway `400K` token spikes from parallel file reads are gone for good.",
      "Long sessions now clean up after themselves. I quietly drop stale file reads and ancient command output the moment newer versions exist, keeping conversations lean, cutting rebilled context by up to `60%`, and pushing full compaction much further away.",
      "`Autopilot` stopped double-checking itself. When Ken reviews your work he now owns the whole verification, so runs finish faster with one clean verdict instead of two overlapping reviews.",
    ],
  },
  {
    version: "0.23.0",
    date: "2026-07-17",
    items: [
      "`Grok 4.5` just joined the lineup. I wired in xAI's new flagship with a huge `500K` context window, image vision, and adjustable reasoning, so you can throw serious coding and knowledge work at it from day one.",
      "`Kimi` sign-in finally knows which wallet to use. I make OAuth your first choice, switch to your API key only when plan usage runs dry, then move you back automatically when it resets. No more crossed wires or fake dead-end limits.",
      "Huge sessions wake up fast now. I stopped `resume` from freezing the app for up to `30 seconds`, and long compactions keep going while the provider is still working instead of collapsing into a rough fallback.",
      "`Ideal review` now lands exactly where it belongs, before the answer you keep. I hide the scratch draft, show the review, then leave you with one clean final response.",
    ],
  },
  {
    version: "0.22.0",
    date: "2026-07-16",
    items: [
      "`Kimi K3` is here, and I made Moonshot's new flagship your default from day one. You get maximum reasoning, a massive `1M-token` brain, and native image plus video understanding, while `Kimi K2.7 Code` stays ready when you want the lean coding specialist.",
      "Your workspace tells you the truth at a glance now. I moved the project, `branch`, and live `uncommitted` file count into the title bar, so every window shows exactly where you are without stealing space from your tools.",
      "Your recent sessions stop multiplying and losing their names after long chats. I made titles and conversation identity survive `compaction`, then collapsed old checkpoints into one clean, resumable session.",
      "`Plan Steps` finally stays locked to the real plan while GG Coder works. I made it follow live edits, count completed steps honestly, and disappear the instant the run ends, so stale progress never hangs around pretending work is still moving.",
      "Your specialist crew now shows where every token really went, including fresh input, cached input, and output. I also tightened `Codex` tool results so oversized reads stop devouring the context your agents need to finish strong.",
    ],
  },
  {
    version: "0.21.1",
    date: "2026-07-15",
    items: [
      "`Ultra` specialists can survive an app restart and keep their place. I made child agents durable, reconnectable, and safe to continue, so long missions no longer vanish when a process hiccups.",
      "Cancel means cancelled now. I made `Esc` wait for the active run to settle before the app returns to idle, with a clear `Cancelling...` state and honest recovery if the provider refuses to stop.",
      "`Autopilot` now proves it actually checked every changed file. I tightened final review around real reads, edits, and diagnostics, so a green finish means the work earned it.",
      "Provider failures are cleaner and safer. I scrub secrets before they reach logs or sessions and replace broken `HTML` error pages with a useful status-aware message, so support is easier and your credentials stay out of the mess.",
      "`Context` tracking got sharper across every route and model. I taught GG Coder to use the right limits and timing evidence, so long sessions compact at the right moment instead of guessing.",
    ],
  },
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
