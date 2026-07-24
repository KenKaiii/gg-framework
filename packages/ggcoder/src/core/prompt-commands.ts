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

/**
 * True when this process is the gg-app sidecar (Tauri spawns it with
 * `GG_APP_PORT` set, even to "0" — plain `ggcoder` CLI never sets it). Used
 * to phrase user-facing notices (restart / task-list pointers) in terms of
 * the desktop app's UI instead of CLI keybinds, since most users are on the
 * app now and it has no terminal keybinds at all.
 */
const IS_GG_APP = process.env.GG_APP_PORT !== undefined;

const TASKS_ADDED_NOTICE = IS_GG_APP
  ? 'Tasks added. Click the "Tasks" button to open the task list and run them.'
  : "Tasks added. Press Ctrl+T to open the task list and run them.";

const CLAUDE_MD_RESTART_NOTICE = IS_GG_APP
  ? '> ⚠️ CLAUDE.md was created/updated. GG App loads it fresh per session, so start a **New Session** (click "+ New") before continuing. Without a new session, I won\'t see the new context.'
  : "> ⚠️ CLAUDE.md was created/updated. ggcoder loads it at startup, so **exit and restart ggcoder** (`/quit` then run `ggcoder` again) before continuing. Without a restart, I won't see the new context.";

/**
 * Shared sub-agent fan-out phrasing. One home so the "call the tool N times
 * in a single response" wording can't drift between command prompts.
 */
const spawnParallel = (count: string | number): string =>
  `in parallel using the subagent tool (call the subagent tool ${count} times in a single response)`;

