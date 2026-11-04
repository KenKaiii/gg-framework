// Read/write the project health checklist record (`<project>/.gg-checklist.json`).
// The file is shared through Git, so it is treated as untrusted on the way in:
// every entry is validated, unknown ids and bad dates are dropped, long text is
// clipped. Writes are atomic (temp file + rename) and canonical (sorted ids,
// fixed key order) so diffs between teammates stay small.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  CHECKLIST_FILE,
  CHECKLIST_STALE_DAYS,
  getChecklistItem,
  type ChecklistItem,
} from "./checklist-items.js";
import { retryWindowsReplace } from "./session-storage.js";

export const CHECKLIST_RESULTS = ["pass", "issues", "not-applicable"] as const;
export type ChecklistResult = (typeof CHECKLIST_RESULTS)[number];

export type ChecklistStatus = "not-run" | "not-applicable" | "due" | "passed" | "needs-work";

export const SUMMARY_MAX = 300;
export const FINDING_MAX = 300;
export const EVIDENCE_MAX = 200;
export const LIST_MAX = 10;

/** Accept teammates' clocks running a little ahead; anything further is bogus. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;
const STALE_MS = CHECKLIST_STALE_DAYS * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 1024 * 1024;

export interface ChecklistEntry {
  readonly checkedAt: string;
  readonly commit: string | null;
  readonly uncommittedChanges: boolean;
  readonly result: ChecklistResult;
  readonly summary: string;
  readonly findings: readonly string[];
  readonly evidence: readonly string[];
}

export interface ChecklistRecord {
  readonly version: 1;
  readonly items: Readonly<Record<string, ChecklistEntry>>;
}

export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

const clip = (max: number) => z.string().transform((s) => (s.length > max ? s.slice(0, max) : s));
const clippedList = (max: number) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((list) =>
      list
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .slice(0, LIST_MAX)
        .map((s) => (s.length > max ? s.slice(0, max) : s)),
    );

const StoredEntry = z.object({
  checkedAt: z.string().refine((s) => Number.isFinite(Date.parse(s))),
  commit: z
    .string()
    .regex(/^[0-9a-f]{4,64}$/)
    .nullable()
    .catch(null),
  uncommittedChanges: z.boolean().catch(false),
  result: z.enum(CHECKLIST_RESULTS),
  summary: clip(SUMMARY_MAX).catch(""),
  findings: clippedList(FINDING_MAX),
  evidence: clippedList(EVIDENCE_MAX),
});

const StoredFile = z.object({
  version: z.literal(1),
  items: z.record(z.string(), z.unknown()),
});

export function checklistPath(cwd: string): string {
  return path.join(cwd, CHECKLIST_FILE);
}

const EMPTY: ChecklistRecord = { version: 1, items: {} };

/**
 * Read and validate the record. A missing file is an empty record; a file that
 * is not valid JSON (or not a version-1 record) is an error, so a write never
 * silently replaces a teammate's data. Invalid entries are dropped, not fatal.
 */
