# EU / EEA / UK

Snapshot **11 Aug 2026**, spot re-verified 3 Oct 2026 (see `provenance.md`). Markers: **[V]** verified against a primary/first-tier source · **[S]** snapshot, re-verify · **[U]** contested or in flux.

**Territorial reality:** GDPR applies to anyone offering goods or services to, or *monitoring the behaviour of*, people in the EU/EEA — regardless of where the developer sits **[V]**. Monitoring includes analytics cookies, session replay, ad pixels, and behavioural profiling. A US solo dev with an open signup form and Google Analytics is in scope. Blocking EU traffic is a legitimate engineering answer and should be offered as an option.

---

## 1. GDPR / UK GDPR

**Lawful basis (Art 6)** — pick one *per purpose*, before shipping, and record it **[V]**. Typical mapping: consent for marketing, non-essential analytics, and optional AI-training use; contract for account creation and core feature delivery; legitimate interests (with a documented assessment) for security, fraud prevention, and basic product telemetry. The UK adds a "recognised legitimate interests" list that removes the balancing test for some purposes **[V]**.

**Consent quality (Art 4(11), 7)** — unbundled, granular per purpose, an affirmative act, as easy to withdraw as to give, and logged with timestamp, version and scope **[V]**. You cannot bundle analytics, advertising and functional purposes into one checkbox.

**Transparency notice (Art 13/14)** must contain: controller identity and contact (plus the Art 27 representative), DPO if any, purposes and lawful basis **per purpose**, the legitimate-interests description, recipients or categories of recipients (name subprocessors), third-country transfers with the mechanism and how to obtain a copy of safeguards, retention periods, the full rights list including withdrawal and the right to complain to a supervisory authority, whether provision is statutory or contractual, and any automated decision-making with meaningful information about the logic **[V]**.

**Rights and deadlines** — one month, extendable by two for complexity, with notification inside the first month **[V]**. The UK now calculates the clock differently under a new Art 12A, allowing a stop-the-clock while you seek identification or clarification **[V]**.

**UK complaints duty** — from 19 June 2026 UK controllers must operate a formal data-protection complaints procedure and acknowledge complaints within 30 days **[V]**. Artifact: a published complaints route and a tracked queue.

**Art 30 records** — the "under 250 employees" exemption is effectively worthless because it falls away for non-occasional processing (any live product), risky processing, or special-category data **[V]**. Assume you need a record of processing activities.

**DPIA (Art 35)** — required when two or more of the WP248 criteria hit: scoring/evaluation, automated decisions with legal or significant effect, systematic monitoring, sensitive data, large scale, matched or combined datasets, vulnerable subjects including children, innovative technology (**LLM features count**), or preventing access to a service **[V]**. Many AI features trip two criteria immediately.

**Art 27 representative** — a non-EU controller targeting EU users must appoint a written-mandated EU representative in a Member State where subjects are located and publish it in the notice; the UK requires a separate one **[V]**. The exemption is narrow (occasional, low-risk, no special-category data), so most US indie SaaS with EU users technically needs both. Cost is a real annual subscription — flag it as a business decision, not a code change.

**DPO** — only for large-scale systematic monitoring, large-scale special-category/criminal data, or public authorities. A typical small SaaS does not need one; name a privacy contact instead **[V]**.

**Art 28 processor contracts** — every vendor processing personal data on your behalf (hosting, database, CDN, error tracking, analytics, email, LLM APIs) needs a DPA with the Art 28(3) clauses, documented subprocessor authorisation, and change notification **[V]**. Most major vendors publish a self-serve DPA; some require acceptance in the dashboard. Note that some vendors act as independent controllers for parts of their service — check rather than assume.

**International transfers** — the EU–US Data Privacy Framework remains valid: the General Court dismissed the Latombe challenge in September 2025 and the appeal was pending with no hearing date as of mid-2026 **[V]**. Design for reversibility: execute SCCs alongside DPF reliance and know which vendors are US-only **[V]**.

**Breach notification** — 72 hours to the lead supervisory authority from *awareness*, not from confirmation, unless a risk is unlikely; without undue delay to individuals where the risk is high; and an internal register of **all** breaches regardless of reportability **[V]**.

