#!/usr/bin/env node
// Maintainer tool: validate and render GG Motion's style library.
//
// For every look and piece in assets/motion/library/ it checks the metadata,
// rejects non-seek-safe or network-dependent code, lints it with the bundled
// HyperFrames, renders its preview image, and then rebuilds library.json and
// the per-kind contact sheets. Previews and the index are checked in.
//
// Usage: node scripts/build-motion-library.mjs [--only <id,id,...>] [--no-render] [--no-index]
//   --only       render just these entries (the index and sheets are still
//                rebuilt from every entry on disk)
//   --no-render  validate and reindex without rendering previews
//   --no-index   with --only: validate and render only those entries and
//                leave library.json and the sheets alone (safe to run several
//                builds in parallel while authoring)
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditSource, GSAP_PREFIX, KINDS, TOKENS } from "./motion-library-audit.mjs";

const MOTION = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "motion");
const LIBRARY = join(MOTION, "library");
const BIN = join(MOTION, "bin");
const HF = join(BIN, "hyperframes.mjs");

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? new Set((args[onlyIndex + 1] ?? "").split(",").filter(Boolean)) : null;
const render = !args.includes("--no-render");
const noIndex = args.includes("--no-index");
if (noIndex && !only) {
  process.stderr.write("--no-index needs --only <ids>\n");
  process.exit(2);
}
const problems = [];
const problem = (id, message) => problems.push(`${id}: ${message}`);

async function readMeta(dir, id, type) {
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  const need =
    type === "look"
      ? ["id", "name", "description", "tags", "fonts", "bestFor", "pieces", "previewAt"]
      : ["id", "name", "kind", "description", "tags", "fonts", "duration", "previewAt", "license"];
  for (const key of need) if (meta[key] === undefined) problem(id, `meta.json missing "${key}"`);
  if (meta.id !== id) problem(id, `meta.json id "${meta.id}" does not match its folder`);
  if (type === "piece" && !KINDS.includes(meta.kind)) problem(id, `unknown kind "${meta.kind}"`);
  for (const need of meta.requires ?? []) {
    if (need !== "three" && need !== "kit") {
      problem(id, `unknown requirement "${need}" (only "three" or "kit")`);
    }
  }
  if (type === "piece" && meta.license !== "original" && !meta.source?.url) {
    problem(id, "third-party piece needs source.url and source.author");
  }
  if (type === "piece" && meta.license !== "original" && meta.license !== "MIT") {
    problem(id, `license must be "original" or "MIT", got "${meta.license}"`);
  }
  // MIT requires its notice to travel with every copy of the code.
  if (type === "piece" && meta.license === "MIT") {
    const notice = await readFile(join(dir, "LICENSE"), "utf8").catch(() => "");
    if (!/MIT License/i.test(notice) || !/Copyright/i.test(notice)) {
      problem(id, "MIT piece needs the upstream LICENSE (with its copyright line) beside piece.html");
    }
  }
  return meta;
}

function hf(project, hfArgs) {
  return execFileSync(process.execPath, [HF, ...hfArgs], { cwd: project, encoding: "utf8" });
}

/** A throwaway project that renders one look sample or one piece in a look. */
async function stage(files, fonts, lookId, requires = []) {
  const project = await mkdtemp(join(tmpdir(), "gg-lib-"));
  await writeFile(join(project, "hyperframes.json"), '{ "name": "gg-library-preview" }\n');
  for (const [target, source] of files) {
    await mkdir(dirname(join(project, target)), { recursive: true });
    await cp(source, join(project, target));
  }
  if (lookId) {
    await mkdir(join(project, "assets", "looks"), { recursive: true });
    await cp(
      join(LIBRARY, "looks", lookId, "tokens.css"),
      join(project, "assets", "looks", `${lookId}.css`),
    );
  }
  execFileSync(process.execPath, [join(BIN, "fonts.mjs"), "add", project, ...fonts], {
    encoding: "utf8",
  });
  if (requires.includes("three")) {
    execFileSync(process.execPath, [join(BIN, "three.mjs"), "add", project], { encoding: "utf8" });
  }
  if (requires.includes("kit")) {
    await mkdir(join(project, "assets", "kit"), { recursive: true });
    await cp(join(LIBRARY, "kit", "moves.js"), join(project, "assets", "kit", "moves.js"));
  }
  return project;
}

