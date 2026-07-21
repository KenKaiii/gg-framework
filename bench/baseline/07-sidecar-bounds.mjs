// 07-sidecar-bounds — baseline for item #8 (unbounded sidecar paths).
//   (a) searchProjectFiles glob materialization: full '**/*' glob+stats+sort vs sliced-kept.
//   (b) daemonReadBody/readBody HTTP chunk-concat buffering: memory vs body size, no byte cap.
//   (c) fs.watch leak in createProgressManager (code inspection).
// Run from repo root:  node --expose-gc bench/baseline/07-sidecar-bounds.mjs
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  writeWideTree,
  makeTmpDir,
  cleanupDir,
  writeResult,
  fmt,
  table,
  REPO_ROOT,
} from "./lib.mjs";

if (typeof globalThis.gc !== "function") {
  console.error("FATAL: run with node --expose-gc");
  process.exit(1);
}

// Same fast-glob + ignore the sidecar uses (packages/ggcoder deps, fast-glob 3.3.3).
const fg = (
  await import(pathToFileURL(path.join(REPO_ROOT, "packages/ggcoder/node_modules/fast-glob/out/index.js")).href)
).default;
const ignore = (
  await import(pathToFileURL(path.join(REPO_ROOT, "packages/ggcoder/node_modules/ignore/index.js")).href)
).default;

const FILE_SEARCH_LIMIT = 20; // app-sidecar.ts:449
const MB = (b) => b / (1024 * 1024);
const rss = () => process.memoryUsage().rss;

