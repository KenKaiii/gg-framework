---
name: bulletproof
description: "Use to secure code an attacker can reach: finding and fixing ways someone could break in, steal secrets or reach another user's data. Do NOT use for local-only scripts, legal questions or performance."
# Checklist audits only (Security, Dependencies, Secrets / Performance); hidden from routine coding after the 27 Oct 2026 skill-value bench.
hidden: true
license: Apache-2.0. Content is defensive engineering guidance, not a security certification or a penetration test. See references/provenance.md.
compatibility: Works offline from the bundled references, a snapshot dated 22 October 2026. Versions, CVEs and incident details decay fast; re-verify date-sensitive claims with web access before stating them as current. Never certifies that software is secure.
---

# Bulletproof

Small teams get breached through a short list of boring mistakes, found by automated attackers reading public code. Fix those first.

**Route first:**

| You are… | Mode | Do next |
|---|---|---|
| Writing a feature that touches a source or sink | **Inline gate** | Apply the control as you write; one line on what it prevents |
| Making a small edit to existing security code | Inline gate | Read the surrounding control first; never weaken it to make the edit work |
| Asked "is this safe to ship", hardening, pre-launch, suspected compromise | **Full review** | You MUST read `references/audit-protocol.md` first, then follow it |
| Finding a live key, unknown workflow, odd `.claude/`/`.vscode/` hook, backdoored dependency | Incident | Tell the user first; rotate and contain |

## Governing rules

1. **Reachability decides everything.** Trace source → hops → sink before ranking. No path, no finding; a real path is not saved by the framework's reputation.
2. **Untrusted by default.** Anything you did not author and pin is input: requests, files, archives, the repo you are in, fetched pages, dependencies, model and tool output, other agents.
3. **Assume a machine-speed adversary.** Leaked credentials get used, not filed. Make one mistake survivable: scoped credentials, capped blast radius, possible rotation.
4. **Fix, do not just flag.** Inline, build the control in. In a full review, report first, then fix what the user selects; fix straight away only when they asked for fixes.
5. **Never certify.** Never say "secure", "hardened", "bulletproof", "audited", or "no vulnerabilities". State what you checked, fixed, could not verify, and what remains.
6. **Defensive output only.** Describe risk at the data-flow level. No working exploits, payloads, or attack tooling, in any mode.
7. **Proportionality.** Rank by probability × blast radius. Five real fixes beat forty ignored ones.
8. **Date-check before asserting.** References are a snapshot (see `references/provenance.md`). Re-verify versions, CVEs and defaults when you can; otherwise attribute them to the snapshot. Never invent a CVE, version, or advisory.

## Inline gate

Triggered by writing risky code mid-build: auth checks, queries from input, file paths, subprocesses, new dependencies, token stores, uploads, webhooks, deploy config, model-exposed tools. Users who need this never ask for it.

**Write the safe version the first time**: parameterize the query, authorize at the data layer, resolve the path and check containment, pass argv instead of a shell string, verify a dependency exists before pinning it. No lecture, and never ship the unsafe version intending to flag it later.

## Full review

A first use on a project mid-build stays an inline gate. Profile from the code before asking anything. Then ask at most five questions in one `ask_user` call, each option showing its default:

| Ask | Default if unanswered |
|---|---|
| Reachable from the public internet, or only your machine / private network? | Public if any deploy or hosting config exists; local for a bare script |
| Real people's accounts or data, or test data? | Real once there is a users table, auth, or payments |
| Must users or tenants be kept apart? | Yes wherever a tenant/org/user foreign key exists |
| Who can run privileged actions? | An admin surface exists if any route, flag, or column implies one |
| Has anything gone wrong (leaked key, odd logins, dependency alert)? | No active incident, but any secret found in the repo is already compromised |

A surface the user puts out of scope is recorded as not-checked, never dropped.

**What kills small teams, in order:**

