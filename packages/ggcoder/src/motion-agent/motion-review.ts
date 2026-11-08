import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { productionDepthSchema } from "./motion-review-gate.js";

const localPath = z.string().min(1).max(2048);
export const actionWindowSchema = z
  .object({
    label: z.string().min(1).max(80),
    start: z.number().finite().min(0),
    end: z.number().finite().positive(),
  })
  .strict()
  .refine((w) => w.end > w.start && w.end - w.start <= 10);
export const motionRangeSchema = z
  .object({ start: z.number().finite().min(0), end: z.number().finite().positive().max(3600) })
  .strict()
  .refine((r) => r.end > r.start && r.end - r.start <= 180);
export const motionRegistrationSchema = z
  .object({
    project: localPath,
    output: localPath,
    depth: productionDepthSchema.default("standard"),
    windows: z.array(actionWindowSchema).min(1).max(12),
    references: z.array(z.string().min(1).max(1000)).max(4).default([]),
    holds: localPath.optional(),
    slideshowRequested: z.boolean().optional(),
    range: motionRangeSchema.optional(),
  })
  .strict();
export type MotionRegistration = z.infer<typeof motionRegistrationSchema>;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const motionManifestSchema = z
  .object({
    version: z.literal(1),
    range: motionRangeSchema,
    video: z
      .object({
        file: localPath,
        sha256: hashSchema,
        duration: z.number().positive().max(3600),
        fps: z.number().min(1).max(120),
      })
      .strict(),
    windows: z.array(actionWindowSchema).min(1).max(12),
    pages: z
      .array(
        z
          .object({
            kind: z.enum(["overview", "phone", "action"]),
            label: z.string().min(1).max(80),
            times: z.array(z.number().finite().min(0)).min(1).max(8),
            file: z.string().regex(/^\d{2}-(overview|phone|action)\.jpg$/),
            width: z.number().int().positive().max(1600),
            height: z.number().int().positive().max(1600),
            sha256: hashSchema,
          })
          .strict(),
      )
      .min(3)
      .max(14),
  })
  .strict();
export type MotionManifest = z.infer<typeof motionManifestSchema>;
const technicalReportSchema = z.object({
  ok: z.literal(true),
  lint: z.object({ filesScanned: z.number().int().positive(), errorCount: z.literal(0) }),
  runtime: z.object({ errorCount: z.literal(0) }),
  layout: z.object({ samples: z.array(z.number()).min(1), errorCount: z.literal(0) }),
  contrast: z.object({
    enabled: z.literal(true),
    samples: z.array(z.number()).min(1),
    errorCount: z.literal(0),
  }),
});
export function isMotionTechnicalReport(text: string): boolean {
  try {
    return technicalReportSchema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
/**
 * Existing paths only; checking their real paths rejects symlink escapes. A path is read
 * against the workspace as it was named (so `/tmp/x/file` works for a workspace named
 * `/tmp/x` although macOS keeps it at `/private/tmp/x`) and checked again by real path.
 */
export async function motionPath(root: string, input: string): Promise<string> {
  const base = await fs.realpath(root);
  const named = path.resolve(root);
  const requested = path.resolve(named, input);
  if (!inside(named, requested) && !inside(base, requested))
    throw new Error("Motion path escapes its workspace");
  const real = await fs.realpath(requested);
  if (!inside(base, real)) throw new Error("Motion symlink escapes its workspace");
  return real;
}
export async function hashMotionFile(file: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 2 * 1024 ** 3)
      throw new Error("Motion input is not a bounded regular file");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ signal, autoClose: false })) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 ** 3) throw new Error("Motion input grew beyond 2 GiB");
      hash.update(chunk);
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
export async function readMotionText(
  root: string,
  input: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const file = await motionPath(root, input);
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes)
      throw new Error("Motion text exceeds its limit or is not a file");
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error("Motion text grew beyond its limit");
    signal?.throwIfAborted();
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Source/media fingerprint; output/QA folders are never composition inputs. `ignored` names
 * further files the composition never reads (e.g. a check's hold plan).
 */
export async function motionSourceHash(
  project: string,
  output: string,
  signal?: AbortSignal,
  ignored: readonly string[] = [],
): Promise<string> {
  const root = await fs.realpath(project);
  const excluded = new Set(
    [output, ...ignored].map((file) =>
      path.resolve(root, path.relative(path.resolve(project), path.resolve(file))),
    ),
  );
  const hash = createHash("sha256");
  let count = 0;
  let bytes = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (depth > 12) throw new Error("Motion source tree exceeds depth limit");
    const entries = [];
    const directory = await fs.opendir(dir);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (++count > 2000) throw new Error("Motion source tree exceeds 2000 entries");
      entries.push(entry);
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (
        [".git", ".gg", ".hyperframes", ".DS_Store", "node_modules", "qa", "renders"].includes(
          entry.name,
        ) ||
        entry.name === ".env" ||
        entry.name.startsWith(".env.")
      )
        continue;
      const file = path.join(dir, entry.name);
      if (excluded.has(file)) continue;
      if (entry.isSymbolicLink())
        throw new Error("Motion source symlinks require local copies for review");
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile()) {
        bytes += (await fs.stat(file)).size;
        if (bytes > 2 * 1024 ** 3) throw new Error("Motion source tree exceeds 2 GiB");
        hash.update(
          JSON.stringify([
            path.relative(root, file).split(path.sep).join("/"),
            await hashMotionFile(file, signal),
          ]),
        );
      } else throw new Error("Motion source contains a non-regular input");
    }
  };
  await walk(root, 0);
  return hash.digest("hex");
}

