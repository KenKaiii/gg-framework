#!/usr/bin/env node
// GG Motion contact sheet: tile frame PNGs into one labeled grid image so a
// critique pass costs one image read instead of N (each image read re-prices
// the whole context). `hf snapshot` already writes a full-size sheet; the
// main use here is --phone, which shows the same frames at phone size.
//
// Usage: node contact-sheet.mjs <frames-dir> <out.jpg> [--cols 4] [--width 1600] [--phone]
// Frames are ordered by the number in their filename (seconds or index).
// Uses the `sharp` build that ships inside GG's bundled HyperFrames.
import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const positional = args.filter(
  (a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(cols|width)$/),
);
const [framesArg, outArg] = positional;
if (!framesArg || !outArg) {
  fail("usage: contact-sheet.mjs <frames-dir> <out.jpg> [--cols 4] [--width 1600] [--phone]");
}
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? Number(args[i + 1]) : fallback;
  if (!Number.isFinite(value) || value <= 0) fail(`--${name} must be a positive number`);
  return value;
};
const phone = args.includes("--phone");
const cols = flag("cols", phone ? 6 : 4);
// A phone is ~390pt wide; a phone-strip cell is that width so text reads as it would on a feed.
const sheetWidth = flag("width", phone ? 390 * cols : 1600);

let sharp;
try {
  const require = createRequire(import.meta.url);
  const hfPkg = require.resolve("hyperframes/package.json");
  sharp = createRequire(hfPkg)("sharp");
} catch {
  fail(
    "Contact sheets need the HyperFrames bundled with Kleio. Reinstall Kleio to restore Motion mode.",
  );
}

const framesDir = resolve(framesArg);
const names = await readdir(framesDir).catch(() => fail(`Frames folder not found: ${framesDir}`));
// Skip sheets from earlier runs (snapshot writes contact-sheet.jpg beside its frames).
const entries = names.filter(
  (n) => /\.(png|jpe?g|webp)$/i.test(n) && !/contact-sheet|phone-strip/i.test(n),
);
if (entries.length === 0) fail(`No frame images in ${framesDir}`);
const order = (name) => {
  const m = basename(name, extname(name)).match(/(\d+(?:\.\d+)?)(?!.*\d)/);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
};
entries.sort((a, b) => order(a) - order(b) || a.localeCompare(b));

const gap = 8;
const labelH = 28;
const cellW = Math.floor((sheetWidth - gap * (cols + 1)) / cols);
const first = await sharp(join(framesDir, entries[0])).metadata();
const cellH = Math.round((cellW * (first.height ?? 9)) / (first.width ?? 16));
const rows = Math.ceil(entries.length / cols);
const height = gap + rows * (cellH + labelH + gap);

const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const composites = [];
for (const [i, name] of entries.entries()) {
  const x = gap + (i % cols) * (cellW + gap);
  const y = gap + Math.floor(i / cols) * (cellH + labelH + gap);
  const tile = await sharp(join(framesDir, name))
    .resize(cellW, cellH, { fit: "contain", background: "#111" })
    .toBuffer();
  composites.push({ input: tile, left: x, top: y });
  const label = `${i + 1}. ${basename(name, extname(name))}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${labelH}"><text x="4" y="19" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#ddd">${escapeXml(label)}</text></svg>`;
  composites.push({ input: Buffer.from(svg), left: x, top: y + cellH });
}

const out = resolve(outArg);
const outStat = await stat(dirname(out)).catch(() => null);
if (!outStat?.isDirectory()) fail(`Output folder does not exist: ${dirname(out)}`);
await sharp({ create: { width: sheetWidth, height, channels: 3, background: "#1b1b1b" } })
  .composite(composites)
  .jpeg({ quality: 82 })
  .toFile(out);
process.stdout.write(
  `${JSON.stringify({ ok: true, frames: entries.length, cols, width: sheetWidth, height, out })}\n`,
);
