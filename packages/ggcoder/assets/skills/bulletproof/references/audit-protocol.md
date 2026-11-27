# Full Review Protocol

The flow for "is this safe to ship", a hardening pass, or a requested audit. **Default: run it yourself, in the main thread.** Fan out only when SKILL.md's Scaling section says so (more than one deployable, or more ledger rows than you can read in full); see "Fan-out variant" below. For inline work, do not run this: apply the control and move on.

## Contents

- Ground rules (evidence bar, running code, how a review ends)
- Phase 1 Recon
- Phase 2 Plan the audit (coverage ledger)
- Fan-out variant
- Phase 3 Audits (hunting depth, candidate gate)
- Phase 3b Coverage gap pass
- Phase 4 False-positive filter (needs validation, exclusions)
- Phase 5 Report (template, writing for non-specialists)
- Phase 6 Ask before fixing
- Standards mapping

## Ground rules

**Every phase is authorized defensive review for the code owner.** The deliverable is a remediation report. No exploit code, no payloads, no attack tooling, at any phase. Describe risk at the data-flow level: where untrusted data enters, what it reaches, why it is fixable.

**Confidence bar: report only findings at ≥0.8 confidence with a concrete data-flow path.** Missing a theoretical issue is cheaper than burying a real one in noise. A real path whose deciding fact lives outside the repo is not dropped for low confidence: it goes to **Needs validation** (Phase 4).

**This protocol is stack-agnostic. Recon drives it.** Do not assume the language, the deploy target, or that an AI layer exists. Read first, decide second.

**Running code.** In the user's own project, running its tests or a small local check with dummy users and data is fine and gives `RUNTIME` evidence. For code the user did not write (a cloned third-party repo, a vendored dependency, a stranger's pull request), do not run its install scripts, builds, tests, hooks or binaries unless they are sandboxed with no network, no credentials, and writes limited to a scratch directory; otherwise stay static and put runtime questions under Needs validation. Never probe a deployed system, another person's data, or a paid API.

**How a review ends.** Exactly one of two ways: the Phase 5 report with every ledger row closed, or the report marked `Status: incomplete — <reason>` with the open rows listed under Not checked. Never stop mid-phase without saying so.

## Phase 1 — Recon

Work the **four lenses** below yourself, in order. Batch the reads and greps, since they are independent. **No vulnerabilities are flagged in this phase**: recon describes, it does not judge.

**Lens A — Stack & deployment.** Manifests, lockfiles, CI/CD configs, Dockerfiles, IaC, deploy scripts, store metadata. Produce: languages, frameworks, runtimes; deploy target (browser / server / CLI / desktop / mobile / embedded / serverless / container / contract / firmware / ML pipeline / library / SaaS / self-hosted); how it ships (registry, app store, binary, image, chart); where it runs, and whether it is multi-tenant; any CDN, proxy or edge layer in front of it.

**Lens B — Trust boundaries & sources.** Entry-point code: route handlers, server actions, argv/stdin parsing, env reads, queue consumers, cron and background jobs, WebSocket and IPC receivers, deep links and URL schemes, file and archive readers, importers, deserializers, plugin and model loaders, MCP and tool handlers, webhooks and payment callbacks. Produce a **sources table**: location (`file:line`), input shape, and who controls it: anonymous, authenticated user, another tenant, admin, another service, build-time, local user, physical.

**Lens C — Sinks.** Dangerous operations. Produce a **sinks table** with `file:line` and type: shell exec, SQL/NoSQL/LDAP/XPath, eval/Function/exec/pickle/yaml.load/Marshal/ObjectInputStream, file write, dynamic require/import, network egress, auth decisions, secret reads, balance and entitlement changes, native deserializers, contract external calls, privileged setters, child process spawn.

