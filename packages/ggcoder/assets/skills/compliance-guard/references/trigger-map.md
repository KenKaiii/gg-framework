# Trigger Map

Observable fact → what it triggers → what to actually do. This is the routing index; depth lives in the jurisdiction and vector files.

Status markers: **[V]** verified against a primary source (11 Aug 2026 snapshot, spot re-verified 3 Oct 2026 — see `provenance.md`) · **[S]** snapshot claim, re-verify date/threshold before asserting · **[U]** uncertain or contested, present as uncertain.

---

## A. Universal — applies to essentially any product with real users

| Observed fact | Triggers | Do this |
|---|---|---|
| Any personal data at all, any deployed app | GDPR/UK GDPR if EU/UK reachable; US state privacy laws by residency | Privacy notice at collection; lawful basis recorded; deletion path that actually deletes; vendor list |
| Third-party scripts on a public page | ePrivacy consent **[V]**, CIPA/wiretap claims **[V]**, state "sharing" opt-outs | Block non-essential tags until consent; consent banner with reject parity; disclose recipients |
| Accounts / login | Security baseline; breach-notification readiness | See `security-baseline.md` P0 list; hashing, session flags, server-side authz |
| A public marketing or product web page | ADA Title III / EAA accessibility **[V]** | WCAG 2.1 AA minimum (2.2 AA if targeting EU public-sector or new work); axe CI gate; accessibility statement |
| Any email you send | CAN-SPAM; Gmail/Yahoo bulk-sender rules **[S]** | Physical postal address, working unsubscribe, `List-Unsubscribe` + one-click, honour within 10 business days |
| Contact/support form | Privacy notice; retention | Say what you do with it; delete on a schedule |
| Error tracking / logs | Personal data in logs; transfer duties | Scrub PII, set retention, sign the vendor DPA |
| No entity, personal liability | Contract/liability exposure | LAWYER item — do not paper over it |

---

## B. Tracking, analytics, advertising

| Observed fact | Triggers | Do this |
|---|---|---|
| Any analytics that sets a cookie or reads device storage | ePrivacy consent (EU/UK) **[V]** regardless of whether data is personal | Prior blocking; granular purposes; consent record with timestamp + policy version |
| Meta/TikTok/Google ad pixel | CIPA §631/§638.51 **[V]**, state "sale/share" opt-out, GDPR joint-controller | Consent-gated load; GPC honoured server-side; DPA/joint-controller terms; list recipient in the notice |
| Session replay (Hotjar, Clarity, FullStory, LogRocket) | Wiretap claims — the strongest fingerprint **[V]** | Prefer removal. If kept: post-login only, mask all inputs, explicit in-product consent, no keystroke capture |
| Chat widget (Intercom, Drift, Zendesk, tawk) | Wiretap/third-party-eavesdropper claims **[V]** | Disclose the third party in the chat UI before the first message; consent-gate the script |
| Fingerprinting / device ID | Consent; several state laws treat it as an identifier | Consent-gate; document purpose; do not use to defeat opt-outs |
| Cross-origin Google Fonts / CDN assets | EU transfer + consent claims **[S]** | Self-host fonts. Cheapest fix in the whole file |
| Cookie banner that loads tags first, or has no reject button | Regulator fines and litigation **[V]** | Reject-all as prominent as accept-all; nothing fires pre-consent; withdrawal as easy as consent |
| Video content + any ad pixel | VPPA class actions **[U]** — circuit split, actively litigated | Strip ad pixels from pages containing video until resolved. **Passing the video title or id into the pixel payload is the exact fingerprint** — check tag parameters, not just tag presence |
| Any cross-context tracking at all | Universal opt-out / GPC duty **[V]** | Handle `Sec-GPC: 1` server-side before tags load. The defect is an **absent handler**, so grep for its absence rather than waiting for something to look wrong |

---

## C. Money

