import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "vendor"]);

export interface ReferenceProjectFiles {
  files: string[];
  complete: boolean;
}

/** Bounded discovery for configless TS/JS projects. Never follows directory symlinks. */
export async function collectReferenceProjectFiles(
  root: string,
  signal: AbortSignal,
  maxFiles = 256,
  maxEntries = 4096,
): Promise<ReferenceProjectFiles> {
  const files: string[] = [];
  let complete = true;
  let entriesLeft = maxEntries;
  const canonicalRoot = await fs.realpath(root);
  type Rule = { directory: string; matcher: ReturnType<typeof ignore> };
  // Preserve the server's path spelling (/var vs /private/var on macOS).
  // Real paths are for containment only; mixing spellings creates duplicate TS symbols.
  const pending: { directory: string; rules: Rule[] }[] = [{ directory: root, rules: [] }];

  while (pending.length > 0) {
    if (signal.aborted || entriesLeft <= 0 || files.length >= maxFiles) {
      complete = false;
      break;
    }
    const next = pending.shift();
    if (!next) break;
    const { directory } = next;
    const rules = [...next.rules];
    try {
      const actual = await fs.realpath(directory);
      const relative = path.relative(canonicalRoot, actual);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        complete = false;
        continue;
      }
      // A directory may have been swapped for a symlink since it was queued.
      if ((await fs.lstat(directory)).isSymbolicLink()) {
        complete = false;
        continue;
      }
      const ignorePath = path.join(directory, ".gitignore");
      try {
        const stat = await fs.lstat(ignorePath);
        if (stat.isFile() && stat.size <= 65536) {
          const handle = await fs.open(ignorePath, "r");
          try {
            const buffer = Buffer.alloc(65537);
            const { bytesRead } = await handle.read(buffer);
            if (bytesRead <= 65536) {
              rules.push({
                directory,
                matcher: ignore().add(buffer.subarray(0, bytesRead).toString("utf8")),
              });
            } else complete = false;
          } finally {
            await handle.close();
          }
        } else complete = false;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
          complete = false;
      }
      const children = [];
      const dir = await fs.opendir(directory);
      for await (const entry of dir) {
        if (signal.aborted || entriesLeft-- <= 0) {
          complete = false;
          break;
        }
        children.push(entry);
      }
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of children) {
        if (signal.aborted || files.length >= maxFiles) {
          complete = false;
          break;
        }
        if (entry.name.startsWith(".") || EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        if (entry.isSymbolicLink()) {
          complete = false;
          continue;
        }
        const absolute = path.join(directory, entry.name);
        const isDirectory = entry.isDirectory();
        let ignored = false;
        for (const { directory: base, matcher } of rules) {
          const result = matcher.test(
            path.relative(base, absolute).split(path.sep).join("/") + (isDirectory ? "/" : ""),
          );
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        if (ignored) continue;
        if (isDirectory) pending.push({ directory: absolute, rules });
        else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) files.push(absolute);
      }
    } catch {
      complete = false;
    }
  }
  return { files: files.sort(), complete };
}
