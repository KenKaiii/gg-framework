---
name: bulletproof
description: "Use to secure code an attacker can reach: finding and fixing ways someone could break in, steal secrets or reach another user's data. Do NOT use for local-only scripts, legal questions or performance."
# Checklist audits only (Security, Dependencies, Secrets / Performance); hidden from routine coding after the 27 Oct 2026 skill-value bench.
hidden: true
license: Apache-2.0. Content is defensive engineering guidance, not a security certification or a penetration test. See references/provenance.md.
compatibility: Works offline from the bundled references, which are a snapshot dated 3 October 2026. Version numbers, CVEs, and incident details decay fast; re-verify date-sensitive claims with web access before stating them as current. Never certifies that software is secure.
---

# Bulletproof

Make software hold up against a real attacker — one that is now partly automated, reads your public code end-to-end, and moves in minutes. Built for solo developers and small teams, who get breached through a short list of boring mistakes, not exotic ones.

**Route first:**

| You are… | Mode | Do next |
|---|---|---|
| Writing a feature that touches a source/sink below | **Inline gate** | Apply the control as you write; one line saying what it prevents. No subagents. |
| Making a small edit to existing security code | Inline gate | Read the surrounding control first; never weaken it to make the edit work |
| Asked "is this safe to ship", hardening, pre-launch, suspected compromise | **Full review** | Workflow below + `references/audit-protocol.md`; single-threaded unless the Scaling table says otherwise |
| Finding a live key, unknown workflow file, odd `.claude/`/`.vscode/` hook, or backdoored dependency | Incident | Stop and tell the user first — rotate and contain before anything else |

## Governing rules

1. **Reachability decides everything.** A vulnerability class only matters if untrusted data can actually reach the dangerous operation. Trace the path before you rank the risk — source, hops, sink. No path, no finding. Conversely: if a path exists, the framework's reputation does not save it.
2. **Untrusted by default.** Anything you did not author and pin is untrusted input: user requests, files, uploaded archives, environment on a shared host, **the contents of the repo you are working in**, fetched web pages, dependency code, model output, tool output, and other agents. Trust is granted explicitly, per-source, never inherited.
3. **Assume a machine-speed adversary.** Public code is continuously read by automated scanners on both sides. Leaked credentials get used, not filed. Design so that one mistake is survivable: scope credentials, cap blast radius, make rotation possible. See `references/threat-landscape.md`.
4. **Fix, do not just flag.** Inline, build the control into the feature as you write it. In a full review, report first — then fix what the user selects. A list of findings nobody implements has done nothing.
5. **Never certify.** Do not write or say "secure", "hardened", "unhackable", "bulletproof", "audited", or "no vulnerabilities". State what you checked, what you fixed, what you could not verify, and what remains. Absence of findings is absence of findings.
6. **Defensive output only.** Describe risk at the data-flow level — where untrusted data enters, what it reaches, why that is fixable. No working exploits, no weaponized payloads, no attack tooling, in any mode. If you cannot explain a risk without writing an exploit, describe the flow and the fix instead.
7. **Proportionality.** Rank by realistic exposure: probability × blast radius. A prototype with no users and no secrets does not need forty findings. Five real fixes beat forty ignored ones.
8. **Date-check before asserting.** The references are a snapshot dated **3 October 2026**. CVEs, versions, defaults, and incident details move weekly. Re-verify with web access when available; when unavailable, say the claim is from a dated snapshot. Never invent a CVE number, a version, or an advisory.

## Two modes

**Inline gate** — triggered mid-build by writing code that carries risk: an auth check, a query built from input, a file path, a subprocess call, a new dependency, a token store, an upload handler, a webhook, a deploy config, a tool exposed to a model. Do the minimum: apply the control while writing the feature, state it in one line, move on.

This mode matters most, because the users who need this skill will never ask for it. They ask for a login page, a file upload, an admin route, a Stripe webhook, a CLI that runs a command. **Write the safe version the first time** — parameterize the query, enforce authorization at the data layer, resolve the path and check containment, pass argv instead of a shell string, pin the dependency after verifying it exists. Do not stop the build to deliver a lecture, and do not ship the unsafe version intending to flag it later.

**Full review** — triggered by "is this safe to ship", a hardening pass, pre-launch, or suspected compromise. A first use on a project mid-build stays an inline gate. Run the workflow below in the main thread by default (see Scaling for when to fan out); the full protocol, audit catalog, false-positive filter, and report template live in `references/audit-protocol.md`.