| Observed fact | Triggers | Do this |
|---|---|---|
| Card payments via Stripe/Paddle/etc. | PCI DSS scope, consumer law, tax | Never let PAN touch your server; hosted fields/Checkout; verify webhook signatures; idempotency keys |
| Auto-renewing subscription | ROSCA + ~25 state auto-renewal laws **[V]** | Clear pre-purchase disclosure adjacent to the CTA; separate affirmative consent + stored record; cancel in the same medium in ≤2 clicks; renewal reminders; price-change notice |
| Free trial converting to paid | Highest-risk consumer pattern **[V]** | Pre-conversion reminder; disclose conversion date and amount before charging |
| Hidden mandatory fees at checkout | Junk-fee and honest-pricing rules **[V]** | One `displayPrice()` returning base + all mandatory fees, used on every surface |
| You hold, route, or pool user funds | Money transmission licensing | **Gate** — see `sector-gates.md` §3 before writing the ledger |
| Payouts to users | Tax reporting, KYC, sanctions | Use a provider that owns the obligation (Stripe Connect/Express) rather than building it |
| Selling to EU/UK consumers | Distance-selling info duties, withdrawal rights, VAT/OSS **[V]** | Pre-contract info before the pay button, 14-day withdrawal terms **plus the digital-content waiver checkbox pair**, tax handling or a merchant-of-record. **Fires on any paid consumer flow reachable from the EU/UK, independently of auto-renewal and pricing findings** — do not treat those as covering it |
| Crypto, tokens, wallets | MiCA / US regimes | **Gate** — `sector-gates.md` §3 |

---

## D. Users, content, community

| Observed fact | Triggers | Do this |
|---|---|---|
| In-app currency, credits, gems, or tips **that can be cashed out** | Money transmission / e-money licensing **[V]** | **ILLEGAL without authorisation** — route through a licensed provider's managed payouts; never hold a user-owned balance. See `sector-gates.md` §3 |
| Any generated audio, video, image, or synthetic persona shown to users | Synthetic-content marking + labelling **[V]** | Machine-readable provenance on the artifact **and** a visible label, separate from whether generating it was allowed |
| Users can upload files or post content | DMCA safe harbour prerequisites **[V]**; intermediary duties | Register a DMCA designated agent (small fee, expires after 3 years — calendar a renewal); publish it; repeat-infringer policy with a real termination mechanism |
| Users can upload **images or video** | CSAM reporting duties **[V]**; NCII takedown duty **[V]** | Hash-matching where feasible; NCMEC reporting path and preservation; public NCII report form with a 48-hour removal SLA and identical-copy removal |
| Hosting user content while established in, or reachable from, the EU/UK | **EU DSA** intermediary duties **[V]**; UK Online Safety Act | Notice-and-action mechanism, published point of contact, moderation criteria in the terms, minors' protection. **Separate from and additional to the US DMCA/CSAM/NCII duties** — naming only the US set leaves an EU-established platform's own regulator unaddressed |
| Public profiles, DMs, feeds | EU DSA / UK Online Safety duties **[V]**, harassment/safety | Notice-and-action mechanism, contact point, terms describing moderation, risk assessment if UK-facing |
| Reviews or testimonials displayed | FTC Consumer Reviews Rule **[V]** | No fabricated or seeded reviews, no incentives conditioned on sentiment, no rating-filtered display, disclose insider reviews. Delete fixture testimonials before launch |
| Adult content | State age-verification laws **[V]** | **Gate** — `sector-gates.md` §6 |
| Deepfakes, voice cloning, likeness | Right of publicity, NCII, state AI laws **[V]** | **Gate** — consent-of-subject architecture or do not build |

---

## E. Minors

| Observed fact | Triggers | Do this |
|---|---|---|
| Any realistic under-13 users (US) | COPPA **[V]** | Verifiable parental consent before collection; separate consent for third-party disclosure; published retention policy; no behavioural ads to children; delete on request |
| Under-16/18 users | State minor-protection laws, UK/EU children's codes **[V]** | High-privacy defaults, no profiling ads, age-appropriate design, no dark patterns |
| App-store distribution to minors | Platform family policies + state app-store age laws **[S]** | Correct age rating, families policy compliance, no third-party ad SDKs in kids builds |
| Education/school customers | FERPA/PPRA and state student-privacy contracts **[V]** | School-consent model, contractual terms, no secondary use, no ads |
| AI companion features reachable by minors | Companion-chatbot laws **[V]**, incl. a private right of action in at least one state | Disclosure, crisis handling, minor mode, incident logs — see `us.md` |

