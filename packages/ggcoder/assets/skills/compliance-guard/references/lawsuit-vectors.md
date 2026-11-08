# Lawsuit & Demand-Letter Vectors

How a small app actually gets sued or extorted, ranked by real base rate rather than statutory maximum. Snapshot **11 Aug 2026**, spot re-verified 3 Oct 2026 (see `provenance.md`) — verify any date, amount, or case posture before stating it as current.

**The core asymmetry:** most regulators do not chase solo developers. Private plaintiffs and demand-letter mills do, because the process is automated: a bot scans public sites for a technical fingerprint, a letter goes out, and settling is cheaper than defending. Optimise against *fingerprints*, not against theoretical liability.

---

## 1. Web accessibility demand letters — highest base rate

**Who:** serial plaintiff firms filing thousands of federal suits a year, plus a much larger volume of pre-suit letters. Federal website-accessibility filings were 3,117 in 2025, up 27% on 2024, and over 5,000 counting state courts **[S]**; e-commerce is the primary target, and pro se filings drafted with AI tools are rising **[S]**.

**Fingerprint they scan for:** automated scanners on the homepage and checkout. Missing `alt`, unlabeled form inputs, missing form `<label>`/`aria-label`, low contrast, no visible focus indicator, keyboard traps in modals and menus, inaccessible custom dropdowns, images of text, missing page language, empty links/buttons with icon-only content, and — the defect generated code produces most reliably — **a clickable `<div>` or `<span>` carrying an `onClick` with no `<button>`, no `role`, no `tabIndex`, and no key handler**, which is simply invisible to keyboard and screen-reader users.

**Enumerate each defect separately.** Report accessibility as one finding per distinct defect class with its file and element — "hero image missing `alt`", "email input has no label", "`div` with `onClick` is not keyboard reachable", "#aaa text on #ccc fails contrast" — never as a single "accessibility issues" row. A collapsed row gets partially fixed: the developer adds the alt text, ships, and keeps every remaining barrier. Contrast in particular is checkable statically from the literal colour values in the source and should never be reported as merely "likely".

**Exposure:** federal ADA suits seek injunctive relief plus fees; California's Unruh Act adds statutory damages per visit **[V]**, which is what makes California filings profitable. Settlements for small sites typically land in the low five figures plus remediation.

**Counter-intuitive finding: accessibility overlay widgets increase risk.** A large share of 2025 filings targeted sites running overlays, and the leading overlay vendor faced a regulatory action over its claims **[V]**. Overlays are a beacon, not a shield.

**Engineering fix**
- `@axe-core/playwright` (or `axe-core` + Puppeteer) as a **blocking** CI gate on the top 10 routes; fail on `critical` and `serious`.
- Manual keyboard pass on every flow that takes money or data: tab order, focus visible, escape closes, focus returns.
- Remove any overlay widget and fix the DOM instead.
- Publish an accessibility statement with a real contact route and a response commitment — it does not immunise you, but it converts some letters into conversations.
- Never label the result "ADA compliant"; automated tooling finds a minority of barriers.

---

## 2. Wiretap / pixel / session-replay claims — highest volume in privacy

**Who:** California plaintiffs' firms under CIPA §631 (wiretap) and §638.51 (pen register / trap-and-trace), plus growing analogues in other states **[U]** for the exact state list.

**Theory:** a third-party script on your page is an uninvited "eavesdropper" on the user's communications with you, or is a device capturing routing/identifier data. IP addresses and click data suffice; no sensitive data and no harm are needed.

**Scale:** pen-register-style claims have become a dominant share of active privacy litigation, driven by ordinary analytics and ad tools **[V]**. Statutory damages of **$5,000 per violation** are the leverage **[V]**.

**Relief status:** California SB 690 was signed on 30 September 2026 and is operative 1 January 2027: private suits under the pen-register/trap-and-trace section (§638.51) over a website or app are removed (Attorney General only), with retroactive reach to pending claims filed within the prior two years **[U]** (consistent across law-firm reports; the leginfo text was not retrieved). It does **not** touch §631/§632 wiretap claims, which remain the main pixel/session-replay/chat-widget theory **[S]**. The fix is unchanged: consent-gate every third-party request.

**Fingerprint:** any third-party request firing on page load before consent — Meta/TikTok/LinkedIn pixels, GA, session replay, chat widgets, A/B tools. Server-side tagging does **not** cure it if the third party still receives the data.

