# Sector Gates

Domains where **building the thing is the problem**, not the privacy policy. Evaluate these *before* any other checklist: if the product cannot lawfully exist as described, nothing downstream matters.

Snapshot **11 Aug 2026**, spot re-verified 3 Oct 2026 (see `provenance.md`). Markers: **[V]** verified · **[S]** re-verify · **[U]** genuinely unresolved.

Each entry gives the trigger, the **safe subset** a small dev can ship, and the **red line** that means stop.

---

## 1. Health and wellness

**HIPAA** reaches covered entities and their business associates. A direct-to-consumer fitness, period, or wellness app with no provider or plan contract is usually **not** covered **[V]** — but you become a business associate the moment you create, receive, maintain, or transmit PHI *on behalf of* a covered entity, which requires a BAA, Security Rule compliance, and 60-day breach notice. If you are not HIPAA-covered you are still subject to the FTC Health Breach Notification Rule and state consumer-health-data laws, which are often *worse* because one carries a private right of action.

**Wellness app → medical device.** The trigger is **intended use**: claiming to diagnose, treat, cure, mitigate, or prevent a disease. Marketing copy, not architecture, decides this **[V]**. In the EU, MDR Rule 11 puts software providing information used for diagnostic or therapeutic decisions at **Class IIa minimum** **[V]** — there is effectively no "just a wellness app" path for diagnostic output.
- **Safe subset:** log data, present it back, cite third-party general information, explicitly disclaim diagnosis, no treatment recommendations, no risk scores framed as clinical.
- **Red line:** "AI doctor", "diagnoses your symptoms", "tells you if you have X", dosage recommendations, or interpreting medical images. Unlawful to market without clearance/CE.

**Telehealth and online prescribing** — the clinician must be licensed **in the patient's state**; compacts ease but do not erase this. Controlled substances add federal constraints and the telemedicine flexibilities have a scheduled expiry **[S]** — verify the current date before relying on it.
- **Red line:** any flow that results in a prescription without a licensed prescriber in the patient's jurisdiction.

**Mental-health and companion chatbots — the fastest-moving area in this file.** Several states now ban AI systems providing professional mental or behavioural health services outright, and some ban the marketing language itself **[V]**. Others require disclosure, crisis protocols, and minor safeguards, and at least two create a private right of action **[V]**.
- **Safe subset:** journalling, mood tracking, psychoeducation, guided exercises, explicit "not therapy, not a therapist" framing, crisis resources surfaced on risk detection, no clinical claims.
- **Red line:** "AI therapist", "AI counselor", presenting as a licensed professional, delivering treatment, or making clinical decisions.

**Reproductive-health data** — no federal ban, but consumer-health-data laws (one with a private right of action) and state AG enforcement make period and fertility data among the highest-risk data classes a small app can hold **[V]**. If you build one: no ad SDKs anywhere near it, no third-party analytics on health screens, separate consent for collection and for sharing, and a real deletion path.

**Health and supplement claims** need competent and reliable scientific evidence; disease claims are a separate regulated category **[V]**. Safe subset: describe features, cite sources, make no efficacy claims.

---

## 2. Legal, financial, and professional advice

**Unauthorized practice of law** — the line is *applying law to a specific person's specific facts* **[V]**. Explaining how a process works generally is information; generating a jurisdiction-specific filing strategy for this user's situation is advice. UPL is a criminal offence in some states.
- **Safe subset:** document automation with user-entered facts, general explainers, attorney review in the loop, clear "not legal advice" framing that matches what the product actually does.
- **Red line:** "AI lawyer", "we'll tell you what to file", selecting claims or defences for a user.

**Investment advice** — advising others about securities for compensation triggers adviser registration, federal or state depending on assets; **robo-advisers get no exemption** **[V]**. Unsubstantiated AI capability claims are an active enforcement priority.
- **Safe subset:** education, generic screening tools with no personalised recommendation, backtests clearly labelled and not presented as predictions.
- **Red line:** "AI picks stocks for you", personalised buy/sell recommendations, performance claims you cannot substantiate.

**Broker-dealer** triggers on transaction-based compensation, handling customer orders or funds, or matching buyers and sellers. **Insurance** quoting/binding needs producer licensing. **Tax preparation** needs a PTIN and e-file authorisation. Accounting and medical/psych advice are similarly gated **[V]**.