**Rule:** "we don't allow under-13s" in the terms is not a defence if the design attracts them or you have actual knowledge. Actual-knowledge signals include a user telling support their age.

---

## F. Sensitive data classes

| Observed fact | Triggers | Do this |
|---|---|---|
| Estimating age, gender, or any attribute from a face or voice | Biometric categorisation duties **[V]**; age-assurance law where it gates content | Inform the exposed person; document the GDPR Art 9 analysis; an *estimate* is not verification where a law requires effective age assurance |
| Face/voice templates, fingerprints, iris | Illinois BIPA and analogues **[V]** — per-person statutory damages, no volume threshold | Written release before capture; published retention/destruction schedule; prefer on-device matching returning a boolean, never storing a template |
| Health, symptoms, fitness, mental health, cycle/fertility | Consumer-health-data laws with a private right of action **[V]**; possibly HIPAA | Separate consent for collection; separate signed authorisation before any sale/share; strict vendor control; see `sector-gates.md` §1 |
| Precise geolocation | Sensitive category in most state laws; consent required | Opt-in, purpose-limited, coarse where possible, short retention |
| Genetic data | Dedicated genetic-privacy statutes | LAWYER before building |
| Government ID / identity documents | Retention and security duties, breach severity | Use a verification vendor; do not store images; keep only a boolean and a reference |
| Immigration, criminal, union, religion, sexual orientation, race | GDPR Art 9 / state sensitive-data rules | Explicit opt-in, DPIA, minimise or drop the field |

---

## G. AI features

| Observed fact | Triggers | Do this |
|---|---|---|
| User-facing chatbot | EU AI Act Art 50 disclosure **[V]**; several US state chatbot-disclosure laws **[V]** | Persistent "you are talking to an AI" disclosure, not buried in terms. See `eu-uk.md` §3 (Art 50) and `us.md` §5 |
| Companion / emotional / therapy-adjacent chatbot | Companion-AI laws + AI-therapy bans **[V]** | **Gate** — `sector-gates.md` §1 and §5, `us.md` §2 (CA SB 243, PRA) and §5. Crisis protocol, minor protections, and in some states you cannot offer therapy at all |
| Scoring emotion, confidence, engagement or sincerity from face/voice in **hiring, work, or education** | EU AI Act Art 5(1)(f) **prohibited practice** **[V]** | **ILLEGAL in the EU — remove the feature.** Not curable by disclosure or consent. See `eu-uk.md` Art 5 |
| Inferring race, ethnicity, gender, religion, union membership or sexual orientation from a photo, face or voice | EU AI Act Art 5(1)(g) **prohibited** **[V]**; discrimination law everywhere | **ILLEGAL in the EU — delete the field and the model.** Also a discrimination claim if it touches any decision |
| Building a face database by scraping images from the web or CCTV | EU AI Act Art 5(1)(e) **prohibited** **[V]** | **ILLEGAL in the EU.** Also BIPA and scraping exposure |
| Cross-context "trust score" or "reputation score" affecting unrelated treatment | EU AI Act Art 5(1)(c) social scoring **[V]** | **Gate** — narrow the score to the context it was collected for |
| Generated images/audio/video | Synthetic-content marking duties **[V]** | Machine-readable provenance (C2PA-style) + visible label where required. EU: Art 50(2)/(4), legacy systems by 2 Dec 2026 — `eu-uk.md` §3. CA SB 942/AB 853 if >1M monthly users — `us.md` §2. Sexual deepfakes of real people: `sector-gates.md` §6 |
| AI in hiring, lending, housing, insurance, education, essential services | High-risk/ADS regimes **[V]** | Notice, human review, bias testing, records, adverse-action reasons. LAWYER item |
| Training or fine-tuning on user data | Lawful basis, notice, opt-in expectations, training-data disclosure laws **[S]** | Default to opt-out-by-default = off; document data sources; check vendor terms. CA AB 2013 (no size threshold) — `us.md` §2 |
| Agent with tool access / code execution | Prompt injection, exfiltration, cost abuse | See `security-baseline.md` §9 — this is a security blocker, not a policy item |
| Sending user PII to an LLM vendor | Processor relationship, transfers, retention | Sign the DPA, use zero/limited-retention endpoints, redact before send, disclose the vendor |
| Marketing claims like "AI-powered", "99% accurate", "fully automated" | Deceptive-claims enforcement **[V]** | Keep a dated substantiation file mapping each claim to evidence |

