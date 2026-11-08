#!/usr/bin/env node
// GG Motion PDF ingest: text per page, metadata, and embedded images, using the
// `unpdf` package GG already ships. No network, no extra installs.
//
// Usage: node pdf-extract.mjs <input.pdf> <output-dir>
// Writes: <out>/text.md (page-delimited text), <out>/meta.json,
//         <out>/images/p<page>-<n>.png (embedded raster images, when present)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const [inputArg, outArg] = process.argv.slice(2);
if (!inputArg || !outArg) {
  process.stderr.write("usage: pdf-extract.mjs <input.pdf> <output-dir>\n");
  process.exit(2);
}

let unpdf;
try {
  unpdf = await import("unpdf");
} catch {
  process.stderr.write("PDF support is missing from this GG install (unpdf not found).\n");
  process.exit(1);
}

/** Minimal PNG encoder for RGBA/RGB/gray pixel buffers (no native deps). */
function encodePng(width, height, channels, pixels) {
  const colorType = channels === 4 ? 6 : channels === 3 ? 2 : 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const input = resolve(inputArg);
const outDir = resolve(outArg);
await mkdir(join(outDir, "images"), { recursive: true });

let pdf;
let totalPages;
let text;
try {
  const bytes = new Uint8Array(await readFile(input));
  pdf = await unpdf.getDocumentProxy(bytes);
  ({ totalPages, text } = await unpdf.extractText(pdf, { mergePages: false }));
} catch (error) {
  // pdf.js errors carry the whole minified bundle in their stack; keep only the message.
  const message =
    error instanceof Error || (error && typeof error.message === "string")
      ? error.message
      : String(error);
  process.stderr.write(`Could not read PDF ${input}: ${message}\n`);
  process.exit(1);
}

let info = {};
try {
  info = (await unpdf.getMeta(pdf)).info ?? {};
} catch {
  // Metadata is optional.
}

const pages = Array.isArray(text) ? text : [String(text)];
const md = [`# ${basename(input)}`, ""];
pages.forEach((pageText, i) => {
  md.push(
    `## Page ${i + 1}`,
    "",
    pageText.trim() || "_(no extractable text — likely scanned or image-only)_",
    "",
  );
});
await writeFile(join(outDir, "text.md"), md.join("\n"));

const images = [];
const MIN_EDGE = 120; // skip icons, bullets and rules
for (let page = 1; page <= totalPages; page++) {
  let extracted = [];
  try {
    extracted = await unpdf.extractImages(pdf, page);
  } catch {
    continue;
  }
  let n = 0;
  for (const img of extracted) {
    if (!img?.data || img.width < MIN_EDGE || img.height < MIN_EDGE) continue;
    const channels = img.channels ?? Math.round(img.data.length / (img.width * img.height));
    if (![1, 3, 4].includes(channels)) continue;
    n += 1;
    const file = `p${page}-${n}.png`;
    await writeFile(
      join(outDir, "images", file),
      encodePng(img.width, img.height, channels, img.data),
    );
    images.push({ page, file: `images/${file}`, width: img.width, height: img.height });
  }
}

const emptyPages = pages.map((t, i) => (t.trim() ? null : i + 1)).filter((p) => p !== null);
const meta = {
  source: input,
  pages: totalPages,
  title: typeof info.Title === "string" ? info.Title : null,
  author: typeof info.Author === "string" ? info.Author : null,
  pagesWithoutText: emptyPages,
  images,
};
await writeFile(join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ ok: true, pages: totalPages, images: images.length, pagesWithoutText: emptyPages.length, outDir })}\n`,
);
