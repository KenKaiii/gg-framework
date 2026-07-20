import crypto from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import type { Message } from "@kenkaiiii/gg-ai";

export const MAX_PERSISTED_TOOL_TEXT_CHARS = 40_000;
export const COLD_SESSION_AGE_DAYS = 7;
export const SESSION_GZIP_VERSION = 1;
export const SESSION_REDIRECT_VERSION = 1;
export const SESSION_MEDIA_MARKER_VERSION = 1;
export const SESSION_PLAIN_SUFFIX = ".jsonl";
export const SESSION_ARCHIVE_SUFFIX = ".jsonl.gz";
export const SESSION_ASSET_SUFFIX = ".jsonl.assets";
export const SESSION_TEMP_MARKER = ".gg-session-tmp-";

const REDIRECT_TYPE = "gg_session_redirect";
const MEDIA_MARKER_PREFIX = `gg-session-asset:v${SESSION_MEDIA_MARKER_VERSION}:`;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REDIRECT_BYTES = 4096;

export interface SessionRedirect {
  type: typeof REDIRECT_TYPE;
  version: typeof SESSION_REDIRECT_VERSION;
  target: string;
}

export interface StorageNormalizationMetrics {
  truncatedToolTexts: number;
  externalizedMedia: number;
  omittedPathMedia: number;
  removedDisplayItems: number;
}

export interface ArchiveSessionResult extends StorageNormalizationMetrics {
  archived: boolean;
  sourceBytes: number;
  archiveBytes: number;
  bytesSaved: number;
  path: string;
}

export function emptyStorageNormalizationMetrics(): StorageNormalizationMetrics {
  return {
    truncatedToolTexts: 0,
    externalizedMedia: 0,
    omittedPathMedia: 0,
    removedDisplayItems: 0,
  };
}

export function isSessionPath(filePath: string): boolean {
  return filePath.endsWith(SESSION_PLAIN_SUFFIX) || filePath.endsWith(SESSION_ARCHIVE_SUFFIX);
}

export function isSessionTempPath(filePath: string): boolean {
  return path.basename(filePath).includes(SESSION_TEMP_MARKER);
}

export function plainSessionPath(filePath: string): string {
  return filePath.endsWith(SESSION_ARCHIVE_SUFFIX) ? filePath.slice(0, -3) : filePath;
}

export function archiveSessionPath(filePath: string): string {
  const plain = plainSessionPath(filePath);
  return `${plain}.gz`;
}

export function sessionAssetDir(filePath: string): string {
  return `${plainSessionPath(filePath)}.assets`;
}

export function sessionGroupPaths(filePath: string): {
  plainPath: string;
  archivePath: string;
  assetsPath: string;
} {
  const plainPath = plainSessionPath(filePath);
  return {
    plainPath,
    archivePath: archiveSessionPath(plainPath),
    assetsPath: sessionAssetDir(plainPath),
  };
}

export function temporarySiblingPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}${SESSION_TEMP_MARKER}${process.pid}-${crypto.randomUUID()}`,
  );
}

function isSiblingBasename(value: string): boolean {
  return (
    value === path.basename(value) &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    isSessionPath(value)
  );
}

async function readRedirect(filePath: string): Promise<SessionRedirect | null> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REDIRECT_BYTES) return null;

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const value = JSON.parse(raw) as Partial<SessionRedirect>;
    if (
      value.type !== REDIRECT_TYPE ||
      value.version !== SESSION_REDIRECT_VERSION ||
      typeof value.target !== "string" ||
      !isSiblingBasename(value.target)
    ) {
      return null;
    }
    return value as SessionRedirect;
  } catch {
    return null;
  }
}

export async function resolveSessionPath(filePath: string): Promise<string> {
  let current = path.resolve(filePath);
  const seen = new Set<string>();
  for (let hops = 0; hops < 4; hops++) {
    if (seen.has(current)) throw new Error(`Session redirect loop at ${filePath}`);
    seen.add(current);
    const redirect = await readRedirect(current);
    if (!redirect) return current;
    current = path.join(path.dirname(current), redirect.target);
  }
  throw new Error(`Too many session redirects at ${filePath}`);
}

export async function isGzipSessionPath(filePath: string): Promise<boolean> {
  const resolved = await resolveSessionPath(filePath);
  const handle = await fs.open(resolved, "r");
  try {
    const bytes = Buffer.alloc(2);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

export async function openSessionReadStream(filePath: string): Promise<{
  path: string;
  stream: Readable;
}> {
  const resolved = await resolveSessionPath(filePath);
  const input: ReadStream = createReadStream(resolved);
  if (await isGzipSessionPath(resolved)) {
    return { path: resolved, stream: input.pipe(createGunzip()) };
  }
  return { path: resolved, stream: input };
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = temporarySiblingPath(filePath);
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    await syncFile(tempPath);
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function writeRedirect(filePath: string, targetPath: string): Promise<void> {
  if (path.dirname(filePath) !== path.dirname(targetPath)) {
    throw new Error("Session redirects must remain in the same directory");
  }
  const target = path.basename(targetPath);
  if (!isSiblingBasename(target)) throw new Error(`Invalid session redirect target: ${target}`);
  const redirect: SessionRedirect = {
    type: REDIRECT_TYPE,
    version: SESSION_REDIRECT_VERSION,
    target,
  };
  await atomicWrite(filePath, `${JSON.stringify(redirect)}\n`);
}

async function verifyPlainSession(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0];
    const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
    if (header.type !== "session" || typeof header.id !== "string") {
      throw new Error(`Invalid session header in ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

