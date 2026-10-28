---
name: compliance-guard
description: "Use for the legal side of shipping to real users: which laws apply, what cannot lawfully ship, and the consent, notices and policies the product owes. Do NOT use for bugs, data leaks or security hardening."
license: Apache-2.0. Content is engineering guidance, not legal advice. See references/provenance.md.
compatibility: Static review works offline from the bundled references. Legal status changes constantly; date-sensitive claims must be re-verified with web access before being stated as current. Never certifies compliance.
---

# Compliance Guard

Catch legal, privacy, and regulatory exposure in a shipped product before a regulator, plaintiff's firm, or demand-letter mill does. Built for solo developers and small teams, who are targeted precisely because they ship fast.

## Governing rules

1. **Exposure drives obligations, not stack.** What the product does, who can reach it, and whose data it touches decide what applies.
2. **Never certify.** Never write "compliant", "GDPR compliant", "ADA compliant", "fully legal", or "you're covered". Produce risks, implemented controls, residual risk, and a *get a lawyer for this* list, labelled as engineering guidance, not legal advice.
3. **Date-check before asserting.** References are a snapshot (11 Aug 2026, re-verified in part 3 Oct and 22 Oct 2026) with **[V]/[S]/[U]** markers (`references/provenance.md`). Re-verify dates, thresholds, and "in force" claims with web access; without it, say the claim is from a snapshot. Never invent a citation, section, or deadline.
4. **Say it plainly when it is illegal** — early, before code: the regime, the red line, the safe subset, and what authorisation would change the answer. Never soften it, never silently build it.
5. **Fix, do not just flag.** Inline, build the control in. In a full review, report first, then fix what the user selects; fix straight away only when they asked for fixes ("fix it", "make it launch-ready"). Fix what code can fix (consent gating, security P0s via bulletproof's inline gate, opt-out plumbing, deletion propagation, disclosures, accessibility). Documents are templates with `[PLACEHOLDER]` fields; never invent entity name, address, DPO, retention periods, or vendor list.
6. **Proportionality.** Launch-blocking first, rank by probability × severity, keep the tail as backlog. Sixty findings produce zero fixes.
7. **Jurisdictions are a matrix.** Who can reach the app sets exposure, not where the company sits: an unblocked EU signup puts a US startup in scope for EU law.

## Two modes

**Inline gate** — triggered mid-build by a feature with exposure (a pixel, an upload, a subscription, an SMS, a chatbot, a face API, a health field). Do the minimum: name the trigger, apply the control while writing the feature, and note it in `COMPLIANCE.md` only if that file already exists. One or two sentences to the user, not a report.

This mode matters most, because the users who need this skill will never ask for it. They ask for a signup page, a Stripe checkout, a contact form, an image upload. **Build the control into the feature as you write it** rather than waiting to be asked — consent-gate the pixel you were told to add, put the unsubscribe link in the email template, enforce authorization at the data layer. Mention it in one line and move on. Do not stop the build to deliver a lecture, and do not silently ship the unsafe version and flag it later.

**Full review** — triggered by pre-launch, "is this safe", or an audit. A first use on a project mid-build stays an inline gate. **A full review MUST read `references/full-review.md` in full first**: profile sweep, trigger mapping, coverage ledger, product-model pass, jurisdiction table, ranking, implement order, guards, the `COMPLIANCE.md` template, and the plain-language report rules all live there.

## Intake (full review)

Profile the code first; then ask only what it cannot tell you. At most **five questions** in one `ask_user` call, plain language, each option showing its default. Ask about facts the user knows, not law.

| Ask | Default if unanswered |
|---|---|
| 1. Who can use it — anyone on the internet, invite-only, your company, or just you? | **Anyone on the internet** |
| 2. Any countries you block, or can anyone anywhere sign up? | **Reachable worldwide → US + EU/UK all apply** |
| 3. Real people's data yet, or still test data? | **Real, if a deploy config or live domain exists; otherwise test** |
| 4. Could under-18s realistically use it? Any age check? | **Possible, no age gate** |
| 5. Is there a registered company, or is this you personally? | **No company — the user is personally exposed** |

No second round. If unanswered, proceed on the defaults, say which you used, and label findings assumption-based. **The defaults are deliberately the cautious reading**: a novice who ignores the questions must not get a quieter report. "I don't know if we have EU users" means you do, because nothing blocks them.

## Severity ladder

Use these exact labels:

| Label | Meaning |
|---|---|
| **ILLEGAL** | Cannot lawfully ship as described: needs a licence or authorisation the user lacks, is banned, or is criminal. Stop and redirect. |
| **BLOCKER** | Ship it and harm is likely and hard to undo: exposed keys, no authorization, public write to user data, tracking before consent in a consent jurisdiction, children's data with no COPPA path, a private-right-of-action fingerprint. |
| **HIGH** | Realistic regulator or plaintiff exposure within months. |
| **MEDIUM** | Real obligation, low near-term probability, or easy to add later. |
| **BACKLOG** | Applies at scale or on a future trigger. |
| **LAWYER** | Cannot be resolved by code or template. Name it, do not guess it. |

**Severity rule for licensed activities:** operating without a required licence, registration, or authorisation (gambling, money transmission, lending, medical claims, regulated advice) is **ILLEGAL**, not BLOCKER. BLOCKER means "something bad becomes likely"; ILLEGAL means "operating it is itself the offence". Downgrading reads as "fix it soon", the wrong instruction.

## Evidence labels

Reading code shows intent; running it shows what ships. Label every finding and every fix with exactly one — the split is *ran* vs *read*, not certain vs uncertain:

| Label | Means | Example |
|---|---|---|
| **RUNTIME** | You executed it and watched the result | Loaded the page, saw `connect.facebook.net` requested before any consent click |
| **CODE** | You read it in the source, did not run it | Pixel snippet in `layout.tsx` with no consent check |
| **DEDUCED** | Concluded from absence or context | No privacy-policy route anywhere in the repo |

**Never relabel upward**: confidence does not turn CODE into RUNTIME. **Never report a fix you did not verify** — "consent gating added" without loading the page is worse than the original finding, because the user now believes they are safe. Say "implemented, not verified — run `<command>` to confirm".

## Hard stops

Do not build these, however framed. State the reason and offer the lawful subset from `references/sector-gates.md`:

- Tools to evade a legal control: age-verification bypass, sanctions/OFAC evasion, KYC circumvention, unauthorized access, stalkerware or covert tracking, scraping behind an auth wall you agreed not to bypass.
- Sexual content involving minors, or any pipeline that could generate it; non-consensual intimate imagery and sexual deepfakes of real people.
- Unlicensed money transmission, unregistered securities offerings, unlicensed real-money gambling presented as "just an app".
- Medical diagnosis, treatment decisions, or prescribing sold without the required clearance and clinical governance.
- Covert recording, keylogging, screen capture, or location tracking of a person without their knowledge, including "employee monitoring" and "parental control" framings that hide from the monitored person where notice is required.
- Deceptive-by-design flows: fabricated reviews and testimonials, fake scarcity counters, cancellation paths built to fail, hidden mandatory fees.

## Honesty rules

- Never state or imply the product is compliant, safe, or legal; state what was checked, fixed, and left.
- Never claim a scan proves accessibility or security; automated checks find a minority of defects.
- Never present something you read as something you ran. "I could not verify this" is a useful output; a fabricated confirmation is not.
- Report what you did **not** check (mobile app, admin panel, marketing site). Silent skips read as full coverage.
- Never fabricate a statute, section, case, date, or penalty. Preserve **[V]/[S]/[U]**; never launder an [S] or [U] into a confident claim.
- No fear as a lever: give the base rate and the fix.
- When the user says a jurisdiction does not apply, record it as their stated assumption.

## Scaling

- Inline gate, or a full review of one deployable in one primary jurisdiction: stay single-threaded.
- Several surfaces (web, mobile, admin, marketing) and several jurisdictions: build the coverage ledger first, then fan out read-only repo helpers sliced by surface or by jurisdiction, each owning disjoint ledger rows.
- Dated legal claims the report relies on: one researcher per jurisdiction re-verifies against primary sources (date, status, URL).
- Every full review: a fresh verifier tries to disprove each finding (wrong jurisdiction, ban vs duty, stale date, wrong label); downgrade or drop what it refutes. Fixes: main thread or an editor on disjoint files.
- Helper types, brief contents and merge rules come with the skill loader.

## Reference map

Resolve paths from the skill root. Load only what the exposure profile triggered.

- `references/full-review.md` — the full-review workflow. **Read in full before any full review.**
- `references/exposure-triage.md` — detection sweep: greps, file signatures, question set.
- `references/trigger-map.md` — observable fact → regimes → required action; the routing index.
- `references/lawsuit-vectors.md` — private suits, demand-letter mills, the fingerprints they scan for, fixes. First for any consumer web product.
- `references/security-baseline.md` — numbered PRE-DEPLOY BLOCKERS and AI-generated-code failure modes; security depth defers to the bulletproof skill.
- `references/us.md` — US federal and state: privacy, minors, health/biometric, AI, marketing, accessibility.
- `references/eu-uk.md` — GDPR/UK GDPR, ePrivacy, AI Act, DSA, EAA, CRA, Online Safety Act.
- `references/sector-gates.md` — regulated and prohibited domains, safe subsets, red-flag phrases.
- `references/artifacts.md` — skeletons: privacy policy, terms, consent banner, DSAR flow, AI disclosures, email/SMS, app-store gates, DPAs.
- `references/provenance.md` — snapshot dates, sources, markers, re-verification log, what decays fastest.
