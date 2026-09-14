// Bundle the ggcoder app-sidecar into a single self-contained ESM file shipped
// as a Tauri `bundle.resources` entry, plus the handful of native/optional
// packages it loads at runtime copied into a sibling node_modules/.
//
// Why external + copy (not a single SEA binary): ggcoder's runtime pulls in
// native `sharp` and lazily imports optional natives (playwright, transformers,
// unpdf, ...). Those cannot be inlined by a bundler, so we mark them `external`
// and copy the real packages (with their dependency trees) next to the bundle.
// Pure-JS linkedom is bundled to avoid flattening incompatible htmlparser2/entities
// versions into that external node_modules tree. Each OS/arch bundle is built on
// its own runner, so copied native binaries match the target.
import { build } from "esbuild";
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const sidecarEntry = join(repoRoot, "packages", "ggcoder", "dist", "app-sidecar.js");
const outDir = join(here, "..", "src-tauri", "sidecar");
const outFile = join(outDir, "app-sidecar.mjs");
const nodeModulesOut = join(outDir, "node_modules");
const bundledSkillsSource = join(repoRoot, "packages", "ggcoder", "assets", "skills");
const bundledSkillsOut = join(outDir, "skills");

// Packages that must NOT be inlined: native addons, lazily-loaded optional
// heavy deps, and child-process entry points that esbuild cannot discover.
const EXTERNAL = [
  "sharp",
  "playwright",
  "@huggingface/transformers",
  "unpdf",
  "ogg-opus-decoder",
  "turndown",
  "turndown-plugin-gfm",
  "@mozilla/readability",
  // The Codex transport loads this package's zstd.wasm by path at runtime.
  // Keep the package external so the WASM asset survives the sidecar bundle.
  "@bokuweb/zstd-wasm",
  // LSP servers run as child processes from their real package entry points.
  // The server resolver also needs a physical tsserver.js path. Neither package
  // is imported by the sidecar, so esbuild would otherwise omit both and every
  // installed desktop build would silently lose TS/JS inline diagnostics.
  "typescript-language-server",
  "typescript",
  // source_path spawns opensrc's CLI by physical path; it is never imported.
  "opensrc",
  // Bash launches SRT's physical CLI as a child process for per-session OS
  // sandboxing; keep its platform binaries and CLI files on disk.
  "@anthropic-ai/sandbox-runtime",
];

// require resolver anchored at the ggcoder package, where these deps live.
const ggcoderRequire = createRequire(join(repoRoot, "packages", "ggcoder", "package.json"));

// Candidate node_modules roots to scan directly when `require.resolve` is
// blocked by a package's `exports` map (which often hides ./package.json).
const NM_ROOTS = [
  join(repoRoot, "packages", "ggcoder", "node_modules"),
  join(repoRoot, "packages", "gg-ai", "node_modules"),
  join(repoRoot, "node_modules"),
];

/** Nearest ancestor directory literally named `node_modules`, or null. */
function enclosingNodeModules(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    if (parent.endsWith(`${sep}node_modules`)) return parent;
    dir = parent;
  }
  return null;
}