**Disclaimers do not cure any of this.** A "not financial advice" banner over a personalised recommendation engine is evidence of awareness, not a defence.

---

## 3. Money movement and crypto

**Holding or routing user funds** — taking custody, control, or transmission authority over value between two parties is money transmission: FinCEN MSB registration plus state licensing, and operating unlicensed is a **federal felony** **[V]**. This catches far more designs than people expect: marketplace escrow, a `balances` table users can transfer between, tip jars that settle later, wallet features, "hold the payment until the job is done".
- **Safe subset:** use a payment provider's managed model (Connect/Express-style) where the licensed entity holds and moves the funds and you never touch a balance. Never build your own ledger of user-owned fiat.
- **Red line:** custody of third-party funds, escrow, or peer-to-peer transfers on your own rails.

**AML/KYC/OFAC** — BSA obligations attach to MSBs, but **OFAC sanctions apply to every US person, including hobby projects and open-source maintainers**, with strict liability and no de-minimis exception **[V]**. Practical minimum for any product taking money globally: geoblock comprehensively sanctioned jurisdictions and screen against the SDN list.

**Crypto** — token issuance is presumptively a securities offering absent statutory clarity **[U]**, stablecoin rules are phasing in **[S]**, and in the EU the MiCA transitional period ended, so providing crypto-asset services to EU users without authorisation is unlawful **[V]**. Hosted DeFi front-ends are an enforcement target even where the protocol is not.

**Lending** needs state licences and triggers truth-in-lending disclosures; usury caps apply. **Gift cards and stored value** have their own regime. **Crowdfunding** and **prediction markets** are separately regulated, and prediction markets are the subject of active federal–state litigation **[U]**.

---

## 4. Gambling, contests, and game monetisation

The test is **prize + chance + consideration**. Remove one leg or you need a licence **[V]**.

- **Real-money gaming** requires state-by-state licensure that is not a small-dev path.
- **Sweepstakes** need genuinely no-purchase-necessary entry with an equal alternative method, official rules stating odds, prize value, eligibility and sponsor, and registration/bonding in some states above prize thresholds. Dual-currency "sweeps casino" mechanics drew a wave of state bans and cease-and-desists in 2025–2026 **[V]**.
- **Loot boxes and gacha** require probability disclosure in several jurisdictions and are treated as gambling in others; EU consumer authorities issued principles on in-game virtual currencies **[V]**. Allowing items to cash out crosses into gambling.
- **Skill contests** are a narrower exception than founders assume and are prohibited or restricted in some states.

**Red line:** cash prizes for gameplay, wagering on real-world events, or any cash-out from a chance-based mechanic, without a licence.

---

## 5. Children, education, vulnerable users

**COPPA** requires verifiable parental consent before collection for child-directed services or on actual knowledge of an under-13 user, plus direct notice, deletion rights, and no conditioning participation on unnecessary data **[V]**. See `us.md` §3 for the amended-rule specifics.

**School-facing ed-tech** adds FERPA's school-official framing, PPRA for surveys on protected topics, and state contract-mandating laws requiring specific data-security plans, parent bills of rights, and subcontractor terms **[V]**. Selling to a school without the required contract terms is a dead deal, not just a legal risk.

**Age assurance** — self-declared age is no longer sufficient in a growing number of contexts; adult content in particular now requires real age verification in roughly half of US states **[V]**, and platform/app-store age-signal laws impose duties on **developers**, not only stores **[V]**.

**Red line:** an AI companion marketed to minors with no age gate, no crisis handling, and no content restrictions.

---

## 6. Content, platforms, UGC

**DMCA safe harbour is conditional and easily forfeited.** You must register a designated agent with the Copyright Office (online, small fee, **renewal every 3 years**), publish the agent's contact on your site, implement a takedown and counter-notice workflow, and adopt and *actually enforce* a repeat-infringer policy **[V]**. Most small platforms fail the renewal and the enforcement, which are exactly the two facts a plaintiff checks.

**CSAM** — hosting user images creates a statutory duty to report apparent CSAM to NCMEC on actual knowledge, preserve the material for the statutory period, and **not** independently investigate it **[V]**. There is no size exemption.

**NCII / TAKE IT DOWN** — the notice-and-removal requirement is live since 19 May 2026: a plain-language process usable by non-users, removal of the content and known identical copies within **48 hours**, and published notice **[V]**. Non-compliance is trivially detectable — the absence of the published process is itself the violation.