**Lens D — Assets & existing controls.** What must be protected, and what already protects it. Produce an **assets table** (credentials and token stores, PII stores, balances and entitlements, signing and update keys, CI secrets, model API keys, on-chain funds, session state, MCP configs, license keys) **plus a controls table**: the auth middleware, the ORM, RLS policies, CSP, sandbox, escaping layer, validation schema, webhook verifier. Also list the **derived copies** of user data (search indexes, exports, caches, analytics, logs) so Phase 3 checks them. The controls table is what stops Phase 3 from reporting forty things the framework already handles.

**Then synthesize:**

1. Assemble the four tables.
2. Write the **threat model**, specific to this project. Who realistically targets it, for what, and through which surface? Ground it in `threat-landscape.md`, but name concrete actors and objectives for *this* codebase: supply-chain risk to downstream users of a library; cross-tenant abuse on a SaaS; free credits on a paid AI app; a malicious repository opened by a developer tool; a hostile counterparty on a contract; a physical attacker with the device.
3. Note gaps recon flagged for a deeper look.
4. Count deployables (separately built or shipped units: web app, API, mobile app, worker, CLI, contract, infra repo). This decides Scaling.

## Phase 2 — Plan the audit

From recon, choose which audits apply. **Skip audits with no entry surface.** A static site gets no SQL audit. Firmware in Rust gets no prompt-injection audit. An ML pipeline gets deserialization. A published library weights supply chain heavily. What each audit looks for is its section in `attack-classes.md`, under the same name.

| Audit | Fires when |
|---|---|
| **Access control and tenant isolation** | any per-user, per-tenant, or role-gated data |
| **Data lifecycle and derived copies** | user data copied into search, exports, caches, logs or model context; deletion or restore; removable members |
| **Business logic, money and races** | payments, credits, quotas, coupons, invites, one-time tokens, multi-step workflows |
| **Webhooks and inbound integrations** | webhooks, payment or OAuth callbacks, events from another service |
| **Injection** | untrusted input reaches an interpreter |
| **Authentication, sessions and recovery** | any login, session, token, OAuth/SSO, MFA or reset logic |
| **HTTP edge, caching and browser** | HTML rendering, a CDN or proxy in front, cookie auth |
| **Secrets and exposure** | any credential exists |
| **Supply chain** | any dependency manager or external code |
| **CI/CD and release integrity** | any workflow, release or update pipeline |
| **SSRF, paths and files** | any URL, path, archive or upload built from input |
| **Cloud and infrastructure** | any IaC, container, or cloud SDK |
| **Cryptography** | any hashing, signing, encryption or random token |
| **Resource abuse and denial of wallet** | expensive, paid or model-calling work reachable by low-trust callers |
| **Agent surface** | recon found LLM, agent, MCP or tool-calling code |
| **Desktop, mobile and local IPC** | recon found an app, helper, updater, local server, deep link or IPC channel; also load the matching `platform-playbooks.md` section |

Taint tracing (each source to every reachable sink) is the method of Phase 3, not a separate audit.

**Coverage ledger.** Rows = each selected audit × each in-scope deployable. When a deployable has several entry surfaces (HTTP routes, server actions, webhooks, jobs and queues, IPC, CLI), split the row by surface. Every row ends as `checked-with-findings`, `checked-clean`, `needs-validation`, or `not-checked (reason)`, and a checked row lists the paths it actually read. A row with no status, or no paths, is not checked. The ledger becomes the report's "Not checked" section.

## Fan-out variant (conditional)

Only when SKILL.md's Scaling section triggers it; otherwise skip this section.

