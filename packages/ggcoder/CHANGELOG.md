# @kenkaiiii/ggcoder

## 5.59.4

### Patch Changes

- Compaction summaries now carry failing test names forward deterministically: test failures parsed from tool results are appended to the summary in a tracked block, survive re-compaction, and are reversed when a later run passes.
  - @kenkaiiii/gg-ai@5.59.4
  - @kenkaiiii/gg-agent@5.59.4
  - @kenkaiiii/gg-core@5.59.4

## 5.59.3

### Patch Changes

- Fix replace_all re-editing replaced text (duplicate properties, skipped occurrences), reject unsafe global elision matches, and stop empty/invisible search strings from hanging or mismatching blank lines.
  - @kenkaiiii/gg-ai@5.59.3
  - @kenkaiiii/gg-agent@5.59.3
  - @kenkaiiii/gg-core@5.59.3

## 5.59.2

### Patch Changes

- Clarify agent completion status and required next actions, reject unsupported transparent image requests without repeated backend failures, and preserve prior verification after successful mixed check commands that leave source unchanged.
  - @kenkaiiii/gg-ai@5.59.2
  - @kenkaiiii/gg-agent@5.59.2
  - @kenkaiiii/gg-core@5.59.2

## 5.59.1

### Patch Changes

- Reduce repeated verification hooks by separating edit diagnostics from completion checks, sharing background-check results with Autopilot, and preserving verification after builds that leave source unchanged.
  - @kenkaiiii/gg-ai@5.59.1
  - @kenkaiiii/gg-agent@5.59.1
  - @kenkaiiii/gg-core@5.59.1

## 5.59.0

### Minor Changes

- Add GPT Image 2.5 Flare and Sunburst image generation with transparent backgrounds. Preserve intent and detailed requirements in prompt enhancement, respect the selected model's settings, and keep drafts intact on incomplete responses. Keep coding moving with background edit diagnostics, responsive dev-server readiness waits, leaner agent instructions, and clearer completion guidance after verification.

### Patch Changes

- @kenkaiiii/gg-ai@5.59.0
- @kenkaiiii/gg-agent@5.59.0
- @kenkaiiii/gg-core@5.59.0

## 5.58.1

### Patch Changes

- Fix stale login credentials when another session replaces the shared auth file with the same size and timestamp.
  - @kenkaiiii/gg-ai@5.58.1
  - @kenkaiiii/gg-agent@5.58.1
  - @kenkaiiii/gg-core@5.58.1

## 5.58.0

### Minor Changes

- Add independent read-only reviews for substantial coding tasks and model-assisted detection of unproductive retries. Keep stale loop judgments and unfinished verification from interrupting later question-only turns, and explain why a check does not count as verification.

### Patch Changes

- @kenkaiiii/gg-ai@5.58.0
- @kenkaiiii/gg-agent@5.58.0
- @kenkaiiii/gg-core@5.58.0

## 5.57.2

### Patch Changes

- Fix verification-gate false alarms: bash shells now run with pipefail so piped checks report the failing stage's exit code, `check | tail` pipelines count as verification evidence, stale failed checks are superseded by green runs at newer revisions, and verified sessions stay verified across resume.
  - @kenkaiiii/gg-ai@5.57.2
  - @kenkaiiii/gg-agent@5.57.2
  - @kenkaiiii/gg-core@5.57.2

## 5.57.1

### Patch Changes

- OpenAI tool calls now use strict (structured outputs) sampling so malformed arguments are guaranteed away at the provider, with a null-argument fallback re-parse for schemas strict mode rewrites.
  - @kenkaiiii/gg-ai@5.57.1
  - @kenkaiiii/gg-agent@5.57.1
  - @kenkaiiii/gg-core@5.57.1

## 5.57.0

### Minor Changes

- Add current-commit GitHub Actions progress to the desktop title bar, with live job counts, brief success feedback, and dismissible failures. Recognize successful checks after a git status prelude and show incomplete verification as Unverified instead of an unexpected crash.

### Patch Changes

- @kenkaiiii/gg-ai@5.57.0
- @kenkaiiii/gg-agent@5.57.0
- @kenkaiiii/gg-core@5.57.0

## 5.56.1

### Patch Changes

- Block completion and Autopilot approval when verification is missing, failed, stale, or running; preserve unresolved checks across resumed sessions, bound post-edit rechecks, and retain structured corpus-review warnings.
  - @kenkaiiii/gg-ai@5.56.1
  - @kenkaiiii/gg-agent@5.56.1
  - @kenkaiiii/gg-core@5.56.1

## 5.56.0

### Minor Changes

- Add opt-in Gemini 3.8 Flash, Gemini 3.5 Flash Lite, and experimental DeepSeek V4 Flash Vision; enable Qwen image/video input, align provider reasoning and output limits, and respect loaded local context and summary output budgets.

### Patch Changes

- @kenkaiiii/gg-ai@5.56.0
- @kenkaiiii/gg-agent@5.56.0
- @kenkaiiii/gg-core@5.56.0

## 5.55.1

### Patch Changes

- Fix Codex requests for GPT-5.6/GPT-6 models: default reasoning effort to `low` on the Responses-Lite route (these models reject `none`), which unbreaks prompt enhancement and Autopilot; only show the ChatGPT entitlement hint for OpenAI's actual "not supported with a ChatGPT account" error instead of any 400.
  - @kenkaiiii/gg-ai@5.55.1
  - @kenkaiiii/gg-agent@5.55.1
  - @kenkaiiii/gg-core@5.55.1

## 5.55.0

### Minor Changes

- 7ade77f: Fix GPT-6 Astra on the ChatGPT OAuth route. OpenAI gates Astra on the Codex client version (`minimal_client_version: 0.153.0`) and rejected our `0.144.1` header with "requires a newer version of Codex"; we now advertise `0.153.4`, the current openai/codex release. When a future model is gated the same way, the error guidance says plainly that GG Coder needs updating and to switch model meanwhile, instead of echoing OpenAI's "upgrade the app or CLI" as if it were the user's problem.

  Remove GPT-5.5 from the model registry, footers, login hub, README, and CLI defaults (OpenAI now defaults to GPT-5.6 Sol everywhere, matching the registry). Sync the desktop login hub descriptions with the registry for every provider (Claude Fable 5.1, GPT-6 Astra, GLM-5.3-Flash, OpenRouter Qwen3.6-Plus). Drop the last slash-command reference from a generic error hint so guidance reads correctly in the app.

### Patch Changes

- Updated dependencies [7ade77f]
  - @kenkaiiii/gg-ai@5.55.0
  - @kenkaiiii/gg-core@5.55.0
  - @kenkaiiii/gg-agent@5.55.0

## 5.54.1

### Patch Changes

- 5aa507b: Fix a Windows race in the cross-process compaction lock. When one session released the lock while another was acquiring it, Windows reported the mid-delete lock directory as `EPERM` rather than `EEXIST`, and the acquiring side threw instead of waiting. `EPERM`/`EBUSY`/`EACCES` on the lock `mkdir` are now treated as contention and retried on the normal poll, so simultaneous compactions coordinate cleanly on Windows too.
  - @kenkaiiii/gg-ai@5.54.1
  - @kenkaiiii/gg-agent@5.54.1
  - @kenkaiiii/gg-core@5.54.1

## 5.54.0

### Minor Changes