**Engineering fix**
- Consent-before-load, enforced technically: no third-party tag may execute until an explicit signal. Test it — a CI check asserting **zero third-party network requests on first paint** is the single highest-value guard.
- Google Consent Mode v2 defaulting to `denied` for ad and analytics storage.
- Strict CSP `connect-src`/`script-src` so an accidental tag cannot phone home.
- Disclose every third-party recipient by name in the privacy notice.
- Arbitration clause with class waiver, presented in an enforceable clickwrap (see `artifacts.md`) — the most effective structural defence.
- Delete session replay, or restrict it to post-login with `maskAllInputs: true` and explicit in-product consent.

---

## 3. Biometric claims (Illinois BIPA and analogues)

**Trigger:** collecting a face geometry, fingerprint, voiceprint, iris, or similar identifier from a person in Illinois — with **no volume threshold**, so a single user creates exposure. Consent must be a **written release obtained before collection**, and you must publish a retention and destruction schedule **[V]**.

**Damages:** $1,000 negligent / $5,000 intentional **per person**, plus fees. The August 2024 amendment (SB 2979) limits recovery to one per person per collection method rather than per scan, and the Seventh Circuit held on 1 Apr 2026 (*Clay v. Union Pacific*) that it applies to cases already pending **[S]**. Exposure dropped, filing volume did not: a class of thousands is still serious money.

**Fingerprint in code:** face detection or recognition SDKs, `face_embedding`/`descriptor`/`template` columns, voice embeddings, liveness checks, photo auto-tagging, avatar generation from a selfie. Face *detection* without identification is contested **[U]** — do not rely on it as a defence.

**Engineering fix:** run matching on-device and return a boolean; never persist a template server-side. If you must, obtain a written release before capture, publish the retention schedule, set a hard deletion job, and treat Illinois/Texas/Washington users as in scope regardless of where you are.

---

## 4. TCPA / SMS

**Trigger:** any SMS to a mobile number without provable prior express consent, or outside permitted hours, or after a revocation. **$500–$1,500 per message, uncapped** **[V]** — one 5,000-recipient blast is millions in exposure.

**Fingerprint:** a `phone` column with no matching consent record; a send loop with no timezone check; "STOP" handled only by the carrier, not your suppression list.

**Engineering fix:** exactly one `canSend()` chokepoint that owns the SMS provider credentials and enforces: valid consent record (with the exact disclosure text shown and a timestamp), suppression list, quiet hours in the recipient's timezone, frequency cap, and campaign type. Process opt-outs received on **any** channel within the statutory window. Register your messaging campaign with the carriers. Keep consent records for years, not weeks.

---

## 5. Subscription / auto-renewal class actions

**Trigger:** auto-renewal or free-trial conversion with disclosures that are not clear and conspicuous *adjacent to the enrolment control*, no separate affirmative consent, or a cancellation path harder than the signup path **[V]**. California's amended auto-renewal law broadened what is actionable **[V]**; the federal click-to-cancel rule was vacated in July 2025 and the FTC only restarted rulemaking with an advance notice in March 2026, so **state law and general deception rules are the live risk** — do not tell a user the federal rule saves them **[S]**.

**Fingerprint:** trial logic with no reminder job; a cancel flow that emails support; terms shown behind a link rather than adjacent to the button; no stored record of what the user was shown.

**Engineering fix:** disclosure block immediately above the pay button (price, renewal cadence, first charge date, how to cancel); a checkbox or equivalent affirmative act; store `{user, timestamp, disclosure_hash, price, terms_version}`; in-app cancel reachable in ≤2 clicks from account home; renewal and trial-conversion reminders; notice before any price change.

---

## 6. IP demand letters

**Stock photos and fonts — the most common IP hit on small sites.** Automated reverse-image scanning drives letters typically in the hundreds to low thousands, escalating to firms that file real suits **[V]**. Leverage depends on registration timing **[V]** — always ask for the registration number and date before negotiating, and route the letter to counsel.

Typical sources of the problem: images pulled from search results, assets supplied by a contractor with no licence trail, Creative Commons images used without the required attribution, platform stock reused after migrating off that platform, foundry fonts self-hosted under a desktop-only licence, paid icon sets vendored from a CDN.

**Copyleft contamination.** AGPL/SSPL dependencies in a closed SaaS create a source-disclosure demand and kill acquisitions; AI-suggested snippets can reproduce GPL or CC-BY-SA code.