export async function validateMotionManifest(
  directory: string,
  output: string,
  windows: MotionRegistration["windows"],
  signal?: AbortSignal,
  range?: MotionRegistration["range"],
): Promise<{ manifest: MotionManifest; images: Buffer[] }> {
  const manifest = motionManifestSchema.parse(
    JSON.parse(await readMotionText(directory, "manifest.json", 32_768, signal)),
  );
  if (
    manifest.video.sha256 !== (await hashMotionFile(output, signal)) ||
    JSON.stringify(manifest.windows) !== JSON.stringify(windows)
  )
    throw new Error("Stale rendered evidence");
  const expectedRange = range ?? { start: 0, end: manifest.video.duration };
  if (manifest.range.start !== expectedRange.start || manifest.range.end !== expectedRange.end)
    throw new Error("Wrong chapter evidence range");
  if (
    manifest.pages[0]?.kind !== "overview" ||
    manifest.pages[1]?.kind !== "phone" ||
    manifest.pages.length !== windows.length + 2
  )
    throw new Error("Incomplete overview/phone/action coverage");
  const images: Buffer[] = [];
  let bytes = 0;
  for (const [i, page] of manifest.pages.entries()) {
    if (page.times.some((t) => t < expectedRange.start || t >= expectedRange.end))
      throw new Error("Evidence timestamp outside video");
    if (i >= 2) {
      const window = windows[i - 2];
      if (
        !window ||
        page.kind !== "action" ||
        page.label !== window.label ||
        page.times.length < 2 ||
        page.times[0] !== window.start ||
        Math.abs((page.times[1] ?? 0) - (page.times[0] ?? 0) - 1 / manifest.video.fps) > 0.00001
      )
        throw new Error("Missing consecutive action evidence");
    }
    const file = await motionPath(directory, page.file);
    const size = (await fs.stat(file)).size;
    bytes += size;
    if (
      size > 2 * 1024 ** 2 ||
      bytes > 16 * 1024 ** 2 ||
      (await hashMotionFile(file, signal)) !== page.sha256
    )
      throw new Error("Changed or oversized image evidence");
    const image = await fs.readFile(file, { signal });
    if (image[0] !== 0xff || image[1] !== 0xd8) throw new Error("Evidence is not JPEG imagery");
    images.push(image);
  }
  return { manifest, images };
}