- 7ad7339: Add GPT-6 Astra (`gpt-6-astra`, released 2026-09-03) to the model registry — 1.05M context on the public Responses API, 272K on the ChatGPT OAuth/Codex route, 128k output, text+image input, $10/$50 MTok with cache reads at $1/MTok. It takes the full six-rung Codex effort ladder (low → medium → high → xhigh → max → ultra) and uses the same responses-lite transport and `prompt_cache_options` cache shape as the GPT-5.6 family; at `ultra` it receives the proactive async-subagent orchestration prompt, matching its `multi_agent v2` catalog entry.

  Astra is still rolling out (`visibility: hide` in OpenAI's Codex catalog), so accounts without access get the existing "not in the current Codex catalog" hint, which now names Astra among the alternatives. Through a plain OpenAI API key, OpenAI requires the Responses API for tool calling on Astra, so the Chat Completions path stays text-only — the OAuth Codex route is the supported way to run it as an agent.

### Patch Changes

- Updated dependencies [7ad7339]
  - @kenkaiiii/gg-ai@5.54.0
  - @kenkaiiii/gg-core@5.54.0
  - @kenkaiiii/gg-agent@5.54.0

## 5.53.3

### Patch Changes

- Fix a crash where a background command whose binary cannot be spawned emitted an unhandled `error` event and took the whole CLI down; the failure is now reported as a normal non-zero exit.
  - @kenkaiiii/gg-ai@5.53.3
  - @kenkaiiii/gg-agent@5.53.3
  - @kenkaiiii/gg-core@5.53.3

## 5.53.2

### Patch Changes

- Wait on background processes instead of guessing: `task_output` takes `wait_ms` and returns the moment the process exits, and a long bare `sleep` while something runs in the background is now refused and redirected there.
  - @kenkaiiii/gg-ai@5.53.2
  - @kenkaiiii/gg-agent@5.53.2
  - @kenkaiiii/gg-core@5.53.2

## 5.53.1

### Patch Changes

- Make Agent Steroids the proactive source of truth: the agent now searches the real-code corpus before planning or writing nontrivial code, fills a corpus gap via discover → ask → add (indexing allowed in plan mode), and nudges once to install Steroids when the CLI is missing.
  - @kenkaiiii/gg-ai@5.53.1
  - @kenkaiiii/gg-agent@5.53.1
  - @kenkaiiii/gg-core@5.53.1

## 5.53.0

### Minor Changes

- Add the native `steroids` tool (Agent Steroids local code corpus: search, define, show, files, repos, discover, recent, add) and the `/steroids` command that profiles the project, discovers matching repos and indexes the ones you pick. Replaces the kencode-search MCP default. Removes the Error Mom error reporter.

### Patch Changes

- @kenkaiiii/gg-ai@5.53.0
- @kenkaiiii/gg-agent@5.53.0
- @kenkaiiii/gg-core@5.53.0

## 5.52.0

### Minor Changes

- 17ca096: Add Claude Fable 5.1 (`claude-fable-5-1`, released 2026-09-01) to the model registry — 1M context, 128k output, image input, always-on adaptive thinking on the low→max ladder (no xhigh), $10/$50 MTok with cache reads at $0.25/MTok. It replaces Fable 5, which is retired from the registry and the model picker — a session still pinned to it falls back to the provider default on next start. Fable 5.1 rejects forced tool use (`tool_choice` `any`/`tool`) with a 400; gg-coder only ever sends `auto`/`none`, so no call path changes.

  The login screen now derives its provider rows from `AUTH_PROVIDERS` instead of keeping a second hardcoded copy, and a new test pins every provider description to the model registry — which caught two stale ones: Z.AI now lists GLM-5.3-Flash alongside GLM-5.3, and OpenRouter names Qwen3.6-Plus rather than just "multi-provider gateway".

### Patch Changes

- Updated dependencies [17ca096]
  - @kenkaiiii/gg-ai@5.52.0
  - @kenkaiiii/gg-core@5.52.0
  - @kenkaiiii/gg-agent@5.52.0

## 5.51.4

### Patch Changes

- Block symlink escapes from the workspace write guard, and tell custom-prompt sessions when a root is added
  - @kenkaiiii/gg-ai@5.51.4
  - @kenkaiiii/gg-agent@5.51.4
  - @kenkaiiii/gg-core@5.51.4

## 5.51.3

### Patch Changes

- Fix a duplicate final response when the Ideal review's coverage gate re-injects: the pre-coverage draft now stays held until the reviewed answer lands, and repeated injections announce themselves without stacking identical notices.
  - @kenkaiiii/gg-ai@5.51.3
  - @kenkaiiii/gg-agent@5.51.3
  - @kenkaiiii/gg-core@5.51.3

## 5.51.2

### Patch Changes

- Release a parked `ask_user` question when the user sends their own prompt instead of picking an option, so the turn resumes immediately rather than waiting out the ten-minute timeout.
  - @kenkaiiii/gg-ai@5.51.2
  - @kenkaiiii/gg-agent@5.51.2
  - @kenkaiiii/gg-core@5.51.2

## 5.51.1

### Patch Changes

- Route every end-of-reply question through the `ask_user` tool when it is registered, instead of writing it as a markdown blockquote the user has to type an answer to.
  - @kenkaiiii/gg-ai@5.51.1
  - @kenkaiiii/gg-agent@5.51.1
  - @kenkaiiii/gg-core@5.51.1

## 5.51.0

### Minor Changes

- Add the `ask_user` tool so the agent can ask a structured question mid-run and block on the answer, with the request parked until the user replies or it times out

### Patch Changes

- @kenkaiiii/gg-ai@5.51.0
- @kenkaiiii/gg-agent@5.51.0
- @kenkaiiii/gg-core@5.51.0

## 5.50.0

### Patch Changes

- Updated dependencies [10138dd]
  - @kenkaiiii/gg-core@5.50.0
  - @kenkaiiii/gg-ai@5.50.0
  - @kenkaiiii/gg-agent@5.50.0

## 5.49.11

### Patch Changes

- Cap file reads at 20 MiB and refuse symlinks and fifos at open, report interrupted tool calls as indeterminate rather than cancelled, repair crash-torn session lines, and correct a stale environment without breaking the prompt cache
  - @kenkaiiii/gg-ai@5.49.11
  - @kenkaiiii/gg-agent@5.49.11
  - @kenkaiiii/gg-core@5.49.11

## 5.49.10

### Patch Changes

- Harden the verification gate: an edited check now discloses the tamper instead of passing as proof, and a golden snapshot of the cached system-prompt prefix blocks unreviewed tool or prompt edits.
  - @kenkaiiii/gg-ai@5.49.10
  - @kenkaiiii/gg-agent@5.49.10
  - @kenkaiiii/gg-core@5.49.10

## 5.49.9

### Patch Changes

- Fix image and video attachments on Windows: write temp files to `os.tmpdir()` instead of a hardcoded `/tmp`, which does not exist on Windows and silently dropped the attachment.
  - @kenkaiiii/gg-ai@5.49.9
  - @kenkaiiii/gg-agent@5.49.9
  - @kenkaiiii/gg-core@5.49.9

## 5.49.8

### Patch Changes

- Fix GLM image attachments: route them to the real `mcp__zai_vision__analyze_image` MCP tool (with its `tool_search` unlock path) instead of a phantom tool name, gate the hint to the GLM provider only so other providers keep inline images, and raise the `zai_vision` tool-call timeout from 60s to 180s so long GLM-4.6V analyses stop getting killed mid-flight.
  - @kenkaiiii/gg-ai@5.49.8
  - @kenkaiiii/gg-agent@5.49.8
  - @kenkaiiii/gg-core@5.49.8

## 5.49.7

### Patch Changes

- Fix Hugging Face model downloads picking unpullable files and flickering progress: search now filters to real GGUF repos, repo trees are read recursively so quants in subfolders are found, split shards / vision projectors / imatrix blobs / speculative-decoding drafts are never chosen as the model, pull phase no longer jumps backwards, and failures explain rate limits instead of dumping raw terminal output.
  - @kenkaiiii/gg-ai@5.49.7
  - @kenkaiiii/gg-agent@5.49.7
  - @kenkaiiii/gg-core@5.49.7

## 5.49.6

### Patch Changes

- Shrink the published CLI bundle by 3.4MB by excluding the test suite from the build output
  - @kenkaiiii/gg-ai@5.49.6
  - @kenkaiiii/gg-agent@5.49.6
  - @kenkaiiii/gg-core@5.49.6

## 5.49.5

### Patch Changes

- Harden the sandbox against unix-socket and degraded-isolation escapes, strip invisible Unicode from MCP and web-fetch output, and attribute new diagnostics to the edit that caused them
  - @kenkaiiii/gg-ai@5.49.5
  - @kenkaiiii/gg-agent@5.49.5
  - @kenkaiiii/gg-core@5.49.5

## 5.49.4

### Patch Changes

- Tighten reply length with one total word budget nothing is exempt from, and give Ken's plan review a design bar that catches unnecessary steps, misplaced boundaries, and uncovered paths before code is written.
  - @kenkaiiii/gg-ai@5.49.4
  - @kenkaiiii/gg-agent@5.49.4
  - @kenkaiiii/gg-core@5.49.4

## 5.49.3

### Patch Changes

- Fix a crash that disabled autopilot entirely, and lock Ken's model plus the reasoning level while a run is in flight
  - @kenkaiiii/gg-ai@5.49.3
  - @kenkaiiii/gg-agent@5.49.3
  - @kenkaiiii/gg-core@5.49.3

## 5.49.2

### Patch Changes

- Verification gate now recognizes compound commands like `cd pkg && npm test`, demands verification at most once per run, and announces itself so it no longer surfaces as a second unexplained final answer.
  - @kenkaiiii/gg-ai@5.49.2
  - @kenkaiiii/gg-agent@5.49.2
  - @kenkaiiii/gg-core@5.49.2

## 5.49.1

### Patch Changes

- Close a sandbox write-root symlink escape, translate Git-Bash paths on Windows, and add a low-token outline mode to web_fetch
  - @kenkaiiii/gg-ai@5.49.1
  - @kenkaiiii/gg-agent@5.49.1
  - @kenkaiiii/gg-core@5.49.1

## 5.49.0

### Minor Changes

- 05685fe: Add Gemini 3.7 Flash (`gemini-3.7-flash`, released 2026-08-13) and retarget `deepseek-v4-pro` to DeepSeek-V4-Pro-0813 under the same API id. 3.7 Flash is Google's most capable Flash for coding and agents — 1M context, 64K output, thinking low/medium/high, video input (20 MB inline cap) — listed as a selectable option for Gemini but kept non-default because it ships on our Code Assist transport ahead of gemini-cli (issue #28802 tracks upstream); free/personal accounts get the existing account-gated 404 guidance while entitled Code Assist Standard/Enterprise accounts can use it. DeepSeek's `deepseek-v4-pro` alias now serves the first stable V4 Pro (0813, supersedes the April preview, calling name unchanged): max output corrected to 393,216 and costTier dropped to `medium` to match the ~$0.43/$0.87 per-MTok pricing; saved sessions keep working since the id is unchanged.
- 05685fe: Add Grok 4.6 (`grok-4.6`, released 2026-08-12) to the model registry and make it the xAI default — 500K context, image input, $2/$6 MTok (under 200K prompt tokens), and a `reasoning_effort` ladder that adds a new `xhigh` top rung (`low`/`medium`/`high` default/`xhigh`), which `XAI_THINKING_LEVELS` now exposes; thinking starts at `xhigh`. Grok 4.5 stays registered as a legacy option, still capped at `high` since it rejects `xhigh`. The OpenAI-compatible transport needs no changes — `xhigh` passes through `toOpenAIReasoningEffort` unchanged — so both the public API and the Grok CLI OAuth proxy serve the new model; CLI/app login defaults point at `grok-4.6`.
- 05685fe: Add "Add from Hugging Face" to the desktop app: search the Hub and pull models with Ollama, in one modal. From Connect AI Providers, the Hugging Face tile offers "Search Hugging Face and download with Ollama" next to its hosted-token login, and the Local models modal gains an "Add from Hugging Face" button. The modal debounces typed queries into a live dropdown of GGUF repos (downloads/likes inline, full keyboard navigation), and clicking a model starts `ollama pull hf.co/<repo>:<quant>` immediately — the sidecar picks the quant from the repo's real file list (Q4_K_M preferred), streams `hf_pull` progress events into a cancellable progress bar, re-scans local endpoints on success so the model appears in the picker without a restart, and maps known failures to fixes (the Ollama 0.32 hf.co pull bug → upgrade; 401 → connect an HF token, which is also passed to pulls for gated repos). Pull state lives in the sidecar, so closing the modal mid-download never cancels it — reopening reattaches. One pull at a time; client sends only validated `org/repo` ids, and the child is spawned with argv (never a shell string).
- 05685fe: Add a first-class `huggingface` provider backed by Hugging Face's Inference Providers router (`https://router.huggingface.co/v1`, OpenAI-compatible Chat Completions, one HF token with "Make calls to Inference Providers" permission). Model ids are Hub repo paths: `Qwen/Qwen3-Coder-480B-A35B-Instruct` (default; 262K context, tool-native, non-thinking Coder line) and `openai/gpt-oss-120b` (low-tier sibling for summaries and scout sub-agents; reasoning effort low/medium/high). Auth is a static API key wired through the existing apikey login flow in both TUI and desktop app, with label/logo/order entries everywhere providers are enumerated (`config`/`settings-manager`/`app-sidecar`/`auth-providers`/`ModelSelector`/`login`/`provider-labels`/`provider-logos`). Local-weight users keep the existing routes: Ollama `hf.co/...` pulls and any self-hosted OpenAI-compatible server via local endpoints.

### Patch Changes

- Updated dependencies [05685fe]
- Updated dependencies [05685fe]
- Updated dependencies [05685fe]
- Updated dependencies [05685fe]
  - @kenkaiiii/gg-ai@5.49.0
  - @kenkaiiii/gg-core@5.49.0
  - @kenkaiiii/gg-agent@5.49.0

## 5.48.0

### Minor Changes

- Add /setup-ci command: dual-mode CI setup for any stack (generate hardened CI from scratch, or audit + harden existing workflows) with Dependabot, branch-protection rulesets, and AGENTS.md

### Patch Changes

- @kenkaiiii/gg-ai@5.48.0
- @kenkaiiii/gg-agent@5.48.0
- @kenkaiiii/gg-core@5.48.0

## 5.47.0

### Minor Changes

- 8d8a93b: Add five bundled workflow skills that ship by default and route themselves: `clarify` (frontier-based requirements interview — facts self-served, only decisions reach the user), `tdd` (red-green loop with pre-agreed seams and independent expected values), `root-cause` (gated diagnosis: red repro command → ranked falsifiable hypotheses → regression test before fix), `shared-language` (CONTEXT.md glossary + ADR discipline), and `code-review` (spec and standards axes kept separate; security defers to `bulletproof`). Plus two system-prompt lines: facts-vs-decisions sorting and batched questions with recommended answers.

### Patch Changes

- @kenkaiiii/gg-ai@5.47.0
- @kenkaiiii/gg-agent@5.47.0
- @kenkaiiii/gg-core@5.47.0

## 5.46.2

### Patch Changes

- System prompt guardrails (git safety, anti-fake-green verification, reproduce-before-fix, retry circuit-breaker, question-vs-fix), bash tool safety lines (git only when asked, no shell backgrounding, PID-specific kills), and an explicit kencode-search staple in Research. Bench A/B'd with zero regressions.
  - @kenkaiiii/gg-ai@5.46.2
  - @kenkaiiii/gg-agent@5.46.2
  - @kenkaiiii/gg-core@5.46.2

## 5.46.1

### Patch Changes

- Guard the `lean` skill against killing its own host daemon: the process-cleanup reference now leads with a hard rule to trace PPID ancestry before any kill, treat memory-heavy processes as findings rather than kill targets, and leave orphan cleanup to the host startup sweep. Fixes lean sessions dying mid-run after SIGTERM-ing the app-sidecar they run inside.
  - @kenkaiiii/gg-ai@5.46.1
  - @kenkaiiii/gg-agent@5.46.1
  - @kenkaiiii/gg-core@5.46.1

## 5.46.0

### Minor Changes

- 7a4a613: Add a bundled `durable` skill for data durability — user data must survive bad migrations, crashed writes, retried webhooks, and dead servers. Two modes like its siblings: binding defaults while building (migration tooling from the first table, guards on destructive operations, constraints in the store, transactions around multi-write invariants, idempotency keys on retried writes, batched resumable backfills, backups the moment real data exists, connection/session hygiene, SQLite runtime rules) and a full pass for existing projects (backups & recovery, destructive paths, migration health, transactions & idempotency, schema integrity, runtime data safety — ranked by survivability, verified with restore/guard/migration drills). References cover the expand-contract pattern with concrete lock behavior, ORM migration traps, backup tiers with 2026 managed-provider baselines, the restore drill, outbox/idempotency patterns, and transaction-pooling session-state pitfalls.
- 7a4a613: Add a bundled `lean` skill for performance and resource efficiency — two modes like its siblings: binding defaults while building (teardown ships with the feature, bounded accumulation, lazy loading, right-sized media, streamed I/O, timeout everything) and a full-pass workflow for existing projects (baseline, sweep six areas — loading/startup, runtime responsiveness, memory, processes & lifecycle, payload & dead weight, styling consistency — rank by user impact, fix, re-verify with numbers, leave a CI guard). Covers every stack (web, backend, Electron, Tauri, mobile, native, Python, data) via per-stack playbooks, plus a memory-leak catalog and zombie/orphan process lifecycle playbook (process-tree kills, graceful shutdown, startup sweeps, container PID 1).

### Patch Changes

- @kenkaiiii/gg-ai@5.46.0
- @kenkaiiii/gg-agent@5.46.0
- @kenkaiiii/gg-core@5.46.0

## 5.45.0

### Minor Changes

- Add background-task wake rules (bash `wake` pattern/silence conditions that notify the agent instead of task_output polling), a pre-stop verification gate (a run that edited code cannot finish until a test/typecheck/lint/build command ran after the last edit), and a flag-aware read-only bash classifier for plan mode (blocks `git branch -D`, `find -delete`, `date -s`, clustered flags like `sort -ro`, and sed exec/write scripting).

### Patch Changes

- @kenkaiiii/gg-ai@5.45.0
- @kenkaiiii/gg-agent@5.45.0
- @kenkaiiii/gg-core@5.45.0

## 5.44.3

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@5.44.3
  - @kenkaiiii/gg-agent@5.44.3
  - @kenkaiiii/gg-core@5.44.3

## 5.44.2

### Patch Changes

- Fix silent agent stop when the provider returns empty responses: after retries exhaust, the loop now emits an `empty_response` truncated event, keeps the contentless assistant message out of session history so later requests aren't poisoned, and hosts (TUI + desktop sidecar) surface a clear warning instead of ending silently. Also refreshed the bulletproof skill references.
  - @kenkaiiii/gg-ai@5.44.2
  - @kenkaiiii/gg-agent@5.44.2
  - @kenkaiiii/gg-core@5.44.2

## 5.44.1

### Patch Changes

- Tell the model what went wrong when `edit` receives `edits` as a JSON-encoded string, and log the consecutive schema-rejection count so retry loops are visible.
  - @kenkaiiii/gg-ai@5.44.1
  - @kenkaiiii/gg-agent@5.44.1
  - @kenkaiiii/gg-core@5.44.1

## 5.44.0

### Minor Changes

- bc99e74: **GLM-5.3 is now the only GLM model.** Z.AI's new coding-first flagship (released 2026-08-14) replaces GLM-5.2, and GLM-5.1 / GLM-4.7 / GLM-4.7 Flash are retired from the registry — they routed to strictly worse coding for the same plan quota, and the coding endpoint already answers `glm-5.2` requests as glm-5.3. Sessions saved on any retired id fall back to the provider default.

  Same GLM-5 base as 5.2 with every gain from post-training: Z.AI reports ~50% better coding and open-source SOTA on Terminal-Bench 3.0 and Agent's Last Exam. Context window (1M) and max output (131K) are unchanged, so compaction budgeting is untouched.

  **GLM thinking is now a real effort ladder, not an on/off toggle.** ggcoder previously sent only `thinking: { type: "enabled" }`, which silently ran Z.AI's `max` default at every setting. The endpoint in fact declares `none, minimal, low, medium, high, xhigh, max` (an unknown value 400s with that list), so `low / medium / high / xhigh / max` are now selectable and sent as `reasoning_effort` alongside the toggle. Measured end-to-end on one hard reasoning prompt: `low` → 0.8K reasoning chars in 15s, `high` → 3.2K in 28s, `max` → 24.9K in 129s. The default stays `max`, matching what the server was already doing, so existing behaviour is unchanged — but dialing effort _down_ is now possible for the first time.

  Note `max` is kept as `max` on the wire for GLM rather than remapped to `xhigh` the way OpenAI-compatible efforts are: GLM spells its own top rung `max`.

  With no low-cost GLM sibling left, compaction-summary and scout sub-agent routing keep GLM-5.3 instead of downshifting — the existing graceful fallback, no crash and no cross-provider jump.

### Patch Changes

- Updated dependencies [bc99e74]
  - @kenkaiiii/gg-ai@5.44.0
  - @kenkaiiii/gg-core@5.44.0
  - @kenkaiiii/gg-agent@5.44.0

## 5.43.0

### Minor Changes

- Add an explicit code-minimization ladder to the Code Quality prompt section, and a `hook_armed` event so clients can hold a candidate final answer back until the Ideal review decides.

  The ladder is ordered and stop-at-first-hit (YAGNI, reuse what the repo already has, standard library, native platform feature, installed dependency, one line, then the minimum code that works). Benchmarked A/B against the previous prose-only section — 5 iterations per cell, every artifact executed against functional tests — it holds correctness (100% exec pass, no new dependencies, no turn-cap hits) while producing 50-76% less code and 21-38% fewer output tokens. Safety is explicitly exempt: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, and anything explicitly requested are never minimized away.

  `hook_armed` fires on both edges as soon as a run crosses the Ideal-review gate, before the candidate final answer streams, so a client renders hook then reviewed answer instead of flashing a draft it deletes.

### Patch Changes

- @kenkaiiii/gg-ai@5.43.0
- @kenkaiiii/gg-agent@5.43.0
- @kenkaiiii/gg-core@5.43.0

## 5.42.0

### Minor Changes

- Add per-repo MCP trust: adding a project-scope MCP server now auto-trusts that repo so its `.gg/mcp.json` servers connect on next load without enabling the global `trustProjectMcpServers` toggle.

### Patch Changes

- @kenkaiiii/gg-ai@5.42.0
- @kenkaiiii/gg-agent@5.42.0
- @kenkaiiii/gg-core@5.42.0

## 5.41.1

### Patch Changes

- Security hardening: authenticate the app sidecar daemon with a per-launch bearer token, drop open CORS, gate repo-controlled `.gg/mcp.json` servers behind a trust setting, and bump vulnerable dependencies.
  - @kenkaiiii/gg-ai@5.41.1
  - @kenkaiiii/gg-agent@5.41.1
  - @kenkaiiii/gg-core@5.41.1

## 5.41.0

### Minor Changes

- 5f49c4a: Add a bundled `bulletproof` skill that hardens what you are shipping against a real attacker, on any target — web, API, CLI, desktop, mobile, embedded, smart contract, ML pipeline, or game. It profiles the attack surface from the code, ranks by what actually breaches small teams (exposed secrets, missing authorization at the data layer, supply-chain and install-time execution) rather than by what is most interesting, builds the control instead of describing it, and leaves a regression test and CI gate behind. It never certifies software as secure and never produces exploit code.

  Its references cover the 2026 threat landscape — AI-orchestrated intrusion, self-propagating registry worms, slopsquatted packages, CI cache poisoning — plus per-platform playbooks, agent/LLM/MCP surfaces, and the secure defaults to write the first time. Every dated claim carries a verified/snapshot/uncertain marker so stale advisories are not asserted as current.

  **The `/bullet-proof` slash command is removed** — it is now the `bulletproof` skill. The skill routes itself, so security review no longer depends on remembering a command, and it also fires inline while you build instead of only after. One source of truth instead of a command prompt that drifts from it.

  Security defaults are also always on: the system prompt now tells the agent to write the safe version during normal feature work — treat external input as hostile, parameterize queries, authorize at the data layer, never commit or log a secret, confirm a dependency exists before adding it, and never silently weaken a security control.

### Patch Changes

- @kenkaiiii/gg-ai@5.41.0
- @kenkaiiii/gg-agent@5.41.0
- @kenkaiiii/gg-core@5.41.0

## 5.40.1

### Patch Changes

- 356db7d: Make replies answerable at a glance: the "How to Talk" section now reserves markdown blockquotes for the one thing only the user can decide (`> **<the ask>?** <what happens next>`) and forbids them everywhere else, so a `>` in a reply always means "you're up". Adds a compression rule (reasoning, findings, and history earn a clause only when they change the next move) and a plain-language rule: keep the exact term or identifier, but say what it does or risks in the same sentence the first time it appears, so a reply is answerable without knowing the codebase. Overlapping progress/scannability lines were folded together to pay for part of the added length.

  The rules are also reconciled so they can't pull the model in two directions: the ask defers to How to Work's single stop list instead of publishing a second one, the sentence cap says what it counts (prose — not a step list or the ask), and mid-turn speech is gated on "the plan changes" so a bare finding can't both trigger a message and be cut for not changing the next move. A new test locks all four in place.
  - @kenkaiiii/gg-ai@5.40.1
  - @kenkaiiii/gg-agent@5.40.1
  - @kenkaiiii/gg-core@5.40.1

## 5.40.0

### Minor Changes

- f56f240: Add a bundled `compliance-guard` skill that reviews what you are shipping for legal, privacy, and regulatory exposure — profiling the product from its own code, mapping observable facts to the obligations they trigger, flagging the litigation patterns that actually hit small teams, and saying plainly when a feature cannot lawfully ship as described. It never certifies compliance and routes genuinely legal questions to a lawyer.

  Skill routing now also damps unnecessary invocation: match the work rather than the topic, skip routine or narrow changes, and never re-invoke a skill already loaded in the conversation.

### Patch Changes

- @kenkaiiii/gg-ai@5.40.0
- @kenkaiiii/gg-agent@5.40.0
- @kenkaiiii/gg-core@5.40.0

## 5.39.4

### Patch Changes

- Keep long runs alive across cross-process OAuth token rotation, stop the debug log from wedging just under its size cap, retry provider timeouts that carry no error code, render the full MCP content-block union including images, theme the TUI banner and tool output instead of hardcoding dark hexes, and offer the OAuth paste route immediately on headless hosts.
  - @kenkaiiii/gg-ai@5.39.4
  - @kenkaiiii/gg-agent@5.39.4
  - @kenkaiiii/gg-core@5.39.4

## 5.39.3

### Patch Changes

- Add 14 deep ambient, space ambient, and synthwave stations to the radio picker, including SomaFM's The Dark Zone, Echoes of Bluemars Cryosleep, Ambient Sleeping Pill, and Nightride FM.
  - @kenkaiiii/gg-ai@5.39.3
  - @kenkaiiii/gg-agent@5.39.3
  - @kenkaiiii/gg-core@5.39.3

## 5.39.2

### Patch Changes

- Surface gateway error frames delivered inside HTTP 200 streams instead of swallowing them, and stop treating tokens-per-minute rate limits as context overflow.
  - @kenkaiiii/gg-ai@5.39.2
  - @kenkaiiii/gg-agent@5.39.2
  - @kenkaiiii/gg-core@5.39.2

## 5.39.1

### Patch Changes

- Fix the `code_nav` file outline: list symbols in document order instead of the language server's name-grouped order, and drop locals declared inside function bodies so real declarations are no longer buried or truncated away. `definition`, `references` and `hover` now also resolve from a symbol name alone, with no line number required.
  - @kenkaiiii/gg-ai@5.39.1
  - @kenkaiiii/gg-agent@5.39.1
  - @kenkaiiii/gg-core@5.39.1

## 5.39.0

### Minor Changes

- Add the `code_nav` language-server tool (definition, references, file outline, hover), tier rarely used built-in tool schemas behind `tool_search` to cut per-request tokens, widen `code_search` to Python, Go, Rust, Java and C#, and fix `grep` recall so dot-directories are searched and `.gitignore` is honoured.

### Patch Changes

- @kenkaiiii/gg-ai@5.39.0
- @kenkaiiii/gg-agent@5.39.0
- @kenkaiiii/gg-core@5.39.0

## 5.38.0

### Minor Changes

- 1e8efde: Make sub-agent delegation reliable: ship six bundled agents (bee, owl, researcher, worker, auditor, skeptic) on every install instead of seeding two into `~/.gg/agents`, compose a child's prompt from its agent body PLUS the Tools, project context, return contract and Environment sections rather than replacing everything, resolve a child's model from explicit `model:` frontmatter (`inherit` by default) instead of silently downgrading read-only agents to the cheap tier, expose the agent roster in `spawn_agent`'s schema, validate `tools:` names, and align wait/output budgets with the child's real timeout.

### Patch Changes

- @kenkaiiii/gg-ai@5.38.0
- @kenkaiiii/gg-agent@5.38.0
- @kenkaiiii/gg-core@5.38.0

## 5.37.0

### Minor Changes

- Add Grok subscription OAuth (SuperGrok / X Premium) with OAuth-first credential resolution and automatic API-key fallback, plus a session-archive file-descriptor leak fix

### Patch Changes

- @kenkaiiii/gg-ai@5.37.0
- @kenkaiiii/gg-agent@5.37.0
- @kenkaiiii/gg-core@5.37.0

## 5.36.0

### Minor Changes

- Extend the rank ladder from 50 to 1000 levels with 145 named ranks across 29 tiers. Levels 1-50 keep their exact names, tiers, and XP costs, so existing progress is never re-ranked; past level 50 the XP curve switches from the exponential to a steady ramp that starts at the level-50 step and grows to ~3.6k per level.

### Patch Changes

- @kenkaiiii/gg-ai@5.36.0
- @kenkaiiii/gg-agent@5.36.0
- @kenkaiiii/gg-core@5.36.0

## 5.35.1

### Patch Changes

- 8e124fd: Fix "no low surrogate in string" / Bad Request errors from Anthropic and OpenAI.

  An unpaired UTF-16 surrogate anywhere in the conversation (a model streaming a
  split emoji inside tool-call arguments, or a character-indexed truncation that
  cut an astral character in half) made the JSON request body unparseable for
  every provider — and it persisted in history, so retries and model switches
  failed identically.

  `stream()` now scrubs lone surrogates from all messages at the single provider
  boundary, and the tool-result/shell/web-fetch/grep truncation paths cut on
  character boundaries instead of splitting surrogate pairs.

- Updated dependencies [8e124fd]
  - @kenkaiiii/gg-ai@5.35.1
  - @kenkaiiii/gg-agent@5.35.1
  - @kenkaiiii/gg-core@5.35.1

## 5.35.0

### Minor Changes

- 3b9705d: Share MCP connections and language servers across sessions instead of spawning a set per session.

  A daemon runs many sessions at once — one per window, plus Ken chat and Ken autopilot within each — and each used to spawn its own child process for every MCP server and every language server. Measured on a four-window daemon: 34 processes and 3.3 GB, most of it identical work duplicated.
  - **MCP connections are now pooled per process** and reference counted, so one stdio child serves every session and exits when the last releases it. Sharing is the default for stdio servers; `shared: false` opts out a server that keeps per-caller state, and HTTP servers are never pooled because their auth and session id are per-connection. Elicitation is routed to the session whose tool call is in flight, and cancelled rather than guessed when that is ambiguous. A pooled server that exits on its own is retired from the pool, so the next session reconnects instead of inheriting a dead connection.
  - **Language servers are now pooled per (server, project root)**, so two windows open on one repo share a single tsserver stack instead of running two. Servers left unused for five minutes are reclaimed, which also releases roots that no window has open.
  - **tsserver runs two processes per root instead of four**, by disabling the syntax server and automatic typing acquisition — both exist for an interactive editor and are unused here — and caps its heap at the VS Code default.

### Patch Changes

- @kenkaiiii/gg-ai@5.35.0
- @kenkaiiii/gg-agent@5.35.0
- @kenkaiiii/gg-core@5.35.0

## 5.34.3

### Patch Changes

- Rework auto-compaction summaries: lead with the next step, cut redundant user-message transcripts and read-file lists, and supersede prior summaries instead of concatenating them
  - @kenkaiiii/gg-ai@5.34.3
  - @kenkaiiii/gg-agent@5.34.3
  - @kenkaiiii/gg-core@5.34.3

## 5.34.2

### Patch Changes

- Prevent macOS temp folders from flooding and blanking the desktop project picker.
  - @kenkaiiii/gg-ai@5.34.2
  - @kenkaiiii/gg-agent@5.34.2
  - @kenkaiiii/gg-core@5.34.2

## 5.34.1

### Patch Changes

- List project folders on disk in project discovery, add hidden-project support, and never prune skill output from context
  - @kenkaiiii/gg-ai@5.34.1
  - @kenkaiiii/gg-agent@5.34.1
  - @kenkaiiii/gg-core@5.34.1

## 5.34.0

### Minor Changes

- Add ACP file diffs and tool locations, publish plan progress as `plan` updates, and implement session/resume, session/close, session/delete, session_info_update, and message ids

### Patch Changes

- @kenkaiiii/gg-ai@5.34.0
- @kenkaiiii/gg-agent@5.34.0
- @kenkaiiii/gg-core@5.34.0

## 5.33.0

### Minor Changes

- Emit ACP `usage_update` session notifications so clients can show context-window usage, including the post-compaction drop and usage on session/new and session/load

### Patch Changes

- @kenkaiiii/gg-ai@5.33.0
- @kenkaiiii/gg-agent@5.33.0
- @kenkaiiii/gg-core@5.33.0

## 5.32.0

### Minor Changes

- Count Gemini reasoning tokens toward billed output usage, gate verification claims behind a fail-closed command classifier, select context by relevance when compacting, and add portable Agent Plugin bundles. Also ships an opt-in OS command sandbox.

### Patch Changes

- @kenkaiiii/gg-ai@5.32.0
- @kenkaiiii/gg-agent@5.32.0
- @kenkaiiii/gg-core@5.32.0

## 5.31.0

### Minor Changes

- Advertise built-in and project slash commands to ACP clients when sessions open or load.

### Patch Changes

- @kenkaiiii/gg-ai@5.31.0
- @kenkaiiii/gg-agent@5.31.0
- @kenkaiiii/gg-core@5.31.0

## 5.30.3

### Patch Changes

- Restore complete compacted-session history in ACP clients without duplicate retained messages or internal replay noise.
  - @kenkaiiii/gg-ai@5.30.3
  - @kenkaiiii/gg-agent@5.30.3
  - @kenkaiiii/gg-core@5.30.3

## 5.30.2

### Patch Changes

- Recover useful subagent findings after timeouts and prevent nested delegation from exhausting child turn budgets.
  - @kenkaiiii/gg-ai@5.30.2
  - @kenkaiiii/gg-agent@5.30.2
  - @kenkaiiii/gg-core@5.30.2

## 5.30.1

### Patch Changes

- Keep long autonomous tool runs lean by pruning stale outputs and oversized completed tool arguments.
  - @kenkaiiii/gg-ai@5.30.1
  - @kenkaiiii/gg-agent@5.30.1
  - @kenkaiiii/gg-core@5.30.1

## 5.30.0

### Minor Changes

- Add ACP session controls and make conversation compaction durable across resumes and concurrent processes.

### Patch Changes

- @kenkaiiii/gg-ai@5.30.0
- @kenkaiiii/gg-agent@5.30.0
- @kenkaiiii/gg-core@5.30.0

## 5.29.1

### Patch Changes

- Fix sub-agents hanging until their timeout instead of exiting when finished, and stop the Ideal review coverage gate from looping forever on deleted or unreadable files
  - @kenkaiiii/gg-ai@5.29.1
  - @kenkaiiii/gg-agent@5.29.1
  - @kenkaiiii/gg-core@5.29.1

## 5.29.0

### Minor Changes

- Add step-boundary transcript checkpoints and a run journal so crashes preserve completed work, MCP HTTP session recovery with single reconnect-and-replay, server-initiated elicitation support, a visual token budget for image downscaling, and capped backoff for background-process notifications.

### Patch Changes

- @kenkaiiii/gg-ai@5.29.0
- @kenkaiiii/gg-agent@5.29.0
- @kenkaiiii/gg-core@5.29.0

## 5.28.0

### Minor Changes

- List Claude Code and Codex sessions alongside GG Coder's own for a project, tagged with their source and resumable on open, replacing the `/import` slash command

### Patch Changes

- @kenkaiiii/gg-ai@5.28.0
- @kenkaiiii/gg-agent@5.28.0
- @kenkaiiii/gg-core@5.28.0

## 5.27.0

### Minor Changes

- Add `/import` for resuming Claude Code, Codex and Cursor transcripts, gate turn completion on unread background processes, and migrate MCP to SDK v2 with an on-disk tool catalog cache

### Patch Changes

- @kenkaiiii/gg-ai@5.27.0
- @kenkaiiii/gg-agent@5.27.0
- @kenkaiiii/gg-core@5.27.0

## 5.26.3

### Patch Changes

- Fix session transcript restore: rebase marker anchors when compaction rewrites a session, heal stale anchors in existing session files, skip duplicate autopilot-injected user bubbles, and restore slash commands from the persisted invocation instead of matching drifted templates
  - @kenkaiiii/gg-ai@5.26.3
  - @kenkaiiii/gg-agent@5.26.3
  - @kenkaiiii/gg-core@5.26.3

## 5.26.2

### Patch Changes

- Fix concurrent prompts starting two runs on the same session, and announce queue depth the moment the agent consumes queued steering.
  - @kenkaiiii/gg-ai@5.26.2
  - @kenkaiiii/gg-agent@5.26.2
  - @kenkaiiii/gg-core@5.26.2

## 5.26.1

### Patch Changes

- Remove the project memory journal: it duplicated what the repo already tells the agent and suppressed real verification.
  - @kenkaiiii/gg-ai@5.26.1
  - @kenkaiiii/gg-agent@5.26.1
  - @kenkaiiii/gg-core@5.26.1

## 5.26.0

### Minor Changes

- Keep long tasks running and carry project history across sessions: the agent loop can now extend an exhausted turn budget when it is still making progress, finished sub-agents and background processes announce themselves instead of needing to be polled, mid-session model switches are recorded as durable replayable state, and compaction writes past-tense project history to `.gg/memory.md` (on by default, `/memory-off` to disable).

### Patch Changes

- @kenkaiiii/gg-ai@5.26.0
- @kenkaiiii/gg-agent@5.26.0
- @kenkaiiii/gg-core@5.26.0

## 5.25.0

### Minor Changes

- Add local model support (Ollama, LM Studio, llama.cpp, vLLM) with runtime discovery, capability-gated tool/thinking support, and per-endpoint auth; add `/remove-dir` workspace command; keep the subscription usage meter from blanking on transient provider rate limits.

### Patch Changes

- @kenkaiiii/gg-ai@5.25.0
- @kenkaiiii/gg-agent@5.25.0
- @kenkaiiii/gg-core@5.25.0

## 5.24.0

### Minor Changes

- Add Markdown chat transcript export, network egress allowlist, multi-root `/add-dir`, and OpenAI-compatible reasoning-field detection

### Patch Changes

- @kenkaiiii/gg-ai@5.24.0
- @kenkaiiii/gg-agent@5.24.0
- @kenkaiiii/gg-core@5.24.0

## 5.23.3

### Patch Changes

- 1be7250: Fix Windows compatibility across project discovery, shell execution, MCP and LSP.
  - **Projects and sessions were invisible on Windows.** Every cwd extractor in
    project discovery gated on `cwd.startsWith("/")`, so a `C:\…` session header
    was rejected, discovery fell back to the lossy directory-name decode, and the
    project silently vanished from the picker. Absolute-path detection is now
    platform-agnostic (`C:\…`, `\\server\share\…`, `/…`), and both fallback
    decoders reconstruct real Windows paths.
  - **Extended-length paths no longer duplicate a project.** A cwd recorded as
    `\\?\C:\proj` (what Rust's `canonicalize()` produces) is normalized to its
    plain form on read, matching what `encodeCwd` already did on write.
  - **`persist` bash mode was completely broken on Windows.** It spawned a bare
    `bash`, but Git for Windows puts `cmd\` on PATH and `bash.exe` in `bin\`, so
    the spawn was always ENOENT. It now reuses the resolved shell, and no longer
    detaches on Windows (which only orphaned the shell past a crash).
  - **MCP stdio servers configured with `npx` never connected.** The MCP SDK
    spawns with `shell: false` and Windows' `CreateProcess` ignores `PATHEXT`, so
    the near-universal `{"command": "npx"}` config failed with an opaque
    "Connection closed". The command is now resolved across PATH × PATHEXT.
  - **LSP inline diagnostics never appeared on Windows.** Diagnostics are cached
    by `file://` URI; ours kept the drive letter's case while servers emit the
    lowercase form, so every lookup missed and LSP degraded silently.
  - **Background processes survived cancellation.** `killProcessTree` used a
    POSIX-only negative pid, leaving a timed-out command's whole descendant tree
    running. It now uses `taskkill /T /F`, resolved from `SystemRoot` rather than
    PATH.
  - `find`/`grep` glob patterns containing backslashes now match (backslash is
    picomatch's escape character, never a separator).
  - **Session persistence was broken on Windows.** `syncFile` opened the file
    read-only (`"r"`) and then called `fsync`, but Windows implements fsync as
    `FlushFileBuffers`, which requires a handle with WRITE access and fails with
    `EPERM` on a read-only one. Every durable session write funnels through that
    helper, so saving sessions, archiving cold sessions and writing redirects all
    threw. It now opens `"r+"`, and a failed flush is non-fatal (network shares
    and container overlays can reject fsync outright — losing durability there is
    acceptable, refusing to save the user's session is not).
  - @kenkaiiii/gg-ai@5.23.3
  - @kenkaiiii/gg-agent@5.23.3
  - @kenkaiiii/gg-core@5.23.3

## 5.23.2

### Patch Changes

- Fix named sub-agents receiving no MCP tools: a session with a `tools:` allow-list skipped MCP entirely unless an MCP whitelist was also set, so an agent listing `mcp__kencode-search__searchCode` silently fell back to training data. The whitelist is now derived from the agent definition and forwarded through every spawn path. Also removes the v5.22.6 seeded `auditor.md`/`skeptic.md` that shadowed the richer bundled agents, with hash-gated cleanup that leaves user-edited files untouched.
  - @kenkaiiii/gg-ai@5.23.2
  - @kenkaiiii/gg-agent@5.23.2
  - @kenkaiiii/gg-core@5.23.2

## 5.23.1

### Patch Changes

- fb85e4f: Fix Claude Opus 5's thinking-level cycle and retire Claude Opus 4.8. `thinking-level.ts` kept its own hardcoded Anthropic regexes, so Opus 5 was not recognised as adaptive and collapsed to a single non-cycling `max` level; it now exposes the full low → medium → high → xhigh → max ladder. Opus 4.8 is removed from the model registry, footers, provider descriptions, and the hardcoded JSON/RPC/sidecar/CLI defaults (all now `claude-opus-5`); gg-ai keeps wire-format support for the `claude-opus-4-8` ID since Anthropic still serves it. Also gave the Sol/Terra policy tests real timeouts so they stop flaking at vitest's 5s default.
  - @kenkaiiii/gg-ai@5.23.1
  - @kenkaiiii/gg-agent@5.23.1
  - @kenkaiiii/gg-core@5.23.1

## 5.23.0

### Minor Changes

- a6a78c2: Add Claude Opus 5 (`claude-opus-5`, released 2026-07-24) to the model registry — 1M context, 128k output, image input, adaptive thinking with the full effort ladder (low→max, xhigh included), $5/$25 MTok (same price as Opus 4.8). gg-ai treats it as an adaptive-thinking model (no interleaved-thinking beta, xhigh passes through), footers short-name it "Opus" (Opus 4.8 becomes "Opus 4.8"), login/provider descriptions mention it, and gg-boss's default boss model moves from `claude-opus-4-8` to `claude-opus-5`. Opus 4.8 stays registered as a legacy option.

### Patch Changes

- Updated dependencies [a6a78c2]
  - @kenkaiiii/gg-ai@5.23.0
  - @kenkaiiii/gg-core@5.23.0
  - @kenkaiiii/gg-agent@5.23.0

## 5.22.6

### Patch Changes

- Remove the retired /setup command and its auto-run/hint UI, fix /bullet-proof refusals with authorized-defensive-review framing plus seeded auditor/skeptic agents and batched skeptic verification, dedupe kencode/source_path guidance out of the Research section, gate the native-web-search claim to Anthropic, and slim the system prompt.
  - @kenkaiiii/gg-ai@5.22.6
  - @kenkaiiii/gg-agent@5.22.6
  - @kenkaiiii/gg-core@5.22.6

## 5.22.5

### Patch Changes

- Proactive OAuth token refresh at a lifetime-scaled threshold. Short-lived tokens (e.g. Kimi's 15-minute access token) now refresh at their halfway point instead of riding to the expiry cliff, eliminating the recurring 401s and the misleading "API Key appears invalid" run failures caused by concurrent-session refresh races. Ported from MoonshotAI/kimi-code's OAuthManager: refresh when within max(300s, lifetime × 0.5) of expiry.
  - @kenkaiiii/gg-ai@5.22.5
  - @kenkaiiii/gg-agent@5.22.5
  - @kenkaiiii/gg-core@5.22.5

## 5.22.4

### Patch Changes

- Fix memory tools killing the turn when the model sends content over the 600-character limit (over-limit input is now an ordinary, actionable tool error instead of a fatal "repeatedly issued invalid arguments" failure), make chat agents save durable memories proactively without being asked, fix false stream stalls for silent OpenAI reasoning, and anchor transcript error markers to persisted messages so resumed errors render at the bottom.
  - @kenkaiiii/gg-ai@5.22.4
  - @kenkaiiii/gg-agent@5.22.4
  - @kenkaiiii/gg-core@5.22.4

## 5.22.3

### Patch Changes

- Automatically recover from runaway tool-call streams and restore bundled TypeScript diagnostics and source inspection in the desktop sidecar.
  - @kenkaiiii/gg-ai@5.22.3
  - @kenkaiiii/gg-agent@5.22.3
  - @kenkaiiii/gg-core@5.22.3

## 5.22.2

### Patch Changes

- Keep live sessions responsive while multiple subagents stream in parallel.
  - @kenkaiiii/gg-ai@5.22.2
  - @kenkaiiii/gg-agent@5.22.2
  - @kenkaiiii/gg-core@5.22.2

## 5.22.1

### Patch Changes

- Reliability fixes from the baseline harness (bench/baseline):
  - **Truncated-stream guard (gg-ai):** a clean stream close with no terminal event (no `message_stop` / `finish_reason`) now throws a retryable `ProviderError(504)` instead of silently returning partial text as a phantom-complete `end_turn`. Applies to both the Anthropic and OpenAI-compatible providers.
  - **Sidecar bounds (ggcoder):** inbound HTTP bodies capped at 10 MB (413) via `readCappedBody`; the `~/.gg` progress `fs.watch` handle is now closed on shutdown; the project-file glob search streams and bails after 50k entries. Closes three unbounded-memory/leak paths.
  - **Cap-divergence marker (gg-agent):** `capToolResults`/`capTurnToolResults` now stamp `ToolResult.capped = { originalChars, keptChars, scope }` when they trim, so the event-transcript vs model-input divergence is programmatically visible. Internal metadata only — never serialized to the provider.
  - **Empty-part serializer fix (gg-ai):** `toAnthropicMessages` no longer emits empty text parts (user `""`, user `{text:""}`, settled assistant `""`), eliminating live Anthropic 400 "text content blocks must be non-empty" failures.
  - **Tool-id remap fix (gg-ai):** `remapToolCallId` now strips the full `toolu_` prefix (`slice(6)`), mapping `toolu_01ABC` → clean `call_01ABC` instead of the lossy double-underscore `call__01ABC`.

- Updated dependencies
  - @kenkaiiii/gg-ai@5.22.1
  - @kenkaiiii/gg-agent@5.22.1
  - @kenkaiiii/gg-core@5.22.1

## 5.22.0

### Minor Changes

- Add Kimi (Moonshot) subscription usage tracking — the usage meter now reports Kimi For Coding plan quota (weekly + rate windows) alongside Anthropic and OpenAI.

### Patch Changes

- @kenkaiiii/gg-ai@5.22.0
- @kenkaiiii/gg-agent@5.22.0
- @kenkaiiii/gg-core@5.22.0

## 5.21.0

### Minor Changes

- Kimi K3 gains its full low/high/max thinking ladder with an endpoint-aware default (high on the Kimi For Coding OAuth endpoint, matching the official CLI's plan-usage profile; max on the public API), thinking can now be fully disabled via the nested toggle, and context compaction no longer blows past the model's window on oversized turns.

### Patch Changes

- @kenkaiiii/gg-ai@5.21.0
- @kenkaiiii/gg-agent@5.21.0
- @kenkaiiii/gg-core@5.21.0

## 5.20.5

### Patch Changes

- Require generated UIs to meet WCAG 2.2 Level AA and follow ADA-aligned accessibility practices.
  - @kenkaiiii/gg-ai@5.20.5
  - @kenkaiiii/gg-agent@5.20.5
  - @kenkaiiii/gg-core@5.20.5

## 5.20.4

### Patch Changes

- Teach the bundled UI skill to avoid generic soft semantic tint-on-tint treatments.
  - @kenkaiiii/gg-ai@5.20.4
  - @kenkaiiii/gg-agent@5.20.4
  - @kenkaiiii/gg-core@5.20.4

## 5.20.3

### Patch Changes

- Strengthen the bundled UI skill with consistent content rails, control spacing, and pointer focus guidance.
  - @kenkaiiii/gg-ai@5.20.3
  - @kenkaiiii/gg-agent@5.20.3
  - @kenkaiiii/gg-core@5.20.3

## 5.20.2

### Patch Changes

- 5fb6b62: Automatically enforce session retention across desktop, CLI, and chat-agent stores, compress inactive transcripts after seven days, and cap persisted tool output at 40,000 characters. Media is migrated to deduplicated adjacent assets with backward-compatible hydration and archived sessions remain discoverable and resumable through stale saved paths.
- Updated dependencies [f4b8ec7]
  - @kenkaiiii/gg-core@5.20.2
  - @kenkaiiii/gg-ai@5.20.2
  - @kenkaiiii/gg-agent@5.20.2

## 5.20.1

### Patch Changes

- Show up to 30 recent chat sessions while keeping coding history capped at 5.
  - @kenkaiiii/gg-ai@5.20.1
  - @kenkaiiii/gg-agent@5.20.1
  - @kenkaiiii/gg-core@5.20.1

## 5.20.0

### Minor Changes

- Harden agent completion, loop recovery, workspace writes, project instructions, and subagent concurrency.

### Patch Changes

- @kenkaiiii/gg-ai@5.20.0
- @kenkaiiii/gg-agent@5.20.0
- @kenkaiiii/gg-core@5.20.0

## 5.19.6

### Patch Changes

- Filter expected usage polling, cancellation, and tool validation failures from desktop error reports.
  - @kenkaiiii/gg-ai@5.19.6
  - @kenkaiiii/gg-agent@5.19.6
  - @kenkaiiii/gg-core@5.19.6

## 5.19.5

### Patch Changes

- Report sidecar, provider, tool, and subagent failures through the desktop Error Mom integration.
  - @kenkaiiii/gg-ai@5.19.5
  - @kenkaiiii/gg-agent@5.19.5
  - @kenkaiiii/gg-core@5.19.5

## 5.19.4

### Patch Changes

- Prevent Anthropic many-image requests from failing by resizing new and restored images to provider-safe dimensions.
  - @kenkaiiii/gg-ai@5.19.4
  - @kenkaiiii/gg-agent@5.19.4
  - @kenkaiiii/gg-core@5.19.4

## 5.19.3

### Patch Changes

- Updated dependencies [b6e7562]
  - @kenkaiiii/gg-ai@5.19.3
  - @kenkaiiii/gg-agent@5.19.3
  - @kenkaiiii/gg-core@5.19.3

## 5.19.2

### Patch Changes

- Reduce long-session token usage with calibrated context estimates and preserve full oversized command output for targeted recovery.
  - @kenkaiiii/gg-ai@5.19.2
  - @kenkaiiii/gg-agent@5.19.2
  - @kenkaiiii/gg-core@5.19.2

## 5.19.1

### Patch Changes

- Cut OpenAI token burn: percentage-only compaction thresholds on authoritative provider usage, a per-turn aggregate tool-result budget that trims parallel fan-out context bombs, cheap stale tool-output pruning (superseded reads and old outputs stubbed before compaction), and autopilot now suppresses the redundant Ideal self-review while Ken owns verification.
  - @kenkaiiii/gg-ai@5.19.1
  - @kenkaiiii/gg-agent@5.19.1
  - @kenkaiiii/gg-core@5.19.1

## 5.19.0

### Minor Changes

- Add Grok 4.5 support and make Kimi prefer OAuth with automatic API-key fallback when plan usage is exhausted.

### Patch Changes

- @kenkaiiii/gg-ai@5.19.0
- @kenkaiiii/gg-agent@5.19.0
- @kenkaiiii/gg-core@5.19.0

## 5.18.0

### Minor Changes

- e00de5b: Add Kimi K3 as Moonshot's default model with its 1M-token multimodal registry metadata and endpoint-specific max-effort request handling for both the public API and Kimi Code OAuth. Keep Kimi K2.7 Code available as the dedicated coding alternative.

### Patch Changes

- Updated dependencies [e00de5b]
  - @kenkaiiii/gg-ai@5.18.0
  - @kenkaiiii/gg-core@5.18.0
  - @kenkaiiii/gg-agent@5.18.0

## 5.17.0

### Minor Changes

- a3916ff: Harden provider error handling, cancellation settlement, review evidence, LSP confidence, route-aware context limits, turn metrics, and durable child-agent recovery.

### Patch Changes

- Updated dependencies [a3916ff]
  - @kenkaiiii/gg-ai@5.17.0
  - @kenkaiiii/gg-agent@5.17.0
  - @kenkaiiii/gg-core@5.17.0

## 5.16.0

### Minor Changes

- Add persistent Jiwa behavior instructions for GG Chat, with dedicated curation tools and safer loop detection that avoids interrupting healthy progress.

### Patch Changes

- 25601bd: Bundle the evidence-led UI skill for every GG Coder installation, require models to invoke matching skills before acting, honor explicit exclusions and precedence, and align GG Coder and Ken's UI guidance around evidence-led implementation.
  - @kenkaiiii/gg-ai@5.16.0
  - @kenkaiiii/gg-agent@5.16.0
  - @kenkaiiii/gg-core@5.16.0

## 5.15.1

### Patch Changes

- Restore previous coding sessions in the desktop project picker after switching from Chat.
  - @kenkaiiii/gg-ai@5.15.1
  - @kenkaiiii/gg-agent@5.15.1
  - @kenkaiiii/gg-core@5.15.1

## 5.15.0

### Minor Changes

- Make chat-agent delegation switch the active agent in place while preserving conversation history and restoring handoffs across resumed sessions.

### Patch Changes

- @kenkaiiii/gg-ai@5.15.0
- @kenkaiiii/gg-agent@5.15.0
- @kenkaiiii/gg-core@5.15.0

## 5.14.0

### Minor Changes

- Add specialist chat agents, safer multi-window sessions, hardened web tools, and live provider usage tracking.

### Patch Changes

- @kenkaiiii/gg-ai@5.14.0
- @kenkaiiii/gg-agent@5.14.0
- @kenkaiiii/gg-core@5.14.0

## 5.13.3

### Patch Changes

- Align OpenAI prompt caching with Codex and improve cache-safe sub-agent routing.
  - @kenkaiiii/gg-ai@5.13.3
  - @kenkaiiii/gg-agent@5.13.3
  - @kenkaiiii/gg-core@5.13.3

## 5.13.2

### Patch Changes

- c0553e1: Bound historical tool-call arguments during compaction and stop retrying timed-out summary requests.
  - @kenkaiiii/gg-ai@5.13.2
  - @kenkaiiii/gg-agent@5.13.2
  - @kenkaiiii/gg-core@5.13.2

## 5.13.1

### Patch Changes

- Keep internet radio playback continuous while changing volume.
  - @kenkaiiii/gg-ai@5.13.1
  - @kenkaiiii/gg-agent@5.13.1
  - @kenkaiiii/gg-core@5.13.1

## 5.13.0

### Minor Changes

- Add parallel specialist orchestration and reliable app-exit radio cleanup.

### Patch Changes

- @kenkaiiii/gg-ai@5.13.0
- @kenkaiiii/gg-agent@5.13.0
- @kenkaiiii/gg-core@5.13.0

## 5.12.0

### Minor Changes

- Add concurrent async subagent orchestration with steering, follow-up, interruption, lifecycle tracking, and shared-workspace safeguards.

### Patch Changes

- @kenkaiiii/gg-ai@5.12.0
- @kenkaiiii/gg-agent@5.12.0
- @kenkaiiii/gg-core@5.12.0

## 5.11.0

### Minor Changes

- Add GPT-5.6 Ultra orchestration with proactive parallel subagent delegation.

### Patch Changes

- @kenkaiiii/gg-ai@5.11.0
- @kenkaiiii/gg-agent@5.11.0
- @kenkaiiii/gg-core@5.11.0

## 5.10.1

### Patch Changes

- Fix GPT-5.6 Sol, Terra, and Luna access through the ChatGPT Codex transport.
  - @kenkaiiii/gg-ai@5.10.1
  - @kenkaiiii/gg-agent@5.10.1
  - @kenkaiiii/gg-core@5.10.1

## 5.10.0

### Minor Changes

- Add OAuth subscription usage snapshots for Anthropic and OpenAI Codex.

### Patch Changes

- @kenkaiiii/gg-ai@5.10.0
- @kenkaiiii/gg-agent@5.10.0
- @kenkaiiii/gg-core@5.10.0

## 5.9.7

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-core@5.9.7
  - @kenkaiiii/gg-ai@5.9.7
  - @kenkaiiii/gg-agent@5.9.7

## 5.9.6

### Patch Changes

- Retry read-only sub-agents on the active parent model when the cheaper model is unavailable.
  - @kenkaiiii/gg-ai@5.9.6
  - @kenkaiiii/gg-agent@5.9.6
  - @kenkaiiii/gg-core@5.9.6

## 5.9.5

### Patch Changes

- Add GPT-5.6 Sol, Terra, and Luna models to the registry; remove GPT-5.4, GPT-5.4 Mini, and GPT-5.3 Codex. Fix provider error hints to reference the model selector instead of CLI-only slash commands so they work in both the desktop app and the CLI.
  - @kenkaiiii/gg-ai@5.9.5
  - @kenkaiiii/gg-agent@5.9.5
  - @kenkaiiii/gg-core@5.9.5

## 5.9.4

### Patch Changes

- Auto-recover from context-overflow errors in the desktop app (request_too_large / 413) by wiring force-compaction + retry into AgentSession, add explicit 413 guidance, and rebrand user-facing error text to "GG Coder".
  - @kenkaiiii/gg-ai@5.9.4
  - @kenkaiiii/gg-agent@5.9.4
  - @kenkaiiii/gg-core@5.9.4

## 5.9.3

### Patch Changes

- Fix Gemini models over Code Assist OAuth: use the GA IDs from gemini-cli (`gemini-3.1-flash-lite`, wire name `gemini-3-flash` for Gemini 3.5 Flash), add Gemini 3.1 Pro (Preview) to the registry, and surface account-gated 404s as a clear entitlement message with actionable guidance instead of a raw provider error body.
  - @kenkaiiii/gg-ai@5.9.3
  - @kenkaiiii/gg-agent@5.9.3
  - @kenkaiiii/gg-core@5.9.3

## 5.9.2

### Patch Changes

- Fix retroactive XP seeding so heavy prior users spread across levels 15-25 instead of all clamping onto level 15. Full credit up to level 15, then diminishing returns beyond, hard-capped at level 25.
  - @kenkaiiii/gg-ai@5.9.2
  - @kenkaiiii/gg-agent@5.9.2
  - @kenkaiiii/gg-core@5.9.2

## 5.9.1

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@5.9.1
  - @kenkaiiii/gg-agent@5.9.1
  - @kenkaiiii/gg-core@5.9.1

## 5.9.0

### Minor Changes

- Hash-anchored span edits and opt-in persistent bash session. The edit tool gains a `{ span, lines }` form: pin a line range by its line+hash anchors from a `read` with `anchors:true` and supply only the replacement lines — no retyping existing code, stale files rejected before any write. Benchmarked on Sonnet 5 at −19% output tokens overall and −76% on repetitive code, with equal correctness. The bash tool gains `persist: true`: commands run in a long-lived session shell where cd, env vars, and shell state survive across calls (~0.3ms vs ~6.4ms per-call overhead).

### Patch Changes

- @kenkaiiii/gg-ai@5.9.0
- @kenkaiiii/gg-agent@5.9.0
- @kenkaiiii/gg-core@5.9.0

## 5.8.8

### Patch Changes

- Fix transient Ken sessions leaking to the session store (compact() and newSession() now respect the transient flag), harden autopilot verdict parsing to recover a buried line-start PROMPT keyword, and tighten Ken's autopilot contract so reasoning prose never precedes the verdict.
  - @kenkaiiii/gg-ai@5.8.8
  - @kenkaiiii/gg-agent@5.8.8
  - @kenkaiiii/gg-core@5.8.8

## 5.8.7

### Patch Changes

- Cut MCP server memory: resolve stdio servers to their real bin (via the npx on-demand cache and sole-bin matching) instead of falling back to the ~90 MB npx wrapper per connection. Covers non-bundled defaults like zai and any user-added MCP.
  - @kenkaiiii/gg-ai@5.8.7
  - @kenkaiiii/gg-agent@5.8.7
  - @kenkaiiii/gg-core@5.8.7

## 5.8.6

### Patch Changes

- Fix autopilot leaking the raw HUMAN verdict reason and teach Ken GG Coder's own capabilities so his guidance is grounded in what the tool can actually do.
  - @kenkaiiii/gg-ai@5.8.6
  - @kenkaiiii/gg-agent@5.8.6
  - @kenkaiiii/gg-core@5.8.6

## 5.8.5

### Patch Changes

- Autopilot now tells GG Coder when no human is watching: injected review prompts carry a situational-awareness preamble so the agent self-verifies its work and stops asking permission for safe, already-implied steps, while the transcript and resumed sessions still show Ken's clean instruction.
  - @kenkaiiii/gg-ai@5.8.5
  - @kenkaiiii/gg-agent@5.8.5
  - @kenkaiiii/gg-core@5.8.5

## 5.8.4

### Patch Changes

- Route read-only scout sub-agents (recon/research) to each provider's fast/cheap model via `costTier`, cutting sub-agent latency and spend with no quality risk. Writers and default sub-agents keep the parent model.
  - @kenkaiiii/gg-ai@5.8.4
  - @kenkaiiii/gg-agent@5.8.4
  - @kenkaiiii/gg-core@5.8.4

## 5.8.3

### Patch Changes

- Fix Anthropic empty-args tool calls and underscore-path project discovery. Truncated tool-input JSON now surfaces as a retryable parse error instead of emitting a phantom `args:{}` call, and eager/fine-grained tool streaming is gated behind a default-off flag. Project discovery reads the real cwd from ggcoder session headers, so projects whose path contains an underscore no longer vanish from the picker.
  - @kenkaiiii/gg-ai@5.8.3
  - @kenkaiiii/gg-agent@5.8.3
  - @kenkaiiii/gg-core@5.8.3

## 5.8.2

### Patch Changes

- Ship deferred MCP tools, leaner prompts, and smoother retry recovery for faster coding-agent turns.
  - @kenkaiiii/gg-ai@5.8.2
  - @kenkaiiii/gg-agent@5.8.2
  - @kenkaiiii/gg-core@5.8.2

## 5.8.1

### Patch Changes

- Session resume now renders 1:1 with the live transcript: stale autopilot all-clear markers are deduped and range-clamped (no more duplicate Ken bubbles bunching at the bottom of reopened sessions), queued steering prompts resume as clean bubbles without the internal wrapper, Ken "Send to GG Coder" labels, enhancer highlights, plan-mode banners, task headers, error rows, and compaction counts all persist and restore, and all-clear wording is deterministic across reopens.
  - @kenkaiiii/gg-ai@5.8.1
  - @kenkaiiii/gg-agent@5.8.1
  - @kenkaiiii/gg-core@5.8.1

## 5.8.0

### Minor Changes

- Autopilot now reviews submitted plans itself, auto-approves sound plans, requests revisions when needed, and starts implementation without a human blocker.

### Patch Changes

- @kenkaiiii/gg-ai@5.8.0
- @kenkaiiii/gg-agent@5.8.0
- @kenkaiiii/gg-core@5.8.0

## 5.7.0

### Minor Changes

- Add XP progression system: rank engine, git-based XP, persistent progress store, and sidecar progress endpoints powering the gg-app rank badge, scorecard, and level-up celebrations.

### Patch Changes

- @kenkaiiii/gg-ai@5.7.0
- @kenkaiiii/gg-agent@5.7.0
- @kenkaiiii/gg-core@5.7.0

## 5.6.3

### Patch Changes

- Fix duplicate session files created on every resume — resuming now appends to the original session file instead of forking a byte-identical copy each time.
  - @kenkaiiii/gg-ai@5.6.3
  - @kenkaiiii/gg-agent@5.6.3
  - @kenkaiiii/gg-core@5.6.3

## 5.6.2

### Patch Changes

- Optimize Ken mentor/autopilot prompt caching: fold static project context (CLAUDE.md/AGENTS.md) into the cached system prompt instead of resending it uncached every turn, and force long cache retention on Ken sessions independent of the user's global speed profile.
  - @kenkaiiii/gg-ai@5.6.2
  - @kenkaiiii/gg-agent@5.6.2
  - @kenkaiiii/gg-core@5.6.2

## 5.6.1

### Patch Changes

- Fix Ken autopilot gating, stranded prompt handling, and Ken model selection in the app sidecar.
  - @kenkaiiii/gg-ai@5.6.1
  - @kenkaiiii/gg-agent@5.6.1
  - @kenkaiiii/gg-core@5.6.1

## 5.6.0

### Minor Changes

- Autopilot Ken now has an IGNORE verdict for turns that were never real work (small talk, answered questions, mechanical git ops like commit/push), so trivial turns no longer produce a pointless "all clear" in the transcript.

### Patch Changes

- @kenkaiiii/gg-ai@5.6.0
- @kenkaiiii/gg-agent@5.6.0
- @kenkaiiii/gg-core@5.6.0

## 5.5.1

### Patch Changes

- Fix subagent tool allow-list crashing in the desktop app: the JSON-mode arg parser in `app-sidecar.ts` was missing the `--tools` flag, so any named agent with a `tools:` allow-list (bee, owl, researcher, worker) failed to spawn with "Unknown option '--tools'".
  - @kenkaiiii/gg-ai@5.5.1
  - @kenkaiiii/gg-agent@5.5.1
  - @kenkaiiii/gg-core@5.5.1

## 5.5.0

### Minor Changes

- Add autopilot Ken auto-review loop: after each turn a separate read-only Ken reviewer judges the work and either sends GG Coder back in with a fresh prompt, calls it all-clear, or flags for a human. Also auto-prune completed tasks from the sidecar task list.

### Patch Changes

- @kenkaiiii/gg-ai@5.5.0
- @kenkaiiii/gg-agent@5.5.0
- @kenkaiiii/gg-core@5.5.0

## 5.4.3

### Patch Changes

- Enforce subagent `tools:` frontmatter as an allowlist, raise the subagent turn cap to 50 with a clear cut-off signal when it's hit, and phrase `/init` and task-handoff notices for the gg-app UI instead of CLI keybinds.
  - @kenkaiiii/gg-ai@5.4.3
  - @kenkaiiii/gg-agent@5.4.3
  - @kenkaiiii/gg-core@5.4.3

## 5.4.2

### Patch Changes

- Auto-continue once when a tool call fails 3x with completely empty arguments (a provider stream glitch, not a model schema mistake), and correctly attribute the resulting error to the provider instead of mislabeling it a ggcoder bug.
  - @kenkaiiii/gg-ai@5.4.2
  - @kenkaiiii/gg-agent@5.4.2
  - @kenkaiiii/gg-core@5.4.2

## 5.4.1

### Patch Changes

- Fix gg-app auto-compaction not reserving headroom for a model's real output budget (e.g. GPT-5.5 over Codex OAuth: 272K window, up to 128K output), which let context grow until the provider rejected the turn with "exceeds the context window"; also fix the app's context-window footer to use the correct transport-specific window (Codex OAuth vs public API).
  - @kenkaiiii/gg-ai@5.4.1
  - @kenkaiiii/gg-agent@5.4.1
  - @kenkaiiii/gg-core@5.4.1

## 5.4.0

### Minor Changes

- Re-enable Claude Fable 5 in the model selector, and show clean, provider-attributed error messages (headline + guidance + reset time for usage limits) instead of raw JSON error blobs from providers like Xiaomi MiMo.

### Patch Changes

- @kenkaiiii/gg-ai@5.4.0
- @kenkaiiii/gg-agent@5.4.0
- @kenkaiiii/gg-core@5.4.0

## 5.3.0

### Minor Changes

- Add Xiaomi MiMo-V2.5-Pro-UltraSpeed, served over a separate API Credits endpoint. Xiaomi auth now supports both the existing Token Plan key and a new API Credits key — `mimo-v2.5-pro`/`mimo-v2.5` prefer the Token Plan and fall back to API Credits when that's all that's configured, while UltraSpeed requires API Credits. `ggcoder login` and the desktop login modal both let you choose which endpoint to authenticate with.

### Patch Changes

- @kenkaiiii/gg-ai@5.3.0
- @kenkaiiii/gg-agent@5.3.0
- @kenkaiiii/gg-core@5.3.0

## 5.2.0

### Minor Changes

- Add Claude Sonnet 5 (`claude-sonnet-5`, 1M context, 128k output, adaptive thinking) replacing Sonnet 4.6, and fix the Anthropic non-streaming fallback so it no longer trips the SDK's "Streaming is required for operations that may take longer than 10 minutes" pre-flight throw on large max_tokens.

### Patch Changes

- @kenkaiiii/gg-ai@5.2.0
- @kenkaiiii/gg-agent@5.2.0
- @kenkaiiii/gg-core@5.2.0

## 5.1.2

### Patch Changes

- Add a tool-steering clause that nudges the model to batch independent read-only calls (read, grep, ls, find) into one turn, cutting round-trips since tool execution is already parallel.
  - @kenkaiiii/gg-ai@5.1.2
  - @kenkaiiii/gg-agent@5.1.2
  - @kenkaiiii/gg-core@5.1.2

## 5.1.1

### Patch Changes

- Fix the gg-app Ken mentor sidecar so it follows model switches after it has been created.
  - @kenkaiiii/gg-ai@5.1.1
  - @kenkaiiii/gg-agent@5.1.1
  - @kenkaiiii/gg-core@5.1.1

## 5.1.0

### Minor Changes

- Add Ken Kai, a read-only mentor agent: a second AgentSession scoped by an `allowedTools` allow-list plus an `allowedMcpServers` whitelist (kencode-search) so it can research real code but never mutate the repo, with its advisory turns persisted alongside the build session as non-LLM custom entries that survive resume and compaction.

### Patch Changes

- @kenkaiiii/gg-ai@5.1.0
- @kenkaiiii/gg-agent@5.1.0
- @kenkaiiii/gg-core@5.1.0

## 5.0.0

### Major Changes

- Remove the `ggcoder pixel` error-tracking command and all gg-pixel SDK packages (breaking CLI change), and add test-drift detection to the ideal-review hook so editing a source file whose sibling test was left untouched now prompts the agent to update the stale test.

### Patch Changes

- @kenkaiiii/gg-ai@5.0.0
- @kenkaiiii/gg-agent@5.0.0
- @kenkaiiii/gg-core@5.0.0

## 4.15.0

### Minor Changes

- Add `code_search` AST-aware tool (TS/JS symbol chunking + BM25 ranking) and opt-in hashline anchors for read/edit (stale-edit rejection via line+hash guard).

### Patch Changes

- @kenkaiiii/gg-ai@4.15.0
- @kenkaiiii/gg-agent@4.15.0
- @kenkaiiii/gg-core@4.15.0

## 4.14.3

### Patch Changes

- Fix queued messages overriding the original task: mid-run steering prompts are now framed as concurrent instructions so the agent folds them into the current work instead of abandoning the original objective.
  - @kenkaiiii/gg-ai@4.14.3
  - @kenkaiiii/gg-agent@4.14.3
  - @kenkaiiii/gg-core@4.14.3

## 4.14.2

### Patch Changes

- Add prompt-enhancer sidecar capability with project-stack-aware terminology, and harden image attachments — malformed/unsupported images (e.g. a bad .ico) now degrade to a file note instead of failing the whole turn.
  - @kenkaiiii/gg-ai@4.14.2
  - @kenkaiiii/gg-agent@4.14.2
  - @kenkaiiii/gg-core@4.14.2

## 4.14.1

### Patch Changes

- Fix Anthropic 1h prompt-cache TTL by sending the extended-cache-ttl beta header on the streaming and prewarm paths, so `cacheRetention: "long"` no longer silently falls back to the 5-minute default.
  - @kenkaiiii/gg-ai@4.14.1
  - @kenkaiiii/gg-agent@4.14.1
  - @kenkaiiii/gg-core@4.14.1

## 4.14.0

### Minor Changes

- Add Sakana Fugu provider (Fugu, Fugu Ultra) with API-key login, high/xhigh reasoning, and a silent-reasoning stream-timeout extension.

### Patch Changes

- @kenkaiiii/gg-ai@4.14.0
- @kenkaiiii/gg-agent@4.14.0
- @kenkaiiii/gg-core@4.14.0

## 4.13.3

### Patch Changes

- Fix orphaned queued messages after an abort — drain the post-abort queue even when the run was interrupted, so a reprompt during async teardown isn't stranded.
  - @kenkaiiii/gg-ai@4.13.3
  - @kenkaiiii/gg-agent@4.13.3
  - @kenkaiiii/gg-core@4.13.3

## 4.13.2

### Patch Changes

- Add tool-call and error logging to the gg-app sidecar event bridge so fatal "invalid tool arguments" aborts leave a forensic trail in `~/.gg/gg-app-sidecar.log` (tool name, isError, result preview, and agent error events) instead of failing silently.
  - @kenkaiiii/gg-ai@4.13.2
  - @kenkaiiii/gg-agent@4.13.2
  - @kenkaiiii/gg-core@4.13.2

## 4.13.1

### Patch Changes

- Spawn dependency-backed stdio MCP servers (e.g. the default kencode-search)
  directly via `node <binScript>` instead of `npx -y <pkg>`, removing the ~100 MB
  `npm exec` wrapper process per MCP connection. Non-dependency / non-npx servers
  pass through unchanged.

  Also ships content-aware compression for bash/task_output truncation (preserves
  errors over blind tail slices) and the gg-app shared-daemon backend refactor.
  - @kenkaiiii/gg-ai@4.13.1
  - @kenkaiiii/gg-agent@4.13.1
  - @kenkaiiii/gg-core@4.13.1

## 4.13.0

### Minor Changes

- Update system prompt talk section for ADHD-readable responses

  Rewrite `renderTalkSection()` so every reply leads with the outcome word
  (Fixed/Done/Broken/Failed), enforces bottom-line-first scanning, one idea
  per line, pick-don't-menu, concrete metrics, no unresolved it-depends, and
  affirmative phrasing. Designed for fast scanning and low working memory.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.13.0
  - @kenkaiiii/gg-agent@4.13.0
  - @kenkaiiii/gg-core@4.13.0

## 4.12.2

### Patch Changes

- Fix Windows sidecar crash: the session-folder name encoder (`encodeCwd`) now strips Windows extended-length path prefixes (`\\?\` and `\\?\UNC\`) and all reserved filename characters (`<>:"|?*`). Previously, Windows canonicalized cwds (`\\?\C:\Users\brams`) produced illegal folder names containing `?`, causing `mkdir` ENOENT and a fatal sidecar crash on startup — blocking OAuth/login for all Windows users.
- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.2
  - @kenkaiiii/gg-agent@4.12.2
  - @kenkaiiii/gg-core@4.12.2

## 4.12.1

### Patch Changes

- Add performance benchmarks and optimize streaming, tool execution, and rendering pipeline
  - edit-diff: lazy normalization cache for fuzzy matching (5-7× faster on large files)
  - ls: parallel stat() via Promise.all (3.7-5.5× faster on large dirs)
  - StreamResult: backpressure with high/low-water marks to bound memory (10× reduction)
  - agent-loop: mixed-mode tool execution batches consecutive parallel-safe tools (2-10× faster)
  - agent-loop: per-tool timeout isolation via AbortSignal.any (prevents indefinite hangs)
  - agent-loop: gate diagnostic char-counting behind \_diagFn (eliminates per-turn overhead)
  - Markdown.tsx: block-level memoization via marked.lexer (only active block re-parses)
  - App.tsx: requestAnimationFrame-throttled appendAssistant (5-10× fewer re-renders)
  - benchmarks: full harness with before/after comparison tables (pnpm bench)

- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.1
  - @kenkaiiii/gg-agent@4.12.1
  - @kenkaiiii/gg-core@4.12.1

## 4.12.0

### Minor Changes

- Add generate_image tool: generate and edit images via OpenAI gpt-image-2 through the Codex backend. Conditionally registered when OpenAI is connected. Includes inline image preview in transcript, shimmering skeleton placeholder during generation, 1:1 history reconstruction for tool-produced images and sub-agent groups on session resume, and image path exposure for multi-turn editing.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.12.0
  - @kenkaiiii/gg-agent@4.12.0
  - @kenkaiiii/gg-core@4.12.0

## 4.11.3

### Patch Changes

- 1c37b11: Persist model + thinking selection per-project (per window) across app restarts.

  Previously every window's sidecar wrote its model choice to a single shared
  `defaultModel`/`defaultProvider` slot in `~/.gg/settings.json`, so switching a
  model in one window clobbered the selection for all others — and on restart
  every window defaulted to the last-written model (or fell back to the provider
  default when that provider wasn't logged in). Model + thinking preferences are
  now stored keyed by project cwd in `~/.gg/gg-app.json` and read first on boot;
  the global slot is kept only as a fallback for never-opened projects.
  - @kenkaiiii/gg-ai@4.11.3
  - @kenkaiiii/gg-agent@4.11.3
  - @kenkaiiii/gg-core@4.11.3

## 4.11.2

### Patch Changes

- a2da1f8: Fix app subagents to inherit the active model at spawn time and render completed plan-step markers cleanly.
  - @kenkaiiii/gg-ai@4.11.2
  - @kenkaiiii/gg-agent@4.11.2
  - @kenkaiiii/gg-core@4.11.2

## 4.11.1

### Patch Changes

- Fix sub-agents hanging until timeout when spawned from a host whose `argv[1]`
  isn't the CLI entry (e.g. the desktop app's sidecar). The subagent tool now
  resolves `dist/cli.js` relative to its own module instead of trusting
  `process.argv[1]`, so sub-agents run and stream NDJSON correctly in every host.
  - @kenkaiiii/gg-ai@4.11.1
  - @kenkaiiii/gg-agent@4.11.1
  - @kenkaiiii/gg-core@4.11.1

## 4.11.0

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-core@4.11.0
  - @kenkaiiii/gg-ai@4.11.0
  - @kenkaiiii/gg-agent@4.11.0

## 4.10.2

### Patch Changes

- Fix duplicated transcript text and random whitespace in the terminal UI. The
  bottom-pinned shrink-backfill repaint reconstructed the on-screen transcript by
  re-serializing history (markdown re-render + wrapAnsi); when a row's visual
  width diverged from the terminal (wide emoji, bold/italic markdown, CJK) the
  rebuilt row count disagreed with ink's frame math, causing the repaint to
  overlap still-present rows (duplicate lines) or pad short with blank rows
  (injected whitespace). It fired on nearly every turn. The repaint is now
  disabled by default — ink falls back to a cursor-up pad-consume that never
  repaints content — eliminating both failure modes. Opt back in with
  `GG_SHRINK_BACKFILL=1`. Also adds `[scrollback]` debug logging across every
  native-scrollback write path.
  - @kenkaiiii/gg-ai@4.10.2
  - @kenkaiiii/gg-agent@4.10.2
  - @kenkaiiii/gg-core@4.10.2

## 4.10.1

### Patch Changes

- Fix `ggcoder continue` resuming the newest-created session instead of the one you last spoke in (now sorts by last-message activity), and fix inline-image scrollback corruption (base64 spew, duplicated lines, and misaligned images) by bailing the shrink-backfill text repaint when the transcript contains an image.
  - @kenkaiiii/gg-ai@4.10.1
  - @kenkaiiii/gg-agent@4.10.1
  - @kenkaiiii/gg-core@4.10.1

## 4.10.0

### Minor Changes

- Update Kimi to K2.7 (`kimi-k2.7-code`) as the Moonshot default model, replacing Kimi K2.6 across the registry, CLI, login UI, and docs.

  Harden Kimi OAuth token refresh so it no longer silently falls back to a paid Moonshot API key: refresh reuses the existing refresh token when the server doesn't rotate it, tokens are renewed proactively before expiry (60s skew), `baseUrl` is preserved across refreshes, and a genuinely-dead OAuth credential now logs a warning instead of switching billing silently.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.10.0
  - @kenkaiiii/gg-agent@4.10.0
  - @kenkaiiii/gg-core@4.10.0

## 4.9.1

### Patch Changes

- Fix blank rows being reserved above short live content during streaming. The
  live-area height estimate over-counted non-text rows (slash-command info lines,
  tool/step markers), which falsely clamped the live area to its full budget and
  bottom-anchored the content — leaving a block of empty rows above it until the
  rows flushed to history. The estimate is now biased low; Ink's
  clipFrameToTerminalHeight remains the authoritative overflow backstop.
  - @kenkaiiii/gg-ai@4.9.1
  - @kenkaiiii/gg-agent@4.9.1
  - @kenkaiiii/gg-core@4.9.1

## 4.9.0

### Minor Changes

- Add LSP inline diagnostics to the edit/write tools. Successful edits now append
  compiler-grade error diagnostics (`Diagnostics in src/a.ts (informational …):
L42:7 Type 'string' is not assignable …`) so the model self-corrects type errors
  in the same turn. `typescript-language-server` + `typescript` ship bundled, so
  TS/JS diagnostics work for every user with zero setup; Python/Go/Rust/C servers
  are auto-detected from the project or PATH when present. Servers spawn lazily,
  are time-budgeted, and degrade silently — output is byte-identical when no server
  is available. Opt out with `"lspDiagnostics": false` in `~/.gg/settings.json`.

### Patch Changes

- @kenkaiiii/gg-ai@4.9.0
- @kenkaiiii/gg-agent@4.9.0
- @kenkaiiii/gg-core@4.9.0

## 4.8.7

### Patch Changes

- Fix the intermittent blank-row block appearing right before the agent's final response: the patched ink's bottom-anchor pad debt left over from a run-end frame shrink is now reclaimed when the anchor deactivates (ink fork 6.8.0-gg.2). Also: oversized flushed assistant prefixes leave live state immediately, and null-rendering items no longer inflate the live-area clamp estimate.
  - @kenkaiiii/gg-ai@4.8.7
  - @kenkaiiii/gg-agent@4.8.7
  - @kenkaiiii/gg-core@4.8.7

## 4.8.6

### Patch Changes

- Fix message vanish on slash-command submit: queueFlush now mirrors flushed rows into sessionStore.history synchronously so the patched ink's bottom-pinned repaint (menu close, resize) redraws from a current transcript. Also track /theme switches live so closure-level repaint serializers always use the active theme, not the startup theme.
  - @kenkaiiii/gg-ai@4.8.6
  - @kenkaiiii/gg-agent@4.8.6
  - @kenkaiiii/gg-core@4.8.6

## 4.8.5

### Patch Changes

- Ship the patched Ink rendering engine to npm installs. The TUI's footer-anchor and scrollback fixes live in a patched ink build that pnpm's patchedDependencies only applied inside the workspace — npm users silently got vanilla ink. ggcoder's ink dependency is now an npm alias to the published @kenkaiiii/ink fork, so every install (npm, pnpm, yarn, bun) gets the fixed renderer with no install scripts.
  - @kenkaiiii/gg-ai@4.8.5
  - @kenkaiiii/gg-agent@4.8.5
  - @kenkaiiii/gg-core@4.8.5

## 4.8.4

### Patch Changes

- Fix footer jumps and scrollback whitespace/duplication in the scrollback-mode TUI. The patched Ink now folds transcript flushes atomically into frame writes (insertBeforeFrame), anchors the frame bottom with reclaimable pad debt while the agent runs, clips frames to terminal height, and repaints in place (cursor home + eraseDown) for bottom-pinned idle height changes like the slash-command menu — so the footer stays pinned, responses have no phantom gaps, and scrollback receives no duplicate banner/prompt copies.
  - @kenkaiiii/gg-ai@4.8.4
  - @kenkaiiii/gg-agent@4.8.4
  - @kenkaiiii/gg-core@4.8.4

## 4.8.3

### Patch Changes

- Fix oversized pinned assistant items being cut off in the live area: flush tall finalized items (cumulative over the pinned set) to scrollback, and keep the height-clamp slice from starting on a blank line so the ⏺ prefix stays aligned.
  - @kenkaiiii/gg-ai@4.8.3
  - @kenkaiiii/gg-agent@4.8.3
  - @kenkaiiii/gg-core@4.8.3

## 4.8.2

### Patch Changes

- Fix TUI scrollback corruption from streaming markdown tables and inline images: table-aware live-region row estimation, pending-table height clamping and partial-row hold-back in the markdown renderer, and fixed-height inline image blocks so Ink's live-frame erase math stays in sync (no more orphaned ⏺ rows).
  - @kenkaiiii/gg-ai@4.8.2
  - @kenkaiiii/gg-agent@4.8.2
  - @kenkaiiii/gg-core@4.8.2

## 4.8.1

### Patch Changes

- Fix ENOSPC crash when session transcript writes fail (disk full) — persistence now fails soft with a one-time warning instead of killing the live session. Add automatic session transcript pruning via new `sessionRetentionDays` setting (default 30 days, 0 disables).
  - @kenkaiiii/gg-ai@4.8.1
  - @kenkaiiii/gg-agent@4.8.1
  - @kenkaiiii/gg-core@4.8.1

## 4.8.0

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.8.0
  - @kenkaiiii/gg-core@4.8.0
  - @kenkaiiii/gg-agent@4.8.0

## 4.7.0

### Minor Changes

- Add `task_send` tool for interactive control of background processes. Background processes started with `run_in_background` now spawn with a stdin pipe, and the agent can answer prompts, drive REPLs, and feed scaffolders via `task_send` (with optional Enter/EOF), pairing with the existing `task_output`/`task_stop` tools.

### Patch Changes

- @kenkaiiii/gg-ai@4.7.0
- @kenkaiiii/gg-agent@4.7.0
- @kenkaiiii/gg-core@4.7.0

## 4.6.3

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.3
  - @kenkaiiii/gg-agent@4.6.3
  - @kenkaiiii/gg-core@4.6.3

## 4.6.2

### Patch Changes

- Fix OpenAI OAuth account switching by adding prompt=login to authorize URL. Previously, re-running `ggcoder login` with OpenAI would silently re-approve the cached browser session, preventing users from switching accounts.
- Updated dependencies
  - @kenkaiiii/gg-core@4.6.2
  - @kenkaiiii/gg-ai@4.6.2
  - @kenkaiiii/gg-agent@4.6.2

## 4.6.1

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.1
  - @kenkaiiii/gg-agent@4.6.1
  - @kenkaiiii/gg-core@4.6.1

## 4.6.0

### Minor Changes

- Add Xiaomi MiMo-V2.5 models with native video analysis. The text-only
  `mimo-v2.5-pro` is now the Xiaomi default, and the omnimodal `mimo-v2.5`
  supports native image and video understanding. Video read through the read
  tool is now delivered to MiMo (and other non-Moonshot OpenAI-compatible video
  models) in a follow-up user message as inline base64 `video_url`, the shape
  the API accepts — fixing the fallback where the model resorted to ffmpeg frame
  extraction. The read tool is also rebuilt on model switch so its video
  capability tracks the active model.

### Patch Changes

- Updated dependencies
  - @kenkaiiii/gg-ai@4.6.0
  - @kenkaiiii/gg-agent@4.6.0
  - @kenkaiiii/gg-core@4.6.0

## 4.5.0

### Minor Changes

- Add native video analysis for Kimi K2.6, Gemini, and MiniMax. Attached and read videos are sent to the model in its required format (Kimi file-service upload, Gemini inlineData, MiniMax base64), with per-model size caps and automatic ffmpeg compression for oversized clips. Non-video models now show a clean "this model can't analyze video" message instead of an opaque provider error, and Kimi OAuth login was fixed to pass the coding-endpoint client identity.

### Patch Changes

- @kenkaiiii/gg-ai@4.5.0
- @kenkaiiii/gg-agent@4.5.0
- @kenkaiiii/gg-core@4.5.0

## 4.4.0

### Patch Changes

- Updated dependencies [9e381ad]
  - @kenkaiiii/gg-core@4.4.0
  - @kenkaiiii/gg-ai@4.4.0
  - @kenkaiiii/gg-agent@4.4.0
