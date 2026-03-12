import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export function resolvePath(cwd: string, filePath: string): string {
  if (filePath.startsWith("~")) {
    filePath = path.join(os.homedir(), filePath.slice(1));
  }
  return path.resolve(cwd, filePath);
}

/**
 * Check if a path is a symlink. Used by file tools to prevent symlink-based
 * attacks that could read/write sensitive files outside the working directory.
 */
export async function rejectSymlink(resolved: string): Promise<void> {
  try {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlink: ${resolved}`);
    }
  } catch (err) {
    // Re-throw our own error; swallow ENOENT (file doesn't exist yet, e.g. write/new file)
    if (err instanceof Error && err.message.startsWith("Refusing to follow")) throw err;
  }
}