**Children (Art 8)** — the digital age of consent varies by Member State between 13 and 16 **[V]**. If you cannot gate per country, set 16, or design so that no consent-based processing applies to minors.

---

## 2. ePrivacy — cookies and device storage

Consent is required **before** any non-essential storage or access on the user's device, under the ePrivacy Directive as transposed by each Member State — 27 variants **[V]**. The Digital Omnibus proposal to move cookie rules into the GDPR (Art 88a/88b: one-click refuse, no re-asking for six months, browser signals) is **not law** — as of September 2026 it was still in first reading with no Council negotiating mandate and no trilogue **[S]**. Do not build to it; one-click reject is already the defensible design anyway. Scope is technology-neutral and expressly reaches pixels, local storage, and similar techniques **[V]**. This applies **whether or not** the data is personal, which is why "we only use anonymous analytics" is not an answer.

**Banner technical spec** (this is the implementable contract):
- No third-party script, pixel, or network request before an affirmative choice.
- No pre-ticked boxes.
- Reject at the same layer and with the same visual weight as accept.
- Granular per-purpose toggles.
- A persistent re-open control for withdrawal.
- Store the choice with a bounded expiry and re-ask; log timestamp, version and scope.

**Enforcement reality:** very large fines have gone to large platforms, and regulators have run complaint-driven sweeps and warning campaigns against ordinary websites, including fines for pre-ticked boxes **[V]**. Small sites are targeted by complaints, not by proactive audits.

**Consent-or-pay:** permitted only under conditions, with the guidance scoped to large platforms; a hard cookie wall with no free path is high risk for a small app **[V]**. A third "free without personalised tracking" option is the defensible design. Later broadening of this guidance is reported but unconfirmed **[U]**.

**Google Analytics** is not illegal in Europe in 2026 — the transfer defect behind the 2022 decisions has an answer in the DPF — but the consent-before-tracking requirement still applies **[V]**.

**UK divergence (important):** from 5 February 2026 certain first-party analytics and functionality cookies are exempt from the PECR consent requirement where you give clear information and a simple, free way to object **[V]**. This does **not** extend to third-party advertising cookies, and it does not change EU rules — a single banner serving both markets should keep the stricter behaviour unless you geo-branch.

**PECR penalties** rose to £17.5m or 4% of global turnover **[V]**.

---

## 3. EU AI Act — timeline

The Digital Omnibus on AI (Reg (EU) 2026/1744 of 8 July 2026) was published in the OJ on 24 July 2026 and entered into force on the third day after publication **[V]** (EUR-Lex OJ text opened 3 Oct 2026). Dates below marked **[V]** were read in that text; 2 Feb 2027 was not located there **[U]**. **Any guidance dated before mid-2026 saying high-risk obligations apply from 2 August 2026 is now wrong.**

| Date | Status |
|---|---|
| 2 Feb 2025 | Prohibited practices and AI literacy — **in force** **[V]** |
| 2 Aug 2025 | GPAI models, governance, penalties — **in force** **[S]** |
| **2 Aug 2026** | **Article 50 transparency obligations — in force now** (general application date) **[V]** |
| 2 Dec 2026 | Art 50(2) marking for generative systems placed on the market before 2 Aug 2026; new Art 5(1)(ba)/(bb) prohibitions incl. non-consensual sexual deepfakes of identifiable people **[V]** |
| 2 Feb 2027 | Watermark-detection interoperability deadline for providers **[U]** |
| **2 Dec 2027** | High-risk obligations for standalone Annex III systems — **deferred** **[V]** |
| 2 Aug 2028 | High-risk obligations for embedded Annex I systems **[V]** |

**Provider vs deployer is the consequential classification.** Providers develop an AI system, or have it developed, and place it on the market or into service **under their own name or trademark**, regardless of establishment **[V]**. Wrapping a foundation model in your own product and shipping it under your brand generally makes you a provider of that AI system — not merely a deployer.

**What applies right now:**
- **Art 4 AI literacy** — provider *or* deployer, no size exemption, in force since Feb 2025. Realistic artifact for a small team: a one-page internal AI-use policy plus a dated reading/training record **[V]**.
### Art 5 prohibited practices — check these FIRST