**Deepfakes and voice cloning** — no federal replica right has passed **[S]**, but state right-of-publicity and digital-replica laws, plus NCII statutes, make cloning an identifiable voice or likeness without consent actionable **[V]**.
- **Red line:** "nudify"/"undress" tools, sexualised imagery of real people, or cloning a specific real person without documented consent. This is criminal territory, not a grey area — refuse.

**Music and audio** — playing recorded music needs both composition rights (mechanical and public performance) and a master licence; sync for video is separate **[V]**. Streaming-service licences do not transfer to your app.

**Moderation regimes** — the EU DSA, the UK Online Safety Act, and Australia's under-16 social-media restrictions all reach small services **[V]**. See `eu-uk.md` §4–5.

---

## 7. Decisions about people

- **Hiring** — bias-audit and notice regimes apply in some cities and states; some require an annual independent audit, a published summary, and advance candidate notice **[V]**.
- **Screening or scoring people** — assembling or evaluating consumer information for eligibility decisions makes you a **consumer reporting agency**: permissible purpose, maximum possible accuracy, dispute handling, and adverse-action notices **[V]**. "It's just an AI background check" does not escape this; it is the classic small-company FCRA class action.
- **Credit** — adverse-action notices must state **specific principal reasons**. A black-box model that cannot articulate reasons is itself the violation **[V]**.
- **Housing and insurance** — disparate-impact exposure and rating regulation apply regardless of intent.
- **EU** — these are Annex III high-risk categories under the AI Act, with obligations from 2 Dec 2027 (Reg 2026/1744) **[V]**.

---

## 8. Other gated verticals

Firearms and ammunition (licensed dealing; publishing certain files raises export-control issues) · alcohol, tobacco, vape (licensing plus shipping-reporting regimes) · cannabis (federally prohibited, so processors, banks and app stores refuse regardless of state law) · online pharmacy (licensure plus valid prescriptions) · dating apps (state safety-disclosure laws) · debt collection · private investigation · background checks · drones (registration and remote ID) · autonomous systems · **export controls** on encryption, model weights and hardware **[U]** · lead generation and robocalling (consent and DNC, with state private rights of action).

---

## 9. Data sourcing legality

- **Scraping public pages** — the federal anti-hacking statute is largely off the table for genuinely public pages with no authentication, leaving contract (ToS), trespass-to-chattels, and copyright/database-right theories **[V]**.
- **Authenticated scraping revives that exposure** — logging in and scraping is a materially different legal act. Treat "we scrape LinkedIn" as a stop-and-discuss.
- **Personal data in scraped sets** — publishing data publicly is not consent under EU law; you need a documented lawful basis, and machine-readable text-and-data-mining opt-outs must be honoured **[V]**.
- **Training on user content** — needs its own lawful basis, notice, and usually opt-in; retrofitting it into an existing product via a terms update is a classic enforcement trigger.
- **Dataset licences** — many public datasets are research-only. Check before commercial use.

---

## RED FLAG PHRASE TABLE

Product descriptions or code signals → regime → the one-line warning to show the user.

