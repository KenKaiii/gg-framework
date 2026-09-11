import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_FILES = 10_000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_MS = 5000;

/**
 * Bounded, local-only comparison of Git workspace inputs. Ignored build output
 * is excluded, but tracked files and explicitly edited inputs never are.
 * Missing Git, symlinks/submodules, races and resource limits decline the
 * optimization: the caller must require fresh checks instead.
 */
export async function captureVerificationSnapshot(
  cwd: string,
  editedFiles: readonly string[] = [],
): Promise<string | null> {
  const deadline = Date.now() + MAX_MS;
  try {
    const git = async (args: string[]) =>
      (
        await exec("git", args, {
          cwd,
          timeout: Math.max(1, deadline - Date.now()),
          maxBuffer: 2 * 1024 * 1024,
        })
      ).stdout;
    const root = await fs.realpath((await git(["rev-parse", "--show-toplevel"])).trim());
    const list = async () =>
      [
        ...new Set(
          (await git(["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
            .split("\0")
            .filter(Boolean),
        ),
      ].sort();
    const listed = await list();
    const explicit: string[] = [];
    for (const file of editedFiles) {
      if (explicit.length >= MAX_FILES || Date.now() > deadline) return null;
      const absolute = path.resolve(cwd, file);
      // Canonicalize the parent, not the file: /var and /private/var alias on
      // macOS, while the final component may legitimately have been deleted.
      const parent = await fs.realpath(path.dirname(absolute));
      explicit.push(path.relative(root, path.join(parent, path.basename(absolute))));
    }
    const files = [...new Set([...listed, ...explicit])].sort();
    if (files.length > MAX_FILES) return null;
    const hash = createHash("sha256");
    let bytes = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (const file of files) {
      if (Date.now() > deadline || path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
        return null;
      const absolute = path.join(root, file);
      hash.update(JSON.stringify(file));
      let stat;
      try {
        stat = await fs.lstat(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update("missing");
        continue;
      }
      // Do not follow repository-controlled links or read device files.
      if (!stat.isFile()) return null;
      const relative = path.relative(root, await fs.realpath(absolute));
      if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) return null;
      if (bytes + stat.size > MAX_BYTES) return null;
      const handle = await fs.open(
        absolute,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== stat.ino || opened.size !== stat.size) return null;
        const fileHash = createHash("sha256");
        let fileBytes = 0;
        for (;;) {
          if (Date.now() > deadline) return null;
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          bytes += bytesRead;
          fileBytes += bytesRead;
          if (bytes > MAX_BYTES) return null;
          fileHash.update(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        if (
          fileBytes !== stat.size ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ino !== stat.ino
        )
          return null;
        hash.update(String(stat.mode));
        hash.update(fileHash.digest());
      } finally {
        await handle.close();
      }
    }
    if (Date.now() > deadline || JSON.stringify(listed) !== JSON.stringify(await list()))
      return null;
    return hash.digest("hex");
  } catch {
    return null;
  }
}
