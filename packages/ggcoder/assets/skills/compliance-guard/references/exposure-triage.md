# Exposure Triage

## Contents
- 1. Reach — can a stranger touch this?
- 1b. Translate the signatures to the stack in front of you
- 2. Personal data inventory
- 3. Third-party recipients
- 4. Money
- 5. Decisions about people
- 6. User-generated content
- 7. Messaging
- 8. AI surface
- 9. Domain signal scan
- 10. Jurisdiction inference
- 11. Question set (max five, batched, with defaults)
- 12. Proportionality rule


Determine what the product actually is before deciding what applies. Everything here is code-observable; do not ask the user what the repo can answer.

## 1. Reach — can a stranger touch this?

Obligations scale almost entirely with reach. Establish it first.

| Class | Signals | Baseline exposure |
|---|---|---|
| **Local-only** | CLI, no server, no network calls with user data, no deploy config, no telemetry | Near zero. Licence hygiene and secrets hygiene only. Do not generate a compliance program. |
| **Internal / self-hosted, no third parties** | Docker compose for one org, no public DNS, SSO to one tenant | Security baseline, employment/monitoring rules if it watches staff, vendor terms |
| **Private beta / invite-only** | Auth required, invite table, no public signup | Full privacy stack applies to real users; volume-threshold laws mostly do not |
| **Public app** | Open signup, public marketing page, app-store listing | Everything in `trigger-map.md` |
| **Public + UGC** | Uploads, comments, profiles, messaging | Adds intermediary/safe-harbour, CSAM, NCII, moderation duties |
| **Public + money** | Checkout, subscriptions, payouts | Adds payments, auto-renewal, tax, consumer law |

Deploy signals: `vercel.json`, `netlify.toml`, `fly.toml`, `render.yaml`, `app.yaml`, `wrangler.toml`, `Procfile`, Dockerfile with exposed ports, Terraform/Pulumi with public ingress, GitHub Actions deploy jobs, `CNAME`, custom-domain config, `robots.txt`, sitemap, `apple-app-site-association`, `.well-known/assetlinks.json`, Fastlane, EAS config, `Info.plist`, `AndroidManifest.xml`.

Absence of deploy config does not prove absence of a deployment. If it looks like a web app, ask.

## 1b. Translate the signatures to the stack in front of you

The greps in this file lean JavaScript because that is what most of these apps are built in. **They are examples of a pattern, not the pattern itself.** Before concluding "not applicable", restate the signature in the project's own idiom:

| Signature | JS/TS | Python | Ruby | Go / Rust / PHP / mobile |
|---|---|---|---|---|
| Dependency manifest | `package.json`, lockfile | `requirements.txt`, `pyproject.toml`, `poetry.lock` | `Gemfile`, `Gemfile.lock` | `go.mod`, `Cargo.toml`, `composer.json`, `Podfile`, `build.gradle` |
| Secret leaked to the client | `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*` | hardcoded literal in source; a default in `os.environ.get("KEY", "sk-...")`; committed `settings.py` | mis-scoped credentials, hardcoded literal | `EXPO_PUBLIC_*`, `Info.plist`, `AndroidManifest`, strings compiled into a shipped binary |
| Injection sink | template literal in a query | f-string / `%` / `.format()` into `text()` or `execute()` | interpolation into `where("...")` | any concatenated query in any language |
| Missing object authorization | handler reading `params.id` | FastAPI/Flask/Django view trusting a query or body field | controller trusting `params[:id]` | any handler trusting a client-supplied id |
| Mass assignment | `{...req.body}` spread | `Model(**payload)`, `setattr` loops, unrestricted serializer | `update_attributes(params)` without strong params | any bulk bind of request data to a model |
| Licence/vuln scanning | `npm audit`, licence checker | `pip-audit`, `pip-licenses` | `bundler-audit` | `govulncheck`, `cargo audit`, `cargo deny` |
| Tracking/tags | `<script src>`, tag manager | server-rendered template blocks, or a separate frontend repo | ERB/HAML layouts | native SDK init in the app delegate |

**If the repo is backend-only, say so and check whether a separate frontend exists** rather than silently reporting the tracking and accessibility sections as clean. "No frontend in this repo" and "no frontend in this product" are different findings, and only the second one is good news.

## 2. Personal data inventory