async function preview(project, at, out, id) {
  // One browser session: lint, runtime console errors, and layout. It exits
  // non-zero on errors, so read its report either way. Contrast is judged in
  // the full look, not per transparent piece.
  const check = spawnSync(
    process.execPath,
    [HF, "check", "--json", "--no-contrast", "--samples", "12"],
    { cwd: project, encoding: "utf8" },
  );
  const report = JSON.parse(check.stdout.slice(check.stdout.indexOf("{")));
  for (const section of ["lint", "runtime", "layout"]) {
    const errors = (report[section]?.findings ?? []).filter((f) => f.severity === "error");
    for (const e of errors) problem(id, `hf check ${section}: ${JSON.stringify(e)}`);
  }
  hf(project, ["snapshot", "--at", String(at)]);
  const frames = (await readdir(join(project, "snapshots"))).filter((f) => f.endsWith(".png"));
  const frame = frames.sort()[0];
  if (!frame) return problem(id, "snapshot produced no frame");
  const sharp = createRequire(join(MOTION, "..", "..", "node_modules", "hyperframes", "package.json"))(
    "sharp",
  );
  await sharp(join(project, "snapshots", frame)).resize(640, 360).jpeg({ quality: 80 }).toFile(out);
}

const THREE_IMPORTMAP =
  '<script type="importmap">{ "imports": { "three": "./assets/vendor/three/build/three.module.min.js", "three/addons/": "./assets/vendor/three/addons/" } }</script>';

const KIT_SCRIPT = '<script src="assets/kit/moves.js"></script>';