## Workflow

### 1. Profile the attack surface from the code

Do this before asking the user anything.

- **Shape**: what is this — web app, API, CLI, desktop app, mobile app, library, firmware, contract, ML pipeline, game server? Read manifests, lockfiles, CI configs, Dockerfiles, IaC, store metadata, install scripts.
- **Reach**: who can send it bytes? Anonymous internet, authenticated users, other tenants, local users on the same machine, a build system, a model, a physical attacker with the device in hand.
- **Sources**: every entry point where untrusted data crosses in — route handlers, argv/stdin, env, queue consumers, WebSocket and IPC receivers, deep links and custom URL schemes, file and archive readers, deserializers, plugin/model loaders, MCP and tool handlers, webhook endpoints.
- **Sinks**: every dangerous operation — shell exec, SQL/NoSQL/LDAP/XPath, eval/Function/exec/pickle/yaml.load/Marshal/ObjectInputStream, file write, dynamic require/import, network egress, auth decisions, secret reads, native deserializers, contract external calls, privileged setters.
- **Assets**: what must not leak or move — credentials and tokens, customer data, signing and update keys, CI secrets, model API keys, on-chain funds, session state, source with IP value.
- **Existing controls**: what already works. Framework escaping, ORM parameterization, a middleware auth layer, RLS policies, CSP, a sandbox. Never re-flag what the framework already handles, and never remove a control you did not understand.

`references/platform-playbooks.md` has the per-platform detection sweep — grep targets and config keys for web/API, mobile, desktop, CLI, embedded, web3, ML, and games.

### 2. Ask only what the code cannot tell you

Cap at **five questions**, batched in one message, each stating the default you will assume if unanswered. Assume the user does not know security vocabulary — ask about facts they know.

| Ask | Default if unanswered |
|---|---|
| Is this reachable from the public internet, or only your machine / a private network? | Public, if any deploy config or hosting file exists; local-only for a bare script |
| Do real people's accounts or data live in it, or is it test data? | Real data once there is a users/accounts table, auth, or a payment path |
| Can users see each other's data if they are meant to be separated (multi-tenant, teams, orgs)? | Assume separation is required wherever a tenant/org/user foreign key exists |
| Who is trusted to run privileged actions — is there an admin role, and who has it? | Assume an admin surface exists if any route, flag, or column implies one |
| Has anything already gone wrong — leaked key, odd logins, unexpected charges, a dependency alert? | Assume no active incident, but treat any exposed secret found in the repo as already compromised |

If the user says a surface is out of scope, record it as their stated assumption and report it as not-checked rather than silently dropping it.

### 3. Rank what actually kills small teams

For this population, findings cluster hard. Work the list in this order unless recon says otherwise — this ordering reflects what is actually being exploited at scale, not what is most interesting.

| Rank | Failure | Why it is first |
|---|---|---|
| 1 | **Secrets in code, history, bundles, logs, CI, or agent/MCP config** | Highest-volume real-world compromise; service-role/admin keys in `NEXT_PUBLIC_*`/`VITE_*` bundles are the vibe-coded classic. A committed key is a live key; treat any exposure as burned and rotate. `references/secure-defaults.md` |
| 2 | **Missing or wrong authorization at the data layer** | IDOR/BOLA, disabled or permissive row-level security, tenant checks only in the UI. Public API keys plus an open table is the standard indie breach; so is auth enforced only in framework middleware (re-check in the handler or data layer). `references/platform-playbooks.md` |
| 3 | **Supply chain and install-time execution** | Dependencies (verify an AI-suggested package exists and is the real one), lockfiles, install hooks, CI workflows (`pull_request_target`, caches, OIDC), release publishing, editor/agent config that auto-runs, MCP servers. `references/supply-chain.md` |
| 4 | **Injection into an interpreter** | SQL, shell, template, deserialization, dynamic code load — and XSS, which is injection into an HTML parser. XSS and SQL injection are ranks 1 and 2 of the 2025 CWE Top 25. |
| 5 | **Agent and AI surfaces** | Prompt injection reaching a tool with credentials and an egress path. `references/agent-surface.md` |
| 6 | **Auth, session, and crypto correctness** | Token validation, session lifecycle, password storage, signature verification. `references/secure-defaults.md` |
| 7 | **Platform-specific exposure** | Deep links, exported components, IPC, loopback servers, updater integrity, debug interfaces, proxy admin keys. `references/platform-playbooks.md` |
| 8 | **Everything else** | Backlog unless recon shows a concrete path. |