export const PROMPT_COMMANDS: PromptCommand[] = [
  {
    name: "expand",
    aliases: [],
    description: "Find exciting new features to add",
    prompt: `# Expand: Exciting Feature Discovery

Find the most exciting new features this project should add by comparing it to similar, adjacent, and best-in-class repositories/tools/products/services. This command is project-agnostic: infer what THIS project is before choosing comparisons. This command is report-first and feature-first — the only deliverable is a single ranked table of exciting, user-facing features. Do not edit, install, or implement anything until the user chooses an option at the end.

Focus on what users actually get excited about: the new, killer, user-facing capabilities that make a product stand out. Security audits, refactors, code-quality cleanups, tests, CI, and ops/DX hygiene are OUT OF SCOPE here — exclude them unless a specific item is itself an exciting user-facing feature.

## Phase 0: Profile this project first

Before external research, inspect the local project and write a private working profile:

- What the project does, who its users are, and how they use it.
- Core user-facing surfaces, workflows, commands/routes/screens, and the features that already exist.
- The feature categories most relevant to THIS project. Do not assume a stack or product type.

Use this profile to decide which features are relevant and genuinely missing. If the user passed arguments to /expand, treat them as a focus area and prioritize that lens while still validating relevance.

## Phase 1: Parallel feature research

Spawn exactly 5 sub-agents ${spawnParallel(5)}. Give each sub-agent the project profile and a different feature-hunting lens:

**Agent 1 - Direct competitor killer features**: The standout, most-loved user-facing features in the closest peer projects/tools/products that this project lacks.

**Agent 2 - Adjacent & emerging tools**: Exciting user-facing features from adjacent products that would translate well to this project.

**Agent 3 - User demand signals**: Highly requested or trending features — top-voted issues, roadmap items, community asks, reviews, discussions — that point at what users want next.

**Agent 4 - Platform & ecosystem trends**: New user-facing capabilities unlocked by recent framework/API/model/platform releases that this project has not adopted yet.

**Agent 5 - Differentiators & wow-factor**: Novel or innovative features that would make this project stand out, even if no single peer has shipped them yet.

Each sub-agent must:

1. Use current sources: prefer repos/releases/changelogs/docs/articles updated within the last 6 months. Drop old or stale sources unless they are canonical and still actively maintained.
2. Return only user-facing FEATURES that appear absent in this project — not refactors, hardening, tooling, tests, or internal cleanup.
3. Include source names/URLs, freshness date (commit/release/article/doc date), and the local search anchors they used or recommend to verify the feature is absent.
4. Rank its own candidates by how exciting and valuable they would be to users, and state why each is exciting.
5. Avoid generic wishlist items. Every feature must be grounded in an external comparison or a real user-demand signal and relevant to this project profile.

## Phase 2: Main-agent validation against this repo

For every candidate from the sub-agents, validate it yourself before reporting:

1. Confirm the external source is relevant to this project and fresh enough (normally within 6 months).
2. Search this repo with grep/find and language-aware anchors to confirm the feature is not already present under another name.
3. Check routes, CLI commands, UI surfaces, package exports, config, docs, and examples before calling a feature missing.
4. Use mcp__kencode-search__searchCode when a code-level look clarifies how peers actually ship the feature. Use literal imports, functions, config keys, CLI flags, route names, or package names — not conceptual phrases.
5. Drop anything already present, irrelevant, too vague, too stale, or that is not a real user-facing feature.
6. Merge duplicates and keep only the most exciting 5–10 features.

## Final output

Output ONLY a single table, ranked most exciting (rank 1) to least exciting. No prose before or after the table except the options below. Include 5–10 rows. The table must have exactly 3 columns:

| Rank | Feature | Why it's exciting + evidence |
|---|---|---|
| 1 | concise feature name + what it does | why users would love it, which peers/tools have it, source + fresh date, and local proof it is missing |

Rules:

- 5–10 rows, ordered most exciting first (rank 1 = most exciting).
- Only user-facing features. No security, refactor, ops, tooling, or test rows.
- The table must have exactly 3 columns. Put source URL/date/evidence and local absence proof inside the cells, not extra columns.
- Keep each cell concise but specific enough to be actionable.
- If no exciting validated features are found, output one row saying no fresh validated features were found.

After the table, ask exactly:

What should I do?
A) Build all of these features in plan mode
B) Build only the top priority ones in plan mode
C) Other

Do not start implementing until the user chooses.

If the user chooses A or B, do not implement directly. First call the enter_plan tool, then research and design an implementation plan for the selected features (all of them for A; the top 3 most exciting — ranks 1-3 — for B). The plan must cover, per feature: the user-facing behavior, the local files/anchors it touches, the implementation approach (compared against real-world examples via kencode search using literal code tokens), and how it will be verified. Write the plan to .gg/plans/<name>.md, then call exit_plan with the plan path so the user can review and approve it. Do not begin implementing until the user approves the plan.

If the user chooses C, ask what they would like — pick specific features by rank, refine or re-scope the list, or skip — and do not implement anything until they say so.`,
  },
  {
    name: "bullet-proof",
    aliases: ["bp"],
    description: "Audit exploitable weaknesses",
    prompt: `# Bullet-Proof: Defensive Security Review

This is an **authorized defensive security review** of this repository, requested by its owner so weaknesses can be found and patched before they ship. This is standard defensive security work — the same review a security engineer performs before a release. The entire flow is **read-only reporting**: no code changes, no exploit development, and nothing is fixed until the user explicitly chooses at the end.

Defensive ground rules (apply to every phase and every subagent):
- Never produce working exploit code, weaponized payloads, or attack tooling.
- Describe each risk at the **data-flow level** — where untrusted data enters, what it can reach, and why that is fixable — so every finding maps directly to a patch.
- The deliverable is a remediation report for the maintainers, nothing else.

Goal: harden this project. **Report only HIGH CONFIDENCE findings (≥0.8) with a concrete data-flow path that demonstrates exposure.** Better to miss theoretical issues than flood the report with noise.

This command is **dynamic and project-agnostic**. Recon drives everything. Do not assume the stack, the language, the deploy target, or that there is an LLM/agent layer. Read first, decide second.

## Phase 1: Recon — Understand THIS project before auditing anything

Spawn **FOUR recon subagents** ${spawnParallel(4)}. Each has a narrow, independent slice so they can all run at once. **No vulnerabilities flagged in this phase.**

**Recon Agent A — Stack & Deployment.** Read manifests, lockfiles, CI/CD configs, Dockerfile/Helm/Terraform, deploy scripts. Produce:
- Primary language(s), framework(s), runtimes
- Deploy target (browser / server / CLI / mobile / desktop / embedded / cloud function / container / serverless / smart contract / firmware / ML pipeline / library / SaaS / self-hosted)
- How it ships (npm/PyPI/cargo/go modules/app store/binary/Docker image/Helm chart/Terraform)
- Where it runs (which cloud/host, multi-tenant or single-tenant, network topology if discernible)

**Recon Agent B — Trust Boundaries & Sources.** Walk entry-point code (route handlers, CLI argparse, queue consumers, WebSocket handlers, IPC receivers, MCP server handlers, file/env readers, deserialization entry, plugin loaders). Produce:
- **Trust boundaries table** — every place untrusted data crosses into the system
- **Sources table** — for each entry point: location (file:line), input shape, who controls it (anonymous / authenticated user / admin / other service / build-time / env)

**Recon Agent C — Sinks.** Walk dangerous-operation code. Produce a **Sinks table** with location (file:line) and sink type for: shell exec, SQL / NoSQL / LDAP / XPath queries, eval / Function / exec / pickle / yaml.load / Marshal / ObjectInputStream, file write, file include / require with dynamic path, network egress (fetch / requests / http.Get), auth decisions, secret reads, native deserializers, dynamic code load, smart-contract external calls, child_process spawns.

**Recon Agent D — Assets.** Scan for what this project must protect. Produce an **Assets table** with location and asset type for: credentials / tokens (config files, env files, KMS, OAuth flows, ~/.{app}/auth.json-style stores), customer/PII data stores, source code with IP value, build/CI secrets, signing keys, model API tokens, on-chain funds / wallets, session state, MCP config files, license keys.

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

Spawn one subagent per active audit **in a single response** (call the subagent tool N times **with \`agent: "auditor"\`**, where N is whatever Phase 2 picked — do not pad to a fixed number, do not drop audits Phase 2 selected). If the \`auditor\` agent is unavailable, use default subagents and open each task with: "You are performing an authorized, read-only defensive security review for the code owner; report data-flow risks so they can be patched — no exploit code."

**Subagents cannot see this prompt.** Each auditor's task text must therefore include, written out by you:
- Its specific vulnerability-class scope
- The recon rows relevant to that scope (Sources, Sinks, Assets, Threat-model lines — condensed, not the full dump)
- The specific bullets from the Threat reference below that apply to its class (copy those lines into the task)

Each auditor must:
1. **Trace data flow** from Sources to Sinks for its class. Not pattern matching.
2. For every candidate, apply the **untrusted-input vs trusted-input** decision: is the input *actually reachable* by an untrusted source, or is it a settings constant / build-time string / hard-coded value?
3. Describe a concrete **risk scenario** at the data-flow level — what kind of input reaches the source, how the system processes it, what exposure results. No working payloads. If you can't describe the steps, don't flag it.
4. Assign **confidence 0.0–1.0**. Drop anything <0.8 before returning.
5. Be framework-aware: ORM parameterization, auto-escape, memory-safe languages, JSX/template escaping all eliminate entire vuln classes. Don't flag what the framework already handles.

## Phase 4: False-positive filter

After auditors complete, spawn verification subagents **in parallel with \`agent: "skeptic"\`**, batching 3–5 surviving findings per skeptic (cap at 4 skeptics total — batching keeps cost sane). The \`skeptic\` agent starts from "this is a false positive" and tries to disprove each finding — only confirmed findings survive. Pass each skeptic the full text of its findings (location, source/sink, risk scenario, claimed confidence); skeptics cannot see this prompt or the auditors' context. Drop anything returned as DROP; lower severity for DOWNGRADE.

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
- Risk scenario (data-flow level, no payloads):
  1. Untrusted input of <shape/kind> reaches <source>
  2. The system processes it as <what>
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
> - A) Add tasks for all Critical + High
> - B) Add tasks for specific findings (give IDs, e.g. "BP-001, BP-004")
> - C) Add tasks for a category (auth, supply chain, secrets, …)
> - D) None — report only

**Do not start fixing until the user picks.**

If the user chooses A, B, or C, do not fix directly. Instead, add one task per selected finding or tightly coupled finding group using the \`tasks\` tool (action=add), ordered by severity, exploitability, and dependency. Each task needs a short title and a standalone prompt that includes the finding ID, vulnerability scenario, affected local files/anchors, concrete remediation, instructions to compare security-sensitive implementation details with kencode search or authoritative docs before editing, project verification commands, and instructions to compare the final fix with kencode search or authoritative docs again before completing the task. After adding the tasks, tell the user exactly: "${TASKS_ADDED_NOTICE}" Do not begin executing them unless the user explicitly says so.

## Threat reference (May 2026)

Defensive reference material from public incident reports and OWASP — patterns to check for, not techniques to reproduce. Copy the relevant bullets into each auditor's task (Phase 3); do not dump them into the report.

**OWASP Top 10:2025** — A01 Broken Access Control (now includes SSRF), A02 Misconfig, **A03 Supply Chain Failures (new)**, A05 Injection (now includes prompt injection), **A10 Mishandling Exceptional Conditions (new — fail-open patterns)**.

**OWASP API Security Top 10 (2023)** — BOLA, Broken Auth, BOPLA, SSRF (API7).

**OWASP Top 10 for LLM Apps v2025** — LLM01 Prompt Injection (direct + indirect), LLM02 Sensitive Info Disclosure, LLM03 Supply Chain, LLM04 Data & Model Poisoning, LLM05 Improper Output Handling, LLM06 Excessive Agency, **LLM07 System Prompt Leakage (new)**, **LLM08 Vector & Embedding Weaknesses (new — RAG/embedding-store attacks)**, LLM09 Misinformation, LLM10 Unbounded Consumption.

**OWASP Top 10 for Agents 2026 (ASI01–10)** — Goal hijack, tool misuse, identity/privilege abuse, agentic supply chain, unexpected code exec, memory/context poisoning, inter-agent comms, cascading failures, human-trust exploit, rogue agents.

**Real 2024-2026 public incidents — patterns to grep for defensively:**
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
    name: "init",
    aliases: [],
    description: "Generate or update CLAUDE.md for this project",
    prompt: `Generate or update a minimal CLAUDE.md with project-specific context only: what this project is, how it is structured, and commands/workflows that are unique to it.

Do NOT add generic agent behavior already covered by the system prompt, including: read before edit/write, re-read after formatters, ask before destructive actions, no fake verification, generic code-quality advice, single-responsibility rules, one-file-per-component rules, or language-style conventions. Never add guidance that requires running checks, builds, or the full quality suite after every edit or every file change. Include only project-specific overrides or stricter local requirements.

## Step 1: Check if CLAUDE.md Exists

If CLAUDE.md exists:
- Read the existing file
- Preserve custom sections the user may have added
- Update only project-specific facts that are stale or missing
- Remove generic guidance that is already covered by the system prompt unless it is a deliberate project-specific override

If CLAUDE.md does NOT exist:
- Create a new one from scratch

## Step 2: Analyze Project (Use Sub-agents in Parallel)

Derive every fact from the actual project — source code, entry points, manifests, and config. Treat README, docs, and code comments as unverified hints that are frequently stale: never copy claims from them, and only state things you can confirm from the code and config themselves.

Spawn 3 sub-agents ${spawnParallel(3)}:

1. **Project Purpose Agent**: Determine what the project actually does from its real code — entry points, main modules, exported/public APIs, CLI commands, routes, and manifests. Do not rely on the README's description.
2. **Directory Structure Agent**: Map out the folder structure and what each folder contains
3. **Tech Stack Agent**: Identify languages, frameworks, tools, and dependencies from manifests/lockfiles and config (not from prose docs)

Wait for all sub-agents to complete, then synthesize the information.

## Step 3: Detect Project Type & Commands

Check for config files:
- package.json -> JavaScript/TypeScript (extract package-manager, build, lint, typecheck, test, format, and server scripts)
- pyproject.toml or requirements.txt -> Python
- go.mod -> Go
- Cargo.toml -> Rust

Extract exact commands that are useful project facts. Take commands from authoritative sources — package scripts, manifests, Makefiles, and CI config; do not invent them from convention, and do not trust README/doc command snippets unless a script or manifest confirms they still exist. Do not restate generic "run checks after edits" behavior, and do not turn discovered commands into mandatory after-every-edit requirements unless local docs or CI explicitly require that stricter sequence.

## Step 4: Summarize Stable Structure

If useful, create a concise structure summary for future agents showing only key stable directories and files with brief descriptions. Do NOT embed generated symbol maps, exhaustive file indexes, auto-generated directory listings, or large trees in CLAUDE.md.

## Step 5: Generate or Update CLAUDE.md

Create CLAUDE.md with only sections that add project-specific value. Prefer this structure:

- Project name and one-sentence purpose
- Key packages/apps/modules and what each owns
- Important project-specific architecture or workflow notes
- Exact local commands (install/build/check/test/dev/publish/deploy) when they are not obvious from package scripts alone
- Project-specific constraints that override defaults (for example required publish order, generated-file workflow, auth/secrets storage, deployment caveats)

Avoid generic sections named "Code Quality", "Organization Rules", or "How to Work" unless every bullet is specific to this project. Do not duplicate language style packs, generic verification rules, or boilerplate quality gates such as "After editing ANY file" / "Code Quality — Zero Tolerance". Do not add symbol indexes, exhaustive file indexes, or auto-generated project inventories; CLAUDE.md must remain durable, agent-focused project context.

Keep total file under 100 lines. If updating, preserve any custom sections the user added. After writing, re-read CLAUDE.md and confirm it contains only project-specific facts supported by local files.

## Step 6: Restart Notice

End your reply with this exact notice so the user doesn't miss it:

${CLAUDE_MD_RESTART_NOTICE}`,
  },
  {
    name: "setup-commit",
    aliases: [],
    description: "Generate a /commit command",
    prompt: `Detect the project type and generate a /commit command that enforces quality checks and an agent code review before committing.

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
description: Run checks, agent code review, commit with AI message, and push
---

1. Run quality checks:
   [PROJECT-SPECIFIC LINT/TYPECHECK COMMANDS]
   Fix ALL errors before continuing. Use auto-fix commands where available.

2. Review changes: run git status and git diff --staged and git diff

3. Fast review gate: spawn ONE subagent with the full diff. Instructions: review ONLY
   the diff for real bugs, regressions, leftover debug code, and unintended changes.
   Score each issue 0-100 confidence (pre-existing issues and stylistic nitpicks = false
   positives, score low). Report ONLY issues with confidence >= 80, with file:line and a
   one-line fix. If none, reply "CLEAR". This is a last check, not a deep audit - be fast.

4. If CLEAR: proceed straight to step 5 and push WITHOUT asking the user anything.
   If issues >= 80 were reported: STOP, show the issues, and ask exactly:
   "Want me to fix this first, or commit and push anyway?
   A) Fix it first, then commit & push
   B) Commit & push anyway"
   On A: fix, re-run step 1, then continue (no re-review). On B: continue as-is.

5. Stage relevant files with git add (specific files, not -A)

6. Generate a commit message:
   - Start with verb (Add/Update/Fix/Remove/Refactor)
   - Be specific and concise, one line preferred

7. Commit AND push in one go - never pause for confirmation here:
   git commit -m "your generated message"
   git push
\`\`\`

Replace [PROJECT-SPECIFIC LINT/TYPECHECK COMMANDS] with the actual commands.

Keep the command file under 30 lines.

## Step 3: Confirm

Report that /commit is now available with quality checks, an agent code review gate, and AI-generated commit messages, and mention which local scripts/docs verified the commands.`,
  },
  {
    name: "compare",
    aliases: [],
    description: "Compare real-world code",
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
    description: "Recommend useful skills",
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

Spawn one sub-agent per domain you chose, ${spawnParallel("N")} — one task per domain. Each explores its assigned domain and returns skill-worthy opportunities.

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
];

/** Look up a prompt command by name or alias */
export function getPromptCommand(name: string): PromptCommand | undefined {
  return PROMPT_COMMANDS.find((cmd) => cmd.name === name || cmd.aliases.includes(name));
}
