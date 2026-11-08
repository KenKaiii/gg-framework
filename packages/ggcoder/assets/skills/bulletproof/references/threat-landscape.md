# Threat Landscape — snapshot 3 October 2026

Why the defaults in this skill are what they are. Confidence markers: **[V]** verified against a primary source at snapshot time, **[S]** snapshot-accurate but volatile, **[U]** uncertain or single-sourced. Preserve the markers when you repeat these claims.

Read this once per full review to set the threat model. Do not paste incident lists into a report — cite only the ones that map to a finding.

## 1. What automation actually changed

**Confirmed: AI-orchestrated intrusion is real and operational.**

- **GTG-1002** [V] — Anthropic disclosed (13 Nov 2025) the first documented largely-autonomous AI-orchestrated espionage campaign: an actor it assessed as China state-sponsored drove a coding agent wired to tooling over MCP through recon, vulnerability discovery, exploitation, credential harvesting and exfiltration against roughly 30 organizations, with 80–90% of tactical work machine-executed and a small number of intrusions succeeding. The operators got the model to cooperate by **posing as a security firm doing authorized defensive testing** — so a defensive framing in a brief is necessary, never sufficient; the Hard stops still apply.
- **Runtime LLM use inside malware** [U] — Google GTIG (Nov 2025) reported malware families that query a hosted model at runtime for obfuscation or collection commands. Not re-verified for this snapshot.
- **Machine-found bugs at scale** [V] — Anthropic's Project Glasswing reported 23,019 vulnerability candidates; by late July 2026 about 126 had become published CVEs and one was confirmed exploited (per VulnCheck). Candidates are not CVEs, and CVEs are not exploitation.

**The honest counterweight — do not overstate this.** VulnCheck (28 Jul 2026) [V] found that of ~1,061 vulnerabilities attributed to AI-assisted discovery, only about 1.3% are confirmed exploited in the wild — roughly the same rate as vulnerabilities generally. Discovery volume is not exploitation volume. Machine-scale scanning has moved the bottleneck to **maintainer capacity to triage, patch, test and ship**, which is exactly where a small team is weakest.

**What this means for the code you write:**

1. Assume any public repository has been read end-to-end by an automated system. Obscurity was never a control; now it is not even a delay.
2. The bug classes machines find fastest are the ones with a cheap verification oracle — web/API classes and memory-safety in parsers. Business logic and multi-actor authorization remain comparatively hard for them, and remain where the expensive breaches happen.
3. Patch latency is now the dominant controllable variable. A dependency you cannot update quickly is a standing liability.
4. Breakout speed is measured in minutes [U] (vendor threat reports; not re-verified). Detection that requires a human to read a dashboard within the hour is not a control.

## 2. Supply chain — the dominant compromise route for small teams

Named incidents, with the fingerprint a defender can grep for. All [V] unless marked.

**The self-propagating npm worm lineage.** Shai-Hulud (Sept 2025) established the pattern: steal a publish token, enumerate every package the victim can publish, inject, republish. The November 2025 wave added destructive behavior. GitGuardian's analysis of 6,943 compromised developer machines found **59% were CI/CD runners rather than laptops** [V] — CI is the real target.

Successor waves worth knowing because each broke a different assumption:

