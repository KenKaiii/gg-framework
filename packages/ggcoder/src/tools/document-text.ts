import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { extractPdfText } from "./pdf-extract.js";

/** Documents `read` returns as extracted text instead of a binary-file notice. */
export const DOCUMENT_EXTENSIONS = new Set([".pdf", ".epub"]);

/** Same as the app's per-message attachment cap, so any attached document reads. */
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

// Zip-bomb guard: no real EPUB chapter inflates past this.
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;

/** Plain text of a PDF or EPUB, headed by a one-line `[PDF · …]` summary. */
export async function extractDocumentText(ext: string, bytes: Buffer): Promise<string> {
  if (ext === ".pdf") {
    const { text, pages } = await extractPdfText(new Uint8Array(bytes));
    return `[PDF · ${pages} page${pages === 1 ? "" : "s"}]\n\n${text.trim()}`;
  }
  if (ext === ".epub") return extractEpubText(bytes);
  throw new Error(`unsupported document type ${ext}`);
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function readZipDirectory(buf: Buffer): Map<string, ZipEntry> {
  // End-of-central-directory record: last 22 bytes plus an up-to-64 KB comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a valid EPUB (zip directory missing)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error("not a valid EPUB (corrupt zip directory)");
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, {
      name,
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) {
    throw new Error(`not a valid EPUB (corrupt entry ${entry.name})`);
  }
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
  throw new Error(`unsupported compression in EPUB entry ${entry.name}`);
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
}

function resolveHref(base: string, href: string): string {
  const bare = href.split("#")[0]!;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // Malformed escapes: use the href as written.
  }
  return path.posix.normalize(base === "." ? decoded : path.posix.join(base, decoded));
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    const code =
      body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(head|script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre|dt|dd|figcaption|table)\s*>/gi,
      "\n",
    )
    .replace(/<[^>]*>/g, "");
  return decodeEntities(stripped)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractEpubText(buf: Buffer): string {
  const entries = readZipDirectory(buf);
  const read = (name: string): string | null => {
    const entry = entries.get(name);
    return entry ? readZipEntry(buf, entry).toString("utf8") : null;
  };
  const container = read("META-INF/container.xml");
  const opfPath = container ? /full-path\s*=\s*["']([^"']+)["']/i.exec(container)?.[1] : undefined;
  const opf = opfPath ? read(opfPath) : null;
  let chapters: string[] = [];
  let title: string | undefined;
  if (opf && opfPath) {
    const rawTitle = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1];
    title = rawTitle ? htmlToText(rawTitle) || undefined : undefined;
    const base = path.posix.dirname(opfPath);
    const manifest = new Map<string, string>();
    for (const tag of opf.match(/<item\b[^>]*>/gi) ?? []) {
      const id = attr(tag, "id");
      const href = attr(tag, "href");
      if (id && href) manifest.set(id, resolveHref(base, href));
    }
    for (const tag of opf.match(/<itemref\b[^>]*>/gi) ?? []) {
      const href = manifest.get(attr(tag, "idref") ?? "");
      if (href && entries.has(href)) chapters.push(href);
    }
  }
  // No usable spine: fall back to every XHTML file in archive-name order.
  if (chapters.length === 0) {
    chapters = [...entries.keys()].filter((name) => /\.x?html?$/i.test(name)).sort();
  }
  if (chapters.length === 0) throw new Error("no readable chapters found in EPUB");
  const body = chapters
    .map((name) => htmlToText(read(name) ?? ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
  const label = `${chapters.length} chapter${chapters.length === 1 ? "" : "s"}`;
  return `[EPUB · ${title ? `${title} · ` : ""}${label}]\n\n${body}`;
}
