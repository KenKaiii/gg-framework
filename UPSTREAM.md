# Upstream provenance

This repository is the Kleio-owned downstream fork of
[`KenKaiii/gg-framework`](https://github.com/KenKaiii/gg-framework).

## First engine integration (merged)

PR [#1](https://github.com/fmckie/gg-framework/pull/1) imported upstream
`3a4eb7e83fe19eebc74aa539d5fa940822f8cdd1` (engine **5.59.3**, desktop **0.63.3**)
and merged at `2a4ba011806ba6795b44c96d2b76261cfd3c98b2`. All six framework/app
Linux, macOS and Windows jobs passed in post-merge run **34973614641**, including
the blocking Windows installer build-and-launch smoke.

## Next 44 commits (2026-09-15)

- Pinned upstream snapshot: `fdab3f18ff204fbae2846686a7a7a2a3e8e04d94`
- Engine **5.60.2**, desktop **0.65.0**: 44 commits after the first integration
- Integration base: `2a4ba011806ba6795b44c96d2b76261cfd3c98b2`
- Branch: `sync/upstream-fdab3f18`; `main` stays unchanged
- PR: [#2](https://github.com/fmckie/gg-framework/pull/2), merged at `99073ea3`
- Integration commit: `9972757d69935e8fe7041316646acac30e5b0942`
- Verification gates: `79735cb4`; hosted-runner fixes and dependency overrides in
  [#3](https://github.com/fmckie/gg-framework/pull/3)

**Released as 5.60.2-kleio.1.** From this release the fixed version is
`<imported engine version>-kleio.<n>` (enforced by `scripts/verify-fixed-versions.mjs`
against `fork-provenance.json` `upstream.lastImportedVersion`), so a package never
claims an engine it does not contain. The original fork point and its immutable
baseline below remain unchanged.

### Projects maintained downstream

Unlike upstream, this fork retains standalone `@kleio/manager` in
`packages/gg-boss`, Editor and the Premiere panel, all Pixel SDKs and its server,
Voice, Coder Eyes, Matey, and experiments. Their workspace membership, commands,
exports, tests, and supporting assets remain active. Compatibility adaptations
use the newer shared engine; these projects are not archived or replaced by a
second engine copy. This deliberate divergence requires ongoing maintenance.

`gg-app` is an additional imported workspace member. Its upstream app identity
is distinct from Kleio Desktop; its release jobs are guarded to run only in
`KenKaiii/gg-framework`. The Kleio Desktop repository, vendored bridge, separate
Manager surface, runtime dependency pins, and real session data are unchanged.

`SessionInfo.firstPrompt` remains optional bounded raw text captured in the same
stream pass as the newer, normalized `preview`. Archive handling, checkpoint
selection, redaction, and storage normalization remain upstream implementations.

The workspace, Ink patch, security overrides, explicit build allowlist, fork
release guards and Windows CI fixes remain intact. Two additional upstream UI
patches preserve production style nonces. Zod 4 is pinned to upstream's **4.5.4**
across the workspace to prevent incompatible schema types from mixed versions.

Internal diagnostics remain opt-in. Argument identifiers (even short ones) and
normalized errors are hashed; raw error samples are never stored. Project paths
are hashed, existing secret redaction is reused, maps/records/reads are bounded,
and validated records are privately written by temp-then-rename. Old raw-format
files are excluded from aggregation. Regression tests use disposable synthetic data.

### Verification record

Local macOS verification passed: complete workspace build/typecheck/test, lint,
formatting, fixed versions, staged and packed identity checks, actual five-package
archives with byte-for-byte audit parity, identity negative tests, runtime staging,
sidecar bundle/smoke, all three size gates, startup gate, **515 desktop tests**,
frontend production build, **77 Rust tests**, and unsigned native production build
(`tauri build --no-bundle`). Existing opt-in live/LSP tests remain unrun; no test or
CI gate was disabled by this integration.

The frontend initially exceeded its unchanged size gate at **859.2 KiB**. Deferring
closed settings/model-setup dialogs reduced initial JavaScript to **837.1 KiB**;
no thresholds were relaxed. Regression tests cover real lazy dialogs, saving,
Escape/focus return, and no automatic model download. The shared modal captures
its opener before child autofocus, preserving keyboard focus on close. Seven
retained files received only formatting required by the new Prettier version.

Tauri JS/Rust and MediaPipe SDK/runtime alignment checks passed. Existing Chrome
exercised real components in synthetic desktop/narrow fixtures: native keyboard
activation, disabled controls, persisted toggle, reduced motion, draft retention
and cleanup. Real-package nonce tests passed; production CSP was not weakened.
Production geometry/CSP checks passed in Chrome at 50%, 95%, 100%, 125% and 200%
zoom, including persisted toggles. The optional WebKit leg could not launch because
its Playwright browser binary is not installed. Logs are ignored under
`.git/upstream-44/`.

The authoritative cross-platform results are in [PR #2's checks](https://github.com/fmckie/gg-framework/pull/2/checks):
all six Linux/macOS/Windows framework/app jobs must pass, including the blocking
Windows MSI build-and-launch smoke. Full native screen-reader, live-provider,
host-application/audio/screen and signed/notarized
installation checks remain unverified. No camera, inference model downloads, real
sessions or credentials were used; internal mode is enabled only in disposable tests.

**Not release-ready:** the dependency audit reports **115** full-graph alerts
(60 high, 46 moderate, 9 low), versus 114 (61/43/10); **20** production alerts
(10 high, 8 moderate, 2 low), versus 18 (9/7/2). New adm-zip advisories
**GHSA-xcpc-8h2w-3j85** and **GHSA-vwc7-r8mq-g2x9** arrive through Transformers 4 /
ONNX's binary installer; that hook was not run locally. Existing Electron/Matey,
LangChain/Boss and sharp/libheif findings remain. Attachment processing reaches
the decoder covered by [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).
Dependency remediation requires separate scope approval; this import is not a
comprehensive security review or a clean-audit claim.

**2026-09-18 update:** root `pnpm.overrides` now pin `undici@7` ≥7.29, `sharp`
≥0.35.4 and `adm-zip` ≥0.6.1, clearing every production alert on a `@kleio/*` path
(prod 21 → 3, remaining three are Matey-only). Triage and accepted-risk list:
[`docs/dependency-audit-2026-09-18.md`](docs/dependency-audit-2026-09-18.md).

## Engine 5.64.1 and 5.66.2 integrations (merged)

- `sync/upstream-3d36e760` ([#13](https://github.com/fmckie/gg-framework/pull/13)):
  upstream `3d36e760b54f6268a3a01ec5546d2744c383ba12`, 49 commits, engine **5.64.1**,
  desktop **0.70.3**. Base `fba4a4dc`, integration commit `ae6e9989`, fixed version
  `5.64.1-kleio.1`.
- `sync/upstream-3f2bb6bc`: upstream `3f2bb6bc716198dc223365520374363a56bff051`,
  40 commits, engine **5.66.2**, desktop **0.73.2**. Built on the 3d36e760 branch
  (`eddf755e`), integration commit `f9d55906`, fixed version `5.66.2-kleio.1`. It
  also removed Matey from the tree (deleted upstream in `bbc5c7a8`).

Both reached `main` through [#14](https://github.com/fmckie/gg-framework/pull/14)
at `005a94e3` on 2026-09-30; all six CI jobs passed on `221ff255` (run
**36754104760**), and GitHub then marked #13 merged. `upstream.lastImportedCommit`
is `3f2bb6bc`. Both imports shipped in `5.66.2-kleio.1`, published on 2026-10-30
(see [Published releases](#published-releases)); `5.64.1-kleio.1` itself was never
published.

## Selective import through upstream 988f920e (merged)

- Upstream tip reviewed: `988f920ef6aad72e2a2196eb16ce6ac1b9096ea3` (engine **5.87.2**,
  desktop **0.97.5**), 245 commits after `3f2bb6bc`
- Branch: `sync/upstream-selective-20261029`, based on `main` at `3562294b`
- PR: [#66](https://github.com/fmckie/gg-framework/pull/66), merged at `36f01139` on
  2026-10-29; all six CI jobs passed on `125f9b31` (run **40889421051**)
- `upstream.lastImportedCommit` stays `3f2bb6bc`, because the fork does not contain
  everything up to any later upstream commit. A later full sync must treat the commits
  below as already applied: picks carry `cherry picked from commit <sha>` and ports
  carry `Ported from upstream <sha>`. `fork-provenance.json` `selectiveImports` holds
  the full hashes.

Picked with `git cherry-pick -x`. Conflicts were resolved against the fork's code,
upstream changesets were dropped, and new upstream text got Kleio names or
identity-allowlist entries:

| Upstream   | Downstream | Fix                                                                                                                                                        |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `946c4597` | `ee2b9037` | URL passwords in redaction, cut-off ChatGPT replies, partial-read overwrites, `cmd &` bash hangs, hidden text in instruction files; sandbox-runtime 0.0.78 |
| `32dee6ec` | `70aec920` | Project picker listing tool folders and never-used session folders                                                                                         |
| `9510f2a7` | `d5256f05` | Window-layout menu opening behind the transcript on Windows and Linux                                                                                      |
| `5789eabb` | `a0ba9818` | Ken autopilot review: changed files, corpus warning, user framing                                                                                          |
| `c5018a4a` | `b76dd3be` | Cloudflare 520–524 retries; invalid tool arguments counted once per response                                                                               |
| `10241229` | `e4bb6ac8` | Early compaction after a skewed token estimate                                                                                                             |
| `182b4dfd` | `7124888d` | Per-provider compaction triggers instead of a flat 400K cap                                                                                                |
| `507281c5` | `a66e323d` | `x-grok-conv-id`, so Grok reuses its prompt cache                                                                                                          |
| `2a9e02d6` | `0706016d` | Gemini 3.1 Pro compacts under its 200K price line; the registry hunk edits a model the fork does not have                                                  |
| `dd2c2e63` | `fb55a4fb` | Daemon log going dark; a rejected refresh wiping a newer login                                                                                             |
| `0954bed4` | `7c94db71` | gg-app dev server reloading on Motion preview HTML                                                                                                         |
| `c44ae6ba` | `54ca00a8` | Windows EBUSY in the dispose test                                                                                                                          |
| `db990304` | `a643f99e` | Flaky Windows dispose test                                                                                                                                 |

Ported by hand into the fork's single-file modules, because upstream's module split
(`4f763ed2`) is not imported:

| Upstream   | Downstream | Taken                                                                                               | Left out                                                            |
| ---------- | ---------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `60a24958` | `d2e28a4a` | `AgentOptions.fetch` passthrough                                                                    | `embed()`, `rerank()`, `providerOptions`                            |
| `d493df83` | `ef690ba3` | Provider fetch past Node's 300 s cap, `ResponseStalledError`, reasoning keepalives; `undici` 7.29.1 | Grok on xAI's Responses API, `chat-error.ts` copy                   |
| `420b1ad3` | `bcec266c` | Env proxy kept by the provider fetch                                                                | Compound-command verification, bash note, reply-length prompt rules |
| `95615bde` | `cc641f20` | SSE pings count as activity; 30-minute thinking cap                                                 | —                                                                   |
| `89e5af17` | `b6a2d329` | Background commands stopped before async teardown                                                   | — (the fork's `dispose()` order is kept)                            |
| `0b9dbe96` | `73ab3385` | Failed compacted runs keep their messages                                                           | Deferred `web_search` 400 fix, which needs `c08602e9`               |
| `65e76739` | `e40ddd6b` | Anthropic tool-loop turns cached at 5 min, user messages at 1 h                                     | —                                                                   |
| `3cca7462` | `2eabe6e7` | Working directory behind the uncached marker                                                        | Check-rule wording; the fork's prompt lacks those bullets           |

Not taken:

- `7d010a4a`: the sub-agent turn-record fix already landed downstream as `b9698ef8`.
- `a359de2f`: fixes `gg-app/src/WakeScreen.test.tsx`, which only exists after
  upstream `3ec4e666`.
- `c38df90e`: the fork's catastrophic-command guard predates `3ec4e666`'s shell
  walker and already reads `C:\Users\me` literally.

The rest of `3f2bb6bc..988f920e` (features, the module split, branding, release, CI
and version commits) is not imported. The imported fixes shipped in `5.66.2-kleio.1`,
published on 2026-10-30. Their changesets for `@kleio/ai`, `agent`, `core` and `coder`
were moved by hand into those packages' `5.66.2-kleio.1` CHANGELOG entries.

## Module split from upstream 4f763ed2 (open)

- Upstream tip reviewed: `0e7a6382da002e8a4473f0247a7e60050cc3e9ee` (engine **5.88.1**,
  desktop **0.99.1**), 265 commits after `3f2bb6bc`. None of the 20 commits after
  `988f920e` is taken here.
- Branch: `sync/upstream-split-4f763ed2`, based on `main` at `75e3ba68`
- PR: [#74](https://github.com/fmckie/gg-framework/pull/74), opened as a draft on
  2026-11-02
- PR 1 of the 4 in `.gg/plans/upstream-selective-import-phased.md`. PRs 2–4 port
  upstream fixes, tools and Goals against the new paths.
- `upstream.lastImportedCommit` stays `3f2bb6bc`, for the reason given in the previous
  section. Each port commit carries
  `Ported from upstream 4f763ed27d80097f2867e55d67f17d61236ae2d9`, and
  `fork-provenance.json` `selectiveImports` holds the full hashes. No commit is picked.

Upstream's split can't be cherry-picked: the fork's four largest files carry fork code
and lack upstream's edits from `3f2bb6bc..4f763ed2`. So the fork's own code moves into
upstream's module layout. Each item goes to the module where upstream put the item of
the same name, and fork-only items go with their main caller. Bodies move unchanged;
only imports, exports, visibility and the command registration change. Behaviour does
not change.

| Upstream   | Downstream | Split                                                                                                                                                                                                                               | Not created                                                                                                                     |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `4f763ed2` | `dc11fe9b` | `gg-app/src-tauri/src/lib.rs` into `auth`, `commands/{mod,agent,agent_admin,files}`, `daemon`, `events`, `paths`, `process`, `settings`, `state`, `tray` and `windows`. `lib.rs` keeps `run()`, the plugins and `generate_handler!` | —                                                                                                                               |
| `4f763ed2` | `f42b09e1` | `app-sidecar.ts` in `@kleio/coder`, still the entry, into 23 upstream-named `app-sidecar/` modules on upstream's route context, plus 12 fork-named ones for the fork's own routes                                                   | `keep-awake.ts`: the fork keeps the machine awake from Rust                                                                     |
| `4f763ed2` | `14a78f71` | `core/agent-session.ts` in `@kleio/coder`, which keeps `AgentSession` and its exports, into `core/agent-session/{helpers,mcp-tools,run-loop-monitor,transcript-markers,verification-tracker}`                                       | Members only later upstream commits use: `McpToolRegistry.promote()`, cache diagnostics, the debug manager, plan-mode promotion |
| `4f763ed2` | `2a23a7b1` | `gg-app/src/App.tsx`, which keeps `<KleioHome`, into `transcript-item.ts`, `TranscriptRow`, `AppFooter`, `Composer`, `WorkspaceHeaderActions` and 10 hooks                                                                          | `useChecklist`: the checklist arrives with `4b63cdd2`                                                                           |

Not taken from `4f763ed2`:

- The What's New redesign (`WhatsNew.css`, the `WhatsNewCampfire.tsx` pixel art,
  `WhatsNewParts.tsx`, `whatsnew-content.ts`, the `WhatsNewCritter` changes) and the
  `HomeScreen.tsx` and `App.css` edits: desktop UI the plan leaves out.
- Package and CI hygiene: package.json `files` and `exports`, tsup, tsconfig, eslint,
  `pnpm-workspace.yaml`, `.gitignore`, the CI workflow, READMEs, `SECURITY.md`,
  `CONTEXT.md`, `docs/adr` and changesets.
- Behaviour hunks: gg-ai `openai-codex.ts` and `stream.ts`; gg-core `model-registry.ts`
  and thinking levels; `@kleio/coder`'s `auth-providers.ts`, `checklist-*`, `cli.ts`,
  the compactor test and the tool-catalog snapshot. A later PR that needs one of them
  ports it and records it.

### Verification record

Local macOS checks, each compared with `main`:

- The same behaviour surface: the 132 Tauri commands in `generate_handler!`, the 92
  sidecar routes and their 126 path literals, the 302 `cargo test` names (83 of the 84
  `lib.rs` tests now sit in their module's `tests`, so only their module path changes),
  the 9 exports and 53 public members of `AgentSession`, and `App`'s 199 hook calls with
  its 46 effects in the same order.
- Moved state is declared exactly once: 243 sidecar declarations (52 of them `let`), 22
  `AgentSession` fields and `idSeq`.
- Test totals equal `main`: `cargo test` 299 passed (3 ignored); `@kleio/coder` 317
  files and 3814 tests (17 skipped); `@kleio/manager` 31 files and 332 tests; gg-app
  152 files and 1801 tests. Seven tests that read private state or source text now
  point at the file that holds it; nothing else in a test changes.
- Identity audit, tracked and packed: 0 unclassified hits and 0 count mismatches. The
  `lib.rs`, `app-sidecar.ts` and `App.tsx` allowlist entries are re-keyed per
  destination file with exact counts that add up to the originals; alternatives that
  matched nothing on `main` are dropped. Emitted `.d.ts` files that now carry reviewed
  comments get entries from the same alternatives, and the seam counts rise by the
  tokens in the new paths. The packed `@kleio/manager` source-path count rises from 662
  to 675: the bundle and its source map name the five new `core/agent-session/`
  modules, and a bundle built from `main` has 662.
- The build, typecheck, lint, format check, bundled sidecar smoke and startup gate pass.
- Size baselines: the `@kleio/coder` build output 7098613 → 7242459 bytes and the
  app's initial JavaScript 1015645 → 1041680 bytes. `main` already sat close to both
  limits (71 bytes under for the frontend). The split adds 70.8 KiB of per-file
  overhead to the build output (import headers, source maps, declarations) and 5793
  bytes to the initial JavaScript.

## Original imported baseline

- Upstream repository: `https://github.com/KenKaiii/gg-framework`
- Upstream commit: `cde19e9e41b419546d0c167f12a3d616bdd30ccc`
- Upstream package version: `4.10.1`
- Import date: `2026-07-17`
- Immutable baseline tag: `upstream/4.10.1-cde19e9`
- Unshipped mechanical baseline: `4.10.1-kleio.0`
- Direct-rename baseline commit: `ef12845`
- Mechanical baseline tag: `kleio/mechanical-4.10.1-kleio.0`
- First publish candidate: `4.10.1-kleio.1`

The immutable upstream tag remains untouched. Commit `ef12845` directly renamed the
five package names, workspace dependency specifiers, and TypeScript import specifiers
from the upstream scope to `@kleio/*`. Its successful build and test suite establish
behavioral parity, while artifact comparisons must normalize exactly the five mappings
below and reject every other runtime delta. Version `.0` records that unshipped
mechanical baseline; it must not be published.

## Published releases

| Version          | Tag               | Commit     | Engine | npm dist-tags     | Date       |
| ---------------- | ----------------- | ---------- | ------ | ----------------- | ---------- |
| `4.10.1-kleio.1` | `v4.10.1-kleio.1` | `0c69b71e` | 4.10.1 | superseded        | 2026-08-28 |
| `5.60.2-kleio.1` | `v5.60.2-kleio.1` | `28c9162d` | 5.60.2 | superseded        | 2026-09-22 |
| `5.66.2-kleio.1` | `v5.66.2-kleio.1` | `cfa83ab7` | 5.66.2 | `latest`, `kleio` | 2026-10-30 |

All five fixed packages are published together, by hand from `main` at the tagged
commit, after `pnpm -r build`, `verify:fixed-versions` and `audit:identity:packed`.
`release.yml` only builds the desktop bundle and is gated to the upstream repository;
it never publishes npm. Both dist-tags must move: the manager auto-updater installs
`@kleio/manager@kleio`.

### Publishing note (2026-09-22)

`npm publish` printed `+ @kleio/<pkg>@5.60.2-kleio.1` for all five, yet three of
them (`ai`, `core`, `coder`) did not appear in the registry, and re-publishing
returned `409 Cannot publish over previously staged version` although
`npm stage list` was empty. This is an open registry-side bug
([npm/cli#9889](https://github.com/npm/cli/issues/9889)): the PUT is accepted and
silently dropped. Re-running `npm publish` for the missing packages, spaced about
a minute apart, eventually landed them (`E403` afterwards means "already
published", which is the good outcome). Always confirm with the raw packument
(`curl https://registry.npmjs.org/@kleio%2f<pkg>`) and a clean `npm i` into a
temporary prefix rather than trusting the publish output.

### Publishing note (2026-10-30)

[npm/cli#9889](https://github.com/npm/cli/issues/9889) recurred with `5.66.2-kleio.1`.
For `agent`, `coder` and `manager`, `npm publish` returned `E403`/`E409` "cannot
publish over previously staged version", yet all three still landed in the registry
within minutes. Checking the raw packument before each retry is what caught it.

## Package map

| Upstream              | Downstream       |
| --------------------- | ---------------- |
| `@kenkaiiii/gg-ai`    | `@kleio/ai`      |
| `@kenkaiiii/gg-agent` | `@kleio/agent`   |
| `@kenkaiiii/gg-core`  | `@kleio/core`    |
| `@kenkaiiii/ggcoder`  | `@kleio/coder`   |
| `@kenkaiiii/gg-boss`  | `@kleio/manager` |

Runtime imports and workspace dependencies use the downstream `@kleio/*` names.
The upstream names above remain only as immutable provenance for the imported
baseline.

## License and attribution

The upstream MIT license and copyright notices are retained unchanged in
[`LICENSE`](LICENSE). Downstream changes remain distributed under that license.

## Sync policy

The `upstream` Git remote is read-only. Upstream updates are imported from an
exact reviewed commit on `sync/upstream-<version>` branches. Every import records
its merge base here and in [`fork-provenance.json`](fork-provenance.json), then
passes the artifact, clean-consumer, full test, and Atlas live gates before a
fixed downstream release is promoted.
