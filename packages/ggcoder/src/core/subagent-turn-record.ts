import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

/**
 * Durable side-channel for one child's LAST completed turn, written by the
 * worker itself next to its session transcript. It closes the restart gap in
 * durable delegation: when the parent dies mid-child-turn, a detached child
 * finishes its turn with nowhere to report — its stdout pipe is gone — and
 * without this record the rehydrated parent would forever mark it
 * "interrupted", losing completed work (the fx durable-queue lesson).
 *
 * Written atomically (tmp + rename, mirroring subagent-store.ts) and BEST
 * EFFORT: a failed record write is logged and never fails the turn it
 * describes. Reading is fail closed — anything malformed, oversized or absent
 * reads as "no record".
 */
const MAX_RECORD_BYTES = 1024 * 1024;

export interface SubagentTurnRecord {
  status: "completed" | "interrupted" | "failed";
  output?: string;
  /** Engine-built receipt of the turn's tool calls (see subagent-receipt.ts). */
  receipt?: string;
  error?: string;
  model?: string;
  turn_count: number;
  token_usage: { input: number; output: number };
  completed_at: number;
}

function recordPath(childSessionPath: string): string {
  // <validated .jsonl session path>.turn.json — the .jsonl suffix is asserted
  // by the caller (assertChildSessionPath), so this stays a sibling file.
  return `${childSessionPath}.turn.json`;
}

function isTurnRecord(value: unknown): value is SubagentTurnRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SubagentTurnRecord>;
  return (
    (record.status === "completed" ||
      record.status === "interrupted" ||
      record.status === "failed") &&
    typeof record.turn_count === "number" &&
    Number.isFinite(record.turn_count) &&
    !!record.token_usage &&
    typeof record.token_usage.input === "number" &&
    Number.isFinite(record.token_usage.input) &&
    typeof record.token_usage.output === "number" &&
    Number.isFinite(record.token_usage.output) &&
    typeof record.completed_at === "number" &&
    Number.isFinite(record.completed_at)
  );
}

export async function writeTurnRecord(
  childSessionPath: string | undefined,
  record: SubagentTurnRecord,
): Promise<void> {
  if (!childSessionPath) return;
  const filePath = recordPath(childSessionPath);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tempPath, `${JSON.stringify(record)}\n`, "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    log("WARN", "subagent", "Failed to write child turn record", {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

export async function readTurnRecord(
  childSessionPath: string | undefined,
): Promise<SubagentTurnRecord | undefined> {
  if (!childSessionPath) return undefined;
  const filePath = recordPath(childSessionPath);
  try {
    const stat = await fs.stat(filePath);
    if (stat.size === 0 || stat.size > MAX_RECORD_BYTES) return undefined;
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf-8"));
    return isTurnRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** ADOPTED records have served their purpose; keep the transcript dir clean. */
export async function clearTurnRecord(childSessionPath: string | undefined): Promise<void> {
  if (!childSessionPath) return;
  await fs.unlink(recordPath(childSessionPath)).catch(() => {});
}
