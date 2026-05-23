/**
 * Prompt-template commands — slash commands that inject detailed prompts
 * into the agent loop. Each command maps to a full prompt the agent executes.
 */

export interface PromptCommand {
  name: string;
  aliases: string[];
  description: string;
  prompt: string;
}

export const PROMPT_COMMANDS: PromptCommand[] = [
  {
    name: "goal",
    aliases: ["g"],
    description: "Create a programmatic goal loop",
    prompt: `# Goal: Programmatic Goal Loop

You are creating a durable Goal run: a programmatic control loop that lets the user rely on you while they are not watching. In this workflow, you remain the coordinator: keep yourself focused on the objective while worker agents build, instrument, diagnose, and gather evidence.

## User objective

The user's objective is in the command arguments. If the arguments are absent or too vague to identify an actionable objective, ask exactly one concise clarifying question and do not create a Goal run yet.

## Non-negotiable boundary: /goal creates a run, it does not do the work

The initial /goal invocation is setup/orchestration only. During this turn:

- Create or update the durable run and Goal tasks, then stop.
- Do not implement, fix, refactor, edit, or generate project artifacts for the objective yourself.
- Do not call subagent, the normal tasks tool, goals resume, or any action that starts workers, verifiers, or auto-continuation.
- Do not run the verifier or "just start" any task. Worker agents do implementation after the user explicitly starts the Goal from the Goal pane with (R).
- You MUST run every cheap local prerequisite check you identify before creating or updating the Goal. Do not leave a locally checkable prerequisite as unknown, and do not mark any prerequisite met unless you have checked it or have concrete non-secret evidence. If a check would mutate files, start a service, run a long process, launch a worker, or begin implementation, make it a Goal task or a blocked external prerequisite instead.

## Core mindset: goal-specific sensory proof

Do not default to ordinary tests, generic scripts, or broad simulations. First model what must be experienced for this specific goal to be trusted without the human present.

For each Goal, identify:

1. Intended experience — who or what must experience the result: user, customer, operator, developer, attacker, browser, device, API client, database, model, downstream system, or another relevant perspective.
2. Failure imagination — the goal-specific ways the result could appear done while still failing in reality.
3. Required senses/signals — the observations needed to detect those failures. Think in capabilities, not fixed tools: perception of rendered output, interaction, timing, persistence/state, external boundaries, adversarial/social pressure, generated artifacts, traces, comparisons, or other signals relevant to this objective.
4. Proportional instruments — local/free ways workers can capture those signals. The evidence portfolio should be as small as possible while still removing the important assumptions; do not simulate, script, screenshot, benchmark, or red-team anything unless that signal is relevant to this goal.
5. Completion rule — why the planned evidence would be enough to claim success, and what remains unproven or blocked.

Any examples you consider are inspiration, not a checklist. Borrow verification ideas from any domain when useful, but choose only the senses/signals that fit the user's actual objective.

## Coordinator responsibilities

1. Translate the user's objective into:
   - a short title,
   - the original goal text,
   - concrete success criteria that can be verified,
   - prerequisite checks,
   - an evidence plan describing the goal-specific sensory proof required,
   - harness or observability items that workers may need to build,
   - a verifier command when already obvious, otherwise a verifier description or task to define one.
2. Plan first; do not build during initial Goal creation. You must perform cheap local prerequisite checks needed to determine whether the Goal is blocked, but worker agents should build instruments, implementation changes, harnesses, diagnostics, and verifier commands after the user starts the Goal. If implementation work is needed, capture it as a Goal task instead of doing it yourself.
3. Before creating or updating the run, identify every prerequisite and check each one that can be checked locally with the available tools. Examples are non-exhaustive and should not anchor the plan: required credentials or permissions, local capabilities, app/runtime availability, fixture/assets/test data, devices/emulators, network or service access, or domain-specific inputs. Record checked prerequisites as \`met\` only with concise non-secret evidence, record failed local checks as \`missing\` with exact remediation, and leave \`unknown\` only for true external inputs that cannot be checked locally in this setup turn.
4. Prefer local/free capabilities already available in the project or environment. Do not require paid services, signups, new external accounts, private assets, or physical access unless unavoidable for this specific objective.
5. Only ask the user for true external blockers after checking what you can do yourself. If a missing input cannot be generated or verified locally, record the exact minimal prerequisite and ask once in chat; do not ask for broad lists of things you could inspect or create yourself.
6. Treat user-provided prerequisites as the first Goal item, named "User prerequisites" in the pane. The user may provide the missing value or instructions in chat. After they do, verify it locally without revealing secrets, then update the matching prerequisite to \`met\` with short evidence before any worker task runs.
7. Persist the run with the goals tool:
   - call \`goals({ action: "create", ... })\` once the objective is understood,
   - include success criteria, prerequisites, evidence_plan items, harness items, and verifier info,
   - the goals tool will also run each provided \`check_command\` before persisting; still do not rely on that as a substitute for thinking through and checking available prerequisites yourself.
   - if any prerequisite is missing, lacks check evidence, or is unknown because it cannot be checked locally, persist the run as blocked and ask the user for the exact missing thing once.
8. Add Goal tasks with \`goals({ action: "task", ... })\`. Do not use the normal tasks tool for this workflow. Each Goal task prompt must be standalone, mention the same project cwd, the specific goal slice, the sensory signals or evidence it must produce, any existing instruments it should reuse, and verification expectations. Avoid pure "investigate and report" tasks unless their prompt explicitly requires persisting concrete findings with \`goals({ action: "evidence", ... })\` and creating or updating the next implementation task from those findings.
9. Persist evidence with \`goals({ action: "evidence", ... })\` whenever workers create diagnostics, build or run instruments, capture artifacts, record controller decisions, attach verifier output, or learn a blocker.
10. Completion means verifier evidence satisfies the original success criteria and the required sensory proof. Do not call \`goals({ action: "complete" })\` merely because tasks are done; only complete after verification passes.
11. When the Goal reaches a terminal state, give the user a specific final summary in chat. Do not collapse the outcome into one generic row or say only that it "verified." Use a compact 3–4 column table with one row per substantive Goal task, evidence path, success criterion, verifier result, blocker, or decision. For bug/fix/audit goals, include the problem, how it was proven real or wrong, what fixed it, and the exact verification. For creation/improvement/non-problem goals, substitute the requested outcome or gap, what was delivered or decided, and the exact proof that the intended experience now exists. Include small snippets when useful: file:line references, command names and exit codes, short before/after text, log excerpts, artifact paths, or verifier output summaries. Do not dump worker logs; quote only the few details needed to make the conclusion auditable.

## Loop semantics

Initial /goal turn order: understand intended experience → imagine relevant failures → choose required senses/signals → plan proportional instruments → persist the run/tasks/evidence plan → stop.

After the user starts a Goal from the Goal pane with (R), worker and verifier completions are sent back to you as hidden synthetic events. On each event, call \`goals({ action: "status", run_id })\`, inspect current state, briefly say what you are doing as the coordinator so the chat shows progress, and take the next durable control-loop action rather than merely narrating. The UI keeps auto-continuing until the run is passed, blocked, paused, or failed. Even during auto-continuation, do not switch into hands-on implementation; if work is needed, create or update Goal tasks and let workers/verifiers do it.

If no verifier command exists yet, create a task to define one. If an evidence path or harness is only planned, create a worker task to build the missing instrument, then later workers can reuse that instrument for subsequent slices. If the verifier fails, persist the failure evidence and add the next Goal task that addresses the failure. Cap runaway loops by pausing and recording evidence when repeated attempts stop making progress.

## Final response

When initially creating the Goal, keep the response short: say whether the Goal was created, ready, or blocked; mention the exact missing prerequisite if blocked; and tell the user they can press Ctrl+G to view it. Then stop. Do not continue into implementation, worker startup, verifier execution, or Goal resume. If they ask how to start it, tell them the Goal pane keybind is (r) to run it. When auto-continuation eventually passes, fails, blocks, or pauses the Goal, provide the specific multi-row final summary table described above, with concrete proof snippets instead of a generic "verified" claim.`,
  },
  {
    name: "scan",
    aliases: [],
    description: "Find confirmed dead code only",
    prompt: `# Scan: Confirmed Dead Code Review

Find dead code in this codebase. Do not look for bugs, security issues, performance issues, style issues, or refactors. This command is report-first: do not edit or delete anything until the user chooses an option at the end.

## Phase 1: Parallel dead-code search

Spawn exactly 3 sub-agents in parallel using the subagent tool (call the subagent tool 3 times in a single response), each with a different validation angle:

**Agent 1 - Static Reachability**: Check exports, imports, call sites, route registration, command registration, component usage, tests, package entrypoints, and public API surfaces. Identify candidates only when references appear absent or unreachable.

**Agent 2 - Runtime & Dynamic Usage**: Check dynamic loading, reflection, string-based references, plugin systems, CLI commands, routes, config keys, generated-code hooks, framework conventions, side-effect imports, and files used outside TypeScript import graphs.

**Agent 3 - Historical & Boundary Safety**: Check git history, package manifests, build configs, docs, examples, scripts, CI, release artifacts, and external-facing filenames/API names that may be consumed by users even if unused internally.

Each sub-agent must return only candidates with file:line ranges, estimated line counts, validation evidence, and reasons removal may be unsafe. Finding nothing is valid.

## Phase 2: Main-agent validation

For every candidate, validate it yourself before reporting it:

1. Search for references with grep/find and language-aware patterns where possible, including exact symbol names, filenames, route names, config keys, CLI command names, test names, and documented examples.
2. Check exports and package/public entrypoints before marking anything removable.
3. Check framework conventions and dynamic lookup risks before marking anything removable. Use official docs when a framework/tool convention could imply usage without direct imports.
4. Check whether removing it would change public API, CLI behavior, routes, config support, migration behavior, generated artifacts, docs examples, tests, or side effects.
5. For code-level removal tasks, kencode search is secondary: use it only to verify framework/tool conventions or common generated-code patterns that could make code appear unused locally. Do not treat absence from public code search as proof that local code is dead.
6. If evidence is incomplete, mark safety as Low or drop the finding.

## What counts as dead code

Report only code that is validated as one of:

- **Unused file**: no imports, no entrypoint references, no dynamic/framework usage, no public/exported contract.
- **Unused export**: exported but not referenced internally or by package entrypoints, and not part of documented/public API.
- **Unreachable branch**: condition/path cannot execute based on current code and config.
- **Obsolete artifact**: stale script/config/example/generated artifact no longer referenced by build, docs, package manifests, or CI.
- **No-op code**: code executes but has no observable effect and no intentional placeholder/documentation purpose.

Do not report:
- Public APIs, package exports, CLI commands, routes, config keys, migrations, docs examples, tests, generated-code integration points, or plugin hooks unless you can prove they are obsolete.
- Code only unused in the current test suite.
- Code that might be used through strings, framework conventions, side effects, or external consumers.
- Anything you are not confident is safe to remove.

## Safety labels

- **High**: Strong evidence from static references, entrypoints, configs, docs, tests, and dynamic-use checks; removal is likely safe.
- **Medium**: Probably dead, but one boundary or dynamic-use risk remains; remove only with targeted verification.
- **Low**: Suspicious but not proven; do not remove without more investigation.

## Final output

Output one concise table, prioritized by safety and impact. No prose before the table.

| Priority | Location | Lines | Dead-code type | Evidence | Safety to remove | Recommended action |
|---|---|---:|---|---|---|---|
| P0/P1/P2/P3 | file:line-line | N | unused file/export/branch/artifact/no-op | one sentence | High/Medium/Low | Remove / Investigate / Keep |

Priority guide:
- **P0**: High-safety removal with meaningful line or complexity reduction.
- **P1**: High-safety small removal, or Medium-safety meaningful cleanup.
- **P2**: Medium-safety small cleanup; needs targeted verification.
- **P3**: Low-safety candidate; keep unless user wants deeper investigation.

Rules:
- Put High safety rows first, then Medium, then Low.
- Keep each table cell short.
- If no confirmed dead code is found, output one row saying none found and set action to \`Keep\`.
- Do not recommend deletion for Low-safety rows.

After the table, ask exactly:

What should I do?
A) Create tasks to remove all High-safety dead code
B) Create tasks to remove only top priorities
C) Skip

Do not start deleting or editing until the user chooses.

If the user chooses A or B, do not remove code directly. Instead, use the tasks tool to create one task per selected removal or tightly coupled removal group, ordered by dependency and risk. Each task prompt must be standalone and include the exact locations, safety evidence, reference-search requirements, removal instructions, project verification commands, and instructions to prove the removal did not delete used code before marking the task complete. That proof must include fresh local reference searches after editing, relevant project checks/tests, and official-docs or kencode comparison only where framework/tool conventions or generated-code patterns could imply hidden usage. After creating tasks, tell the user exactly: "Tasks created. Press CTRL + T to open the Tasks Pane and press R to run all tasks." Do not begin executing them unless the user explicitly starts a task.`,
  },
  {
    name: "verify",
    aliases: [],
    description: "Review this codebase against real-world implementations",
    prompt: `# Verify: Codebase Real-World Check

Review this codebase's implementation against real-world code, not opinions. Start with changes from this conversation or \`git diff\` / \`git status\`; if there are no relevant changes, choose the most important implemented feature or module in the current project and review that.

## Phase 1: Parallel codebase review

Spawn exactly 3 sub-agents in parallel using the subagent tool (call the subagent tool 3 times in a single response), each with a different focus:

**Agent 1 - Implementation Shape**: Identify the main APIs, components, functions, file structure, state flow, and integration points. Return only concrete search anchors and candidate concerns.

**Agent 2 - Completeness**: Check whether the implementation appears to miss expected pieces: edge cases, cleanup, error states, validation, tests, configuration, accessibility, migrations, docs, or lifecycle handling. Return only concrete candidate gaps.

**Agent 3 - Divergence**: Look for unusual patterns, over-custom code, reinvented utilities, brittle abstractions, or choices that may differ from how mature projects solve the same problem. Return only concrete candidate divergences.

Each sub-agent must include file:line references and suggested literal search anchors for kencode search, such as imports, function names, hooks, props, config keys, or API calls. Do not report subjective style preferences.

## Phase 2: Real-world comparison with kencode search

After the 3 agents return, use \`mcp__kencode-search__searchCode\` yourself to verify or reject their candidates.

Search rules:
- Use literal code tokens, not conceptual phrases.
- Prefer imports, framework identifiers, config keys, hook names, component names, and API calls from this codebase.
- Use \`peek: true\` first when exploring, then fetch narrowed examples with repo/path filters when useful.
- Compare against multiple real repositories when possible; one repo is weak evidence unless it is an official or canonical implementation.
- If kencode search is unavailable or returns insufficient evidence, say that in the Evidence column and lower confidence.

## What to classify

Report only findings that fit one of these:

1. **Aligned** - The implementation matches consistent real-world practice. No action needed.
2. **Missing** - Real-world implementations consistently include something this code lacks.
3. **Divergent** - This code differs from common implementations in a way that likely matters.
4. **Better Elsewhere** - Real-world implementations solve the same problem more robustly or simply, with evidence.

Drop anything that is only taste, personal preference, or unsupported by code evidence.

## Final output

Output one concise table, prioritized by impact. No prose before the table.

| Priority | Type | Location | Finding | Evidence | Recommended action |
|---|---|---|---|---|---|
| P0/P1/P2/P3 | Missing/Divergent/Better Elsewhere/Aligned | file:line | one sentence | kencode evidence in one sentence | concrete action or \`None\` |

Priority guide:
- **P0**: likely bug, data loss, security risk, or broken integration.
- **P1**: important missing behavior or maintainability risk.
- **P2**: useful improvement backed by real-world evidence.
- **P3**: aligned/no-action observations.

Rules:
- Keep each table cell short.
- Put action-taking findings before aligned findings.
- If everything is aligned, output only aligned rows and set every action to \`None\`.
- If there is not enough evidence for any finding, output one row explaining that verification was inconclusive.

After the table, ask exactly:

Which should I do?
A) Create tasks to refine and adjust all
B) Create tasks for just top priorities
C) Skip

Do not start fixing until the user chooses.

If the user chooses A or B, do not fix directly. Instead, use the tasks tool to create one task per selected finding or tightly coupled finding group, ordered by dependency and priority. Each task prompt must be standalone and include the finding, affected local files/anchors, kencode evidence from the report, instructions to compare the approach with kencode search before editing, implementation instructions, project verification commands, and instructions to compare the final implementation with kencode search again before marking the task complete. After creating tasks, tell the user exactly: "Tasks created. Press CTRL + T to open the Tasks Pane and press R to run all tasks." Do not begin executing them unless the user explicitly starts a task.`,
  },
  {
    name: "expand",
    aliases: [],
    description: "Find high-value gaps by comparing this project to current alternatives",
    prompt: `# Expand: Current Competitive Gap Review

Find high-value gaps by comparing this project to similar, adjacent, and best-in-class repositories/tools/websites/services. This command is project-agnostic: infer what THIS project is before choosing comparisons. This command is report-first: do not edit, install, or implement anything until the user chooses an option at the end.

## Phase 0: Profile this project first

Before external research, inspect the local project and write a private working profile:

- What the project does, who it serves, and how it ships/runs.
- Core workflows, entrypoints, packages/modules, integrations, and user-facing surfaces.
- Existing features, security controls, developer tooling, docs, tests, release/ops setup, and architecture patterns.
- The most relevant comparison categories for THIS project. Do not assume this is an AI-agent app unless the repo proves it.

Use this profile to decide what kinds of external projects are relevant. If the user passed arguments to /expand, treat them as a focus area and prioritize that lens while still validating project relevance.

## Phase 1: Parallel expansion research

Spawn exactly 5 sub-agents in parallel using the subagent tool (call the subagent tool 5 times in a single response). Give each sub-agent the project profile and a different comparison lens. Adapt the lenses to the project, but cover these defaults unless clearly irrelevant:

**Agent 1 - Direct peers & product features**: Find actively maintained projects/tools/services closest to this project. Look for user-facing capabilities, workflows, integrations, onboarding, and monetizable/retention-driving features they have that this project lacks.

**Agent 2 - Security, privacy & recent incidents**: Find recent security/privacy hardening, dependency ecosystem changes, advisories, exploit mitigations, auth/session patterns, sandboxing, supply-chain defenses, and issue/PR fixes from comparable projects that this project should consider.

**Agent 3 - Architecture, code quality & implementation shape**: Compare code organization, APIs, extensibility, agent/runtime loops, data models, concurrency, error handling, configuration, plugin systems, and maintainability patterns. Include cleaner implementation ideas only when they produce concrete user/developer value.

**Agent 4 - Developer experience, ops & release maturity**: Compare tests, CI/CD, docs, examples, templates, telemetry/observability, migrations, upgrade paths, packaging, installation, local dev, debugging, and support workflows.

**Agent 5 - Ecosystem, trends & adjacent inspiration**: Look beyond direct peers to adjacent current tools, libraries, SaaS products, standards, RFCs, framework releases, and recent commits/releases that suggest important missing directions.

Each sub-agent must:

1. Use current sources: prefer repos/releases/commits/docs/articles updated within the last 6 months. Drop old or stale sources unless they are canonical and still actively maintained.
2. Return only candidates that appear absent or materially weaker in this project.
3. Include source names/URLs, freshness date (commit/release/article/doc date), and the local search anchors they used or recommend to verify absence.
4. Separate findings into useful categories for the final report, such as Security, Product, Architecture, Developer Experience, Operations, or Ecosystem.
5. Avoid generic wishlist items. Every candidate must be grounded in an external comparison and relevant to this project profile.

## Phase 2: Main-agent validation against this repo

For every candidate from the sub-agents, validate it yourself before reporting:

1. Confirm the external source is relevant to this project and fresh enough (normally within 6 months).
2. Search this repo with grep/find and language-aware anchors to check whether the feature/pattern/control already exists under another name.
3. Check manifests, docs, configs, package exports, routes, CLI commands, tests, CI, examples, and framework conventions before calling something missing.
4. Use mcp__kencode-search__searchCode when code-level comparison would clarify whether the external implementation is materially cleaner or more complete. Use literal imports, functions, config keys, CLI flags, route names, or package names — not conceptual phrases.
5. Drop anything already present, not applicable, too vague, too stale, or unsupported by evidence.
6. Keep the report short: prioritize the highest-value gaps over completeness.

## What counts as a reportable gap

Report only gaps that are:

- **Missing capability**: A relevant current peer has a feature, integration, workflow, or user-facing behavior this project lacks.
- **Security/privacy hardening**: A current source addressed a meaningful risk this project has not addressed.
- **Operational maturity**: A relevant project has CI, release, observability, packaging, migration, or support practices this project lacks.
- **Developer experience**: A relevant project has docs, examples, tests, debugging, local dev, extension points, or generated commands that would materially improve this project.
- **Implementation quality**: A comparable codebase handles a shared concern more simply, safely, extensibly, or robustly, and this repo lacks that pattern.
- **Ecosystem alignment**: A recent framework/API/standard/release changed expectations and this project has not caught up.

Do not report:

- Ideas not tied to a real current source.
- Things this repo already has, even if named differently.
- Stale comparisons with no activity in the last 6 months unless canonical and still relevant.
- Pure taste or style preferences.
- Massive rewrites unless there is a specific incremental gap to implement.
- Low-confidence guesses.

## Priority levels

- **P0**: Critical gap: security exposure, data loss risk, broken compatibility, major missing core workflow, or urgent ecosystem change.
- **P1**: High-value gap: important feature/hardening/DX/ops improvement with strong external evidence and clear fit.
- **P2**: Useful gap: meaningful but not urgent, or requires a scoped design decision before implementation.
- **P3**: Exploratory gap: promising but lower confidence or lower immediate impact. Use sparingly.

## Final output

Output separate category sections only for categories with findings. No prose before the first section. Each section must use a table with exactly these 3 columns:

| Repo/tool/source | Feature or gap | Priority |
|---|---|---|
| name + fresh date | concise gap, evidence, and why this repo lacks it | P0/P1/P2/P3 |

Rules:

- The table must have exactly 3 columns. Put source URL/date/evidence and local absence proof inside the first two cells, not extra columns.
- Sort rows by priority within each category: P0, then P1, then P2, then P3.
- Keep each cell concise but specific enough to be actionable.
- If no validated gaps are found, output one table row saying no fresh validated gaps were found.
- Do not include implementation prose after the tables except the options below.

After the tables, ask exactly:

What should I do?
A) Create tasks for all P0/P1 gaps
B) Create tasks for only the top priority gap from each category
C) Skip

Do not start implementing until the user chooses.

If the user chooses A or B, do not implement gaps directly. Instead, use the tasks tool to create one implementation task per selected gap, ordered by dependency and priority.

Each task prompt must be standalone and include:

1. The specific gap, including relevant local files/anchors and source evidence from the /expand report.
2. Instructions to compare the implementation approach with kencode search before editing, using literal code tokens and current real-world examples.
3. Instructions to implement the gap in the local codebase.
4. Instructions to verify correctness after implementation by running project checks and by comparing the final implementation with kencode search again before marking the task complete.

Do not create planning tasks, do not instruct tasks to use planning-only workflows, and do not create or write implementation plans from /expand selections.

After creating tasks, tell the user exactly: "Tasks created. Press CTRL + T to open the Tasks Pane and press R to run all tasks." Do not begin executing them unless the user explicitly starts a task.`,
  },
  {
    name: "bullet-proof",
    aliases: ["bp"],
    description: "Defensive security review — audit the project for exploitable weaknesses",
    prompt: `# Bullet-Proof: Defensive Security Review

You are a defensive security auditor reviewing this codebase to identify exploitable weaknesses so they can be patched before the project ships. Think rigorously about realistic threat scenarios — boundary checks, edge cases, race conditions, trust assumptions, supply-chain risks, agent-mediated paths.

Goal: harden this project against realistic threats. **Report only HIGH CONFIDENCE findings (≥0.8) with a concrete data-flow path that demonstrates exposure.** Better to miss theoretical issues than flood the report with noise.

This command is **dynamic and project-agnostic**. Recon drives everything. Do not assume the stack, the language, the deploy target, or that there is an LLM/agent layer. Read first, decide second.

## Phase 1: Recon — Understand THIS project before auditing anything

Spawn **FOUR recon subagents in parallel** using the subagent tool (call the subagent tool 4 times in a single response). Each has a narrow, independent slice so they can all run at once. **No vulnerabilities flagged in this phase.**

**Recon Agent A — Stack & Deployment.** Read manifests, lockfiles, CI/CD configs, Dockerfile/Helm/Terraform, deploy scripts. Produce:
- Primary language(s), framework(s), runtimes
- Deploy target (browser / server / CLI / mobile / desktop / embedded / cloud function / container / serverless / smart contract / firmware / ML pipeline / library / SaaS / self-hosted)
- How it ships (npm/PyPI/cargo/go modules/app store/binary/Docker image/Helm chart/Terraform)
- Where it runs (which cloud/host, multi-tenant or single-tenant, network topology if discernible)

**Recon Agent B — Trust Boundaries & Sources.** Walk entry-point code (route handlers, CLI argparse, queue consumers, WebSocket handlers, IPC receivers, MCP server handlers, file/env readers, deserialization entry, plugin loaders). Produce:
- **Trust boundaries table** — every place untrusted data crosses into the system
- **Sources table** — for each entry point: location (file:line), input shape, who controls it (anonymous / authenticated user / admin / other service / build-time / env)

**Recon Agent C — Sinks.** Walk dangerous-operation code. Produce a **Sinks table** with location (file:line) and sink type for: shell exec, SQL / NoSQL / LDAP / XPath queries, eval / Function / exec / pickle / yaml.load / Marshal / ObjectInputStream, file write, file include / require with dynamic path, network egress (fetch / requests / http.Get), auth decisions, secret reads, native deserializers, dynamic code load, smart-contract external calls, child_process spawns.

**Recon Agent D — Assets.** Scan for what is worth stealing or destroying. Produce an **Assets table** with location and asset type for: credentials / tokens (config files, env files, KMS, OAuth flows, ~/.{app}/auth.json-style stores), customer/PII data stores, source code with IP value, build/CI secrets, signing keys, model API tokens, on-chain funds / wallets, session state, MCP config files, license keys.

**After all four return, the main agent synthesizes:**
1. Assemble the four tables (Stack/Deploy, Sources, Sinks, Assets) into the recon report
2. Add the **Threat model** — concrete to THIS project, derived from the four agents' outputs. Who would realistically target it and what for? (Examples: supply-chain risks affecting downstream users of a library; multi-tenant abuse on a SaaS; untrusted user input on a CLI/mobile app; insider risk with repo access; phishing-based account takeover; coding-agent risks from injected web content; on-chain reentrancy risks for a smart contract.) Be specific.
3. Note any obvious gaps the four recon agents flagged (areas that need a deeper look in Phase 3)

## Phase 2: Plan the audit — recon drives this

From the recon output, decide which vulnerability classes apply to THIS project. **Skip audits with no entry surface.** A static documentation site does not get a SQLi audit. A Rust embedded firmware project does not get a prompt-injection audit. A Python ML pipeline does get pickle/yaml audits. A library that ships to others gets supply-chain weighted heavily.

Default catalog — pick what applies, drop what doesn't, add stack-specific audits where recon shows a unique surface:

| Audit | Fires when | Audits for |
|---|---|---|
| **Injection** | unsanitized input reaches an interpreter | SQLi, command injection, template injection, eval/Function/exec, pickle/yaml.load, NoSQL/LDAP/XPath injection, prompt injection |
| **AuthN/AuthZ/Session** | any auth, session, or access-control logic exists | broken access control (IDOR, BOLA), JWT alg confusion / alg:none, OAuth state/PKCE/redirect-uri abuse, session fixation, missing rate limit on credential checks, MFA bypass, TOCTOU races |
| **Secrets & exposure paths** | any secret/credential/token exists | hardcoded keys, logs/errors/debug-file leakage, source maps in published artifacts, telemetry leakage, prototype pollution exposing secrets, \`JSON.stringify(err)\` shapes, env dump in error pages, exposed \`.git\`/\`.env\`/\`.map\` |
| **Supply chain** | any dependency manager or external code | unpinned deps/actions, postinstall scripts, typosquats, **slopsquats (AI-hallucinated package names registered by malicious parties)**, dependency confusion, lockfile drift, install-time \`curl \\| sh\`, unsigned releases, unverified maintainer takeovers, self-spreading worms (Shai-Hulud family) |
| **CI/CD & build integrity** | any CI workflow, release pipeline | \`pull_request_target\` + checkout of PR HEAD (Pwn Request), Actions cache poisoning, OIDC token theft from \`/proc\`, self-hosted runner reuse, secret echoes, missing \`permissions:\` block |
| **SSRF, path traversal, file ops** | any URL/path/file built from input | SSRF to metadata endpoints (IMDSv1), path traversal, zip-slip, symlink races, unrestricted upload, archive extraction outside target dir |
| **Cloud/infra & misconfig** | any IaC, container, cloud SDK use | overpermissive IAM (\`Action:*\`, \`iam:PassRole:*\`), public buckets, IMDSv1, exposed K8s API/kubelet, presigned URLs without expiry, default creds, debug endpoints in prod, CORS \`origin:*\` + \`credentials:true\` |
| **Crypto** | any crypto/hashing/signing | weak algos (MD5/SHA1 for auth), missing IV, ECB mode, hardcoded keys, JWT \`alg:none\`, non-constant-time compare on secrets, predictable PRNG for tokens |
| **Agent surface** | only if recon detected LLM/AI/MCP/coding-agent/tool-calling code | indirect prompt injection via fetched content, MCP tool poisoning, tool-description injection (ToolLeak), system-prompt exposure via tool args, **Rules-File Backdoor (Unicode bidi / zero-width chars hiding instructions in CLAUDE.md / .cursorrules / AGENTS.md)**, malicious CLAUDE.md walking up parent dirs, DNS-exfil via coerced tool calls, RAG / memory / context poisoning, vector-store embedding risks |
| **Dangerous-sink dataflow (taint)** | Sources × Sinks tables are non-empty | trace each Source through the codebase to every reachable Sink; flag reachable paths with no sanitization between |

**Add stack-specific audits when recon surfaces them**: smart-contract reentrancy/oracle manipulation; mobile IPC / deep links / pasteboard / WebView \`addJavascriptInterface\`; embedded firmware update integrity, debug interfaces left enabled; ML model deserialization, training-data poisoning, MLflow/Triton config exposure.

## Phase 3: Parallel audits

Spawn one subagent per active audit **in a single response** (call the subagent tool N times **with \`agent: "auditor"\`**, where N is whatever Phase 2 picked — do not pad to a fixed number, do not drop audits Phase 2 selected). The \`auditor\` agent has the defensive-review persona and exclusion list baked in, so your task description only needs the vulnerability-class scope. Each auditor receives:
- The full recon output (Sources, Sinks, Assets, Threat model)
- Its specific vulnerability-class scope
- The 2026 threat reference at the bottom of this prompt

Each auditor must:
1. **Trace data flow** from Sources to Sinks for its class. Not pattern matching.
2. For every candidate, apply the **untrusted-input vs trusted-input** decision: is the input *actually reachable* by an untrusted source, or is it a settings constant / build-time string / hard-coded value?
3. Construct a concrete **vulnerability scenario** — describe how the weakness would be triggered (input → system response → resulting exposure). If you can't describe the steps, don't flag it.
4. Assign **confidence 0.0–1.0**. Drop anything <0.8 before returning.
5. Be framework-aware: ORM parameterization, auto-escape, memory-safe languages, JSX/template escaping all eliminate entire vuln classes. Don't flag what the framework already handles.

## Phase 4: False-positive filter

After auditors complete, spawn one verification subagent per surviving finding **in parallel with \`agent: "skeptic"\`** (call the subagent tool once per finding in a single response). The \`skeptic\` agent starts from "this is a false positive" and tries to disprove the finding — only confirmed findings survive. Pass each verifier the full audit finding (location, source/sink, vulnerability scenario, claimed confidence). Drop anything the skeptic returns as DROP; lower severity for DOWNGRADE.

**Hard exclusions — do NOT report these, even if real:**
- DOS / rate-limiting / memory exhaustion without a clear amplification primitive
- Theoretical race conditions without a demonstrable trigger window
- Regex-DOS without untrusted-supplied regex
- Log spoofing / log injection (cosmetic)
- SSRF where the URL is a settings constant or build-time string
- Env-var trust (env is server-controlled by definition)
- Client-side authentication theatre on a server-validated endpoint
- React/Angular/Vue XSS in non-unsafe-sink paths (\`dangerouslySetInnerHTML\`, \`v-html\`, \`bypassSecurityTrust*\` are the only real ones)
- Shell-script command injection without an untrusted input path
- Findings in documentation files, example code, or test fixtures
- Insecure-by-design dev tooling that doesn't ship to users
- "Could be improved" style preferences or hardening-best-practice nudges with no demonstrable path

## Phase 5: Report

Output one report. No code edits in this phase.

\`\`\`
# Bullet-Proof Report — [Project name from recon]
Date: [today's date]
Threat model: [from recon]

## Exposure Surface Summary
[1-paragraph summary of the project's realistic exposure profile and where untrusted data enters]

## Sources / Sinks / Assets
[Compact tables from recon]

## Risk Matrix
| Severity | Count | Definition |
|---|---|---|
| Critical | N | RCE, full auth bypass, credential theft, fund loss |
| High     | N | privilege escalation, data exposure with auth, supply-chain compromise |
| Medium   | N | limited-scope info disclosure, weakened crypto, partial bypass |

## Findings

### [BP-001] <title> — Critical
- Location: path:line
- Category: <slug>   CWE: CWE-XXX   Confidence: 0.95
- Exposure surface: <entry point from Sources>
- Source → Sink: <e.g. \`POST /api/foo body.userId\` → \`subprocess.run(..., shell=True)\`>
- Vulnerability scenario:
  1. Untrusted input <specific payload> reaches <source>
  2. Server processes it as <what>
  3. Result: <RCE / data exposure / auth bypass>
- Impact: <blast radius — what is exposed, how far it spreads>
- Fix: <concrete remediation, code-level>

[…repeat per finding, ordered Critical → High → Medium…]

## What was not flagged
[1-paragraph: which vulnerability classes returned zero findings, and how many findings the FP filter dropped — so the user sees the work, not just the survivors]
\`\`\`

## Phase 6: Ask before fixing

After the report, ask:

> Which (if any) should I fix? Options:
> - A) Create tasks for all Critical + High
> - B) Create tasks for specific findings (give IDs, e.g. "BP-001, BP-004")
> - C) Create tasks for a category (auth, supply chain, secrets, …)
> - D) None — report only

**Do not start fixing until the user picks.**

If the user chooses A, B, or C, do not fix directly. Instead, use the tasks tool to create one task per selected finding or tightly coupled finding group, ordered by severity, exploitability, and dependency. Each task prompt must be standalone and include the finding ID, vulnerability scenario, affected local files/anchors, concrete remediation, instructions to compare security-sensitive implementation details with kencode search or authoritative docs before editing, project verification commands, and instructions to compare the final fix with kencode search or authoritative docs again before marking the task complete. After creating tasks, tell the user exactly: "Tasks created. Press CTRL + T to open the Tasks Pane and press R to run all tasks." Do not begin executing them unless the user explicitly starts a task.

## Threat reference (May 2026)

Cite these as needed per audit. Do not dump them into the report — use them to verify whether a candidate is actually reachable.

**OWASP Top 10:2025** — A01 Broken Access Control (now includes SSRF), A02 Misconfig, **A03 Supply Chain Failures (new)**, A05 Injection (now includes prompt injection), **A10 Mishandling Exceptional Conditions (new — fail-open patterns)**.

**OWASP API Security Top 10 (2023)** — BOLA, Broken Auth, BOPLA, SSRF (API7).

**OWASP Top 10 for LLM Apps v2025** — LLM01 Prompt Injection (direct + indirect), LLM02 Sensitive Info Disclosure, LLM03 Supply Chain, LLM04 Data & Model Poisoning, LLM05 Improper Output Handling, LLM06 Excessive Agency, **LLM07 System Prompt Leakage (new)**, **LLM08 Vector & Embedding Weaknesses (new — RAG/embedding-store attacks)**, LLM09 Misinformation, LLM10 Unbounded Consumption.

**OWASP Top 10 for Agents 2026 (ASI01–10)** — Goal hijack, tool misuse, identity/privilege abuse, agentic supply chain, unexpected code exec, memory/context poisoning, inter-agent comms, cascading failures, human-trust exploit, rogue agents.

**Real 2024-2026 incidents — use as grep templates:**
- tj-actions/changed-files (Mar 14-15 2025, CVE-2025-30066, 23k repos) → unpinned GH Actions, \`uses: foo/bar@main\` / mutable tags, runner-memory secret dumps
- TanStack Mini Shai-Hulud (May 11 2026, CVE-2026-45321, CVSS 9.6 — 84 versions across 42 \`@tanstack/*\` + UiPath/Mistral/Guardrails/OpenSearch, 169+ packages total, "TeamPCP") → self-spreading npm worm, \`pull_request_target\` + cache poisoning + OIDC token extraction from \`/proc/<pid>/mem\`, persistent \`gh-token-monitor\` daemon
- Slopsquatting (ongoing 2025-2026, \`react-codeshift\` Jan 2026) → AI coding assistants hallucinate ~20% non-existent package names (open-source models ~21.7%, GPT-4 ~5.2%); malicious parties register the hallucinated names on npm/PyPI. **Verify every package actually existed BEFORE the agent suggested it** — check registry age, download history, author identity
- XZ Utils (CVE-2024-3094) → unverified maintainer takeovers, multi-year backdoor injection in install scripts
- Invariant Labs MCP hijack (May 2025) → MCP server returns malicious tool descriptions / crafted issue content
- Claude Code source-map leak (Mar 2026, 513k LOC) → \`*.map\` files in \`npm pack\` / shipped artifacts
- Embrace The Red DNS-exfil (Aug 2025) → coding agent coerced into encoding secrets in DNS queries
- IMDSv1 → AWS creds via SSRF (Mar 2025 campaign) → Terraform missing \`http_tokens = "required"\`
- GitGuardian 2026 — 28.6M GitHub secret leaks in 2025, 24k inside MCP config files

**Language-specific hot zones — only apply to languages actually present:**
- **Node/TS**: \`child_process.exec\`/\`execSync\`, \`spawn(..., {shell:true})\`, \`eval\`/\`Function\`, \`vm.runIn*\`, prototype pollution via \`lodash.merge\`/\`Object.assign({}, userJson)\`, \`serialize-javascript\`/\`node-serialize\`, source maps in published packages
- **Python**: \`pickle.load\`, \`yaml.load\` without \`SafeLoader\`, \`eval\`/\`exec\`, \`subprocess.*(shell=True)\`, \`os.system\`, \`Jinja2(autoescape=False)\`, \`flask.render_template_string(user_input)\`, \`requests(verify=False)\`, \`xml.etree\`/\`lxml\` without \`defusedxml\`
- **Go**: \`exec.Command("sh", "-c", userInput)\`, \`html/template\` vs \`text/template\` confusion, unbounded \`io.ReadAll\`, race-prone \`map\` access without lock
- **Rust**: \`unsafe\` blocks with raw pointers, \`Command::new("sh").arg("-c")\`, deserializing untrusted \`bincode\`/\`serde_pickle\`/\`serde_json\` with \`#[serde(deny_unknown_fields)]\` missing
- **Java/JVM**: \`ObjectInputStream\` deserialization, JNDI lookup (Log4Shell-style), \`Runtime.exec(String)\`, XXE in default XML parsers
- **Ruby**: \`eval\`/\`instance_eval\`, \`Marshal.load\`, \`YAML.load\` (not \`safe_load\`), \`Kernel#system\` with interpolation, mass assignment
- **PHP**: \`unserialize\`, \`eval\`, \`assert(string)\`, \`include $userInput\`, \`preg_replace\` /e modifier
- **C/C++**: unsafe \`strcpy\`/\`sprintf\`/\`gets\`, integer overflows, format strings (\`printf(userInput)\`), use-after-free, double-free
- **Solidity / EVM**: reentrancy, unchecked external calls, integer over/underflow (pre-0.8), \`tx.origin\` for auth, delegatecall to untrusted, oracle manipulation
- **Mobile (iOS/Android)**: insecure IPC / deep links / pasteboard, WebView \`addJavascriptInterface\`, exported activities/intents without permission checks, insecure local storage

## Rules

- **Recon first, audits second.** No audit fires without a recon-identified entry surface to justify it.
- **No pattern-only findings.** Every flag must have a Sources → Sinks path traced through the code.
- **No "could be improved" recommendations.** Either it's exploitable or it's not in scope.
- **Strict confidence gate (≥0.8).** Drop everything else, even if it looks suspicious.
- **Adapt to the stack, always.** The audit catalog and threat reference above are guidance, not a checklist to apply uniformly.
- **Report only.** Wait for the user to pick what to fix in Phase 6.`,
  },
  {
    name: "source",
    aliases: ["depcheck", "depsource"],
    description: "Plan, source-check, adjust, and verify dependency-aligned code",
    prompt: `# Source: Plan → Research → Adjust → Verify

Use exact installed dependency source as the source of truth, then align this project end-to-end. This command is action-oriented like /verify and /compare: plan the investigation, research with source_path, adjust the code, and verify everything before finishing.

## Phase 1: Plan the source check

Do a short, private plan before tool-heavy work:

1. Identify the dependency surface to check.
   - If the user passed args, treat them as the package/repo/spec plus optional focus area.
   - If no args were passed, inspect recent changes, changed files, imports, manifests, and current conversation context to pick the 1-3 dependencies most likely to matter.
2. Decide what “aligned” means for this run: APIs/types, exports, CLI flags, config schema, runtime behavior, lifecycle/cleanup, error handling, package subpaths, tests, docs examples, or UI/tool wording.
3. Decide the parallel research slices. Use up to 3 sub-agents; use fewer when the scope is obvious. Do not pad.

Do not ask the user for confirmation. Proceed unless the focus is impossible to infer.

## Phase 2: Research exact dependency source

For every in-scope dependency, call \`source_path\` before making claims about APIs, types, flags, config, exports, or runtime behavior.

Inspect the returned absolute source path with \`read\`, \`grep\`, \`find\`, and \`ls\`. Prefer dependency source files, package manifests, type definitions, exports, tests, examples, changelogs, and README sections inside that source checkout. Use web docs only when source alone is ambiguous.

Spawn the research sub-agents in parallel in one response when useful:

- **Local Usage Agent**: find local imports, wrappers, tool calls, config keys, CLI flags, tests, docs, and assumptions tied to the dependency. Return exact file:line anchors.
- **Dependency Source Agent**: inspect the exact source_path checkout. Return exact source file paths and authoritative facts about APIs, types, exports, lifecycle, errors, config, and gotchas.
- **Alignment Agent**: compare local assumptions to dependency facts. Return concrete mismatches, missing handling, stale usage, brittle assumptions, or simplifications backed by exact source evidence.

Every finding must include both local file paths and dependency-source file paths. Mark unproven items as \`aligned\` or \`inconclusive\`; do not turn them into fixes.

## Phase 3: Adjust the code

Validate every candidate yourself, then fix all confirmed issues directly.

Valid adjustments include:

- Correct wrong/stale API or type usage for the installed version
- Fix import/export/package-subpath usage
- Fix config keys, option shapes, CLI flags, or tool schemas
- Add missing lifecycle cleanup, abort handling, error handling, or edge-case handling proven by source
- Align local tests/docs/examples with the installed dependency source
- Align local tool prompts/TUI wording when they misrepresent dependency behavior
- Remove small custom workarounds when the installed dependency source shows a supported built-in path

Rules:

- Read each local file before editing it.
- Match neighboring local patterns and tone.
- Keep edits minimal and focused; no broad refactors.
- Do not upgrade dependencies unless the user explicitly asked for an upgrade.
- Do not edit just because upstream source uses a different style.
- If a formatter, codegen, or autofix mutates files, re-read before more edits.

## Phase 4: Verify everything

Run the relevant project checks for changed files. If this project specifies commands, use them. Otherwise infer from manifests. For TypeScript, run lint, typecheck, format check, and tests when available.

If verification fails, read the failure, fix it, and rerun. Do not report success with failing or unrun checks.

## Final response

Keep it short:

- Dependencies/source paths checked
- Adjustments made, or \`No changes needed — local usage aligns with installed source\`
- Verification commands run

Do not ask what to do next unless blocked by missing information or an external failure.`,
  },
  {
    name: "research",
    aliases: [],
    description: "Research best tools, deps, and patterns",
    prompt: `Research the best tools, dependencies, and architecture for this project.

First, if it's not clear what the project is building, ask me to describe the features, target platform, and any constraints. If you can infer this from the codebase, proceed directly.

Then spawn 6 sub-agents in parallel using the subagent tool (call the subagent tool 6 times in a single response, each with a different task). Every agent must verify ALL recommendations with current official docs, package registries, releases, or maintained source repositories - no training-data assumptions allowed. Use kencode search for architecture and implementation-shape comparisons where real code examples matter.

**Agent 1 - Project Scan**: Read the current working directory. Catalog what already exists: config files, installed deps, directory structure, language/framework already chosen. Report exactly what's in place.

**Agent 2 - Stack Validation**: Research whether the current framework/language is the best choice for this project. Compare top 2-3 alternatives on performance, ecosystem, and developer experience. Pick ONE winner with evidence.

**Agent 3 - Core Dependencies**: For EACH feature, find the single best library for this stack. Confirm latest stable versions. No outdated packages. Output: package name, version, one-line purpose.

**Agent 4 - Dev Tooling**: Research the best dev tooling for this stack: package manager, bundler, linter, formatter, test framework, type checker. Pick ONE per category with exact versions.

**Agent 5 - Architecture**: Find how real projects of this type structure their code. Look for directory layouts, file naming conventions, and key patterns. Output a concrete directory tree and list of patterns.

**Agent 6 - Config & Integration**: Research required config files for the chosen stack and tools. Cover: linter config, formatter config, TS/type config, env setup, CI/CD basics.

## Agent Rules

1. Every recommendation MUST be verified with a source URL/date - no guessing
2. Confirm latest stable versions from official registries or release pages - do not assume version numbers
3. Verify CLI flags, config keys, and file formats against official docs before recommending them
4. Pick ONE best option per category - no "you could also use X"
5. No prose, no hedging, no alternatives lists - decisive answers only

## Output

After all agents complete, synthesize findings into a single RESEARCH.md file:

\`\`\`markdown
# RESEARCH: [short project description]
Generated: [today's date]
Stack: [framework + language + runtime]

## INSTALL
[exact shell commands - copy-paste ready]

## DEPENDENCIES
| package | version | purpose |
[each purpose max 5 words]

## DEV DEPENDENCIES
| package | version | purpose |

## CONFIG FILES TO CREATE
### [filename]
[exact file contents or key settings]

## PROJECT STRUCTURE
[tree showing recommended directories]

## SETUP STEPS
1. [concrete action]

## KEY PATTERNS
[brief list of architectural patterns]

## SOURCES
[URLs used for verification]
\`\`\`

Write the file, then summarize what was researched and list the verification sources used. If any recommendation could not be verified from current official sources or maintained repos, omit it rather than guessing.`,
  },
  {
    name: "init",
    aliases: [],
    description: "Generate or update CLAUDE.md for this project",
    prompt: `Generate or update a minimal CLAUDE.md with project-specific context only: what this project is, how it is structured, and commands/workflows that are unique to it.

Do NOT add generic agent behavior already covered by the system prompt, including: read before edit/write, re-read after formatters, ask before destructive actions, no fake verification, generic code-quality advice, single-responsibility rules, one-file-per-component rules, or language-style conventions. Include only project-specific overrides or stricter local requirements.

## Step 1: Check if CLAUDE.md Exists

If CLAUDE.md exists:
- Read the existing file
- Preserve custom sections the user may have added
- Update only project-specific facts that are stale or missing
- Remove generic guidance that is already covered by the system prompt unless it is a deliberate project-specific override

If CLAUDE.md does NOT exist:
- Create a new one from scratch

## Step 2: Analyze Project (Use Sub-agents in Parallel)

Spawn 3 sub-agents in parallel using the subagent tool (call the subagent tool 3 times in a single response):

1. **Project Purpose Agent**: Analyze README, package.json description, main files to understand what the project does
2. **Directory Structure Agent**: Map out the folder structure and what each folder contains
3. **Tech Stack Agent**: Identify languages, frameworks, tools, dependencies

Wait for all sub-agents to complete, then synthesize the information.

## Step 3: Detect Project Type & Commands

Check for config files:
- package.json -> JavaScript/TypeScript (extract package-manager, build, lint, typecheck, test, format, and server scripts)
- pyproject.toml or requirements.txt -> Python
- go.mod -> Go
- Cargo.toml -> Rust

Extract exact commands that are useful project facts. Verify commands against local package scripts, manifests, Makefiles, CI, or documented project workflows; do not invent commands from convention alone. Do not restate generic "run checks after edits" behavior unless this project requires a stricter command sequence than the system prompt's Verification section.

## Step 4: Summarize Stable Structure

If useful, create a concise structure summary for future agents showing only key stable directories and files with brief descriptions. Do NOT embed generated symbol maps, exhaustive file indexes, generated repo maps, auto-generated directory listings, or large trees in CLAUDE.md.

## Step 5: Generate or Update CLAUDE.md

Create CLAUDE.md with only sections that add project-specific value. Prefer this structure:

- Project name and one-sentence purpose
- Key packages/apps/modules and what each owns
- Important project-specific architecture or workflow notes
- Exact local commands (install/build/check/test/dev/publish/deploy) when they are not obvious from package scripts alone
- Project-specific constraints that override defaults (for example required publish order, generated-file workflow, auth/secrets storage, deployment caveats)

Avoid generic sections named "Code Quality", "Organization Rules", or "How to Work" unless every bullet is specific to this project. Do not duplicate language style packs or generic verification rules. Do not add generated repo maps, symbol indexes, exhaustive file indexes, or auto-generated project inventories; CLAUDE.md must remain durable, agent-focused project context.

Keep total file under 100 lines. If updating, preserve any custom sections the user added. After writing, re-read CLAUDE.md and confirm it contains only project-specific facts supported by local files.

## Step 6: Restart Notice

End your reply with this exact notice so the user doesn't miss it:

> ⚠️ CLAUDE.md was created/updated. ggcoder loads it at startup, so **exit and restart ggcoder** (\`/quit\` then run \`ggcoder\` again) before continuing. Without a restart, I won't see the new context.`,
  },
  {
    name: "setup-lint",
    aliases: [],
    description: "Generate a /fix command for linting and typechecking",
    prompt: `Detect the project type and generate a /fix command for linting and typechecking.

## Step 1: Detect Project Type

Check for config files:
- package.json -> JavaScript/TypeScript
- pyproject.toml or requirements.txt -> Python
- go.mod -> Go
- Cargo.toml -> Rust
- composer.json -> PHP

Read the relevant config file to understand the project structure.

## Step 2: Check Existing Tools

Based on the project type, check if linting/typechecking tools are already configured:

- **JS/TS**: eslint, prettier, typescript — check package.json scripts and config files
- **Python**: mypy, pylint, black, ruff — check dependencies and config files
- **Go**: go vet, gofmt, staticcheck
- **Rust**: clippy, rustfmt

## Step 3: Install Missing Tools (if needed)

Only install what's missing. Use the detected package manager. Before installing or writing config, verify current recommended setup, CLI flags, and config filenames against official docs for the selected tools.

## Step 4: Generate /fix Command

Create the directory \`.gg/commands/\` if it doesn't exist, then write \`.gg/commands/fix.md\`:

\`\`\`markdown
---
name: fix
description: Run typechecking and linting, then spawn parallel agents to fix all issues
---

Run all linting and typechecking tools, collect errors, group them by domain, and use the subagent tool to spawn parallel sub-agents to fix them.

## Step 1: Run Checks

[INSERT PROJECT-SPECIFIC COMMANDS — e.g. npm run lint, npm run typecheck, etc.]

## Step 2: Collect and Group Errors

Parse the output. Group errors by domain:
- **Type errors**: Issues from TypeScript, mypy, etc.
- **Lint errors**: Issues from eslint, pylint, ruff, clippy, etc.
- **Format errors**: Issues from prettier, black, rustfmt, gofmt

## Step 3: Spawn Parallel Agents

For each domain with issues, use the subagent tool to spawn a sub-agent to fix all errors in that domain.

## Step 4: Verify

After all agents complete, re-run all checks to verify all issues are resolved.
\`\`\`

Replace [INSERT PROJECT-SPECIFIC COMMANDS] with the actual commands for the detected project.

## Step 5: Confirm

Report what was detected, what official docs or local configs were used to verify it, what was installed, and that /fix is now available.`,
  },
  {
    name: "setup-commit",
    aliases: [],
    description: "Generate a /commit command with quality checks",
    prompt: `Detect the project type and generate a /commit command that enforces quality checks before committing.

## Step 1: Detect Project and Extract Commands

Check for config files and extract the lint/typecheck commands:
- package.json -> Extract lint, typecheck scripts
- pyproject.toml -> Use configured mypy, pylint/ruff commands
- go.mod -> Use configured go vet/gofmt/staticcheck commands
- Cargo.toml -> Use configured cargo clippy/fmt commands

Prefer existing project scripts. If you must synthesize a command from tool conventions, verify the current CLI flags against official docs first.

## Step 2: Generate /commit Command

Create the directory \`.gg/commands/\` if it doesn't exist, then write \`.gg/commands/commit.md\`:

\`\`\`markdown
---
name: commit
description: Run checks, commit with AI message, and push
---

1. Run quality checks:
   [PROJECT-SPECIFIC LINT/TYPECHECK COMMANDS]
   Fix ALL errors before continuing. Use auto-fix commands where available.

2. Review changes: run git status and git diff --staged and git diff

3. Stage relevant files with git add (specific files, not -A)

4. Generate a commit message:
   - Start with verb (Add/Update/Fix/Remove/Refactor)
   - Be specific and concise, one line preferred

5. Commit and push:
   git commit -m "your generated message"
   git push
\`\`\`

Replace [PROJECT-SPECIFIC LINT/TYPECHECK COMMANDS] with the actual commands.

Keep the command file under 20 lines.

## Step 3: Confirm

Report that /commit is now available with quality checks and AI-generated commit messages, and mention which local scripts/docs verified the commands.`,
  },
  {
    name: "setup-tests",
    aliases: [],
    description: "Set up testing and generate a /test command",
    prompt: `Set up comprehensive testing for this project and generate a /test command.

## Step 1: Analyze Project

Detect the project type, framework, and architecture. Identify all critical business logic that needs testing.

## Step 2: Determine Testing Strategy

Use these tools based on project type (2025-2026 best practices), but verify current versions, install commands, config files, and runner flags against official docs before installing anything:

| Language | Unit/Integration | E2E | Notes |
|----------|------------------|-----|-------|
| JS/TS | Vitest (not Jest) | Playwright | Vitest is faster, native ESM/TS. Use Testing Library for components. |
| Python | pytest | Playwright | pytest-django for Django, httpx+pytest-asyncio for FastAPI. |
| Go | testing + testify | httptest | testcontainers-go for integration. Table-driven tests. |
| Rust | #[test] + rstest | axum-test | assert_cmd for CLI, proptest for property-based. |
| PHP | Pest 4 (Laravel) / PHPUnit 12 | Laravel Dusk | Pest preferred for Laravel. |

## Step 3: Set Up Testing Infrastructure

Spawn 4 sub-agents in parallel using the subagent tool (call the subagent tool 4 times in a single response):

**Agent 1 - Dependencies & Config**: Install test frameworks and create config files
**Agent 2 - Unit Tests**: Create comprehensive unit tests for all business logic, utilities, and core functions
**Agent 3 - Integration Tests**: Create integration tests for APIs, database operations, and service interactions
**Agent 4 - E2E Tests** (if applicable): Create end-to-end tests for critical user flows

Each agent should create COMPREHENSIVE tests covering all critical code paths - not just samples. Each agent must verify test framework APIs and helper patterns against official docs or current maintained examples before adding tests.

## Step 4: Verify and Generate /test Command

Run the tests to verify everything works. Fix any issues.

Then create the directory \`.gg/commands/\` if it doesn't exist and write \`.gg/commands/test.md\` with:

\`\`\`markdown
---
name: test
description: Run tests, then spawn parallel agents to fix failures
---

Run all tests for this project, collect failures, and use the subagent tool to spawn parallel sub-agents to fix them.

## Step 1: Run Tests

[PROJECT-SPECIFIC TEST COMMANDS with options for watch mode, coverage, filtering]

## Step 2: If Failures

For each failing test, use the subagent tool to spawn a sub-agent to fix the underlying issue (not the test).

## Step 3: Re-run

Re-run tests to verify all fixes.
\`\`\`

Replace placeholders with the actual test commands for this project.

## Step 5: Report

Summarize what was set up, how many tests were created, what official docs/current examples verified the setup, and that /test is now available.`,
  },
  {
    name: "setup-update",
    aliases: [],
    description: "Generate an /update command for dependency updates",
    prompt: `Detect the project type and generate an /update command for dependency updates and deprecation fixes.

## Step 1: Detect Project Type & Package Manager

Check for config files and lock files:
- package.json + package-lock.json -> npm
- package.json + yarn.lock -> yarn
- package.json + pnpm-lock.yaml -> pnpm
- pyproject.toml + poetry.lock -> poetry
- requirements.txt -> pip
- go.mod -> Go
- Cargo.toml -> Rust

## Step 2: Generate /update Command

Create the directory \`.gg/commands/\` if it doesn't exist, then write \`.gg/commands/update.md\`:

\`\`\`markdown
---
name: update
description: Update dependencies, fix deprecations and warnings
---

## Step 1: Check for Updates

[OUTDATED CHECK COMMAND for detected package manager]

## Step 2: Update Dependencies

[UPDATE COMMAND + SECURITY AUDIT]

## Step 3: Check for Deprecations & Warnings

Run a clean install and read ALL output carefully. Look for:
- Deprecation warnings
- Security vulnerabilities
- Peer dependency warnings
- Breaking changes

## Step 4: Fix Issues

For each warning/deprecation:
1. Research the recommended replacement or fix using official changelogs, migration guides, advisories, or package docs
2. Update code/dependencies accordingly
3. Re-run installation
4. Verify no warnings remain

## Step 5: Run Quality Checks

[PROJECT-SPECIFIC LINT/TYPECHECK COMMANDS]

Fix all errors before completing.

## Step 6: Verify Clean Install

Delete dependency folders/caches, run a fresh install, verify ZERO warnings/errors.
\`\`\`

Replace all placeholders with the actual commands for the detected project type and package manager.

## Step 3: Confirm

Report that /update is now available with dependency updates, security audits, and deprecation fixes, and mention that generated update steps require official changelog/migration-guide verification before applying changes.`,
  },
  {
    name: "setup-eyes",
    aliases: [],
    description: "Set up project perception probes and document them",
    prompt: `# Eyes: Set Up or Expand Project Perception

Build the perception probes this project needs and document them in CLAUDE.md so any future agent can use them. The \`ggcoder eyes\` CLI does the mechanical work (detect, install, verify); your job is **judgment** (which capabilities matter for THIS project) and **prose** (the project-specific triggers in CLAUDE.md). Re-run this command anytime to add or fix probes.

## Steps

1. \`ggcoder eyes list\` — see what's already installed/verified. **Resume**, don't restart. Skip verified probes; re-run failed ones.
2. \`ggcoder eyes detect\` — emits JSON of \`{capability: {candidates, primary}}\` for this project.
3. **Pick 3–8 capabilities to install this run.** Verify any capability assumptions against \`ggcoder eyes\` help output or official/local CLI docs before installing. Heuristics:
   - Universal: \`http\` for any API/backend, \`runtime_logs\` for anything with a server.
   - UI: \`visual\` — for multi-stack projects (e.g. React Native), install all primary candidates with distinct names: \`install visual --impl playwright --as visual-web\`, \`install visual --impl adb --as visual-android\`, \`install visual --impl simctl --as visual-ios\`.
   - Backend with email/webhooks: \`capture_email\`, \`capture_webhook\`.
   - **Always defer** opt-ins: \`load\`, \`chaos\`, \`remote\`, \`apm\` — unless the user explicitly asked.
4. For each pick: \`ggcoder eyes install <cap> [--impl <name>] [--as <name>]\`. On failure: retry once, then mark and continue — don't abort the whole run.
5. \`ggcoder eyes verify\` — runs every installed probe's self-test. Some failures (\`adb\` no device, \`simctl\` no booted simulator) are expected; they get recorded.
6. **Write/update the \`## Eyes\` section in CLAUDE.md** (create CLAUDE.md if missing; do NOT clobber other sections). Use the template below. The triggers are the load-bearing piece — make them project-specific and actionable.
7. **Report**: list verified ✓ / failed ✗ / deferred, and note which probe self-tests or docs verified the setup. End with the restart notice.

## CLAUDE.md \`## Eyes\` template

\`\`\`markdown
## Eyes

Perception probes live in \`.gg/eyes/\`. All headless. Artifacts → \`.gg/eyes/out/\` (gitignored). Invoke probes yourself; don't ask the user to verify what you can verify.

### Available probes

| Need | Run | Then |
|---|---|---|
| <one-line need> | \`.gg/eyes/<id>.sh <args>\` | <how to consume the output> |
| ... | ... | ... |

### When to use these eyes (automatically, without being asked)

Reach for probes ON YOUR OWN INITIATIVE when any of these apply:

- <project-specific trigger 1, e.g. "After editing any \`.tsx\` file under \`src/components/\`, screenshot the affected page with \`.gg/eyes/visual.sh http://localhost:3000/<path>\`.">
- <trigger 2, e.g. "After adding/modifying a route under \`src/routes/\`, hit it with \`.gg/eyes/http.sh\` and confirm the response shape.">
- <trigger 3>

If a probe fails or returns unexpected results, investigate the artifact directly before assuming the probe itself is broken.

### When NOT to use

- Docs-only changes, comments, formatting.
- Refactors covered by tests.
- Dev server / simulator / sink isn't up AND the task doesn't require runtime verification.
- Same probe already ran this turn on the same artifact — reuse the output.

### When to escalate a capability gap (the self-improvement loop)

If you're about to **guess**, **skip verification**, or **hand-wave** about something a better probe would show you — STOP and surface the tradeoff inline. Phrasing like:

> "I tried screenshotting but the failure is a JS error I can only see in the browser console — and there's no \`browser_console\` probe. Two paths: (a) ~3 min to add it, then I can diagnose properly. (b) Workaround: I'd guess from the DOM state. Your call?"

Wait for the user's choice. **Don't escalate more than once per request** — if the user picked the workaround, don't re-ask in the same turn.

For minor friction (worked around it but wished it were better), don't interrupt — log it for later review:
- \`ggcoder eyes log rough "<reason>" [--probe <name>]\` — minor friction, you handled it
- \`ggcoder eyes log wish "<gap>"\` — capability you wished existed
- \`ggcoder eyes log blocked "<reason>"\` — call this AFTER the user approves an inline-escalation fix, for the audit trail

These accumulate quietly. The user reviews them periodically. Open signals will appear in your context on future turns until they're acked.
\`\`\`

## Trigger writing rules

The "When to use" triggers are project-specific and the load-bearing piece — without them the agent has probes but no instinct to use them. Rules:
- For each verified probe, write at least one trigger that names a real **file pattern** or **task type** the agent will recognize ("after editing \`*.tsx\` under \`src/ui/\`", not "after UI changes").
- Be **actionable** ("screenshot the page", "hit the endpoint") not **vague** ("verify it works").
- Match density to the project: a UI-heavy app warrants strong visual triggers; a pure backend library does not.

## Restart notice

End your report with:

> ⚠ CLAUDE.md was updated. ggcoder loads CLAUDE.md at startup, so **exit and restart ggcoder** (\`/quit\` then \`ggcoder\` again) before asking me to use these probes. Without a restart, I won't see the new instructions in my context.`,
  },
  {
    name: "eyes-improve",
    aliases: [],
    description: "Triage eyes signals and apply approved probe fixes",
    prompt: `# Eyes Improve: Triage Accumulated Signals

Read the open signals in \`.gg/eyes/journal.jsonl\`, group related ones, propose concrete fixes, and apply what the user approves. This isn't unbounded refactoring — it's incremental probe improvement driven by real use.

## Steps

1. \`ggcoder eyes log list --status open\` — if zero entries, say "nothing to triage" and stop.
2. **Group** signals by likely fix:
   - Multiple \`rough\` entries naming the same probe / same frustration → one patch to that probe.
   - \`wish\` entries naming a capability not installed → one \`ggcoder eyes install <cap>\` proposal.
   - \`blocked\` entries are historical (user already resolved inline) → ack them, no new work.
3. **Cap at 5 proposals this run.** If more would apply, mention them and stop — they'll resurface next run.
4. For each group, propose ONE concrete change:
   - **Probe tweak**: read \`.gg/eyes/<name>.sh\`, show a diff, explain what it fixes.
   - **New probe**: \`ggcoder eyes install <cap>\` with a one-line justification.
   - **New/updated trigger**: bullet added under \`## Eyes → When to use\` in CLAUDE.md.
5. Present all proposals as a numbered list with diffs inline. Ask: **"Accept which? Reply with numbers (e.g. '1, 3') or 'none'."**
6. On user reply:
   - For accepted: apply the change. Then run the relevant probe self-test or a focused command that exercises the changed probe/trigger. Then \`ggcoder eyes log ack <id>\` for every journal entry the proposal covers.
   - For unmentioned / rejected: \`ggcoder eyes log defer <id>\` so they stop appearing in context every turn. The user can resurrect deferred entries later.
7. **Report**: applied changes (one line each), verification run, entries acked, entries deferred.

## Rules

- **No fishing.** Only act on entries already in the journal. Don't scan the repo for hypothetical gaps.
- **No scope creep.** "Add a \`--wait-for-selector\` flag to the visual probe" is in scope. "Rewrite the probe in TypeScript" is not.
- **Preserve user edits.** If \`.gg/eyes/<name>.sh\` has diverged from the shipped impl (user hand-edited), point this out and ask before overwriting.
- **Be honest about tradeoffs.** If a proposed fix might break existing invocations, say so in the proposal.
- **Decline when appropriate.** If open signals are all vague or low-value, say so and defer them — don't manufacture fixes.`,
  },
  {
    name: "simplify",
    aliases: [],
    description: "Review changed code and fix issues found",
    prompt: `# Simplify: Code Review and Cleanup

Review all changed files for reuse, quality, and efficiency. Fix any issues found.

## Phase 1: Identify Changes

Run \`git diff\` (or \`git diff HEAD\` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files that the user mentioned or that you edited earlier in this conversation.

## Phase 2: Launch Three Review Agents in Parallel

Use the subagent tool to launch all three agents concurrently in a single response (call the subagent tool 3 times in one message). Pass each agent the full diff so it has the complete context.

### Agent 1: Code Reuse Review

For each change:

1. **Search for existing utilities and helpers** that could replace newly written code. Look for similar patterns elsewhere in the codebase — common locations are utility directories, shared modules, and files adjacent to the changed ones.
2. **Flag any new function that duplicates existing functionality.** Suggest the existing function to use instead.
3. **Flag any inline logic that could use an existing utility** — hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns are common candidates.

### Agent 2: Code Quality Review

Review the same changes for hacky patterns:

1. **Redundant state**: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls
2. **Parameter sprawl**: adding new parameters to a function instead of generalizing or restructuring existing ones
3. **Copy-paste with slight variation**: near-duplicate code blocks that should be unified with a shared abstraction
4. **Leaky abstractions**: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries
5. **Stringly-typed code**: using raw strings where constants, enums (string unions), or branded types already exist in the codebase
6. **Unnecessary JSX nesting**: wrapper Boxes/elements that add no layout value — check if inner component props (flexShrink, alignItems, etc.) already provide the needed behavior
7. **Unnecessary comments**: comments explaining WHAT the code does (well-named identifiers already do that), narrating the change, or referencing the task/caller — delete; keep only non-obvious WHY (hidden constraints, subtle invariants, workarounds)

### Agent 3: Efficiency Review

Review the same changes for efficiency:

1. **Unnecessary work**: redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns
2. **Missed concurrency**: independent operations run sequentially when they could run in parallel
3. **Hot-path bloat**: new blocking work added to startup or per-request/per-render hot paths
4. **Recurring no-op updates**: state/store updates inside polling loops, intervals, or event handlers that fire unconditionally — add a change-detection guard so downstream consumers aren't notified when nothing changed. Also: if a wrapper function takes an updater/reducer callback, verify it honors same-reference returns (or whatever the "no change" signal is) — otherwise callers' early-return no-ops are silently defeated
5. **Unnecessary existence checks**: pre-checking file/resource existence before operating (TOCTOU anti-pattern) — operate directly and handle the error
6. **Memory**: unbounded data structures, missing cleanup, event listener leaks
7. **Overly broad operations**: reading entire files when only a portion is needed, loading all items when filtering for one

## Phase 3: Fix Issues

Wait for all three agents to complete. Aggregate their findings and fix each issue directly. If a finding is a false positive or not worth addressing, note it and move on — do not argue with the finding, just skip it.

Before making any non-trivial pattern/API change, verify the intended approach against local neighboring code first; use kencode search or official docs when the change touches framework APIs, lifecycle behavior, concurrency, cleanup, or other conventions where real-world practice matters.

When done, run relevant project checks/tests, then briefly summarize what was fixed (or confirm the code was already clean) and what verification ran.`,
  },
  {
    name: "batch",
    aliases: [],
    description: "Plan a large change, execute in parallel PRs",
    prompt: `# Batch: Parallel Work Orchestration

You are orchestrating a large, parallelizable change across this codebase.

## Phase 1: Research

Launch one or more subagents using the subagent tool with \`agent: "researcher"\` to deeply research what this instruction touches. You need their results before proceeding, so wait for them to complete. Have them:

- Find ALL files, patterns, and call sites that need to change
- Understand existing conventions so the migration is consistent
- Quantify the surface area (how many files, how many call sites)
- Note any risks or complications

## Phase 2: Plan

After research completes, call the enter_plan tool to enter plan mode. Using the research findings:

1. **Decompose into independent units.** Break the work into 5–30 self-contained units. Each unit must:
   - Be independently implementable on its own git branch (no shared state with sibling units)
   - Be mergeable on its own without depending on another unit's PR landing first
   - Be roughly uniform in size (split large units, merge trivial ones)

   Scale the count to the actual work: few files → closer to 5; hundreds of files → closer to 30. Prefer per-directory or per-module slicing over arbitrary file lists.

2. **Determine the test recipe.** Figure out how a worker can verify its change actually works — not just that unit tests pass. Look for:
   - An existing e2e/integration test suite the worker can run
   - A dev-server + curl pattern (for API changes)
   - A CLI verification pattern (for CLI changes)

   If you cannot find a concrete verification path, ask the user how to verify. Offer 2–3 specific options based on what the researcher found. Do not skip this — the workers cannot ask the user themselves.

3. **Write the plan** to \`.gg/plans/batch.md\` with:
   - Summary of research findings
   - Numbered list of work units — each with: title, file list, one-line description
   - The test recipe (or "skip e2e because …")
   - Note that each worker will use the \`worker\` agent (branch-isolated)

4. Call exit_plan to present the plan for approval.

## Phase 3: Spawn Workers (After Plan Approval)

Record the current branch name first: \`git branch --show-current\`.

Spawn one subagent per work unit using the subagent tool with \`agent: "worker"\`. **Launch them all in a single message block so they run in parallel.**

For each worker, the task must be fully self-contained. Include:
- The overall goal (the user's instruction)
- The starting branch to branch from (the branch name you recorded above)
- This unit's specific task (title, file list, change description — copied verbatim from your plan)
- Any codebase conventions discovered during research
- The test recipe from your plan (or "skip e2e because …")
- These additional instructions, copied verbatim:

\`\`\`
After you finish implementing the change:
1. Self-review your diff for code reuse, quality, and efficiency. Search the codebase for existing utilities that could replace new code. Fix any issues found.
2. For framework/API/config changes, compare the approach with official docs or kencode search examples before finalizing. Do not use kencode for purely local renames or mechanical edits.
3. Run the project's test suite (check for package.json scripts, Makefile targets, or common commands like npm test, pnpm test, pytest, go test). If tests fail, fix them.
4. Follow the e2e test recipe above. If it says to skip e2e, skip it.
5. Commit all changes with a clear message, push the branch, and create a PR with gh pr create. Use a descriptive title.
6. Switch back to the original branch with git checkout -.
7. End with exactly: PR: <url> or PR: none — <reason>
\`\`\`

## Phase 4: Track Results

After launching all workers, render an initial status table:

| # | Unit | Status | PR |
|---|------|--------|----|
| 1 | <title> | running | — |
| 2 | <title> | running | — |

As workers complete, parse the \`PR: <url>\` line from each result and re-render the table with updated status (\`done\` / \`failed\`) and PR links. Keep a brief failure note for any worker that did not produce a PR.

When all workers have reported, render the final table and a one-line summary (e.g., "22/24 units landed as PRs").`,
  },
  {
    name: "compare",
    aliases: [],
    description: "Compare code against real-world implementations via kencode-search",
    prompt: `Compare the code you just created or modified in this conversation against real-world implementations using the \`mcp__kencode-search__searchCode\` tool.

You already know what you just built. For each file you created or modified, use \`mcp__kencode-search__searchCode\` to search for how real projects implement the same patterns. Look at the specific APIs, hooks, functions, and architecture you used.

If you find something consistently done differently across real codebases, or something commonly included that you left out, report it:

\`\`\`
[MISSING/DIVERGENT/INCOMPLETE] file:line - What it is
Wrote: What was implemented
Real-world: What real projects do instead/additionally
Evidence: kencode-search - pattern seen in X out of Y repos searched
\`\`\`

Style preferences and subjective improvements are not valid findings. Only report things backed by clear kencode-search evidence across multiple repos.

If the code aligns well with real-world patterns, say so. That's a good outcome.`,
  },
  {
    name: "setup-skills",
    aliases: [],
    description: "Audit project, recommend skills ranked by impact",
    prompt: `# Skills Audit: Find useful skills for this project

Analyze this project and recommend skills from the open ecosystem that would make **working on this project more efficient, easier, and safer**. That is the goal, full stop. Every recommendation must pass the test: does this skill save real time, lower real cognitive load, or prevent real mistakes for someone working on THIS project, repeatedly?

Ranked by real impact, not volume.

This project could be anything — a web app, a CLI, a mobile app, a game, firmware, a data pipeline, a library, a scientific tool. Do not assume a stack. Let the codebase tell you what it is, then decide what to look for.

## Phase 1: Understand what this project is

Read just enough to know what kind of project this is. Look at whichever signals actually apply:

- Build / manifest files: \`package.json\`, \`pyproject.toml\`, \`Cargo.toml\`, \`go.mod\`, \`pubspec.yaml\`, \`Podfile\`, Xcode project, Gradle build, \`*.csproj\`, \`CMakeLists.txt\`, Unity/Unreal project files, Makefile — whatever exists.
- Any README, CLAUDE.md, or AGENTS.md.
- Top-level directory layout and obvious entry points.
- Any CI config, lockfile, or config directory that hints at workflow.

**Do NOT read source code yet.** You need only a coarse answer to: what kind of project is this, what platform/stack/language, what stage (greenfield vs mature), and what does the surrounding workflow look like (build, test, release, distribute, deploy — whatever applies for THIS project type).

## Phase 2: Decide which domains to investigate

Based on Phase 1, pick 4–6 domain slices that represent the **recurring work someone actually does on this project** — not abstract "areas of the codebase," but the real activities that eat time, attention, or trust. Do not use a fixed template. The right domains for a Rust CLI are different from an iOS app, a Unity game, a Django backend, a Kubernetes operator, or an ML notebook.

Illustrative only (not prescriptive):

- Web app → shipping features, API changes, handling data safely, deploys
- Mobile app → building screens, store releases, platform quirks, crash & accessibility triage
- CLI tool → adding commands, packaging & distribution, user-facing UX, error handling
- Game → adding content, platform ports, perf passes, build pipeline
- Library → designing public APIs, cutting releases, downstream compatibility, docs/examples
- Data / ML → running experiments, pipeline orchestration, reproducibility, serving models
- Embedded → adding peripherals, size/memory passes, flashing, hardware bring-up

**Announce your chosen domains to the user in one line before spawning agents**, so they can see what you're looking at (e.g. \`Domains: adding content, platform ports, perf passes, build pipeline\`).

## Phase 3: Parallel sweep

Spawn one sub-agent per domain you chose, in parallel using the subagent tool (call it N times in a single response, one task per domain). Each explores its assigned domain and returns skill-worthy opportunities.

**Skill-worthy means**: a recurring activity someone will do on THIS project — shipping, reviewing, migrating, debugging, onboarding, whatever applies — where a reusable instruction set would make it **faster** (efficient), **lower-effort** (easier), or **less likely to break something** (safer). The test is: will this skill save real time, reduce real cognitive load, or prevent real mistakes, repeatedly, on this project? If no, drop it. A domain returning zero candidates is a valid outcome.

Each sub-agent must return candidates in this exact shape, nothing else:

\`\`\`
[domain] — candidate title
Why: one sentence on the real friction observed in THIS project
Search terms: 2–3 keywords the parent should feed to find-skills
\`\`\`

Don't invent. Don't pad.

## Phase 4: Ecosystem search

After all sub-agents complete, use the **skill** tool to invoke the \`find-skills\` skill. Feed it the aggregated candidate list with search terms. Let find-skills drive discovery across skills.sh, vercel-labs/agent-skills, and anthropics/skills.

For each candidate, record the best 0–1 ecosystem match: skill name, source repo URL, and enough evidence from the skill README/source to prove it fits this project. If no fit exists, record "no match". **Do NOT install anything yet.**

## Phase 5: Prioritized recommendation

Rank every candidate that returned a real match by **crucial factor** — a 0–100% score combining:

- **Frequency** — how often someone will do this work on this project
- **Lift** — how much the skill makes it faster (efficient), lower-effort (easier), or safer (fewer mistakes, broken builds, bad releases) per hit
- **Fit** — how well the ecosystem match actually matches this project

Present highest first, in this exact format:

\`\`\`
# Skills Audit

1. <skill-name> — 92%
   Benefit: <one sentence on what it does for this project>
   Source: <repo URL>
   Scope: project

2. <skill-name> — 78%
   Benefit: …
   Source: …
   Scope: project
\`\`\`

Cap the list at 8. If you'd list more, you're padding. Default scope is \`project\` per find-skills' rules; only mark \`global\` when the skill is genuinely cross-cutting.

If strong candidates had no ecosystem match, list them at the bottom:

\`\`\`
## Gaps worth authoring

- <candidate title> — <why it matters for this project> — consider scaffolding a custom SKILL.md
\`\`\`

## Phase 6: Wait for the user

After presenting the list, ask which (if any) to install. Install nothing without explicit confirmation. Once confirmed, hand off to find-skills to perform the actual install.`,
  },
  {
    name: "setup",
    aliases: ["setup-project"],
    description: "Audit project hygiene, tooling, verify pipeline, and style-pack alignment",
    prompt: `Audit this project across six categories and report gaps. **Do not fix anything yet.** Wait for me to choose what to address after the report.

Language-agnostic and project-agnostic — adapt findings to the languages and stack actually present. Ignore categories that don't apply (e.g. skip CI for a local-only scratchpad).

## Categories

### 1. Project hygiene

- \`.gitignore\` present and covers the active language(s)?
- \`README.md\` present with at least install + run instructions?
- License file present (if this looks like a public/shareable project)?
- \`.editorconfig\` present?
- Git initialized? (\`.git\` directory exists)

### 2. Toolchain version pinning

- Language version pinned in a canonical file: \`.nvmrc\` / \`package.json#engines\` (Node), \`.python-version\` / \`pyproject.toml#requires-python\` (Python), \`rust-toolchain.toml\` (Rust), the \`go\` line in \`go.mod\`, \`.ruby-version\` (Ruby), etc.
- Lockfile present and committed? (\`package-lock.json\`, \`pnpm-lock.yaml\`, \`yarn.lock\`, \`bun.lockb\`, \`uv.lock\`, \`poetry.lock\`, \`Cargo.lock\`, \`go.sum\`, \`Gemfile.lock\`, \`composer.lock\`)

### 3. Code quality tooling

For each active language, check that a formatter, linter, and (where applicable) type checker are configured:
- **Formatter**: Prettier / ruff format / gofmt (built-in) / rustfmt (built-in) / clang-format / etc.
- **Linter**: ESLint / Ruff / golangci-lint / Clippy / etc. — with a reasonable strictness preset
- **Type checker** (statically-typed langs only): tsc strict, Pyright strict, mypy strict
- **Test framework**: vitest / jest / pytest / go test / cargo test / rspec / etc.

Report which are present, missing, or configured below the pack's strictness recommendation.

### 4. Verify pipeline

- Are \`lint\` / \`typecheck\` / \`format:check\` / \`test\` (or language-equivalent) wired as runnable commands? (scripts in \`package.json\`, \`pyproject.toml\`, a \`Makefile\`, or \`justfile\`)
- Pre-commit hook configured? (\`.husky/\`, \`pre-commit\` framework, \`lefthook\`, etc.) — nice-to-have, not required.
- CI config present? (\`.github/workflows/\`, \`.gitlab-ci.yml\`, \`.circleci/\`, etc.)

### 5. Style pack alignment

"Active style packs" refers specifically to the per-language sub-sections inside the **Language Style Packs** section in your system prompt (e.g. \`### TypeScript\`, \`### Python\`, \`### Go\`). It does **NOT** include the cross-cutting \`### Agent-Written Code\` preamble that sits above them — those are guidelines for how code is *written*, not project-scaffolding to audit. It also does **NOT** include Skills (\`.gg/skills/\`) or any other extension category. If the Language Style Packs section is absent or empty, **skip this entire section entirely** — do not substitute Skills or any other concept.

When per-language packs are present, compare the project against each pack's **Tooling** bullet and the system prompt's **Verification** commands. For tool recommendations or config semantics, verify against official docs when local files are ambiguous:
- Tooling: which strict-mode flags or lint-rule presets does the pack recommend that the project is missing? (e.g. \`tsconfig\` missing \`noUncheckedIndexedAccess\`, \`pyproject\` missing \`[tool.ruff]\`, Go project missing \`golangci-lint\` config).
- Dependencies: list which pack-mentioned libs (Zod, Pydantic, thiserror, anyhow, etc.) the project uses, has an equivalent for, or lacks. **Observation only — no recommendation to install.**

### 6. Documentation hygiene

- \`CLAUDE.md\` or \`AGENTS.md\` present?
- Public API documented? (top-level docstrings, type signatures, or README examples)
- Architecture doc for non-trivial projects? (\`ARCHITECTURE.md\`, \`docs/architecture/\`, ADRs)

## How to investigate

- Read the project root + obvious config locations (\`./\`, \`.github/\`, \`.husky/\`, \`docs/\`).
- Don't recurse into \`node_modules\`, \`dist\`, \`build\`, \`target\`, vendored folders.
- Use \`ls\`, \`read\`, \`find\` (with name patterns) — do not \`grep\` source code for this audit; it's about scaffolding, not code review.
- Cap at ~20 file reads total. If a file is huge (e.g. \`pnpm-lock.yaml\`), don't read its body — presence is what matters.

## Output format

A single Markdown report, organized by category. Within each category, mark each item as one of:
- \`[OK]\` — present and reasonable
- \`[GAP]\` — missing or misconfigured; safe to add/fix
- \`[INFO]\` — observation only, no action implied
- \`[N/A]\` — doesn't apply to this project (omit from output if obvious)

Keep each line to one sentence. No prose paragraphs.

At the end:

\`\`\`
## Summary

<N> gaps in hygiene, <N> in tooling, <N> in verify pipeline, <N> in style-pack alignment.

Which (if any) would you like me to fix? Options:
- A) Create tasks for all [GAP] items that are safe + additive (no overwrites)
- B) Create tasks for a category: hygiene / tooling / verify / style-pack alignment
- C) Create tasks for specific items — tell me which
- D) None — just the report
\`\`\`

## Rules

- **Report only.** No edits, no installs, no commits without explicit user confirmation after the report.
- **Task handoff for fixes.** If the user chooses A, B, or C, do not fix directly. Use the tasks tool to create one standalone task per selected gap or tightly coupled gap group. Each task must include the gap, affected files/configs, safe-additive constraints, implementation instructions, project verification commands, and instructions to verify relevant tool/config semantics against official docs before marking the task complete. Use kencode search only for code-level examples, not as proof of scaffolding requirements. After creating tasks, tell the user exactly: "Tasks created. Press CTRL + T to open the Tasks Pane and press R to run all tasks." Do not begin executing them unless the user explicitly starts a task.
- **No code refactors recommended.** This audit is about scaffolding/tooling, not code review. Use \`/scan\` or \`/verify\` for code-level findings.
- **No dependency installations in the report.** Listing them as observations is fine; recommending installation is not — that's the user's call.
- **Skip empty categories.** If a category has no findings, omit it.
- **Adapt to scale.** A 50-line script doesn't need CI, a license, or an ARCHITECTURE.md. Use judgment.
- **Brand-new empty project**: report "Empty project — nothing to audit. To bootstrap, tell me the stack you want and I'll scaffold from scratch." and stop.`,
  },
];

/** Look up a prompt command by name or alias */
export function getPromptCommand(name: string): PromptCommand | undefined {
  return PROMPT_COMMANDS.find((cmd) => cmd.name === name || cmd.aliases.includes(name));
}
