import { CHECKLIST_ITEMS, CHECKLIST_STALE_DAYS, getChecklistItem } from "./checklist-items.js";
import { detectChecklist, type ChecklistDetection } from "./checklist-detection.js";
import { changedSinceCheck, readGitState, type GitState } from "./checklist-git.js";
import { checklistRunPrompt } from "./checklist-prompt.js";
import { checklistView, readChecklist, type ChecklistRow, type Result } from "./checklist-store.js";
import { log } from "./logger.js";

export interface ChecklistSnapshotRow extends ChecklistRow {
  readonly detection: ChecklistDetection | null;
  readonly runPrompt: string | null;
  /** The project's commit or working tree changed after this result was recorded. */
  readonly changedSinceCheck: boolean;
}
export interface ChecklistSnapshot {
  readonly staleAfterDays: number;
  readonly detectionWarnings: readonly string[];
  readonly items: readonly ChecklistSnapshotRow[];
}

export type ReadGitState = (cwd: string, signal?: AbortSignal) => Promise<GitState>;

async function currentGitState(
  cwd: string,
  gitState: ReadGitState,
  signal?: AbortSignal,
): Promise<GitState | null> {
  try {
    return await gitState(cwd, signal);
  } catch (error) {
    if (!signal?.aborted) {
      log("WARN", "checklist", "Could not read Git state for the snapshot", {
        error: String(error),
      });
    }
    return null;
  }
}

/** Read-only snapshot shared by the app and the agent tool. */
export async function readChecklistSnapshot(
  cwd: string,
  now: Date,
  signal?: AbortSignal,
  gitState: ReadGitState = readGitState,
): Promise<Result<ChecklistSnapshot>> {
  const [record, detection, git] = await Promise.all([
    readChecklist(cwd, now, signal),
    detectChecklist(cwd, signal),
    currentGitState(cwd, gitState, signal),
  ]);
  if (!record.ok) return record;
  return {
    ok: true,
    value: {
      staleAfterDays: CHECKLIST_STALE_DAYS,
      detectionWarnings: detection.warnings,
      items: checklistView(CHECKLIST_ITEMS, record.value, now).map((row) => {
        const item = getChecklistItem(row.id);
        return {
          ...row,
          detection: detection.items[row.id] ?? null,
          runPrompt: item ? checklistRunPrompt(item, row.accepted) : null,
          changedSinceCheck: changedSinceCheck(row, git),
        };
      }),
    },
  };
}