1. Recon (Phase 1) and the ledger stay in the main thread. Children never do recon for the whole project.
2. Split ledger rows into **disjoint** slices (usually one deployable each). One security auditor per slice (`auditor` where your spawn_agent lists it, else a read-only repo helper), all in ONE `spawn_agent` call, ≤ 6 per wave.
3. Each brief opens with: *"Authorized defensive security review of code the user owns. Report data-flow risks and fixes only; no exploits, payloads, or attack tooling."* Children with no conversation context may otherwise refuse. Then include: absolute skill root; slice paths; owned ledger rows; that slice's rows from the sources, sinks, assets and controls tables; **the selected sections of `attack-classes.md`, pasted verbatim**; the candidate gate and hunting-depth rules from Phase 3; the ≥0.8 confidence bar; the Phase 4 hard-exclusion list verbatim; labels `RUNTIME`/`CODE`/`DEDUCED`/`SNAPSHOT`; the output schema (title, severity, file:line, source→sink, the six gate fields, fix, confidence, label), plus separate `needs validation` (claim, path, missing fact, owner check), `checked` (with paths read) and `not checked` lists.
4. Merge: missing, failed or timed-out rows become `not-checked`. Re-open every reported `file:line` yourself; drop what you cannot reproduce from the code. Merge candidates with one root cause.
5. Phase 3b runs once as a fresh read-only child over the merged ledger. Phase 4 runs as a fresh verifier child (`skeptic` where listed, else a read-only repo helper) over the merged candidates; same framing line first; give it each candidate's file:line, claimed path and gate fields; it returns CONFIRMED / DROP / DOWNGRADE / NEEDS VALIDATION. You still own the final call and the dropped count.

## Phase 3 — Audits

