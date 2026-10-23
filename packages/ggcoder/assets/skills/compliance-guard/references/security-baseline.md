# Security Baseline

## Contents
- PRE-DEPLOY BLOCKERS
- Why AI-generated code fails here specifically
- Security depth lives in the bulletproof skill
- Payments
- Data handling that maps to legal duties
- Incident readiness
- AI features: the compliance side
- Assurance for B2B sales


Security is the fastest route from "small app" to "regulatory incident": a breach triggers notification duties, class actions in states with a breach private right of action, and the deception theory that your privacy policy promised protection you did not provide. This file is the pre-deploy floor, weighted toward the failure modes that AI-generated and rapidly built apps produce most often.

Snapshot **11 Aug 2026**, spot re-verified 3 Oct 2026 and 22 Oct 2026 (see `provenance.md`). Verify version numbers and vendor terms before asserting them.

---

## PRE-DEPLOY BLOCKERS

Do not ship with any of these unresolved. Each is P0.

1. **Secrets in the client or the repo.** Any API key, service-role key, database URL, or private key present in a client bundle, a `NEXT_PUBLIC_*`/`VITE_*` variable, committed `.env`, or git history. Fix: move server-side, rotate the exposed value (rotation is mandatory — history is public forever), add `.env*` to `.gitignore`, add a secret scanner to CI, purge history if the repo is public.
2. **Row-level security or equivalent not enabled** on any table reachable by a client SDK (Supabase, Firebase, PocketBase, direct PostgREST). Default-deny, then add policies per table. Verify by querying as an anonymous user, not by reading the dashboard.
3. **Service-role / admin key reachable from the browser or an edge function that any user can call.** This bypasses every policy you wrote.
4. **Authorization enforced only in the UI or only on the route.** Every read and write must check *this user may act on this object* server-side, at the data layer. Broken object-level authorization is the most common serious defect in generated code: `/api/orders/:id` returning any id, `PATCH /users/:id` accepting an arbitrary id, an `isAdmin` check that lives only in a React component.
4a. **Defaults that grant instead of deny.** Any column, flag, or config whose default hands out access, verification, or entitlement without anyone checking: `is_verified DEFAULT TRUE`, `is_adult_verified DEFAULT TRUE`, `role DEFAULT 'admin'`, `plan DEFAULT 'pro'`, `approved BOOLEAN DEFAULT TRUE`, a permissive fallback in `getEnv("MODE", "debug")`. These read as harmless schema lines and silently defeat the entire control they belong to — an age gate whose column defaults to verified is not an age gate. Grep every `DEFAULT TRUE`, `DEFAULT 'admin'`, and default-valued boolean in the schema, and ask what it authorises before anyone acts.

4b. **Tenant isolation derived from client input.** In any B2B or multi-tenant product, a handler that takes `org_id`, `employer_id`, `workspace_id`, `account_id` or similar **from the request** and filters on it lets any customer read another customer's records by changing one value. The tenant must come from the authenticated session or token, never from a parameter. Enforce it once — a session-level filter, a policy, or a repository wrapper — not per route, and test it by authenticating as tenant A and requesting tenant B's id.
5. **Mass assignment.** Spreading a request body into a create/update (`{...req.body}`, `Object.assign(user, body)`, `prisma.user.update({data: body})`) lets a user set `role`, `is_admin`, `credits`, `plan`, or `stripe_customer_id`. Fix: explicit allow-listed field mapping or a strict schema with unknown-key rejection.
6. **String-built queries.** Any SQL, NoSQL filter, or ORM raw call assembled by concatenation or template literal from user input. Use parameterised queries everywhere, no exceptions.
7. **Unauthenticated internal endpoints.** Cron routes, webhooks, admin actions, migration or seed endpoints, debug routes, `/api/dev/*`, and server actions with no auth check. Webhooks must verify the provider's signature; cron routes must verify a shared secret.
8. **Publicly writable or listable storage buckets.** Signed URLs with sane expiry; no public write; no directory listing; validate content type and size server-side; never trust the client-supplied filename or MIME.
9. **No rate limiting on anything expensive or abusable** — auth, password reset, signup, search, file upload, and every LLM call. Absence produces credential stuffing, enumeration, and unbounded vendor bills.
10. **Password storage that is not a modern memory-hard hash** (argon2id or bcrypt/scrypt with adequate parameters). Never MD5/SHA-family, never unsalted, never encryption-instead-of-hashing. Or drop passwords entirely for an identity provider or passkeys.
11. **Session cookies without `HttpOnly`, `Secure`, and `SameSite`**, or tokens stored in `localStorage` where XSS can read them, or sessions that never expire and are not invalidated on password change.
12. **JWT verification that trusts the token** — `decode` instead of `verify`, algorithm not pinned, `none` accepted, no expiry check, secret shared with the client.
13. **CORS `*` combined with credentials**, or an origin reflected from the request header.
14. **Card data touching your systems.** PAN, CVV, or full track data in your database, your logs, or your error tracker. Use hosted fields or hosted checkout so the data never reaches your origin.
14b. **Financial and identity columns stored in the clear.** `payout_iban`, `bank_account`, `routing`, `tax_id`, `ssn`, `national_id`, `passport`, `government_id` sitting in a table with no encryption, no restricted access path, and no retention rule. They look like ordinary text columns and are routinely written that way; a breach involving them is materially worse than one involving emails, and several regimes treat them as their own category.
15. **PII in logs and error trackers** — request bodies, headers with tokens, full user objects, prompts containing user data. Scrub at the transport, set retention, sign the vendor DPA.
16. **No transport security or mixed content** — HTTPS everywhere, HSTS, secure cookies, no `http://` asset loads.
17. **SSRF in any server-side fetch of a user-supplied URL** (image import, webhook test, link preview, RSS, "fetch my site"). Allow-list schemes and hosts, block private/link-local ranges and metadata endpoints, disable redirects to internal addresses.
18. **No backup, or an untested restore.** Data loss is the incident nobody calls a breach and everybody suffers.