These are **bans**, in force since 2 Feb 2025, carrying the top penalty tier of €35M or 7% of global turnover **[V]**. They map to the **ILLEGAL** severity label: the answer is "delete the feature", never "add a disclosure". Check this list before Art 50, because Art 50 tells you how to *label* a system you are allowed to ship, and it will quietly mislead you into labelling one you are not.

Eight categories are prohibited **[V]**. The ones a small developer realistically builds by accident:

- **Art 5(1)(f) — inferring emotions in the workplace or education**, except for medical or safety reasons **[V]**. The Commission reads "workplace" broadly and it **expressly covers recruitment and hiring** **[V]**. Any system scoring an interview candidate's confidence, enthusiasm, engagement, or sincerity from face, voice, or physiology is caught, and commentary concludes there is no realistic exemption for interview assessment **[V]**. Same for exam proctoring and student-attention scoring in education **[V]**. A narrow carve-out exists for personal training use where results are not shared with HR and cannot affect assessment or promotion **[S]** — do not rely on it without advice.
- **Art 5(1)(g) — biometric categorisation to infer race, political opinions, trade union membership, religious or philosophical beliefs, sex life, or sexual orientation** from biometric data **[V]**. Any "guess ethnicity/gender/orientation from a photo" feature is prohibited, including as an internal analytics field.
- **Art 5(1)(e) — untargeted scraping of facial images** from the internet or CCTV to build or expand facial-recognition databases **[V]**. This bans the face-search-engine pattern outright.
- **Art 5(1)(c) — social scoring** leading to detrimental or disproportionate treatment in unrelated contexts — including by private actors **[V]**. A general-purpose "trust score" or "reputation score" applied across unrelated domains is the risky shape.
- **Art 5(1)(b) — exploiting vulnerabilities** of age, disability, or socio-economic situation to materially distort behaviour **[V]**; **Art 5(1)(a) — subliminal or manipulative techniques** causing significant harm **[V]**. Aggressive engagement mechanics aimed at children or people in financial distress live here.
- **Art 5(1)(d)** — predicting criminal offending from profiling or personality traits; **Art 5(1)(h)** — real-time remote biometric identification in public spaces for law enforcement **[V]**. Rare for small devs, but absolute.

**Territorial reach:** the ban applies to use affecting people in the EU regardless of where the company is established **[V]**. A US or UK company running emotion analysis on EU candidates is in scope.

**Stacking:** emotion recognition and biometric categorisation almost always process biometric data, which is Art 9 special-category data, so a prohibited-practice finding normally carries a parallel GDPR violation **[V]**. Report both.

### Art 50 transparency — for systems you are allowed to ship

- **Art 50(1) chatbot disclosure** — disclose that the user is interacting with an AI at first interaction, in the UI. The "obvious to a reasonable person" carve-out exists but is a bad bet; label it **[V]**.
- **Art 50(2) synthetic-output marking** — providers of generative systems must embed machine-readable provenance in generated audio, image, video and text: C2PA/Content Credentials manifests, watermarking where feasible **[V]**. New systems now; pre-2 Aug 2026 systems from 2 Dec 2026 — **record your placing-on-the-market date**.
- **Art 50(4) deepfake and public-interest text labelling** — deployers must apply a user-visible label at first exposure; guidance takes a broad territorial view for globally accessible content **[V]**.
- **Art 50(3)** — emotion recognition or biometric categorisation requires informing exposed persons, and is special-category processing under GDPR **[V]**.
- **Code of Practice safe harbour** — adherence to the transparency Code of Practice is the cheapest defensible posture for a small provider, though not conclusive evidence of compliance **[V]**.

**High-risk (Annex III)** is unlikely unless the feature does CV screening or hiring, credit scoring, education assessment, biometric identification, essential-service eligibility, or law-enforcement/migration work **[V]**. If it does, treat it as a major project and route to counsel.

**Minimum for a small dev shipping an LLM feature — do all five:** visible AI label; provenance marking on generated media; user-facing label on deepfakes and AI-published text on matters of public interest; an `ai-literacy.md` plus AI-use policy; and a one-page system description recording model provider, purpose, limitations, human-oversight path, and your provider/deployer determination.

