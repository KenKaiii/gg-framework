# Provenance and Volatility

## Snapshot

These references were compiled on **11 August 2026** and spot re-verified on **3 October 2026** (see *Re-verification log* below) from primary and first-tier sources: EUR-Lex and the Official Journal, EDPB, national data protection authorities, ICO, Ofcom, the European Commission, the FTC, CPPA, state legislature and AG sites, US federal court opinions, the Copyright Office, NIST, OWASP, PCI SSC, and platform developer documentation.

## Confidence markers

Every substantive claim in these files carries a marker. **Preserve them when you report to the user.**

- **[V] Verified** — checked against a primary or first-tier source at snapshot time. Still subject to change after that date.
- **[S] Snapshot** — accurate at snapshot time but date-, threshold-, or version-sensitive. Re-verify before stating it as current.
- **[U] Uncertain** — contested, in litigation, in legislative flux, or where sources conflicted. Present it to the user as uncertain, with both readings if they matter.

Laundering an `[S]` or `[U]` item into a confident assertion is the most damaging failure mode of this skill. A user who acts on a wrong effective date is worse off than a user who was told to check.

## What decays fastest

Re-verify these before relying on them, in rough order of volatility:

1. **US state AI laws** — effective dates have moved repeatedly, some are enjoined, some were repealed and replaced mid-cycle, and federal preemption efforts are active.
2. **State privacy law scope** — new states take effect on 1 January and 1 July cycles; thresholds and cure periods change.
3. **EU AI Act dates** — amended in July 2026; any guidance written before mid-2026 is unreliable on the high-risk timeline.
4. **EU data/ePrivacy reform** — the data-protection half of the Digital Omnibus is **not law**; at 3 Oct 2026 it was in first reading with no Council mandate. Do not build to proposed cookie or browser-signal provisions.
5. **EU–US transfer framework** — valid at snapshot, with an appeal pending.
6. **Wiretap/pixel litigation** — statutory reform and appellate decisions are actively reshaping which theories survive.
7. **Age-verification and minors' laws** — rapid state adoption plus constitutional litigation.
8. **Platform requirements** — Apple and Google change privacy and account requirements on their own schedule.
9. **Security standards and vendor terms** — OWASP versions, PCI requirements, and LLM vendor retention/training defaults all move.
10. **Penalty amounts** — many are inflation-adjusted annually.

## Known gaps at snapshot

- Jurisdictions outside the EU/UK/US are covered only where they surfaced incidentally (Australia, Canada, Brazil, India). **Do not extrapolate** — if the user targets another market, say the references do not cover it and research it before advising.
- Sector regimes are covered at gate-detection depth, not implementation depth. The purpose is to recognise the gate and route to counsel, not to compliance-engineer a regulated business.
- Fine tiers, transitional dates, and standard versions were flagged individually where they could not be re-verified.

## Using this with web access

When web access is available, verify in this order before making a claim the user will act on: (1) the effective date, (2) whether the law survived litigation, (3) the threshold and whether the user is over it, (4) the penalty and whether a private right of action exists. Prefer the statute, the regulator's own guidance, or the court's opinion over secondary commentary — law-firm blog posts were a recurring source of the errors corrected during this research, including at least one widely-repeated claim about an EU obligation that does not exist.

When web access is unavailable, say so, cite the snapshot date, and mark the affected findings as needing verification.

## Re-verification log — 3 October 2026

**Pass 1** (secondary sources): CA SB 690 signed 30 Sep 2026; Colorado SB 26-189; FCC TCPA revocation order reportedly adopted 30 Sep 2026; FTC negative-option ANPRM March 2026; Data Omnibus first-reading status; AI Omnibus dates; Texas SB 2420.

**Pass 2** (primary sources preferred):

