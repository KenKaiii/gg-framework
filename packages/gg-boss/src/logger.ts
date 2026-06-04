import path from "node:path";
import { getAppPaths } from "@kenkaiiii/gg-core";
import { openLog, log, closeLogger as coreCloseLogger } from "@kenkaiiii/gg-core";

/**
 * Boss debug log — uses the shared file-writer core in @kenkaiiii/gg-core so the
 * format is grep-compatible across the framework. Lives at ~/.gg/boss/debug.log;
 * the core rotates at 10 MB and keeps one generation (`debug.log.1`) so a
 * session that's just been rotated still has its trailing context recoverable.
 *
 * Each line format:
 *   [<iso-ts>] [sid=<8 hex>] [<LEVEL>] [<category>] <message> [k=v k=v …]
 *
 * Tail it live during a session:
 *   tail -f ~/.gg/boss/debug.log
 *
 * Filter to the current session:
 *   grep "sid=$(grep -oE 'sid=[a-f0-9]+' ~/.gg/boss/debug.log | tail -1 | cut -d= -f2)" ~/.gg/boss/debug.log
 */

export { log, getSessionId } from "@kenkaiiii/gg-core";

export function getLogPath(): string {
  return path.join(getAppPaths().agentDir, "boss", "debug.log");
}

/**
 * Open the boss log in append mode and write a one-time "gg-boss started …"
 * line. Idempotent — re-calling once open is a no-op.
 */
export function initLogger(meta?: {
  version?: string;
  bossProvider?: string;
  bossModel?: string;
  bossThinking?: string;
  workerProvider?: string;
  workerModel?: string;
  projectCount?: number;
}): void {
  if (!openLog(getLogPath(), "gg-boss")) return;
  const parts = ["gg-boss"];
  if (meta?.version) parts[0] += ` v${meta.version}`;
  parts.push("started");
  if (meta?.bossProvider) parts.push(`boss=${meta.bossProvider}/${meta.bossModel ?? "?"}`);
  if (meta?.bossThinking) parts.push(`bossThinking=${meta.bossThinking}`);
  if (meta?.workerProvider) parts.push(`workers=${meta.workerProvider}/${meta.workerModel ?? "?"}`);
  if (meta?.projectCount !== undefined) parts.push(`projects=${meta.projectCount}`);
  parts.push(`pid=${process.pid}`);
  log("INFO", "startup", parts.join(" "));
}

/**
 * Best-effort flush + close. Called from the CLI's exit handler so the final
 * writes hit disk before the process tears down. Suppresses the shared
 * shutdown line to preserve the boss log's historical behavior.
 */
export function closeLogger(): void {
  coreCloseLogger({ shutdownLine: false });
}