Penalties for Art 50 breaches reach €15M or 3% of global turnover; prohibited practices reach €35M or 7% **[S]** on the exact tier post-Omnibus.

---

## 4. Other EU acts

- **Digital Services Act** — triggered by *hosting information provided by a recipient*: user uploads, comments, profiles, public pastes, shared docs. Single-tenant B2B SaaS with no third-party-visible content is generally out **[V]**. All hosting providers regardless of size owe a point of contact for authorities and users, a notice-and-action mechanism, statements of reasons for removals, and terms describing moderation. Micro and small enterprises are exempt from several heavier duties but **not** from the basics.
- **European Accessibility Act (Directive (EU) 2019/882)** — applies to **service categories**, not all software: e-commerce (any consumer-facing online sale), consumer banking, e-books, electronic communications, transport ticketing, and access to audiovisual media **[V]**. Applies since 28 June 2025 to products placed on the market and services provided to consumers after that date (Art 31(2)) **[V]**. Art 32 transitional rules: service contracts agreed before 28 June 2025 may run unaltered until expiry but no later than **28 June 2030**; products already used to deliver services may continue until 28 June 2030; self-service terminals up to 20 years **[S]** (Article text as quoted by secondary sources; EUR-Lex not opened). None of this exempts a new or changed web checkout. A B2B-only SaaS is out of scope; a B2C app with a checkout is in. Technical standard is EN 301 549 (WCAG 2.1 AA today; a WCAG 2.2-aligned revision is in progress **[U]** — build to 2.2 AA now, it is backwards-compatible). Microenterprises (<10 staff and ≤€2M turnover) are exempt for services, but the detail varies by transposition **[S]**.
- **Cyber Resilience Act** — applies to *manufacturers* of products with digital elements placed on the EU market: downloadable or installable software, desktop and mobile apps, browser extensions, firmware, monetised libraries **[V]**. Main obligations from 11 December 2027, but **reporting obligations from 11 September 2026** — actively exploited vulnerabilities and severe incidents must be reported on a short clock. Pure SaaS is generally outside, but the SaaS boundary is exactly where small products get caught unexpectedly; re-read the Commission's practical guidance **[U]**.
- **NIS2** — sector plus size; cloud, data-centre, managed-service and managed-security providers are in scope, but the size cap generally means ≥50 staff or >€10M turnover **[S]**. A small SaaS is normally out unless designated.
- **Data Act (Regulation (EU) 2023/2854)** — applicable since **12 September 2025** (Art 50) **[S]**. Two developer-relevant parts: (1) providers of data processing services (expressly including SaaS, PaaS, IaaS) with EU customers, with no carve-out for small providers, owe contractual switching and egress terms, no unreasonable exit barriers, and data-porting support; switching charges must be abolished from **12 January 2027** **[S]**. (2) Makers of **connected products** (IoT devices, wearables, connected cars) and their companion apps owe user access to product and related-service data; from **12 September 2026** products placed on the market must be designed so users can access that data directly where relevant and technically feasible (Art 3(1)) **[S]**. Chapter IV unfair-terms rules apply to B2B data contracts concluded after 12 Sept 2025 **[S]**.
- **DORA** — only if you are a financial entity or a contracted ICT provider to one; for a small dev it arrives as customer contract terms **[S]**.
- **PSD2 SCA** — use a PSP with 3-D Secure rather than building card flows; exemptions belong to the PSP **[S]**.
- **MiCA** — issuing a token or providing crypto-asset services to EU users requires authorisation; merely accepting crypto payment through a licensed processor generally does not **[S]**.
- **GPSR** — whether standalone software is a "product" is genuinely unresolved: the Commission's FAQ says software is included, while a recital excludes services **[U]**. Flag as uncertain rather than asserting either way.
- **Platform-to-Business Regulation** — if you let business users offer goods or services to consumers (a marketplace, a booking layer): plain-language terms with 15-day change notice, disclosed ranking parameters, stated reasons for suspension, and an internal complaints process **[V]**.

---

## 5. UK specifics

