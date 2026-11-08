# Artifacts

What each required document or flow must actually contain, as a skeleton to generate against. Snapshot **11 Aug 2026**, spot re-verified 3 Oct 2026 (see `provenance.md`).

**Rule for every document here:** generate it with `[PLACEHOLDER]` fields for facts only the user has, never invent entity names, addresses, retention periods, or vendor lists, and mark the output as a template that needs review. State plainly which artifacts a competent developer can safely template and which genuinely need a lawyer.

| Artifact | Safe to template | Needs a lawyer |
|---|---|---|
| Privacy policy | Yes, if it is generated *from the actual data map* | If sensitive data, children, health, or ad-tech sharing is involved |
| Cookie/consent implementation | Yes — this is engineering | No |
| DSAR/DSR flow | Yes | No |
| Accessibility statement | Yes | No |
| AI disclosures | Yes | If high-risk classification is arguable |
| Email/SMS compliance | Yes | No |
| Terms of service | Skeleton only | **Yes** — liability, indemnity, arbitration, and consumer-law limits are where templates fail |
| DPAs, transfer documentation | Sign the vendor's | If you are the processor offering one |
| Anything sector-gated | No | **Yes** |

---

## 1. Privacy policy

Generate it **from the code's data map**, not from a template. A policy that describes processing the app does not do is itself the violation — the deception theory is the most commonly enforced privacy failure for small companies.

**Section skeleton**

1. **Who we are** — legal entity name, trading name, postal address, contact email. Plus EU and UK representatives if applicable, and a privacy contact.
2. **What we collect** — by category, tied to source: provided by you, collected automatically, received from third parties. Include online identifiers (IP, device ID, cookie ID) — omitting them is the most common gap.
3. **Why, and on what legal basis** — purpose by purpose, with the lawful basis for each (EU/UK) and the business purpose (US).
4. **Who we share it with** — **name the recipients**, or at minimum name categories plus a linked subprocessor list. Include processors, analytics, ad platforms, payment, hosting, support, and AI vendors.
5. **Selling / sharing / targeted advertising** — an explicit statement, and if yes, the opt-out link and how you honour opt-out preference signals.
6. **Retention** — per category, with a period or the criteria used. California requires per-category retention.
7. **Your rights and how to exercise them** — the full list for each applicable regime, the intake methods (two for California), the response deadline, the appeal route (required in several US states), and the authorized-agent route.
8. **International transfers** — destinations, mechanism, and how to obtain a copy of safeguards.
9. **Children** — your actual age policy and what happens on discovery of an underage user.
10. **Security** — describe the measures truthfully and generically; do not promise what you have not built.
11. **Automated decision-making** — meaningful information about the logic and consequences, if any.
12. **Changes** — how you notify, and the effective date.
13. **Complaints** — supervisory-authority route for EU/UK users.
14. **Effective date and last-updated date.**

**Fatal mistakes**
- A copied template naming the wrong company (regulators and plaintiffs check this first).
- Promising encryption, deletion, or "we never share your data" that the code contradicts.
- No effective date, or one that is years stale — annual review is expected.
- Listing rights that you have no mechanism to fulfil.
- No postal address.
- A separate "cookie policy" that contradicts the main policy.
- For consumer-health data in some states, a **separate, distinctly-linked** health-data policy is required — burying it in the main policy is non-compliant.

---

## 2. Terms of service

**Essential clauses:** acceptance mechanics; licence grant and restrictions; acceptable use; user-content licence (narrow, purpose-limited); payment, refund, and auto-renewal terms; disclaimers; limitation of liability; indemnity; termination; governing law and venue; dispute resolution; and how terms change.

**Acceptance mechanics decide enforceability.** Clickwrap — an affirmative click on a control adjacent to conspicuous linked terms — is routinely enforced; browsewrap with a footer link routinely is not. Implement:

```
[ ] I agree to the Terms of Service and Privacy Policy   ← unchecked by default, links live
Store: user_id, timestamp, terms_version, ip, the exact text shown (or its hash)
```

Without that stored record you cannot prove assent, which is what defeats an arbitration clause when you most need it.

**Changes-to-terms:** notice plus continued-use acceptance is weak for material changes. For material changes, re-prompt for affirmative acceptance and version the record.

