---
name: compliance-guard
description: "Use for the legal side of shipping to real users: which laws apply, what cannot lawfully ship, and the consent, notices and policies the product owes. Do NOT use for bugs, data leaks or security hardening."
license: Apache-2.0. Content is engineering guidance, not legal advice. See references/provenance.md.
compatibility: Static review works offline from the bundled references. Legal status changes constantly; date-sensitive claims must be re-verified with web access before being stated as current. Never certifies compliance.
---

# Compliance Guard

Catch the legal, privacy, and regulatory exposure in a shipped product before a regulator, a plaintiff's firm, or a demand-letter mill does. Built for solo developers and small teams shipping fast — the population that is now actively targeted precisely because it ships fast.

## Governing rules

1. **Exposure drives obligations, not stack.** What the product *does*, *who can reach it*, and *whose data it touches* decide what applies. A CLI that never leaves the laptop owes almost nothing. A one-page site with a contact form and an ad pixel owes a surprising amount.
2. **Never certify.** Do not write or say "compliant", "GDPR compliant", "ADA compliant", "fully legal", or "you're covered". Produce a risk register, implemented controls, residual risk, and an explicit *get a lawyer for this* list. This is engineering guidance, not legal advice, and must be labelled as such in every report.
3. **Date-check before asserting.** The references are a snapshot dated **11 August 2026**, spot re-verified **3 October 2026** (`references/provenance.md` lists what was and was not re-checked). Effective dates, thresholds, injunctions, and penalty amounts move. Before stating a date, a threshold, or "this is in force", re-verify with web access if available; if unavailable, say the claim is from a dated snapshot and needs confirmation. Never invent a citation, statute section, or deadline.
4. **Say it plainly when it is illegal.** If the requested build is unlawful, licensed, or criminal as described, state that clearly and early — before writing code, not after. Name the specific regime, the concrete red line, the safe subset that *can* be built, and what authorization would change the answer. Do not soften it into a vague caution, and do not silently build it.
5. **Fix, do not just flag.** Anything code can fix, fix: consent gating, security P0s (via bulletproof's inline gate), opt-out plumbing, deletion propagation, disclosure strings, accessibility defects. Draft documents as clearly-marked templates with `[PLACEHOLDER]` fields. Never invent the user's legal facts — entity name, registered address, DPO, retention periods, or vendor list must come from the user or the repo.
6. **Proportionality.** A weekend prototype with no users does not need 60 findings. Gate on *launch-blocking* first, rank by probability × severity, and keep the tail as a backlog. Overwhelming a solo dev produces zero fixes.
7. **Jurisdictions are a matrix, not a country.** "Where the company is" rarely limits exposure; "who can reach the app" usually sets it. A US-only startup with EU visitors and an unblocked signup form is in scope for EU law.

## Two modes

**Inline gate** — triggered mid-build by a feature that carries exposure (adding a pixel, an upload, a subscription, an SMS, a chatbot, a face API, a health field). Do the minimum: name the trigger, apply the control while writing the feature, note it in the register. One or two sentences to the user, not a report.

This mode matters most, because the users who need this skill will never ask for it. They ask for a signup page, a Stripe checkout, a contact form, an image upload. **Build the control into the feature as you write it** rather than waiting to be asked — consent-gate the pixel you were told to add, put the unsubscribe link in the email template, enforce authorization at the data layer. Mention it in one line and move on. Do not stop the build to deliver a lecture, and do not silently ship the unsafe version and flag it later.

**Full review** — triggered by pre-launch, "is this safe", or an audit. A first use on a project mid-build stays an inline gate. Run the whole workflow below and write the register.

## Workflow

### 1. Profile the exposure from the code

Do this before asking the user anything. `references/exposure-triage.md` has the full detection sweep; the fast version:

- **Reach**: is there a deployed public surface? Look for hosting/deploy config (`vercel.json`, `netlify.toml`, `fly.toml`, Dockerfile + ingress, `wrangler.toml`), a domain, a marketing page, app-store metadata, an auth flow.
- **Personal data**: schema/model files, migrations, form fields, session tables — email, name, phone, address, IP, device ID, location, DOB, photo, voice, health, payment, government ID.
- **Third parties**: every `<script src>`, tag manager, analytics, ad pixel, session replay, chat widget, error tracker, CDN font, LLM API, email/SMS provider, payment provider.
- **Money**: payment SDK, subscription/plan tables, trial logic, refund logic, payouts to users, wallets, balances.
- **People-facing decisions**: any code that scores, ranks, screens, approves, or rejects a human.
- **UGC**: uploads, comments, profiles, messaging, sharing, public feeds.
- **Domain signals**: table and route names carry the truth — `patients`, `diagnos*`, `prescription`, `loan`, `kyc`, `wallet`, `bet`, `wager`, `prize`, `minor`, `age`, `student`, `applicant`, `background_check`, `face_embedding`, `voiceprint`.
- **Messaging**: transactional vs marketing email, SMS, push.
- **AI**: model calls, agents with tools, chat personas, generated images/audio/video, training on user data.

### 2. Ask only what the code cannot tell you

Cap at **five questions**, batched in one message, in plain language, each stating the default you will assume if unanswered. Assume the user does not know what GDPR, CCPA, or an "entity" is — ask about facts they know, not about law.

| Ask | Default if unanswered |
|---|---|
| 1. Who can use it — anyone on the internet, invite-only, your company, or just you? | **Anyone on the internet** |
| 2. Any countries you block, or can anyone anywhere sign up? | **Reachable worldwide → US + EU/UK all apply** |
| 3. Real people's data yet, or still test data? | **Real, if a deploy config or live domain exists; otherwise test** |
| 4. Could under-18s realistically use it? Any age check? | **Possible, no age gate** |
| 5. Is there a registered company, or is this you personally? | **No company — the user is personally exposed** |

Never interrogate, never send a second round. If the user does not answer, proceed on these defaults, say which ones you used, and label the findings as assumption-based. **The defaults are deliberately the cautious reading** — a novice who ignores the questions must not get a quieter report than one who answers.

A non-answer is itself information. "I don't know if we have EU users" means you do, because nothing is blocking them.

### 3. Map triggers to obligations

Use `references/trigger-map.md` as the spine: each observable product fact maps to the regimes it triggers and the concrete artifact or code change required. Then pull the depth you need:

- `references/lawsuit-vectors.md` for what actually produces demand letters and class actions — read this **first** for any consumer-facing web product, it has the highest hit rate.
- `references/us.md` and `references/eu-uk.md` for jurisdiction detail, thresholds, and dates.
- `references/sector-gates.md` whenever a domain signal fires — this is where "you cannot ship this" lives.
- `references/security-baseline.md` for the pre-deploy technical blockers.
- `references/artifacts.md` for what each required document or flow must actually contain.

Do not read every reference by default. Load the ones the profile triggered.

**Then sweep the fixed checklists and emit a coverage ledger.** Narrative review finds what stands out and silently drops the rest — the boring items go missing precisely because they are boring, and an item you never wrote down is an item you never checked. So for any deployed product, produce this table **in the output**, one row per item, before writing any findings:

```
| # | Checklist item | fail / pass / n-a | Evidence |
```

Walk **every numbered item** of the PRE-DEPLOY BLOCKERS list in `security-baseline.md` (one row per numbered item, in order, including sub-numbered ones such as 4b) and **every universal row** of `trigger-map.md` section A. Add mandatory rows for **accessibility** on any product with a public UI — one row each for image alternatives, form labels, keyboard operability of every clickable element, colour contrast computed from the literal values in the source, focus visibility, media controls and captions on any audio or video element, and page language. These are the first thing scanned in the wild and the first thing dropped from a review, because they are never the most interesting finding on the page. **Emit these rows even when the report is long and the dramatic findings are elsewhere** — they are the highest-frequency real-world claim in this entire file, and dropping them under output pressure is the single most repeated failure in evaluation.

Add a mandatory row for **consumer contract duties** wherever money is taken from consumers, and for **platform duties** wherever users publish or upload — one row per applicable jurisdiction, not one row total. Add one mandatory row for **minors** on any consumer-facing product: the intake default is that under-18s are possible and there is no age gate, so this row is `fail` unless the code shows an actual age gate — "the terms say 18+" is not one. `n-a` requires a reason. This is mechanical, not a judgement call: you may not shorten the list, merge rows, or drop an item because something more dramatic was already found. An unverified payment webhook and an unmetered LLM endpoint are not less real than a headline issue, only less interesting.

**Every `fail` row becomes its own finding — and coverage survives the output format.** The ledger is a working artifact, not the deliverable. If the report format has no ledger, or you were asked for findings only, the sweep still runs and each failing item still appears as a separate numbered finding. Coverage is a property of the findings, never of an optional table: an obligation that exists only inside a ledger you were not asked to print has not been reported at all.

So regardless of format, a deployed product with a public UI always yields **separate** findings for each failing accessibility defect class, and a product taking consumer money or hosting user content always yields the consumer-contract and platform-duty findings for **each** applicable jurisdiction. Never merge these into one "accessibility issues" or "platform duties" row, and never describe a defect you did not see in the source — report the elements that are actually present, not the ones this file lists as examples.

Items 1 and 2 of that list — **committed secrets and `.gitignore` gaps**, and **database row-level security left at the framework default** — are the two most frequently missed in evaluation, precisely because reviewers jump to the exciting findings. Check the actual `.gitignore` contents against the actual files present, and check the schema for a policy on every table a client SDK can reach.

Other habitual casualties: webhook signature verification, rate limits on expensive or abusable endpoints, storage bucket permissions and client-supplied filenames, precise geolocation as a sensitive class in its own right, and fabricated or placeholder testimonials left in the landing page.

**Then do a second pass on the product model, not the files.** The code sweep finds defects that live in a line. It reliably misses obligations that arise from **what the product is**, or from *two facts combined*, because neither fact looks wrong on its own. Ask these five explicitly, every time:

1. **Does value move?** Balances, credits, in-app currency, tips, wallets, payouts, cash-out to a bank. Currency in + cash out = a money-transmission question no matter how small, and it is a **licensing gate**, not a to-do.
2. **Is it a platform?** If users publish, upload, or message each other, intermediary duties attach as a matter of status: notice-and-action, a contact point, moderation terms, a DMCA agent, illegal-content and child-safety processes. These never appear as a code defect — they appear as *absence*.
3. **Does it generate or manipulate media?** Synthetic audio, video, images, or a persona needs provenance marking and user-facing labelling — and this is **a second, separate finding from whether generating it was permitted at all**. Both runs of an evaluation caught unconsented voice cloning as illegal and then omitted the labelling duty entirely, because the dramatic finding felt like it had covered the topic. Consent to generate and disclosure of what was generated are different obligations owed to different people; emit both.

3b. **Where do credentials and financial identifiers live?** Bank account numbers, IBANs, tax identifiers, government IDs and payout details are high-value data whose storage is routinely written without any access control, encryption, or retention rule because they read as ordinary columns. Check them explicitly whenever a schema contains a payout, KYC, or identity field.
4. **Do people get tracked across contexts?** Then opt-out preference signals must be honoured server-side and the opt-out must actually sever the recipient. Nothing in the code will look broken; the handler simply will not exist.
5. **What two features combine into a third regime?** Video content **plus** an ad pixel is a distinct video-privacy claim, not just a tracking issue. In-app currency **plus** withdrawal is money movement. Biometrics **plus** a minor is a different statute. User uploads **plus** adult content is age assurance. Look for pairs, not just items.

**Name every jurisdiction's version of the same duty.** Most obligations exist in both regimes under different names, and a review reliably names the first one it thinks of and stops — so the EU version goes missing from US-shaped reasoning and vice versa. Once a duty fires, ask "what is this called in the other regime, and does it add anything?" and emit a row for each:

| Duty | US instantiation | EU/UK instantiation |
|---|---|---|
| Hosting user content | DMCA agent + repeat-infringer policy, CSAM reporting, NCII takedown | **DSA** notice-and-action, contact point, moderation terms, minors' protection; UK Online Safety duties |
| Selling to consumers | ROSCA and state auto-renewal, junk-fee rules | **Pre-contract information, 14-day withdrawal right and the digital-content waiver**, unfair-terms limits, VAT/OSS |
| Tracking | CIPA and state opt-out, GPC | ePrivacy prior consent, GDPR lawful basis |
| Biometrics | BIPA written release + retention schedule | GDPR Art 9 basis, AI Act biometric-categorisation duties |
| Automated decisions | ADMT notice and opt-out, FCRA, ECOA | AI Act risk tier, GDPR Art 22 |
| Accessibility | ADA Title III, WCAG in practice | EAA and EN 301 549 |
| Synthetic media | State provenance and disclosure laws | AI Act Art 50 marking and labelling |

An EU-established company gets the EU column as the headline. That is the row a regulator in its own country will open with, and the one a US-shaped review is most likely to omit entirely.

**Severity rule for licensed activities.** If an activity requires a licence, registration, or authorisation the user does not have — gambling, money transmission, lending, medical claims, regulated advice — that is **ILLEGAL**, not BLOCKER. BLOCKER means "ship this and something bad becomes likely"; ILLEGAL means "operating this without authorisation is itself the offence". Downgrading the second to the first reads as "fix it soon" and is the wrong instruction.

**Read the prose, not only the code.** README files, landing-page copy, pricing pages and app-store descriptions state the audience and the claims that the schema never reveals — "kids can make profiles too", "tells you what medication to give", "we import listings from X", "HIPAA-ready", "bank-level security". A sentence in a README is as much a trigger as a column name, and is frequently the only place a minors audience, a health claim, or a data-sourcing practice is admitted. Any statement about who uses the product or what it does for them must be run through the trigger map like a code signal.

### 4. Rank by realistic exposure

Severity ladder — use these exact labels in the report:

| Label | Meaning |
|---|---|
| **ILLEGAL** | Cannot lawfully ship as described. Requires a licence, an authorization the user does not have, or is criminal. Stop and redirect. |
| **BLOCKER** | Ship this and harm is likely and hard to undo: exposed keys, no authorization checks, public write access to user data, no consent before tracking in a consent jurisdiction, children's data with no COPPA path, a private-right-of-action fingerprint sitting in the code. |
| **HIGH** | Realistic regulator or plaintiff exposure within months. Fix before or immediately after launch. |
| **MEDIUM** | Real obligation, low near-term probability, or straightforward to add later. |
| **BACKLOG** | Applies at scale or on a future trigger (enterprise sales, EU expansion, headcount, revenue thresholds). |
| **LAWYER** | Cannot be resolved by code or template. Name it, do not guess it. |

Rank the top items by *probability the fingerprint is actually detected in the wild*, not by statutory maximum. A missing form label produces more real letters than an exotic treaty issue.

**Lead with the jurisdiction the product actually operates in.** Worldwide reachability means other regimes apply, but it does not make them equally likely. For an EU company selling to EU customers, the EU regime is the headline and US exposure is a secondary section — and the reverse for a US product. Framing an EU-only product's central finding under a US statute is a real error: it buries the rule that will actually be enforced and sends the user to the wrong kind of lawyer. State the primary regime, then list the others as "also applies if you have users in X".

**Check for an outright ban before writing up an obligation.** Some regimes prohibit a practice rather than conditioning it — the EU AI Act's Art 5 list is the one small builders hit by accident. If a feature is banned, it is **ILLEGAL** and the fix is deletion; do not report it as a disclosure or consent obligation, because a transparency rule sitting next to a prohibition will read as the applicable one and quietly authorise the thing that is forbidden.

### 5. Implement

Fix in this order: BLOCKER security → tracking/consent gating → required disclosures and flows → documents → backlog. For each fix, make the smallest change that actually holds, and prefer a single enforced chokepoint over scattered checks (one `canSend()` gate, one `displayPrice()`, one consent state, one server-side authorization helper).

For documents, generate templates with placeholders, mark them clearly as templates needing review, and never fill in facts you were not given.

### 6. Prove it, then leave the check behind

This is what separates a real review from a plausible-sounding one. **Reading code tells you what someone intended; running it tells you what ships.**

**Observe before asserting.** Static detection has false negatives that matter more than its false positives: tags injected at runtime by a tag manager, scripts added through a hosting dashboard and absent from the repo entirely, a framework's script component whose loading strategy decides whether consent is respected, a vendor SDK that phones home from inside a dependency. Grepping for `fbq(` finds none of those. Where the app can be run, verify the behaviour directly — load a page and record which third-party origins are contacted before any consent interaction, sign in as one user and request another user's object by id, submit the form and read what actually reaches the network. Label every finding with exactly one of three states — the distinction is between *running* and *reading*, not between certain and uncertain:

| Label | Means | Example |
|---|---|---|
| **RUNTIME** | You executed it and watched the result | Loaded the page, saw `connect.facebook.net` requested before any consent click |
| **CODE** | You read it in the source; you did not run it | The pixel snippet is in `layout.tsx` with no consent check around it |
| **DEDUCED** | You concluded it from absence or from context | No privacy policy route exists anywhere in the repo |

Never relabel upward. A `CODE` finding does not become `RUNTIME` because you are confident. Where you could not run the app at all, say so once at the top of the report rather than repeating it per finding — and note that the review therefore cannot see runtime-injected tags, dashboard-added scripts, or anything outside the repo.

**Then make the fix self-enforcing.** A register is a snapshot that starts rotting the moment someone adds a feature; a failing test is not. For every BLOCKER and HIGH you fix, leave a check that fails if it regresses, and wire it into the project's existing test or CI setup rather than inventing a parallel one:

| Fix | Guard that keeps it fixed |
|---|---|
| Consent gating | Test asserting **zero third-party network requests before consent** on first paint. The single highest-value check in this file. |
| Accessibility | `axe-core` run over the top routes, failing on `serious` and `critical` |
| Secrets | Secret scanner on commits, plus a test that the client bundle contains no key pattern |
| Authorization | A test that user A cannot read or write user B's object by id |
| Marketing email | A test that every send path goes through the one gate and includes an unsubscribe header |
| Licence contamination | Dependency licence scan that **fails**, not warns, on copyleft and unknown |

If the project has no test runner at all, say so plainly and add the one check with the highest ratio of protection to setup cost rather than building a test harness they did not ask for.

**Never report a fix you did not verify.** "Consent gating added" without loading the page is exactly the false assurance this skill exists to prevent — it is worse than the original finding, because the user now believes they are safe. If you could not run it, say "implemented, not verified — run `<command>` to confirm".

### 7. Report and persist

Write or update **`COMPLIANCE.md`** at the repo root (or extend an existing register if one exists). Structure:

```markdown
# Compliance Register
Snapshot: <date> · Reviewed by: GG Coder compliance-guard · NOT LEGAL ADVICE

## Assumed exposure profile
<reach, jurisdictions, data classes, minors, money, domain, third parties — mark each Confirmed or Assumed>

## Findings
| ID | Severity | Trigger | Evidence (RUNTIME / CODE / DEDUCED) | Obligation | Status | Guard |

## Implemented in this pass
## Open — needs a decision from you
## Needs a lawyer
## Re-verify before relying (date-sensitive)
```

Keep IDs stable across runs so the register is diffable. Re-running the skill updates statuses rather than rewriting history.

**The register must age honestly.** Record the commit it was written against. On any later run, re-check the existing findings before adding new ones, and mark anything you could not re-confirm as stale rather than silently carrying it forward as still-true. A register that claims a clean bill of health for code that has moved on is a liability, not an asset.

### 8. Write it for someone who has never read a statute

The register is the artifact; the message to the user is what actually gets acted on. Most users of this skill cannot tell a real risk from a theoretical one and will either panic or ignore everything. Neither produces a fix.

**Every finding you surface must answer four things in plain words:**

1. **What in your app causes this** — name the file, line, or feature. "The Meta pixel in `app/layout.tsx` loads before anyone agrees to it."
2. **What could actually happen** — the real-world consequence, not the statute. "This is the single most common thing US law firms send demand letters about. Damages are claimed per visitor."
3. **What it takes to fix** — who does it and roughly how long. "I already fixed it" / "20 minutes of your time" / "a lawyer, a few hundred dollars".
4. **What happens if you ignore it** — honestly, including "probably nothing for a while" where that is true.

**Language rules.** Lead with the plain-English name, and put the statute in parentheses only if it helps them search — "tracking people before they agree to it (CIPA)", not "CIPA §631 exposure". Never use an unexplained acronym. Never say "you may wish to consider" when you mean "do this before launch". Translate every legal term the first time you use it: a *processor* is a company that handles your users' data for you; a *lawful basis* is your reason for being allowed to hold the data at all.

**Give them a ranked, finite next action.** End with at most three things to do next, in order, with the first one being the smallest. A user who reads "you have 47 issues" fixes zero. A user who reads "do this one thing today, these two this week" fixes three.

**Say what is already done.** Separate *"I fixed these while I was in here"* from *"you have to decide these"* from *"this one needs a real lawyer"*. Confusing the three is what makes people give up.

**Do not moralise and do not catastrophise.** State the base rate. "Small apps get sued over this regularly" and "this almost never gets enforced against someone your size, but it is cheap to fix" are both useful; "you could be fined €20 million" is not, because they will stop reading.

## Scaling: one agent or several

| Situation | Do |
|---|---|
| Inline gate, small edit, single feature | Main thread only. Never spawn for an inline gate. |
| Full review, one deployable, one primary jurisdiction, every ledger row readable by you | Stay single-threaded. |
| Several deployables/surfaces (web + mobile + admin + marketing site) **and** several jurisdictions or data flows | Build the coverage ledger first (rows = ledger items × surfaces × jurisdictions), then fan out. |

Fan-out rules:
- One `spawn_agent` call, ≤ 6 read-only children, each owning a disjoint slice — **by product surface** (paths) or **by jurisdiction** (US / EU / UK). Brief each with: absolute skill root, the exact reference files to read, its paths, the ledger rows it owns, the RUNTIME/CODE/DEDUCED labels, `[V]/[S]/[U]` markers, and the output schema (finding, file:line, label, severity, fix, plus explicit `checked` and `not checked` lists). Children never see this conversation.
- Dated legal claims the report will rely on → one `researcher` child per jurisdiction to re-verify against primary sources (statute site, official journal, regulator, court), returning date, status, and URL.
- **Merge:** a child that fails, times out, or omits a row → that row is `not checked`, never clean. Re-open each reported file:line yourself before reporting it.
- **Independent verification, always, for a full review:** a fresh-context child gets the draft findings and tries to disprove each one (wrong jurisdiction, ban vs duty, stale date, wrong label). Downgrade or drop what it refutes.
- Fixes stay serialized in the main thread (or `bee` children on strictly disjoint files); run checks once after merging.

## Hard stops

Do not build these, regardless of framing. State the reason and offer the lawful subset from `references/sector-gates.md`:

- Tools whose purpose is to evade a legal control: age-verification bypass, sanctions/OFAC evasion, KYC circumvention, unauthorized access, stalkerware or covert tracking of a person, scraping behind an authentication wall you agreed not to bypass.
- Sexual content involving minors, or any pipeline that would generate it. Non-consensual intimate imagery and sexual deepfakes of real people.
- Unlicensed money transmission, unregistered securities offerings, and unlicensed real-money gambling presented as "just an app".
- Medical diagnosis, treatment decisions, or prescribing sold as a product without the required clearance and clinical governance.
- Covert data collection: recording, keylogging, screen capture, or location tracking of a person without their knowledge, including "employee monitoring" and "parental control" framings that hide from the monitored person where notice is required.
- Deceptive-by-design flows whose function is to trick: fabricated reviews and testimonials, fake scarcity/urgency counters, cancellation paths engineered to fail, hidden mandatory fees.

## Honesty rules

- Never state or imply the product is compliant, safe, or legal. State what was checked, what was fixed, what remains.
- Never claim a scan proves accessibility or security. Automated checks find a minority of defects; say so.
- Never present something you read as something you ran. Every finding and every fix is **RUNTIME**, **CODE**, or **DEDUCED**, and the report says which. "I could not verify this" is a legitimate and useful output; a fabricated confirmation is not.
- Report what you did **not** check. A review that silently skips the mobile app, the admin panel, or the marketing site reads as full coverage and is more dangerous than no review.
- Never fabricate a statute, section number, case, effective date, or penalty. If unsure, say "verify this" and mark confidence.
- Distinguish **verified**, **snapshot (11 Aug 2026 / 3 Oct 2026, re-verify)**, and **uncertain** in the report. The references carry these markers — preserve them; do not launder a flagged-uncertain item into a confident statement.
- Do not use fear as a lever. Give the base rate and the fix, not doom.
- When the user says a jurisdiction does not apply to them, record it as their stated assumption rather than silently accepting or arguing.

## Reference map

Resolve every path from the installed skill root. Load only what the exposure profile triggered.

- `references/exposure-triage.md` — detection sweep: greps, file signatures, and the question set. Read at the start of a full review.
- `references/trigger-map.md` — master table: observable fact → regimes triggered → required action. The routing index for everything else.
- `references/lawsuit-vectors.md` — private rights of action, demand-letter mills, technical fingerprints they scan for, and the engineering fix per vector. Read for any public consumer-facing product.
- `references/security-baseline.md` — pre-deploy technical blockers, the failure modes specific to AI-generated code, and the AI/agent security section. Read before any deploy.
- `references/us.md` — US federal and state detail: privacy laws, minors, health/biometric, AI laws, marketing, accessibility.
- `references/eu-uk.md` — GDPR/UK GDPR, ePrivacy, AI Act, DSA, EAA, CRA, Online Safety Act.
- `references/sector-gates.md` — regulated and prohibited domains, safe subsets, hard red lines, and the red-flag phrase table.
- `references/artifacts.md` — copy-ready skeletons: privacy policy, terms, consent banner, DSAR flow, AI disclosures, email/SMS compliance, app-store gates, vendor DPAs.
- `references/provenance.md` — snapshot date, sources, confidence levels, and the volatile-items list that must be re-verified.