/** Harness that mounts one piece full-frame, styled by a look's tokens. */
function harness(piece, lookId) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" />
<link rel="stylesheet" href="assets/fonts/fonts.css" />
<link rel="stylesheet" href="assets/looks/${lookId}.css" />
${(piece.requires ?? []).includes("three") ? THREE_IMPORTMAP : ""}
<script src="${GSAP_PREFIX}gsap.min.js"></script>
${(piece.requires ?? []).includes("kit") ? KIT_SCRIPT : ""}
<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden}
#root{position:relative;width:1920px;height:1080px;background:var(--field)}</style>
</head><body>
<div id="root" class="look-${lookId}" data-composition-id="main" data-start="0" data-duration="${piece.duration}" data-width="1920" data-height="1080">
<div id="${piece.id}-clip" data-composition-id="${piece.id}" data-composition-src="compositions/${piece.id}.html" data-start="0" data-duration="${piece.duration}" data-width="1920" data-height="1080" data-track-index="0"></div>
</div>
<script>const tl=gsap.timeline({paused:true});tl.to({},{duration:${piece.duration}});window.__timelines={main:tl};</script>
</body></html>
`;
}

// The move kit ships to every kit project: hold it to the same determinism rules.
for (const issue of auditSource(await readFile(join(LIBRARY, "kit", "moves.js"), "utf8"))) {
  problem("kit", issue);
}

const looks = [];
const pieces = [];
const lookIds = (await readdir(join(LIBRARY, "looks"))).filter((d) => !d.startsWith(".")).sort();
const pieceIds = (await readdir(join(LIBRARY, "pieces"))).filter((d) => !d.startsWith(".")).sort();

/** A token's color as [r, g, b, a] (0-255, alpha 0-1), from hex or rgb()/rgba(). */
function tokenColor(css, token) {
  const value = css.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1].trim() ?? "";
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).concat(1);
  const rgb = value.match(/^rgba?\(([^)]+)\)$/i)?.[1];
  if (!rgb) return undefined;
  const [r, g, b, a = "1"] = rgb.split(",").map((part) => part.trim());
  return [Number(r), Number(g), Number(b), Number(a)];
}
const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + (bg[i] ?? 0) * (1 - fg[3]));
function luminance(rgb) {
  const [r = 0, g = 0, b = 0] = rgb.map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** Read an entry, recording (not throwing) problems such as a half-written folder. */
async function tryRead(id, fn) {
  try {
    return await fn();
  } catch (error) {
    problem(id, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

for (const id of pieceIds) {
  const dir = join(LIBRARY, "pieces", id);
  const meta = await tryRead(id, () => readMeta(dir, id, "piece"));
  const source = await tryRead(id, () => readFile(join(dir, "piece.html"), "utf8"));
  if (!meta || source === undefined) continue;
  for (const issue of auditSource(source)) problem(id, issue);
  if (!source.includes(`data-composition-id="${id}"`)) problem(id, "root must use data-composition-id");
  if (!source.includes(`window.__timelines["${id}"]`)) problem(id, "timeline must register as its id");
  // HyperFrames drops the root element's id when it inlines a sub-composition.
  if (source.includes(`"${id}-root"`) && /getElementById\(\s*["'][^"']*-root["']/.test(source)) {
    problem(id, `do not look up "#${id}-root" (its id is dropped when mounted); use [data-composition-id="${id}"]`);
  }
  pieces.push(meta);
}
for (const id of lookIds) {
  const dir = join(LIBRARY, "looks", id);
  const meta = await tryRead(id, () => readMeta(dir, id, "look"));
  if (!meta) continue;
  for (const file of ["look.md", "tokens.css", "sample.html"]) {
    if (!(await stat(join(dir, file)).catch(() => null))) problem(id, `missing ${file}`);
  }
  const tokens = (await tryRead(id, () => readFile(join(dir, "tokens.css"), "utf8"))) ?? "";
  if (!tokens.includes(`.look-${id}`)) problem(id, `tokens.css must scope to .look-${id}`);
  // Any family named in tokens must be installed by the look, or HyperFrames
  // silently fetches it from Google Fonts at render time.
  const generic = new Set(["serif", "sans-serif", "monospace", "system-ui", "cursive"]);
  for (const family of tokens.match(/"([^"]+)"/g) ?? []) {
    const name = family.slice(1, -1);
    if (!generic.has(name) && !meta.fonts.includes(name)) {
      problem(id, `tokens.css names "${name}" but meta.fonts does not install it`);
    }
  }
  for (const token of TOKENS) {
    if (!tokens.includes(`${token}:`)) problem(id, `tokens.css missing ${token}`);
  }
  // Text must be readable on the field. --ink carries headlines and body
  // (WCAG AA 4.5:1; saturated duotone fields rarely reach AAA 7:1), --muted
  // carries small labels (4.5:1 too).
  const field = tokenColor(tokens, "--field");
  for (const [token, min] of [["--ink", 4.5], ["--muted", 4.5]]) {
    const fg = tokenColor(tokens, token);
    if (field && fg) {
      const ratio = contrast(over(fg, field), field);
      if (ratio < min) problem(id, `${token} is ${ratio.toFixed(2)}:1 on --field (needs ${min}:1)`);
    } else problem(id, `${token} and --field must be hex or rgba() so contrast can be checked`);
  }
  const sample = (await tryRead(id, () => readFile(join(dir, "sample.html"), "utf8"))) ?? "";
  for (const issue of auditSource(sample)) problem(id, issue);
  for (const piece of meta.pieces) {
    if (!pieceIds.includes(piece)) problem(id, `lists unknown piece "${piece}"`);
  }
  looks.push(meta);
}

if (render) {
  for (const look of looks) {
    if (only && !only.has(look.id)) continue;
    const dir = join(LIBRARY, "looks", look.id);
    const files = [["index.html", join(dir, "sample.html")]];
    for (const piece of look.samplePieces ?? []) {
      files.push([`compositions/${piece}.html`, join(LIBRARY, "pieces", piece, "piece.html")]);
    }
    const requires = (look.samplePieces ?? []).flatMap(
      (id) => pieces.find((p) => p.id === id)?.requires ?? [],
    );
    const project = await stage(files, look.fonts, look.id, requires);
    try {
      await preview(project, look.previewAt, join(dir, "preview.jpg"), look.id);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
    process.stdout.write(`rendered look ${look.id}\n`);
  }
  for (const piece of pieces) {
    if (only && !only.has(piece.id)) continue;
    const dir = join(LIBRARY, "pieces", piece.id);
    const lookId = piece.previewLook ?? looks.find((l) => l.pieces.includes(piece.id))?.id;
    if (!lookId) {
      problem(piece.id, "no look to preview it in (set previewLook or list it in a look)");
      continue;
    }
    const project = await stage(
      [[`compositions/${piece.id}.html`, join(dir, "piece.html")]],
      [...new Set([...piece.fonts, ...(looks.find((l) => l.id === lookId)?.fonts ?? [])])],
      lookId,
      piece.requires ?? [],
    );
    try {
      await writeFile(join(project, "index.html"), harness(piece, lookId));
      await preview(project, piece.previewAt, join(dir, "preview.jpg"), piece.id);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
    process.stdout.write(`rendered piece ${piece.id}\n`);
  }
}

if (noIndex) {
  const mine = problems.filter((p) => only.has(p.slice(0, p.indexOf(":"))));
  if (mine.length > 0) {
    process.stderr.write(`${mine.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`entries ok: ${[...only].join(", ")} (index not rebuilt)\n`);
  process.exit(0);
}