**Your own code may not be protectable.** US Copyright Office guidance holds that purely AI-generated output is not copyrightable and that prompting alone does not create authorship **[V]**. For a vibe-coded product this weakens IP claims and must be disclosed in diligence — keep human-authored commits, review history, and meaningful human editing.

**Engineering fix**
- Blocking licence scan in CI (`license-checker`, `syft` + `grant`, ScanCode). Deny AGPL, SSPL, GPL-2.0/3.0, CC-BY-SA, BUSL, Commons Clause, UNLICENSED, UNKNOWN. Fail, don't warn.
- Generate an SBOM per release (CycloneDX) and keep it as an artifact.
- Ship the attribution notices MIT/BSD/Apache actually require at an in-app "Open source licences" route.
- Asset inventory build step: walk `public/`, `assets/`, and `@font-face` sources, hash each file, require a row in a checked-in `LICENSES.csv` with `{sha256, source, licence, receipt, permitted_use}`. Fail on unmatched assets.
- Clear the product name against trademark databases before buying the domain and shipping to app stores.

**Patents:** non-practising entities target small companies heavily and defence costs dwarf settlements **[V]**. You cannot engineer around unknown patents. Do not respond substantively to a demand letter yourself; preserve it and route it to counsel.

---

## 7. Consumer-protection / advertising

- **Fabricated, incentivised, or insider reviews** are directly prohibited with per-violation civil penalties, and enforcement is active **[V]**. Fingerprint: a reviews table with no `verified_purchase`, seeded testimonial fixtures with stock avatars, "5 stars for 10% off", display logic filtering `rating >= 4`, an approval queue that only approves positives.
- **"AI-powered" and accuracy claims** without substantiation are an active enforcement theme **[V]**. Keep a repo-resident claims file mapping each marketing claim to dated evidence.
- **Hidden mandatory fees** are restricted; one `displayPrice()` helper used everywhere is the fix **[V]**.
- **Dark patterns** (pre-checked boxes, confirmshaming, fake urgency timers, obstructed cancel) are independently actionable across many regimes.

---

## 8. Platform and structural risks

- **DMCA safe harbour** requires a registered designated agent *and* a reasonably implemented repeat-infringer policy. The registration **expires after three years** unless renewed — a lapse silently converts every user upload into direct liability **[V]**. Fix: register, calendar the renewal well before expiry, publish the agent contact, and implement `takedown_notices` + `strikes` tables with an actual `terminated_at` column and a counter-notice flow.
- **Contractor IP:** without a signed assignment before the first commit, the contractor may own the copyright — "work made for hire" does not apply to most software by default **[V]**.
- **Single-platform dependency:** an app-store or payment-processor termination is unappealable in practice. Keep a web fallback, a data-export path, and a second processor behind a flag.
- **Accidental data-broker status:** selling or making available personal information about people who never interacted with you triggers registration and deletion-mechanism duties with per-day penalties, and enforcement has already hit companies of exactly this size **[V]**.

---

## Top vectors to check first on any consumer web app

1. Unlabeled inputs / missing alt / no focus indicator on public pages → accessibility letter.
2. Ad or analytics tags firing before consent → wiretap claim.
3. An accessibility overlay installed instead of remediation → increases targeting.
4. Auto-renew or trial checkout with buried terms and email-only cancel → subscription class action.
5. SMS with no per-recipient consent record or timezone check → uncapped statutory damages.
6. Unlicensed image or font anywhere on the site → automated demand letter.
7. Session replay recording form input → wiretap claim.
8. UGC with no registered DMCA agent (or a lapsed one) → loss of safe harbour.
9. Face/voice embedding persisted server-side → biometric claim from a single user.
10. Seeded, incentivised, or AI-written reviews → advertising enforcement.
11. Unsubstantiated "AI-powered"/accuracy claims → deception enforcement.
12. AGPL/GPL dependency in closed-source SaaS → source-disclosure demand and diligence failure.
13. Video pages carrying ad pixels → video-privacy claims **[U]**.
14. Hidden mandatory fees at checkout → pricing enforcement.
15. Lead-gen or enrichment selling data about non-customers → data-broker penalties.

**Structural defences that cut across everything:** an enforceable clickwrap at signup with arbitration and class waiver; a consent state that gates all non-essential third parties; one chokepoint per risky capability; and records — consent records, disclosure hashes, and audit logs are what convert a lawsuit into a dismissal.