- **TanStack / "Mini Shai-Hulud" (11 May 2026)** [V] — 84 malicious versions across 42 `@tanstack/*` packages in about six minutes, with **no npm token stolen**. Chain (from the maintainers' postmortem): a fork PR triggered a `pull_request_target` workflow that ran fork code; it poisoned the shared Actions cache (pnpm store); the release workflow later restored that cache; attacker code then read the OIDC token from runner memory and published. Fixes the maintainers shipped: restructured the PR workflow, repository-owner guards, third-party actions pinned to SHAs, caches purged.
- **Miasma "Phantom Gyp" waves (mid-2026)** [S] — ran code at install time through a bare `binding.gyp` (implicit `node-gyp rebuild`) with no lifecycle script in `package.json`, evading scanners that only watch `preinstall`/`postinstall`.
- **ChainDrop (4 Aug 2026)** [V] — a self-propagating worm starting from a malicious commit in `keyv`, reaching hundreds of packages within hours; releases published through hijacked GitHub Actions OIDC carried **valid provenance**. Two properties matter more than scale:
  - **Persistence outside the registry.** Using stolen GitHub tokens it committed a `SessionStart` hook in `.claude/settings.json` and a `runOn: folderOpen` task in `.vscode/tasks.json` to every eligible branch, authored as `claude <claude@users.noreply.github.com>`. Opening the repo in Claude Code or VS Code executed it; no `npm install` needed. Lockfile fixes do not remove it — check all branches.
  - **AI credentials are loot.** It read `.claude`, `.cursor`, and model-provider auth files alongside cloud keys [S].

**Provenance proves where an artifact was built, not that the build was honest.** Both 2026 worms shipped valid provenance. Treat it as necessary, not sufficient.

**CI/CD.** The `tj-actions/changed-files` compromise (Mar 2025, CVE-2025-30066) [S] retroactively repointed version tags at a malicious commit and dumped secrets into build logs. **A mutable tag is not a pin. Pin actions by commit SHA** — GitHub itself recommends it and lets admins enforce it [V].

**Slopsquatting.** Spracklen et al. (USENIX Security 2025) [V]: across 576,000 generated code samples from 16 models, 19.7% of recommended packages did not exist (205,474 unique invented names); commercial models did far better than open ones but not zero. When hallucinating prompts were re-run ten times, 43% of names recurred every time — predictable, so registrable. **Agents removed the human "does that name look right" checkpoint.** Verify a package exists, is old enough, and is the one you meant, before adding it — see `supply-chain.md`.

**Editor extensions and MCP servers.** Lookalike-extension campaigns on open registries are recurring [U]; extensions auto-update by default and registry removal does not clean installed copies. The first malicious MCP server in the wild, `postmark-mcp` (Koi Security, Sept 2025) [V], copied the official Postmark server under the same npm name, shipped 15 clean versions, then in 1.0.16 added one line BCC-ing every outgoing email to the attacker.

## 3. AI coding agents as an attack surface

If the project you are hardening is itself an agent, a tool server, or ships an AI feature, read `agent-surface.md` in full. The headline facts:

- **Prompt injection has no known reliable prevention** [V]. "The Attacker Moves Second" (Nasr et al., Oct 2025) bypassed 12 published defenses with >90% success for most using adaptive attacks; human red-teaming succeeded on every scenario. Design for containment, not for a filter that holds.
- **The lethal trifecta** — private data access + untrusted content + an egress channel. Any two are usually fine; all three is exploitable. This is the single most useful architectural test for an agent feature.
- **Sandbox escapes were the 2026 bumper crop** [U] — multiple critical-severity escapes across the major coding-agent products, including symlink-based escapes and configuration-file protections bypassed from inside the sandbox. The recurring root pattern: **files the agent writes inside the sandbox are later read, loaded, or executed by a trusted process outside it.**
- **Rules-file and skill backdoors** [S] — instructions hidden in `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, or a shared skill using invisible Unicode (tag codepoints, bidi controls, zero-width characters) land directly in the model's context. Documented payloads have instructed agents to exfiltrate local `.env` contents while suppressing output, and to inject credential-harvesting code into every file they generate — turning the agent into the delivery mechanism for a backdoor that reaches CI and production.
- **Fetched content is executable-adjacent** [S] — a malicious issue in a public repository was enough to make an assistant leak private repository contents; a support ticket containing embedded instructions caused an agent holding a privileged database credential to publish secrets back into a public thread.
- **Repo config is now a worm vector** [V] — ChainDrop (above) persisted in agent and editor config. An agent that auto-loads hooks or auto-runs tasks from the repo it opens is executing the repo author's code.

## 4. What is actually being exploited against small teams

- **Secret sprawl is the number one route.** GitGuardian's *State of Secrets Sprawl 2026* (Mar 2026) [V]: 28.65M new hardcoded secrets in public GitHub commits in 2025 (+34%); AI-service secrets up 81%; 24,008 unique secrets in public MCP configuration files; Claude Code-assisted commits leaked at 3.2% vs a 1.5% baseline; and **64% of valid secrets from 2022 still valid** — leaks are not revoked.
- **Backend-as-a-service row-level security is the highest-yield indie misconfiguration.** CVE-2025-48757 [S] covered 170+ apps generated by a vibe-coding platform whose Supabase tables lacked RLS, so the public anon key in the page read and wrote everything. Failure modes to check, all [S]: RLS disabled; a permissive `using (true)` policy (what a generator writes when told "add a policy" with no rule); reads locked but writes open; a service-role key in the client bundle; `auth.uid()` present but not compared to the owner column. Generated schemas converge on the same table names, so enumeration is trivial.
- **Middleware-only auth** [V] — CVE-2025-29927 let any client skip Next.js middleware (fixed in 15.2.3 / 14.2.25 / 13.5.9) by sending an internal `x-middleware-subrequest` header. Apps that checked auth only in middleware were fully open. Enforce authorization again in the route handler or data layer.
- **Exposed AI and developer infrastructure** [U] — tens of thousands of internet-facing local-inference servers, plus smaller populations of notebook, experiment-tracking and MCP endpoints. Note the honest caveat from the same research: it recorded essentially no AI-aware exploitation; the traffic hitting those ports was generic credential-harvesting scanning probing for `.env` files and cloud secrets. Generic scanners find you first.
- **AI gateways concentrate credentials** [U] — a compromised dependency in a gateway library can expose an organization's entire portfolio of model provider keys at once. Several agent-framework and low-code AI platform CVEs have been used for initial access, credential harvesting and lateral movement, with at least one on CISA's exploited-vulnerabilities catalog.
- **Do not over-rotate to AI, though** [V] — one-third of known-exploited vulnerabilities in the first half of 2026 were content-management systems (VulnCheck 1H-2026), with network edge devices next. If the project runs a CMS or sits behind an appliance, that is the likelier door.

## 5. Speed and economics

- **Median time from CVE publication to confirmed exploitation fell from about 120 days (2025) to about 80 days (1H 2026)** [S] (VulnCheck 1H-2026). Known-exploited vulnerabilities grew ~10% while published CVEs grew ~45%, so the exploited *share* is falling even as *speed* rises.
- **Leaked credentials are used, not archived.** Assume any secret that touched a public surface, a build log, a paste, or a third-party service is compromised at the moment of exposure. Rotation is the fix; deleting the commit is not.
- **Patch aggressively where there is evidence of exploitation.** Guidance in 2026 [S] points toward days, not weeks, for vulnerabilities that are automatable, exploited, and reachable in your deployment.

## How to use this file

1. Pick the two or three items above that plausibly apply to *this* project and write them into the threat model as concrete scenarios with named actors and objectives.
2. Skip the rest. A threat model that lists every incident of the last two years is not a threat model.
3. Re-verify anything marked [S] or [U] before putting it in front of the user as current fact.