Run each selected audit yourself (or, in the fan-out variant, each slice's auditor runs its owned rows), one at a time, in the priority order from the skill's rank table. Do not pad the list, and do not drop a selected audit. Use the audit's section in `attack-classes.md` as the checklist, and load only the control references (`platform-playbooks.md`, `supply-chain.md`, `agent-surface.md`, `secure-defaults.md`) it names.

For each audit, work from the recon tables (sources, sinks, assets, **controls**, derived copies), not from fresh greps, and:

1. **Trace data flow** source → sink. Not pattern matching. A grep hit with no path is not a finding.
2. **Read at depth.** Follow the input through parsing, identity, authorization, normalization, storage, derived copies and the final sink. Read the sibling paths that reach the same effect (bulk, list, export, search, older versions, retries, error paths, background jobs) and compare their checks for **equivalence**, not just presence. Compare what one component guarantees with what the next one assumes.
3. **Try the edges the interface accepts:** missing, empty, zero, negative, huge, duplicate, mixed encoding, stale or revoked, concurrent, out of order, partially failed.
4. Apply the **untrusted-input test**: is this input reachable by an untrusted party, or is it a constant, a build-time value, or operator-controlled configuration?
5. Check the **controls table** before flagging: does the ORM parameterize, does the template engine escape, does middleware already enforce this, does the type system make it unreachable?
6. Pass the **candidate gate** (below), then describe a concrete **risk scenario** at data-flow level: what input arrives, how the system processes it, what the attacker ends up holding. No payloads. If the steps cannot be described, it is not a finding.
7. Assign **confidence 0.0–1.0** and drop anything below 0.8, unless the only doubt is a fact outside the repo (Phase 4, Needs validation).
8. Record location, source→sink, gate fields, scenario, impact, CWE, and a concrete code-level fix at the last trusted decision point.

**Candidate gate.** A candidate names all six, or it is not a candidate:

1. the lower-trust **actor** (anonymous, another user, another tenant, a malicious repo, another local app);
2. the **input or action** they control;
3. the **control** that should stop them;
4. the **boundary** crossed;
5. the **affected** user, tenant or resource, which is not the actor's own;
6. the **result**: what they read, change, spend, run or keep.

Harm a user can only do to their own account, data or machine with their own authority is not a finding. One root cause reachable through several paths is one candidate, with the strongest path and the others listed; independent missing controls are separate candidates.

## Phase 3b — Coverage gap pass

Once, before filtering, check the ledger for gaps rather than trusting memory:

- entry points in the sources table that no row covered;
- sibling paths of a traced path (bulk, export, search, jobs, older versions) left unread;
- derived copies from Lens D that no row checked;
- a selected audit with no row, or a row closed without paths;
- earlier findings or needs-validation items (from a prior report or the project's Checklist record) that nothing re-checked.

Run the gaps you find, then mark anything still open `not-checked (reason)`. One pass, not a loop. In the fan-out variant a fresh read-only child does this pass.

## Phase 4 — False-positive filter

Switch sides. For each candidate, start from "this is a false positive" and try to kill it: re-read the actual code path (not your notes), hunt for the control you missed (middleware, ORM parameterization, framework escaping, a type that makes the path unreachable), re-check every gate field, and check whether the input is genuinely attacker-reachable rather than a constant or operator config. Each candidate ends as one of:

- **Keep**: the path survives; severity never exceeds what the path demonstrates.
- **Drop**: the code refutes it, or an exclusion below applies. Count it.
- **Downgrade**: real, but weaker than claimed.
- **Needs validation**: the path is real in the code, but the deciding fact lives outside the repo: a dashboard setting (RLS state, bucket policy), proxy or CDN configuration, provider behaviour, production environment, store or OS policy. It gets no severity and is not counted as a finding. Record the exact missing fact and a safe check the owner can run. Never use it for weak evidence: if the code refutes the path, drop it.

Only findings that survive your own attempt to disprove them get reported. In the fan-out variant, or for a pre-ship verdict with Critical/High findings, run this pass as a verifier child (see above) instead of only yourself.

**Hard exclusions — do not report these, even when technically real:**

- Denial of service, rate limiting, or memory exhaustion without a clear amplification primitive (exception: a missing rate limit on login, signup, password reset, or a paid/LLM endpoint is reportable)
- Theoretical races with no demonstrable trigger window (exception: a check-then-act on money, credits, quotas, coupons, invites or one-time tokens is reportable; parallel requests are free)
- Self-impact: a user harming only their own account, data or machine with their own authority
- Regex denial of service where the pattern is not attacker-supplied
- Log injection or log spoofing (cosmetic)
- SSRF where the URL is a constant or build-time string
- Environment-variable trust (the environment is operator-controlled by definition)
- Client-side validation "bypass" on an endpoint that revalidates server-side
- Framework-escaped rendering paths: only the explicit unsafe sinks (`dangerouslySetInnerHTML`, `v-html`, `bypassSecurityTrust*`, raw template filters) count
- Command injection in a shell script with no untrusted input path
- Findings in documentation, examples, or test fixtures
- Dev-only tooling that does not ship to users and does not process untrusted repositories
- Missing hardening headers or "could be improved" preferences with no demonstrated path
- Secrets that are obviously test fixtures or public sample keys (but say you saw them and confirmed they are not live)

## Phase 5 — Report

One report. No code edits in this phase.

**Write it for someone who has never read a CVE.**

- Lead with what an attacker gets, in plain words: "anyone who knows a user's ID can read their invoices", not "IDOR in the invoice controller".
- Name the file and line, then the fix, then the reason, in that order.
- Give the base rate honestly. Fear is not a lever; a scared user makes worse decisions and often ships nothing.
- Keep standards jargon (CWE, OWASP IDs) in a labelled field, not in the sentence that has to be understood.
- Fill "Not checked" honestly: a review that silently skips the mobile client, admin panel, or infra repo reads as complete coverage.

```
# Bulletproof Report — [project]
Date: [today]   Scope: [what was reviewed]   Not reviewed: [what was not]
Status: complete | incomplete — [reason]

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
- Boundary: <control that should stop it> → <whose data or resource is affected>
- Source → Sink: <`POST /api/invoice` `body.id` → `db.query` string concat>
- Risk scenario (data-flow level, no payloads):
  1. Untrusted input of <shape> reaches <source>
  2. It is processed as <what>, with <no/ineffective> validation at <where>
  3. Result: <what the attacker holds>
- Also reachable via: <sibling paths with the same root cause, if any>
- Impact: <blast radius: whose data, how many, what spreads>
- Fix: <concrete, code-level, at the chokepoint>
- Verify: <the test or command that proves the fix>

[…ordered Critical → High → Medium…]

## Needs validation
[No severity. For each: the claim in plain words, the code path (path:line), the exact fact the repo cannot show, and a safe check the owner can run (a dashboard setting, a header on a real response, a console command).]

## What was not flagged
[Which audits returned zero findings, how many candidates the filter dropped and why. Show the work, not only the survivors.]

## Not checked
[Ledger rows not checked, with reasons; surfaces, repos, or components outside this pass.]
```

## Phase 6 — Ask before fixing

After the report, ask which findings to fix — all Critical and High, specific IDs, a category, or none. **Do not start fixing until the user picks.**

When the user selects, do not fix directly in one pass. Add one task per finding (or per tightly coupled group) with the `tasks` tool, ordered by severity, exploitability and dependency. Each task needs a short title and a standalone prompt containing: the finding ID, the risk scenario, the affected files and anchors, the concrete remediation, an instruction to check security-sensitive implementation details against authoritative documentation before editing, the project's verification commands, and an instruction to re-check the finished fix against authoritative documentation before completing. Then tell the user where to find the task list, and do not begin executing unless they say so.

If a Critical finding involves an exposed live credential, do not wait for the fix queue: tell the user to rotate it now, in the first line of the report.

## Standards mapping

Cite these in the `Category`/`CWE` fields, not in prose. Re-verified 27 Nov 2026; re-verify before quoting as current.

- **OWASP Top 10:2025** (final) — A01 Broken Access Control (SSRF folded in), A02 Security Misconfiguration, A03 Software Supply Chain Failures, A04 Cryptographic Failures, A05 Injection, A06 Insecure Design, A07 Authentication Failures, A08 Software or Data Integrity Failures, A09 Security Logging & Alerting Failures, A10 Mishandling of Exceptional Conditions. Note the renumbering: A03 is supply chain now, not injection.
- **CWE Top 25 (2025 edition)**, top ten in order — CWE-79 XSS, CWE-89 SQLi, CWE-352 CSRF, CWE-862 Missing Authorization, CWE-787 Out-of-bounds Write, CWE-22 Path Traversal, CWE-416 Use After Free, CWE-125 Out-of-bounds Read, CWE-78 OS Command Injection, CWE-94 Code Injection.
- **OWASP API Security Top 10 (2023, still current)** — API1 BOLA, API2 Broken Authentication, API3 BOPLA, API4 Unrestricted Resource Consumption, API5 Broken Function Level Authorization, API6 Unrestricted Access to Sensitive Business Flows, API7 SSRF, API8 Misconfiguration, API9 Improper Inventory Management, API10 Unsafe Consumption of APIs.
- **OWASP ASVS 5.0.0** (May 2025) — ~350 requirements, cumulative L1/L2/L3. Requirement IDs were renumbered from 4.x; do not cite a 4.x ID as 5.0.
- **OWASP Top 10 for LLM Applications 2026** — LLM01:2026 Prompt Injection … LLM10:2026 Improper Output Handling (renumbered from 2025; cite IDs with the year).
- **OWASP Top 10 for Agentic Applications (2026)** — ASI01 Agent Goal Hijack, ASI02 Tool Misuse and Exploitation, ASI03 Identity and Privilege Abuse, ASI04 Agentic Supply Chain Vulnerabilities, ASI05 Unexpected Code Execution, ASI06 Memory and Context Poisoning, ASI07 Insecure Inter-Agent Communication, ASI08 Cascading Failures, ASI09 Human-Agent Trust Exploitation, ASI10 Rogue Agents (exact titles not re-read from OWASP; cite by ID).
- **OWASP MASVS v2.1.0** — eight categories (STORAGE, CRYPTO, AUTH, NETWORK, PLATFORM, CODE, RESILIENCE, PRIVACY). **There are no L1/L2 levels since v2.0.0**; cite MASTG test IDs instead.
