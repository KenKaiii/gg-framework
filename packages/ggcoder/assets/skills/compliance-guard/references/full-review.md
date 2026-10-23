# Full Review Workflow

Read this file in full before starting a full review. The inline gate does not need it.

## Contents
- 1. Profile the exposure from the code
- 2. Map triggers to obligations
- 3. Coverage ledger
- 4. Second pass on the product model
- 5. One duty, every jurisdiction
- 6. Rank
- 7. Implement
- 8. Prove it, then leave the check behind
- 9. COMPLIANCE.md
- 10. Write it for someone who has never read a statute

## 1. Profile the exposure from the code

Do this before the intake questions. `exposure-triage.md` has the full sweep; the fast version:

- **Reach**: deploy config (`vercel.json`, `netlify.toml`, `fly.toml`, Dockerfile + ingress, `wrangler.toml`), a domain, a marketing page, app-store metadata, an auth flow.
- **Personal data**: schemas, migrations, form fields, session tables — email, name, phone, address, IP, device ID, location, DOB, photo, voice, health, payment, government ID.
- **Third parties**: every `<script src>`, tag manager, analytics, ad pixel, session replay, chat widget, error tracker, CDN font, LLM API, email/SMS and payment provider.
- **Money**: payment SDK, plan tables, trials, refunds, payouts, wallets, balances.
- **Decisions about people**: code that scores, ranks, screens, approves, or rejects a human.
- **UGC**: uploads, comments, profiles, messaging, sharing, public feeds.
- **Domain signals**: `patients`, `diagnos*`, `prescription`, `loan`, `kyc`, `wallet`, `bet`, `wager`, `prize`, `minor`, `age`, `student`, `applicant`, `background_check`, `face_embedding`, `voiceprint`.
- **Messaging**: transactional vs marketing email, SMS, push.
- **AI**: model calls, agents with tools, personas, generated media, training on user data.

**Read the prose, not only the code.** README files, landing copy, pricing pages and app-store text state the audience and claims the schema never shows — "kids can make profiles too", "tells you what medication to give", "we import listings from X", "HIPAA-ready", "bank-level security". A sentence about who uses the product or what it does for them is a trigger like a column name, and is often the only place a minors audience, a health claim, or a data-sourcing practice is admitted.

## 2. Map triggers to obligations

`trigger-map.md` is the spine: observable fact → regimes → required change. Then load only what fired:

- `lawsuit-vectors.md` **first** for any consumer-facing web product (highest hit rate).
- `us.md`, `eu-uk.md` for thresholds and dates.
- `sector-gates.md` whenever a domain signal fires.
- `security-baseline.md` for the pre-deploy blockers.
- `artifacts.md` for what each document or flow must contain.

## 3. Coverage ledger

Narrative review finds what stands out and drops the boring items; an item never written down was never checked. For any deployed product, emit this coverage ledger **before** any findings:

```
| # | Checklist item | fail / pass / n-a | Evidence |
```

Mandatory rows — you may not shorten the list, merge rows, or drop an item because something more dramatic was found:

- **Every numbered item** of PRE-DEPLOY BLOCKERS in `security-baseline.md`: one row per numbered item, in order, including sub-numbers such as 4a, 4b, 14b.
- **Every universal row** of `trigger-map.md` section A.
- **Accessibility**, on any public UI — one row each: image alternatives, form labels, keyboard operability of every clickable element, colour contrast computed from the literal values in the source, focus visibility, media controls and captions on any audio/video, page language. These are the most frequent real-world claim and the most often dropped under output pressure; emit them even when the report is long and the drama is elsewhere.
- **Consumer contract duties** wherever consumers pay, and **platform duties** wherever users publish or upload — one row **per applicable jurisdiction**, not one total.
- **Minors**, on any consumer-facing product: `fail` unless the code shows an actual age gate ("the terms say 18+" is not one). `n-a` needs a reason.

