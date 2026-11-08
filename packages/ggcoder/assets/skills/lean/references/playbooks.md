# Lean — per-stack playbooks

Load only the sections the profile triggered. Commands assume a POSIX shell unless noted. Claims sourced on the snapshot date (3 October 2026) carry `SNAPSHOT`; tool versions and thresholds decay — re-verify with web access before asserting as current.

**Contents:** Web frontend · React / Next.js / Vite · Node.js / backend / API · Electron · Tauri · Mobile · Native / compiled · Python · Data & queries (N+1) · Payload & dead weight · Styling consistency

## Web frontend

**Targets (web.dev Core Web Vitals, field data at p75, mobile and desktop judged separately; unchanged since INP replaced FID in March 2024 — `SNAPSHOT`):**

| Metric | Good | Needs improvement | Poor |
|---|---|---|---|
| LCP (Largest Contentful Paint) | ≤ 2.5s | ≤ 4.0s | > 4.0s |
| INP (Interaction to Next Paint) | ≤ 200ms | ≤ 500ms | > 500ms |
| CLS (Cumulative Layout Shift) | ≤ 0.1 | ≤ 0.25 | > 0.25 |

SEO blogs claim 2026 "tightenings" (LCP 2.0 s, stricter INP). None appear on web.dev as of the snapshot — quote only the table above. Lab tools (Lighthouse) cannot measure INP; it is a field metric. Lab = diagnosis, field (CrUX / RUM) = verdict.

**Measure:**

- Lab: Lighthouse (DevTools, or `npx lighthouse <url> --output json`), DevTools Performance panel (long tasks, long animation frames, layout shifts), Network waterfall, Coverage tab for shipped-but-unused JS/CSS.
- Field: the `web-vitals` npm package; use its **attribution build** (`import { onINP } from "web-vitals/attribution"`) to get INP phase breakdown (input delay / processing / presentation) and the **Long Animation Frames (LoAF)** entries for the slow interaction — LoAF names the script and function that blocked the frame. LoAF is Chromium-only (shipped Chrome 123); script attribution misses cross-origin iframes, workers, and extensions.
- SPAs: route changes after the first load are not separate page views in CrUX. Chrome's **Soft Navigations API** was in a final origin trial (Chrome 147–149) with a planned 2026 ship; how CrUX will use it is undecided (`SNAPSHOT`). Until it ships, measure SPA route transitions yourself (`performance.mark` around route change → next paint).
- Regression gate: Lighthouse CI with assertions (budgets on LCP/CLS/TBT and resource sizes) and/or `size-limit` on bundle bytes.

**Navigation speed:** the **Speculation Rules API** (`<script type="speculationrules">`) prefetches/prerenders likely-next pages. Chromium-only by default as of snapshot (Safari had it behind a flag; Firefox not shipped) — progressive enhancement, harmless elsewhere. Start with `moderate`/`conservative` eagerness; never prerender pages with side effects (logout, cart mutation, analytics that count views) or per-user sensitive content.

**Symptom → usual cause:**

| Symptom | Usual causes | Fixes |
|---|---|---|
| Slow LCP | Oversized hero image, render-blocking CSS/JS, slow TTFB, web-font swap | AVIF/WebP + `srcset`, explicit dimensions, `fetchpriority="high"` on the LCP image, preload the font + `font-display: swap` (subset it), inline critical CSS / defer the rest, fix server TTFB first if > ~400–600ms — no frontend work survives that |
| Poor INP | Long tasks (>50ms) on the main thread, expensive handlers, layout thrash, hydration weight | Split long tasks (`scheduler.yield()` where available, else task chunking), debounce expensive input handlers, batch DOM reads before writes, animate only `transform`/`opacity`, move heavy compute to a web worker, ship less JS |
| High CLS | Images/embeds without dimensions, late banners pushing content, font swap | Width/height or `aspect-ratio` on all media, reserve ad/banner slots (`min-height`), `content-visibility` for below-fold, avoid injecting above existing content |
| Slow nav | Waterfall fetches, client-side everything, no prefetch | Parallelize with `Promise.all`, prefetch likely-next routes, partial/staged rendering, keep-alive connections |

**Sweep list:** code splitting at routes (dynamic `import()`), tree-shaking blockers (side-effectful modules, CJS in the graph, barrel files re-exporting everything), image audit (format, dimensions, `loading="lazy"` + `decoding="async"` below fold, `fetchpriority="high"` on the LCP image only), font count and subsetting, dependency weight (analyzer: `source-map-explorer` works with any bundler's source maps; `rollup-plugin-visualizer` for Rollup/Vite; `webpack-bundle-analyzer` for webpack; Next.js's built-in analyzer for Next), virtualized long lists, context split instead of one giant provider, `passive: true` scroll/touch listeners, debounced resize/search handlers, third-party scripts (tag managers, chat widgets) — often the top INP offender in LoAF data.

