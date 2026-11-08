#!/usr/bin/env node
// GG Motion style library: curated, render-verified looks (art directions)
// and pieces (seek-safe building blocks), each with a preview image.
//
// Usage:
//   node library.mjs list [looks|pieces] [--kind <kind>]
//   node library.mjs search <words...>
//   node library.mjs show <id>
//   node library.mjs look <project-dir> <look-id>
//   node library.mjs add <project-dir> <piece-id> [<piece-id> ...] [--force]
//   node library.mjs kit <project-dir>
//
// `look` writes <project>/assets/looks/<id>.css (design tokens as CSS
// variables) and installs the look's fonts. `add` copies pieces into
// <project>/compositions/<id>.html, installs their fonts, and records
// third-party credits in CREDITS.md. `kit` installs the move kit
// (library/kit/moves.js) as <project>/assets/kit/moves.js; `add` does the
// same for pieces that require it. Every command prints one JSON line.
import { execFileSync } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = dirname(fileURLToPath(import.meta.url));
const LIBRARY = join(BIN, "..", "library");

function done(result, code = 0) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(code);
}
const fail = (error) => done({ ok: false, error }, 1);

/** @returns {Promise<{looks: any[], pieces: any[], kinds: string[]}>} */
async function index() {
  return JSON.parse(await readFile(join(LIBRARY, "library.json"), "utf8"));
}

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function projectDir(arg) {
  if (!arg) fail("Missing project folder");
  const dir = resolve(arg);
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) fail(`Project folder not found: ${dir}`);
  return dir;
}

/** Returns the installed families and fonts.mjs's page-ready <style> block. */
function installFonts(project, families) {
  if (families.length === 0) return { installed: [], head: [] };
  const out = execFileSync(
    process.execPath,
    [join(BIN, "fonts.mjs"), "add", project, ...families],
    {
      encoding: "utf8",
    },
  );
  const result = JSON.parse(out);
  if (!result.ok) fail(`Font install failed: ${result.error}`);
  // Inline, not a linked fonts.css: `hf check` only sees @font-face written in the page.
  return { installed: result.installed, head: [result.head] };
}

const KIT_HEAD = '<script src="assets/kit/moves.js"></script>';

/** Copies the move kit into the project; returns the <script> for the root head. */
async function installKit(project) {
  await mkdir(join(project, "assets", "kit"), { recursive: true });
  await copyFile(join(LIBRARY, "kit", "moves.js"), join(project, "assets", "kit", "moves.js"));
  return KIT_HEAD;
}

const summary = (entry, type) => ({
  id: entry.id,
  type,
  name: entry.name,
  ...(type === "piece" ? { kind: entry.kind, duration: entry.duration } : {}),
  description: entry.description,
  tags: entry.tags,
  preview: join(LIBRARY, type === "look" ? "looks" : "pieces", entry.id, "preview.jpg"),
});

const args = process.argv.slice(2);
const [command, ...rest] = args;
const lib = await index().catch(() => fail(`Style library missing at ${LIBRARY}`));

if (command === "list") {
  const which = rest[0] === "looks" || rest[0] === "pieces" ? rest[0] : undefined;
  const kindIndex = rest.indexOf("--kind");
  const kind = kindIndex >= 0 ? rest[kindIndex + 1] : undefined;
  if (kind && !lib.kinds.includes(kind))
    fail(`Unknown kind "${kind}". Kinds: ${lib.kinds.join(", ")}`);
  const looks = which === "pieces" || kind ? [] : lib.looks.map((l) => summary(l, "look"));
  const pieces =
    which === "looks"
      ? []
      : lib.pieces.filter((p) => !kind || p.kind === kind).map((p) => summary(p, "piece"));
  // Contact sheets show many previews in one image read.
  const sheets = {};
  if (looks.length > 0) sheets.looks = join(LIBRARY, "sheets", "looks.jpg");
  for (const k of new Set(pieces.map((p) => p.kind)))
    sheets[k] = join(LIBRARY, "sheets", `${k}.jpg`);
  done({ ok: true, kinds: lib.kinds, sheets, looks, pieces });
}

if (command === "search") {
  const words = rest.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) fail("usage: library.mjs search <words...>");
  const score = (entry) => {
    const hay = [entry.id, entry.name, entry.kind ?? "", entry.description, ...(entry.tags ?? [])]
      .join(" ")
      .toLowerCase();
    return words.reduce((sum, w) => sum + (hay.includes(w) ? 1 : 0), 0);
  };
  const results = [
    ...lib.looks.map((l) => ({ ...summary(l, "look"), score: score(l) })),
    ...lib.pieces.map((p) => ({ ...summary(p, "piece"), score: score(p) })),
  ]
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 15);
  done({ ok: true, results });
}