---

## Why AI-generated code fails here specifically

Generated code optimises for a working happy path. The recurring gaps, in rough order of frequency:

- Authorization is written as UI conditionals, not data-layer policy.
- Database-level security is left at the framework default, which is often permissive for client SDKs.
- Convenience keys (service role, admin tokens) get wired into wherever made the demo work.
- Input validation exists at the form, not at the API boundary.
- Error handling leaks stack traces, queries, and internal paths to the client.
- Rate limits, quotas, and abuse controls are simply absent.
- Dependencies are added freely, including hallucinated or typosquatted package names.
- Secrets end up in whichever file the example used.

Academic and vendor studies through 2024–2026 consistently find a substantial share of LLM-generated code samples contain a known weakness **[S]** — treat the prevalence as directionally real and the specific percentages as unverified.

**Review heuristic:** for every table, ask "who can read this row, who can write it, and where is that enforced?" For every endpoint, ask "what happens if I change the id to someone else's?" Those two questions find most of it.

---

## Security depth lives in the bulletproof skill

Supply chain, authentication and account recovery, prompt injection, agent tool permissions, sandboxing, and abuse limits are covered in depth by the separate **bulletproof** skill. Load it for any fix beyond a blocker above; do not duplicate it here. The compliance-specific residue:

- **Licence scan** in the same CI step as vulnerability scanning; fail on copyleft and unknown (see `lawsuit-vectors.md` §6).
- **Hallucinated or typosquatted packages** ("slopsquatting") are a supply-chain incident with breach-notice consequences; verify every new package name.

## Payments

- Use hosted fields/checkout from your processor so PAN never touches your origin. This is what keeps your PCI scope minimal.
- PCI DSS v4.0.1 is the only active version (v4.0 retired 31 Dec 2024), and all 51 formerly future-dated requirements have been mandatory since **31 March 2025**, with no remaining grace period **[S]**. For web checkouts the ones that bite are 6.4.3 (inventory, authorise and integrity-check every script on the payment page) and 11.6.1 (detect unauthorised changes to payment-page scripts and security headers) **[S]**. Confirm SAQ eligibility with your processor before advising: it differs between a fully hosted redirect and embedded fields/iframes.
- Verify webhook signatures; make handlers idempotent; never grant entitlements from a client-side success callback.
- Reconcile: entitlement state must derive from the processor's record, not from your optimistic write.
- Store only the processor's customer/payment-method reference, never card data.

---

## Data handling that maps to legal duties

- **Encryption** in transit always; at rest via managed disk/db encryption plus column-level encryption for sensitive categories.
- **Minimisation** — every column you do not collect is a column you cannot leak, cannot be asked to delete, and cannot be sued over. This is the highest-leverage privacy control that exists.
- **Retention** — a documented schedule per data class, implemented as a scheduled job, not a policy sentence. Include logs, analytics, backups, email provider, CRM, and LLM vendor retention.
- **Deletion propagation** — deletion that leaves the row in backups, the analytics warehouse, the email tool, and the vendor's logs is not deletion. Document the realistic backup-expiry approach rather than claiming instant erasure.
- **Access logging** for administrative access to user data.
- **"Reasonable security"** is the legal standard in most US enforcement: the failures above are what regulators cite. Meeting this list is most of it.

---

## Incident readiness

- Know your clocks before you need them: EU/UK supervisory-authority notification runs on a short deadline from awareness **[V]**; US state deadlines vary and several require attorney-general notice above thresholds; sector rules add their own.
- Keep an incident runbook: who decides, how to contain, how to preserve evidence, notification templates, and a contact list.
- Preserve logs long enough to reconstruct an event — 30 days is often too short.
- Do not publicly characterise scope before you know it.

---

## AI features: the compliance side

Prompt injection, tool scoping, sandboxing and cost limits: load **bulletproof**. What stays a legal duty here:

- **PII into prompts** — redact what you can, name the vendor in the privacy notice, sign its DPA, prefer zero/limited-retention endpoints. Business/API and consumer tiers of the same vendor often differ on training and retention **[S]**; verify the specific endpoint's terms before telling a user their data is not trained on.
- **Prompt and output logs** often hold the most sensitive data in the system; their retention belongs in the retention schedule.
- **Unbounded per-user LLM spend** is also blocker 9 (rate limits); record it in the ledger, not only as a cost issue.

---

## Assurance for B2B sales

Only when a buyer demands it: SOC 2 Type II or ISO 27001 are months and meaningful cost; a security questionnaire answer pack, a public trust page, a pen-test report, and a VPAT cover most early enterprise deals. Do not start a certification because it feels responsible — start it because a deal requires it.
