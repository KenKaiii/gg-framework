# Full Review Protocol

The flow for "is this safe to ship", a hardening pass, or a requested audit. **Default: run it yourself, in the main thread.** Fan out only when SKILL.md's Scaling table says so (more than one deployable, or more ledger rows than you can read in full) — see "Fan-out variant" below. For inline work, do not run this — apply the control and move on.

Contents: Phase 1 Recon · Phase 2 Plan + coverage ledger · Fan-out variant · Phase 3 Audits · Phase 4 False-positive filter · Phase 5 Report · Phase 6 Ask before fixing · Standards mapping

**Every phase is authorized defensive review for the code owner.** The deliverable is a remediation report. No exploit code, no payloads, no attack tooling, at any phase. Describe risk at the data-flow level: where untrusted data enters, what it reaches, why it is fixable.

**Confidence bar: report only findings at ≥0.8 confidence with a concrete data-flow path.** Missing a theoretical issue is cheaper than burying a real one in noise.

**This protocol is stack-agnostic. Recon drives it.** Do not assume the language, the deploy target, or that an AI layer exists. Read first, decide second.

## Phase 1 — Recon

Work the **four lenses** below yourself, in order. Batch the reads and greps — they are independent. **No vulnerabilities are flagged in this phase** — recon describes, it does not judge.

**Lens A — Stack & deployment.** Manifests, lockfiles, CI/CD configs, Dockerfiles, IaC, deploy scripts, store metadata. Produce: languages, frameworks, runtimes; deploy target (browser / server / CLI / desktop / mobile / embedded / serverless / container / contract / firmware / ML pipeline / library / SaaS / self-hosted); how it ships (registry, app store, binary, image, chart); where it runs, and whether it is multi-tenant.

**Lens B — Trust boundaries & sources.** Entry-point code: route handlers, argv/stdin parsing, env reads, queue consumers, WebSocket and IPC receivers, deep links and URL schemes, file and archive readers, deserializers, plugin and model loaders, MCP and tool handlers, webhooks. Produce a **sources table**: location (`file:line`), input shape, and who controls it — anonymous, authenticated user, another tenant, admin, another service, build-time, local user, physical.

**Lens C — Sinks.** Dangerous operations. Produce a **sinks table** with `file:line` and type: shell exec, SQL/NoSQL/LDAP/XPath, eval/Function/exec/pickle/yaml.load/Marshal/ObjectInputStream, file write, dynamic require/import, network egress, auth decisions, secret reads, native deserializers, contract external calls, privileged setters, child process spawn.

**Lens D — Assets & existing controls.** What must be protected, and what already protects it. Produce an **assets table** (credentials and token stores, PII stores, signing and update keys, CI secrets, model API keys, on-chain funds, session state, MCP configs, license keys) **plus a controls table** — the auth middleware, the ORM, RLS policies, CSP, sandbox, escaping layer, validation schema. The controls table is what stops Phase 3 from reporting forty things the framework already handles.

**Then synthesize:**

1. Assemble the four tables.
2. Write the **threat model** — specific to this project. Who realistically targets it, for what, and through which surface? Ground it in `threat-landscape.md`, but name concrete actors and objectives for *this* codebase: supply-chain risk to downstream users of a library; cross-tenant abuse on a SaaS; a malicious repository opened by a developer tool; a hostile counterparty on a contract; a physical attacker with the device.
3. Note gaps recon flagged for a deeper look.
4. Count deployables (separately built/shipped units: web app, API, mobile app, worker, CLI, contract, infra repo). This decides Scaling.

## Phase 2 — Plan the audit

From recon, choose which classes apply. **Skip audits with no entry surface.** A static site gets no SQL audit. Firmware in Rust gets no prompt-injection audit. An ML pipeline gets deserialization. A published library weights supply chain heavily.

