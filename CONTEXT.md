# Shared language

**Ultra (OpenAI)** — A local delegation preset, not an API reasoning level. Following `openai/codex` commit `4c9f42f4`, Astra/Sol send `xhigh` and proactively delegate; explicit Max still sends `max` through Codex. OpenAI children inherit the current parent's reasoning selection in both blocking and persistent paths, capped to a pinned model's supported levels and restored on fallback. Other providers retain their lowest-rung child policy. Thinking/model changes refresh the live delegation instructions as well as the request setting.

**Build-render-once** — GG Motion's working loop: ask the few things only the user knows, build the page in one go, look at a few stills, render once, deliver. No planning file, draft renders or checking pass; re-render only for something visibly broken.

**Motion study** — A short example demonstrating transferable motion decisions. It informs a build; it is not choreography to copy.

**Support skill** — Instructions for brand identity or source intake. It supports the video rather than adding another creative style or approval workflow.

**Input binding** — Mapping the user's text, fonts, colours, logos and media into the video. Required identity outranks taste.

**Flash screen** — The WCAG 2.3.1 check the final render runs on the finished file: no more than three flashes in any second. A file that fails is never delivered. It is a screen, not a certification.

**Feed loudness** — The final render's audio level for Reels, TikTok and Shorts: -14 LUFS integrated, peaks limited to -2 dBFS.

**Feed bands** — The parts of a tall 1080×1920 frame that Instagram, TikTok and YouTube Shorts cover on an ordinary post: the top 138 px, the bottom 422 px and the right 179 px from y 840 down. Words stay out of them; colour and imagery may run under them.

**Composition-level choreography** — Coordinated changes in attention, hierarchy, spatial relationships and visual state over time. Fixed framing and intentional holds are not universal defects.

**Production depth** — A legacy quick, standard or production preference retained for compatibility. It does not activate a review loop.

**Studio preferences** — Optional, validated user preferences and reference choices. They fill unresolved choices without overriding the user's explicit requirements or importing general coding-agent instructions.

**Job skill** — A Motion skill for one kind of video (a launch, an app walkthrough, a website video, a before-and-after, a developer tool video or one like the user's example). It adds that job's questions, ideas, moves and pitfalls to the `motion` skill's build steps. At most one is loaded per video.

**Idea pitch** — Two or three short concepts for the user's own subject, offered on the single upfront question card with "Let GG Motion choose". It gathers a preference; it is not an approval step.

**Handoff** — The element that survives a scene boundary and changes into the next scene (a box that becomes the next frame, a cursor that stays on screen, a stage opening from the subject).

**Move kit** — Motion's own seek-safe motion helpers (`library/kit/moves.js`): springs, arrivals, handoffs, contact, an operated camera and a cursor. Pure functions of time, not a look. Optional; plain GSAP is fine.

**Review-ready** — A legacy independent-review status, not a requirement or claim made by the normal Motion workflow.

**Checklist item** — One of Kleio Coder's built-in project health checks (tests, CI, security, design system and so on), defined once in `packages/ggcoder/src/core/checklist-items.ts`. The app's full-page Checklist shows automatically detected setup separately from recorded reviews; detected configuration is not a pass. The Agent setup button runs `/init` to create or update project instructions; it is setup, not an audit. All other checks are report-only: the agent changes no project file, and the `checklist` tool records the verdict, date, commit and evidence in `.gg-checklist.json` at the project root, which is shared through Git. Reviews state their scope and exclusions, and can also be recorded after checks requested in normal chat. A result is due again after 30 days. Not the same as a project task, which is work to do.

**Goal** — A long-running objective opened from Home's **Goals** button ("Bring p95 latency under 200 ms across the whole API"), bigger than one session. Each goal is a folder `goals/<id>/` in the agent directory holding `goal.json` (name, goal text, attached context folders/files by absolute path); that folder is the cwd of **Kleio Goals**, the goal's coordinator agent (`goals-agent/`): its own primary agent (not Kleio Coder), with its identity plus the goal brief as its system prompt and the context folders added as workspace roots. On first open the coordinator replies unprompted, once (`kickoffAt`): it briefs and asks questions, then asks the user to start before doing any work. Goal folders never appear in the project list. A goal has two phases: **briefing** (the coordinator asks questions; no work) and **active** (from `startedAt`, set when the user picks "Start the goal now"). An active goal's window can switch between the conversation and a **Workers** list showing the coordinator and each worker with what it is doing. Not a project (a folder you code in) and not a project task (one item of work).