for (const look of looks) {
  if (!(await stat(join(LIBRARY, "looks", look.id, "preview.jpg")).catch(() => null))) {
    problem(look.id, "missing preview.jpg");
  }
}
for (const piece of pieces) {
  if (!(await stat(join(LIBRARY, "pieces", piece.id, "preview.jpg")).catch(() => null))) {
    problem(piece.id, "missing preview.jpg");
  }
}

// Contact sheets: one image per kind (and one for looks) so the agent can
// compare many options in a single image read.
const sheetDir = join(LIBRARY, "sheets");
await rm(sheetDir, { recursive: true, force: true });
await mkdir(sheetDir, { recursive: true });
const groups = [["looks", looks.map((l) => join(LIBRARY, "looks", l.id, "preview.jpg"))]];
for (const kind of KINDS) {
  const files = pieces
    .filter((p) => p.kind === kind)
    .map((p) => join(LIBRARY, "pieces", p.id, "preview.jpg"));
  if (files.length > 0) groups.push([kind, files]);
}
for (const [name, files] of groups) {
  const staging = await mkdtemp(join(tmpdir(), "gg-sheet-"));
  try {
    let staged = 0;
    for (const file of files) {
      if (await stat(file).catch(() => null)) {
        await cp(file, join(staging, `${basename(dirname(file))}.jpg`));
        staged += 1;
      }
    }
    // Missing previews are already reported above; skip an empty sheet.
    if (staged === 0) continue;
    execFileSync(
      process.execPath,
      [join(BIN, "contact-sheet.mjs"), staging, join(sheetDir, `${name}.jpg`), "--cols", "4"],
      { encoding: "utf8" },
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const strip = ({ previewAt: _p, ...rest }) => rest;
await writeFile(
  join(LIBRARY, "library.json"),
  `${JSON.stringify(
    {
      kinds: KINDS.filter((k) => pieces.some((p) => p.kind === k)),
      looks: looks.map(strip),
      pieces: pieces.map(strip),
    },
    null,
    2,
  )}\n`,
);

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`library ok: ${looks.length} looks, ${pieces.length} pieces\n`);
