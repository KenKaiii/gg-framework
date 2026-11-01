import fs from "node:fs";
import path from "node:path";
import { getAppPaths } from "@kenkaiiii/gg-core";

/**
 * Which mechanism produced the change, so a regression can be traced back to
 * the matching strategy that made it. The fuzzy tiers are the ones under
 * suspicion: they place an edit the model did not describe exactly.
 */
export type EditSource = "span" | "text" | "indent_flex" | "blank_edges" | "dotdotdot" | "write";

export interface EditRegression {
  filePath: string;
  /** Error count before the change; only recorded when it grew. */
  before: number;
  after: number;
  source?: EditSource;
}

/**
 * Cap on the log. Past it the file is truncated rather than trimmed line by
 * line: this is aggregate signal about which edit strategies break files, so
 * losing the oldest window costs nothing worth the read-modify-write.
 */
const MAX_BYTES = 256 * 1024;

let logPath: string | undefined;

/** Test seam: redirect the log and forget the resolved path. */
export function setEditTelemetryPathForTests(filePath: string | undefined): void {
  logPath = filePath;
}

function resolveLogPath(): string {
  // GG_EDIT_TELEMETRY_PATH lets the test runner keep rows out of the real ~/.gg.
  logPath ??=
    process.env.GG_EDIT_TELEMETRY_PATH || path.join(getAppPaths().agentDir, "edit-quality.jsonl");
  return logPath;
}

/**
 * Append one valid→invalid transition to a local JSONL log.
 *
 * Records the file's EXTENSION rather than its path or contents: the question
 * this answers is "which edit strategies break which languages", and the answer
 * does not need anything identifying to be useful.
 *
 * Best-effort and synchronous-but-tiny: telemetry must never fail an edit, so
 * every error is swallowed.
 */
export function recordEditRegression(entry: EditRegression): void {
  try {
    const file = resolveLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) {
      fs.truncateSync(file, 0);
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ext: path.extname(entry.filePath) || "none",
      source: entry.source ?? "unknown",
      before: entry.before,
      after: entry.after,
      introduced: entry.after - entry.before,
    });
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // A telemetry write is never worth failing, or even mentioning, an edit for.
  }
}