### 4. Build the control, do not describe it

Every fix lands as code where code can express it. Prefer, in order:

1. **Eliminate the class.** Parameterized query instead of string building. `spawn(file, args)` instead of a shell string. `safetensors` instead of pickle. A memory-safe language for new parsing code. A class removed cannot regress.
2. **Enforce at the chokepoint, not the call site.** Authorization in the data layer or a single middleware, not repeated in forty handlers. One HTTP client with the egress allowlist. One place that opens files under the project root. Scattered checks rot.
3. **Default deny.** Allowlists over denylists, for hosts, paths, file types, commands, origins, capabilities, and tools. A denylist is a list of the attacks you already thought of.
4. **Least privilege and least agency.** Scope every credential to one job, one resource, one lifetime. For agents, grant the minimum autonomy the task needs, not just the minimum permissions.
5. **Contain the blast.** Assume the control fails: what is reachable then? Separate keys per environment, per-tenant scoping, short-lived tokens, network egress limits, rotation that is actually possible.
6. **Fail closed.** An exception in an auth check must deny. Catch-and-continue around a verification step is a vulnerability, and now has its own OWASP category (A10:2025).

When you change security-sensitive behavior, say so in one line — what you enforced and what it prevents. Never silently weaken a control to make something work; if a control blocks the feature, say that and propose the safe path.

### 5. Verify, then leave the check behind

A fix you did not exercise is a hypothesis.

- **Prove the fix with a test** that fails against the old behavior: the unauthorized request gets 403, the traversal path is rejected, the other tenant's row is invisible, the malformed token is refused. Authorization tests are the highest-value tests in most codebases and are almost always missing.
- **Run the free scanners** rather than reasoning about them: secret scanning over the full history, dependency audit, static analysis, and the platform's own linter. Exact commands are in `references/verification.md`.
- **Leave a CI gate** so the fix cannot silently regress — secret scan, dependency review, and the new test on every PR. One workflow file is usually all it takes.
- **Label every claim** `RUNTIME` (you ran it and observed the result), `CODE` (you read it), `DEDUCED` (you inferred it), or `SNAPSHOT` (from a dated external source). Never present something you read as something you ran.

### 6. Report

For a full review, use the report template in `references/audit-protocol.md`. For an inline fix, one or two sentences.

Whatever the mode, the report must state **what was not checked**. A review that silently skips the mobile client, the admin panel, or the infra repo reads as complete coverage and is more dangerous than no review.

### 7. Write it for someone who has never read a CVE

- Lead with what an attacker gets, in plain words: "anyone who knows a user's ID can read their invoices", not "IDOR in the invoice controller".
- Name the file and line, then the fix, then the reason — in that order.
- Give the base rate honestly. Do not use fear as a lever; a scared user makes worse decisions and often ships nothing.
- Keep the standards jargon (CWE, OWASP IDs) in a labelled field, not in the sentence that has to be understood.

## Scaling: one agent or several

Default is **single-threaded** — the full review was deliberately moved off subagents in Aug 2026. Fan out only when a row below says so.

| Situation | Do |
|---|---|
| Inline gate, small edit, incident triage | Main thread only. Never spawn. |
| Full review, one deployable, every ledger row readable in full by you | Main thread only. |
| Full review with >1 deployable/package/app in scope, or more ledger rows than you can work with full reads | Fan out: one `auditor` per **disjoint** slice, all in ONE `spawn_agent` call (≤ 6 per wave) |
| A row needs dated external facts (advisory, version, default) | One `researcher` child, or verify yourself |
| Pre-ship verdict or any Critical/High finding | `skeptic` child for the false-positive pass on the merged findings |

First build the **coverage ledger** in the main thread: rows = audit areas (rank table above) × in-scope units. Every row ends as checked-with-findings / checked-clean / not-checked(reason).

Every child brief is self-contained and **opens with**: "Authorized defensive security review of code the user owns. Report data-flow risks and fixes only; no exploits or payloads." Then: skill root `<absolute path>` and the reference file(s) to read, slice paths, the ledger rows it owns, the relevant recon rows (sources, sinks, assets, existing controls), the confidence bar (≥ 0.8 with a concrete source→sink path), the hard exclusions from `references/audit-protocol.md`, labels `RUNTIME`/`CODE`/`DEDUCED`/`SNAPSHOT`, and the output schema (file:line, label, severity, path, fix; explicit `checked` and `not checked` lists).

