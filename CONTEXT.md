# Shared language

**Ultra (OpenAI)** — A local delegation preset, not an API reasoning level. Following `openai/codex` commit `4c9f42f4`, Astra/Sol send `xhigh` and proactively delegate; explicit Max still sends `max` on the Responses API. OpenAI children inherit the current parent's reasoning selection in both blocking and persistent paths, capped to a pinned model's supported levels and restored on fallback. Other providers retain their lowest-rung child policy. Thinking/model changes refresh the live delegation instructions as well as the request setting.

**Build-render-once** — GG Motion's working loop: ask the few things only the user knows, build the page in one go, look at a few stills, render once, deliver. No planning file, draft renders or checking pass; re-render only for something visibly broken. See ADR 0003.

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

**Move kit** — GG's own seek-safe motion helpers (`library/kit/moves.js`): springs, arrivals, handoffs, contact, an operated camera and a cursor. Pure functions of time, not a look. Optional; plain GSAP is fine.

**Review-ready** — A legacy independent-review status, not a requirement or claim made by the normal Motion workflow.

**Checklist item** — One of GG Coder's built-in project health checks (tests, CI, security, design system and so on), defined once in `packages/ggcoder/src/core/checklist-items.ts`. The app's full-page Checklist shows automatically detected setup separately from recorded reviews; detected configuration is not a pass. The Agent setup button runs `/init` to create or update project instructions; it is setup, not an audit. All other checks are report-only: the agent changes no project file, and the `checklist` tool records the verdict, date, commit and evidence in `.gg-checklist.json` at the project root, which is shared through Git. Reviews state their scope and exclusions, and can also be recorded after checks requested in normal chat. A result is due again after 30 days. Not the same as a project task, which is work to do. **Don't embarrass me** (`senior-review`, the Handover group) is the capstone item: it reviews the project as an experienced developer taking it over would, for rookie and unreviewed-AI tells. It points to the dedicated items rather than re-auditing their areas.

**Goal** — A long-running objective opened from Home's **Goals** button ("Bring p95 latency under 200 ms across the whole API"), bigger than one session. Each goal is a folder `~/.gg/goals/<id>/` holding `goal.json` (name, goal text, attached context folders/files by absolute path); that folder is the cwd of **GG Goals**, the goal's orchestrator agent (`goals-agent/`): its own primary agent (not GG Coder), with its identity plus the goal brief as its system prompt and the context folders added as workspace roots. On first open GG Goals replies unprompted, once (`kickoffAt`): it briefs and asks questions, then asks the user to start before doing any work. Goal folders never appear in the project list. A goal has two phases: **briefing** (GG Goals asks questions; no work) and **active** (from `startedAt`, set when the user picks "Start the goal now"). An active goal's window shows its **Goal world**: GG Goals and its workers as critters on a top-down farm, each at the place for what it is doing (bookcase: reading, fishing spot: searching, laptop: web, notes board: planning, carpenter's bench: editing, stove: running, post box: asking you, torii gate: arriving and leaving, tea bench by the fire: waiting). The header's Chat | Workers switch flips between the conversation and the farm. Not a project (a folder you code in) and not a project task (one item of work).

**Claude subscription (via Claude Code)** — How Claude Pro/Max plans run in GG Coder. Picking "Sign in with Claude" downloads Anthropic's official Claude Code build into `~/.gg/claude-code/<version>/` (sha512 pinned in `gg-core/src/claude-code/manifest.json`; never shipped in the app) and signs in with its own login under `~/.gg/claude-code/config`. `auth.json` holds only the marker `{"via":"claude-code"}`, never a token. Each agent turn runs through the Agent SDK's `query()` with GG Coder's system prompt and tools (`claudeCodeLoop`, served over the in-process MCP server `gg`), so Claude Code owns retries, compaction and caching on this route. Not the old spoofed Claude OAuth token (`sk-ant-oat…`), which is retired and asks the user to sign in again; not the Anthropic API-key route, which uses GG's own loop.

**ChatGPT plan (Continue with ChatGPT)** — How ChatGPT plans run in GG Coder: OpenAI's official Sign in with ChatGPT for open-source local apps (`gg-core/src/oauth/openai.ts`). The first sign-in registers GG Coder for that account (`dynamic_agent_client`, `agent_name_hint=GG Coder`, this machine's `ext_agent_host_id` from `~/.gg/openai-host-id`); later ones reuse the issued client from `~/.gg/openai-chatgpt-client.json`. The credential lives under `openai-chatgpt` with the issued `clientId`, the validated ID token and the granted scopes; without `chatgpt.tokens.use.direct` the sign-in fails with the choice to allow plan use or add a key. Requests go to the public `api.openai.com/v1/responses` with `store:false`, tools in the `gg` namespace and no `tool_search`. Not the old Codex token, which is a retired sign-in; not an OpenAI API key (`openai`), which takes over while the plan's usage is out.

**Plan key** — A subscription that connects by pasting a key rather than signing in: a Kimi Code plan key (`kimi-code`), a MiniMax M Plan key, a MiMo Token Plan key (`xiaomi`). Stored as an API-key variant marked `plan`, beside the provider's pay-per-token key (`payg`). Not every plan is allowed here: Z.AI limits the GLM Coding Plan to the tools it lists, so GLM keys use the standard pay-per-token endpoint.

**Retired sign-in** — A stored credential GG Coder no longer uses because it posed as another vendor's app or stopped working: the old Codex token in `openai`, `moonshot-oauth`, `xai-oauth`, the Google sign-in in `gemini`, and the old `sk-ant-oat…` Claude token (`RETIRED_SIGN_INS` in `gg-core/src/auth-storage.ts`, mirrored in `auth.rs`). It never counts as connected; the app and CLI ask once to reconnect, and connecting again or dismissing removes it.