## React / Next.js / Vite

- **React Compiler 1.0** (stable Oct 2025; works for React and React Native) auto-memoizes components and hooks. With it on, write plain code; React's guidance keeps `useMemo`/`useCallback` only as an escape hatch (e.g. a value used as an effect dependency). In existing code, don't mass-delete manual memo — removing it can change compiled output; remove only with tests. Without the compiler, memo only what the React DevTools Profiler implicates. The compiler does **not** fix effects: an effect that refetches on every render is still a bug.
- **Next.js 16** (Oct 2025): Turbopack is the default bundler for dev and build. Caching is explicit — with `cacheComponents: true`, dynamic code runs per request and only `"use cache"` functions/components are cached (tune with `cacheLife`/`cacheTag`, invalidate with `revalidateTag`/`updateTag`). Perf checks: is expensive shared data cached? is per-user data kept out of shared cache (`"use cache: private"`)? is `"use client"` pushed down to leaves? are request waterfalls in server components parallelized? Turn on `reactCompiler: true` when the codebase passes the compiler's rules.
- **Vite 8** (stable 12 Mar 2026): Rolldown (Rust) replaces esbuild + Rollup as the single bundler; config key `build.rollupOptions` → `build.rolldownOptions`; needs Node 20.19+/22.12+. Vite 7 projects still use Rollup. Build-time wins are not runtime wins — measure the shipped bundle, not the build clock.

## Node.js / backend / API

**Runtime:** Node 26 becomes Active LTS on 28 Oct 2026; Node 24 moves to maintenance on 20 Oct 2026 (EOL 30 Apr 2028); Node 22 EOL 30 Apr 2027 (`SNAPSHOT`, nodejs/Release schedule). New projects target 24 now, 26 once it is LTS. Bun/Deno: same rules apply; benchmark your workload before switching runtimes for speed — vendor benchmarks are not your app.

**Measure:** `autocannon` or `k6` for load (watch p99, not the average — the average lies), `clinic doctor` / `clinic flame` / `0x` for CPU and event-loop diagnosis, `--inspect` + Chrome DevTools for heap. DB: slow-query log, `EXPLAIN ANALYZE`.

**Sweep list:**

- **Event-loop blocking:** sync fs/crypto/zlib in request handlers, `JSON.parse` of huge payloads on the hot path, regex backtracking. Move to workers or streams.
- **N+1 queries:** one join/include/dataloader instead of a loop of queries. Detection under *Data & queries*.
- **Missing indexes:** every frequent filter/sort column; verify with `EXPLAIN ANALYZE` that the plan uses them.
- **Unpaginated reads:** `SELECT *` on growing tables, `findMany()` without `take`. Cursor pagination for stable ordering.
- **Connection pools:** sized for the DB's real limit; check for pool exhaustion under load (requests queueing on a connection).
- **Caching with bounds:** TTL or LRU on expensive derivations; invalidate on write. Cache stampede guard (lock or stale-while-revalidate) when a hot key expires.
- **Payload:** gzip/brotli on responses, HTTP/2+ or keep-alive, avoid re-serializing the same object per request.
- **Memory ceiling:** `--max-old-space-size` matched to the container limit so GC pressure shows up as errors you chose, not an OOM kill at a random allocation.
- **Retries:** capped, with backoff and jitter; unbounded retry loops are a self-inflicted outage plus a memory leak (each attempt holds state).

## Electron

Official maintainer guidance (electronjs.org performance tutorial, `SNAPSHOT`): profile, then fix the most resource-hungry thing; repeat. VS Code and Slack got fast exactly this way.

**Sweep list:**

- **Lazy `require`:** Node modules loaded at startup cost startup forever. Require at first use for heavy/rare paths; defer expensive setup with idle-time initialization.
- **Price modules before adopting:** `node --cpu-prof --heap-prof -e "require('mod')"` — the canonical example is a "simple" connectivity checker that parsed a 100k-line JSON port list at load. Server-oriented modules are often wrong for desktop.
- **Never block the main process:** UI jank and dead IPC come from main-process busy work. CPU-heavy work goes to utility processes / worker threads; keep main for orchestration.
- **Bundle renderer code** (bundler or esbuild) instead of hundreds of module loads at window open.
- **Window hygiene:** lazy-create `BrowserWindow`s, destroy (not just hide) windows whose content is expensive and rarely revisited, `process.getProcessMemoryInfo()` per process to find which side eats.
- **Tray/menu/global-shortcut listeners** registered once, removed on app quit; background throttling is default — don't defeat it with busy polling (`powerSaveBlocker` only while genuinely needed).
- **Startup:** `Menu.setApplicationMenu(null)` when no menu is needed; splash/deferred window show to cut time-to-visible; V8 compile cache for large renderer bundles.
- Security config (`contextIsolation`, sandbox) is bulletproof's lane — but note sandboxing also shrinks renderer memory; do not weaken it for speed.

