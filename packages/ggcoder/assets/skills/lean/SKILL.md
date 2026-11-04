---
name: lean
description: Use when speed or resource use matters. Do NOT use for correctness bugs.
license: Performance engineering guidance, not a benchmark certification. Sources and snapshot date are recorded at the foot of each reference file.
compatibility: Snapshot dated 17 August 2026. Thresholds, tool names, and defaults decay — re-verify with web access before asserting them as current. Claims sourced to that date carry a SNAPSHOT marker.
---

# Lean

Make software fast, light, and smooth — loads quick, responds instantly, holds memory flat, leaves nothing running behind it. Built for the reality that users rarely ask for performance: they ask for a feature, then quietly leave when it eats RAM or takes five seconds to open.

**This skill is on from the first line of code.** The default mode is the inline gate below — build the lean version while writing the feature, in the main thread. The full pass is for existing projects and pre-ship checks.

## Governing rules

1. **Measure, then cut.** In a pass, never optimize from vibes: baseline, find the bottleneck, fix it, re-measure. Guessing produces premature optimization — complexity without user-visible gain. In build mode the binding defaults below are pre-paid by platform evidence: apply them without benchmarking.
2. **Fix the shared cause once.** The N+1 belongs in the query layer, not a memo at each call site. Check every caller of the slow path before patching where it hurt.
3. **Optimize user time, not machine time.** What users wait on: startup, first paint, navigation, hot interactions, the nightly job. Micro-tuning code nobody waits for is last, always.
4. **Memory should be flat.** After N cycles of the core loop, committed memory should look like after 1. Sustained growth is a leak until proven otherwise; a sawtooth that returns to baseline is GC, not a leak.
5. **Nothing outlives its job.** Timers, listeners, observers, subscriptions, watchers, child processes, temp files, locks — everything with a lifetime needs an owner that ends it, on the success path *and* every failure path.
6. **Bounded by default.** If it can grow — cache, queue, buffer, retry, log, list render — it gets a cap and an eviction policy at creation, not after the incident.
7. **Small is fast.** Dead code, unused dependencies, and duplicate styles are parsed, shipped, and paid for. Removing is the cheapest optimization there is.
8. **Numbers or silence.** Verify with before/after on the same machine and data, cold and warm. "Feels faster" is not a result, and never claim "optimized", "leak-free", or "fast" — say what moved, from X to Y, and what you could not measure.
9. **No perf theater.** Complexity must pay for itself in measured user time; otherwise revert. Caching that introduces staleness bugs for an unmeasured gain is a regression wearing a costume.
10. **Label evidence** on every claim: `RUNTIME` (you measured it), `CODE` (you read it), `DEDUCED` (inferred), `SNAPSHOT` (dated source claim). Never present what you read as what you ran.

## Two modes

**Inline gate** — while writing any feature, apply the binding defaults below. One line in the reply about what you did and why it matters, then move on. Do not stop the build to lecture, and do not ship the heavy version intending to "optimize later" — later never comes.

**Full pass** — triggered by "make it faster", "why is it slow / eating RAM / lagging", "will this run smoothly", a suspected regression, or a pre-ship check. Run the workflow below. Per-stack sweeps and measurement commands live in `references/playbooks.md`; the memory-leak catalog and process/zombie lifecycle detail live in `references/memory-and-processes.md`.

## Binding defaults (build mode)

Apply on every feature, every stack. These are the habits that prevent the pass from ever being needed:

