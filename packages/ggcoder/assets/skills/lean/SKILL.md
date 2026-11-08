---
name: lean
description: "Use to make software faster or lighter when speed, memory, CPU or size is the problem. Do NOT use for correctness bugs."
# Checklist audits only (Security, Dependencies, Secrets / Performance); hidden from routine coding after the 27 Oct 2026 skill-value bench.
hidden: true
license: Performance engineering guidance, not a benchmark certification. Sources and snapshot date are recorded at the foot of each reference file.
compatibility: Snapshot dated 3 October 2026. Thresholds, tool names, and defaults decay — re-verify with web access before asserting them as current. Claims sourced to that date carry a SNAPSHOT marker.
---

# Lean

**Pick your mode now:**

| You are… | Mode | Do |
|---|---|---|
| Writing or editing a feature (any size) | **Inline gate** | Apply *Binding defaults* + *AI-code traps* while you write. One line in the reply on what you did. No benchmarks, no spawning. |
| Asked "make it faster / why slow / eating RAM / will it run smoothly", a regression, pre-ship | **Full pass** | Run *Full-pass workflow*. Read `references/playbooks.md` sections for the stacks found; `references/memory-and-processes.md` for any memory or process finding. |
| About to run `kill`/`pkill`/`taskkill`, or "stop that stuck process" | **Process safety** | Obey *Never kill your own host* first. |

Users rarely ask for performance: they ask for a feature, then leave when it eats RAM or takes five seconds to open. This skill is on from the first line of code. Do not ship the heavy version intending to "optimize later".

## Governing rules

1. **Measure, then cut.** In a pass, never optimize from vibes: baseline → find the bottleneck → fix → re-measure. In build mode the binding defaults are pre-paid by platform evidence: apply them without benchmarking.
2. **Fix the shared cause once.** The N+1 belongs in the query layer, not a memo at each call site. Check every caller of the slow path.
3. **Optimize user time, not machine time.** Startup, first paint, navigation, hot interactions, the nightly job. Micro-tuning code nobody waits on is last.
4. **Memory should be flat.** After N cycles of the core loop, committed memory ≈ after 1. A climbing staircase is a leak until proven otherwise; a sawtooth returning to baseline is GC.
5. **Nothing outlives its job.** Timers, listeners, observers, subscriptions, watchers, child processes, temp files, locks — each has an owner that ends it on success *and* every failure path.
6. **Bounded by default.** Cache, queue, buffer, retry, log, list render: cap and eviction policy at creation.
7. **Small is fast.** Dead code, unused deps, duplicate styles are shipped and paid for. Deleting is the cheapest optimization.
8. **Numbers or silence.** Before/after on the same machine and data, cold and warm. Say what moved, X → Y, and what you could not measure.
9. **No perf theater.** Complexity must pay for itself in measured user time, or revert it. Caching that adds staleness bugs for an unmeasured gain is a regression.
10. **Label evidence** on every claim: `RUNTIME` (measured), `CODE` (read in source), `DEDUCED` (inferred), `SNAPSHOT` (dated external source). Never present what you read as what you ran.

## Never kill your own host

