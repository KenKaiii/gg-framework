# Attack Classes

What to look for, one section per audit in `audit-protocol.md` Phase 2. Each section stands alone and uses the same shape: **Fires when**, **Look for**, **Not a finding**, **Controls**. Working alone, use the selected sections as your checklist; in the fan-out variant, paste them verbatim into each child's brief so every child hunts the same way.

Every candidate must still pass the candidate gate in `audit-protocol.md` Phase 3. A lead below is a place to trace, not a finding.

## Contents

- Access control and tenant isolation
- Data lifecycle and derived copies
- Business logic, money and races
- Webhooks and inbound integrations
- Injection
- Authentication, sessions and recovery
- HTTP edge, caching and browser
- Secrets and exposure
- Supply chain
- CI/CD and release integrity
- SSRF, paths and files
- Cloud and infrastructure
- Cryptography
- Resource abuse and denial of wallet
- Agent surface
- Desktop, mobile and local IPC

## Access control and tenant isolation

**Fires when:** any per-user, per-tenant or role-gated data.

**Look for:**
- Every route to the same object: get, list, update, delete, bulk and batch endpoints, GraphQL resolvers, server actions, background jobs, admin and older API versions. One path with the check and a sibling without it is the most common real finding.
- Identity read from the request (body, query, header, path) instead of the session. User, tenant, role, owner or price fields accepted on write (mass assignment).
- Checks only in the UI, middleware or edge layer. RLS off, `using (true)`, or covering only some of select, insert, update, delete.
- Lookups by object ID alone where the ID is only unique within a tenant. A child object reachable without checking its parent.
- Policy and query disagreeing: the policy checks one field, the query filters another, or an `OR` widens the filter.

**Not a finding:** a user reading or changing their own data with their own authority; an intended admin power used by an admin.

**Controls:** `secure-defaults.md` Authorization; `platform-playbooks.md` Web & API.

## Data lifecycle and derived copies

**Fires when:** user data is copied into search, exports, caches, logs, analytics or model context, can be deleted or restored, or members can be removed.

**Look for:**
- Other readers of the same data: search indexes, exports and reports, analytics, logs, traces, error trackers, caches, notifications and emails, embeddings and model context. Each needs the same owner or tenant filter as the main read.
- Access that outlives removal: sessions, refresh tokens, API keys, share links, invites, signed URLs and queued jobs that still work after a member leaves, a role drops, or an account is deleted.
- Soft-deleted or archived rows still returned by search, counts, exports or joins.
- Import and restore that create records the user could not create through the normal path, skip validation, or overwrite other users' records.
- Oracles: search, filters, sorting, counts or different errors that reveal whether a record the user cannot read exists.

**Not a finding:** retention periods (`compliance-guard` owns those); copies only the owner can read.

**Controls:** `secure-defaults.md` Authorization.

## Business logic, money and races

**Fires when:** payments, credits, quotas, coupons, invites, one-time tokens, inventory, voting, or any multi-step workflow.

**Look for:**
- Prices, discounts, quantities, plan IDs or currency sent by the client and trusted by the server.
- Negative, zero, fractional, huge or non-numeric amounts; rounding and unit mismatches between steps.
- Check-then-act on a shared balance or one-time item without an atomic update, row lock or unique constraint: two concurrent requests redeem one coupon, spend the same credits twice, or accept one invite twice.
- Steps that can be skipped, repeated or reordered: replaying a success callback, calling the final step directly, a cancelled order that still delivers.
- Partial failure: step two fails and step one's grant or charge is never rolled back.
- Entitlements decided by a client flag, a success-page redirect, or a cached plan that is never re-checked.

**Not a finding:** a race with nothing shared at stake, or a window no outsider can reach. A check-then-act on money, credits, quotas or one-time items is reportable even when the window is short, because parallel requests are free.

**Controls:** `secure-defaults.md` Money, quotas & webhooks.

## Webhooks and inbound integrations

**Fires when:** the app receives webhooks, payment or OAuth callbacks, or events from another service.

**Look for:**
- A handler that acts without verifying the provider's signature, verifies a re-serialized body instead of the raw bytes, compares with `==`, or skips verification when the header is missing.
- No timestamp tolerance or event-ID dedupe, so a captured event can be replayed.
- Payload fields (amount, customer, status) trusted instead of re-fetching the object from the provider's API.
- Callback parameters that pick the account, tenant or pending transaction without binding to state the app generated.
- One webhook secret shared across environments, or committed.