## Tauri (v2)

**Sweep list:**

- **Release profile:** in `Cargo.toml` `[profile.release]` — `lto = true` (or `"thin"`), `codegen-units = 1`, `strip = true`; `panic = "abort"` if acceptable. `opt-level = "s"/"z"` trades speed for size — measure which you need.
- **IPC cost:** every `invoke` serializes (JSON by default) — for large binary payloads use Tauri 2's raw request/response bodies or channels rather than JSON arrays of bytes. Don't shuttle large blobs or big JSON back and forth per keystroke; chunk, delta, or move the work to the Rust side. Watch for per-frame IPC from frontend animation/monitoring loops.
- **State:** `tauri::State` with `Mutex` held across `.await` serializes everything behind it; scope locks tightly.
- **Frontend** follows the web section exactly — the webview is a browser; bundle size and long tasks hit the same.
- **Assets:** embed vs. fetch per asset class; large binaries should not ship inside the binary if they can be fetched/unpacked on demand.
- **Plugins:** lazy-init heavy plugins; each one is startup cost on the Rust and JS side both.
- **Measure:** `cargo bloat` / `cargo tree -d` for binary weight and duplicate deps; standard Rust profilers (`perf`, Instruments, `cargo-flamegraph`) for hot paths.

## Mobile

**Sweep list:** cold-start path (lazy screen registration, defer non-critical SDK init — analytics can wait), list virtualization (`FlatList`/`FlashList`/`RecyclerView`/`LazyColumn` — never render 1000 rows), image assets per density (not runtime-downscaled full images), main-thread discipline (decode/parse off the main thread), memory-warning handling that actually drops caches. Measure on a low-end Android device in a release build — debug builds and simulators lie.

**React Native:** since 0.82 (Oct 2025) the New Architecture is the only architecture; Hermes is the default engine; Hermes V1 was an experimental opt-in at that release (re-check status before recommending). Old-bridge libraries are a migration problem, not a perf knob. Avoid chatty JS↔native calls per frame; run animations on the UI thread (Reanimated worklets / native driver). React Compiler applies here too.

**Android:** add **Baseline Profiles** (Jetpack Macrobenchmark + Baseline Profile Gradle plugin) so startup and hot paths are AOT-compiled; measure cold start with Macrobenchmark `StartupTimingMetric` or `adb shell am start -W`. **iOS:** measure launch with Instruments App Launch template and Xcode Organizer launch metrics; keep work out of `application(_:didFinishLaunching…)` and static initializers.

**Measure/leak tools:** Android — Android Studio Profiler, `LeakCanary`, `dumpsys meminfo`; iOS — Instruments Allocations/Leaks, Xcode memory graph debugger.

## Native / compiled

- **Rust:** leaks are usually `Rc`/`Arc` cycles (switch one direction to `Weak`), `Box::leak`, unbounded channels, or tasks blocked forever holding state. Blocking calls inside async runtime threads stall the executor — use `spawn_blocking`. Measure: `cargo-flamegraph`, `heaptrack`, `pprof` crate. Children must be `wait()`ed — dropping a `Child` does not reap it (see `references/memory-and-processes.md`).
- **C/C++:** every `malloc`/`new`/`fopen` has an owner that frees/closes on all paths — RAII or scope guards, not discipline. Measure: valgrind memcheck/massif, AddressSanitizer/LeakSanitizer (`-fsanitize=address,leak`), `heaptrack`.
- **Go:** goroutine leaks — a goroutine blocked on a channel/ctx that never arrives holds everything it captured forever. `pprof` goroutine + heap profiles tell you both. Set `GOMEMLIMIT` in containers; tune `GOGC` only after measuring.
- **JVM:** bound the heap (`-Xmx`) to the container, watch for unbounded caches and listener registries; `jmap -histo`, async-profiler, JFR for allocation sites.
- **Games/hot loops:** frame budget is 16.6ms @60 (8.3ms @120) including everything. No per-frame allocation (object pools), no per-frame sync I/O, no GC spikes mid-frame; batch draws; time-slice background work.

## Python