- **Data (Use and Access) Act 2025** — Royal Assent 19 June 2025; commenced in stages. The principal data-protection provisions came into force on **5 February 2026** under SI 2026/82 (legislation.gov.uk): ss. 70, 76, 80, 112 and Schedules 4, 6, 11, 12 **[V]**. Code-relevant changes: the new DSAR clock (Art 12A UK GDPR), recognised legitimate interests (no balancing test), Arts 22A–22D replacing the automated-decision prohibition with permission plus safeguards (information, representations, human intervention, contest) for non-special-category data, and the PECR analytics/functionality cookie exemption. The complaints-handling duty (new s. 164A DPA 2018) followed on **19 June 2026** **[V]**. Remaining stages (ICO restructuring into the Information Commission) are institutional and do not change code **[S]**.
- **Online Safety Act** — triggered by **user-to-user** services (anywhere users can encounter content uploaded by others — comments, DMs, forums, shared galleries, multiplayer chat), search services, and pornography publishers, with UK links. **There is no small-service exemption from the core duties**, and the regulator runs a dedicated "small but risky" supervision function **[V]**. Duties include illegal-content and children's-access risk assessments, proportionate safety measures, reporting and complaints mechanisms, and highly effective age assurance where required. Ofcom has been fining since late 2025 — mostly for missing highly effective age assurance on pornographic services, and in one case for a missing illegal-content risk assessment and deficient terms — with penalties up to £18M or 10% of qualifying worldwide revenue **[S]**. The register of categorised services (Category 1, 2A, 2B; extra duties) was published in July 2026 **[S]**; small services are not categorised, but the core duties still apply. Treat any UK-reachable UGC product as in scope and produce the risk assessments — their absence is itself the enforceable failure.
- **Children's Code** — applies to services *likely to be accessed* by under-18s, a much lower bar than "aimed at children": high-privacy defaults, geolocation off by default, no nudges toward weaker privacy, a DPIA covering children, minimised profiling **[V]**.
- **Accessibility** — no private-sector EAA equivalent; exposure runs through the Equality Act duty to make reasonable adjustments, with WCAG 2.1 AA as the de facto benchmark **[S]**.

---

## 6. Consumer and tax blindsides

- **VAT on B2C digital sales to EU consumers** — there is **no small-seller threshold for businesses established outside the EU**; VAT is due from the first sale, via OSS registration or a merchant-of-record **[V]**. This is the single most commonly missed obligation for indie SaaS selling to Europe.
- **Right of withdrawal for digital content** — a 14-day cooling-off period applies by default. You lose it for immediately-supplied digital content **only if** you obtain prior express consent to immediate performance **and** the consumer's acknowledgement that they thereby lose the right, and you confirm it **[V]**. That means a specific checkbox pair at checkout, not a link to terms.
- **A claim circulating that a mandatory "withdrawal button" applies to all EU online traders from 19 June 2026 is a misreading of a financial-services directive** **[V]**. Do not implement it as a general obligation; do not repeat the claim.
- **Pre-contract information** — before the order: main characteristics, total price inclusive of taxes and all charges, duration and minimum term, auto-renewal terms, trader identity with geographic address and email, complaint handling, and digital-content functionality and interoperability. The order button must be labelled to make the payment obligation explicit **[V]**.
- **Pricing and dark patterns** — price-reduction claims must reference the lowest price in the previous 30 days; paid ranking placement must be disclosed; review verification must be described honestly; personalised pricing must be disclosed **[V]**.
- **Unfair terms** — in B2C, non-negotiated terms creating significant imbalance are void: blanket liability exclusions, unilateral changes without notice and an exit right, forum clauses depriving consumers of their home courts, and mandatory arbitration **[V]**. **Do not copy a US ToS into an EU-facing product** — the arbitration and class-waiver clauses that protect you in the US are unenforceable and can themselves be an unfair-terms violation.

---

## 7. Verify before relying

AI Act fine tiers post-Omnibus · EN 301 549 version status · the GDPR/ePrivacy half of the Digital Omnibus (**not law**: as of Sept 2026 still in first reading, no Council mandate, no trilogue) · Ofcom's categorised-services duties consultation outcome · consent-or-pay scope broadening · CRA SaaS boundary · NIS2 small-provider designation practice · UK adequacy status.
