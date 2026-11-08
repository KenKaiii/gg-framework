# Lean — memory & processes

The deep reference for two of the six sweep areas: memory (leaks and hogging) and process lifecycle (zombies, orphans, shutdown). Read for any finding in those areas.

## Part 1 — Memory

### The leak taxonomy

Every memory leak is one of a small number of shapes. Name the shape before hunting the instance:

1. **Forgotten teardown** — a timer, listener, observer, subscription, or callback registered against something long-lived (window, document, a global emitter, an event bus, a message broker) and never removed. The registration itself keeps the owner object — and everything it captures — alive.
2. **Detached-but-referenced** — DOM nodes (or view/widget objects) removed from the document but still held by a closure, array, cache, or map. The GC cannot free what a live reference pins; "removed from the screen" is not "freed".
3. **Unbounded accumulation** — a cache, map, array, or queue that only grows. Not a leak by accident — a design that forgot limits. Includes "in-memory session store" with no eviction and metrics maps keyed by unbounded cardinality (per-request keys are the classic).
4. **Captured scope** — a long-lived closure captures a large object it doesn't need (a handler that uses one field but closes over the whole request/state). Also: promises that never settle, pinning everything their closures captured.
5. **Cycles in non-GC runtimes** — Rust `Rc`/`Arc` cycles, C++ shared_ptr loops, Objective-C retain cycles (delegate + strong reference both ways). The reference count never reaches zero. Break the cycle with `Weak` on one edge.
6. **Resource handles** — file descriptors, sockets, database connections, locks, temp files. Not heap, but the same symptom ("it dies after running a while") and the same rule: every acquisition has an owner that releases it on all paths.

### Hogging is not leaking

Flat-but-too-big is the other half. Hunt: whole files/datasets loaded to process item-by-item (stream instead); images decoded at full resolution for thumbnail-sized display (decode down, cache the small one); the same large data duplicated across processes/IPC boundaries (send references or deltas); logs and metrics buffered in RAM without a cap; caches sized by hope instead of measurement ("it'll fit"). In containers, set memory limits (cgroups, `--memory`, K8s requests/limits) so hogging surfaces as a chosen error instead of silent neighbor-starvation.

### Detection technique

**The universal method:** run the suspected loop many times (open/close the view, iterate the endpoint, replay the job), force GC where possible, and compare committed memory between cycles. Flat across cycles = no leak. Sawtooth returning to baseline = GC, not a leak. Climbing staircase = leak. Sample `process.memoryUsage()` (Node), RSS via `ps`/`top`, or the runtime's counter, every N cycles, and log the series — a leak you can graph is a leak you can bisect. Change one thing between runs.

**JavaScript/TypeScript (browser and Node):**

- **Three-snapshot technique** (Chrome DevTools Memory): snapshot → perform the suspected leaky action several times → snapshot → force GC, act again, force GC → snapshot. Objects present in snapshot 3 that grew in count between snapshots 2 and 3 are your leak; the retainer chain shows what pins them.
- **Allocation instrumentation on timeline** records every allocation — blue bars that never get collected mark the leak as it happens.
- `queryObjects(constructor)` in the console counts live instances; Detached nodes filter in heap snapshots for removed-but-pinned DOM.
- Node: `node --inspect` + DevTools heap snapshots; `clinic heap` for guided diagnosis; `--expose-gc` in tests so assertions can GC before measuring. Production-safe heap snapshot on signal where you control the entrypoint.
- The usual suspects, in order of frequency: forgotten `setInterval` (worse than `setTimeout` — it never stops on its own), listeners on long-lived objects added per-mount/per-request, `ResizeObserver`/`IntersectionObserver`/`MutationObserver` never `disconnect()`ed, growing `Map`s used as caches, detached nodes held in module-level arrays, per-request closures stored on a global.

**The unified cleanup pattern** — register everything against one handle and teardown once:

```ts
const ac = new AbortController();
window.addEventListener("resize", onResize, { signal: ac.signal });
fetch(url, { signal: ac.signal }).then(/* ... */);
const ro = new ResizeObserver(onResize); ro.observe(el);
// one teardown path (effect cleanup, session close, SIGTERM handler):
ac.abort(); ro.disconnect(); clearInterval(id);
```

Web-platform APIs accept `AbortSignal` directly; the rest get disconnected in the same teardown function. One owner, one path — including the error path.

**Component frameworks (React and kin):** every subscription started in an effect is returned-from that effect for cleanup, no exceptions; stores and event buses get unsubscribe on unmount; beware module-level singletons accumulating per-component state (registered callbacks never removed — the leak lives on after the component dies). Long lists get virtualized. With React Compiler enabled, don't hand-add `memo`/`useMemo`; without it, catch a real re-render in the Profiler first — memoization has its own memory cost and is frequently perf theater. Watch `key` misuse: index keys on reorder-prone lists cause remount storms (CPU) and stale-capture bugs (memory).

**Rust / C / C++ / Go / JVM / Python:** see the native/compiled and Python sections of `references/playbooks.md` for the per-runtime tools (valgrind/ASan/LSan, heaptrack, pprof, async-profiler/JFR, tracemalloc). The cycle shapes to hunt are listed in the taxonomy above.

### Rules for fixes