/** Walk up from a file to the nearest dir containing package.json. */
function nearestPackageDir(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve a package's root dir (the folder holding its package.json), searching
 * from the requiring package's directory. Robust to `exports` maps that hide
 * ./package.json and to pnpm's sibling layout
 * (.pnpm/<parent>/node_modules/<dep>).
 */
function packageRoot(name, fromRequire, fromDir) {
  const segs = name.split("/");
  // A resolved dir only counts as the package root when its package.json is the
  // REAL manifest (name matches). Some packages' `exports` maps remap
  // `<pkg>/package.json` to a nested stub — e.g. @modelcontextprotocol/sdk
  // resolves it to `dist/cjs/package.json` ({"type":"commonjs"}). Copying that
  // dir shipped a package with no dependencies field, so its dep tree
  // (zod-to-json-schema, …) was never copied and a bundled stdio MCP server
  // crashed at require time in the installed app.
  const isRealRoot = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === name;
    } catch {
      return false;
    }
  };
  // 1) Direct package.json resolution (works when exports allows it).
  try {
    const dir = dirname(fromRequire.resolve(`${name}/package.json`));
    if (isRealRoot(dir)) return dir;
  } catch {
    // ignore and fall through
  }
  // 2) Resolve the package entry, then walk up to the real package root (the
  //    nearest package.json can be a nested build stub — keep walking).
  try {
    const entry = fromRequire.resolve(name);
    let dir = nearestPackageDir(dirname(entry));
    while (dir) {
      if (isRealRoot(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = nearestPackageDir(parent);
    }
  } catch {
    // ignore and fall through
  }
  // 3) Direct directory lookup in candidate node_modules. pnpm places a
  //    package's deps as siblings under the same .pnpm/<x>/node_modules dir,
  //    so the requiring package's enclosing node_modules is a key candidate.
  const candidates = [];
  if (fromDir) {
    candidates.push(join(fromDir, "node_modules")); // nested
    // The pnpm sibling root is the ENCLOSING `node_modules` dir, which is two
    // levels up for a scoped package (.../node_modules/@scope/name) and one for
    // an unscoped one. Using dirname() alone silently missed every scoped
    // dependency of a scoped package — e.g. an MCP server's SDK, which then
    // shipped without its dep tree and crashed the spawned MCP server.
    const siblingRoot = enclosingNodeModules(fromDir);
    if (siblingRoot) candidates.push(siblingRoot);
  }
  candidates.push(...NM_ROOTS);
  for (const nm of candidates) {
    const candidate = join(nm, ...segs);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

/**
 * Copy a package and its (optional) dependency tree into the flat output
 * node_modules, dereferencing pnpm symlinks. First version of a name wins
 * (npm-style hoist); the smoke test validates the result loads.
 */
function copyPackage(name, fromRequire, fromDir, copied) {
  if (copied.has(name)) return;
  const linkedRoot = packageRoot(name, fromRequire, fromDir);
  if (!linkedRoot) {
    console.warn(`skip (not found): ${name}`);
    return;
  }
  // Resolve pnpm symlinks to the real .pnpm dir. Anchoring the child resolver
  // at the SYMLINK path can't see the package's own deps (pnpm places them as
  // siblings of the REAL location), which silently skipped every transitive
  // dep of a package found via the symlink — a bundled MCP server once
  // shipped without the MCP SDK's dependency tree and crashed on spawn.
  const root = realpathSync(linkedRoot);
  copied.add(name);
  const dest = join(nodeModulesOut, ...name.split("/"));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(root, dest, { recursive: true, dereference: true });

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.optionalDependencies || {}),
  };
  const childRequire = createRequire(join(root, "package.json"));
  for (const dep of Object.keys(deps)) {
    copyPackage(dep, childRequire, root, copied);
  }
}

/**
 * Native packages can publish binaries for every supported OS/architecture in
 * one npm tarball. Keep only this build runner's payload: shipping dormant Intel
 * Mach-O files makes an arm64 app look Intel-based to macOS inventory scanners
 * and adds roughly 180 MB of unused files before compression.
 */
function pruneForeignNativePayloads() {
  const runtimes = join(nodeModulesOut, "onnxruntime-node", "bin", "napi-v3");
  if (!existsSync(runtimes)) return;

  const selected = join(runtimes, process.platform, process.arch);
  if (!existsSync(selected)) {
    throw new Error(
      `onnxruntime-node has no native payload for ${process.platform}/${process.arch}`,
    );
  }

  const keep = join(outDir, `.gg-onnxruntime-${process.pid}`);
  cpSync(selected, keep, { recursive: true });
  rmSync(runtimes, { recursive: true, force: true });
  mkdirSync(join(runtimes, process.platform), { recursive: true });
  cpSync(keep, selected, { recursive: true });
  rmSync(keep, { recursive: true, force: true });
  console.log(`pruned onnxruntime-node payloads to ${process.platform}/${process.arch}`);
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

/** Recursive non-symlink walk; visit(absPath, dirent) gets files and dirs. */
function walk(root, visit) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      visit(p, entry);
      if (entry.isDirectory()) stack.push(p);
    }
  }
}

