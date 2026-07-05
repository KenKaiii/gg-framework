// Bundle the ggcoder app-sidecar into a single self-contained ESM file shipped
// as a Tauri `bundle.resources` entry, plus the handful of native/optional
// packages it loads at runtime copied into a sibling node_modules/.
//
// Why external + copy (not a single SEA binary): ggcoder's runtime pulls in
// native `sharp` and lazily imports optional natives (playwright, transformers,
// unpdf, linkedom, ...). Those cannot be inlined by a bundler, so we mark them
// `external` and copy the real packages (with their dependency trees) next to
// the bundle. Each OS/arch bundle is built on its own CI runner, so the copied
// `sharp` platform binary is always correct for the target.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const sidecarEntry = join(repoRoot, "packages", "ggcoder", "dist", "app-sidecar.js");
const outDir = join(here, "..", "src-tauri", "sidecar");
const outFile = join(outDir, "app-sidecar.mjs");
const nodeModulesOut = join(outDir, "node_modules");

// Packages that must NOT be inlined: native addons + lazily-loaded optional
// heavy deps. They are copied verbatim with their dependency trees instead.
const EXTERNAL = [
  "sharp",
  "playwright",
  "@huggingface/transformers",
  "unpdf",
  "linkedom",
  "ogg-opus-decoder",
  "turndown",
  "turndown-plugin-gfm",
  "@mozilla/readability",
  // Default MCP server: spawned as a stdio child, never imported, so esbuild
  // won't bundle it. Copy it next to the sidecar so resolveStdioCommand can
  // resolve its bin and rewrite `npx -y @kenkaiiii/kencode-search` to a direct
  // `node dist/index.js` spawn. Without this the shipped app silently falls
  // back to raw npx, paying a ~90 MB `npm exec` wrapper per MCP connection.
  "@kenkaiiii/kencode-search",
];

// require resolver anchored at the ggcoder package, where these deps live.
const ggcoderRequire = createRequire(join(repoRoot, "packages", "ggcoder", "package.json"));

// Candidate node_modules roots to scan directly when `require.resolve` is
// blocked by a package's `exports` map (which often hides ./package.json).
const NM_ROOTS = [
  join(repoRoot, "packages", "ggcoder", "node_modules"),
  join(repoRoot, "node_modules", ".pnpm", "node_modules"),
  join(repoRoot, "node_modules"),
];

function isInsideRepo(dir) {
  const rel = relative(repoRoot, dir);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isPackageRoot(dir, name) {
  try {
    if (!isInsideRepo(dir)) return false;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return pkg.name === name;
  } catch {
    return false;
  }
}

/** Walk up from a file to the nearest real package root for `name`. */
function nearestPackageDir(start, name) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (isPackageRoot(dir, name)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Return the nearest ancestor directory named node_modules. */
function nearestNodeModulesDir(start) {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (basename(dir) === "node_modules") return dir;
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
  // 1) Direct package.json resolution (works when exports allows it). Validate
  //    the package name because some export maps expose nested package.json stubs.
  try {
    const direct = dirname(fromRequire.resolve(`${name}/package.json`));
    if (isPackageRoot(direct, name)) return direct;
  } catch {
    // ignore and fall through
  }
  // 2) Direct directory lookup in candidate node_modules. pnpm places a
  //    package's deps as siblings under the same .pnpm/<x>/node_modules dir,
  //    so the requiring package's parent dir is a key candidate. Do this before
  //    resolving the package entry: some packages (for example
  //    @modelcontextprotocol/sdk) expose subpath files that contain nested
  //    package.json stubs like {"type":"commonjs"}. Walking up from those entry
  //    files would copy only that subfolder and drop real dependencies.
  const candidates = [];
  if (fromDir) {
    candidates.push(join(fromDir, "node_modules")); // nested
    const nearestNodeModules = nearestNodeModulesDir(fromDir);
    if (nearestNodeModules) candidates.push(nearestNodeModules); // pnpm sibling deps
  }
  candidates.push(...NM_ROOTS);
  for (const nm of candidates) {
    const candidate = join(nm, ...segs);
    if (isPackageRoot(candidate, name)) return candidate;
  }
  // 3) Resolve the package entry, then walk up to its package.json.
  try {
    const entry = fromRequire.resolve(name);
    const root = nearestPackageDir(dirname(entry), name);
    if (root) return root;
  } catch {
    // ignore and fall through
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
  const root = packageRoot(name, fromRequire, fromDir);
  if (!root) {
    console.warn(`skip (not found): ${name}`);
    return;
  }
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

async function main() {
  if (!existsSync(sidecarEntry)) {
    throw new Error(`sidecar entry missing: ${sidecarEntry} (build @kenkaiiii/ggcoder first)`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  await build({
    entryPoints: [sidecarEntry],
    outfile: outFile,
    bundle: true,
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
  console.log(
    `bundled sidecar → ${outFile}\ncopied ${copied.size} external packages → ${nodeModulesOut}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