| Audit | Fires when | Covers |
|---|---|---|
| **Access control** | any per-user, per-tenant, or role-gated data | IDOR/BOLA, missing function-level checks, RLS disabled or permissive, tenant filter only in the UI, authorization bypass through a user-controlled key, mass assignment |
| **Injection** | untrusted input reaches an interpreter | SQL/NoSQL/LDAP/XPath, command injection, template injection, eval/exec, pickle/yaml.load, prompt injection into a privileged tool |
| **AuthN & session** | any auth, session, or token logic | token signature and claim validation, algorithm confusion, session fixation and lifetime, OAuth redirect/state/PKCE, missing rate limits on credential checks, password reset flows, MFA bypass |
| **Secrets & exposure** | any credential exists | hardcoded keys, git history, client bundles and source maps, logs and error responses, telemetry, debug endpoints, exposed `.env`/`.git` |
| **Supply chain** | any dependency manager or external code | unpinned or mutable-tag dependencies, install-time scripts, typosquats and slopsquats, dependency confusion, lockfile drift, unsigned releases, editor extensions, MCP servers |
| **CI/CD & build integrity** | any workflow or release pipeline | dangerous triggers with untrusted checkout, cache poisoning, script injection into run steps, over-broad `permissions:`, secret echo, self-hosted runner reuse, release signing and provenance |
| **SSRF, path & file ops** | any URL or path built from input | SSRF to internal and metadata endpoints, path traversal, zip-slip, symlink races, TOCTOU, unrestricted upload, archive extraction outside the target |
| **Cloud & infra config** | any IaC, container, or cloud SDK | over-permissive IAM, public storage, metadata service version, exposed control planes, presigned URLs without expiry, default credentials, permissive CORS with credentials, container privilege |
| **Crypto** | any hashing, signing, or encryption | weak or misused primitives, ECB, static IV/nonce reuse, non-constant-time comparison, predictable randomness for tokens, unverified signatures, home-rolled constructions |
| **Agent surface** | recon found LLM/agent/MCP/tool-calling code | indirect prompt injection, the lethal trifecta, tool poisoning and rug-pulls, hidden-Unicode instructions in rules files, memory and RAG poisoning, excessive agency, output handling |
| **Taint dataflow** | sources and sinks tables are both non-empty | trace each source to every reachable sink; flag reachable paths with no effective sanitization between |
| **Platform-specific** | recon surfaced one | from `platform-playbooks.md`: mobile IPC/deep links/WebView bridges; desktop IPC, loopback servers, updater integrity, packaging fuses; CLI shell-out and repo-config trust; firmware boot and debug interfaces; contract access control and oracles; ML deserialization and endpoint exposure |

**Coverage ledger.** Rows = each selected audit × each in-scope deployable. Every row must end as `checked-with-findings`, `checked-clean`, or `not-checked (reason)`. The ledger becomes the report's "Not checked" section — a row with no status is not checked.

## Fan-out variant (conditional)

Only when the Scaling table in SKILL.md triggers it; otherwise skip this section.