async function verifyGzipSession(filePath: string): Promise<void> {
  let headerChecked = false;
  let prefix = Buffer.alloc(0);
  const stream = createReadStream(filePath).pipe(createGunzip());
  for await (const chunk of stream) {
    if (!headerChecked) {
      prefix = Buffer.concat([prefix, Buffer.from(chunk)]);
      const newline = prefix.indexOf(0x0a);
      if (newline >= 0) {
        const header = JSON.parse(prefix.subarray(0, newline).toString("utf8")) as {
          type?: unknown;
          id?: unknown;
        };
        if (header.type !== "session" || typeof header.id !== "string") {
          throw new Error(`Invalid archived session header in ${filePath}`);
        }
        headerChecked = true;
        prefix = Buffer.alloc(0);
      } else if (prefix.length > 1024 * 1024) {
        throw new Error(`Session header is too large in ${filePath}`);
      }
    }
    // Fully consuming the iterator forces gzip CRC/trailer verification while
    // retaining only the first-line prefix needed to validate the header.
  }
  if (!headerChecked) throw new Error(`Missing archived session header in ${filePath}`);
}

export async function thawSessionArchive(filePath: string): Promise<string> {
  const resolved = await resolveSessionPath(filePath);
  if (!(await isGzipSessionPath(resolved))) return resolved;

  const archivePath = resolved;
  const plainPath = plainSessionPath(archivePath);
  const tempPath = temporarySiblingPath(plainPath);
  const before = await fs.stat(archivePath);
  try {
    await pipeline(
      createReadStream(archivePath),
      createGunzip(),
      createWriteStream(tempPath, { flags: "wx" }),
    );
    await syncFile(tempPath);
    await verifyPlainSession(tempPath);
    const after = await fs.stat(archivePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`Session archive changed while thawing: ${archivePath}`);
    }
    await fs.rename(tempPath, plainPath);
    await fs.utimes(plainPath, before.atime, before.mtime);
    await writeRedirect(archivePath, plainPath);
    return plainPath;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

function boundedToolText(text: string, metrics: StorageNormalizationMetrics): string {
  if (text.length <= MAX_PERSISTED_TOOL_TEXT_CHARS) return text;
  metrics.truncatedToolTexts += 1;
  const notice =
    "\n\n[Session storage truncated this tool result. Re-run the tool or use read with offset/limit for the omitted content.]\n\n";
  const available = MAX_PERSISTED_TOOL_TEXT_CHARS - notice.length;
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${text.slice(0, headLength)}${notice}${text.slice(text.length - tailLength)}`;
}

function mediaMarker(sha256: string): string {
  return `${MEDIA_MARKER_PREFIX}${sha256}`;
}

function parseMediaMarker(value: unknown): { valid: boolean; sha256?: string } | null {
  if (typeof value !== "string" || !value.startsWith("gg-session-asset:")) return null;
  if (!value.startsWith(MEDIA_MARKER_PREFIX)) return { valid: false };
  const sha256 = value.slice(MEDIA_MARKER_PREFIX.length);
  return SHA256_PATTERN.test(sha256) ? { valid: true, sha256 } : { valid: false };
}

async function storeMediaAsset(
  sessionPath: string,
  data: string,
  metrics: StorageNormalizationMetrics,
): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 && data.length > 0) return null;
  } catch {
    return null;
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const assetsDir = sessionAssetDir(sessionPath);
  const assetPath = path.join(assetsDir, sha256);
  await fs.mkdir(assetsDir, { recursive: true });
  try {
    await fs.writeFile(assetPath, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  metrics.externalizedMedia += 1;
  return mediaMarker(sha256);
}

function mediaSourceCandidates(content: unknown[]): string[] {
  const candidates: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const text = (block as { type?: unknown; text?: unknown }).text;
    if ((block as { type?: unknown }).type !== "text" || typeof text !== "string") continue;
    const patterns = [
      /Read (?:image|video) file (.+?) \[/u,
      /(?:Captured|Generated).*? → (.+?) \[/u,
      /(?:saved|written|output)(?: to| at)?\s+([^\n]+?\.(?:png|jpe?g|webp|gif|mp4|mov|webm|mkv|avi))\b/iu,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match?.[1]) candidates.push(match[1].trim());
    }
  }
  return candidates;
}

async function firstDurableMediaSource(content: unknown[]): Promise<string | null> {
  for (const candidate of mediaSourceCandidates(content)) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // A stale text path is not a durable source; externalize the media below.
    }
  }
  return null;
}

type MediaBlock = { type: "image" | "video"; mediaType: string; data: string; fileId?: string };

function isMediaBlock(value: unknown): value is MediaBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Partial<MediaBlock>;
  return (
    (block.type === "image" || block.type === "video") &&
    typeof block.mediaType === "string" &&
    typeof block.data === "string"
  );
}

async function normalizeMediaBlocks(
  blocks: unknown[],
  sessionPath: string,
  metrics: StorageNormalizationMetrics,
  sourcePath?: string | null,
): Promise<unknown[]> {
  const normalized: unknown[] = [];
  for (const value of blocks) {
    if (!isMediaBlock(value)) {
      normalized.push(value);
      continue;
    }
    if (sourcePath) {
      metrics.omittedPathMedia += 1;
      normalized.push({
        type: "text",
        text: `[Session storage omitted duplicated ${value.type} data; read the source again at ${sourcePath}.]`,
      });
      continue;
    }
    const marker = await storeMediaAsset(sessionPath, value.data, metrics);
    if (!marker) {
      normalized.push({ type: "text", text: "[Session media could not be persisted.]" });
      continue;
    }
    normalized.push({ ...value, data: marker });
  }
  return normalized;
}

async function normalizeMessage(
  message: Message,
  sessionPath: string,
  metrics: StorageNormalizationMetrics,
): Promise<Message> {
  if (message.role === "user" && Array.isArray(message.content)) {
    return {
      ...message,
      content: (await normalizeMediaBlocks(
        message.content,
        sessionPath,
        metrics,
      )) as typeof message.content,
    };
  }
  if (message.role !== "tool") return message;

  const content = [] as typeof message.content;
  for (const result of message.content) {
    if (typeof result.content === "string") {
      content.push({ ...result, content: boundedToolText(result.content, metrics) });
      continue;
    }
    const sourcePath = await firstDurableMediaSource(result.content);
    const blocks = await normalizeMediaBlocks(result.content, sessionPath, metrics, sourcePath);
    content.push({
      ...result,
      content: blocks.map((block) => {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          return {
            ...(block as { type: "text"; text: string }),
            text: boundedToolText((block as { text: string }).text, metrics),
          };
        }
        return block;
      }) as typeof result.content,
    });
  }
  return { ...message, content };
}

export async function normalizeSessionEntryForStorage<T>(
  entry: T,
  sessionPath: string,
  metrics: StorageNormalizationMetrics = emptyStorageNormalizationMetrics(),
): Promise<T | null> {
  if (!entry || typeof entry !== "object") return entry;
  const value = entry as {
    type?: unknown;
    kind?: unknown;
    message?: Message;
  };
  if (value.type === "custom" && value.kind === "display_item") {
    metrics.removedDisplayItems += 1;
    return null;
  }
  if (value.type !== "message" || !value.message) return entry;
  return {
    ...entry,
    message: await normalizeMessage(value.message, sessionPath, metrics),
  } as T;
}

async function hydrateMediaBlocks(blocks: unknown[], sessionPath: string): Promise<unknown[]> {
  const hydrated: unknown[] = [];
  for (const value of blocks) {
    if (!isMediaBlock(value)) {
      hydrated.push(value);
      continue;
    }
    const marker = parseMediaMarker(value.data);
    if (!marker) {
      hydrated.push(value);
      continue;
    }
    if (!marker.valid || !marker.sha256) {
      hydrated.push({
        type: "text",
        text: "[Session media reference was malformed and was ignored.]",
      });
      continue;
    }
    try {
      const data = await fs.readFile(path.join(sessionAssetDir(sessionPath), marker.sha256));
      hydrated.push({ ...value, data: data.toString("base64") });
    } catch {
      hydrated.push({
        type: "text",
        text: "[Session media asset is unavailable; attach or read it again.]",
      });
    }
  }
  return hydrated;
}

export async function hydrateSessionEntry<T>(entry: T, sessionPath: string): Promise<T> {
  if (!entry || typeof entry !== "object") return entry;
  const value = entry as { type?: unknown; message?: Message };
  if (value.type !== "message" || !value.message) return entry;
  const message = value.message;
  if (message.role === "user" && Array.isArray(message.content)) {
    return {
      ...entry,
      message: {
        ...message,
        content: (await hydrateMediaBlocks(message.content, sessionPath)) as typeof message.content,
      },
    } as T;
  }
  if (message.role !== "tool") return entry;
  const content = [] as typeof message.content;
  for (const result of message.content) {
    content.push({
      ...result,
      content: Array.isArray(result.content)
        ? ((await hydrateMediaBlocks(result.content, sessionPath)) as typeof result.content)
        : result.content,
    });
  }
  return { ...entry, message: { ...message, content } } as T;
}

export async function archiveColdSession(sessionPath: string): Promise<ArchiveSessionResult> {
  const sourcePath = await resolveSessionPath(sessionPath);
  if (await isGzipSessionPath(sourcePath)) {
    const stat = await fs.stat(sourcePath);
    return {
      archived: false,
      sourceBytes: stat.size,
      archiveBytes: stat.size,
      bytesSaved: 0,
      path: sourcePath,
      ...emptyStorageNormalizationMetrics(),
    };
  }

  const plainPath = plainSessionPath(sourcePath);
  const archivePath = archiveSessionPath(plainPath);
  const normalizedTemp = temporarySiblingPath(plainPath);
  const gzipTemp = temporarySiblingPath(archivePath);
  const before = await fs.stat(plainPath);
  const metrics = emptyStorageNormalizationMetrics();

  try {
    const sourceHandle = await fs.open(plainPath, "r");
    let hadTrailingNewline = false;
    try {
      if (before.size > 0) {
        const finalByte = Buffer.alloc(1);
        await sourceHandle.read(finalByte, 0, 1, before.size - 1);
        hadTrailingNewline = finalByte[0] === 0x0a;
      }
    } finally {
      await sourceHandle.close();
    }

    const outputHandle = await fs.open(normalizedTemp, "wx");
    try {
      const rl = createInterface({
        input: createReadStream(plainPath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      let wroteLine = false;
      for await (const line of rl) {
        let outputLine: string | null = line;
        if (line) {
          try {
            const parsed = JSON.parse(line) as unknown;
            if ((parsed as { type?: unknown }).type !== "session") {
              const normalized = await normalizeSessionEntryForStorage(parsed, plainPath, metrics);
              outputLine = normalized === null ? null : JSON.stringify(normalized);
            }
          } catch {
            // Preserve malformed lines byte-for-byte. A later recovery tool may
            // be able to repair content that this version cannot parse.
          }
        }
        if (outputLine === null) continue;
        if (wroteLine) await outputHandle.write("\n");
        await outputHandle.write(outputLine);
        wroteLine = true;
      }
      if (wroteLine && hadTrailingNewline) await outputHandle.write("\n");
      await outputHandle.sync();
    } finally {
      await outputHandle.close();
    }
    await verifyPlainSession(normalizedTemp);
    await pipeline(
      createReadStream(normalizedTemp),
      createGzip({ level: 9 }),
      createWriteStream(gzipTemp, { flags: "wx" }),
    );
    await syncFile(gzipTemp);
    await verifyGzipSession(gzipTemp);

    const after = await fs.stat(plainPath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`Session changed while archiving: ${plainPath}`);
    }

    await fs.rename(gzipTemp, archivePath);
    await fs.utimes(archivePath, before.atime, before.mtime);
    await writeRedirect(plainPath, archivePath);
    const archiveStat = await fs.stat(archivePath);
    return {
      archived: true,
      sourceBytes: before.size,
      archiveBytes: archiveStat.size,
      bytesSaved: Math.max(0, before.size - archiveStat.size),
      path: archivePath,
      ...metrics,
    };
  } finally {
    await fs.unlink(normalizedTemp).catch(() => {});
    await fs.unlink(gzipTemp).catch(() => {});
  }
}

export async function cleanupOldSessionTemps(
  directory: string,
  olderThanMs: number,
): Promise<{ deletedFiles: number; freedBytes: number }> {
  const result = { deletedFiles: 0, freedBytes: 0 };
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !isSessionTempPath(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs >= olderThanMs) continue;
      await fs.unlink(filePath);
      result.deletedFiles += 1;
      result.freedBytes += stat.size;
    } catch {
      // Maintenance artifacts are best-effort cleanup only.
    }
  }
  return result;
}