Grep the schema, not the prose. Look at migrations, ORM models, Zod/Pydantic schemas, form components, and event payloads.

```
# identity & contact
email|phone|mobile|first_?name|last_?name|full_?name|address|postcode|zip|dob|date_of_birth|ssn|national_id|passport|driver
# online identifiers (these ARE personal data in the EU/UK and most US state laws)
ip_?address|user_?agent|device_?id|advertising_?id|idfa|gaid|fingerprint|cookie_?id|session_?id
# location
lat|lng|latitude|longitude|geo|coords|precise_location|geofence
# special categories / sensitive
health|medical|diagnos|symptom|prescription|patient|therapy|mental|cycle|period|fertility|pregnan
biometric|face_?(embedding|descriptor|template|encoding)|voice_?(print|embedding)|fingerprint_template|iris|gait
race|ethnic|religio|politic|union|sexual|orientation|gender_identity|immigration|criminal|conviction
genetic|dna|genome
# financial
card|pan|cvv|iban|routing|account_number|balance|ledger|payout|tax_id
# minors
age|birthday|minor|child|parent_consent|guardian|grade|school|student
```

Classify each hit into: **basic** (name/email), **identifier** (IP/device/cookie), **sensitive** (health, biometric, precise location, sexual life, race, religion, union, immigration, criminal, genetic, financial account), **children's**, **credential**. Sensitive and children's data change the legal analysis more than volume ever does.

Also record for each class: where it is stored, who it is sent to, how long it is kept, and whether deletion actually removes it. Most vibe-coded apps have no answer to the last two — that gap *is* a finding.

## 3. Third-party recipients

Every external call is a disclosure. Enumerate exhaustively — this is the single highest-yield sweep for litigation risk.

```
# tags & trackers
googletagmanager|google-analytics|gtag|analytics\.js|connect\.facebook\.net|fbq\(|fbevents
tiktok.*analytics|ttq\.|snap.*sc-static|pinterest.*pintrk|linkedin.*insight|_linkedin_partner
clarity\.ms|hotjar|fullstory|logrocket|smartlook|mouseflow|inspectlet|quantummetric|heap|mixpanel|amplitude|segment|posthog|plausible|fathom|matomo
# chat & support widgets (a wiretap-claim magnet)
intercom|drift|zendesk|tawk|crisp|livechat|hubspot|freshchat|olark
# infra & vendors
sentry|datadog|bugsnag|rollbar|newrelic|cloudflare|vercel|supabase|firebase|auth0|clerk|stripe|paddle|lemonsqueezy
resend|sendgrid|postmark|mailgun|twilio|vonage|onesignal|expo-notifications
openai|anthropic|googleapis.*generativelanguage|bedrock|azure.*openai|replicate|huggingface|elevenlabs|deepgram|assemblyai
# fonts & assets loaded cross-origin
fonts\.googleapis|fonts\.gstatic|cdnjs|unpkg|jsdelivr
```

For each: what data does it receive, is it a processor or an independent controller, is there a signed DPA, and does it fire before consent? Cross-origin Google Fonts alone has produced German damages awards; ad pixels firing pre-consent are the top demand-letter fingerprint in `lawsuit-vectors.md`.

## 4. Money

```
stripe|paddle|lemonsqueezy|braintree|adyen|paypal|razorpay|square|revenuecat|chargebee|recurly
subscription|plan_id|price_id|trial|renew|invoice|refund|payout|wallet|balance|escrow|transfer|topup|credits
```

Distinguish: one-off purchase, **auto-renewing subscription** (adds ROSCA/state auto-renewal duties), **free trial converting to paid** (highest-risk pattern), **holding or routing user funds** (money-transmission analysis, see `sector-gates.md`), **paying users out** (tax reporting, KYC), **in-app currency or loot boxes** (consumer-protection scrutiny).

## 5. Decisions about people

Any code path that scores, ranks, filters, approves, denies, prices, or flags a human. Grep `score|risk|approve|reject|eligib|screen|rank|match|fraud|verify_identity|creditworth|applicant|candidate|tenant`.

If the output affects **employment, credit, housing, insurance, education, or access to essential services**, the analysis changes completely — see the automated-decision sections in `us.md` and `eu-uk.md`. An LLM in that path is still an automated decision system.

## 6. User-generated content

