# Provenance

## Contents
- Confidence markers
- Re-verified 3 October 2026
- Re-verified 22 October 2026
- Re-verified 22 November 2026
- Re-verified 27 November 2026
- Methodology update 27 November 2026
- Source classes
- Known gaps in this snapshot
- What this skill is not
- When to escalate to a human specialist

**Snapshot date: 3 October 2026**, partially re-verified **22 October 2026** and **22 November 2026** (previous full snapshot 12 August 2026). Items re-verified on either date are listed below; anything else carries its marker from the earlier snapshot. Security facts decay faster than any other content in this repository — a version number, a CVE, a default, or an incident detail that was accurate at snapshot time may be wrong by the time you read it.

## Confidence markers

Used throughout the reference files. Preserve them when repeating a claim to the user.

| Marker | Meaning | How to treat it |
|---|---|---|
| **[V]** | Verified against a primary source (standards body, vendor advisory, official documentation, CVE record) at snapshot time | State it plainly, with the date if it matters |
| **[S]** | Snapshot-accurate but volatile — versions, adoption status, statistics, vendor defaults | Re-verify before asserting as current; otherwise attribute to the snapshot |
| **[U]** | Single-sourced, secondary, or methodology not published | Do not build a recommendation on it alone; say it is uncertain |

Unmarked engineering guidance (parameterize queries, fail closed, least privilege) is durable practice, not a dated claim.

## Re-verified 3 October 2026

| Claim | Primary source |
|---|---|
| OWASP Top 10:2025 order (A01 Broken Access Control … A03 Software Supply Chain Failures … A10 Mishandling of Exceptional Conditions; SSRF folded into A01) | top10.owasp.org/2025 |
| 2025 CWE Top 25: 1 XSS, 2 SQLi, 3 CSRF, 4 Missing Authorization | MITRE CWE Top 25 (Dec 2025) |
| OWASP Top 10 for Agentic Applications 2026 (ASI01–ASI10), published 9 Dec 2025 | OWASP GenAI Security Project |
| MCP 2025-11-25 (superseded 22 Oct: see below) | modelcontextprotocol.io changelog |
| npm: classic tokens revoked 9 Dec 2025; 2-h session tokens; staged publishing GA 22 May 2026 (CLI 11.15.0); npm 12 scripts off by default (8 Jul 2026) | GitHub Changelog; npm release notes |
| GitHub Actions: SHA-pin enforcement policy (Aug 2025); `pull_request_target` default-branch source (8 Dec 2025); checkout fork-ref refusal (Jun/Jul 2026) | GitHub Changelog |
| TanStack compromise chain (11 May 2026) | TanStack postmortem |
| ChainDrop (4 Aug 2026) `.claude/settings.json` / `.vscode/tasks.json` persistence | Datadog Security Labs, StepSecurity |
| `postmark-mcp` BCC backdoor (Sept 2025) | Koi Security via press |
| CVE-2025-29927 Next.js middleware bypass | Vendor advisory / NVD |
| Package hallucination 19.7% / 43% recurrence | Spracklen et al., USENIX Security 2025 |
| GitGuardian 2026: 28.65M secrets, 24,008 in MCP configs, 64% of 2022 secrets still valid | State of Secrets Sprawl 2026 |
| NIST SP 800-63B-4 final (31 Jul 2025), syncable authenticators up to AAL2 | pages.nist.gov/800-63-4 |
| RFC 9700 current; OAuth 2.1 still a draft | IETF datatracker / oauth.net |
| X25519MLKEM768 default in OpenSSL 3.5, Chrome, Firefox | OpenSSL; browser release notes |
| GTG-1002 (13 Nov 2025) | Anthropic disclosure |
| VulnCheck 1H-2026: 1.3% of 1,061 AI-found vulns exploited | VulnCheck report (28 Jul 2026) |
| Adaptive attacks bypass 12 prompt-injection defenses | Nasr et al., arXiv 2510.09023 |