if (command === "show") {
  const id = rest[0];
  const look = lib.looks.find((l) => l.id === id);
  const piece = lib.pieces.find((p) => p.id === id);
  if (!look && !piece) fail(`No look or piece named "${id}"`);
  const dir = join(LIBRARY, look ? "looks" : "pieces", id ?? "");
  done({
    ok: true,
    type: look ? "look" : "piece",
    ...(look ?? piece),
    preview: join(dir, "preview.jpg"),
    files: look
      ? {
          spec: join(dir, "look.md"),
          tokens: join(dir, "tokens.css"),
          sample: join(dir, "sample.html"),
        }
      : { source: join(dir, "piece.html") },
  });
}

if (command === "look") {
  const project = await projectDir(rest[0]);
  const look = lib.looks.find((l) => l.id === rest[1]);
  if (!look) fail(`Unknown look "${rest[1]}". Looks: ${lib.looks.map((l) => l.id).join(", ")}`);
  await mkdir(join(project, "assets", "looks"), { recursive: true });
  const css = join(project, "assets", "looks", `${look.id}.css`);
  await copyFile(join(LIBRARY, "looks", look.id, "tokens.css"), css);
  const fonts = installFonts(project, look.fonts);
  done({
    ok: true,
    look: look.id,
    tokens: css,
    fonts: fonts.installed,
    head: [...fonts.head, `<link rel="stylesheet" href="assets/looks/${look.id}.css" />`],
    use: "Paste head into the composition <head>, replacing any earlier fonts block.",
    root: `add class="look-${look.id}" to the root composition element`,
    spec: join(LIBRARY, "looks", look.id, "look.md"),
  });
}

if (command === "kit") {
  const project = await projectDir(rest[0]);
  const kit = await installKit(project);
  done({
    ok: true,
    installed: join(project, "assets", "kit", "moves.js"),
    kit,
    use: "Put kit in the root index.html <head> after GSAP; scripts then use window.GGMotionKit.",
    reference: join(LIBRARY, "README.md"),
  });
}

if (command === "add") {
  const force = rest.includes("--force");
  const [projectArg, ...ids] = rest.filter((a) => a !== "--force");
  const project = await projectDir(projectArg);
  if (ids.length === 0) fail("usage: library.mjs add <project-dir> <piece-id> [...] [--force]");
  const pieces = ids.map((id) => {
    const piece = lib.pieces.find((p) => p.id === id);
    if (!piece) fail(`Unknown piece "${id}". Try: library.mjs search <words>`);
    return piece;
  });
  await mkdir(join(project, "compositions"), { recursive: true });
  const added = [];
  const kept = [];
  for (const piece of pieces) {
    const target = join(project, "compositions", `${piece.id}.html`);
    // Never clobber a piece the agent has already restyled for this video.
    if (!force && (await exists(target))) {
      kept.push(piece.id);
      continue;
    }
    await copyFile(join(LIBRARY, "pieces", piece.id, "piece.html"), target);
    added.push(piece.id);
    // MIT requires the upstream notice to travel with the code.
    if (piece.license === "MIT") {
      await mkdir(join(project, "compositions", "licenses"), { recursive: true });
      await copyFile(
        join(LIBRARY, "pieces", piece.id, "LICENSE"),
        join(project, "compositions", "licenses", `${piece.id}.txt`),
      );
    }
    if (piece.source) {
      await appendFile(
        join(project, "CREDITS.md"),
        `- ${piece.name}: adapted from ${piece.source.url} by ${piece.source.author} (${piece.license})\n`,
      );
    }
  }
  const fonts = installFonts(project, [...new Set(pieces.flatMap((p) => p.fonts))]);
  // 3D pieces import the bundled Three.js through an importmap in index.html.
  let importmap;
  if (pieces.some((p) => (p.requires ?? []).includes("three"))) {
    const three = JSON.parse(
      execFileSync(process.execPath, [join(BIN, "three.mjs"), "add", project], {
        encoding: "utf8",
      }),
    );
    if (!three.ok) fail(`Three.js install failed: ${three.error}`);
    importmap = three.importmap;
  }
  // Kit pieces call window.GGMotionKit, loaded once by the root page.
  const kit = pieces.some((p) => (p.requires ?? []).includes("kit"))
    ? await installKit(project)
    : undefined;
  done({
    ok: true,
    added,
    kept,
    fonts: fonts.installed,
    ...(importmap
      ? { importmap, note: "put importmap in index.html <head> before any module script" }
      : {}),
    ...(kit ? { kit, kitNote: "put kit in index.html <head> after GSAP" } : {}),
    mount: pieces.map(
      (p) =>
        `<div id="${p.id}-clip" data-composition-id="${p.id}" data-composition-src="compositions/${p.id}.html" data-start="0" data-duration="${p.duration}" data-width="1920" data-height="1080" data-track-index="0"></div>`,
    ),
  });
}

fail(
  "usage: library.mjs list [looks|pieces] [--kind k] | search <words> | show <id> | look <project> <look-id> | add <project> <piece-id>... [--force] | kit <project>",
);