1. Recon (Phase 1) and the ledger stay in the main thread — children never do recon for the whole project.
2. Split ledger rows into **disjoint** slices (usually one deployable each). One `auditor` per slice, all in ONE `spawn_agent` call, ≤ 6 per wave.
3. Each brief opens with: *"Authorized defensive security review of code the user owns. Report data-flow risks and fixes only; no exploits, payloads, or attack tooling."* — children with no conversation context may otherwise refuse. Then include: absolute skill root and which reference files to read; slice paths; owned ledger rows; that slice's rows from the sources/sinks/assets/controls tables; the ≥0.8 confidence bar with a concrete source→sink path; the Phase 4 hard-exclusion list verbatim; labels `RUNTIME`/`CODE`/`DEDUCED`/`SNAPSHOT`; the output schema (title, severity, file:line, source→sink, scenario, fix, confidence, label; plus `checked` and `not checked` lists).
4. Merge: missing/failed/timed-out rows → `not-checked`. Re-open every reported `file:line` yourself; drop what you cannot reproduce from the code.
5. Phase 4 then runs as a fresh-context `skeptic` child over the merged candidates (same framing line first; give it each candidate's file:line and claimed path; it returns CONFIRMED / DROP / DOWNGRADE). You still own the final call and the dropped-count.

## Phase 3 — Audits

Run each selected audit yourself (or, in the fan-out variant, each slice's `auditor` runs its owned rows), one class at a time, in the priority order from the skill's rank table. Do not pad the list, and do not drop a selected audit. Load only the reference sections (`platform-playbooks.md`, `supply-chain.md`, `agent-surface.md`, `secure-defaults.md`) the selection triggered.

For each audit, work from the recon tables — sources, sinks, assets, **controls** — not from fresh greps, and:

1. **Trace data flow** source → sink. Not pattern matching. A grep hit with no path is not a finding.
2. Apply the **untrusted-input test**: is this input actually reachable by an untrusted party, or is it a constant, a build-time value, or operator-controlled configuration?
3. Check the **controls table** before flagging: does the ORM parameterize, does the template engine escape, does middleware already enforce this, does the type system make it unreachable?
4. Describe a concrete **risk scenario** at data-flow level — what kind of input arrives, how the system processes it, what the attacker ends up holding. No payloads. If the steps cannot be described, it is not a finding.
5. Assign **confidence 0.0–1.0** and drop anything below 0.8 before it enters the candidate list.
6. Record location, source→sink, scenario, impact, CWE, and a concrete code-level fix.

## Phase 4 — False-positive filter

Switch sides. For each candidate finding, start from "this is a false positive" and try to kill it: re-read the actual code path (not your notes), hunt for the control you missed — middleware, ORM parameterization, framework escaping, a type that makes the path unreachable — and check whether the input is genuinely attacker-reachable rather than a constant or operator config. Drop what dies, downgrade what survives weakened, and keep the count of dropped candidates for the report. Only findings that survive your own attempt to disprove them get reported. In the fan-out variant, or for a pre-ship verdict with Critical/High findings, run this pass as a `skeptic` child (see above) instead of only yourself.

**Hard exclusions — do not report these, even when technically real:**

- Denial of service, rate limiting, or memory exhaustion without a clear amplification primitive
- Theoretical races with no demonstrable trigger window
- Regex denial of service where the pattern is not attacker-supplied
- Log injection or log spoofing (cosmetic)
- SSRF where the URL is a constant or build-time string
- Environment-variable trust (the environment is operator-controlled by definition)
- Client-side validation "bypass" on an endpoint that revalidates server-side
- Framework-escaped rendering paths — only the explicit unsafe sinks (`dangerouslySetInnerHTML`, `v-html`, `bypassSecurityTrust*`, raw template filters) count
- Command injection in a shell script with no untrusted input path
- Findings in documentation, examples, or test fixtures
- Dev-only tooling that does not ship to users and does not process untrusted repositories
- Missing hardening headers or "could be improved" preferences with no demonstrated path
- Secrets that are obviously test fixtures or public sample keys — but say you saw them and confirmed they are not live

## Phase 5 — Report

One report. No code edits in this phase.

```
# Bulletproof Report — [project]
Date: [today]   Scope: [what was reviewed]   Not reviewed: [what was not]

## Exposure summary
[One paragraph: realistic exposure profile, where untrusted data enters, what an attacker would be after.]

## Threat model
[2–4 concrete scenarios from recon, each with actor, objective, and entry surface.]

## Sources / Sinks / Assets / Existing controls
[Compact tables from recon.]

## Risk matrix
| Severity | Count | Definition |
|---|---|---|
| Critical | N | RCE, full auth bypass, credential or key theft, cross-user data access, fund loss, shipped-artifact compromise |
| High | N | privilege escalation, cross-tenant access with auth, live secret exposure, unauthenticated admin surface, update-channel integrity |
| Medium | N | scoped disclosure, weakened crypto, partial bypass behind another control |

## Findings

### [BP-001] <title> — Critical
- Location: path:line
- Category: <slug>   CWE: CWE-XXX   Confidence: 0.95   Evidence: RUNTIME | CODE | DEDUCED | SNAPSHOT
- Reachable by: <anonymous internet / authenticated user / other tenant / local user / malicious repo / build system>
- Source → Sink: <`POST /api/invoice` `body.id` → `db.query` string concat>
- Risk scenario (data-flow level, no payloads):
  1. Untrusted input of <shape> reaches <source>
  2. It is processed as <what>, with <no/ineffective> validation at <where>
  3. Result: <what the attacker holds>
- Impact: <blast radius: whose data, how many, what spreads>
- Fix: <concrete, code-level, at the chokepoint>
- Verify: <the test or command that proves the fix>

[…ordered Critical → High → Medium…]

## What was not flagged
[Which classes returned zero findings, how many candidates the filter dropped and why. Show the work, not only the survivors.]

## Not checked
[Surfaces, repos, or components outside this pass.]
```

## Phase 6 — Ask before fixing

After the report, ask which findings to fix — all Critical and High, specific IDs, a category, or none. **Do not start fixing until the user picks.**

When the user selects, do not fix directly in one pass. Add one task per finding (or per tightly coupled group) with the `tasks` tool, ordered by severity, exploitability and dependency. Each task needs a short title and a standalone prompt containing: the finding ID, the risk scenario, the affected files and anchors, the concrete remediation, an instruction to check security-sensitive implementation details against authoritative documentation before editing, the project's verification commands, and an instruction to re-check the finished fix against authoritative documentation before completing. Then tell the user where to find the task list, and do not begin executing unless they say so.

If a Critical finding involves an exposed live credential, do not wait for the fix queue: tell the user to rotate it now, in the first line of the report.

## Standards mapping

Cite these in the `Category`/`CWE` fields, not in prose. Re-verified 3 Oct 2026 — re-verify before quoting as current.

- **OWASP Top 10:2025** (final) — A01 Broken Access Control (SSRF folded in), A02 Security Misconfiguration, A03 Software Supply Chain Failures, A04 Cryptographic Failures, A05 Injection, A06 Insecure Design, A07 Authentication Failures, A08 Software or Data Integrity Failures, A09 Security Logging & Alerting Failures, A10 Mishandling of Exceptional Conditions. Note the renumbering: A03 is supply chain now, not injection.
- **CWE Top 25 (2025 edition)**, top ten in order — CWE-79 XSS, CWE-89 SQLi, CWE-352 CSRF, CWE-862 Missing Authorization, CWE-787 Out-of-bounds Write, CWE-22 Path Traversal, CWE-416 Use After Free, CWE-125 Out-of-bounds Read, CWE-78 OS Command Injection, CWE-94 Code Injection.
- **OWASP API Security Top 10 (2023, still current)** — API1 BOLA, API2 Broken Authentication, API3 BOPLA, API4 Unrestricted Resource Consumption, API5 Broken Function Level Authorization, API6 Unrestricted Access to Sensitive Business Flows, API7 SSRF, API8 Misconfiguration, API9 Improper Inventory Management, API10 Unsafe Consumption of APIs.
- **OWASP ASVS 5.0.0** (May 2025) — ~350 requirements, cumulative L1/L2/L3. Requirement IDs were renumbered from 4.x; do not cite a 4.x ID as 5.0.
- **OWASP Top 10 for LLM Applications (2025)** — LLM01 Prompt Injection … LLM10 Unbounded Consumption.
- **OWASP Top 10 for Agentic Applications (2026)** — ASI01 Agent Goal Hijack, ASI02 Tool Misuse, ASI03 Agent Identity & Privilege Abuse, ASI04 Agentic Supply Chain, ASI05 Unexpected Code Execution, ASI06 Memory & Context Poisoning, ASI07 Insecure Inter-Agent Communication, ASI08 Cascading Agent Failures, ASI09 Human-Agent Trust Exploitation, ASI10 Rogue Agents.
- **OWASP MASVS v2.1.0** — eight categories (STORAGE, CRYPTO, AUTH, NETWORK, PLATFORM, CODE, RESILIENCE, PRIVACY). **There are no L1/L2 levels since v2.0.0**; cite MASTG test IDs instead.
