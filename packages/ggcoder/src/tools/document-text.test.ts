import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "./read.js";
import type { ReadTracker } from "./read-tracker.js";

// Minimal zip writer: `deflate` entries use method 8, the rest are stored.
function zip(files: Array<{ name: string; body: string; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.from(file.body, "utf8");
    const data = file.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(file.deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const epub = zip([
  { name: "mimetype", body: "application/epub+zip" },
  {
    name: "META-INF/container.xml",
    body: `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
  },
  {
    name: "OEBPS/content.opf",
    deflate: true,
    body: `<package><metadata><dc:title>The Test Book</dc:title></metadata>
      <manifest>
        <item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/>
        <item href="text/one%20a.xhtml" id="c1" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
  },
  {
    name: "OEBPS/text/one a.xhtml",
    deflate: true,
    body: `<html><head><title>skip me</title><style>p{}</style></head><body><h1>Chapter One</h1><p>Tom &amp; Jerry&#8217;s day.</p><script>evil()</script></body></html>`,
  },
  {
    name: "OEBPS/text/two.xhtml",
    body: `<html><body><p>Second<br/>chapter.</p></body></html>`,
  },
]);

const unpdfInstalled = await import("unpdf").then(() => true).catch(() => false);

describe("read: documents", () => {
  let tmpDir: string;
  const ctx = { signal: new AbortController().signal, toolCallId: "doc" };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-doc-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads an EPUB's chapters as text in spine order", async () => {
    const filePath = path.join(tmpDir, "book.epub");
    await fs.writeFile(filePath, epub);
    const tracker: ReadTracker = new Map();
    const result = (await createReadTool(tmpDir, tracker).execute(
      { file_path: filePath },
      ctx,
    )) as string;
    const text = result.replace(/^ *\d+\t/gm, "");
    expect(text).toBe(
      "[EPUB · The Test Book · 2 chapters]\n\nChapter One\nTom & Jerry\u2019s day.\n\nSecond\nchapter.",
    );
    expect(text).not.toContain("skip me");
    expect(text).not.toContain("evil");
    // Extracted text is not the file's bytes, so it must not unlock edits.
    expect(tracker.has(filePath)).toBe(false);
  });

  it("explains a corrupt EPUB instead of returning garbage", async () => {
    const filePath = path.join(tmpDir, "broken.epub");
    await fs.writeFile(filePath, "not a zip at all, just some bytes padded out to length");
    const result = await createReadTool(tmpDir).execute({ file_path: filePath }, ctx);
    expect(result).toBe(
      `Could not extract text from ${filePath}: not a valid EPUB (zip directory missing)`,
    );
  });

  it.skipIf(!unpdfInstalled)("reads a PDF's text", async () => {
    const filePath = path.join(tmpDir, "sample.pdf");
    await fs.copyFile(
      fileURLToPath(new URL("./__fixtures__/sample.pdf", import.meta.url)),
      filePath,
    );
    const result = (await createReadTool(tmpDir).execute({ file_path: filePath }, ctx)) as string;
    expect(result).toContain("[PDF · 1 page]");
    expect(result).toContain("Hello PDF World");
  });
});