Dropped as not re-verifiable this pass: specific breakout-time figures, the "38% of organizations" workflow statistic, the 77-extension campaign count, the March 2026 scanner-action tag incident, ATT&CK campaign IDs, and Anthropic's banned-account mapping figures.

## Re-verified 22 October 2026

| Claim | Marker | Primary source |
|---|---|---|
| MCP current spec 2026-07-28: stateless (no initialize / `Mcp-Session-Id`), `Mcp-Method`/`Mcp-Name` headers, `requestState`, cacheable listings, DCR deprecated for CIMD, RFC 9207 `iss`, Roots/Sampling/Logging deprecated ≥12 months, MCP Apps | [V] (coordinator) | claude.com/blog/bringing-mcp-2026-07-28-to-claude; modelcontextprotocol.io/specification/2026-07-28 |
| MCP Streamable HTTP: MUST validate `Origin`, 403 if present and invalid; SHOULD bind localhost | [V] | modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http |
| OAuth 2.1 still an Internet-Draft (draft-ietf-oauth-v2-1-16) | [V] | datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/ |
| npm: unvalidated trusted-publishing configs expire; staged publishing supports new packages (both 2 Oct 2026) | [V] | github.blog/changelog (2026-10-02 entries) |
| npm refuses trusted-publishing tokens from `issue_comment`; 48-hour validation window; SlugFest (Bloom Security, 13 Oct 2026) | [S] | Secondary reporting (workos.com, cybersecuritynews.com); changelog body not readable this pass |
| `tensorlake@0.5.144` malware advisory, 8 Oct 2026 | [V] | github.com/advisories/GHSA-rqxj-g25x-4v9v |
| tensorlake: valid provenance, preinstall hook, pushed to main | [S] | Aikido, StepSecurity reporting |
| Next.js 14 Oct 2026 critical RCEs (`use cache` typed arrays; SVG via sharp/librsvg) + Server Actions DoS | [V] (coordinator) | Next.js advisories |
| Node.js 21 Oct 2026 security releases incl. Brotli decoder OOB write and TLS hostname bypass | [V] | nodejs.org/en/blog/vulnerability/october-2026-security-releases |
| CWE Top 25 2025 is still the latest edition | [V] | cwe.mitre.org/top25 |

Changed this pass: `threat-landscape.md` rewritten as technique + fingerprint (counts and statistics dropped); package-manager version minimums for release-age cooldowns replaced with a rule; the "~80 days to exploitation" figure dropped.

## Re-verified 22 November 2026

| Claim | Marker | Primary source |
|---|---|---|
| OWASP Top 10 for LLM Applications 2026 (4 Aug 2026), renumbered; every bare LLMxx ID rewritten as LLMxx:2026 | [V] | github.com/GenAI-Security-Project/GenAI-LLM-Top10 |
| GitHub blocks `pull_request_target` by default in public repos from 2 Dec 2026 (brownouts 9 and 16 Nov) | [V] title/date; [S] scope | github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2/ ; socket.dev |
| Next.js 3 Nov 2026 security release (16.4.5 / 15.5.29), incl. `use cache` cross-tenant disclosure GHSA-mfr8-8qww-v76h | [V] | nextjs.org/blog/november-2026-security-release |
| Node.js 11 Nov 2026 security releases (22.23.5, 24.22.3, 26.13.1) | [V] | nodejs.org/en/blog/vulnerability/november-2026-security-releases |
| OAuth 2.1 at draft-ietf-oauth-v2-1-17, still an Internet-Draft | [V] | datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/ |
| MCP: no spec revision after 2026-07-28 | [V] | blog.modelcontextprotocol.io |
| CWE Top 25 2025 still the latest; CWE 5.0 (28 Oct 2026) deprecates CWE-377/391/613, none cited here | [V] | cwe.mitre.org/news/archives/news2026.html |