- **Teardown ships with the feature.** Whatever you start — timer, listener, observer, subscription, child process, watcher — is torn down in the same module that started it, on success and error paths. Prefer one cleanup handle per owner (an `AbortController` for all of a component's fetches and listeners; a destructor/dispose method; a `finally` block) over scattered manual removes.
- **Cap every accumulation.** LRU/TTL cache, bounded queue, paginated query, virtualized list, capped retries with backoff, rotating logs. Unbounded is a bug with a delay.
- **Never block the interactive thread.** Chunk, defer, or offload work that can exceed a frame (web main thread long task threshold: 50ms) — web workers, background threads, task queues, utility processes. I/O stays async on the hot path; no sync fs/crypto/CPU spikes inside request handlers or UI code.
- **Lazy by default, eager only for the first screen.** Below-the-fold media, rare routes, heavy editors, optional services: load on demand (dynamic `import()`, deferred `require`, on-demand plugin init). Preload/preconnect only what the critical path demonstrably needs.
- **Right-size media.** AVIF/WebP with JPEG fallback, explicit `width`/`height` (also kills layout shift), `srcset`/`sizes` for density, decode thumbnails instead of full images.
- **Stream, don't hoard.** Stream files and large responses, paginate/cursor DB queries, chunk large jobs. Loading a whole dataset into memory to process it item by item is the classic hog.
- **Timeout everything external.** Network calls, subprocesses, locks, queues — no unbounded waits, and teardown on timeout.
- **Price a dependency before adopting it** in anything user-facing: its load cost is your load cost (`node --cpu-prof --heap-prof -e "require('mod')"` for Node-side; bundle impact for client-side). The most-downloaded module is not the lightest.
- **Batch I/O and reads-then-writes.** One query for N rows, not N queries; group DOM reads before writes; coalesce events (debounce/throttle) when handlers are expensive.

## Full-pass workflow

### 1. Profile the target from the code

Before asking the user anything: shape (web app, API, CLI, desktop, mobile, library, game, ML pipeline — read manifests, lockfiles, build and CI configs), the surfaces users wait on (startup, first screen, navigation, hot interactions, batch jobs), scale (data sizes, traffic, session length), and platform constraints (low-end devices matter more than the dev machine).

### 2. Baseline, or say you cannot

Runtime numbers when the project runs: load time, startup time, p50/p99 latency, bundle sizes, RSS/heap at rest and after repeated cycles. Exact commands per stack are in `references/playbooks.md`. If you cannot run it (no environment, no data, no time), do a `CODE`-labeled static pass and say plainly in the report that nothing was measured — do not fabricate a baseline.

### 3. Sweep the six areas

Work this list in order — it reflects where user-perceived damage concentrates, not what is most interesting to engineer. Detection specifics per stack: `references/playbooks.md`; areas 3–4: `references/memory-and-processes.md`.

| # | Area | What you are hunting |
|---|---|---|
| 1 | **Loading & startup** | Slow first paint/open, render-blocking resources, giant bundles, eager imports of rarely-used code, waterfall requests, unoptimized media and fonts, cold-start work that could be deferred |
| 2 | **Runtime responsiveness** | Long tasks blocking input, layout thrash, expensive re-renders, N+1 queries, sync work on hot paths, missing pagination, unvirtualized long lists, GC pressure from allocation churn |
| 3 | **Memory** | Growth over time (leaks): forgotten timers/listeners/observers, detached DOM held alive, unbounded caches and maps, closures capturing large scope, cycles in non-GC runtimes, undecoded-or-full-size media, whole-file loads where streaming would do |
| 4 | **Processes & lifecycle** | Zombie children (spawned, never reaped), orphans surviving parent exit (killed the node, not the tree), missing signal handling and graceful shutdown, leaked ports/fds/locks/temp files, no startup sweep for crash leftovers |
| 5 | **Payload & dead weight** | Unused dependencies, dead code and dead exports, dead/duplicate CSS, two libraries doing one job (two icon sets, two date libs, two CSS systems), ship-weight of debug/symbol payloads, tree-shaking blockers |
| 6 | **Styling consistency** | Same visual thing built three ways — repeated rule blocks, one-off spacing/color literals that duplicate tokens, framework utilities fighting handwritten CSS. Consistency here is payload: one way to do X is the only way that stays small. (Design direction itself is evidence-led-ui's call.) |

### 4. Rank by user impact, fix the top, not all

| Severity | Meaning |
|---|---|
| **Critical** | Blocks or breaks: startup counted in tens of seconds, OOM crashes, multi-second UI freezes, a leak that kills a session in minutes |
| **High** | User-perceivable degradation: sluggish interactions, fan-spinning idle CPU, RAM that climbs over a workday, zombie processes accumulating across runs, slowest paths 2–10× slower than they should be |
| **Medium** | Waste with symptoms at scale: bundle bloat, N+1 under load, unbounded caches, missing pagination, duplicate dependencies |
| **Low** | Hygiene without a measured symptom: dead code, dead styles, micro-tuning. Do these when adjacent to a real fix, never instead of one. |

Fix the few that measurement actually implicates — three to five, rarely more. Each fix records its baseline number first. Prefer removing work over hiding it (delete the eager import beats code-splitting it beats deferring it), and prefer the platform primitive over a hand-rolled one.

### 5. Verify the fix

Re-measure exactly how you baselined, same machine, same data, cold and warm. A fix you did not measure is a hypothesis. For memory: cycle the changed path many times, force GC where the runtime allows (`--expose-gc`, DevTools), and compare committed memory — flat wins, sawtooth is fine, climbing is not fixed. If the number did not move, revert and say so; a change that adds complexity without moving the number is a regression.

### 6. Leave a guard behind

One check so it cannot silently return: bundle-size budget in CI, Lighthouse CI or `size-limit` for web, a slow-query threshold, a repeated-cycle memory assertion where feasible, a test that fails if the eager import returns. One gate beats good intentions.

### 7. Report

- Lead with numbers: what moved, X → Y, on which machine/data/date.
- Then remaining findings, ranked, each with file/line and the fix.
- Then what was **not checked** — unmeasured areas, stacks skipped, environments unavailable. A report that silently skips the mobile client or the batch job reads as complete coverage.
- Then what you changed vs. what you recommend and did not do.
- Label every claim `RUNTIME` / `CODE` / `DEDUCED` / `SNAPSHOT`. Include your false positives — candidates you investigated and dropped — so the survivor list is not hiding its noise.

## Honesty rules

- Never state or imply the software is "fast", "optimized", or "leak-free". State what was measured, fixed, and left unchecked.
- Never present a lint rule, bundle analyzer, or profiler as proof of the absence of problems; tools find a minority of what matters.
- Never invent a number, threshold, or version. If the claim is date-sensitive and unverified, mark it `SNAPSHOT` or say "verify this".
- "I could not measure this" is a legitimate and useful output. A fabricated confirmation is not.
- If the project is a prototype with no users and no load, say that proportionality applies — five real fixes beat forty ignored ones — and stop early.

## Reference map

Resolve every path from the installed skill root. Load only what the profile triggered.

- `references/playbooks.md` — per-stack sweeps and measurement commands: web frontend (Core Web Vitals with official thresholds), Node/backend/API, Electron, Tauri, mobile, native/compiled (Rust, C/C++, Go, JVM), Python, data & queries, and the payload/dead-weight/styling-consistency tooling. Read the sections the profile triggered.
- `references/memory-and-processes.md` — the leak catalog by pattern, detection technique per runtime (three-snapshot, allocation timeline, heap dumps, pprof, valgrind, Instruments, LeakCanary), component-framework leak rules, and the process lifecycle playbook: zombies, orphans, signal handling, process-tree kills, container PID 1, startup sweeps, leaked fds/ports/temp files. Read for any memory or process finding.