Fix the lifetime, not the symptom: remove the registration (or disconnect the observer) at the source that created it; bound the cache with an eviction policy (LRU/TTL) instead of deleting entries manually where it keeps growing; break cycles at the design level (`Weak`/`weakref`/unowned edge) rather than sprinkling cleanups. Then re-run the cycle test and show the flat line. A "fix" without the flat line is not a fix.

## Part 2 — Processes & lifecycle

### Zombies vs orphans

- A **zombie** is a dead child the parent never reaped — it holds a PID and a kernel exit-status slot. Too many exhaust the process table. On Unix, only the parent's `wait()`/`waitpid()` (or equivalent) clears it. **Rust: dropping `Child` does not reap it — you must `wait()`.** Go: `cmd.Wait()`. C: `waitpid`. Node gets an `exit` event automatically — your job is not to spawn what you can't track. A parent that never reaps is itself the bug; the zombies are the receipt.
- An **orphan** is a child whose parent died first. It keeps running, reparented to init — nobody is coming to shut it down. Orphans are what users call "why is this still running after I quit?".

### Kill the tree, not the node

`kill(pid)` kills one process; its spawned children (MCP servers, LSPs, shells, helpers) survive as orphans. Correct patterns:

- **Never kill the host you run in.** Before killing any long-lived daemon, node process, or "orphan", trace its ancestry (`ps -o pid,ppid,command` up the PPID chain) and check it is not your own host or an ancestor of it — agent sessions live *inside* a host daemon process, so a session killing that daemon kills itself mid-turn, and a child killing its parent kills the whole app's sessions. A process that is merely using lots of memory is a measurement finding, not a kill target; report it. Live-session agents do not kill host daemons at all — orphan cleanup belongs to the host's startup sweep (below), never to a session that might be running inside the thing it aims at.
- **Never select targets by name or pattern** (`pkill -f`, `killall`, `pgrep | xargs kill`, `taskkill /IM`): another instance of your own host, or a sibling session's server, matches the same pattern. Signal only an exact PID — or the negative PID of a process group — that you spawned in this task and still hold. PIDs are reused: if your handle is stale (process already exited), do not re-resolve by name; check it is still yours (same start time/command) or leave it.
- **Unix:** start the child in its own process group (`detached: true` in Node, `setsid`/`process_group` elsewhere), then kill the group: `process.kill(-pid, sig)` — the negative PID addresses the whole group. Escalate SIGTERM → grace period → SIGKILL.
- **Windows:** there are no process groups; `taskkill /PID <pid> /T /F` kills the tree (`/T` = tree, `/F` = force), or use a Job Object assigned to children so closing the handle terminates them all.
- **Both:** kill children *before* the parent exits, in order — parents can't clean up after they're dead; and children of an interactive app must die when the app does, normal exit *and* crash.

### Graceful shutdown is a feature

On SIGTERM/SIGINT (and before-exit hooks): stop accepting new work, let in-flight work finish or checkpoint it, kill the child tree (above), close sockets/DB connections, release locks and port registrations, remove pidfiles/ledgers, flush and close logs — with a deadline, then force-exit. Ctrl+C on a dev server leaving a port busy is this feature missing. Test it: send SIGTERM, assert nothing from your app survives (`ps`, `lsof -i :<port>`).

### Crash leftovers: the startup sweep

Processes crash; whatever they left must not outlive the next boot. Pattern: on start, read a ledger of resources you own (pidfiles with PID + start-time to avoid PID reuse, registered ports, lock files under `tmpdir`), verify each is actually one of yours, kill the stale ones, then write your own entry. Flock/`O_EXCL` locks make "is the old one really dead?" checkable rather than guessed. Temp dirs get a sweep of your app's namespaced files on start. This is cheap insurance and the fix for "every crash leaves another zombie until reboot".

### Containers: the PID 1 problem

If your process is PID 1 in a container, it inherits orphaned zombies and default signal handlers that ignore SIGTERM. Either run a proper init (`docker run --init`, tini, dumb-init) or handle it yourself: reap children, trap and act on SIGTERM. K8s does not save you from this — exec-form ENTRYPOINT still makes you PID 1.

### Leaked handles and files

The slow cousins of zombie processes: file descriptors (`lsof -p <pid>` — a climbing count is a leak), sockets/ports held by dead listeners (`ss -ltnp` / `lsof -i`), lock files, and temp files that outlive their writers. Every open() has a matching close() on all paths — `finally`, defer, RAII, context managers — and temp files are created with your app's namespaced prefix so a startup sweep can find them.

### The verification loop

1. Start the app; record `ps`/RSS/fd count for the process tree.
2. Exercise the suspected path N times (open/close, request, job run).
3. Quit — normal exit and SIGKILL both.
4. Assert: nothing from your tree remains (`ps`, port free, fd count back to baseline, temp dir clean), and RSS on next start matches the first start.

Anything that survives step 4 is the finding, and the ledger/sweep/group-kill patterns above are the fix.

---

**Provenance:** snapshot 3 October 2026 (content otherwise from the 17 August 2026 review; OS semantics stable). Sources: Rust std `process::Child` documentation (zombies and reaping), Node.js `child_process` documentation (detached/process-group semantics on Unix and Windows), Docker/tini PID 1 reaping guidance, Chrome DevTools memory documentation (three-snapshot technique, allocation timeline, `queryObjects`), web.dev long-task and lifecycle guidance. OS signal semantics are stable; tool flags and library APIs decay — re-verify specifics with web access before asserting.