Agent sessions run *inside* a host process (Kleio Coder's daemon/sidecar, an editor, a terminal multiplexer). Killing it kills this session and every sibling session mid-turn. This has happened.

- **Never kill by pattern.** No `pkill -f`, `killall`, `kill $(pgrep …)`, `taskkill /IM`, or loops over `ps | grep` output. Kill only an **exact PID or process group you started in this task** (you hold the PID from your own spawn or background-task handle).
- **Before touching any PID you did not start:** walk its ancestry (`ps -o pid,ppid,command -p <pid>`, repeat up the PPID chain) and your own (`$$`, `$PPID` upward). If it is you, an ancestor, or another instance of the same host binary (e.g. another `app-sidecar`/daemon) — **do not kill. Report it.**
- **A process using lots of CPU/RAM is a finding, not a target.** Report PID, command, RSS, age; recommend the fix. Orphan cleanup belongs to the app's startup sweep, never to a live session.
- Unsure whether you own it? You don't. Ask the user.

## Binding defaults (build mode)

- **Teardown ships with the feature.** Whatever you start is torn down in the same module, success and error paths. One cleanup handle per owner: an `AbortController` for a component's fetches and listeners, a `dispose()`, a `finally`.
- **Cap every accumulation.** LRU/TTL cache, bounded queue, paginated query, virtualized long list, capped retries with backoff + jitter, rotating logs.
- **Never block the interactive thread.** Work that can exceed a frame (web long-task threshold: 50 ms) is chunked (`scheduler.yield()` where supported, else `setTimeout` chunking), deferred, or moved to a worker / utility process / background thread. No sync fs/crypto/CPU spikes in request handlers or UI code.
- **Lazy by default, eager only for the first screen.** Rare routes, heavy editors, charts, optional SDKs: dynamic `import()` / deferred `require`. Preload only what the critical path provably needs.
- **Right-size media.** AVIF/WebP with fallback, explicit `width`/`height`, `srcset`/`sizes`, `loading="lazy"` below the fold, `fetchpriority="high"` on the one LCP image only — never lazy-load it.
- **Stream, don't hoard.** Stream files and large responses; cursor-paginate queries; chunk big jobs.
- **Timeout everything external.** Network, subprocesses, locks, queues — and tear down on timeout.
- **Price a dependency before adopting it** in anything user-facing (bundle impact client-side; `node --cpu-prof -e "require('mod')"` server/desktop).
- **Batch I/O.** One query for N rows; DOM reads before writes; debounce/throttle expensive handlers.
- **Events over polling.** Prefer push (WebSocket/SSE, fs watchers, DB notifications, webhooks). If you must poll: slowest interval the UX tolerates, back off when idle, pause on `visibilitychange` hidden, stop on unmount.

## AI-code traps (check every generated diff)

The patterns agents produce most. Scan your own diff for them before replying.

| Trap | Detect | Fix |
|---|---|---|
| Whole-library imports | `import * as Icons`, `import _ from "lodash"`, root imports of big icon/UI/date kits | Per-icon/per-function imports or the library's documented tree-shakable entry; confirm in the bundle analyzer |
| Effect refetch loops | `useEffect` fetching with object/array/function deps created during render, or no deps array | Fetch on the server / in the route loader / via a query library keyed by primitives |
| Over-fetching | `SELECT *`, `findMany()` without `take`/`select`, API returning full rows to render two fields | Select needed columns, paginate, shape on the server |
| N+1 | `await` on a query inside `for` / `.map` | Join/include/batch (`IN (...)`, DataLoader) |
| Unvirtualized lists | `.map` over unbounded data into DOM or `ScrollView` | Paginate or virtualize (`FlatList`/`FlashList`, TanStack Virtual, `LazyColumn`) |
| Polling | `setInterval(fetch…)` without cleanup or visibility check | Events; else backoff + pause + cleanup |
| Everything client-side | `"use client"` at the top of a page tree; browser fetches data the server already had | Push the client boundary down to the interactive leaf |
| Memo sprinkling | `useMemo`/`useCallback`/`React.memo` on everything | React Compiler on → write plain code, keep manual memo only as an escape hatch (e.g. stable effect deps). Compiler off → memo only what the Profiler implicates |
| Unbounded module cache | `const cache = new Map()` at module scope, never evicted | LRU/TTL with a size cap |

## Full-pass workflow

1. **Profile the target from the code.** Shape (manifests, lockfiles, build/CI configs), surfaces users wait on, scale (data sizes, session length), platform constraints (low-end devices matter more than the dev machine). Build the coverage ledger (see Scaling).
2. **Baseline, or say you cannot.** Load/startup time, p50/p99 latency, bundle sizes, RSS/heap at rest and after repeated cycles. Commands: `references/playbooks.md`. If nothing runs, do a `CODE`-labeled static pass and say plainly nothing was measured.
3. **Sweep the six areas, in order:**

| # | Area | Hunting |
|---|---|---|
| 1 | Loading & startup | Slow first paint/open, render-blocking resources, giant bundles, eager imports, request waterfalls, unoptimized media/fonts, deferrable cold-start work |
| 2 | Runtime responsiveness | Long tasks / long animation frames, layout thrash, re-render storms, N+1, sync hot paths, missing pagination/virtualization, allocation churn |
| 3 | Memory | Forgotten timers/listeners/observers, detached DOM, unbounded maps, large captured closures, non-GC cycles, full-size media, whole-file loads |
| 4 | Processes & lifecycle | Unreaped children, orphans (killed node not tree), no signal handling, leaked ports/fds/locks/temp files, no startup sweep |
| 5 | Payload & dead weight | Unused deps/files/exports, dead CSS, two libs for one job, debug payloads shipped, tree-shaking blockers |
| 6 | Styling consistency | Same visual thing built three ways, literals duplicating tokens (design decisions are evidence-led-ui's call) |

4. **Rank by user impact; fix the top three to five.**

| Severity | Meaning |
|---|---|
| Critical | Startup in tens of seconds, OOM, multi-second freezes, a leak that kills a session in minutes |
| High | Sluggish interactions, busy idle CPU, RAM climbing over a workday, zombies accumulating, hot paths 2–10× slower than needed |
| Medium | Bundle bloat, N+1 under load, unbounded caches, missing pagination, duplicate deps |
| Low | Dead code/styles, micro-tuning — only when adjacent to a real fix |

   Record each baseline first. Prefer removing work over hiding it (delete the eager import > code-split it > defer it); prefer the platform primitive.
5. **Verify.** Re-measure exactly as baselined. Memory: cycle the path many times, force GC where possible, compare — flat wins. Number didn't move → revert and say so.
6. **Leave one guard.** Bundle budget (`size-limit`, Lighthouse CI assertions), slow-query threshold, repeated-cycle memory assertion, a test that fails if the eager import returns.
7. **Report.** Numbers first (X → Y, machine, data, date) → remaining findings ranked with file:line and fix → **not checked** list → changed vs recommended → dropped candidates (false positives). Label every claim.

## Scaling: one agent or several

| Situation | Do |
|---|---|
| Inline gate, small edit, single fix | Main thread only. Never spawn. |
| Full pass, one deployable, you can read every relevant file | Single-threaded; build the ledger yourself. |
| Full pass, several deployables (e.g. web + API + desktop shell + mobile), or more ledger rows than you can read fully | Fan out **static review** by surface — frontend / backend / processes & lifecycle — in ONE `spawn_agent` call (≤ 6). |
| A dated claim needs checking (threshold, tool status) | One `researcher` child. |

- **Ledger:** rows = six areas × in-scope units. Each row ends checked-with-findings / checked-clean / not-checked(reason).
- **Child brief (self-contained):** absolute skill root and which `references/*.md` sections to read; slice paths; owned ledger rows; evidence labels; output = findings (file:line, label, severity, fix) + explicit `checked` / `not checked` lists; "read-only: do not kill, start, or benchmark anything". Use `owl`, or a general-purpose child if it must load this skill.
- **Measurement does not fan out on one machine.** Benchmarks, load tests, and memory-cycle runs stay in the main thread, or one child per *separate environment*, so numbers stay comparable (same machine, same data, same build). Never run benchmarks in parallel on the same machine — they distort each other.
- **Merge:** a failed, timed-out, or silent child → its rows are `not checked`, never clean. Re-open every reported file:line before reporting it.
- **Large pre-ship pass:** one fresh-context verifier child tries to disprove the top findings.
- **Edits stay serialized** in the main thread (or `bee` children on strictly disjoint files); re-measure once after merging.

## Honesty rules

- Never state or imply the software is "fast", "optimized", or "leak-free". State what was measured, fixed, and left unchecked.
- A lint rule, analyzer, or profiler is never proof of absence; tools find a minority of what matters.
- Never invent a number, threshold, or version. Date-sensitive and unverified → `SNAPSHOT` or "verify this".
- "I could not measure this" is a useful output. A fabricated confirmation is not.
- Prototype with no users or load → say proportionality applies and stop early.

## Reference map

Resolve paths from the installed skill root. Load only what the profile triggered.

- `references/playbooks.md` — per-stack measurement and sweeps: web (Core Web Vitals, LoAF, React/Next/Vite), Node/backend, data & N+1, Electron, Tauri, mobile, native, Python, payload/dead-code tooling, styling consistency.
- `references/memory-and-processes.md` — leak taxonomy and detection per runtime; process lifecycle: host-safety rule, zombies, orphans, tree kills, graceful shutdown, startup sweeps, container PID 1, leaked handles.