| Item | Result | Source tier | File |
|---|---|---|---|
| UK DUAA commencement | Main provisions 5 Feb 2026 (SI 2026/82); s.164A complaints 19 Jun 2026 | **Primary**: legislation.gov.uk SI 2026/82, SI 2026/31 | `eu-uk.md` |
| CPPA ADMT / risk assessment / audits | Effective 1 Jan 2026; ADMT 1 Jan 2027; RA attestation 1 Apr 2028; audits 2028/29/30 by revenue | **Primary**: cppa.ca.gov rulemaking page + 23 Sep 2025 announcement | `us.md` |
| TAKE IT DOWN §3 | Enforced from 19 May 2026; 48h removal; FTC complaint portal | **Primary**: ftc.gov press releases (May 2026) | `us.md` |
| Colorado SB 26-189 | Repeal-and-reenact confirmed; 1 Jan 2027 date from secondary only → **[U]** | Primary (partial): leg.colorado.gov bill page | `us.md` |
| EU Data Act | Applies 12 Sep 2025; Art 3(1) design duty 12 Sep 2026 (Art 50) | Statute text via secondary mirror + law firms (EUR-Lex not fetched) | `eu-uk.md` |
| EAA transitional | 28 Jun 2030 cap for pre-2025 service contracts (Art 32); "2027 vs 2030" conflict resolved | Statute text quoted in secondary sources | `eu-uk.md` |
| COPPA | Effective 23 Jun 2025; compliance 22 Apr 2026 (90 FR 16918) | Secondary (consistent citations to FR) | `us.md` |
| ADA Title II | DOJ IFR 20 Apr 2026: 26 Apr 2027 / 26 Apr 2028 (FR Doc 2026-07663) | Secondary + SBA Office of Advocacy (federalregister.gov blocked the fetch) | `us.md` |
| ADA Title III trend | 3,117 federal web suits in 2025 (+27%) | Secondary (Seyfarth tracker) → [S] | `us.md`, `lawsuit-vectors.md` |
| GPC states / new laws | 12 GPC states unchanged; IN, KY, RI live 1 Jan 2026 without GPC duty | Secondary → GPC list kept [V] from August, 2027 laws [U] | `us.md` |
| UK OSA | Fines ongoing; categorised register July 2026 | Secondary (Ofcom roadmap page partly) → [S] | `eu-uk.md` |
| PCI DSS 4.0.1 | Future-dated reqs mandatory 31 Mar 2025; v4.0 retired 31 Dec 2024 | Secondary (pcisecuritystandards.org not fetched) → [S] | `security-baseline.md` |
| WA MHMDA + health-data laws | Damages: actual, treble to $25,000 (corrected from "$7,500/violation"); NY HIPA not law | Secondary → [S] | `us.md` |
| BIPA | SB 2979 per-person cap retroactive (7th Cir. *Clay v. Union Pacific*, 1 Apr 2026) | Secondary (multiple firms quoting opinion) | `us.md`, `lawsuit-vectors.md` |
| App-store laws | Utah → 6 May 2027 (HB 498), PRA 31 Dec 2026; Louisiana → 1 Jul 2027 (HB 977); CA AB 1043 1 Jan 2027 | Secondary → [S]; Alabama [U] | `us.md` |
| Reg (EU) 2026/1744 | Pass 3: OJ text opened (eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=OJ:L_202601744): OJ 24.7.2026, in force 3rd day; Art 5(1)(ba)/(bb) + Art 50(2) legacy 2 Dec 2026; Annex III 2 Dec 2027; Annex I 2 Aug 2028 → **[V]**. 2 Feb 2027 watermark date not found → [U] | Primary | `eu-uk.md`, `sector-gates.md` |
| Delete Act / DROP | Pass 3: 1 Aug 2026, 45-day cadence, DROP account duty → **[V]** (cppa.ca.gov/data_brokers/) | Primary | `us.md` |
| Texas TRAIGA HB 149 | Pass 3: signed 22 Jun 2025, effective 1 Jan 2026 → **[V]** (capitol.texas.gov History HB149, 89R) | Primary | `us.md` |
| CA SB 243 reporting | Pass 3: leginfo unreachable; 1 Jul 2027 reporting start from secondary → [S] | — | `us.md` |
| CA SB 690 | leginfo fetch failed → retroactivity detail **[U]** | — | `lawsuit-vectors.md` |
| FCC TCPA order | fcc.gov page not found; stays **[U]** | — | `us.md` |
| Texas SB 2420 | No court order opened → **[U]** | — | `us.md` |

Marker rule applied in pass 2: **[V]** only where a primary source was actually opened (legislation.gov.uk, cppa.ca.gov, ftc.gov, leg.colorado.gov); secondary-only facts are **[S]**; earlier-pass items without primary confirmation are **[U]**. Items whose [V] dates from the 11 Aug snapshot keep it.

**Pass 3 (3 Oct 2026) still unverified:** leginfo (SB 243/942/AB 853/AB 2013) timed out; nysenate.gov and legiscan 403; CRA (Reg 2024/2847) EUR-Lex and digital-strategy pages returned empty; DPF appeal (C-703/25 P) not fetched. Those claims keep their prior markers.

**Still unverified after pass 2:** primary text for Reg 2026/1744, SB 690, the FCC order, Colorado's effective date, the Title II IFR, COPPA FR text, PCI SSC documents, and Ofcom's register. Not re-checked at all: genetic-privacy state list, VPPA, NY SAFE for Kids, Delete Act/DROP, CA SB 942/AB 2013/SB 243, Texas TRAIGA, CRA, DSA, NIS2, DPF appeal, consent-or-pay, adult-content AV state count, everything in `sector-gates.md`, `artifacts.md`, `trigger-map.md`, `exposure-triage.md`.

Pass 1 sources: whitecase.com, acompli.ie, fenwick.com, procopio.com, seyfarth.com, troutmanprivacy.com, burr.com, commlawgroup.com, mslawgroup.com, kelleydrye.com, crowell.com, mofo.com, recordinglaw.com. Pass 2 adds: legislation.gov.uk/uksi/2026/82, cppa.ca.gov/regulations/ccpa_updates.html, cppa.ca.gov/announcements/2025/20250923.html, ftc.gov/news-events/news/press-releases/2026/05/ftc-begins-enforcing-take-it-down-act, leg.colorado.gov/bills/sb26-189, reedsmith.com (Title II IFR), advocacy.sba.gov, adatitleiii.com, wsgr.com (Data Act), lw.com and davispolk.com (COPPA), insideprivacy.com (BIPA), loeb.com and recordinglaw.com (Utah/Louisiana), enzuzo.com (MHMDA), 360advanced.com (PCI), reedsmith.com (OSA).