| User says / code shows | Regime | Warning |
|---|---|---|
| "let users send money to each other", a `balances` table + transfer endpoint | State money transmitter licensing + federal MSB registration | Holding or routing other people's funds is licensed money transmission, and unlicensed operation is a federal felony. Use a licensed provider's managed model instead. |
| "escrow until the job is done" | Money transmission / escrow licensing | Escrowing third-party funds is a licensed activity in most states. Route through a licensed processor. |
| "AI doctor", "diagnoses", "tells you what's wrong" | FDA device / EU MDR Rule 11 | Diagnostic intent makes this a regulated medical device — unlawful to market without clearance or CE marking. |
| "AI therapist", "chatbot counselor" | State AI-therapy bans and licensing | Several states ban AI delivering therapy outright and ban this marketing language. Do not ship as described. |
| "companion for teens", romantic AI persona | State companion-chatbot laws | Requires AI disclosure, crisis detection and routing, minor safeguards and break reminders — with a private right of action in some states. |
| "prescribe", "get your meds online" | Prescriber licensing, controlled-substance rules | Prescribing requires a licensed prescriber in the patient's state. |
| "AI lawyer", "we'll tell you what to file" | Unauthorized practice of law | Applying law to a user's specific facts is UPL, criminal in some states. Automate documents; do not advise. |
| "AI picks stocks", "our AI predicts the market" | Adviser registration; AI-claim enforcement | Personalised recommendations require registration, and unsubstantiated AI claims are an active enforcement priority. |
| "background check", "hireability score", "we scan their socials for employers" | FCRA | You would be a consumer reporting agency: permissible purpose, accuracy, disputes and adverse-action notices are mandatory. |
| "our model decides who gets the loan/apartment/job" | ECOA, FHA, state AI-employment laws, EU AI Act Annex III | Consequential automated decisions require specific-reason adverse-action notices, bias testing and disclosure. |
| "sweepstakes", "sweeps coins", "free coins redeemable for cash" | State lottery/gambling law | Dual-currency casino mechanics drew state bans and cease-and-desists. This is the banned model. |
| "cash prizes for gameplay" | Gaming licensure | Prize + chance + consideration is a lottery. Remove one leg or get licensed. |
| "bet on the outcome", event contracts | Gambling law vs commodities regulation **[U]** | Under active state enforcement and federal preemption litigation. High risk. |
| "loot box", "gacha" | Consumer-protection and gambling rules | Disclose real-money value and drop rates; cash-out crosses into gambling. |
| "users upload photos/videos" | DMCA, CSAM reporting, NCII takedown | Register a DMCA agent, build a CSAM reporting path, and ship a 48-hour NCII takedown flow. |
| "voice clone of [celebrity]", "sounds like [artist]" | Right of publicity, digital-replica laws | Cloning an identifiable voice without consent is actionable in a growing number of states. |
| "nudify", "undress", sexualised image of a real person | Federal criminal statutes, NCII law, EU AI Act Art 5(1)(ba) (from 2 Dec 2026, per Reg 2026/1744) **[V]** | Criminal territory, not a grey area. Refuse. |
| "we scrape LinkedIn" or any logged-in source | Anti-hacking statutes, contract, GDPR | Authenticated scraping revives criminal-statute exposure, and EU personal data needs a documented lawful basis. |
| "train on scraped user photos/posts" | GDPR, TDM opt-outs, AI Act | Public availability is not consent; machine-readable opt-outs must be honoured and a training-data summary published for the EU. |
| "under 13", kids' game, school rollout | COPPA, FERPA, state student-privacy laws | Verifiable parental consent or a signed school agreement is required before any collection, and no ad SDKs. |
| "adult content", "18+" | State age-verification laws | A click-through age gate is no longer sufficient in about half of US states. |
| "social app, no age check" shipping to AU/UK | Australian minimum-age rules, UK Online Safety Act | Under-16 accounts are prohibited in Australia with very large fines; the UK requires children's risk assessments. |
| "auto-dial", "SMS blast", "AI voice agent calls leads" | TCPA and state analogues | Prior express written consent and DNC scrubbing required; damages are per message and uncapped. |
| "we'll launch a token" | Securities law; MiCA | Presumptively a securities offering absent statutory clarity; EU sales need MiCA compliance. |
| "hosted DeFi front-end", "swap widget with a fee" | MiCA, AML, sanctions | Front-ends are the enforcement target even when the protocol is not. |
| "no geoblocking, available worldwide" | Sanctions (strict liability) | Sanctions apply to hobby projects. Block comprehensively sanctioned jurisdictions and screen the SDN list. |
| "export our model weights", chip resale | Export controls **[U]** | Get an export-control read before shipping weights or hardware. |
| "background music from Spotify/YouTube" | Music licensing | Streaming licences do not transfer to your app; you need composition and master rights, plus sync for video. |

---

## How to deliver a gate finding

Lead with the conclusion, then the safe subset, then the question that would change the answer:

> **This crosses into licensed territory.** Letting users hold balances and send each other money is money transmission — that needs state licences and federal registration, and operating without them is a federal crime, not a fine. What I *can* build today is the same marketplace using [provider]'s managed accounts, where the licensed entity holds the funds and you never touch a balance — same user experience, no licence. If you already hold licences or have counsel advising on this, tell me and I'll build the direct version.

Never build the gated version silently, never bury the warning at the end of a long report, and never soften it into "you may want to consider consulting a lawyer".