// ── (a) Glob materialization ─────────────────────────────────
// Reproduces searchProjectFiles (app-sidecar.ts:479-524): fast-glob '**/*'
// with stats:true, gitignore filter, full mtime sort, THEN slice(0, 20).
async function benchGlob() {
  const dir = await makeTmpDir("glob");
  const fileCount = await writeWideTree(dir, { dirs: 100, filesPerDir: 200 }); // 20k files
  const ig = ignore.default ? ignore.default() : ignore(); // no .gitignore in tmp dir
  // Inner scope: the 20k-entry arrays die when this returns, so the post-gc
  // reading below measures what the sliced-kept variant actually retains.
  async function runFullPattern() {
    const t0 = performance.now();
    const entries = await fg("**/*", {
      cwd: dir,
      dot: false,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/.gg/**"],
      suppressErrors: true,
      followSymbolicLinks: false,
      stats: true,
    });
    const files = entries.filter((e) => !ig.ignores(e.path));
    const tGlob = performance.now();
    const rssAfterGlob = rss(); // no gc — approximates peak retained+garbage

    // Empty-query path: full sort by mtime desc, then slice.
    const sorted = files.sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0));
    const tSort = performance.now();
    const rssAfterSort = rss();

    const kept = sorted.slice(0, FILE_SEARCH_LIMIT).map((e) => ({ path: e.path, name: path.posix.basename(e.path) }));
    return { kept, t0, tGlob, tSort, rssAfterGlob, rssAfterSort };
  }

  try {
    global.gc();
    const rss0 = rss();
    const heap0 = process.memoryUsage().heapUsed;
    const r = await runFullPattern();
    const fullRetainedMB = MB(r.rssAfterSort - rss0);
    const keptLen = r.kept.length;

    // Variant "sliced kept": big arrays out of scope now; keep only the 20 hits.
    // NB: RSS is a high-water mark (freed heap pages aren't returned to the OS),
    // so retained-after-gc is measured with heapUsed, peak with RSS. The 20k
    // glob entries survive a single full gc (promoted to old-gen during the
    // walk), so settle a tick and gc twice — verified: 19.2MB after 1 gc,
    // 0.3MB after settle + 2 gc.
    await new Promise((r) => setTimeout(r, 100));
    global.gc();
    global.gc();
    const heapSliced = process.memoryUsage().heapUsed;

    return {
      files: fileCount,
      globMs: fmt(r.tGlob - r.t0, 1),
      sortMs: fmt(r.tSort - r.tGlob, 1),
      fullRetainedMB: fmt(fullRetainedMB, 1),
      peakDeltaMB: fmt(MB(r.rssAfterSort - rss0), 1),
      slicedKeptDeltaMB: fmt(MB(Math.max(0, heapSliced - heap0)), 1),
      slicedKeptNote: "heapUsed delta after gc (RSS is a high-water mark and does not shrink)",
      mbPer1kFiles: fmt((fullRetainedMB / fileCount) * 1000, 2),
      keptEntries: keptLen,
    };
  } finally {
    await cleanupDir(dir);
  }
}

// ── (b) HTTP body buffering ──────────────────────────────────
// Reproduces daemonReadBody (app-sidecar.ts:703-710) / readBody (:2430-2437):
// unbounded chunk-array concat with no byte cap.
function readBodyLikeSidecar(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function benchHttpBody() {
  let handlerRssAfter = 0;
  const server = http.createServer((req, res) => {
    const t0 = performance.now();
    readBodyLikeSidecar(req).then((body) => {
      // Measure INSIDE the handler: Buffer.concat copy + utf-8 string are live.
      handlerRssAfter = process.memoryUsage().rss;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bytes: body.length, ms: performance.now() - t0 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const rows = [];
  try {
    for (const sizeMB of [1, 10, 50, 100]) {
      const body = Buffer.alloc(sizeMB * 1024 * 1024, "x");
      global.gc();
      const rss0 = rss();
      const t0 = performance.now();
      const resp = await fetch(`http://127.0.0.1:${port}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const json = await resp.json();
      const ms = performance.now() - t0;
      const deltaMB = MB(handlerRssAfter - rss0);
      rows.push({
        sizeMB,
        ms: fmt(ms, 1),
        serverDeltaMB: fmt(deltaMB, 1),
        deltaPerBodyMB: fmt(deltaMB / sizeMB, 2),
        echoedBytes: json.bytes,
      });
    }
  } finally {
    server.close();
  }
  const ratios = rows.map((r) => Number(r.deltaPerBodyMB));
  const linear = Math.max(...ratios) / Math.min(...ratios) < 2.5; // roughly constant per-MB cost
  return {
    rows,
    linearWithBodySize: linear,
    byteCapPresent: false, // no length guard anywhere in daemonReadBody/readBody
    note: "delta measured inside handler after Buffer.concat+toString; includes concat copy + utf-8 string; ~2x body size, unbounded",
  };
}

// ── main ─────────────────────────────────────────────────────
console.log("== 07-sidecar-bounds ==\n(a) glob materialization (20k files, fast-glob 3.3.3, stats+sort+slice)");
const glob = await benchGlob();
table(
  [
    ["files", glob.files],
    ["glob+stats ms", glob.globMs],
    ["sort ms", glob.sortMs],
    ["full retained ΔMB", glob.fullRetainedMB],
    ["sliced-kept ΔMB", glob.slicedKeptDeltaMB],
    ["MB per 1k files", glob.mbPer1kFiles],
  ],
  ["metric", "value"],
);

console.log("\n(b) HTTP body buffering (daemonReadBody chunk-concat, no byte cap)");
const httpBody = await benchHttpBody();
table(
  httpBody.rows.map((r) => [r.sizeMB + " MB", r.ms + " ms", r.serverDeltaMB + " MB", r.deltaPerBodyMB + "x"]),
  ["body", "time", "server RSS Δ", "Δ per body MB"],
);
console.log(`linear growth: ${httpBody.linearWithBodySize} — byte cap present: ${httpBody.byteCapPresent}`);

// (c) fs.watch leak — code inspection of createProgressManager (app-sidecar.ts:1145-1242).
const fsWatchLeak = {
  status: "OPEN/LEAKED",
  refs: {
    watchCreated: "app-sidecar.ts:1215 — const watcher = fsWatch(agentDir, …)",
    unrefOnly: "app-sidecar.ts:1226 — watcher.unref() (keeps process exitable; handle stays open)",
    debounce: "app-sidecar.ts:1213,1217-1218 — watchDebounce cleared only on re-arm; no teardown clears it",
    noClose: "grep: zero matches for `watcher.close` in app-sidecar.ts",
    noDispose: "app-sidecar.ts:~1241 — createProgressManager returns { snapshot, awardRun }; no close/dispose",
  },
  verdict:
    "The fs.watch handle is never closed and the debounce timer is never cleared on shutdown. " +
    "unref() only stops the watcher from pinning the event loop; the FD stays open for the " +
    "process lifetime. One manager per daemon today, but any re-creation (or per-session use) " +
    "leaks a watcher + pending 150ms debounce timer each time.",
};
console.log(`\n(c) fs.watch in createProgressManager: ${fsWatchLeak.status}`);
for (const [k, v] of Object.entries(fsWatchLeak.refs)) console.log(`    ${k}: ${v}`);

writeResult("07-sidecar-bounds", { glob, httpBody, fsWatchLeak });