/** Delete files matched by `dead(fileAbsPath)`; returns bytes freed. */
function pruneFiles(dead) {
  let freed = 0;
  walk(nodeModulesOut, (p, entry) => {
    if (entry.isFile() && dead(p)) {
      freed += statSync(p).size;
      rmSync(p);
    }
  });
  return freed;
}

/**
 * Source maps are dev-tooling payload: nothing in the packaged app loads them,
 * and they were ~52 MB across the copied dependency tree.
 */
function stripSourceMaps() {
  let count = 0;
  walk(nodeModulesOut, (p, entry) => {
    if (entry.isFile() && p.endsWith(".map")) count++;
  });
  const freed = pruneFiles((p) => p.endsWith(".map"));
  console.log(`stripped ${count} source maps (${mb(freed)})`);
}

/**
 * `onnxruntime-web` is statically imported by @huggingface/transformers but in
 * Node the exports map resolves only `dist/ort.node.min.{js,mjs}` — thin
 * wrappers around onnxruntime-node. The browser wasm binaries and webgl/webgpu
 * bundle variants (~85 MB) can never execute in a Node sidecar. Fail open: if
 * the node entries are missing (future version renamed them), keep everything
 * rather than shipping a package that cannot load.
 */
function pruneBrowserOnnxPayloads() {
  const KEEP = [
    "package.json",
    "types.d.ts",
    join("dist", "ort.node.min.js"),
    join("dist", "ort.node.min.mjs"),
  ];
  const roots = [];
  walk(nodeModulesOut, (p, entry) => {
    if (
      entry.isDirectory() &&
      entry.name === "onnxruntime-web" &&
      existsSync(join(p, "package.json"))
    ) {
      roots.push(p);
    }
  });
  for (const root of roots) {
    if (!KEEP.every((rel) => existsSync(join(root, rel)))) {
      console.warn(`skip onnxruntime-web prune (node entry missing): ${root}`);
      continue;
    }
    let freed = 0;
    walk(root, (p, entry) => {
      if (!entry.isFile()) return;
      if (KEEP.includes(relative(root, p))) return;
      freed += statSync(p).size;
      rmSync(p);
    });
    console.log(`pruned onnxruntime-web browser payloads (${mb(freed)})`);
  }
}

async function main() {
  if (!existsSync(sidecarEntry)) {
    throw new Error(`sidecar entry missing: ${sidecarEntry} (build @kenkaiiii/ggcoder first)`);
  }
  if (!existsSync(bundledSkillsSource)) {
    throw new Error(`bundled skills missing: ${bundledSkillsSource}`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(bundledSkillsSource, bundledSkillsOut, { recursive: true });

  await build({
    entryPoints: [sidecarEntry],
    outfile: outFile,
    bundle: true,
    // SDK updates add generated code. Trim formatting, not identifiers or syntax,
    // so the shipped bundle stays within its size budget without changing names.
    minifyWhitespace: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: EXTERNAL,
    // ESM bundles that reference `require`/__dirname need a banner shim so the
    // few CJS-interop call sites in dependencies keep working under Node ESM.
    banner: {
      js: [
        "import { createRequire as __ggCreateRequire } from 'node:module';",
        "import { fileURLToPath as __ggFileURLToPath } from 'node:url';",
        "import { dirname as __ggDirname } from 'node:path';",
        "const require = __ggCreateRequire(import.meta.url);",
        "const __filename = __ggFileURLToPath(import.meta.url);",
        "const __dirname = __ggDirname(__filename);",
      ].join("\n"),
    },
    logLevel: "info",
  });

  const copied = new Set();
  const ggcoderRoot = join(repoRoot, "packages", "ggcoder");
  for (const name of EXTERNAL) {
    copyPackage(name, ggcoderRequire, ggcoderRoot, copied);
  }
  pruneForeignNativePayloads();
  pruneBrowserOnnxPayloads();
  stripSourceMaps();
  console.log(
    `bundled sidecar → ${outFile}\ncopied ${copied.size} external packages → ${nodeModulesOut}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