**EU/UK consumer limits:** blanket liability exclusions, unilateral changes without notice and an exit right, foreign exclusive-jurisdiction clauses, and mandatory arbitration with class waivers are unenforceable against consumers and can themselves be violations. **Do not ship one global ToS copied from a US template to EU consumers** — branch the consumer terms or accept that the offending clauses are void.

---

## 3. Consent and preference infrastructure

The banner is engineering, not legalese. Required behaviour:

- **Prior blocking.** No non-essential script, pixel, iframe, or beacon executes before an affirmative choice. Enforce it in the tag manager or loader, and verify with a test asserting zero third-party requests on first paint.
- **Granular purposes** — at minimum necessary / functional / analytics / advertising, individually togglable.
- **Reject parity** — a reject-all control at the first layer, same prominence and same click count as accept-all.
- **No pre-ticked boxes**, no "continue browsing means consent", no cookie wall without a genuine alternative.
- **Withdrawal** as easy as granting: a persistent control (footer link or floating button) that reopens preferences.
- **Consent record**: `{subject_id/device_id, timestamp, purposes granted, policy_version, banner_version, method, evidence_of_text_shown}` retained for the life of the processing plus a limitation period.
- **Expiry and re-ask** on a bounded cadence.
- **Consent Mode v2** where Google tags are used: default `denied` for ad and analytics storage, updated on the user's choice.

**Global Privacy Control / universal opt-out:**

```
Detect: Sec-GPC: 1 request header, and navigator.globalPrivacyControl in the client.
Effect: treat as an opt-out of sale/share and targeted advertising for that user/device.
Timing: apply BEFORE any ad tag loads on the same page view.
Persist: server-side against the user record; do not rely on a cookie alone.
Disclose: state in the privacy policy that you honour it.
```
Honour it for all visitors regardless of state — it satisfies the strictest requirement and violates none.

---

## 4. Data subject / consumer rights flow

Minimal architecture a one-person team can operate:

```
Intake:   /privacy/request form + privacy@ inbox (two methods where required)
Queue:    dsar_requests table: id, type, subject, received_at, due_at, status, verification_state, notes
Verify:   proportionate identity check for access/deletion/correction.
          NEVER verify identity for an opt-out — opt-outs must be frictionless.
Fulfil:   export (machine-readable, portable), delete (propagate), correct, opt-out (propagate)
Appeal:   /privacy/appeal endpoint + separate queue (required in several US states)
Log:      every request, decision, and date — this is your evidence
```

**Deadlines:** 45 days extendable by 45 (US states); one month extendable by two (EU/UK). Set `due_at` on intake and alert before it.

**Deletion propagation is where implementations fail.** A `DELETE FROM users` is not deletion. Enumerate and handle: primary database, replicas, **backups** (document the rolling-expiry approach — deletion on restore is acceptable if documented), analytics platforms, CRM and support tools, email/SMS provider, error tracker and logs, data warehouse, search index, CDN caches, and **LLM vendor retention**. Write the propagation as a checklist in the runbook and as code where possible.

**Opt-out propagation:** severing an ad pixel must also push a suppression/deletion signal to the ad platform's API — stopping the tag alone leaves the data with them.

---

## 5. Records and governance

- **Record of processing (`ropa.yaml`)** — per purpose: data categories, subject categories, recipients, transfers and mechanism, retention, security measures, lawful basis.
- **Assessment (DPIA / data-protection assessment)** — trigger, description of processing, necessity and proportionality, risks to individuals, mitigations, residual risk, decision, date, reviewer. Required for risky profiling, sensitive data, targeted ads, and often for LLM features.
- **Legitimate-interest assessment** — purpose test, necessity test, balancing test, opt-out offered.
- **Vendor register** — vendor, purpose, data categories, region, DPA signed (date/link), subprocessors, transfer mechanism, BAA if health data.
- **Retention schedule** — per data class, with the deletion job that enforces it.
- **Breach runbook** — detection, triage, severity criteria, the notification clocks side by side (72h EU/UK supervisory authority; state deadlines including short fixed clocks; sector rules), notification templates, evidence preservation, and a post-incident review. Pre-write the templates: nobody drafts well at hour six.

