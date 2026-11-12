import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

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
