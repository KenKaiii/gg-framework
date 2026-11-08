# Platform Playbooks

Per-target controls. Load only the sections recon says apply. Format: **control → what to check in code → why it fails in practice.**

Snapshot 3 October 2026. **[V]** verified, **[S]** snapshot-volatile, **[U]** uncertain.

---

## Web & API

The best-understood surface; the failures are still the same three.

| Control | Check | Why it fails |
|---|---|---|
| **Authorization at the data layer** | Every query filtered by the acting user/tenant, enforced in one chokepoint (policy layer, RLS, scoped repository) — not per-handler | Per-handler checks are correct on the day they are written and drift on the fifth new endpoint. Object-level authorization (BOLA/IDOR) is the top API risk and CWE-862 is top-five |
| **Auth not only in middleware/edge** | Framework middleware (Next.js `middleware.ts`, edge functions, route guards) may redirect, but the route handler, server action, or data layer re-checks session and ownership | CVE-2025-29927 let a single `x-middleware-subrequest` header skip Next.js middleware entirely [V]; any app whose only check lived there was open. Server actions and API routes are public endpoints regardless of which page calls them |
| **Parameterized queries** | No string concatenation or f-strings into SQL/NoSQL/LDAP/XPath; ORM `raw`/`literal`/`$where` calls audited individually | The ORM covers 95% and the last 5% is a report filter or a dynamic sort column |
| **Output encoding** | Framework escaping left on; explicit unsafe sinks (`dangerouslySetInnerHTML`, `v-html`, `bypassSecurityTrust*`, `innerHTML`, raw template filters) each justified | XSS is still rank 1 in the 2025 CWE Top 25 (then SQLi, CSRF, Missing Authorization) [V]. Modern frameworks make the safe path default and the unsafe path a one-liner |
| **Server-side validation** | A schema at every entry point, allowlist-shaped, rejecting unknown fields; never trust client validation | Mass assignment: the model accepts `is_admin` because the schema was permissive |
| **CSRF** | State-changing routes require a token or `SameSite=Lax/Strict` cookies plus origin checks; API-token auth is exempt, cookie auth is not. Pre-auth flows need it too — login, signup, password reset (login CSRF is real). Validation must reject a **missing** token, not just a wrong one | Cookie-authenticated JSON endpoints assumed safe because "it's an API"; token checks that only run when a token is present |
| **SSRF** | Any URL from input: allowlist hosts, resolve then validate the IP, block private and link-local ranges, disable redirects or re-validate each hop — full sweep below | Metadata endpoints on cloud hosts turn SSRF into credential theft. Folded into A01 in the 2025 Top 10 |
| **Open redirect** | Any redirect target from input: prefer relative paths starting `/` (reject `//` and `/\`), or map named keys to URLs server-side; if full URLs are required, parse, canonicalize to Punycode, then match the hostname against an allowlist | Raw-string checks fall to `legit.com@evil.com` (userinfo trick), `legit.com.evil.com` (attacker subdomain), protocol-relative `//evil.com`, `javascript:`/`data:` schemes, backslash and double-encoded variants, and IDN homographs. Validate the **parsed hostname**, never the string |
| **File upload** | Three independent checks: extension allowlist **and** magic-byte sniff **and** a parse as the claimed type. Random generated names, original discarded; stored outside the web root; served from a separate origin with `Content-Disposition: attachment` and `nosniff`; size caps server-side | Any single check falls to double extensions (`x.php.jpg`), null bytes in names, spoofed `Content-Type`, prepended magic bytes, or polyglot files. SVG is a scriptable XML document — sanitize or refuse it. Archives get zip-slip path checks per entry |
| **XXE** | Every XML parse of untrusted input has DTDs, external entities, and XInclude disabled at the parser. XML hides in DOCX/XLSX/PPTX (ZIP of XML), SVG, SAML, RSS, SOAP — and in JSON APIs converted to XML server-side | Several stacks still default entity resolution on: Java needs `disallow-doctype-decl`; Python should parse with `defusedxml`; .NET needs `DtdProcessing.Prohibit` and a null resolver |
| **Rate limits on credential paths** | Login, reset, MFA, token exchange, invite acceptance | These are the endpoints where volume converts directly to account takeover |
| **Errors** | Generic message to the client, detail to the log; no stack traces, SQL text, or env in responses | A10:2025 is new and is exactly this: fail-open and mishandled exceptional conditions |

**Backend-as-a-service (Supabase / Firebase / PocketBase and similar) — the highest-yield indie failure** (CVE-2025-48757: 170+ generated apps shipped Supabase tables without RLS) [S]:

1. RLS enabled on **every** table holding user data, including join tables and views.
2. No `using (true)` policies. That is the generated default when a model is told to "add a policy" without a rule, and the dashboard still shows a green badge.
3. Coverage for **all four verbs** — a common shape locks `SELECT` and leaves `INSERT`/`UPDATE`/`DELETE` open.
4. **Service-role keys never in client code**, never in `NEXT_PUBLIC_*`/`VITE_*`/`EXPO_PUBLIC_*`. Grep the built bundle, not just the source.
5. `auth.uid()` compared against the row's owner column, not merely present in the expression.
6. Assume table names are known — generated schemas converge on `users`, `profiles`, `messages`, `orders`, `subscriptions`. The REST layer self-describes to anyone holding the public anon key.

**Verification that actually proves it:** call the endpoint as user B for user A's row and require a 403/404. One such test per protected resource is worth more than a header audit.

**SSRF, hardened** — the naive "block 127.0.0.1 and 10.x" string check is the one that gets bypassed:

1. Validate the **resolved IP** with a canonical IP parser, not the hostname string. Internal ranges are reachable as decimal (`2130706433`), octal (`0177.0.0.1`), hex, shortened (`127.1`), IPv6 loopback (`[::1]`, `[::]`), and IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`) forms — canonicalization collapses all of them; a denylist of spellings never will.
2. **Pin the resolved IP for the actual connection** (connect to the IP, send the hostname in the Host/SNI). Resolve-validate-then-fetch re-resolves, and that second resolution is the DNS-rebinding hole. A CNAME to an internal hostname is the same trick.
3. Block link-local `169.254.0.0/16` and metadata hostnames (`169.254.169.254`, `metadata.google.internal`) explicitly, and enforce IMDSv2 anyway — SSRF plus legacy metadata service equals cloud credentials.
4. Disable redirect following, or re-run the **full** validation on every hop; a compliant external URL that 302s to an internal address is the standard bypass.
5. Scheme allowlist `http`/`https` only; bounded timeout and response size.

**XSS enters from more than form fields.** When auditing sinks, sweep the indirect sources too: URL query **and fragment**, request headers the app displays (Referer, User-Agent), third-party API data rendered to users, WebSocket and `postMessage` payloads (validate `event.origin`), localStorage/sessionStorage values rendered later, uploaded file names, error messages that reflect input, markdown and rich-text renderers with HTML enabled, admin log viewers, and HTML-to-PDF or email-template generators — an injection there executes in the generator's context, often server-side. Sanitize rich text with an allowlist library (DOMPurify), never a homemade regex. Trusted Types plus nonce CSP (see `secure-defaults.md`) backstop the misses.

**GraphQL, if present:** introspection off in production; server-enforced depth limit (~10) and query cost/complexity limit; cap operations per request — batching turns one HTTP request into a thousand login attempts and walks past per-request rate limits; authorization still happens per-object in resolvers, because the graph is one endpoint and route-level auth checks nothing.

---

## Mobile (iOS / Android)

Standards [V]: **MASVS v2.1.0** (8 categories, no L1/L2 levels since v2.0.0) and **MASTG v2.0.0** (30 Jun 2026) with atomic, referenceable test IDs — cite `MASTG-TEST-####`, not chapter names. Mobile Top 10 is the **2024** edition, led by M1 Improper Credential Usage.

| Control | Check | Why it fails |
|---|---|---|
| **Credential storage** | iOS Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; Android Keystore with `setUserAuthenticationRequired`, StrongBox where available | Defaults sync to cloud keychains and survive device backup |
| **RN/Flutter/Expo storage** | `AsyncStorage` holding tokens is plaintext — unencrypted SQLite on Android, plist on iOS. Use `expo-secure-store` / `react-native-keychain` | Secure stores are small-value only; store a key there and encrypt the payload separately |
| **Secrets in the bundle** | Grep the built bundle and `EXPO_PUBLIC_*`/`REACT_APP_*` for API keys | The JS bundle is shipped, readable, and extracted routinely |
| **Exported components** | `android:exported` explicit on every activity/service/receiver with an intent filter; unexported unless required | Set to `true` to silence the build error, permanently |
| **Intent redirection** | `getParcelableExtra(..., Intent.class)` then `startActivity` | A nested attacker-supplied intent gets launched with your app's privileges. Android 16 adds stricter opt-in resolution [S] — opt in |
| **Deep / app links** | `android:autoVerify="true"` plus a served `assetlinks.json`; iOS `applinks:` entitlement plus AASA as `application/json`, no redirect | Verification propagation can take days [S] — a redeploy is not an instant fix. Never treat link parameters as authenticated |
| **WebView bridges** | `addJavascriptInterface`, `loadDataWithBaseURL`, `setJavaScriptEnabled`; iOS `WKScriptMessageHandler` — validate `frameInfo.isMainFrame` and origin | The classic in-app RCE path; a bridge exposed to remote content is a native API for the page |
| **Transport** | `networkSecurityConfig` for `cleartextTrafficPermitted="true"` and `<debug-overrides>`; iOS `NSAllowsArbitraryLoads` | Domain-specific overrides silently reopen cleartext |
| **Pinning** | If pinned: pin an SPKI set including a backup, with documented rotation and a kill switch | Hard-pinning a leaf certificate now causes more outages than the MITM it prevents [U] |
| **Backup / pasteboard** | `android:allowBackup`, `dataExtractionRules`; `UIPasteboard.general` for tokens | Auto Backup exfiltrates tokens off-device by default |
| **Client-side gating** | Any entitlement, price, or role decided in the app | Re-decide server-side. The client binary is attacker-owned |

**Store gates** [S]: Apple requires `PrivacyInfo.xcprivacy` privacy manifests with required-reason API declarations and signed binary dependencies for listed SDKs (rejection codes in the `ITMS-9105x` family). Google Play raised the minimum target API for new apps and updates in 2026 — check the current requirement before a release. Data-safety declarations must match real SDK behavior.

---

## Desktop

**Electron** — two layers, and teams do only the first.

- *Renderer config:* `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `nodeIntegrationInWorker/InSubFrames: false`, `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`, a `setWindowOpenHandler` and a `will-navigate` allowlist, and a preload that exposes a **narrow typed API** rather than `ipcRenderer` itself.
- *Packaging fuses* [V], flipped at package time before signing so the OS enforces them: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`, `GrantFileProtocolExtraPrivileges` → **false**; `EnableEmbeddedAsarIntegrityValidation`, `OnlyLoadAppFromAsar`, `EnableCookieEncryption` → **true**. Verify the packaged app, not the config file. Left on, a signed app becomes a living-off-the-land Node runtime with the app's privileges and entitlements. Tradeoff: disabling `RunAsNode` breaks `child_process.fork` — use `UtilityProcess`.
- Electron's own position [V]: it is not a browser, and displaying arbitrary untrusted content is a risk it is not designed to contain.

**Tauri v2** — capability-scoped, and the defaults are good until someone widens them.

- Grep `src-tauri/capabilities/*.json` for: window label **globs** (a capability granted to `app-*` is granted to every future window with that prefix — boundaries are label-based); `remote.urls` (exposes the API to remote origins; on Linux and Android an embedded iframe cannot be distinguished from the window [V]); `fs:allow-*` without a matching deny scope; `shell:allow-execute`.
- Every registered command is callable from every window unless a capability restricts it. Least privilege means per-window capabilities, not one default file.
- `"csp": null` disables Tauri's CSP injection — set a real policy.
- Updater signature verification cannot be disabled [V], so the residual risk is **private key custody**, not transport. The signing key lives in CI secrets, never a `.env`.

**Cross-desktop, all frameworks:**

| Control | Check | Why it fails |
|---|---|---|
| **Loopback HTTP servers** | Bind `127.0.0.1` explicitly (never `0.0.0.0`), require a per-launch bearer token, validate `Origin` and `Host` | Any local process — and, via DNS rebinding, any web page the user visits — can reach an unauthenticated loopback port |
| **Local IPC** | Unix socket at `0700` with peer-credential checks; Windows named pipe with an explicit DACL and `PIPE_REJECT_REMOTE_CLIENTS` | Default pipe ACLs are broader than you expect |
| **Deep links** | Custom schemes are first-come-first-served (Windows) or last-registered-wins (macOS); any app can claim yours | Never treat a deep-link parameter as authenticated; bind auth codes to a state/nonce you generated |
| **Updater** | Verify the signature **before** unpacking; pin the public key in the binary; include version and target in the signed payload | Rollback and cross-target swaps are the bugs left after signing is added. Design key rotation before you need it |
| **Signing** | macOS: Developer ID, `--options runtime`, `--timestamp`, `notarytool`, then `stapler staple` so offline machines verify. Every nested binary and sidecar signed individually | Certificate validity was cut to 460 days for certificates issued from 1 Mar 2026 [S], and keys must be in certified hardware — build rotation into the release pipeline and always timestamp |

---

## CLI & developer tooling

The distinguishing risk: **these programs open repositories, files, and projects that the user did not write.** Everything in the workspace is attacker-controlled input.

1. **Shelling out.** Grep `shell: true`, `execSync`, `exec(`, backtick or f-string interpolation into `bash -c`, `os.system`, `subprocess` with `shell=True`. Use `spawn(file, args)` with an argument array. Where a shell is genuinely required, the invariant is that no model-derived or repo-derived string reaches it uninterpolated.
2. **PATH and search-order hijack.** Bare command names in spawn calls resolve through `PATH`. Never prepend `.` or a repo-relative `node_modules/.bin` when the repo is untrusted; resolve to absolute paths.
3. **Repo config is data, not code.** A malicious repository ships `.git/config` (`core.fsmonitor` and `core.pager` are code execution), `.vscode/tasks.json` with `runOn: folderOpen`, agent hook configs, `Makefile`, `package.json` scripts, editor and linter plugin paths. **The ChainDrop worm (Aug 2026) used exactly the editor-task and agent-hook vectors** [V]. Never honor a repo-supplied plugin, loader, or interpreter path.
4. **Terminal escape injection.** Untrusted file contents, git refs, branch names, and tool output printed raw can emit OSC 8 hyperlinks, OSC 52 clipboard writes, and cursor/title sequences that some terminals echo back as input. Strip C0/C1, CSI and OSC sequences from untrusted strings before writing to a TTY.
5. **Symlinks and TOCTOU.** `existsSync` then `writeFile` is a race. Resolve with `realpath`, verify containment **after** opening, use `O_NOFOLLOW`/`openat` where available, and reject `..` and absolute entries when extracting archives.
6. **Install-time execution.** `preinstall`/`postinstall` run arbitrary code with full developer privileges before anything is evaluated. Set `ignore-scripts` with an explicit allowlist for the few packages that need builds. See `supply-chain.md`.
7. **Credentials on disk.** Token files at `0600`, never logged, redacted from diagnostics and crash reports, and outside any directory the tool uploads. Prefer the OS keychain where available.
8. **`curl | sh` installers.** If you ship one: HTTPS only, pinned to an immutable release URL rather than `latest`, verifying a published checksum or signature before executing anything.
9. **Sandboxing untrusted content.** macOS seatbelt, Linux Landlock (check the ABI at runtime and degrade gracefully; a descriptor opened before restriction stays usable, so use `O_CLOEXEC`), or a container with `--network none`. Most analysis tasks need no network at all.

---

## Embedded, IoT & firmware

**Regulatory dates that drive engineering** [V]: the EU Cyber Resilience Act is in force since 10 Dec 2024 and fully applicable 11 Dec 2027, with **Article 14 reporting obligations starting 11 September 2026** — early warning within 24 hours, full notification within 72 hours, final report within 14 days once a fix exists. Two traps: only *actively exploited* vulnerabilities trigger reporting, and it applies to products already on the market, so shipping date is irrelevant. UK PSTI has been enforced since Apr 2024 — unique or user-set passwords, a disclosure programme, and a published support period. The US Cyber Trust Mark remains voluntary with administration in flux [S]; do not plan around it as a market gate.

**Device controls:** hardware root of trust with secure boot and anti-rollback counters; OTA images signed and verified **before** flashing to an inactive slot, with A/B plus watchdog rollback; JTAG/SWD fused off and UART consoles disabled in production builds (grep build configs for debug flags and fuse-burn steps); no shared per-fleet keys — per-device identity or a compromise is fleet-wide; an SBOM generated in CI per firmware version and retained, because you cannot answer "which units are affected" in 24 hours without one.

---

## Smart contracts & web3

**The strategic read** [S]: losses are dominated by key management, privileged-role governance, and oracle or collateral *configuration* — not arithmetic bugs. Multiple 2025–2026 nine-figure incidents hit protocols that had been audited by reputable firms; at least one turned on a months-long social-engineering campaign that obtained administrative control and then whitelisted a manipulable asset.

Grep priorities in this order: privileged setters without timelock and multisig; `onlyOwner` on collateral, oracle, or fee parameters; unbounded proxy `upgradeTo`; uninitialized implementations and missing `initializer`; spot prices read from `getReserves`/`slot0` used as an oracle; `ecrecover` without nonce, deadline, and chain ID (use EIP-712); cross-chain message verification that trusts a sender field; and reentrancy on external calls before state writes.

**Compiler** [V]: current is **0.8.36** (9 Jul 2026). Two upgrade-forcing releases in the window — 0.8.34 (Feb 2026) fixed a high-severity storage-clearing bug in the IR pipeline, and 0.8.32 (Dec 2025) fixed a lost storage array write. Since 0.8.31 the default EVM target moved, so **pin `evmVersion` explicitly** or a compiler bump silently retargets your chain. Deprecated before 0.9.0: `send`/`transfer` on `address`, ABI coder v1, virtual modifiers.

**CI gates:** Slither failing on high/medium, Foundry invariant and fuzz suites with bounded handlers (property tests catch the economic bugs unit tests miss), Echidna, and storage-layout diffing on every upgradeable deploy.

---

## ML & AI pipelines

| Control | Check | Why it fails |
|---|---|---|
| **Model deserialization** | The default flipped: `torch.load` is `weights_only=True` from PyTorch 2.6 [V]. So grep the **override** — `weights_only=False`, and `add_safe_globals`/`safe_globals` used to silence an error rather than allowlist a reviewed type | Re-running with `weights_only=False` makes the error go away and arbitrary code execution appear |
| **Other loaders** | `pickle.load`, `joblib.load`, `dill`, `numpy.load(allow_pickle=True)`, Keras `.h5`/`.keras` with Lambda layers | A model file is a program. Prefer `.safetensors` and reject code-capable formats at the ingestion boundary |
| **`trust_remote_code=True`** | Any occurrence | Equivalent to `curl \| sh` against a model hub |
| **Model provenance** | Sign at train time, verify **in the loader** at load time (OpenSSF Model Signing / sigstore) [V]; pin dataset revisions by content hash, not by a mutable hub tag | A README instruction to "verify the hash" is not verification |
| **Endpoint exposure** | Anything bound to `0.0.0.0`: experiment trackers, notebook servers, inference servers, dashboards, job-submission APIs, local model runtimes | Several 2025–2026 critical CVEs in this class chain auth bypass with traversal to unauthenticated RCE [S]; some job APIs are unauthenticated by design and must be network-isolated |
| **Default credentials** | Auth config files shipped with defaults; notebooks started with empty tokens and `--allow-root` | Generic credential-harvesting scanners find these incidentally, which is how most of these get popped [V] |
| **Model output** | Treat as untrusted input to whatever consumes it — never straight into `eval`, a shell, SQL, or `innerHTML` | This is LLM05 Improper Output Handling, and it is how a prompt injection becomes code execution |

---

## Games & client-side software

Short, because one principle covers it: **the client is permanently untrusted input.** Anti-cheat raises cost; it never establishes trust.

- Grep the server for accepting client-supplied position, damage, currency, inventory, score, or elapsed-time deltas. The server simulates; the client predicts and reconciles. Bound and rate-limit every accepted delta.
- Licence keys, HMAC secrets and API tokens in a shipped binary are disclosed, not hidden — `strings` finds them immediately. Validate server-side; if offline validation is required, verify a signed per-user licence with an embedded public key and accept that it is tamperable.
- Mods and user-generated content are the untrusted-repo problem again: sandbox the scripting runtime, disable filesystem/network/FFI access, and never deserialize UGC with a code-capable format.

---

## Language hot zones

Apply only to languages actually present. A grep hit here is a lead, not a finding — trace the path before flagging.

| Language | Check |
|---|---|
| **Node / TypeScript** | `child_process.exec`/`execSync`, `spawn(..., {shell:true})`, `eval`/`new Function`, `vm.runIn*`, prototype pollution via deep-merge helpers or `Object.assign({}, userJson)`, `node-serialize`, source maps in published packages, `JSON.parse` on untrusted input feeding an object used as a lookup table |
| **Python** | `pickle.load`, `yaml.load` without `SafeLoader`, `eval`/`exec`, `subprocess.*(shell=True)`, `os.system`, Jinja2 with `autoescape=False`, `render_template_string` on user input, `requests(verify=False)`, XML parsing without `defusedxml`, `torch.load(weights_only=False)` |
| **Go** | `exec.Command("sh", "-c", input)`, `text/template` where `html/template` was meant, unbounded `io.ReadAll`, unsynchronized map access, missing `http.Server` timeouts |
| **Rust** | `unsafe` blocks with raw pointers, `Command::new("sh").arg("-c")`, deserializing untrusted input without bounds, `unwrap()` on attacker-influenced input in a service path |
| **Java / JVM** | `ObjectInputStream` on untrusted bytes, JNDI lookups from input, `Runtime.exec(String)`, XXE in default XML parsers, expression-language injection |
| **Ruby** | `eval`/`instance_eval`, `Marshal.load`, `YAML.load` rather than `safe_load`, `system` with interpolation, mass assignment without strong parameters |
| **PHP** | `unserialize`, `eval`, `assert(string)`, `include`/`require` with a dynamic path, `preg_replace` with the `/e` modifier |
| **C / C++** | `strcpy`/`sprintf`/`gets`, integer overflow in size arithmetic, `printf(userInput)`, use-after-free, double-free. New parsing code here needs a written justification, sanitizers, and fuzzing |
| **Shell** | Unquoted variable expansion, `eval`, word splitting on filenames, `curl | sh`, missing `set -euo pipefail` |
| **SQL** | String-built queries, dynamic identifiers and `ORDER BY` columns (cannot be parameterized — allowlist them), `LIKE` patterns built from input without escaping `%`/`_`, `IN` lists interpolated instead of expanded as placeholders, `SECURITY DEFINER` functions without a locked `search_path` |