Most often missed: blocker 1 (**committed secrets and `.gitignore` gaps** — compare the actual `.gitignore` to the files present) and blocker 2 (**row-level security left at the framework default** — check a policy exists on every client-reachable table). Other habitual casualties: webhook signature verification, rate limits on expensive endpoints, bucket permissions and client-supplied filenames, precise geolocation as its own sensitive class, fabricated or placeholder testimonials.

**Every `fail` row becomes its own finding, and coverage survives the output format.** The ledger is a working artifact. If the requested format has no ledger, or asks for findings only, still run the sweep and report each failing item as a separate numbered finding. Never merge into one "accessibility issues" or "platform duties" finding, and never describe a defect you did not see in the source — report the elements actually present, not the examples listed here.

## 4. Second pass on the product model

The code sweep finds defects that live in a line; it misses obligations from **what the product is** or from two facts combined. So always do a second pass on the product model, asking:

1. **Does value move?** Balances, credits, in-app currency, tips, wallets, payouts. Currency in + cash out = money transmission, a **licensing gate**, not a to-do.
2. **Is it a platform?** Users publish, upload, or message each other → notice-and-action, contact point, moderation terms, DMCA agent, illegal-content and child-safety processes. These show up as *absence*, never as a code defect.
3. **Does it generate or manipulate media?** Synthetic audio, video, images, or a persona need provenance marking and labelling — a **separate finding** from whether generating it was permitted. Consent to generate and disclosure of what was generated are different duties to different people; emit both.
3b. **Where do credentials and financial identifiers live?** IBANs, bank accounts, tax IDs, government IDs, payout details are often stored with no access control, encryption, or retention rule. Check them whenever a schema has payout, KYC, or identity fields.
4. **Are people tracked across contexts?** Opt-out signals must be honoured server-side and the opt-out must sever the recipient. Nothing looks broken; the handler simply does not exist.
5. **Which pairs make a third regime?** Video + ad pixel = video-privacy claim. Currency + withdrawal = money movement. Biometrics + minor = a different statute. Uploads + adult content = age assurance.

## 5. One duty, every jurisdiction

**Name every jurisdiction's version of the same duty.** A review names the first instantiation it thinks of and stops. Once a duty fires, ask what the other regime calls it and emit a row for each:

| Duty | US | EU/UK |
|---|---|---|
| Hosting user content | DMCA agent + repeat-infringer policy, CSAM reporting, NCII takedown | **DSA** notice-and-action, contact point, moderation terms, minors' protection; UK Online Safety duties |
| Selling to consumers | ROSCA and state auto-renewal, junk-fee rules | **Pre-contract information, 14-day withdrawal and the digital-content waiver**, unfair terms, VAT/OSS |
| Tracking | CIPA, state opt-out, GPC | ePrivacy prior consent, GDPR lawful basis |
| Biometrics | BIPA written release + retention schedule | GDPR Art 9 basis, AI Act biometric duties |
| Automated decisions | ADMT notice and opt-out, FCRA, ECOA | AI Act risk tier, GDPR Art 22 |
| Accessibility | ADA Title III, WCAG in practice | EAA and EN 301 549 |
| Synthetic media | State provenance and disclosure laws | AI Act Art 50 marking and labelling |

An EU-established company gets the EU column as the headline: it is what its own regulator opens with, and what a US-shaped review omits.

## 6. Rank

Rank by the probability the fingerprint is **detected in the wild**, not by statutory maximum. A missing form label produces more real letters than an exotic treaty issue.

**Lead with the jurisdiction the product actually operates in.** Worldwide reach makes other regimes apply, not equally likely. An EU company selling to EU customers gets the EU regime as the headline and US exposure as a secondary section, and the reverse for a US product. Framing an EU-only product's central finding under a US statute buries the rule that will be enforced and sends the user to the wrong kind of lawyer. State the primary regime, then "also applies if you have users in X".