export async function readChecklist(
  cwd: string,
  now: Date,
  signal?: AbortSignal,
): Promise<Result<ChecklistRecord>> {
  let raw: string;
  let handle: FileHandle | undefined;
  try {
    if (signal?.aborted) return { ok: false, error: "Checklist read cancelled" };
    const file = checklistPath(cwd);
    const link = await fs.lstat(file);
    if (link.isSymbolicLink() || !link.isFile()) {
      return { ok: false, error: `${CHECKLIST_FILE} must be a regular file, not a link` };
    }
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, error: `${CHECKLIST_FILE} must be a regular file` };
    if (stat.size > MAX_FILE_BYTES) {
      return { ok: false, error: `${CHECKLIST_FILE} is larger than 1 MB` };
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      if (signal?.aborted) return { ok: false, error: "Checklist read cancelled" };
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES)
      return { ok: false, error: `${CHECKLIST_FILE} is larger than 1 MB` };
    raw = buffer.subarray(0, length).toString("utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: EMPTY };
    return { ok: false, error: `Could not read ${CHECKLIST_FILE}: ${(err as Error).message}` };
  } finally {
    await handle?.close();
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${CHECKLIST_FILE} is not valid JSON` };
  }
  const file = StoredFile.safeParse(json);
  if (!file.success) {
    return { ok: false, error: `${CHECKLIST_FILE} is not a version 1 checklist record` };
  }
  const items: Record<string, ChecklistEntry> = {};
  const latest = now.getTime() + FUTURE_SLACK_MS;
  for (const [id, value] of Object.entries(file.data.items)) {
    if (!getChecklistItem(id)) continue;
    const entry = StoredEntry.safeParse(value);
    if (!entry.success) continue;
    const checked = Date.parse(entry.data.checkedAt);
    if (checked > latest) continue;
    items[id] = { ...entry.data, checkedAt: new Date(checked).toISOString() };
  }
  return { ok: true, value: { version: 1, items } };
}

/** Canonical JSON: ids sorted, fixed key order, 2-space indent, trailing newline. */
export function serializeChecklist(record: ChecklistRecord): string {
  const items: Record<string, ChecklistEntry> = {};
  for (const id of Object.keys(record.items).sort()) {
    const e = record.items[id];
    if (!e) continue;
    items[id] = {
      checkedAt: e.checkedAt,
      commit: e.commit,
      uncommittedChanges: e.uncommittedChanges,
      result: e.result,
      summary: e.summary,
      findings: [...e.findings],
      evidence: [...e.evidence],
    };
  }
  return JSON.stringify({ version: 1, items }, null, 2) + "\n";
}

/** Windows refuses `mkdir` with one of these, not EEXIST, while a released lock
 * dir is still pending delete. */
const PENDING_DELETE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

/** Whether the lock dir is still there; a refused stat means it is mid-delete. */
async function lockDirExists(lockPath: string): Promise<boolean> {
  try {
    await fs.stat(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Atomic directory creation serializes distinct tools/processes, not just one session.
 * Fail closed on a busy/interrupted writer; never steal a live lock after a timeout. */
async function acquireWriteLock(lockPath: string, signal?: AbortSignal): Promise<Result<void>> {
  const started = performance.now();
  let refusedWithoutLock = 0;
  while (true) {
    if (signal?.aborted) return { ok: false, error: "Checklist recording cancelled" };
    try {
      await fs.mkdir(lockPath);
      return { ok: true, value: undefined };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        const fault: Result<void> = {
          ok: false,
          error: `Could not lock ${CHECKLIST_FILE}: ${(error as Error).message}`,
        };
        if (!code || !PENDING_DELETE_CODES.has(code)) return fault;
        // Contention while the releasing writer's lock dir is still there. With no
        // lock dir, retry in case its delete just finished; a refusal that persists
        // is a genuine fault (e.g. an unwritable project), never one to wait out.
        if (!(await lockDirExists(lockPath))) {
          if (++refusedWithoutLock > 3) return fault;
          continue;
        }
      }
      refusedWithoutLock = 0;
    }
    if (performance.now() - started >= 2500) {
      return {
        ok: false,
        error: `${CHECKLIST_FILE} is locked by another or interrupted write. Retry after it finishes; an interrupted write may require removing ${CHECKLIST_FILE}.lock when no checks are running.`,
      };
    }
    try {
      await delay(25, undefined, signal ? { signal } : undefined);
    } catch {
      return { ok: false, error: "Checklist recording cancelled" };
    }
  }
}

/** Lock the whole read/merge/write transaction, then replace the record atomically. */
export async function writeChecklistEntry(
  cwd: string,
  id: string,
  entry: ChecklistEntry,
  now: Date,
  signal?: AbortSignal,
): Promise<Result<ChecklistRecord>> {
  if (!getChecklistItem(id)) return { ok: false, error: `Unknown checklist item: ${id}` };
  const target = checklistPath(cwd);
  const lockPath = `${target}.lock`;
  const locked = await acquireWriteLock(lockPath, signal);
  if (!locked.ok) return locked;
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const current = await readChecklist(cwd, now, signal);
    if (!current.ok) return current;
    const next: ChecklistRecord = { version: 1, items: { ...current.value.items, [id]: entry } };
    await fs.writeFile(temp, serializeChecklist(next), {
      encoding: "utf-8",
      flag: "wx",
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted) return { ok: false, error: "Checklist recording cancelled" };
    await retryWindowsReplace(() => fs.rename(temp, target));
    return { ok: true, value: next };
  } catch (err) {
    return { ok: false, error: `Could not write ${CHECKLIST_FILE}: ${(err as Error).message}` };
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
    await fs.rmdir(lockPath);
  }
}

export function checklistStatus(entry: ChecklistEntry | undefined, now: Date): ChecklistStatus {
  if (!entry) return "not-run";
  const checked = Date.parse(entry.checkedAt);
  if (!Number.isFinite(checked) || checked > now.getTime() + FUTURE_SLACK_MS) return "not-run";
  if (entry.result === "not-applicable") return "not-applicable";
  if (now.getTime() - checked > STALE_MS) return "due";
  return entry.result === "pass" ? "passed" : "needs-work";
}

export interface ChecklistRow {
  readonly id: string;
  readonly group: ChecklistItem["group"];
  readonly title: string;
  readonly description: string;
  readonly check: string;
  readonly skill: string | null;
  readonly setupCommand: string | null;
  readonly status: ChecklistStatus;
  readonly checkedAt: string | null;
  readonly commit: string | null;
  readonly uncommittedChanges: boolean;
  readonly result: ChecklistResult | null;
  readonly summary: string | null;
  readonly findings: readonly string[];
  readonly evidence: readonly string[];
}

/** Every item in list order, joined with its recorded entry and current status. */
export function checklistView(
  items: readonly ChecklistItem[],
  record: ChecklistRecord,
  now: Date,
): ChecklistRow[] {
  return items.map((item) => {
    const entry = record.items[item.id];
    return {
      id: item.id,
      group: item.group,
      title: item.title,
      description: item.description,
      check: item.check,
      skill: item.skill ?? null,
      setupCommand: item.setupCommand ?? null,
      status: checklistStatus(entry, now),
      checkedAt: entry?.checkedAt ?? null,
      commit: entry?.commit ?? null,
      uncommittedChanges: entry?.uncommittedChanges ?? false,
      result: entry?.result ?? null,
      summary: entry?.summary ?? null,
      findings: entry?.findings ?? [],
      evidence: entry?.evidence ?? [],
    };
  });
}