Generators/streams instead of list-building for large data; vectorize hot loops (NumPy/pandas — or Polars for large frames) instead of Python-level iteration; never block the asyncio event loop with sync I/O or CPU work (offload to processes); `functools.lru_cache` is bounded — `cached_property` and hand-rolled dict caches are not. Measure: `tracemalloc` for allocation deltas, `memory_profiler` line-level, `py-spy` for live flamegraphs without stopping the process. Watch for reference cycles keeping big objects alive when `gc` is disabled or timing-dependent.

**Threads vs GIL:** Python 3.14's free-threaded build (`python3.14t`) is officially supported but optional, not the default (PEP 779). Single-threaded code runs roughly 5–10% slower on it, and importing a C extension that hasn't declared free-threading support re-enables the GIL for the whole process. Recommend it only for CPU-bound threaded work where the dependency stack supports it, and measure both builds. Otherwise: `multiprocessing`/`ProcessPoolExecutor` for CPU, asyncio for I/O.

## Data & queries (any stack)

**N+1 detection:** turn on query logging in dev and count queries per request (a list page issuing 1 + N similar queries is the signature). Tools: Django `nplusone`/django-debug-toolbar, Rails Bullet or `strict_loading`, SQLAlchemy `lazy="raise"`, Prisma/Drizzle query logging, Laravel `Model::preventLazyLoading()`, GraphQL → DataLoader. Fix with eager loading / one batched query; add a test asserting the query count.

`EXPLAIN (ANALYZE)` the slow ones; indexes on frequent filters/sorts — but every index taxes writes, so measure both sides. Batch writes; avoid N single-row inserts inside a transaction per row. Cursor/keyset pagination over offset for deep pages. Slow-query log threshold low enough to catch regressions in CI-like environments. Cache expensive reads with explicit invalidation, not hope.

## Payload & dead weight (all stacks)

`SNAPSHOT` (3 Oct 2026): **Knip** finds unused files, exports, dependencies, and devDependencies across JS/TS monorepo workspaces; `depcheck` is an older, narrower alternative (dependencies only). Bundle bytes: `size-limit` (fails CI over budget) plus a visualizer (see Web sweep list). CSS: PurgeCSS (or the framework's built-in pruning) against real markup — beware class names built dynamically, which purgers cannot see; guard with a safelist. Shipped-code audit: DevTools Coverage for what the browser actually ran.

**Sweep list:** `knip` in CI; duplicate dependencies (`pnpm why <pkg>`, `npm ls <pkg>`) — two versions of one library is double weight; "two of the same job" audit (two icon sets, two date libs, two CSS systems, a utility lib plus hand-rolled copies of its functions); polyfills for browsers no longer supported; debug/symbol payloads shipped in release (strip; source maps to a symbol server, not the bundle); largest-files audit (`du`, bundle analyzer) — the top ten files are usually the whole story; unused assets in repos (images, fonts nobody references).

## Styling consistency (payload view)

The rule: **one way to express one visual decision.** Hunt repeated rule blocks that differ by one value, spacing/color literals that duplicate existing design tokens, the same component styled three ways, utility classes wrapped around handwritten CSS doing the same job, dead rules for removed components. Each duplication is bytes today and divergence tomorrow. Kill the copies, keep the token. If resolving it requires a design *decision* (which of three styles is right), that call belongs to evidence-led-ui — coordinate rather than decide unilaterally.

---

**Provenance:** snapshot 3 October 2026 (all URLs accessed 3 Oct 2026). Sources: https://web.dev/articles/vitals (thresholds); https://web.dev/articles/find-slow-interactions-in-the-field and https://developer.chrome.com/docs/web-platform/long-animation-frames (attribution build, LoAF); https://developer.chrome.com/blog/final-soft-navigations-origin-trial (Chrome 147–149, CrUX use undecided); Speculation Rules support from secondary 2026 coverage (corewebvitals.io, uploadcare.com — Chromium default, Safari 26.2 flag; re-verify on caniuse); https://react.dev/blog/2025/10/07/react-compiler-1; https://nextjs.org/docs/app/api-reference/directives/use-cache; https://vite.dev/blog/announcing-vite8; https://github.com/nodejs/Release/blob/main/schedule.json (Node release dates); https://docs.python.org/3/whatsnew/3.14.html (PEP 779); React Native 0.82 release coverage (New Architecture only, Hermes V1 experimental). Carried from the 17 Aug 2026 snapshot, not re-verified: Electron official performance tutorial (module cost, lazy loading, main-process blocking, profiling guidance), Rust std `process::Child` docs (zombie reaping), Knip documentation and 2026 ecosystem coverage (dead-code standard claim — `SNAPSHOT`), Valgrind/LeakCanary/Instruments/pprof public docs for tool usage. Version-specific flags and thresholds decay fastest; re-verify before asserting.
