// `checklist` tool: the only writer of the project health checklist record.
// The model supplies the verdict; the code stamps the date (injected clock),
// the Git commit and whether there were uncommitted changes, so none of those
// can be made up.
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { log } from "../core/logger.js";
import {
  CHECKLIST_FILE,
  CHECKLIST_IDS,
  CHECKLIST_STALE_DAYS,
  getChecklistItem,
} from "../core/checklist-items.js";
import {
  CHECKLIST_RESULTS,
  EVIDENCE_MAX,
  FINDING_MAX,
  LIST_MAX,
  SUMMARY_MAX,
  writeChecklistEntry,
} from "../core/checklist-store.js";
import { readGitState, type GitState } from "../core/checklist-git.js";
import { readChecklistSnapshot, type ChecklistSnapshotRow } from "../core/checklist-snapshot.js";

// The union is flattened into one object schema for providers, so both
// literals carry the same description.
const ACTION_DESCRIPTION =
  "status: every item with its status and last check. record: save the result of checking one item.";

const ChecklistParams = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("status").describe(ACTION_DESCRIPTION),
  }),
  z.object({
    action: z.literal("record").describe(ACTION_DESCRIPTION),
    id: z.enum(CHECKLIST_IDS).describe("record: the checklist item id"),
    result: z
      .enum(CHECKLIST_RESULTS)
      .describe("record: pass, issues (needs findings) or not-applicable"),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(SUMMARY_MAX)
      .describe("record: one-line verdict in plain words"),
    findings: z
      .array(z.string().trim().min(1).max(FINDING_MAX))
      .max(LIST_MAX)
      .default([])
      .describe("record: each problem with file:line, severity and suggested fix"),
    accepted: z
      .array(z.string().trim().min(1).max(FINDING_MAX))
      .max(LIST_MAX)
      .default([])
      .describe(
        "record: findings the user explicitly chose to leave as is, each with the reason (e.g. 'deferred by owner'); they don't block pass",
      ),
    evidence: z
      .array(z.string().trim().min(1).max(EVIDENCE_MAX))
      .min(1)
      .max(LIST_MAX)
      .describe("record: what was actually run or read, e.g. 'pnpm lint — 0 errors'"),
  }),
]);

export interface ChecklistToolDeps {
  readonly now?: () => Date;
  readonly gitState?: (cwd: string, signal?: AbortSignal) => Promise<GitState>;
}

const STATUS_LABEL: Record<ChecklistSnapshotRow["status"], string> = {
  "not-run": "never run",
  "not-applicable": "not applicable",
  due: "due",
  passed: "reviewed",
  "needs-work": "needs work",
};

function formatRow(row: ChecklistSnapshotRow): string {
  const checked = row.checkedAt
    ? `checked ${row.checkedAt.slice(0, 10)}${row.commit ? ` at ${row.commit}` : ""}`
    : "—";
  const last = row.status === "due" && row.result ? ` (last: ${row.result})` : "";
  const changed =
    row.result === "issues" && row.changedSinceCheck ? ", code changed since this check" : "";
  const accepted = row.accepted.length > 0 ? `, ${row.accepted.length} accepted as is` : "";
  const setup = row.detection ? `; setup: ${row.detection.summary} (not a review)` : "";
  return `- ${row.id} — ${row.title}: ${STATUS_LABEL[row.status]}${last}${accepted}, ${checked}${changed}${setup}`;
}

export function createChecklistTool(
  cwd: string,
  deps: ChecklistToolDeps = {},
): AgentTool<typeof ChecklistParams> {
  const now = deps.now ?? (() => new Date());
  const gitState = deps.gitState ?? readGitState;
  let pending: Promise<void> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = pending.then(fn);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  return {
    name: "checklist",
    description:
      "Read or record the project health checklist (stored in " +
      `${CHECKLIST_FILE}). \`status\` lists every item with its status and last ` +
      `check; items older than ${CHECKLIST_STALE_DAYS} days are due. \`record\` saves ` +
      "the result of checking one item: the date and Git commit are filled in " +
      "automatically. `issues` needs at least one finding; `pass` takes none; " +
      "`evidence` lists what you actually ran or read, including scope and exclusions. " +
      "Record completed checklist reviews or checks requested in normal chat; never start extra audits unasked. " +
      "After fixing an item's recorded findings, re-check them and record that item again " +
      "(`pass`, or `issues` with what remains) so the checklist doesn't keep showing fixed findings. " +
      "Findings the user explicitly chose to leave go in `accepted` with the reason, not `findings`, " +
      "so the item can pass once everything else is fixed.",
    parameters: ChecklistParams,
    executionMode: "sequential",
    execute(args, { signal }) {
      return enqueue(async () => {
        const started = Date.now();
        if (signal?.aborted) return "Error: Checklist action cancelled.";
        if (args.action === "status") {
          const snapshot = await readChecklistSnapshot(cwd, now(), signal, gitState);
          if (!snapshot.ok) return `Error: ${snapshot.error}`;
          const rows = snapshot.value.items;
          let group = "";
          const lines = [`${rows.length} project checks. Setup detection is not a passing review.`];
          for (const row of rows) {
            if (row.group !== group) {
              group = row.group;
              lines.push("", `${group}:`);
            }
            lines.push(formatRow(row));
          }
          return lines.join("\n");
        }

        const item = getChecklistItem(args.id);
        if (!item) return `Error: unknown checklist id "${args.id}".`;
        if (args.result === "issues" && args.findings.length === 0) {
          return "Error: result `issues` needs at least one finding. Add findings, or record `pass`.";
        }
        if (args.result === "pass" && args.findings.length > 0) {
          return "Error: result `pass` cannot have findings. Record `issues`, move findings the user chose to leave into `accepted`, or drop the findings.";
        }
        if (args.result === "not-applicable" && args.accepted.length > 0) {
          return "Error: result `not-applicable` cannot have accepted findings.";
        }
        const at = now();
        let git: GitState;
        try {
          git = await gitState(cwd, signal);
        } catch {
          return signal?.aborted
            ? "Error: Checklist action cancelled."
            : "Error: Could not read Git state; no checklist result was recorded.";
        }
        if (signal?.aborted) return "Error: Checklist action cancelled.";
        const written = await writeChecklistEntry(
          cwd,
          args.id,
          {
            checkedAt: at.toISOString(),
            commit: git.commit,
            uncommittedChanges: git.uncommittedChanges,
            result: args.result,
            summary: args.summary.trim(),
            findings: args.findings.map((f) => f.trim()),
            accepted: args.accepted.map((f) => f.trim()),
            evidence: args.evidence.map((e) => e.trim()),
          },
          at,
          signal,
        );
        log("INFO", "checklist", `Record ${args.id}: ${written.ok ? args.result : "failed"}`, {
          id: args.id,
          result: args.result,
          elapsedMs: Date.now() - started,
        });
        if (!written.ok) return `Error: ${written.error}`;
        const where = git.commit
          ? ` at ${git.commit}${git.uncommittedChanges ? " (with uncommitted changes)" : ""}`
          : "";
        const acceptedNote =
          args.accepted.length > 0 ? ` with ${args.accepted.length} accepted as is` : "";
        return `Recorded ${item.title}: ${args.result}${acceptedNote} on ${at.toISOString().slice(0, 10)}${where}.`;
      });
    },
  };
}