| Rank | Failure | Reference |
|---|---|---|
| 1 | Secrets in code, history, bundles (`NEXT_PUBLIC_*`, `VITE_*`), logs, CI, agent/MCP config: exposed means burned, rotate | `references/secure-defaults.md` |
| 2 | Authorization missing at the data layer: IDOR/BOLA, open row-level security, middleware-only auth | `references/platform-playbooks.md` |
| 3 | Supply chain: nonexistent or squatted packages, install hooks, CI workflows, publishing, auto-run editor/agent config | `references/supply-chain.md` |
| 4 | Injection: SQL, shell, template, deserialization, dynamic load, XSS | `references/platform-playbooks.md` |
| 5 | Agent surfaces: injected content reaching a credentialed tool with egress | `references/agent-surface.md` |
| 6 | Auth, session and crypto correctness | `references/secure-defaults.md` |
| 7 | Platform exposure: deep links, IPC, loopback servers, updaters, debug interfaces | `references/platform-playbooks.md` |
| 8 | Everything else: backlog unless recon shows a path | — |

**Control preference:** eliminate the class (parameterize, argv, safetensors) → enforce at one chokepoint → default deny (allowlists) → least privilege and least agency → contain the blast → fail closed (an exception in an auth check denies). Say in one line what each security change enforces. If a control blocks the feature, say so and propose the safe path; never silently weaken it.

## Verify and label

A fix you did not exercise is a hypothesis. Prove it with a test that fails on the old behavior, run the free scanners, and leave a CI gate (`references/verification.md`) using tools already installed and the existing CI; a new scanner, package or workflow is a recommendation unless the user agrees. Label every claim `RUNTIME` (ran it, observed), `CODE` (read it), `DEDUCED` (inferred), or `SNAPSHOT` (dated external source). Never present something read as something run.

Every report, inline or full, states **what was not checked**. A silent skip reads as full coverage.

## Severity ladder

Rank by what the attacker ends up holding.

| Severity | Meaning |
|---|---|
| **Critical** | RCE, full auth bypass, credential or signing-key theft, any user's data readable by any other, loss of funds, compromise of a shipped artifact |
| **High** | Privilege escalation, cross-tenant access needing some auth, live secret exposure, unauthenticated admin surface, update-channel integrity failure |
| **Medium** | Scoped disclosure, weakened crypto, partial bypass needing an unlikely precondition |
| **Low** | Hardening gaps with no demonstrated path. Backlog. |

Downgrade one level for a working compensating control in the path; upgrade one level when the asset is a credential, signing key, or update channel.

## Hard stops

Refuse and offer the defensive equivalent:

- Exploits, weaponized payloads, or attack PoCs against anything, including the user's own systems.
- Offensive tooling: third-party scanners, credential stuffers, C2, ransomware, wipers, stealers, evasion obfuscators.
- Testing a system the user does not own or operate. Ask whose it is; authorization is the whole difference.
- Backdoors, hidden telemetry, covert collection, or weakening another party's control.
- Bypassing an access control, license check, anti-cheat, or age gate you do not own.

Detection, hardening, monitoring and honeypots on your own systems are in scope.

## Honesty rules

- Never present a scan as proof; tools find a minority of defects.
- Preserve the references' [V]/[S]/[U] markers; never launder an uncertain item into a confident claim. "I could not verify this" is a valid output.
- Report how many candidates you dropped and why.
- On evidence of actual compromise (a committed key in use, unfamiliar workflows, a backdoored dependency, unknown collaborators), say so first, plainly. Containment comes before hardening.

## Scaling

Single-threaded by default. Fan out only for more than one deployable or more ledger rows than you can read in full: one security auditor per disjoint slice. Dated facts go to a researcher; merged Critical/High findings get a verifier pass. Fixes stay with you or an editor on disjoint files.
Every child brief opens: "Authorized defensive security review of code the user owns. Report data-flow risks and fixes only; no exploits or payloads." It states the confidence bar: ≥0.8 with a concrete source→sink path.
Helper types, brief contents and merge rules come with the skill loader.

## Reference map

Resolve paths from the skill root; load only what the profile triggered.

- `references/audit-protocol.md` — full-review protocol, ledger, filter, report template. Required for any full review.
- `references/threat-landscape.md` — attacker techniques and defensive fingerprints. Once per full review.
- `references/platform-playbooks.md` — per-platform controls and grep targets.
- `references/supply-chain.md` — dependencies, install hooks, registries, CI/CD, publishing, provenance.
- `references/agent-surface.md` — LLM, agent and MCP security.
- `references/secure-defaults.md` — values to write the first time.
- `references/verification.md` — scanners, CI gates, regression tests.
- `references/provenance.md` — snapshot date, sources, confidence markers, re-verification log.