Uploads, comments, profiles, DMs, public feeds, file sharing, avatars. Grep `upload|multipart|presigned|s3\.|bucket|attachment|comment|post|message|thread|profile|avatar|report_abuse|moderat`.

If images or video can be uploaded by users, CSAM detection/reporting and NCII takedown duties attach in the US regardless of size — see `sector-gates.md` §6. If it is a service in the EU or UK, intermediary duties attach.

## 7. Messaging

Separate **transactional** (receipt, password reset, security alert) from **marketing/promotional** (newsletter, offers, re-engagement, "we miss you", abandoned cart). The legal treatment is completely different and most codebases blur them in one `sendEmail()`.

Grep for template names, campaign tables, `unsubscribe`, `List-Unsubscribe`, cron/scheduled sends, SMS providers, push topics.

## 8. AI surface

```
openai|anthropic|gemini|generativelanguage|bedrock|ollama|vllm|langchain|llamaindex|ai-sdk|streamText|createAgent|tool_choice|function_call
embedding|vector|pgvector|pinecone|qdrant|weaviate|chroma
diffusion|stable-?diffusion|dall-?e|midjourney|tts|voice_?clone|speech_?synth|avatar
```

Then classify:
- **AI-assisted internal tooling** — low external exposure.
- **User-facing chatbot** — disclosure duties (EU AI Act Art 50, several US state laws); companion/emotional framing pulls in far stricter rules.
- **Generated synthetic media** — marking/provenance duties.
- **AI in a consequential decision** — high-risk classification.
- **Agent with tools/code execution** — prompt-injection and sandboxing become security blockers, see `security-baseline.md`.
- **Training or fine-tuning on user data** — needs a lawful basis, notice, and usually opt-in; check vendor training terms.

## 9. Domain signal scan

Route names, table names, and README copy reveal the regulated domain faster than asking. Match against the red-flag phrase table in `sector-gates.md`. Any hit escalates immediately — the domain gate is evaluated *before* the privacy checklist, because if the product cannot lawfully exist as described, the cookie banner is irrelevant.

## 10. Jurisdiction inference

Do not assume the company's country limits exposure.

- **EU/UK in scope if**: the app is reachable from there and offers goods/services (any language/currency targeting, EU/UK addresses accepted, EUR/GBP pricing, EU-targeted marketing) or monitors behaviour of people there (analytics, ad tracking, profiling). Mere accessibility alone is weaker, but analytics on EU visitors is monitoring.
- **US state laws in scope by**: residents of that state using the service, subject to per-state thresholds — but several states have low or no thresholds, and California's threshold is met by ordinary ad-tech "sharing" more often than founders expect.
- **Geoblocking is a real control.** If the user wants to reduce scope, blocking signup by country/region at the edge (and enforcing it, not just hiding UI) is legitimate and should be offered as an option. Note that it must be enforced server-side and that IP geolocation is imperfect.
- **Sanctions screening is not optional** and applies to hobby projects: OFAC-restricted jurisdictions must be blocked for US persons.

## 11. Question set (max five, batched, with defaults)

Only ask what the repo cannot answer. Always state the default you will assume.

1. **Reach** — "Public signup, invite-only, internal, or just you?" *(default: public if a deploy target and open signup exist)*
2. **Geography** — "Which countries can sign up? Anything blocked today?" *(default: worldwide, nothing blocked → EU/UK/US all in scope)*
3. **Real data** — "Real users and real data, or test data only?" *(default: real if there is a production deploy)*
4. **Minors** — "Could under-18s (or under-13s) realistically use it? Any age gate?" *(default: no age gate present → treat general-audience unless the product is clearly workplace-only)*
5. **Entity** — "Company entity and country, or personal/no entity yet?" *(default: unknown → flag as a LAWYER item, do not fill in documents)*

Ask a sixth only if a domain gate fired and the answer determines legality (e.g. "do you hold a licence for X?").

## 12. Proportionality rule

Scale output to reach:

- Local-only / prototype with fake data → at most a short note: secrets, licences, and "here is what changes when you deploy".
- Private beta → security blockers, privacy notice, deletion path, vendor DPAs.
- Public launch → the full register.

Never produce a 60-item report for a project with no users. Findings nobody acts on are worse than none, because they teach the user to ignore the skill.