Not added, unverified: React Server Components CVE-2026-126187 (date disputed, React advisory not reached; resolved 27 Nov, below); GitHub secret scanning of Actions logs and Agentic Workflows GA (changelog bodies not read); the OWASP Agent Control Standard (not read). No supply-chain incident from 22 Oct to 22 Nov 2026 could be confirmed from a primary source: that is "no hits", not "none happened".

## Re-verified 27 November 2026

Unchanged and re-confirmed: MCP 2026-07-28 still current; OAuth 2.1 draft -17; RFC 9700; OWASP Top 10:2025, LLM Top 10 2026, API Top 10 2023, ASVS 5.0.0, MASVS 2.1.0 / MASTG 2.0.0; CWE Top 25 2025; NIST SP 800-63B-4; Node.js 11 Nov and Next.js 3 Nov releases still the latest security releases; npm 12 script blocking, staged publishing, 48-hour trusted-publishing expiry; GitGuardian 2026 figures; OpenSSL 3.5 and Firefox hybrid PQ defaults; CRA dates; UK PSTI; Electron fuse names.

| Claim | Marker | Primary source |
|---|---|---|
| React RSC CVE-2026-126187 (GHSA-xqc2-xf4c-x3h3), published 14 Oct 2026, fixed in 19.0.9 / 19.1.10 / 19.2.9 / 19.3.1 | [V] | github.com/advisories/GHSA-xqc2-xf4c-x3h3 |
| Solidity 0.8.39 (19 Nov 2026) current; 0.8.37–0.8.39 security fixes; 0.9.0-pre.1 (26 Nov 2026) | [V] | github.com/argotorg/solidity/releases |
| Granular-token direct publishing removed January 2027 (was [U]) | [V] | docs.npmjs.com/about-access-tokens |
| npm refuses trusted publishing from `issue_comment`; `strict-allow-scripts` (were [S]) | [V] | docs.npmjs.com/trusted-publishers; npm CLI config definitions |
| `pull_request_target` default policy: public repos without their own event policy, enforced 2 Dec 2026; read-only default-branch cache unless `cache-mode` opts out | [V] | docs.github.com/en/actions/reference/security/securely-using-pull_request_target |
| `actions/checkout` backports shipped 20 Jul 2026 (not 16 Jul); opt-out `allow-unsafe-pr-checkout` | [V] | github.com/actions/checkout/releases |
| ChainDrop hooks pushed as GitHub-signed `github-actions[bot]` commits (previous author detail not supported by the source) | [V] | securitylabs.datadoghq.com (5 Aug 2026) |
| Apple Developer ID G2 certificates last one year; original authority expires 1 Feb 2027; the 460-day cap is the CA/B code-signing rule (CSC-31), not Apple's | [V] | developer.apple.com/help/account/certificates; cabforum.org ballot CSC-31 |
| Google Play: target API 36 since 31 Aug 2026, extensions to 1 Nov 2026 | [V] | support.google.com/googleplay/android-developer/answer/11926878 |
| Apple OS 26 system TLS advertises X25519MLKEM768 | [V] | support.apple.com/en-us/122756 |
| "The Attacker Moves Second": the "human red-teamers beat every scenario" wording is not in the abstract; rewritten to what the abstract states | [V] | arxiv.org/abs/2510.09023 |
| MCP: binding local servers to 127.0.0.1 is a SHOULD, not a MUST | [V] | modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http |
| OWASP Agentic Top 10 titles: two files disagreed; aligned to the commonly cited titles | [S] | official page not readable this pass; cite by ASI ID |
| US Cyber Trust Mark: FCC sought comment on labeling rules in Oct 2026 | [S] | FCC DA-26-834A1; Oct notice via secondary reporting |

Not added: a Vite advisory (GHSA-p4f5-76q4-ffq7) reported by search could not be opened; Django, Rails and Electron advisories from Oct–Nov 2026 are routine patch releases, covered by the "patch latency" rule. No supply-chain or AI-agent incident from 22 to 27 Nov 2026 could be confirmed from a primary source: "no hits", not "none happened".

## Methodology update 27 November 2026