**Not a finding:** an endpoint that only enqueues the event ID and re-fetches from the provider before acting.

**Controls:** `secure-defaults.md` Money, quotas & webhooks; `platform-playbooks.md` Web & API.

## Injection

**Fires when:** untrusted input reaches an interpreter.

**Look for:** SQL/NoSQL/LDAP/XPath built from strings, including dynamic `ORDER BY` columns and `IN` lists; shell strings and `shell: true`; user-supplied templates; `eval`, `Function`, `vm`, dynamic `import`/`require`; unsafe deserializers (`pickle`, `yaml.load`, `Marshal`, `ObjectInputStream`); XML parsed with entities on; model output reaching any of these.

**Not a finding:** framework-escaped rendering, parameterized ORM calls, and input that is a constant, build-time value or operator config.

**Controls:** `platform-playbooks.md` Web & API and Language hot zones.

## Authentication, sessions and recovery

**Fires when:** any login, session, token, OAuth/SSO, MFA or password-reset logic.

**Look for:**
- Token checks: algorithm read from the token, `none` accepted, `exp`/`aud`/`iss` unchecked, or a valid signature whose claims are never bound to the tenant or user being acted on.
- OAuth/OIDC: missing `state` or PKCE, loose redirect-URI matching, ID token audience or nonce unchecked.
- Account linking: a social or SSO sign-in that attaches to an existing account by matching email alone, especially an unverified one. That is account takeover with one sign-up.
- Reset and magic links built from the request's `Host` or `X-Forwarded-Host`, which mails the victim's token to the attacker's domain. Reset tokens that are reusable, long-lived, or survive a password change.
- Sessions not rotated on login or privilege change; logout or password change leaving other sessions and refresh tokens alive.
- MFA enrolled or removed without recent re-authentication; recovery weaker than the factor it recovers; step-up not bound to the action it guards.
- Enumeration: a different status, message or timing for "no such account" on login, signup, reset or invite.
- No rate limit on login, reset, MFA or token exchange.

**Not a finding:** a signed-in user changing their own settings, unless the design requires step-up for that action.

**Controls:** `secure-defaults.md` Authentication.

## HTTP edge, caching and browser

**Fires when:** the app renders HTML, sits behind a CDN or proxy, or authenticates with cookies.

**Look for:**
- Private responses a CDN or shared cache can store: authenticated pages or API responses without `Cache-Control: private` or `no-store`, cache keys that ignore cookies or `Authorization`, and "static" cache rules that match paths like `/account/x.css` (cache deception). Check framework route-level caching too, not only headers.
- `Host`, `X-Forwarded-For`, `X-Forwarded-Host` or `X-Forwarded-Proto` trusted from clients that are not behind a configured proxy, then used for links, redirects, rate-limit keys, IP allowlists or "is HTTPS" decisions.
- Cookie-authenticated state changes without CSRF protection, including login and JSON endpoints; CORS reflecting any origin with credentials; WebSockets that accept any `Origin` with cookie auth.
- DOM sinks fed from the URL, `postMessage` without an origin check, browser storage or third-party data; prototype pollution from deep-merging user JSON into objects used for config or checks.
- Tokens in `localStorage`; service workers or caches that keep one user's data after logout or account switch.
- A one-click damaging action that can be framed (no `frame-ancestors`).

**Not a finding:** a missing header with no reachable consequence; caching genuinely public responses.

**Controls:** `secure-defaults.md` Web response headers; `platform-playbooks.md` Web & API.

## Secrets and exposure

**Fires when:** any credential exists.

**Look for:** keys in source, git history, client bundles and source maps, public env prefixes, logs, error responses, telemetry, CI output, agent and MCP config, container layers and published packages; debug endpoints; served `.env` or `.git`.

**Not a finding:** obvious test fixtures and public sample keys. Say you saw them and checked they are not live.

**Controls:** `secure-defaults.md` Secrets.

## Supply chain

**Fires when:** any dependency manager, vendored code, editor or agent config, or MCP server.

**Look for:** dependencies that do not exist or look like squats; unpinned or mutable versions; install scripts allowed; lockfile drift; git or URL dependencies; auto-run editor and agent config; MCP servers unpinned or re-trusted after an update.

**Not a finding:** a known advisory in code that is never reached. Note it as maintenance, not a vulnerability.

**Controls:** `supply-chain.md`.

## CI/CD and release integrity

**Fires when:** any workflow, release or update pipeline.