**Check for an outright ban before writing up an obligation.** Some regimes prohibit rather than condition — the EU AI Act Art 5 list is the one small builders hit by accident. A banned feature is **ILLEGAL** and the fix is deletion. Never report it as a disclosure or consent duty: a transparency rule next to a prohibition reads as the applicable one and quietly authorises the forbidden thing.

Apply the severity rule for licensed activities from SKILL.md: missing licence = ILLEGAL, never BLOCKER.

## 7. Implement

Report first and fix what the user selects, unless they already asked for fixes (SKILL.md rule 5). Order: BLOCKER security → tracking/consent gating → required disclosures and flows → documents → backlog. Smallest change that holds; one enforced chokepoint over scattered checks (one `canSend()`, one `displayPrice()`, one consent state, one server-side authorization helper). Documents are templates with `[PLACEHOLDER]` fields, marked as needing review.

## 8. Prove it, then leave the check behind

Static detection misses what matters most: tags injected by a tag manager, scripts added in a hosting dashboard, a framework script component whose loading strategy decides consent, a vendor SDK phoning home from a dependency. Where the app runs, observe: load a page and record third-party origins contacted before any consent click; sign in as one user and request another's object by id; submit the form and read what reaches the network. Label each finding RUNTIME / CODE / DEDUCED (SKILL.md). If the app could not run at all, say so once at the top, noting the review cannot see runtime-injected tags, dashboard scripts, or anything outside the repo.

A register rots; a failing test does not. For every BLOCKER and HIGH fixed, leave a check wired into the project's existing test or CI setup, using tools already installed. A check that needs a new package or workflow (`axe-core`, a secret scanner, a licence scanner) is a recommendation unless the user agrees:

| Fix | Guard |
|---|---|
| Consent gating | Test asserting **zero third-party requests before consent** on first paint — the highest-value check here |
| Accessibility | `axe-core` over top routes, failing on `serious` and `critical` |
| Secrets | Secret scanner on commits + test that the client bundle has no key pattern |
| Authorization | Test that user A cannot read or write user B's object by id |
| Marketing email | Test that every send path goes through the one gate and carries an unsubscribe header |
| Licence contamination | Licence scan that **fails**, not warns, on copyleft and unknown |

No test runner at all: say so, and recommend the one check with the best protection-to-setup ratio.

## 9. COMPLIANCE.md

Write or extend the register at the repo root:

```markdown
# Compliance Register
Snapshot: <date> · Commit: <sha> · Reviewed by: GG Coder compliance-guard · NOT LEGAL ADVICE

## Assumed exposure profile
<reach, jurisdictions, data classes, minors, money, domain, third parties — each Confirmed or Assumed>

## Findings
| ID | Severity | Trigger | Evidence (RUNTIME / CODE / DEDUCED) | Obligation | Status | Guard |

## Implemented in this pass
## Open — needs a decision from you
## Needs a lawyer
## Not checked
## Re-verify before relying (date-sensitive)
```

Keep IDs stable across runs; update statuses rather than rewriting history. On a later run, re-check existing findings first and mark anything not re-confirmed as stale — never carry it forward as still true.

## 10. Write it for someone who has never read a statute

Each surfaced finding answers, in plain words:

1. **What in your app causes this** — file, line, or feature.
2. **What could actually happen** — the real consequence and base rate, not the statute.
3. **What it takes to fix** — "already fixed" / "20 minutes" / "a lawyer, a few hundred dollars".
4. **What happens if you ignore it** — honestly, including "probably nothing for a while".

Plain-English name first, statute in parentheses only if it helps a search — "tracking people before they agree (CIPA)". No unexplained acronyms; translate legal terms on first use (a *processor* handles your users' data for you; a *lawful basis* is your reason for being allowed to hold it). Say "do this before launch", not "you may wish to consider".

End with at most three next actions, smallest first. Separate *fixed while I was here* / *you decide* / *needs a lawyer*. State base rates; never moralise or catastrophise ("you could be fined €20 million" ends the reading).
