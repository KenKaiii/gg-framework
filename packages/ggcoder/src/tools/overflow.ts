import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { getAppPaths } from "../config.js";

/** Overflow files older than this are deleted by cleanupToolOutputs(). */
const TOOL_OUTPUT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** Root folder for recoverable full tool outputs: `~/.gg/tool-output/`. */
export function getToolOutputRoot(): string {
  return path.join(getAppPaths().agentDir, "tool-output");
}

/**
 * Write full content to `~/.gg/tool-output/<yyyy-mm-dd>/<prefix>-<random>.txt`
 * so truncated tool results stay recoverable via `read` with offset/limit
 * instead of forcing the model to re-run the command.
 * Returns the file path. Caller uses it in truncation notices; callers must
 * treat failures as best-effort (never fail the tool result over a full disk).
 */
export async function writeOverflow(content: string, prefix: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(getToolOutputRoot(), day);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${prefix}-${crypto.randomBytes(6).toString("hex")}.txt`);
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  return filePath;
}

/**
 * Delete `~/.gg/tool-output/` date folders older than 48h. Best-effort:
 * every failure is swallowed — cleanup must never delay or break startup.
 */
export async function cleanupToolOutputs(maxAgeMs = TOOL_OUTPUT_MAX_AGE_MS): Promise<void> {
  const root = getToolOutputRoot();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // Folder doesn't exist yet — nothing to clean.
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const dirPath = path.join(root, entry.name);
      // Creating a new output updates the day folder's mtime, so it is the
      // authoritative age of the newest file in that folder.
      let newestMs: number;
      try {
        newestMs = (await fs.stat(dirPath)).mtimeMs;
      } catch {
        return;
      }
      if (newestMs < cutoff) {
        await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );
}