---

## H. Messaging

| Observed fact | Triggers | Do this |
|---|---|---|
| Marketing email | CAN-SPAM, EU/UK consent + soft opt-in, CASL for Canada **[V]** | Consent record per recipient per channel; postal address; one-click unsubscribe; suppression list enforced at send |
| SMS / voice | TCPA + state analogues **[V]** — uncapped per-message statutory damages | One `canSend()` chokepoint enforcing consent + opt-out + quiet hours in the recipient's timezone + frequency cap; STOP/HELP handling; carrier registration |
| Push notifications used for marketing | Platform policy + consent expectations | Separate marketing toggle from transactional |
| Cold outreach / scraped contacts | Anti-spam and data-protection breaches | Usually unlawful in the EU/UK without consent. Say so plainly |

---

## I. Data sourcing

| Observed fact | Triggers | Do this |
|---|---|---|
| Scraping public web pages | Contract/ToS, trespass, database rights **[V]** | Never authenticate to scrape; never click through terms on the target; honour `robots.txt`; rate-limit; log `{url, timestamp, status, robots snapshot}` |
| Scraping personal data | EU regulators treat this as high-risk **[V]** | Document a legitimate-interest assessment or do not do it; expect it to be the weakest point in any audit |
| Selling or licensing data about people who never used you | Data-broker registration + deletion-mechanism duties **[V]** | Ask at design review: "do we sell PI of people who never used us?" If yes: registration, deletion pipeline, real budget |
| Training on data of unknown provenance | Infringement exposure turns on *how you obtained it* **[V]** | No pirated corpora, ever. Keep provenance records |
| Bundled images, fonts, icons, UI kits | Stock-photo and font demand letters — high base rate **[V]** | Build-step asset inventory: every image/font needs a row in a checked-in licence manifest with source + licence + receipt. Fail the build on unmatched assets |
| Dependencies | Copyleft contamination in closed-source SaaS **[V]** | Blocking licence scan in CI denying AGPL/SSPL/GPL/CC-BY-SA/BUSL/unknown; generate an SBOM; ship the attribution notices MIT/Apache actually require |

---

## J. Regulated domains — evaluate before anything else

Any hit here goes to `sector-gates.md` first, because the answer may be "this cannot ship as described".

Health/medical · mental health/therapy · telehealth/prescribing · legal advice · financial/investment advice · tax preparation · insurance · lending/BNPL · money transmission/wallets/crypto · gambling/sweepstakes/prize contests/loot boxes · firearms · alcohol/tobacco/vape/cannabis · pharmacy · adult content · dating/safety · background checks/tenant screening/hiring decisions · credit/housing decisions · children's education · drones/aviation/maritime · export-controlled technology · elections/political ads.

---

## K. Fast severity heuristics

Treat as **BLOCKER** on sight:

1. Secrets, service-role keys, or admin credentials reachable from a client bundle or committed to the repo.
2. Any table with user data readable or writable without a server-side authorization check on the object (not just the route).
3. Tracking or ad pixels firing before consent where consent is required.
4. Children's data collected with no parental-consent path.
5. Biometric templates persisted with no written release and no retention schedule.
6. Payment card data touching your server or logs.
7. Auto-renewing charges with no in-product cancel.
8. SMS sending with no per-recipient consent record.
9. User uploads of images with no abuse-reporting or takedown path.
10. A regulated-domain product with no licence and no disclaimer, presented as the real service.
