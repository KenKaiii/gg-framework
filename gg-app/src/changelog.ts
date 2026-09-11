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
    version: "0.63.1",
    date: "2026-09-11",
    items: [
      "I cut the repeat interruptions from `verification` and `Autopilot`, so your agent can keep moving instead of proving the same work again. Background checks and builds that leave your code unchanged now get the credit they earned, while real errors still get caught. Progress notices show what is actually happening, without pretending every edit is the finish line.",
    ],
  },
  {
    version: "0.63.0",
    date: "2026-09-09",
    items: [
      "Your image toolbox just leveled up. I added `GPT Image 2.5 Flare` for fast creation and `Sunburst` for precise edits, plus `transparent backgrounds` so you can make artwork ready to drop into your project.",
      "Your words, sharpened without changing the mission. I tuned the `Prompt Enhancer` to keep your questions, details, and boundaries intact while respecting your selected model's settings. If a rewrite comes back empty or cut short, your original draft stays safe.",
      "Less stop-start while your agent codes. I moved `edit checks` into the background and streamlined `verification` follow-ups, so you get smoother progress and a final answer about your task, not a detour about the checks.",
      "No more waiting for a running preview to shut down. I fixed `dev-server readiness` waits so your agent can check the page when it is ready and leave the server running for you.",
    ],
  },
  {
    version: "0.62.1",
    date: "2026-09-08",
    items: [
      "Stay in your flow across windows and the `CLI`. I fixed a sneaky login glitch that could leave one session using an old login after another refreshed it, so you get fewer surprise interruptions.",
      "A little less baggage every time you open `GG Coder`. I moved `What's new` out of your workspace's startup load and stopped hidden input animations from ticking away, so the app does less busywork while you focus elsewhere.",
    ],
  },
  {
    version: "0.62.0",
    date: "2026-09-07",
    items: [
      "Big coding jobs now get a fresh pair of eyes. I gave `Ideal` an independent reviewer that reads your changes without the original agent's excuses, then sends real issues back for another pass before you get the final answer.",
      "Less spinning, more progress. I upgraded `loop detection` to spot failed retries even when the agent keeps changing the wording, so it can try a genuinely different approach. Your next prompt gets a clean slate, not yesterday's warning.",
      "Ask a question and get an answer, not a surprise testing detour. I stopped unfinished checks from dragging `Hook engaged` into your question-only turns, and made verification explain exactly why a check did not count.",
    ],
  },
  {
    version: "0.61.2",
    date: "2026-09-07",
    items: [
      "I killed the phantom `Hook engaged` interruptions. Ask a plain question right after opening the app and your answer now streams untouched, because verified work stays verified and checks piped through `tail` finally count as proof.",
      "A red test suite can never dress up as green again. Every command now runs with `pipefail`, so piping tests through `tail` still surfaces the failure and the agent has to actually fix it.",
      "No more endless `a check failed` loops. One stale failure no longer blocks every later green run: any fresh passing check on newer code clears the slate.",
      "Follow-up re-checks now answer in `one line`, not a wall. After a tiny change the agent confirms with a short delta instead of re-printing the whole checklist you already read.",
    ],
  },
  {
    version: "0.61.1",
    date: "2026-09-06",
    items: [
      "Your `CI` chip now tells the whole story at a glance. While jobs run it shimmers with quiet suspense, then settles to calm `green` on a pass or honest `red` the moment something breaks. No more guessing.",
      "Agents on `OpenAI` got sharper hands. I made every tool call ship in a strictly validated shape, so fewer calls bounce back with malformed arguments. That means fewer retries and less waiting for you.",
    ],
  },
  {
    version: "0.61.0",
    date: "2026-09-06",
    items: [
      "Stop hopping between tabs to see if your build passed. I brought live `CI` counts into your title bar: green clears after `10 seconds`, red stays until you dismiss it, and one click opens `GitHub Actions`.",
      "Passing tests should count, not cause a scare. I fixed checks that start with `git status` and stopped unfinished verification from masquerading as an app crash. You get `Unverified` when more checking is needed, not a bogus bug report.",
    ],
  },
  {
    version: "0.60.1",
    date: "2026-09-06",
    items: [
      "A green light should mean something. I tightened `Autopilot` so failed or unfinished checks stay `Unverified`, even after you reopen a chat.",
      "No more vanishing caveats. I kept `Steroids` review warnings in your chat history, so you can see when a review lacked a real-code cross-check.",
    ],
  },
  {
    version: "0.60.0",
    date: "2026-09-05",
    items: [
      "More models for you to try. I added `Gemini 3.8 Flash`, `Gemini 3.5 Flash Lite`, and experimental `DeepSeek V4 Flash Vision` to the picker. The new Gemini options still depend on Google enabling access for your account, so your working default stays put.",
      "Show `Qwen3.6-Plus` what you mean. I unlocked image and video input through `OpenRouter`, so you can bring screenshots and clips into the conversation instead of describing everything by hand.",
      "Your thinking controls now do what they promise. I lined up `DeepSeek` with its real reasoning levels and unlocked `max` for `Fugu Ultra`, so you can choose how hard they work on your problem.",
      "Long local chats have a better safety net. I made GG Coder respect the memory you actually gave `Ollama` or `LM Studio`, not the model's advertised maximum, so it can summarize before your loaded model runs out of room.",
    ],
  },
  {
    version: "0.59.1",
    date: "2026-09-05",
    items: [
      "The `Prompt Enhancer` is back on `GPT-6 Astra` and the whole `GPT-5.6` family. OpenAI's newest models refuse to run with thinking fully off, which was bouncing the enhancer and blanking the screen. I gave them a proper reasoning floor, and if anything ever fails again your draft stays put with a clear message instead of a white window.",
      "`Autopilot` on the new OpenAI models works again too, same fix. And the misleading warning that your ChatGPT account could not use a model is gone: I only show it when OpenAI actually says so.",
    ],
  },
  {
    version: "0.59.0",
    date: "2026-09-05",
    items: [
      "`GPT-6 Astra` actually runs now. OpenAI quietly gates Astra behind a newer client handshake, so the first build got bounced with a cryptic error. I upgraded the handshake, and Astra answers on your ChatGPT login with the full reasoning dial up to `ultra`. I also retired `GPT-5.5` from the picker so your OpenAI list is just the current lineup.",
      "Error messages finally talk to you like an app, not a terminal. Every provider hint now tells you to use the model selector or update GG Coder, never to upgrade some CLI you have never seen. The `AI Providers` sign-in page lists the real models for every provider too, Astra and Fable 5.1 included.",
      "Two chats compacting at the same moment on Windows could trip over each other. I fixed the lock so they take turns cleanly, and a real permission problem now surfaces instead of hanging forever.",
    ],
  },
  {
    version: "0.58.0",
    date: "2026-09-05",
    items: [
      "`GPT-6 Astra` is here, the day OpenAI shipped it. Pick it from the model selector with your ChatGPT login and you get OpenAI's most capable model yet, with a `1M` token memory and the full reasoning dial from low all the way up to `ultra`, where it proactively splits big jobs across helper agents and runs them in parallel. I wired it into the same caching and streaming path as the 5.6 family, so it feels instant from the first message. Astra is still rolling out on OpenAI's side, so if your account is not in yet, GG Coder tells you plainly and points you at what works today.",
    ],
  },
  {
    version: "0.57.5",
    date: "2026-09-04",
    items: [
      "Squashed a crash that could take the whole app down. If GG Coder tried to run a command in the background and the program behind it was not installed, the failure escaped and killed everything instead of being reported. Now it just tells you the command could not start and carries on like nothing happened.",
    ],
  },
  {
    version: "0.57.4",
    date: "2026-09-04",
    items: [
      "No more watching GG Coder nap. When it starts a build, a test run or an install in the background, it used to guess how long that would take and just sleep, sometimes a full `30 seconds` after the job already finished. Now it waits on the real finish line and picks straight back up the moment your command is done, so long jobs feel dramatically snappier and it can no longer talk itself into an idle loop.",
    ],
  },
  {
    version: "0.57.3",
    date: "2026-09-03",
    items: [
      "Every question GG Coder asks you now fits neatly in its card. Long options used to spill off the right edge of the chat and get cut in half, so you were picking between answers you could not fully read. Now they wrap cleanly, the `Recommended` tag stays pinned where it belongs, and nothing hides past the edge no matter how narrow your window is.",
      "I refreshed the engine room under the app and made the Windows build tell me the truth when something goes wrong. You get the same GG Coder, on fresher parts, with one more class of startup crash caught before it can ever reach you.",
    ],
  },
  {
    version: "0.57.2",
    date: "2026-09-03",
    items: [
      "GG Coder now builds from proof, not memory. Before it plans or writes anything nontrivial, it checks `Agent Steroids`, your local library of real, current open-source code, and copies the patterns that actually ship. If your library has no match, it goes and finds the right repos, asks you once, indexes them, and then builds from what it read. I ran it `16` times back to back on `GLM-5.3` to make sure it never skips this step. And if you have not installed Steroids yet, it will tell you exactly where the button is.",
    ],
  },
  {
    version: "0.57.1",
    date: "2026-09-03",
    items: [
      "Your Mac can breathe again. A user sent me a profile showing GG Coder's graphics process chewing `468%` CPU with `7` windows open, and I found the culprit: the ambient glow behind every window was being re-blurred by hand on every single repaint, cursor blink included. I rebuilt the glow so it costs almost nothing, keeps its soft look, and still shifts colour per window. Same vibe, a fraction of the power.",
    ],
  },
  {
    version: "0.57.0",
    date: "2026-09-02",
    items: [
      "Your agent stops writing last year's code. I plugged in `Agent Steroids`: a corpus of real, current open-source repos on your own disk that it reads before it writes, offline and with no rate limits. Hit the new `Steroids` button on Home to install it in one click, then run `/steroids` and I profile your project, hunt down the repos that match it, and index only the ones you pick.",
      "GG Coder now knows which platform CLIs you already have. It spots `31` tools like `railway`, `vercel` and `gh` in your project and drives them for logs, deploys and env vars instead of sending you off to a dashboard.",
      "Background windows finally sit still. Every decorative animation and canvas loop pauses the moment a window loses focus, so a stack of open projects no longer burns CPU and battery while you work in one of them.",
    ],
  },
  {
    version: "0.56.0",
    date: "2026-09-02",
    items: [
      "`Claude Fable 5.1` just landed and it is yours right now. Anthropic's newest and sharpest model, with a `1 million` token memory and thinking that dials itself up when the problem gets hard. Pick it in the model selector and go.",
      "The connect screen finally tells you the truth about what you are signing into. Every provider now lists the exact models you get, so `Z.AI` shows its Flash sibling and `OpenRouter` names the model it actually runs instead of hiding behind a label.",
    ],
  },
  {
    version: "0.55.5",
    date: "2026-09-02",
    items: [
      "Every question I ask you now looks the same: one clean stack of options, whatever I am asking. No chips on one question and rows on the next, no stray `Something else` link, no send button to hunt for. Answer in any order, change an early pick while you think about the rest, and the last answer sends it.",
      "Flipping `Autopilot` on and off finally feels as good as it sounds. The blocky sign and the flat black slab behind it are gone, replaced by one calm glowing line over your chat, and I muted the loud toggle chimes.",
      "Your files stay exactly where you put them. A repo can no longer hide a shortcut in a folder and trick me into writing outside your project, into things like `~/.ssh` or your shell config. If something does get blocked, I now tell you precisely which path redirected where.",
      "Hand me a new folder mid-chat and I actually know about it. `/add-dir` used to go unheard in my sessions, so I would turn around and refuse to work in the very folder you just gave me.",
    ],
  },
  {
    version: "0.55.4",
    date: "2026-08-31",
    items: [
      "No more double answers. When I double-check my own work before replying, my rough first draft used to slip onto the screen and sit there right above the polished one. Now you only ever see the final answer, and I stop repeating the same `reviewing` notice over and over while I dig through the files.",
    ],
  },
  {
    version: "0.55.3",
    date: "2026-08-29",
    items: [
      "You can now ignore my question and just tell me what you actually want. Typing your own reply instead of tapping an option used to leave me frozen for up to `10 minutes` before I even read it. Now your message reaches me instantly, the question card clears itself out of the way, and the chat holds perfectly still while it goes.",
    ],
  },
  {
    version: "0.55.2",
    date: "2026-08-29",
    items: [
      "My questions are clickable again. I had started slipping them back into the reply as a line of text, so you were stuck typing out an answer to something that should take one tap. Now every question I end on, even a casual `want me to also do this?`, opens the real question band with the options ready to pick.",
    ],
  },
  {
    version: "0.55.1",
    date: "2026-08-29",
    items: [
      "Your chat box finally sits still. Type all the way to the edge of the first line and it used to bounce up and down on every keystroke, yanking the text out from under your eyes. I taught it to make up its mind once and hold, so writing long prompts is calm again.",
      "The bar along the bottom feels smoother to use. Hovering `Thinking` or a model name no longer slaps an underline on it. The text just warms up brightly under your cursor and stays exactly where it is, so nothing twitches while you aim.",
    ],
  },
  {
    version: "0.55.0",
    date: "2026-08-29",
    items: [
      "I can finally just ask you a question. When I hit a real fork in the road, a question band opens right inside the reply with the options laid out, and I wait on your call instead of guessing and getting it wrong. Click an option, press its number, or hit `Something else` and type your own answer straight into the composer. No more coming back to find I picked the thing you did not want.",
      "GG Coder got a new look. Deeper, near black surfaces, a soft periwinkle accent, and a gentle glow that shifts with every window so no two ever feel like the same template. The glow also breathes while I work, so you can tell I am busy from across the room without reading a word.",
      "The composer feels like a real writing space now. `Send` lives in its own round button that becomes stop the instant I start running, and the box grows with your draft instead of jumping around under your cursor. I also dropped the bundled fonts for the ones your system already loves, so there is less to ship and less to load.",
    ],
  },
  {
    version: "0.54.0",
    date: "2026-08-28",
    items: [
      "My replies flow onto the screen now instead of stuttering. Text used to land in whatever clumps the network delivered, so it read like a typewriter with hiccups. I set my own steady pace and softly fade in each word as it arrives, so watching me work feels smooth no matter how fast the model bursts.",
      "`GLM-5.3-Flash` just joined the lineup. It reads your images natively, keeps the full `1M` context and the top thinking ceiling, and costs about a twentieth of GLM-5.3 with triple the plan quota. I quietly route background work like scouting and summaries through it too, so your GLM sessions stretch much further.",
    ],
  },
  {
    version: "0.53.12",
    date: "2026-08-27",
    items: [
      "No new buttons this time, just fresher foundations. I updated the core libraries GG Coder runs on, including `tokio` and `serde`, so the app stays current and steady underneath you while I build the next batch.",
    ],
  },
  {
    version: "0.53.11",
    date: "2026-08-26",
    items: [
      "Open a monster file and the app just shrugs. Reading something enormous could eat all the memory and take down every window at once, wiping out sessions that had nothing to do with it. I cap reads at `20 MB` now and hand back a clean answer instead, so one oversized log never costs you your work.",
      "Hitting stop is genuinely safe now. If you cancelled mid run, I used to report every unfinished step as though it never happened, so a `git push` that had already gone through could quietly fire a second time. I can finally tell never started apart from outcome unknown, and I say which one it was instead of guessing.",
      "A crash costs you far less. When the app went down mid save, the half written line used to swallow your next message with it, so you came back to find your own words missing from the `history`. I stitch that torn line back up on the way in, so the only thing lost is the one that was actually interrupted.",
      "Sneaky files cannot trick me into reading what you never opened. A `symlink` swapped in at the last instant could point me at something private sitting well outside your project. I refuse those at the door now, and I proved it by running the attack on myself first.",
      "Settings is leaner. I pulled the `Agent plugins` section out while it gets rebuilt properly, so there is one less half finished thing in your way.",
    ],
  },
  {
    version: "0.53.10",
    date: "2026-08-26",
    items: [
      "Typing a long prompt is dead steady now. The thread used to twitch up and drift back down on every line that wrapped, exactly the kind of tiny wobble that pulls you out of your thoughts. I made the chat settle in one smooth motion, so the newest message just sits there while you write.",
      "Start a fresh chat and it actually looks fresh. New sessions were opening with the last run's `token` count and timing still sitting under the box, like you had already asked something. That ghost is gone.",
      "You can trust a green check again. If I ever touch a test, a `tsconfig`, or a lint rule while fixing something, I now have to say so outright instead of letting a rigged check pass as proof. I locked my own instructions behind a snapshot too, so nothing about how I think shifts between releases without you seeing it.",
    ],
  },
  {
    version: "0.53.9",
    date: "2026-08-25",
    items: [
      "Write a long, multi-line prompt and your chat stays exactly where it should. Past the `3rd` line break the input box used to creep up and cover the newest messages, so you lost sight of the reply you were answering. Now the thread glides up with every line you add, no matter how long the prompt gets.",
      "Dropping images and videos into chat now works on `Windows` too. Those attachments were quietly vanishing before they ever reached the model. They land properly now, so you get a real answer instead of silence.",
    ],
  },
  {
    version: "0.53.8",
    date: "2026-08-24",
    items: [
      "Drop an image in the chat with a `GLM` model and it finally gets seen. I rewired attachments so they reach the real `zai vision` engine instead of a dead-end name, and gave slow, careful analysis room to breathe by lifting the cutoff from `60s` to `180s`. Big screenshots now come back with real answers instead of a timeout.",
    ],
  },
  {
    version: "0.53.7",
    date: "2026-08-24",
    items: [
      "Downloading models from `Hugging Face` finally just works. Loads of models used to refuse to install, and the ones that did could quietly hand you the wrong file: a vision add-on or a tiny helper model instead of the real thing. I fixed how GG Coder finds and picks the file, then checked it against the `66` most popular model repos. Every single one installs now, and it lands in your model dropdown the moment it finishes.",
      "The download progress is smooth as glass. That percentage and speed readout used to flicker and jump backwards while you watched it. Now it only ever moves forward, in one clean line: `161 MB / 18 GB`, speed, time left. When something does go wrong you get a straight answer, like being told you hit a rate limit and should wait a minute, instead of a wall of terminal gibberish.",
    ],
  },
  {
    version: "0.53.6",
    date: "2026-08-23",
    items: [
      "GG Coder just went on a diet. I found `3.4 MB` of test code riding along inside every install for no reason at all, and cut it clean out. Same power, lighter download, faster updates from here on.",
    ],
  },
  {
    version: "0.53.5",
    date: "2026-08-23",
    items: [
      "A booby-trapped web page can no longer hijack your agent. Attackers hide instructions inside characters that are completely invisible to you, then wait for GG Coder to read them and obey. I now scrub every one of those out of web pages and `MCP` tool results before GG Coder ever sees them, and it tells you when it caught someone trying.",
      "The safety sandbox finally keeps the promise it makes. It used to leave the `Docker` socket reachable by sandboxed commands, which is a straight shot at your whole machine, and on Linux it would quietly run with protections missing while still calling itself safe. Both are shut now, and your dev servers keep working exactly as they always did.",
      "No more hunting bugs you never caused. When GG Coder edits a file it now says plainly whether it `introduced` those errors or whether they were `already present`, so you stop chasing ghosts through code that was never the problem.",
      "Long sessions stop dying on you. When a provider rejects a request for being too big, GG Coder now learns the real limit and quietly fits inside it for the next `24 hours` instead of failing the exact same way on every turn after.",
    ],
  },
  {
    version: "0.53.4",
    date: "2026-08-23",
    items: [
      "GG Coder gets to the point now. Its answers had quietly grown into walls of text you stopped reading, because the length limit let bullet lists slide straight past it. I closed that loophole with one hard `120 word` budget nothing escapes, capped every bullet at a single line, and told it to skip the file names and jargon unless you actually need to open something. Same answers, a third of the reading.",
      "`Ken` now catches bad plans before a single line gets written. He used to wave through anything that looked reasonable, so a wonky design only showed itself once the code existed and cost you real time to unpick. Now he asks what you would ask: does every step deserve to be there, is anything split in the wrong place, does that order actually matter, and what happens on the paths nobody thought about. He still refuses to nitpick taste, so he only speaks up when something is genuinely off.",
    ],
  },
  {
    version: "0.53.3",
    date: "2026-08-23",
    items: [
      "`Autopilot` is back, and it is bulletproof. Yesterday's build had a bug that killed every single review the instant it started, so Ken never got to check your work and you just got an error. I found it, crushed it, and locked it down with a test so it can never come back.",
      "Your settings no longer lie to you mid task. The `Ken` model picker and the `Thinking` level looked clickable while GG Coder was working, but changing them did nothing to the run you were watching. Now they dim politely and tell you exactly why, so what you see is always what you get.",
    ],
  },
  {
    version: "0.53.2",
    date: "2026-08-23",
    items: [
      "GG Coder stops repeating itself at the end of a task. It used to hand you an answer, quietly send itself back to work, then hand you a second and even a third version of the same thing. Now you get one answer, once, and a clear `Hook engaged` note whenever it goes back to double-check its work.",
      "Answers land a lot faster too. GG Coder ran your tests with commands like `cd project && npm test` and then failed to notice it had run them at all, so it kept re-checking work it had already proven. That blind spot is gone, and the wait at the end of every task went with it.",
    ],
  },
  {
    version: "0.53.1",
    date: "2026-08-21",
    items: [
      "Your model picker never gets stuck again. If the model list lost a race while the app was booting, the dropdown could stay greyed out for the whole session with no way back. Now I retry until it loads, and if it ever is locked I tell you exactly why instead of just ignoring your click.",
      "Windows just got a lot smoother. I taught GG Coder to read the `Git Bash` style paths Windows hands back, so files it finds are files it can actually open. No more mystery failures on paths that looked perfectly fine.",
      "Reading the web is now dramatically cheaper. The new `outline` mode turns a page into a tight numbered map and follows links by number, cutting a six page research run from `16,402` tokens down to `1,936`. That is money straight back in your pocket.",
      "I hardened the sandbox. A sneaky repo could plant a shortcut in a cache folder and trick a later run into handing over write access to your whole machine, including your `SSH` keys. That door is now shut and locked.",
    ],
  },
  {
    version: "0.53.0",
    date: "2026-08-21",
    items: [
      "You can now fill your machine with models without leaving the app. Hit the new `Hugging Face` tile on the Connect page, search anything, click once, and I download it straight into `Ollama` with a live progress bar you can cancel. Fresh models appear in your picker instantly, no restart.",
      "Three heavyweights joined the roster: `Grok 4.6` with a new extra-deep thinking mode, `Gemini 3.7 Flash` at a full `1M` context, and the stable `DeepSeek V4 Pro 0813` build.",
      "Hugging Face accounts now plug in directly. One token unlocks hosted `Qwen3 Coder 480B` and `GPT-OSS 120B` with zero setup.",
      "The Connect page got a strict diet. One clean `Ollama` tile with its real logo, one-line descriptions everywhere, and none of the dead servers nobody used.",
    ],
  },
  {
    version: "0.52.0",
    date: "2026-08-20",
    items: [
      "New projects now launch fully loaded. Hit `Initialize Git` and I create your GitHub repo plus a hardened `CI` pipeline, `Dependabot` updates, branch protection, and an `AGENTS.md`, all matched to your exact stack. Any language, one click, zero config.",
      "Existing repos got a fast pass too. The new `/setup-ci` command audits what you already have or generates it fresh: leaner runners, quicker builds, tighter security. I even collapse expensive matrix legs and cancel stale runs so your CI bill stays tiny.",
    ],
  },
  {
    version: "0.51.0",
    date: "2026-08-19",
    items: [
      "GG Coder just got five new built-in superpowers, and they switch on by themselves. When a plan is fuzzy it reaches for `clarify`, builds test-first with `tdd` when you ask for it, chases stubborn bugs from red repro to real fix with `root-cause`, keeps your project's vocabulary tight with `shared-language`, and checks both what you asked for and how well it's built with `code-review`. No setup, no config, they just show up when the work needs them.",
      "It asks you better questions, way less often. I taught it the difference between facts and decisions: facts it now digs up on its own, and real decisions come to you as one batched list with a recommended answer next to each. The one-question-at-a-time interrogation drip is dead.",
    ],
  },
  {
    version: "0.50.3",
    date: "2026-08-18",
    items: [
      "GG Coder got a fresh set of guardrails, and it shows. It now treats your git history like the precious thing it is: no surprise commits, no force pushes, and it stops to ask instead of touching changes it doesn't recognize. It also refuses to make a failing test pass by weakening it, reproduces a bug before fixing it, and knows the difference between you asking a question and asking for a fix.",
      "The `kencode` superpower is now front and center. When building something nontrivial, GG Coder reaches for real code from `millions of GitHub repos` to see how it's actually done before writing a single line, instead of guessing from memory.",
    ],
  },
  {
    version: "0.50.2",
    date: "2026-08-18",
    items: [
      "GG Coder just dropped `120 MB` of dead weight. I found the installer quietly shipping a pile of files nothing ever reads and cut every last one, so each download is smaller and the app takes up way less room on your disk. Same power, way lighter on its feet.",
    ],
  },
  {
    version: "0.50.1",
    date: "2026-08-17",
    items: [
      "Big cleanup runs no longer stop dead halfway. I caught the `lean` specialist shutting down the very engine it runs inside, taking your session with it mid-task, and taught it to never touch its own host again. Long jobs now run to the end, every time.",
    ],
  },
  {
    version: "0.50.0",
    date: "2026-08-17",
    items: [
      "Two new specialists joined the crew. `lean` hunts down slow loads, memory leaks, and zombie processes in any stack, so everything I build stays fast and light. `durable` makes sure one bad migration or runaway script can't wipe you out, with verified backups and a guard on every destructive operation.",
      "The whole team got more proactive. Skills like `bulletproof` and the new duo now engage while I'm building, not just when you ask for a checkup, so the right patterns land from the very first line. Less rework, fewer surprises, better software.",
    ],
  },
  {
    version: "0.49.0",
    date: "2026-08-17",
    items: [
      "Finished now means proven. If the agent edits code, it literally cannot wrap up until it has run the tests or the typecheck after the last change, so `done` means `verified`, not `trust me`.",
      "Background builds stopped needing babysitters. The agent now gets woken the instant a build prints an `error`, a dev server says `listening`, or a task goes quiet on its own, instead of checking every few seconds. Faster reactions, fewer wasted turns, smaller bills.",
      "`Plan mode` got real teeth. Destructive commands like `git branch -D` and `find -delete` used to sneak past the read-only guard wearing a harmless disguise. I shut every door I could find, including sneaky flag clusters like `sort -ro`.",
    ],
  },
  {
    version: "0.48.3",
    date: "2026-08-17",
    items: [
      "Armor under the hood. I added release guardrails that prove prompt caching and session replay stay intact on every build, so long chats keep hitting the cache and cost less, and a resumed chat always replays exactly what really happened. Every release now clears `2,400+` automated checks before it reaches you.",
    ],
  },
  {
    version: "0.48.2",
    date: "2026-08-15",
    items: [
      "No more prompts that just vanish into thin air. Once in a while a model would come back with literally nothing, and GG Coder would quietly stop like nothing happened, leaving you staring at a dead chat. Now I retry it for you, and if the model truly ghosts, you get a clear `empty response` warning instead of silence. Even better, that blank reply used to poison the whole session so every message after it came back empty too. That is gone for good.",
    ],
  },
  {
    version: "0.48.1",
    date: "2026-08-15",
    items: [
      "Edits that used to kill a run now recover on the spot. Roughly `1%` of file edits came back garbled, and GG Coder would resend the exact same broken payload until `three strikes` ended your whole turn. I made the error tell it precisely what broke, so a long task stops collapsing seconds from the finish line.",
    ],
  },
  {
    version: "0.48.0",
    date: "2026-08-15",
    items: [
      "`GLM-5.3` just landed and it is a monster at coding. Z.AI says it is `50%` better at code than the model it replaces, and it is the strongest open model out there right now on real terminal work. I made it the one and only GLM you get, so picking a weaker sibling by accident is no longer a thing. Same `1M` context, same login, way more firepower.",
      "GLM thinking levels are finally real. Every level you picked used to secretly run at full blast, burning your quota and your patience on questions that never needed it. Now `low` truly is a quick think and `max` truly is a deep one, so you can spend big on the hard stuff and fly through the easy stuff. Nothing gets slower by default, you just got the dial you thought you already had.",
    ],
  },
  {
    version: "0.47.4",
    date: "2026-08-14",
    items: [
      "GG Coder now writes dramatically less code to do the exact same job. I taught it to think like a lazy senior dev getting paged at 3am: reuse what your repo already has, reach for the standard library, never bolt on a dependency for something a few lines can do. I benchmarked it head to head against the old brain with every single result executed against real tests, and it holds a `100%` pass rate while shipping `50-76%` less code and up to `38%` fewer output tokens. Smaller diffs, cheaper runs, far less to review. The one thing it will never trim is your safety net: validation, error handling, security and accessibility stay untouchable.",
      "No more watching an answer appear and then vanish. When GG Coder decides to double check its own work, it now knows that before it starts typing, so you only ever see the final reviewed answer land whole. `Zero` ghost drafts.",
      "Your queued messages now glide into the conversation instead of snapping into place, and the view stays pinned to your newest message while everything settles. I also fixed the chat box landing at the wrong height when you zoom with `Cmd +/-` or resize the window.",
    ],
  },
  {
    version: "0.47.3",
    date: "2026-08-13",
    items: [
      "You can now switch the meme GIFs on your home screen on or off whenever you want. Pop into `Settings` and you will find a new toggle right next to the sound effects switch. Your pick sticks across restarts, so your home screen stays exactly how you like it.",
    ],
  },
  {
    version: "0.47.2",
    date: "2026-08-13",
    items: [
      "Your home screen and wake screen no longer choke when you have multiple project windows open. I made each window pause its canvas the moment it loses focus, so only the window you are looking at is doing the work. No more black frames, frozen star fields, or matrix rain bunched into a corner when you restore a minimized window.",
      "Those meme cards on your home screen actually show up now. They were loading from a remote CDN that your app's own security policy blocks, so you were staring at blank cards. I bundled every `GIF` locally so they load instantly every time with zero network calls.",
      "Project-scoped MCP servers just got way less annoying. Adding a server to a repo's `.gg/mcp.json` now trusts that one project automatically. You never have to flip the global `trustProjectMcpServers` toggle and trust every repo on your machine just to use one project's tools.",
    ],
  },
  {
    version: "0.47.1",
    date: "2026-08-13",
    items: [
      "Your agent now has a locked front door. I sealed the internal connection between GG Coder and its engine so no other app or website on your machine can silently drive it, run commands, or touch your keys. What happens in your workspace stays in your workspace.",
      "Opening a project is now safe from booby-trapped repos. A repo's config files can no longer launch commands the moment you open them. If a project needs that kind of power, you flip it on yourself with `trustProjectMcpServers`.",
    ],
  },
  {
    version: "0.47.0",
    date: "2026-08-12",
    items: [
      "Attackers now use AI to find holes in your code at machine speed, so I stopped waiting to be asked about security. The new `bulletproof` skill hardens what you are building while you build it, on whatever you are actually making: a `CLI` tool, a desktop app, an iPhone or Android app, a smart contract, firmware, or an AI pipeline. It ranks by what actually breaks small teams, like a key left in your code or a page that quietly shows one customer another customer's data. And it will never tell you your code is `secure`, because nobody can promise that: you get what was checked, what got fixed, and what is still open.",
      "`/bullet-proof` is gone from your slash menu, and that is the upgrade. It only ever ran when you remembered to type it, which was usually after the risky code already shipped. The skill now shows up on its own the moment you touch a login, an upload, a payment, or a new dependency, and you can still just ask me if something is safe to ship.",
    ],
  },
  {
    version: "0.46.1",
    date: "2026-08-11",
    items: [
      "You never have to hunt for what I need from you again. When I get stuck on something only you can decide, that one question now lands in its own highlighted quote block at the very end of my reply. One question, never five. If you see that block, you know instantly that I am waiting on you.",
      "I stopped burying the answer in a wall of text. My replies now lead with what actually happened, cut the reasoning you cannot act on, and never re-explain something I already told you. Same work, a fraction of the reading.",
      "Jargon now comes with the stakes attached. I still use the real file name, the real command, the real setting, but the first time it shows up I tell you what it actually does or risks in the same breath. You get the precision without needing to know the codebase.",
    ],
  },
  {
    version: "0.46.0",
    date: "2026-08-11",
    items: [
      "Find out what you're legally missing *before* you launch, not after a demand letter. Ask GG Coder if your app is safe to ship and the new `compliance-guard` skill reads your actual code \u2014 your schema, your tracking scripts, your checkout, your uploads \u2014 then tells you what you owe in plain English, fixes what code can fix, and ranks the rest by what really gets small apps sued.",
      "It tells you straight when something can't legally ship. An `AI vet` that prescribes medication, cash prizes for spins, cashing out a wallet balance, cloning someone's voice without asking \u2014 these are licensed or banned, not to-do items, and you get told before the code gets written, with the version you *can* build.",
      "Skills stay out of your way now. They used to jump in whenever a task merely sounded like their topic; they now match the actual work, skip routine changes, and never reload themselves mid-conversation.",
    ],
  },
  {
    version: "0.45.4",
    date: "2026-08-11",
    items: [
      "Long runs stop dying halfway through. If anything else refreshed your login while your agent was working, every remaining turn used to fail with an `authentication error` until you restarted. Now each turn picks up your live credentials, and your windows quit logging each other out.",
      "A slow provider no longer ends your run. `Request timed out` used to escape straight to you as a dead end. Now it quietly replays the turn like any other blip and carries on.",
      "Your `MCP` tools can finally show pictures. A server sending back a screenshot, chart, or rendered diagram used to arrive as `(empty response)`, so your agent saw nothing at all. Those images now go straight to the model, sized to fit.",
      "A small touch up in the title bar: when your provider reports only one usage window, the meter stops pretending to be a button. No phantom hover, no click sound for a press that does nothing.",
    ],
  },
  {
    version: "0.45.3",
    date: "2026-08-10",
    items: [
      "The radio just grew a whole dark side. I added `14` new stations built to drop you into another world while you work: `The Dark Zone` for staring into the abyss, `Cryosleep` for zero-beat deep space, and `Nightride FM` when you want rain on neon. I streamed every single one before shipping it, so nothing in that list is dead air.",
    ],
  },
  {
    version: "0.45.2",
    date: "2026-08-10",
    items: [
      "When your provider or proxy throttles you, you finally see why. Errors buried inside a `200` response used to surface as a mystery stall, then quietly burn `10` retries that re-billed your whole prompt every time. Now the real reason lands straight away and your credits stay yours.",
      "Your conversation stops getting thrown away for no reason. A per-minute token limit used to look like a full context overflow, so your agent would compact your history, lose the thread, and still fail. Now it waits the limit out and picks up right where you left off.",
    ],
  },
  {
    version: "0.45.1",
    date: "2026-08-10",
    items: [
      "Your code map got a serious cleanup. Ask for a file's structure and you get a clean list that reads straight down the file, real declarations only. On one of my own files that took the outline from `89` cluttered entries to the `17` that actually matter.",
      "Now you can just say the name. No hunting for a line number first: give `code_nav` any function or class and it goes straight to where that lives and every place it gets used.",
    ],
  },
  {
    version: "0.45.0",
    date: "2026-08-10",
    items: [
      "Your agent now understands your code the way your editor does. It can `go to definition` and `find all references` across your whole project instead of guessing from text matches. Renames catch every caller and edits land where they should.",
      "Search stopped missing your files. It now looks inside folders like `.github` that it used to skip completely, leaves out the build junk your project already ignores, and runs nearly twice as fast while doing it.",
      "Smart code search finally speaks your language. I taught it `five` more: Python, Go, Rust, Java and C#. Describe what a function does and it finds the right one, even when you cannot recall the name.",
      "Every conversation got cheaper. I stripped out invisible baggage riding along with your requests and cut billed input by `15%` in my testing, and your agent still reaches for every tool it needs.",
    ],
  },
  {
    version: "0.44.0",
    date: "2026-08-09",
    items: [
      "Your agent now has a real crew. `Six` specialists ship with every install: `bee` builds things, `owl` maps your codebase, `researcher` digs through real docs, `worker` opens PRs, plus an auditor and a skeptic for security passes. They arrive ready to go and quietly refresh themselves with each update, so you never get stuck with a stale copy.",
      "Delegated work comes back sharper. Helpers used to get silently dropped onto the cheap model and handed a stripped down brief, so they missed things you would never accept from your main agent. Now they inherit your model by default and keep your project rules, tools, and environment, and I stretched their time budget so long jobs actually finish.",
      "Quitting means quitting. Closing a terminal or hitting `Ctrl+C` no longer leaves a stubborn background process clinging to its port when a slow plugin refuses to let go. Shutdown gets `5` seconds, then it exits for real.",
    ],
  },
  {
    version: "0.43.0",
    date: "2026-08-08",
    items: [
      "You can now sign in to `Grok` with your SuperGrok or `X Premium` subscription. No API key, no per-token bill, just log in and start building. Add a key as well and I will always spend your subscription first, then slide over to the key the moment your plan usage runs dry, and back again once it resets.",
      "Long sessions stay rock solid. I sealed a slow leak that ate system resources every time GG Coder reopened your archived chats, and background logs in `~/.gg` now tidy up after themselves instead of quietly growing on your disk forever.",
    ],
  },
  {
    version: "0.42.0",
    date: "2026-08-08",
    items: [
      "Your rank no longer stops at the top. I stretched the ladder from `50` levels all the way to `1000`, with `145` fresh rank names waiting past Singularity, from Starforge and Voidwalker to Omega and Origin. Every level you already earned stays exactly where it is, so you just keep climbing.",
      "The stat bars on your scorecard actually mean something now. Instead of sitting pinned at full forever, each one chases your next real milestone and empties the moment you smash it. Glance at your card and you can see exactly how close you are to `1K` commits or your next `60` day streak.",
    ],
  },
  {
    version: "0.41.2",
    date: "2026-08-07",
    items: [
      "Your chat window works properly again. My last update tried to get clever about how the conversation is drawn and got it badly wrong: messages went invisible, new replies never appeared, and the spacing at the bottom fell apart. I tore that change back out and put the solid original rendering back, so every message shows up exactly where it should.",
    ],
  },
  {
    version: "0.41.1",
    date: "2026-08-07",
    items: [
      "Killed a nasty crash that could poison a whole conversation. One stray half-emoji, from a model, a long file, or a wild terminal dump, used to make every single message after it bounce with a `Bad Request`, even after a retry or a model switch. I now clean it before it ever leaves your machine, and chats that were already stuck heal themselves on the very next message.",
    ],
  },
  {
    version: "0.41.0",
    date: "2026-08-07",
    items: [
      "Your chat window just got a lot lighter on its feet. I now only draw the part of the conversation you are actually looking at, so a full day of work costs about the same as five minutes of it. My heaviest window dropped from `753 MB` to `380 MB` and the scrolling stayed buttery.",
      "Giant command dumps no longer bury your chat. Anything long now folds into a neat preview with a `Show full output` button, so you skim the good part and open the rest only when you want it. Copy still grabs the whole thing, every time.",
    ],
  },
  {
    version: "0.40.1",
    date: "2026-08-06",
    items: [
      "I hunted down the last big memory hog: the chat window itself. Marathon sessions used to keep every message and every screenshot loaded all day, quietly swelling each window into the gigabytes. Now I keep just the newest `120` messages live and park the rest behind a tidy `Show earlier messages` button, so your chat stays complete while your memory stays yours.",
    ],
  },
  {
    version: "0.40.0",
    date: "2026-08-06",
    items: [
      "GG Coder just got dramatically lighter. I used to spin up a private set of background helpers for every single window, so four projects open meant four copies of everything doing identical work. Now they all share, and a four window session on my machine dropped from `3.3 GB` to about `900 MB`. Same speed, same features, far more room for everything else you are running.",
      "Projects you walk away from now hand their memory back. Leave one alone for `5 minutes` and I quietly release the code intelligence holding it, then spin it straight back up the moment you return. No more watching the app get heavier all day just because you opened something once this morning.",
    ],
  },
  {
    version: "0.39.5",
    date: "2026-08-05",
    items: [
      "I hold the thread on long sessions now. When a chat runs long enough that I have to compress my own memory, I lead with exactly what I was doing and what comes next, instead of burying it under a replay of everything you already said. Fewer dropped balls, less repeating yourself.",
      "That same memory got leaner. I stopped hoarding lists of every file I had glanced at and stopped stacking old summaries on top of each other, so more of my `memory` goes to your actual work and long chats stay sharp for longer.",
    ],
  },
  {
    version: "0.39.4",
    date: "2026-08-05",
    items: [
      "The `Choose a project` screen is back on its feet. I stopped `macOS` scratch folders from crashing the list, so your real projects load cleanly instead of leaving you staring at a black window.",
    ],
  },
  {
    version: "0.39.3",
    date: "2026-08-05",
    items: [
      "Every one of your projects is finally on the `Choose a project` screen. It used to only show the ones you had already opened with an agent, so most of your work was invisible. Now I read your project folders straight off disk and list the lot. On my own machine that took it from `31` projects to `97`.",
      "Spot something you never want to see in that list again? Hover it and hit the `\u00d7`. It is gone for good, and it stays gone next time you launch. Great for the scratch folders and stray temp directories that used to clutter the place up.",
      "The project list also opens noticeably quicker. I got it scanning everything at once instead of one folder at a time, so it lands almost `2x` faster even with a hundred projects to sift through.",
      "Skills now stick. When I load a skill to do a job properly, it can no longer get quietly dropped from my memory partway through a long session, so I keep working the way you asked all the way to the end.",
    ],
  },
  {
    version: "0.39.2",
    date: "2026-08-03",
    items: [
      "Watch me work inside your own editor. Every file I change now shows up as a proper side by side diff instead of a wall of text, and your editor follows along to the exact file and line I am touching. Reviewing my work just became a glance instead of a chore.",
      "My plan is now your live to do list. When I map out a job in `Plan Mode`, you see every step appear in your editor and tick off in real time as I finish them. No more wondering how far along I am.",
      "Your saved conversations are finally yours to manage from anywhere. Pick one back up right where you left it, close it, or delete it for good, all without leaving your editor. Each one even names itself from what you asked.",
    ],
  },
  {
    version: "0.39.1",
    date: "2026-08-03",
    items: [
      "Your phone remote and other `ACP` clients now show a live context meter. I report exactly how full the window is as the conversation moves, so you can see the room you have left instead of guessing. Best part: when GG Coder compacts a long session, you watch the usage drop on the spot, and a resumed chat shows its context the moment it opens rather than after the first reply.",
    ],
  },
  {
    version: "0.39.0",
    date: "2026-08-03",
    items: [
      "GG Coder can no longer tell you a check passed when it did not. I taught it to judge every command it runs, so a `--watch` that never finishes, a build that rewrites files, or a `--help` that proves nothing all get rejected as evidence. Only real, finished checks like `tsc --noEmit` count now.",
      "Your long sessions stay sharper for longer. When the conversation gets trimmed, I now pick what to keep based on what you just asked, so the error, the file, and the decision that actually matter survive instead of whatever happened to be most recent.",
      "You can install `Agent Plugins` straight from Settings. One portable file adds new commands and abilities, and I check every bundle before it lands so a bad one cannot touch anything outside its own folder.",
      "Gemini usage finally reads true. Its thinking tokens were quietly missing from your totals, so every long reasoning run looked cheaper than it was. Now the number you see is the number you pay.",
    ],
  },
  {
    version: "0.38.0",
    date: "2026-08-01",
    items: [
      "Your phone remote and other `ACP` clients now know every command GG Coder can run the instant a session opens. I wired in built-ins plus project favorites like `/commit`, with the exact descriptions and inputs you need, so command pickers are complete without brittle file scanning.",
    ],
  },
  {
    version: "0.37.5",
    date: "2026-07-31",
    items: [
      "Your longest conversations now reopen as the real back-and-forth, not a wall of generated memory. I rebuilt `ACP` session history to recover every older checkpoint, remove repeated tail messages and hide giant compaction summaries, while your agent keeps the lean context it needs to stay fast.",
    ],
  },
  {
    version: "0.37.4",
    date: "2026-07-31",
    items: [
      "Long research jobs no longer vanish at the finish line. If a `sub-agent` hits its time limit, I give it one focused `60-second` wrap-up to hand you everything it learned, and I stop helper agents from burying themselves in endless delegation. You keep the findings instead of getting an empty failure.",
    ],
  },
  {
    version: "0.37.3",
    date: "2026-07-30",
    items: [
      "Big autonomous jobs can now run longer without drowning in their own history. I taught `GG Coder` to clear away old research and bulky working scraps as it goes, so you get more useful context, fewer interruptions and a steadier finish on massive tasks.",
    ],
  },
  {
    version: "0.37.2",
    date: "2026-07-30",
    items: [
      "GG Coder now plugs straight into `ACP` editors like `Zed`. Run `ggcoder acp` and you get your real sessions, model controls, thinking levels, plan mode, streaming answers and clean cancellation right inside the tools you already use.",
      "Your longest chats are now much harder to lose or scramble. I rebuilt conversation compaction so your original request, newest work and approved plan stay together, reopening an old checkpoint always lands on the latest one, and two windows can no longer race each other into duplicate histories.",
    ],
  },
  {
    version: "0.37.1",
    date: "2026-07-29",
    items: [
      "Sub-agents are finally fast. Every single one used to sit there for a full `5 minutes` and then report failure, even when it had actually finished the job in seconds. Now they hand back their answer the moment they are done, so spawning a helper agent costs you seconds instead of stalling your whole task.",
      "When something does go wrong with a sub-agent, it tells you what happened. No more staring at `unknown error` wondering if it crashed, timed out, or got cancelled. You get the real reason in plain words.",
      "Fixed a rare loop where I would finish your task and then keep repeating the same final answer over and over. If I ever cannot double-check a file, I now just say so once and hand the work back to you.",
    ],
  },
  {
    version: "0.37.0",
    date: "2026-07-29",
    items: [
      "MCP servers can now ask you questions mid-task, and you answer right in the app. When a server needs a name, a choice, or a quick confirmation, a clean little form pops up instead of the whole task stalling out. You decide, it keeps going.",
      "Connecting a model now updates every open window instantly. Drop in an API key or finish a login and the new models show up in the picker right away, no more closing and reopening your session to see them. Disconnecting cleans them up just as fast.",
      "A crash no longer eats your work. I now save your session at every step, so if GG Coder dies mid-task everything it already did is still there when you come back, and it tells you exactly where things stopped.",
      "Images and screenshots just got a lot cheaper to send. A big `2000x2000` shot now costs about a third of the tokens it used to, with zero difference in what the model actually sees.",
      "Background tasks learned some manners. A chatty dev server used to burn around `2,000 tokens a minute` repeating that it was still running. Now it checks in early, then goes quiet, so your context stays free for real work.",
    ],
  },
  {
    version: "0.36.0",
    date: "2026-07-28",
    items: [
      "GG Coder now lives in your menu bar, so it is one click away even when every window is buried behind a fullscreen editor. Hit the little `G` and start a chat or a code session, flip `Remote` on and off, or jump straight into settings. It knows what you already have open: one window and it uses that one, several and it opens a fresh one instead of hijacking the work you are watching. When an update is ready, `Update now` appears right at the top.",
      "Every project gets its own colour now. A stack of identical dark windows turns into something you can read at a glance, with a coloured dot beside the project name and a matching tint along the top edge. The colour comes from the project itself, so it is the same on every window, every launch, every machine, and there is nothing to set up.",
    ],
  },
  {
    version: "0.35.0",
    date: "2026-07-28",
    items: [
      "Your `Claude Code` and `Codex` conversations are now sitting right in your session list, labelled so you can spot them at a glance. Click one and it opens here with the whole history, ready to keep going. No command to remember, no file to hunt down, no setup.",
    ],
  },
  {
    version: "0.34.0",
    date: "2026-07-28",
    items: [
      "Bring your old conversations with you. `/import` pulls a Claude Code, Codex or Cursor thread straight into GG Coder and you carry on where you left off, full history intact. I tested it on a real `44` message thread and it picked up mid sentence.",
      "I stopped saying done when I was not. If I kick off your tests or a build in the background and never actually read the result, I now go back and check before I hand the work over. No more cheerful all good sitting on top of a failed build.",
      "Ask me what I can do and get a straight answer instantly. Your tools used to look missing for the first few seconds while everything booted up, so I would tell you a capability did not exist when it did. I remember them between launches now, so the answer is right from the very first message.",
    ],
  },
  {
    version: "0.33.1",
    date: "2026-07-28",
    items: [
      "Reopen a chat and everything sits exactly where it happened. Errors, `Ken` verdicts and plan banners used to pile up at the bottom of long conversations, sometimes `900` messages below where they belong. I went through every one of your saved chats and fixed the lot, old ones included.",
      "No more seeing the same thing twice. When `Autopilot` hands me a job, reopening that chat used to show its instruction again as raw text underneath. Now you get the one clean handoff, exactly like you saw it live.",
      "Your slash commands stay looking like commands. Reopen a chat and `/release` is still a neat little chip instead of the giant prompt hiding behind it, even after you have edited that command since.",
    ],
  },
  {
    version: "0.33.0",
    date: "2026-07-27",
    items: [
      "Keep typing while I work. Messages you send mid-run now line up above the composer, and you can pull any one of them back out with a single `x` before I get to it. Change your mind, change the plan, no waiting.",
      "You can finally see the moment I pick a message up. The `queued` tag disappears the second I actually read it instead of hanging around until I finish the whole job, so you always know exactly where you stand.",
      "Fire off two things at once and nothing collides. I found a rare timing hole where two prompts landing together could kick off two runs on the same chat and trip over each other. Sealed shut.",
    ],
  },
  {
    version: "0.32.0",
    date: "2026-07-27",
    items: [
      "Put me on a timer. Type `/schedule check the railway logs and fix any issues | 15m` and I will run that prompt every 15 minutes, on my own, until you tell me to stop. Add a number like `| 10` if you only want ten runs. Your live schedules sit in the footer with a countdown and a stop button, and I never pile two runs on top of each other.",
      "I stopped writing my own history book. Last release I started keeping notes in `.gg/memory.md`, and being honest with you, it backfired: it repeated what your code already says, and it made me trust my own notes instead of going and checking. It is gone. I read your real code every time now.",
      "Your slash commands got a proper home. They are called `plays` now, and typing `/` brings them up with every argument spelled out as you type, so you always know what goes where.",
    ],
  },
  {
    version: "0.31.0",
    date: "2026-07-27",
    items: [
      "Big jobs now run all the way to the finish. When I hit the turn limit but I am still making real progress, I get handed more turns and carry on from exactly where I was instead of stopping halfway through your task. If I am just spinning my wheels, I still stop, so you never pay for a loop.",
      "GG Coder remembers your project between sessions. When a long chat gets compacted I write down what happened in `.gg/memory.md`, so next time I already know what you asked for and what I changed. It is plain text right in your repo, so you can read it, fix it, or delete any line you disagree with. Turn it off any time in `Settings` or with `/memory-off`.",
      "No more waiting on background work. Finished helper agents and long builds now tap me on the shoulder the second they are done, so I react immediately instead of stopping to go check on them and burning your tokens doing it.",
      "Switching models mid-chat is clean now. I keep a proper record of which model did what, and I hold onto the cached part of your conversation right through the switch, so your next reply stays fast and cheap.",
    ],
  },
  {
    version: "0.30.0",
    date: "2026-07-27",
    items: [
      "Your own models are really here this time. `Ollama`, `LM Studio`, llama.cpp and vLLM get found on their usual ports with no setup, and I read each one's true context size straight off your server. A model that can't call tools gets greyed out with the reason instead of quietly wasting your turn.",
      "Picking a model is no longer a wall of names. Everything is grouped under its provider now, your local machine pinned at the bottom, so you spot the one you want instantly.",
      "Changed your mind about a folder? `/remove-dir` drops it from the workspace, and running it bare lists exactly what you can remove. Fire it off mid-run and I queue it up rather than losing it.",
      "Your usage bar stopped playing hide and seek. It used to vanish for minutes whenever the provider got moody about being asked, so now I hold the last real reading and tell you plainly when it's not fresh.",
    ],
  },
  {
    version: "0.29.0",
    date: "2026-07-26",
    items: [
      "Every model you already run on your machine now shows up in the picker. I look for Ollama, LM Studio, llama.cpp and vLLM on their usual ports, read each model's real context size, and refuse the ones that can't call tools instead of letting them waste your turn. No key, no cost, and you can add your own endpoint if you moved a port.",
      "You can save any chat now. Hover over the conversation and an `Export chat` button glides into the corner, one click drops a clean Markdown file wherever you want it, and I remember your folder for next time. It reads like a real document, not a machine dump.",
      "You can point me at a second folder without leaving your project. Run `/add-dir` and I work across both repos at once, with a `+1 root` badge up top so you always know what I can reach.",
      "You can lock down exactly which sites I am allowed to touch. Flip on the network allowlist in your settings and everything I fetch, search, clone, or install gets checked against your list first.",
      "Local and self-hosted models were silently losing their thinking. I now catch the reasoning no matter what the endpoint calls it, so you finally see the whole train of thought — and a model that doesn't reason never gets asked to.",
      "Local models get room to breathe. A big prompt on your own machine can take minutes to warm up, and I used to give up and retry forever. Now I wait it out, and a runaway search can no longer freeze me solid.",
    ],
  },
  {
    version: "0.28.3",
    date: "2026-07-25",
    items: [
      "Windows finally feels like home. Your projects and recent sessions show up the moment you open the app, and you stay signed in instead of landing on an empty picker. I was hunting for your files in a folder Windows never actually uses.",
      "Your work on Windows now genuinely saves. Every session write, resume, and archive was quietly failing behind the scenes, so your history could vanish when you closed the app. Nothing slips away anymore.",
      "Inline error checking is live on Windows. I spot type errors the instant I create them and fix them in the same turn, exactly like on Mac. Before this I was getting nothing back and never knew it.",
      "Your `MCP` servers connect on Windows. Anything set up through `npx`, which is very nearly all of them, died with a dead end error before it ever started. They boot properly now.",
      "No more black console windows flashing when you launch or quit. I also make sure a cancelled command takes its entire process tree down with it, so runaway dev servers stop quietly piling up in the background.",
    ],
  },
  {
    version: "0.28.2",
    date: "2026-07-25",
    items: [
      "Your specialist agents now research with real, live code instead of guessing from memory. Anything you point at `kencode-search` can finally reach it, so answers come back grounded in code that actually exists today. They were quietly cut off from it before.",
      "`/bullet-proof` got its sharpest reviewers back. The deep `auditor` and `skeptic` agents were being shadowed by weaker stand-ins, so your security reports now come from the real thing again. Anything you wrote yourself stays exactly as you left it.",
    ],
  },
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