**Look for:** untrusted code in a privileged workflow (`pull_request_target`, `workflow_run`); `${{ github.event.* }}` interpolated into `run:`; actions not pinned by SHA; broad `permissions:` or `id-token: write` outside the publish job; caches and artifacts shared between untrusted and release jobs; secrets echoed; artifacts that can be swapped between build and publish; updates that are unsigned or accept an older version.

**Not a finding:** a workflow that only runs trusted, already-merged code with read-only permissions.

**Controls:** `supply-chain.md` CI/CD and Publishing.

## SSRF, paths and files

**Fires when:** a URL, path, archive or upload comes from input.

**Look for:** server fetches of user URLs (webhook targets, link previews, imports, image proxies, OAuth metadata) without a resolved-IP check and re-validation on every redirect; path joins without a containment check after resolution; archive entries with `..`, absolute paths or symlinks; check-then-use on paths; uploads served from the app's origin.

**Not a finding:** URLs that are constants or build-time strings.

**Controls:** `platform-playbooks.md` Web & API (SSRF, File upload) and CLI & developer tooling.

## Cloud and infrastructure

**Fires when:** IaC, containers, serverless config or cloud SDK calls.

**Look for:** wildcard IAM or roles shared across services; authorization delegated to "anything inside the network"; public buckets; long-lived or unscoped presigned URLs; the legacy metadata service; admin or database ports open to the internet; privileged containers or a mounted Docker socket; secrets in plain manifests; default credentials.

**Not a finding:** a setting the repo cannot show. That is needs validation, with the console or CLI check that settles it.

**Controls:** `secure-defaults.md` Cloud, containers & infrastructure.

## Cryptography

**Fires when:** any hashing, signing, encryption or random token.

**Look for:** fast hashes for passwords; non-AEAD or ECB modes; nonce reuse; `Math.random` or a seeded PRNG for tokens; non-constant-time compares, or compares before the shape is validated; signatures unverified or verified with an algorithm taken from the input; crypto errors that fall through to success.

**Not a finding:** a weak hash used for a non-security purpose such as cache keys or ETags.

**Controls:** `secure-defaults.md` Cryptography and Failure behavior.

## Resource abuse and denial of wallet

**Fires when:** public or low-trust callers can trigger expensive work, paid APIs or model calls, file parsing, or queued jobs.

**Look for:** pre-auth work that costs far more than the request (model calls, email or SMS sends, image or PDF rendering, heavy queries); unbounded page size, batch size or GraphQL depth; decompression and archive bombs; quotas keyed on something the caller can change, or reset by a new account or API key; retries that multiply load on failure; one poison message that blocks a queue.

**Not a finding:** a missing rate limit on a cheap endpoint; slowness the caller pays for themselves.

**Controls:** `agent-surface.md` (spend caps); `platform-playbooks.md` Web & API.

## Agent surface

**Fires when:** the code calls a model, exposes tools to one, runs an agent, or serves or consumes MCP.

**Look for:** private data, untrusted content and egress in one context (the lethal trifecta); model-chosen tool arguments reaching a shell, SQL, path or URL unchecked; approvals that show intent instead of the concrete effect, or are not bound to the action that actually runs; one user's context, memory or retrieved documents reaching another; sub-agents or MCP servers inheriting the parent's credentials; tool descriptions or server identity trusted after an update; model output rendered as HTML, or markdown with remote images; loops and spend without caps.

**Not a finding:** prompt injection with no privileged tool, private data or egress behind it.

**Controls:** `agent-surface.md`.

## Desktop, mobile and local IPC

**Fires when:** a desktop or mobile app, privileged helper, updater, local server, deep link, webview bridge or IPC channel.

**Look for:**
- Loopback servers and IPC that accept any local process: no per-launch token, no peer-credential check, a `0.0.0.0` bind, no `Origin` or `Host` check (DNS rebinding).
- A caller authenticated as one app or user whose request fields then select another user, profile or capability.
- Privileged helpers that run a caller-chosen command, file or setting without checking it on every call.
- Deep links and file-open events that change state, finish sign-in or pick an account without a one-time binding to a request the app started.
- Webview bridges reachable from remote content or after a navigation; capability or permission files wider than the windows that need them.
- Updates verified after unpacking, or without pinning version and target; install and repair paths writable by a lower-privilege user.
- Logout or account switch leaving the previous user's tokens, caches or pending actions behind.

**Not a finding:** the same OS user harming their own data; a missing hardening flag with no reachable content behind it.

**Controls:** `platform-playbooks.md` Desktop, Mobile, and CLI & developer tooling.
