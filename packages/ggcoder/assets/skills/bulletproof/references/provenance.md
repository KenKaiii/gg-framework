# Provenance

**Snapshot date: 3 October 2026** (previous full snapshot 12 August 2026). Items re-verified on 3 Oct 2026 are listed below; anything else carries its marker from the earlier snapshot. Security facts decay faster than any other content in this repository — a version number, a CVE, a default, or an incident detail that was accurate at snapshot time may be wrong by the time you read it.

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
| MCP 2025-11-25: CIMD preferred, DCR optional, RFC 9728 discovery fallback, 403 on bad Origin | modelcontextprotocol.io changelog |
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

## Source classes

- **Standards and frameworks**: OWASP (Top 10:2025, ASVS 5.0.0, API Security Top 10 2023, MASVS 2.1.0 / MASTG 2.0.0, LLM Top 10 2025, Agentic Top 10 2026), MITRE (CWE Top 25 2025 edition, ATT&CK), NIST (SP 800-63B-4, SP 800-218 / 218A, SP 800-53 Rev 5, FIPS 203/204/205), SLSA, OpenSSF.
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