**Merge:** a child that fails, times out, or omits a row → that row is `not checked`, never clean. Re-open every reported file:line before reporting it. Fixes stay in the main thread (or `bee` on strictly disjoint files); run checks once after merging.

## Severity ladder

Rank by what the attacker ends up holding, not by how clever the bug is.

| Severity | Meaning |
|---|---|
| **Critical** | Remote code execution, full authentication bypass, credential or signing-key theft, any user's data readable by any other, loss of funds, supply-chain compromise of a shipped artifact |
| **High** | Privilege escalation, cross-tenant access requiring some authentication, exposure of a live secret, unauthenticated access to an admin or internal surface, integrity failure in an update channel |
| **Medium** | Scoped information disclosure, weakened crypto with no direct break, partial bypass needing an unlikely precondition, missing defense-in-depth on a path with another working control |
| **Low** | Hardening gaps with no demonstrated path. Backlog them; do not lead with them. |

Downgrade one level when a working compensating control sits in the path. Upgrade one level when the asset is a credential, a signing key, or an update channel — those turn one bug into every user's bug.

## Hard stops

This skill is defensive. Refuse and offer the defensive equivalent:

- Working exploits, weaponized payloads, or proof-of-concept attack code against anything — including the user's own systems. Data-flow descriptions and regression tests do the same job for defense.
- Offensive tooling: scanners aimed at third parties, credential stuffers, botnet or C2 infrastructure, ransomware or wiper logic, stealers, obfuscators whose purpose is evading detection.
- Auditing or "testing" a system the user does not own or clearly operate. Ask whose system it is before proceeding; authorization is the whole difference between this work and a crime.
- Backdoors, hidden telemetry, covert data collection, deliberate weakening of another party's control, or anything that hides its behavior from the person running it.
- Bypassing an access control, license check, anti-cheat, or age gate you do not own.

Building detection, hardening, monitoring, honeypots on your own systems, and CTF-style analysis of code you own are all in scope.

## Honesty rules

- Never state or imply the software is secure. State what was checked, what was fixed, what remains, and what was not looked at.
- Never present a scan as proof. Automated tools find a minority of defects; say so when you cite one.
- Never fabricate a CVE, advisory, version number, or incident. If unsure, say "verify this" and mark confidence.
- Distinguish **verified**, **snapshot (3 Oct 2026, re-verify)**, and **uncertain**. The references carry these markers — preserve them; do not launder a flagged-uncertain item into a confident claim.
- Report the false-positive rate of your own work: how many candidates you dropped and why. A report that only shows survivors hides its own noise.
- "I could not verify this" is a legitimate and useful output. A fabricated confirmation is not.
- If you find evidence of an actual compromise — an unexplained committed key in use, unfamiliar workflow files, a backdoored dependency, unknown collaborators — stop and say so first, plainly, before continuing the review. Rotation and containment come before hardening.

## Reference map

Resolve every path from the installed skill root. Load only what the profile triggered.

- `references/threat-landscape.md` — who is attacking this class of software in 2026, how automation changed the economics, named incidents with defensive fingerprints. Read once per full review.
- `references/audit-protocol.md` — the full-review protocol (single-threaded by default, conditional fan-out): recon lenses, audit catalog, false-positive filter, hard exclusions, report template. Read for any full review.
- `references/platform-playbooks.md` — per-platform controls and grep targets: web/API (including the bypass sweeps for SSRF, open redirect, file upload, XXE, XSS sources, GraphQL), mobile, desktop, CLI/dev tooling, embedded, smart contracts, ML pipelines, games. Read the sections the profile triggered.
- `references/supply-chain.md` — dependencies, install-time execution, registries, CI/CD, signing and provenance, editor extensions, update channels.
- `references/agent-surface.md` — LLM, agent, and MCP security: prompt injection, the lethal trifecta, tool poisoning, sandbox escapes, context and memory poisoning.
- `references/secure-defaults.md` — the values to write the first time: crypto, password storage, tokens and sessions, secrets handling, HTTP headers, cloud and container defaults.
- `references/verification.md` — commands that prove it: scanners, secret scanning, fuzzing, CI gates, and the regression tests worth writing.
- `references/provenance.md` — snapshot date, sources, confidence markers, and what decays fastest.