**Vendor DPAs:** most major infrastructure, analytics, email, error-tracking, and AI vendors publish a self-serve DPA — some require explicit acceptance in the dashboard rather than applying automatically. Verify per vendor rather than assuming; record the date and link. Health data additionally needs a BAA, which far fewer vendors offer — check before designing.

---

## 6. Accessibility statement

Contents: conformance target (e.g. WCAG 2.2 AA), scope (which URLs/apps), known limitations with plain descriptions and planned fixes, feedback mechanism with a real contact and a response commitment, the assessment method and date, and any enforcement/complaint route required in your jurisdiction. For enterprise or public-sector sales, a VPAT/ACR is the expected artifact.

Do not publish a conformance claim you have not tested. Claiming conformance you do not have converts an accessibility problem into a deception problem.

---

## 7. AI disclosures

- **Chat surface:** a persistent, visible "You're chatting with an AI" indicator — not a one-time modal, not buried in terms.
- **Generated media:** embed machine-readable provenance (C2PA/Content Credentials manifests) plus a visible label where the content could be mistaken for real. Preserve provenance through your processing pipeline; naive re-encoding strips it.
- **Deepfakes and AI-published text on matters of public interest:** visible label at first exposure.
- **Emotion recognition or biometric categorisation:** inform the people exposed to it.
- **Companion/emotional AI:** AI disclosure, crisis-detection and resource routing, minor-mode restrictions, session-break reminders, and retained protocol documentation.
- **AI usage terms:** who owns inputs and outputs, whether user data trains models (state it accurately), human-review practices, and accuracy limitations.
- **Internal:** a one-page AI-use policy plus a dated training record (satisfies the EU AI literacy duty proportionately), and a one-page system description recording model provider, purpose, limitations, oversight path, and your provider-vs-deployer determination.

---

## 8. Email and SMS in code

**Email**
- Accurate headers and non-deceptive subject lines.
- A **valid physical postal address** in every commercial message.
- A working unsubscribe, honoured within the statutory window, functional for a period after send.
- `List-Unsubscribe` and `List-Unsubscribe-Post` one-click headers for bulk senders, plus SPF, DKIM and DMARC alignment — mailbox providers enforce these independently of law, and failing them costs deliverability before it costs a fine **[S]** on current thresholds.
- Keep spam complaint rates low; monitor them.
- Separate transactional from marketing sends in code so an unsubscribe never suppresses a password reset and a marketing blast never bypasses suppression.

**SMS**
- One `canSend()` chokepoint owning the provider credentials.
- Consent record capturing the exact disclosure text shown, timestamp, and source.
- Suppression list processed on any opt-out keyword received on any channel.
- Quiet hours enforced in the **recipient's** timezone.
- Carrier campaign registration before sending.

**Canada** requires express opt-in with prescribed identification and unsubscribe content; **EU/UK** allow a narrow soft opt-in for existing customers of similar products only. Cold B2C email to EU/UK consumers without consent is not lawful.

---

## 9. App store gates

**Apple:** accurate privacy nutrition labels matching actual behaviour; App Tracking Transparency prompt before any tracking identifier use; privacy manifests and declared reasons for restricted APIs, including for third-party SDKs; **in-app account deletion** where accounts are offered; correct age rating; kids-category restrictions; and trader-status declaration for EU distribution.

**Google Play:** Data safety form matching actual behaviour; account deletion available in-app **and** via a web URL; families policy compliance; justification for sensitive permissions; EU trader information.

**Most common legal-flavoured rejections:** privacy labels that contradict observed network traffic, missing account deletion, missing privacy policy URL, tracking without ATT, and kids apps carrying ad or analytics SDKs. Verify the current requirements in the platform's live documentation before shipping — these change frequently **[S]**.

---

## 10. Business basics (flag, do not draft)

Entity formation and the personal-liability exposure of trading without one; contractor IP assignment (without it, your contractor may own the code); trademark clearance for the product name before you build a brand on it; errors-and-omissions and cyber insurance; and the reality that individuals can be named personally in some privacy and consumer claims. These are business decisions to surface in the register under **Needs a lawyer**, not documents to generate.
