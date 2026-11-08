# Shared language

**Ultra (OpenAI)** — A local delegation preset, not an API reasoning level. Following `openai/codex` commit `4c9f42f4`, Astra/Sol send `xhigh` and proactively delegate; explicit Max still sends `max` through Codex. OpenAI children inherit the current parent's reasoning selection in both blocking and persistent paths, capped to a pinned model's supported levels and restored on fallback. Other providers retain their lowest-rung child policy. Thinking/model changes refresh the live delegation instructions as well as the request setting.

**Motion plan** — The short record of a video's concept, motif, palette roles, type roles and beat, written in the video's project record before building. The rendered frames are checked against it.

**Motion language** — The relationships between rhythm, typography, framing, transformation and continuity that give a video its character. It is independent of subject, palette or a universally mandatory effect. GG Motion's shipped guide describes principles, not a fixed house look.

**Motion study** — A short example demonstrating transferable motion decisions. It informs a plan; it is not choreography to copy.

**Support skill** — Instructions for brand identity, source intake or validation. It supports the video's plan rather than adding another creative style or approval workflow.

**Input binding** — Mapping the user's text, fonts, colours, logos and media into the video's plan. Required identity outranks taste.

**Single-pass output check** — One technical checking path that returns actual rendered images to the working agent for inspection. It is not an independent AI critique, creative approval score or repeated check of an unchanged export.

**Composition-level choreography** — Coordinated changes in attention, hierarchy, spatial relationships and visual state over time. Fixed framing and intentional holds are not universal defects.

**Production depth** — A legacy quick, standard or production preference retained for compatibility. It does not activate an automatic review loop.

**Action plan** — A description of opening state, focal action, resulting state and handoff for a scene.

**Studio preferences** — Optional, validated user preferences and reference choices. They fill unresolved choices without overriding the user's explicit requirements or importing general coding-agent instructions.

**Checked output** — The current export has technical results and rendered samples inspected against its plan and inputs. This is not human approval, full playback, audio listening or a guarantee of quality. Changed output needs new evidence; missing evidence or unresolved failure is draft/unverified.

**Review-ready** — A legacy independent-review status, not a requirement or claim made by the normal Motion workflow.

**Checklist item** — One of Kleio Coder's built-in project health checks (tests, CI, security, design system and so on), defined once in `packages/ggcoder/src/core/checklist-items.ts`. The app's full-page Checklist shows automatically detected setup separately from recorded reviews; detected configuration is not a pass. The Agent setup button runs `/init` to create or update project instructions; it is setup, not an audit. All other checks are report-only: the agent changes no project file, and the `checklist` tool records the verdict, date, commit and evidence in `.gg-checklist.json` at the project root, which is shared through Git. Reviews state their scope and exclusions, and can also be recorded after checks requested in normal chat. A result is due again after 30 days. Not the same as a project task, which is work to do.

**Goal** — A long-running objective opened from Home's **Goals** button ("Bring p95 latency under 200 ms across the whole API"), bigger than one session. Each goal is a folder `goals/<id>/` in the agent directory holding `goal.json` (name, goal text, attached context folders/files by absolute path); that folder is the cwd of **Kleio Goals**, the goal's coordinator agent (`goals-agent/`): its own primary agent (not Kleio Coder), with its identity plus the goal brief as its system prompt and the context folders added as workspace roots. On first open the coordinator replies unprompted, once (`kickoffAt`): it briefs and asks questions, then asks the user to start before doing any work. Goal folders never appear in the project list. A goal has two phases: **briefing** (the coordinator asks questions; no work) and **active** (from `startedAt`, set when the user picks "Start the goal now"). An active goal's window can switch between the conversation and a **Workers** list showing the coordinator and each worker with what it is doing. Not a project (a folder you code in) and not a project task (one item of work).
