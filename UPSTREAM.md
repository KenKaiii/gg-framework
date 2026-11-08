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

## Module split from upstream 4f763ed2 (merged)

- Upstream tip reviewed: `0e7a6382da002e8a4473f0247a7e60050cc3e9ee` (engine **5.88.1**,
  desktop **0.99.1**), 265 commits after `3f2bb6bc`. None of the 20 commits after
  `988f920e` is taken here.
- Branch: `sync/upstream-split-4f763ed2`, based on `main` at `75e3ba68`
- PR: [#74](https://github.com/fmckie/gg-framework/pull/74), merged at `c2a1ea88` on
  2026-11-03; all nine CI jobs passed on `9a18a555` (run **41488549697**). GitHub
  squashed the branch, so the downstream SHAs below are on
  `sync/upstream-split-4f763ed2`; the squash commit keeps all four trailers.
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

## Engine fixes from upstream (merged)

- Upstream tip reviewed: `7d74ada78e31873b4e1586bf9c5f7b69d1146c98` (engine **5.89.0**,
  desktop **0.100.1**), 270 commits after `3f2bb6bc`. None of the 25 commits after
  `988f920e` is taken here.
- Branch: `sync/upstream-engine-fixes`, based on `main` at `c2a1ea88`
- PR: [#75](https://github.com/fmckie/gg-framework/pull/75), merged at `9a89e75c` on
  2026-11-04; all nine CI jobs passed on `cc603c10` (run **41672298221**). GitHub
  squashed the branch, so the downstream SHAs below are on
  `sync/upstream-engine-fixes`; the squash commit keeps all ten trailers (seven
  `Ported from upstream`, three `cherry picked from commit`).
- PR 2 of the 4 in `.gg/plans/upstream-selective-import-phased.md`: engine fixes, ported
  at the paths the module split created.
- `upstream.lastImportedCommit` stays `3f2bb6bc`, for the reason given in the 988f920e
  section. Picks carry `cherry picked from commit <sha>`, ports carry
  `Ported from upstream <sha>`, and `fork-provenance.json` `selectiveImports` holds the
  full hashes.

Picked with `git cherry-pick -x`. Each applied cleanly, with the same patch as upstream:

| Upstream   | Downstream | Fix                                                                                                                                                                                                  |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c38df90e` | `672a058a` | The catastrophic-command guard catches Windows backslash paths such as `C:\Users\me`. #66 skipped it because the fork's guard then predated `3ec4e666`'s shell walker, which this import ports first |
| `0d966f84` | `ce0a104f` | Flaky MCP `maxTotalTimeout` test                                                                                                                                                                     |
| `b8627c2d` | `bec28b3f` | Racy descendant check in the persistent-shell timeout test on loaded Linux runners                                                                                                                   |

Ported by hand at the post-split paths:

| Upstream   | Downstream | Taken                                                                                                                                                                                                                                                                                                                                                                        | Left out                                                                                                                        |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `b5833186` | `fea440c4` | Unrecognized read-only checks and persistent-shell checks no longer re-open verified work                                                                                                                                                                                                                                                                                    | Critter floor, presence list and the other gg-app files                                                                         |
| `f6b906c4` | `0ae3e15b` | Destructive-git guard in `bash` and `task_send`                                                                                                                                                                                                                                                                                                                              | The rest of the commit (see below)                                                                                              |
| `3ec4e666` | `f6c2718c` | Steering interrupts running tools; `transformToolResult` and injection warnings; shell parsing in the catastrophic-command and destructive-git guards; persistent-shell recovery; git hardening; MCP idle shutdown, progress and `maxTotalTimeout`; sub-agent receipts; `wait_agent` promotion; Anthropic server-side fallback; invalid tool calls dropped; truncation notes | Cache expiry, the truncation-note bench, the `HookNotice.tsx` test hunk, every gg-app, icon and installer file                  |
| `95a8d41b` | `02f58d4a` | gg-app: links and files the app opens leave no zombie process (`open` 5.3.5, which `tauri-plugin-opener` already builds; the iPhone keeps the plugin), and every link goes through `open_url`. `edit` recovers a split `edits` argument                                                                                                                                      | Repo-poll sharing, window motion, the Anthropic thinking change, critter and CSS files, `open_image_data`                       |
| `6325d417` | `e4d40659` | Folder changes reach the model through the environment update; runtime notices continue the turn; pruning waits for half the compaction trigger                                                                                                                                                                                                                              | The `cache-diagnostics.ts` `noteEdit` lines, the goal-worker part                                                               |
| `420b1ad3` | `66bddfb0` | A refused check is re-run once on its own; three reply sentences in the How to Talk section                                                                                                                                                                                                                                                                                  | `renderWorkSection`, `Precedence:` and style-pack wording, the `bash.ts` hunks, `provider-fetch.ts` (#66 took it as `bcec266c`) |
| `705af903` | `e19afa38` | Hedged first event for agent streams                                                                                                                                                                                                                                                                                                                                         | The `bash.ts` wording and `Precedence:` line, Royale, every gg-app file, the skills refresh                                     |

Moved to a later import, because they edit or need code the fork doesn't have yet:

- The rest of `f6b906c4`: the keep-awake toggle, stream rules, ask_user deadlines, shell
  and package threat guards, plan-step compaction, `prewarm()`, patches and workspace
  pins.
- `3ec4e666`'s cache expiry: it reads `d83252b9`'s `CacheDiagnostics` and records cache
  touches in `f6b906c4`'s `prewarm()`.
- `6325d417`'s `noteEdit` lines in `cache-diagnostics.ts`, which `d83252b9` creates, and
  its goal-worker part (goals-store, subagent-manager and subagent-worker-mode, with their
  tests), which comes with Goals (`46e534bc`).
- `420b1ad3`'s `renderWorkSection` lines, `Precedence:` line and style-pack wording, which
  edit `987257de`'s text, and its `bash.ts` hunks, which remove a check note that
  `fad77086` adds.
- `705af903`'s `bash.ts` wording and `Precedence:` line, which edit `987257de`'s text.

Not taken:

- `b5833186`'s critter floor modules, presence list, `App.css`, `AttachmentBar.tsx` and
  `ReferencedFiles.tsx`: desktop UI and critter art.
- `3ec4e666`'s gg-app, icon and installer files: the desktop half. Its verification-flow
  test hunk reads `gg-app/src/HookNotice.tsx`, which that half creates, and
  `scripts/truncation-note-bench.ts` is a local benchmark.
- From `95a8d41b`:
  - Repo-poll sharing (one git, GitHub and CI poller per repo instead of one per window):
    a desktop-sidecar efficiency change, not a fix.
  - Window motion and its users, the critter files and the CSS: desktop UI.
  - The thinking change in gg-ai `transform.ts`: the fork sends no `display`, so adaptive
    models already get omitted thinking (Opus and Sonnet 4.6 keep their summarized
    default, which the terminal UI shows).
  - The `open_image_data` hunk, because the fork has no such command, and upstream tests
    for files the fork lacks.
- `705af903` beyond hedged streaming: Royale (the sidecar's `royale*.ts`, the Royale
  screen, `commands/royale.rs` and its window wiring), the pixel-art home and lounge, the
  skills refresh (the bundled skills change with `21adf945` and `7302fa5a` instead) and
  `GG-ROYALE-PRIVACY.md`.
- The five upstream changesets, from `6325d417` and `420b1ad3`.
- The 5 commits after `0e7a6382`. `adea7972` (`!` terminal commands and local images in
  replies) and `9403d456` (a macOS 27 crash guard for AppKit exceptions under tao's
  `sendEvent:`) touch files this import edits, and wait for a decision, as do
  `a2ca7720`, `c73b1866` and `856bf0eb` from before `0e7a6382`. `fdf124c8`, `1cd794ff`
  and `7d74ada7` are version commits.

Changesets: `.changeset/upstream-engine-fixes-ai.md`, `-agent.md` and `-coder.md`
(patch); `@kleio/core` and `@kleio/manager` follow through the fixed group. gg-app is not
a changesets package, so its opener fix (`95a8d41b`) is recorded only here.

### Verification record

Local macOS checks, each compared with `main` at `c2a1ea88`:

- Test totals rise by the ported tests alone, and no test file loses a test:
  `@kleio/ai` 406 → 495 tests (22 files), `@kleio/agent` 172 → 194 (10 files) and
  `@kleio/coder` 3814 → 4133 (323 files; 17 skipped, as on `main`). gg-app (152 files,
  1801 tests) and `@kleio/manager` (31 files, 332 tests) are unchanged, and `pnpm test`
  passes in all 12 packages with tests. Two upstream tests replace older ones, as
  upstream did: a timeout now keeps the persistent shell (`3ec4e666`), and `/add-dir`
  mid-conversation reaches the model through the environment update (`6325d417`).
- `cargo test`: 301 passed and 3 ignored, the 302 names on `main` plus
  `spawn_reaped_leaves_no_zombie` and `open_url_accepts_only_web_mail_and_phone_schemes`.
  `cargo clippy --all-targets` has no warnings, as on `main`, and
  `cargo check --lib --target aarch64-apple-ios` builds the iPhone opener paths.
- Beyond the hunk maps, three gg-app tests (`ConnectionPage`, `voiceCall`, `voiceTools`)
  mock `../agent`, which they now reach through `ConnectionPage` and `safeUrl`, and a
  `kleio/link.rs` test holds the new test-only `SPAWN_LOCK`: on macOS a child mid-spawn
  holds the parent's descriptors, which kept a closed listener answering.
- The tool-catalog snapshot is unchanged. The golden prompt changes only lines 9, 13 and
  19, the three How to Talk sentences.
- No gg-app file imports `@tauri-apps/plugin-opener`. The excluded packages, the `three`
  lines and `upstream.lastImportedCommit` are unchanged. The critter-art checks match only
  the "data URI image" case in `injection-detect.test.ts`.
- Identity audit, tracked (3108 files) and packed (2152 files): 0 unclassified hits and 0
  count mismatches. The Coder source-directory seam rises from 1549 to 1559 for the ten
  new Coder files. Manager's packed Coder paths rise from 675 to 684 with the new modules,
  then drop to 683 once `95a8d41b`'s `edit.ts` import reorders Manager's bundle and one
  module comment goes.
- The build, typecheck, lint, format check, the tracked script tests (143), the
  fixed-version check, the bundled sidecar smoke and the startup gate (498 ms) pass.
  `gg-app/scripts/kleio-identity.test.mjs` imports vitest, so it runs in gg-app's suite
  (5 tests); `node --test` cannot load it, on `main` either.
- Size: the `@kleio/coder` build output grows from 7092.4 KB on `main` to 7349.0 KB. It
  goes over the 7214.2 KB limit at `3ec4e666`'s port, so that commit re-baselines the
  build output at 7318.5 KB. The bundled sidecar (8373.7 KB) and the initial frontend
  JavaScript (1017.0 KB) stay within their budgets.

## Agent tools and prompts from upstream (merged)

- Upstream tip reviewed: `af5b1df4a46a8a308a147afe17bd4a084e958fa7` (engine **5.91.1**,
  desktop **0.102.1**), 287 commits after `3f2bb6bc`.
- Branch: `sync/upstream-agent-tools`, based on `main` at `9a89e75c`
- PR: [#76](https://github.com/fmckie/gg-framework/pull/76), merged at `bf328196` on
  2026-11-04; all nine CI jobs passed on `082ad689` (run **41918584286**). GitHub
  squashed the branch, so the downstream SHAs below are on
  `sync/upstream-agent-tools`; the squash commit keeps all 28 trailers (23
  `Ported from upstream`, 5 `cherry picked from commit`).
- PR 3a of the 4 in `.gg/plans/upstream-selective-import-phased.md`: agent tools and prompts,
  in upstream date order. PR 3b (models, providers, gg-safe and skills) follows from `main`
  at `bf328196`.
- `upstream.lastImportedCommit` stays `3f2bb6bc`, for the reason given in the 988f920e
  section. Picks carry `cherry picked from commit <sha>`, ports carry
  `Ported from upstream <sha>`, and `fork-provenance.json` `selectiveImports` holds the
  full hashes.
- Every commit taken is an ancestor of `c1aa287b` (desktop v0.102.0), upstream's last
  release under MIT. See the licence note below.

Picked with `git cherry-pick -x`. Four have the same patch as upstream. `5798596e`'s two
`app-sidecar.ts` hunks land in the fork's `app-sidecar/json-mode.ts`. `05091704` comes
last, out of date order, because #76's Windows CI failed without it:

| Upstream   | Downstream | Fix                                                                                 |
| ---------- | ---------- | ----------------------------------------------------------------------------------- |
| `01080940` | `6e81833e` | Debug tool breakpoints and paths on Windows when the temp dir uses 8.3 short names  |
| `bacbe7fc` | `853d9ed7` | Debug breakpoints on Windows also bind by the exact script URL Node reports         |
| `5798596e` | `89b69fff` | The sidecar JSON mode accepts `--thinking`, which fixes a desktop subagent crash    |
| `0b1db863` | `203bdb87` | Windows checklist writes no longer fail while a released lock dir is pending delete |
| `05091704` | `23ecd649` | The cat-read credit test from `223830dc` no longer hits `EBUSY` on Windows          |

Ported by hand:

| Upstream                           | Downstream | Taken                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f6b906c4`                         | `be4ff814` | Keep-awake (a plain Settings checkbox), stream rules, ask_user soft deadlines, shell and package-install threat guards, plan-step compaction, the session summary index and Anthropic cache prewarm. #75 took the destructive-git guard |
| `d83252b9`, `3ec4e666`, `6325d417` | `177ea66b` | Cache diagnostics, batch image pruning and cache expiry, with the expiry and `noteEdit` lines #75 deferred                                                                                                                              |
| `6c63a63e`                         | `436ea998` | `debug` tool, acceptance checks, test-impact and repair hints, and the model-unavailable fallback                                                                                                                                       |
| `dd9eec26`                         | `66d7f317` | Codex request-shape settings, Gemini exclusive bounds and prompt trims                                                                                                                                                                  |
| `223830dc`                         | `456a6e7e` | Read-evidence slice only: `cat` output counts as a read, and edits need no prior read. Taken now rather than with the rest of `223830dc` in PR 4, because `7ecf304c` and `ecf0319f` build on it                                         |
| `7ecf304c`                         | `1ab28b2e` | Multi-file edits, and prompt changes from upstream's replay tests                                                                                                                                                                       |
| `4b63cdd2`                         | `06457714` | Project checklist, error recovery and verification review                                                                                                                                                                               |
| `8b0847d4`                         | `1e399702` | OpenAI Ultra reasoning and delegation, as in Codex                                                                                                                                                                                      |
| `c617d8ab`                         | `67ee4d17` | Stale cancelled status after a new session, and attachment send races                                                                                                                                                                   |
| `fad77086`                         | `343eb833` | Quieter verification feedback; `steroids` and `subagent` become deferred                                                                                                                                                                |
| `420b1ad3`                         | `03d23247` | Part 1: the refused-check note leaves `bash` (hunks #75 deferred)                                                                                                                                                                       |
| `85cd5ce2`                         | `252ef101` | Plans no longer stall awaiting approval                                                                                                                                                                                                 |
| `74f032cd`                         | `5f79388f` | Claude Haiku 5.5, summarized thinking and Codex reasoning sections                                                                                                                                                                      |
| `987257de`                         | `73974bbd` | Prompt diet, deferred tools and stale checklist results                                                                                                                                                                                 |
| `420b1ad3`                         | `556213ad` | Part 2: Work-section, Precedence and style-pack wording (lines #75 deferred)                                                                                                                                                            |
| `705af903`                         | `c955a8fc` | Kill-by-PID wording in `bash` and the Precedence line (lines #75 deferred)                                                                                                                                                              |
| `60a24958`                         | `0f472e83` | `embed()`, `rerank()` and `providerOptions`. #66 took the fetch passthrough                                                                                                                                                             |
| `46ca49ce`                         | `15f2351e` | Checks with read-only commands around them count as verification                                                                                                                                                                        |
| `ba56ec5c`                         | `76a95c14` | Flat edit schema for Claude, and more malformed edit calls recovered                                                                                                                                                                    |
| `0a5be0d3`                         | `c4a8dc07` | Built-in `/commit`; unchecked replies are no longer flagged as Unverified                                                                                                                                                               |
| `ecf0319f`                         | `240e6b38` | `write` overwrites and reports unseen lines; `sed -n` and `head` views count as reads                                                                                                                                                   |

Already in the fork, so no commit here: `3cca7462`. #66 took its cache half as `2eabe6e7`
(the working directory stays out of the cached system prompt), and `420b1ad3` (part 2
above) replaced its two Work bullets.

Moved to a later import:

- PR 4, with motion, Goals and the rest of `223830dc`: the hyperframes patch hunks and
  workspace pins from `f6b906c4` and `d83252b9`, with their motion-agent and Motion-check
  hunks; `6c63a63e`'s `critter-tool-kind.ts`; `dd9eec26`'s motion skill files and
  `motion-prompt.ts`; `7ecf304c`'s `motion-review-session.ts` hunk; everything in
  `223830dc` beyond the read-evidence slice, including the skills-routing test `987257de`
  carries; and `6325d417`'s goal-worker part.
- PR 3b: `705af903`'s `tools/skill.ts` lines, with the skills refresh (`21adf945`,
  `7302fa5a`); plan rows 24–46; and the commits after `7d74ada7` that PR 3b takes
  (`cf6c9a23`, `a4bb110c`, `0ba57296`, `0a9d083f` and `5d340fa3`'s non-Goals part).

Not taken:

- Desktop design, which the fork owns: see the UI boundary below. `eb0692b1` is checklist
  colours and icons only.
- `74f032cd`'s footer short names in `@kleio/manager` (which stays unchanged in every
  import PR), and the fork-only `session-title.ts`.
- Hunks a later upstream commit replaced or removed: `0a5be0d3`'s Work bullet, and
  `46ca49ce`'s `bash.ts` hunks for the refused-check note. `420b1ad3` replaced the first
  and removed the note.
- The `scheduled` send flag from `f6b906c4` and `4b63cdd2`, and `4b63cdd2`'s
  `live-text.ts` import: their upstream commits aren't in the fork, and routines fire from
  the daemon here.
- The upstream changesets.
- The licence-boundary commits: see the licence note below.
- Waiting for a decision: `c86b56db` (`@anthropic-ai/sdk` 1.x and `openai` 7.50, major
  bumps, as its own dependency PR after PR 3b), and `a2ca7720`, `c73b1866`, `856bf0eb`,
  `adea7972` and `9403d456`, as recorded for #75. `ba968f9a`, `c8ac6c45`, `3c7ae0d5` and
  `c1aa287b` are version commits.

Changesets: `.changeset/upstream-agent-tools-ai.md`, `-agent.md`, `-core.md` and
`-coder.md` (patch); `@kleio/manager` follows through the fixed group. gg-app is not a
changesets package, so its changes are recorded only here.

### UI boundary

The fork owns the desktop design, and a redesign is under way on its own branch. From
upstream's gg-app hunks this import takes behaviour only: state, data flow, `invoke` and
event wiring, error handling and race fixes. New screens render through minimal components
in `gg-app/src/placeholder/`, styled only with `kleio-theme.css` variables. The redesign
branch restyles them after rebasing, using this list.

New files:

| File                                        | Replaces upstream       | Takes                                                                                                           | Mounted in          |
| ------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| `placeholder/placeholder.css`               | —                       | Theme variables only                                                                                            | —                   |
| `placeholder/StatusDot.tsx`                 | `ErrorCritter.tsx`      | A tone (error, warning or earlier) and a text label                                                             | `ErrorNotice.tsx`   |
| `placeholder/ChecklistView.tsx` (+test)     | `ChecklistScreen.tsx`   | The checklist snapshot from `agent.ts`, the item being checked, and run and retry callbacks                     | `App.tsx`           |
| `placeholder/ErrorNotice.tsx` (+test)       | `ChatErrorNotice.tsx`   | A `chat-error.ts` payload, whether it is the latest error, and a model-picker slot. It holds the details toggle | `TranscriptRow.tsx` |
| `placeholder/CacheExpiryNotice.tsx` (+test) | `CacheExpiryNotice.tsx` | The cache-expiry status, the running flag and a compact action                                                  | `Composer.tsx`      |

New logic and test files, with no rendering of their own: `chat-error.ts`,
`agent-checklist.test.ts`, `prompt-labels.test.ts`, `App.checklist.test.tsx`,
`App.attachments.test.tsx` and `App.plan-review.test.tsx`.

Changed existing files, in logic, props and text: `App.tsx`, `AskBand.tsx` (+test),
`Composer.tsx`, `LazySettingsModal.test.tsx`, `ModelSelect.tsx` (+test),
`SettingsModal.tsx`, `SettingsTabBar.tsx` (+test), `TranscriptRow.tsx`,
`WorkspaceHeaderActions.tsx`, `agent.ts`, `ask-user.ts`, `composer-refocus.ts` (+test),
`kleio/keepAwake.ts` (+test), `prompt-labels.ts`, `task-activity.ts` (+test),
`task-outcome-matrix.test.ts`, `tool-format.ts`, `transcript-item.ts`,
`useAgentEvents.ts` (+test), `useAttachments.ts`, `useAutopilot.ts`, `useFileDrop.ts` and
`useKenMentor.ts` (+test). Rust: `auth.rs`, `commands/agent.rs`, `keep_awake.rs` and
`lib.rs`. Two markup changes come with the new behaviour:

- `App.tsx` adds a Checklist button with the fork's existing `btn btn-sm btn-ghost`
  classes. It also wraps the transcript in React's `<Activity>`, so the checklist view can
  hide the chat and keep its state. The transcript's own classes are unchanged.
- `TranscriptRow.tsx` replaces its error row, and that row's inline styles, with
  `ErrorNotice`.

Not taken, because the fork owns the design: upstream's `App.css`, `ChatErrorNotice.css`
and `ChecklistScreen.css` hunks; `KeepAwakeButton.tsx`, `ChatErrorNotice.tsx`,
`ChecklistScreen.tsx` and `ErrorCritter.tsx`, with their tests;
`scripts/checklist-css.test.mjs`; `App.tsx`'s layout hunks (the header, frame and footer
rearrangement and the moved plan-mode badge); the cache-expiry notice's exit motion; the
error details' dissolve and exit animation; and `eb0692b1`.

### Licence note

This is engineering guidance, not legal advice.

Upstream relicensed from MIT to the GNU Affero General Public License, version 3.0 only, in
`12da5c3a` (2026-11-04). Its new NOTICE files say that releases up to and including
desktop v0.102.0 and npm 5.91.0 were published under MIT. The fork is MIT, so this import
takes only commits that are ancestors of `c1aa287b` (desktop v0.102.0; npm 5.91.0 is
`c8ac6c45`). No `LICENSE` or `NOTICE` file changes.

Not taken:

- Licence unclear, for a lawyer: `85cb0ef7`, `8020944e` and `8627ee65`. They were
  committed before the relicense but first released in 5.91.1 and v0.102.1, which ship
  under the new licence. `0d443e0f`, which is CSS only, is in the same position.
- `12da5c3a` itself (the relicense, the NOTICE files and the About-page source link), and
  every later upstream commit (so far `02375294` and `af5b1df4`, both version commits),
  until a decision on how the fork handles upstream code under the new licence.

Backlog for a lawyer, older than this import:

- The npm packages ship no licence file. `npm pack --dry-run` of `@kleio/ai` lists 8 files
  and no `LICENSE`, and no `packages/*` folder has one. MIT asks for the notice in copies.
- Upstream's NOTICE credits creativeprofit22 for the WSL-to-Windows-host audio playback in
  `core/radio.ts` (`isWsl` and `tryPlayOnWindowsHost`, under MIT). The fork has both
  functions and no matching credit.

### Verification record

Local macOS checks, each compared with `main` at `9a89e75c`:

- Test totals rise by the ported tests, and no test file loses a test: `@kleio/ai` 495 → 590
  tests (22 → 25 files), `@kleio/agent` 194 → 226 (10 → 12 files), `@kleio/core` 256 → 272
  (15 files), `@kleio/coder` 4133 → 4699 (323 → 354 files; 17 skipped, as on `main`) and
  gg-app 1801 → 1876 (152 → 160 files). `@kleio/manager` (31 files, 332 tests) is unchanged,
  `pnpm test` passes in all 12 packages with tests, and every file in the plan's PR 3a test
  list runs and passes.
- `cargo test`: 302 passed and 3 ignored, the names on `main` plus
  `accept_plan_error_surfaces_sidecar_message_or_status` (`85cd5ce2`).
  `cargo clippy --all-targets` has no warnings, as on `main`.
- The golden prompt matches upstream's at `ecf0319f` except #75's Replies rules (lines 5, 6
  and 8) and the lines this import takes from later upstream commits with #75's deferred
  hunks: `420b1ad3`'s security, Work and Precedence lines and `705af903`'s Precedence
  sentence and `bash` wording. Line 1 changes only in `73974bbd` (`987257de`), and
  `cleanInstructionText` still runs in `collectProjectContext`.
- The tool catalog matches upstream's at `ecf0319f` except `bash` (`705af903`'s wording) and
  `checklist`, which has no `accepted` findings field or `senior-review` item. Both come
  from `c346f81f`, in the desktop UI range the plan leaves out.
- `verification-evidence.ts` calls `classifyStrict` where upstream does (lines 312, 774, 783
  and 800).
- Identity audit, tracked (3205 files) and packed (2254 files): 0 unclassified hits and 0
  count mismatches. Each count moves in the commit that changes it: the Coder
  source-directory seam 1559 → 1622 for the new Coder files, Manager's packed Coder paths
  683 → 744, `autopilot-cycle.ts` 5 → 4 (its packed declarations 4 → 3), a Manager chunk
  source map 63 → 62, `useKenMentor.ts` 3 → 2 and the allowlist's own control data 1540 →
  1546, plus two new one-hit entries for `app-error*.ts` and `CONTEXT.md`.
- The build, typecheck, lint, format check, the tracked script tests (143), the
  fixed-version check, both CLIs' `--help` and `--version`, the bundled sidecar smoke and
  the startup gate pass. Its median across three runs is 496–575 ms (498 ms on `main`;
  the budget is 5000 ms). `gg-app/scripts/kleio-identity.test.mjs` runs in gg-app's suite
  (5 tests), as #75 notes.
- Size: the `@kleio/coder` build output grows from 7349.0 KB on `main` to 7887.1 KB, the
  bundled sidecar from 8373.7 KB to 8507.8 KB and the initial frontend JavaScript from
  1017.0 KB to 1041.6 KB. Nothing test-related is in the build output, and the 32 new Coder
  modules, with their maps and declarations, make up 415 KB of its growth. Three ports
  re-baseline where an artifact first crosses its limit: `be4ff814` (`f6b906c4`) the build
  output at 7682882 bytes; `436ea998` (`6c63a63e`) the build output at 7877156 and the
  sidecar at 8678607; and `06457714` (`4b63cdd2`) the build output at 8057866 and the
  initial JavaScript at 1065082.
- Licence: every picked or ported upstream commit is an ancestor of `c1aa287b`, no `LICENSE`
  or `NOTICE` file changes, and no added line names the new licence.
- UI: no CSS changes outside `gg-app/src/placeholder/`, `placeholder.css` uses theme
  variables only, the 14 new gg-app files are the ones listed under UI boundary, and only
  `App.tsx`, `Composer.tsx` and `TranscriptRow.tsx` import from `placeholder/`.
- `patches/`, `pnpm-workspace.yaml`, the package manifests and the lockfile are unchanged,
  as are the excluded packages, the `three` lines and `upstream.lastImportedCommit`. The
  critter-art checks match only upstream's image fixture in `App.attachments.test.tsx`
  (`c617d8ab`), whose preview data URI holds the ten bytes "screenshot".

## Models, providers, gg-safe and skills from upstream (merged)

- Upstream tip reviewed: `296df256b164ec18a4cc72ec7a824633da245bcb` (engine **5.91.2**,
  desktop **0.102.2**), 290 commits after `3f2bb6bc`. Upstream has since moved 9 commits
  further, to `f6b17fc5` (desktop **0.103.1**). All nine come after the relicense, and this
  import doesn't review them.
- Branch: `sync/upstream-models-safety`, based on `main` at `bf328196`.
- PR: [#77](https://github.com/fmckie/gg-framework/pull/77), merged at `7150a676` on
  2026-11-08; all nine CI jobs passed on `ae265c0e` (run **42511087761**). GitHub
  squashed the branch, so the downstream SHAs below are on
  `sync/upstream-models-safety`; the squash commit keeps all 32 trailers (23
  `Ported from upstream`, 9 `cherry picked from commit`).
- PR 3b of the 4 in `.gg/plans/upstream-selective-import-phased.md`: models, providers,
  gg-safe and skills. Its first commit, `97398b68`, records #76 as merged. Plan rows 24–46
  follow in order, then `cf6c9a23`, `a4bb110c`, `0ba57296`, `0a9d083f` and the non-Goals
  half of `5d340fa3`.
- `upstream.lastImportedCommit` stays `3f2bb6bc`, for the reason given in the 988f920e
  section. Picks carry `cherry picked from commit <sha>`, ports carry
  `Ported from upstream <sha>`, and `fork-provenance.json` `selectiveImports` holds the full
  hashes on both sides.
- Every commit taken is an ancestor of `c1aa287b` (desktop v0.102.0), upstream's last
  release under MIT. See the licence note below.

The 30 upstream commits taken, in branch order. A pick is `git cherry-pick -x`, with
upstream's author and date, and has the same patch as upstream unless its row says
otherwise. A port is made by hand and takes the whole commit except design, README and docs
hunks, which the lists below name. A partial port also leaves code out, which its row and
the lists below name.

| Upstream                                   | Downstream | Method             | Taken                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `9d7cbe6dc99eeb65c3b016103fd2cc62215b254b` | `2b3c506a` | Partial port       | Auth providers move to `@kleio/core`, the sidecar's git-target code splits out, and settings and teardown races are fixed. Its Goals hunks go to PR 4                                                                                                                                                                                                        |
| `f9da5393f82fb585d23b947a6f87f121e28df4b8` | `99da3f78` | Port               | `grep` scans on worker threads, with byte prefilters, pruned walks and a 100,000-file cap                                                                                                                                                                                                                                                                    |
| `ae156b90df060cb366552b608aebc66c4fa323d8` | `3f215516` | Pick               | The grep deadline test drives its budget with a fake clock instead of real time                                                                                                                                                                                                                                                                              |
| `d9ad9050bbdcc6d3aaa7a88b512244b9c4705867` | `475eaf2a` | Partial port       | Claude Opus 5.5 fast and Codex GPT-6 fast through subscription logins. Opus 5.5 fast's thinking default goes to PR 4                                                                                                                                                                                                                                         |
| `bc7e5733a25fc9cb1e51ed93b72407a5c7a5eb6f` | `fadf0be7` | Partial port       | Paid Claude fast mode asks before switching (`PaidModelConfirm`), and credit errors say what happened. Keeping Goals workers off paid models goes to PR 4                                                                                                                                                                                                    |
| `a083cf12c4525807d6d2c8a499a28e2c55b39cde` | `7c949498` | Port               | MiMo UltraSpeed counts as paid, and a fallback never moves onto a paid tier                                                                                                                                                                                                                                                                                  |
| `494374d7941d25cbba6afd5c571187de64ab0c5d` | `2eef3b38` | Partial port       | The engine half of waking on background failures: failure detectors, the `task_output` wake, urgent notifications and `IdleWakeController`. Its sidecar wiring reads Goals state and goes to PR 4                                                                                                                                                            |
| `5a3c24b349492e5888ccae3c8c9b1efb795941f1` | `fb27b92c` | Partial port       | Model settings follow vendor evidence, and Gemini's personal-account cutoff is explained. A reworded Sonnet 5.5 comment goes to PR 4                                                                                                                                                                                                                         |
| `67f5a4be8d261f52ec7cc5f9725c9c63fb801d2c` | `14aaa85c` | Port               | A Gemini API key login for accounts Code Assist no longer serves                                                                                                                                                                                                                                                                                             |
| `67e957c87e1eaf6fbdd200286e9dc635c2798f80` | `5a0d6276` | Pick               | The ModelSelector test waits for each key's re-render                                                                                                                                                                                                                                                                                                        |
| `d493df831d3bfe5c7ef3fbda7169ba3e267e93ad` | `947238b0` | Port               | Grok on xAI's Responses API, replaying encrypted reasoning. #66 took the fetch-cap half (`ef690ba3`), and the fork keeps `undici` 7.29.1                                                                                                                                                                                                                     |
| `a69cc275a86d02f31831c280755f335e5b7a117f` | `b0eebc5b` | Partial port       | Slow git is no longer reported as "not a repo", and the Windows verification-flow tests are hardened. The goal-window git hunks go to PR 4                                                                                                                                                                                                                   |
| `c08602e981a735fba7952260d2de3b353884d1ed` | `2752e67a` | Port               | Anthropic web search loads on demand, `grep` groups its output by file, compressed tool output is capped, and the Claude Code version is prefetched                                                                                                                                                                                                          |
| `d7419c46d0b372a1f3c888fa34703e4a826aa0db` | `02a99b7c` | Port               | The gg-safe security layer: package malware and cooldown guards, a daily threat feed, skill and MCP scanning, action guards and blocked-package notices                                                                                                                                                                                                      |
| `5546cce95624cb2c1c94c323344ca747c1d2f6d5` | `eaa8b64c` | Pick               | No Windows teardown race in the safety mode tests                                                                                                                                                                                                                                                                                                            |
| `5db7ab615b72663a4e94082f6aec98b3926917b3` | `3c63ee41` | Port               | An install of a version with a HIGH or CRITICAL advisory moves to the newest fixed release in the same major version                                                                                                                                                                                                                                         |
| `67b47a83ebb43e4e2bcc2eea8ddb1b4db1d6e133` | `dd46dacb` | Pick               | The safety mode test polls for the blocked-packages list instead of waiting a fixed 150 ms                                                                                                                                                                                                                                                                   |
| `0b9dbe96e6ba818d6119d50150c8c091dbf2b06a` | `ccc572e3` | Port               | Unresolved deferred `web_search` calls are no longer replayed to Anthropic. #66 took the lost-messages half (`73ab3385`)                                                                                                                                                                                                                                     |
| `1c91814c243acfbe7a797fbd5adaecb3091b19b6` | `45be349e` | Port               | Grok's HTTP 426 is fixed, Gemini is hidden (see below), `getListedModels` leaves out hidden providers, and routine bash output is compacted                                                                                                                                                                                                                  |
| `ba10f31b4a9891185a0e59dcc7fed6b61fa28650` | `01e47106` | Port               | Each code change is one `bash` command, and the first prompt lists the project's files                                                                                                                                                                                                                                                                       |
| `5315a8a259c94bbcec26b4a01a6f788c66e3fb39` | `9a150219` | Pick               | The threat feed cache no longer serves a stale feed when a rewrite keeps the same mtime                                                                                                                                                                                                                                                                      |
| `705af9035f11d9c5c925cf64cb8a90071b035d98` | `ae5cb990` | Partial port       | The `tools/skill.ts` delegation and host rules that #76 left for the skills refresh                                                                                                                                                                                                                                                                          |
| `21adf9451460b367aef6d880dcce0c7a2aac8771` | `c065296a` | Partial port       | Bundled skills are cut to `compliance-guard` and `durable`, with `bulletproof` and `lean` hidden for Checklist audits; the skill name is required; `code_search` and `code_nav` are removed                                                                                                                                                                  |
| `7302fa5a555077476ca5695698ad84bd52215705` | `75e7bce3` | Port               | The `find-skills` seed and `/setup-skills` are retired, with a light-comments prompt rule and sharper skill descriptions                                                                                                                                                                                                                                     |
| `856bf0ebe8ea3d292e283ad45dbb14e28b6ae124` | `b2bd8d28` | Partial port       | Only the web-search history fix: a restored Anthropic session with native web search no longer fails with HTTP 400. Taken ahead of `cf6c9a23`, which needs it                                                                                                                                                                                                |
| `cf6c9a2327397b573d47762536aad7ab56501ed4` | `b651552f` | Partial port       | Anthropic web search as a Claude Haiku 5.5 side request, `web_fetch` offsets, a 30,000-byte bash offload, local-model fixes and the `steroids` changes. Language style packs and `setup-history.ts` are removed                                                                                                                                              |
| `a4bb110c4149a196d5a69d10a595f3f78a8ac723` | `5c81b468` | Pick               | `steroids` guidance drops the STALE refresh prompts and frames the tool as current open-source code                                                                                                                                                                                                                                                          |
| `0ba5729617b4a825127db49494ea0fbfae19303a` | `2c4fea82` | Pick               | The sidecar auth-broadcast test prints the sidecar log when it fails                                                                                                                                                                                                                                                                                         |
| `0a9d083f14789bf94da17d6be33b35bcf3c4e23a` | `9bba7a1f` | Pick (3 conflicts) | MiniMax M3.1 Flash becomes MiniMax's default, and MiniMax and Xiaomi Token Plan keys go to the region that issued them. Conflicts resolved: `errors.ts` names the product only through the caller's display profile (one test added), the fork's `getDefaultModel` line stands in for upstream's `DEFAULT_MODEL_IDS` table, and the `@kleio/ai` import stays |
| `5d340fa3bc1be03d3200b40cfbe8f8abfb5551bf` | `5ee0bfca` | Partial port       | The non-Goals half: a setting a build rejects falls back on its own, unknown keys are kept, settings save atomically, and the desktop sidecar waits for the saved local model at boot                                                                                                                                                                        |

**Gemini stays hidden.** `1c91814c` hides the Gemini provider with
`HIDDEN_PROVIDERS = ["gemini"]`, and the fork keeps it hidden, as upstream does. This is the
owner's decision: using Gemini through third-party tools risks Google flagging or banning
the account. Existing Gemini logins stop working. To re-enable Gemini, remove `"gemini"`
from `HIDDEN_PROVIDERS` in `packages/gg-core/src/hidden-providers.ts` and in
`gg-app/src-tauri/src/auth.rs`.

Left out of the partial ports, and the dependency bump:

- `856bf0eb`: only its web-search history fix is taken (`historyUsesNativeWebSearch` and its
  two regression tests). Its duplicate sub-agent completion notice fix
  (`subagent-manager.ts` and its test) and its desktop checkpoint pruning (`app-sidecar.ts`)
  stay flagged, waiting for a decision, and are not taken.
- `5d340fa3`: its Goals half moves to PR 4, as row 20 of the phased plan: `goals-store.ts`
  and `goals-agent.ts` with their tests, `prompt-routes.ts`, `route-context.ts`,
  `app-sidecar.ts` hunks 2, 4, 5 and 9, and the "starting a goal by typing" test. This
  import takes `config.ts`, `settings-manager.ts` and its new test, `app-sidecar.ts` hunks
  1, 3, 6, 7 and 8, and two auth-broadcast tests.
- `c86b56db` (`@anthropic-ai/sdk` 1.x and `openai` 7.50) is not taken. Nothing here needs
  it: `0a9d083f`'s conflicts resolve without it, and `@kleio/ai` stays on
  `@anthropic-ai/sdk` ^0.124.0 and `openai` ^7.13.0. It stays a dependency PR of its own,
  after this one.
- `cf6c9a23`: `openai.ts`'s `maxRetries: 0`, and `transform.ts`'s blocking-tool cache TTL
  and `tool_reference` handling, need `c73b1866`, which is flagged, so they are not taken.
  Its `steroids` text is taken as upstream wrote it, including `c73b1866`'s shorter wording,
  by the owner's decision. The 1,800-character limit in `system-prompt.test.ts` is
  unchanged. Its `.gitignore` hunk is not taken, and neither is its `LoginScreen.tsx` hunk
  with its test, which renames the Ollama tile to Local models: the tile is the fork's own
  design, so it still says Ollama while the dialog it opens is now called Local models. Its
  `SettingsScreen.tsx` hunk with its test, `ModelPanel.tsx` and `model-search.ts` have no
  counterpart in the fork.
- `9d7cbe6d`: upstream's removal of the manager package (the fork keeps it as
  `@kleio/manager`), and the `ci.yml` FFmpeg retry: `.github/workflows` is a protected
  directory in `scripts/upstream-sync-policy.json`, and `verify-ci-candidate.test.mjs` pins
  that step, so it needs its own CI change.

Moved to PR 4 (Goals and motion), as rows in the phased plan:

- `9d7cbe6d`: the goal finish card (with `useAgentEvents.ts`'s run summary and its test, and
  `ActivityBar.tsx`'s `formatElapsed` export), the GoalWorld and `goal-routes.ts` hunks,
  `resolveGitCwd` and its test, and the goal-window auth-broadcast test.
- `bc7e5733`: `goal-routes.ts` refuses a paid model for Goals workers, and `goals-agent.ts`
  runs workers on `withoutPaidTier(model.id)`.
- `494374d7`: the `app-sidecar.ts` wiring that starts the idle wake, which reads Goals state
  (row 12). Until it lands, the desktop app doesn't wake an idle agent on a background
  failure.
- `a69cc275`: `resolveGitCwd`'s settled flag, `retargetGit`'s re-read and the goal-window
  git test (row 12).
- `d9ad9050` and `5a3c24b3`: `claude-opus-5-5-fast`'s `defaultThinkingLevel` and the
  reworded Sonnet 5.5 comment, with `127ec0a9` (row 7).
- `21adf945`: the `critter-tool-kind.ts` and `goal-team.ts` hunks, `223830dc`'s skill-root
  brief and the routable-skills test.
- `5d340fa3`: the Goals half, listed above (row 20).

Not taken:

- Desktop design, which the fork owns: see the UI boundary below.
- README hunks (`c08602e9`'s provider table, `5a3c24b3`'s Gemini row, `ba10f31b`'s benchmark
  tables and `21adf945`'s provider and tools tables), `docs/skills-refresh.md`, and the
  trophies hunks in `21adf945` and `7302fa5a` (the fork has no trophies).
- `705af903`'s `SKILL.md` rewrites, its `bundled-agents.ts` rate-limit wording and their
  test, as #75 recorded.
- Still waiting for a decision, as recorded for #75 and #76: `a2ca7720`, `c73b1866`,
  `adea7972` and `9403d456`, and the rest of `856bf0eb` (above).
- The upstream changesets.
- The licence-boundary commits: see the licence note below.

Changesets: `.changeset/upstream-models-safety-ai.md`, `-agent.md`, `-core.md` and
`-coder.md` (patch); `@kleio/manager` follows through the fixed group. gg-app is not a
changesets package, so its changes are recorded only here.

### UI boundary

As in #76, this import takes behaviour only from upstream's gg-app hunks: state, data flow,
`invoke` and event wiring, error handling and race fixes. New screens render through minimal
components in `gg-app/src/placeholder/`, styled only with `kleio-theme.css` variables, for
the redesign branch to restyle after rebasing.

New files:

| File                                       | Replaces upstream                          | Takes                                                                                          | Mounted in          |
| ------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------- |
| `placeholder/PaidModelConfirm.tsx` (+test) | `ModelPanel.tsx`'s paid-model confirmation | The paid model's name and billing, the standard model's name, and confirm and cancel callbacks | `ModelSelect.tsx`   |
| `placeholder/SecurityNotice.tsx` (+test)   | `SecurityNotice.tsx`                       | A blocked action's rule, target and count                                                      | `TranscriptRow.tsx` |
| `placeholder/McpRowNotes.tsx` (+test)      | The row notes in `McpModal.tsx`            | One MCP server row: its connect error, and up to three tools the safety guard hid              | `McpModal.tsx`      |

New logic and test files, with no rendering of their own: `security-notices.ts` and
`blocked-skills.ts` (each +test), `tool-format.safety.test.ts` and
`agent-auth-status.test.ts`. `placeholder/placeholder.css` gains one rule,
`.placeholder-list`, with theme variables only.

Changed existing files, in logic, props and text: `App.tsx`, `AppFooter.tsx`,
`HomeScreen.tsx` (+test), `LocalModelsModal.tsx` (+test), `LoginScreen.lazy.test.tsx`,
`McpModal.tsx`, `MemoryModal.tsx` (+test), `ModelSelect.tsx` (+test), `TasksModal.tsx`,
`ToolRow.tsx`, `TranscriptRow.tsx`, `WorkspaceHeaderActions.tsx`, `agent-radio.test.ts`,
`agent.ts`, `kleio/keepAwake.ts`, `provider-labels.ts` (+test), `task-activity.ts`,
`task-outcome-matrix.test.ts`, `tool-format.ts`, `transcript-item.ts`, `useAgentEvents.ts`,
`useWindowOrder.ts` and `scripts/smoke-sidecar.mjs`. Rust: `auth.rs`, `commands/agent.rs`,
`commands/agent_admin.rs`, `daemon.rs`, `keep_awake.rs`, `lib.rs` and `settings.rs`.
`McpModal.tsx` wraps each server row in a `Fragment` to mount `McpRowNotes`, and
`ModelSelect.tsx`'s outer `span` gains a `ref` for `PaidModelConfirm`; neither changes a
class or a style. Two markup changes come with the new behaviour:

- `MemoryModal.tsx` adds a "Try again" button with the fork's existing
  `btn btn-sm btn-ghost` classes (`2b3c506a`, from `9d7cbe6d`).
- `ToolRow.tsx` colours a blocked step with the theme's `warning` colour (`02a99b7c`, from
  `d7419c46`).

Not taken, because the fork owns the design: upstream's `App.css`, `glass.css`,
`WhatsNew.css` and `Deck.css` hunks; `ModelPanel.tsx` with its test, `Deck.tsx` and
`RoyaleKey.test.tsx`; the `HfPullModal.tsx` colour change; and `d7419c46`'s `McpModal.tsx`
re-layout and `LiveToolPanel.tsx` markup.

### Licence note

This is engineering guidance, not legal advice.

The boundary is the one #76's licence note sets out. Every commit this import takes is an
ancestor of `c1aa287b` (desktop v0.102.0). No `NOTICE` file changes.

One `LICENSE` file is deleted, together with everything it covers. `c065296a` (`21adf945`)
removes the `evidence-led-ui` skill, and with it the skill's `LICENSES.md` and its
`corpus/awesome-design-md/` folder: 74 `DESIGN.md` files and their MIT `LICENSE`
(VoltAgent). The corpus came from upstream `25601bdf`. Upstream dropped it in `705af903`'s
skills refresh, which the fork didn't take, so here it leaves with the skill. Nothing from
the corpus remains, and `git grep awesome-design-md` finds nothing. Releases before this
import still ship the corpus with its `LICENSE`.

Not taken:

- `a1c4f642` (chat attachments), which follows the relicense (`12da5c3a`) and was first
  released in 5.91.2 and v0.102.2, under the new licence.
- The version commits `4fd3d17b` (5.91.2) and `296df256` (desktop 0.102.2, the tip
  reviewed).
- The commits #76 left out for the licence: `85cb0ef7`, `8020944e`, `8627ee65` and
  `0d443e0f` (licence unclear), `12da5c3a` itself, and the version commits `02375294` and
  `af5b1df4`.
- The nine upstream commits after `296df256`, up to `f6b17fc5`, all after the relicense.
  This import doesn't review them.

#76's backlog for a lawyer still stands.

### Verification record

Local macOS checks, each compared with `main` at `bf328196`:

- Test totals: `@kleio/ai` 590 → 634 tests (25 files), `@kleio/core` 272 → 322 (15 → 19
  files), `@kleio/coder` 4742 → 4931 (354 → 368 files; 17 skipped, as on `main`) and gg-app
  1876 → 1916 (160 → 167 files). `@kleio/agent` (226), `@kleio/manager` (332), gg-editor
  (950), kleio-host (973) and gg-pixel (115) are unchanged. `pnpm test` passes in all 12
  packages with tests, and the plan's PR 3b tests run and pass: `side-web-search`,
  `web-fetch`, `steroids`, `settings-manager`, `minimax-region` and `xiaomi-region`.
- Fewer tests only where upstream removed them: `task-outcome-matrix.test.ts` drops its
  `code_search` and `code_nav` cases (`c065296a`, as in `21adf945`), and
  `checklist-items.test.ts` runs 8 fewer `it.each` cases, because `c065296a` removes 8
  `skill:` entries from `checklist-items.ts`. `setup-history.test.ts`, `code-nav.test.ts`
  and `search-code.test.ts` go with their code, `agent-session-style-packs.test.ts` becomes
  `agent-session-languages.test.ts`, and Coder's `core/auth-providers.test.ts` moves to
  `@kleio/core`.
- `cargo test`: 310 passed and 3 ignored. The branch adds 8 tests: 5 in `auth.rs`, 2 in
  `settings.rs` and 1 in `commands/agent.rs`. `cargo clippy --all-targets -- -D warnings`
  passes. `cargo fmt --check` reports the same 10 differences as on `main`, all in files
  this import doesn't touch (`ask_notify.rs`, and `brief.rs`, `commands.rs`, `live.rs` and
  `phone.rs` under `kleio/`); CI runs `cargo fmt` only for `packages/kleio-link`.
- The golden prompt is identical to upstream's at `5d340fa3`. Against `main` it changes in
  four commits: `2752e67a` (`c08602e9`: `grep`'s description), `01e47106` (`ba10f31b`: one
  `bash` command per change replaces the multi-file script line and the `edit`-first line),
  `75e7bce3` (`7302fa5a`: the comments rule) and `b651552f` (`cf6c9a23`: the Precedence line
  drops its style-pack sentence, and the parallel-calls sentence now says shell commands and
  edits run in listed order). Line 1 doesn't change, the Kleio Coder assertions in
  `system-prompt.test.ts` pass, and `cleanInstructionText` still runs in
  `collectProjectContext`.
- The tool catalog drops `code_search` and `code_nav` and changes `grep` and `web_fetch`. It
  matches upstream's at `5d340fa3` except `checklist`, `debug` and `screenshot`, which keep
  `main`'s text: upstream rewrote all three descriptions in `c73b1866` (flagged), and
  `checklist`'s `accepted` field and `senior-review` item come from `c346f81f`, as #76
  recorded.
- Identity audit, tracked (3163 files) and packed (2190 files): 0 unclassified hits and 0
  count mismatches. Each count moves in the commit that changes it. The larger moves are the
  Coder source-directory seam 1622 → 1552 (up with the new Coder files, then down by 100 at
  `c065296a` with the cut skills), Manager's packed Coder paths 744 → 755 and the
  allowlist's own control data 1546 → 1537. `947238b0` adds
  `xai-responses-prompt-cache-identity`, and `75e7bce3` replaces the `find-skills` seed
  entries with `retired-find-skills-seed-fixtures` and
  `packed-manager-coder-legacy-literals`.
- The build, typecheck, lint, format check, the tracked script tests (143), the
  fixed-version check, the bundled sidecar smoke and the startup gate pass. The startup
  median is 548 ms, against a 477 ms baseline and a 5000 ms budget.
  `gg-app/scripts/kleio-identity.test.mjs` runs in gg-app's suite, as #75 notes.
- Size: the `@kleio/coder` build output grows from 7887.1 KB on `main` to 8437.5 KB, and the
  initial frontend JavaScript from 1041.6 KB to 1045.4 KB. The bundled sidecar falls from
  8507.8 KB to 5352.9 KB, because `c065296a` cuts the bundled skills from 3635 KB to 332 KB.
  No test file is in the build output. The 16 new Coder modules, one of them a
  `test-support/` helper that builds like the three on `main`, make up 314 KB of its growth
  with their maps and declarations. Two ports re-baseline where an artifact first crosses
  its limit: `2752e67a` (`c08602e9`) the build output at 8219543 bytes, and `02a99b7c`
  (`d7419c46`) the build output at 8604163 and the sidecar at 8863197. The size gate passes
  on each of the 31 commits.
- Licence: every picked or ported upstream commit is an ancestor of `c1aa287b` (30 of 30),
  and no added line carries the new licence's short identifier.
  `git diff origin/main...HEAD -- LICENSE NOTICE '**/LICENSE' '**/NOTICE'` is not empty: it
  shows the corpus `LICENSE` deleted with the `evidence-led-ui` skill (see the licence
  note). No other `LICENSE` or `NOTICE` file changes.
- UI: no CSS changes outside `gg-app/src/placeholder/`, `placeholder.css` uses theme
  variables only, the 12 new gg-app files are the ones listed under UI boundary, and
  `ModelSelect.tsx` and `McpModal.tsx` are the only files that newly import from
  `placeholder/` (`App.tsx`, `Composer.tsx` and `TranscriptRow.tsx` already did, from #76).
- `patches/`, `pnpm-workspace.yaml`, the package manifests and the lockfile are unchanged,
  so `undici` stays 7.29.1, `@anthropic-ai/sdk` ^0.124.0 and `openai` ^7.13.0. So are the
  excluded packages, the `three` lines and `upstream.lastImportedCommit`.
- Skills: Coder's bundled skills are exactly `bulletproof`, `compliance-guard`, `durable`
  and `lean`. `code_search`, `code_nav`, `find-skills` and `/setup-skills` are gone from the
  catalog snapshot, and from source except upstream's own mentions at `5d340fa3`: a removal
  note in `tool-tiers.ts`, a `code_search` stub in `tool-search.test.ts`, and the cleanup in
  `config.ts` that deletes an unchanged retired `find-skills` seed, with its test and two
  fixtures.
- `style-packs/` and `setup-history.ts` are gone. No code adds a `~/.gg` path: the added
  lines that name it are comments and the retired seed's test fixtures, and the one
  home-directory path the branch touches, `setup-history.json`, goes with
  `setup-history.ts`.
- The critter-art checks match nothing.

## Goals from upstream (open)

- Upstream tip reviewed: `296df256b164ec18a4cc72ec7a824633da245bcb` (engine **5.91.2**,
  desktop **0.102.2**), as for #77. The 9 later upstream commits, up to `f6b17fc5`, all
  follow the relicense and are not reviewed.
- Branch: `sync/upstream-goals`, based on `main` at `7150a676`.
- PR: [#78](https://github.com/fmckie/gg-framework/pull/78), opened as a draft on
  2026-11-08
- PR 4a of PR 4 in `.gg/plans/upstream-selective-import-phased.md`, re-planned as 4a (Goals)
  and 4b (motion) in `.gg/plans/upstream-pr4-goals-motion.md`. Its first commit, `14e1c85b`,
  records #77 as merged. Then `223830dc`'s ask-user slice (moved ahead, because `e98215da`
  imports it) and the Goals rows in upstream date order, with the Goals hunks PR 3a and 3b
  held back.
- `upstream.lastImportedCommit` stays `3f2bb6bc`, for the reason given in the 988f920e
  section. Picks carry `cherry picked from commit <sha>`, ports carry
  `Ported from upstream <sha>`, and `fork-provenance.json` `selectiveImports` holds the full
  hashes on both sides.
- Every commit taken is an ancestor of `c1aa287b` (desktop v0.102.0), upstream's last
  release under MIT.

The 20 upstream commits taken, in branch order. `21adf945` appears twice and `6c63a63e`,
`d9ad9050` and `5a3c24b3` ride on other rows, because their held-back hunks land with the
code they touch.

| Upstream                                   | Downstream | Method       | Taken                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ---------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `223830dc49452b8c4596c33db92adc27ca363558` | `3d78dc65` | Partial port | `answerAskItem` and `firstOpenAskId` in gg-app's `ask-user.ts`. The rest of `223830dc` goes to PR 4b                                                                                                                                                                 |
| `46e534bce060d384e7d674088ea384a389e008bf` | `1da5f4fe` | Partial port | Goals: the goal store, routes and coordinator agent, the subagent and project-list hunks, the five Rust goal commands and the data layer. Goal sessions keep Ideal self-review suppressed (fork-only, until PR 4b removes Ideal review). The UI becomes placeholders |
| `6c63a63edc4cdbfa914cf24f011580dabcd6e9ae` | `1da5f4fe` | Partial port | Its `critter-tool-kind.ts` line, in `placeholder/worker-status.ts`                                                                                                                                                                                                   |
| `21adf9451460b367aef6d880dcce0c7a2aac8771` | `1da5f4fe` | Partial port | `critter-tool-kind.ts` without `code_search` and `code_nav`, in `placeholder/worker-status.ts`                                                                                                                                                                       |
| `e98215daccb5aa52c5440b787bc89e671d588918` | `38e32af0` | Partial port | Update, pause and resume; `retry_window_session` and real start failures; questions survive reload; the coordinator's own team (`goal-team.ts`); focus, scroll and restart fixes. The farm and Ken-talk are not taken                                                |
| `21adf9451460b367aef6d880dcce0c7a2aac8771` | `38e32af0` | Partial port | `goal-team.ts` without `code_search`, folded in because `goal-team.test` fails on the removed tool                                                                                                                                                                   |
| `b252380d33aab0d6da50cec37e9a820f40619272` | `55121f64` | Partial port | The goals-path test compares with platform separators                                                                                                                                                                                                                |
| `9d7cbe6dc99eeb65c3b016103fd2cc62215b254b` | `263ce512` | Partial port | The Goals part #77 held back: git from the goal's project (`resolveGitCwd`, `retargetGit`), `RunEnd`, and the finish card as a placeholder                                                                                                                           |
| `6325d417565fae2ff004a641ff39dea3ed4805d2` | `7ee2302b` | Partial port | Workers reach folders attached mid-goal                                                                                                                                                                                                                              |
| `db5ad07faf469999eac90a391bfce8acf0019ac0` | `12d719c0` | Partial port | Steroids for Goals workers, and its disk size                                                                                                                                                                                                                        |
| `127ec0a914f558b2e21a0cc44e6d7b4d6c8e9e63` | `4931ba68` | Partial port | The goal status pill as a placeholder, and the Claude 5.5 family at medium thinking                                                                                                                                                                                  |
| `d9ad9050bbdcc6d3aaa7a88b512244b9c4705867` | `4931ba68` | Partial port | Opus 5.5 fast's `defaultThinkingLevel`, held back from #77                                                                                                                                                                                                           |
| `5a3c24b349492e5888ccae3c8c9b1efb795941f1` | `4931ba68` | Partial port | The reworded Sonnet 5.5 comment, held back from #77                                                                                                                                                                                                                  |
| `351f590bf09cef7d5c3090ec4e859fec447a777d` | `842ecaf8` | Port         | Goals and autopilot in ACP mode, with goal summaries shared with the sidecar                                                                                                                                                                                         |
| `de2392c352e11374c71063700b1b46bffbcf4543` | `f633e48e` | Pick         | The ACP steering test drains its queue only after both messages arrive                                                                                                                                                                                               |
| `5e689aa0e8393f976035b5c8100f5c067bc60c79` | `9fd6320b` | Partial port | Slash commands from every workspace root. The farm sounds are not taken                                                                                                                                                                                              |
| `818ed96bc25395113e6e002317f4bc62cd65f37c` | `a4b0e0c6` | Partial port | Live goal runs marked across processes. The Deck, Git overview, model panel, set-thinking route and glass styles are not taken                                                                                                                                       |
| `bc7e5733a25fc9cb1e51ed93b72407a5c7a5eb6f` | `d7314a20` | Partial port | The Goals part #77 held back: workers never run on a paid model                                                                                                                                                                                                      |
| `494374d7941d25cbba6afd5c571187de64ab0c5d` | `a935c25b` | Partial port | The sidecar part #77 held back: the idle wake for background failures                                                                                                                                                                                                |
| `a69cc275a86d02f31831c280755f335e5b7a117f` | `c2f0707f` | Partial port | The Goals part #77 held back: the slow-git re-read through the goal's target                                                                                                                                                                                         |
| `5d340fa3bc1be03d3200b40cfbe8f8abfb5551bf` | `e1648e49` | Partial port | The Goals half #77 held back: a typed go-ahead starts a goal, with a goal write lock and atomic writes                                                                                                                                                               |

Not taken:

- Every farm, map, world, Ken-portrait, Ken-talk, critter, sound and font file, `GoalWorld`,
  `KenStatus`'s art and `KenDialogue`, and the `KEN_FACES` "line on the farm" prompt
  section (the coordinator's prompt test checks it asks for no such line).
- All gg-app CSS and `DESIGN.md`, and upstream's `HomeScreen`, `WakeScreen`, `AppFooter`,
  `WorkspaceHeader(Actions)` and `ModelSelect` goal hunks (their controls are in the
  placeholders).
- From `818ed96b`: the Deck and model panel, the glass styles, the Git overview
  (`utils/git-overview.ts`, `/git/overview`, `agent_git_overview`) and `POST /thinking
{level}` (`agent_set_thinking`). Nothing in the fork would call them.
- `816c385d`'s trophy lines, met in `5d340fa3`'s context.
- The upstream changesets.

Changesets: `.changeset/upstream-goals-coder.md` and `-core.md` (patch); `@kleio/manager`
follows through the fixed group. gg-app is not a changesets package, so its changes are
recorded only here.

### UI boundary

As in #76 and #77, this import takes behaviour only from upstream's gg-app hunks. New
screens render through minimal components in `gg-app/src/placeholder/`, styled only with
`kleio-theme.css` variables, for the redesign branch to restyle after rebasing. The Goals
views load with `React.lazy`, so they stay out of the start-up bundle.

New files:

| File                                 | Replaces upstream                                                                                                              | Takes                                                                                                                               | Mounted in                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `placeholder/GoalList.tsx` (+test)   | `GoalPicker.tsx`                                                                                                               | The goal list from `agent.ts`: open, search, delete with a confirm, a status label, and the New goal form                           | `App.tsx` (lazy)                |
| `placeholder/GoalForm.tsx`           | `NewGoalModal.tsx`, `GoalContextPicker.tsx`, `GoalInstructionsField.tsx`                                                       | Name, goal, folders and files, instructions; the sidecar's error as is                                                              | `GoalList.tsx`, `GoalPanel.tsx` |
| `placeholder/GoalPanel.tsx` (+test)  | `WorkspaceHeaderActions.tsx`'s goal controls, `GoalSettingsModal.tsx`, `GoalAskNotice.tsx`, the footer's workers' model picker | The goal, its view, the transcript, workers, runs and tools; it owns the tally, the open question, the finish card and the settings | `App.tsx` (lazy)                |
| `placeholder/WorkerList.tsx` (+test) | `GoalWorld.tsx`                                                                                                                | The coordinator and each worker, with a state label and activity                                                                    | `App.tsx` (lazy)                |
| `placeholder/GoalFinish.tsx` (+test) | `GoalFinishCard.tsx`                                                                                                           | A finished stretch's score and a way to the chat                                                                                    | `GoalPanel.tsx`                 |
| `placeholder/StatusPill.tsx` (+test) | `KenStatus.tsx`                                                                                                                | What the coordinator is doing, its timer and extra line                                                                             | `GoalPanel.tsx`                 |

New logic files, each with a test and no rendering of its own: `placeholder/worker-status.ts`
(from `goal-world-agents.ts`, `CritterFloor.tsx`'s `collectFloorAgents` and
`critter-tool-kind.ts`), `placeholder/goal-status.ts` (from `goal-ken-status.ts`, without
`face` and `mark`), `placeholder/goal-progress.ts`, `placeholder/goal-finish.ts` (without
Ken's face and line), `hidden-focus.ts` and `transcript-status.ts`; and
`useWindowOrder.test.ts`. `placeholder/placeholder.css` gains `.placeholder-goals`,
`.placeholder-form`, `.placeholder-bar` and an `active` dot tone, on theme variables, and
`StatusDot` gains `active` and `neutral` tones.

Changed existing files, in logic, props and text: `App.tsx`, `ActivityBar.tsx` (+test),
`AskBand.tsx` (+test), `Composer.tsx`, `agent.ts`, `agent-radio.test.ts`,
`app-entry-view.ts`, `ask-user.ts` (+test), `kleio/KleioHome.tsx` (+test),
`transcript-item.ts`, `transcript-pin.ts` (+test), `useAgentEvents.ts` (+test),
`useTranscriptScroll.ts` and `useWindowOrder.ts`. Rust: `commands/agent.rs`,
`commands/agent_admin.rs`, `daemon.rs`, `lib.rs` and `state.rs`. Markup that comes with the
behaviour:

- `kleio/KleioHome.tsx` gets one plain "Goals" text button, with the existing
  `btn btn-ghost home-action` classes.
- `AskBand.tsx` gives a text question its own field and Answer button (`e98215da`), with
  upstream's class names.
- `App.tsx` adds a "Try again" button (existing `btn btn-sm btn-ghost` classes) to a failed
  start, which calls `retryWindowSession`; the fork had no button there.

The data names `critterModel`, `agent_set_critter_model` and `setCritterModel` keep
upstream's names. They are in the engine, the Rust commands and the data layer, and as
identifiers only (never visible text) in `App.tsx` and `placeholder/GoalPanel.tsx`.

### Licence note

This is engineering guidance, not legal advice. The boundary is the one #76's licence note
sets out. Every commit this import takes is an ancestor of `c1aa287b` (20 of 20), checked
with `git merge-base --is-ancestor`, and the relicense commit `12da5c3a` is not. No
`LICENSE` or `NOTICE` file changes. #76's backlog for a lawyer still stands.

### Verification record

Local macOS checks on the branch head, each compared with `main` at `7150a676`:

- Test totals: `@kleio/coder` 4931 → 5045 tests (368 → 376 files; 17 skipped, as on
  `main`), gg-app 1916 → 2023 (167 → 179 files) and `@kleio/core` 322 → 323. `@kleio/ai`
  (634), `@kleio/agent` (226), `@kleio/manager` (332), gg-editor (950), kleio-host (973)
  and gg-pixel (115) are unchanged. `pnpm test` passes in every package with tests, and the
  4a tests named in the plan run in those suites. The Windows path test (`b252380d`) runs
  only in CI.
- `cargo test`: 315 passed and 3 ignored (310 on `main`); `cargo clippy --all-targets -- -D
warnings` passes, and `rustfmt --check` passes on the five Rust files this import
  touches. `cargo fmt --check` reports the same differences as on `main`, all in files this
  import doesn't touch.
- The golden prompt and the tool catalog snapshot are unchanged.
- Identity audit, tracked (3206 files) and packed (2217 files): 0 unclassified hits and 0
  count mismatches. Each count moves in the commit that changes it: the Coder
  source-directory seam 1552 → 1569 (17 new Coder files), Manager's packed Coder paths 755
  → 796, the allowlist's own control data 1537 → 1593, one tightening removal (`daemon.rs`'s
  crash message that named upstream's product is gone), and one new exact-context packed entry,
  `packed-20261108-4961ad8cc6a1`, for the 56 source-map occurrences ACP mode's autopilot
  brings into the Manager bundle (`842ecaf8`).
- No added line contains upstream's product names for the app and its Goals, "Autopilot
  Ken", upstream's package scope or `.join(".gg")`, outside the records. The goals root is `goalsRoot(agentDir)`.
- The build, typecheck, lint, format check, the tracked script tests (143), the
  fixed-version check, the bundled-sidecar smoke with a temporary `HOME` and the startup
  gate (median 509 ms against a 477 ms baseline and a 5000 ms budget) pass.
- Size: the `@kleio/coder` build output grows from 8437.5 KB to 8747.3 KB. It crosses its
  limit at `38e32af0` (`e98215da`, 8605.9 KB against 8570.6 KB) and is re-baselined there,
  once, to 8812455 bytes with `--only` for that artifact, so its limit is now 8778.0 KB. The
  initial frontend JavaScript grows from 1045.4 KB to 1054.8 KB, under its 1060.9 KB limit,
  with the Goals views lazy. The bundled sidecar is 5411.0 KB, against a 5352.9 KB build on
  `main` and an 8828.6 KB limit. The sidecar baseline is not ratcheted down.
- UI: no CSS changes outside `gg-app/src/placeholder/`, `placeholder.css` has no colour
  literals or motion, the new gg-app files are the ones listed under UI boundary, and only
  `App.tsx` newly imports from `placeholder/` (`McpModal.tsx`, `ModelSelect.tsx`,
  `Composer.tsx` and `TranscriptRow.tsx` already did).
- `patches/`, `pnpm-workspace.yaml`, the package manifests and both lockfiles are unchanged,
  as are the excluded packages, the `three` lines and `upstream.lastImportedCommit`.
- The critter-art checks match nothing.

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