This section changed no dated facts (those are logged above). The review method was compared with Cloudflare's open-source `security-audit` skill (github.com/cloudflare/security-audit-skill, MIT License, © 2025–2026 Cloudflare, Inc.), and these ideas were adapted, in new wording, for small teams and a single agent:

- `attack-classes.md`: one section per audit in a fixed shape, pasted verbatim into child briefs; new audits for data lifecycle and derived copies, business logic and races, webhooks, the HTTP edge and caching, and denial of wallet.
- `audit-protocol.md`: the six-field candidate gate, the self-impact exclusion, hunting depth (sibling paths, edge inputs), the needs-validation outcome, one coverage gap pass, root-cause merging, safe execution limits for code the user did not write, and the rule that a review ends complete or explicitly incomplete.
- Controls for webhooks, account linking, reset-link host poisoning, private-response caching, IPC caller identity, privileged helpers and logout cleanup in `secure-defaults.md` and `platform-playbooks.md`.

Not adopted: its multi-agent hunting waves, budget accounting, JSON schema and validators, and the descriptor-level artifact promotion procedure. They suit a security team's fleet, not a single-agent review.

## Source classes

- **Standards and frameworks**: OWASP (Top 10:2025, ASVS 5.0.0, API Security Top 10 2023, MASVS 2.1.0 / MASTG 2.0.0, LLM Top 10 2026, Agentic Top 10 2026), MITRE (CWE Top 25 2025 edition, ATT&CK), NIST (SP 800-63B-4, SP 800-218 / 218A, SP 800-53 Rev 5, FIPS 203/204/205), SLSA, OpenSSF.
- **Vendor and platform documentation**: Apple, Google/Android, Microsoft, Electron, Tauri, PyTorch, Solidity, package registries.
- **Incident reporting and threat intelligence**: model-provider security disclosures, national CERT and CISA advisories, established security-vendor research teams, and independent researchers with published methodology.
- **Regulatory texts**: EU Cyber Resilience Act, UK PSTI.

Statistics and incident details in `threat-landscape.md` come from published reports whose methodology varies in quality. Where a figure is widely repeated but the primary methodology is not published, it is marked [U] and should not be quoted as fact.

## Known gaps in this snapshot

- **ASVS 5.0 chapter structure** — sources disagree on the exact chapter count; requirement IDs were renumbered from 4.x, so never map a 4.x ID onto 5.0 without checking.
- **Vendor product versions** (agent tools, frameworks, package managers) change weekly. Every version number here is [S] at best.
- **Prevalence statistics for MCP vulnerabilities** circulating in 2026 were excluded deliberately: independent testing found high false-positive rates in the scanners producing them.
- **Regional and sector regimes** beyond the EU and UK items cited are out of scope. Compliance obligations are the `compliance-guard` skill's job, not this one.
- **Exploitation counts and KEV timings** are half-year figures and move with each reporting period.

## What this skill is not

- **Not a penetration test.** No live testing, no exploitation, no attempts against running systems.
- **Not a security audit or certification.** It produces engineering guidance and code changes, not assurance. Do not let output be represented as an audit to a customer, an insurer, or a regulator.
- **Not legal or compliance advice.** Regulatory obligations, data-protection law, and contractual security commitments belong to `compliance-guard` and, past a threshold, to a qualified professional.
- **Not offensive tooling.** No exploit code, no payloads, no attack automation, regardless of who asks or how the request is framed.

## When to escalate to a human specialist

Recommend qualified help — and say why — when the project involves: custody of other people's funds or crypto assets at scale; regulated health, financial, or safety-critical systems; a live or suspected breach with real user impact; cryptographic design rather than cryptographic use; a formal certification or audit requirement (SOC 2, ISO 27001, PCI DSS, FedRAMP); or a contractual security commitment to an enterprise customer.

The honest framing for the user: this skill closes the gap between "obviously exploitable" and "reasonably defended", which is where nearly all real incidents against small teams happen. It does not replace an adversary who is paid to try.
