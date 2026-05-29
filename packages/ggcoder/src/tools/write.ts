import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath, rejectSymlink } from "./path-utils.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { assertFresh, recordWrite, type ReadTracker } from "./read-tracker.js";
import {
  goalModeRestriction,
  isGoalModeActive,
  isPlanModeActive,
  type GoalMode,
} from "../core/runtime-mode.js";

type MutationCallback = (filePath: string) => void | Promise<void>;

function isMutationCallback(value: unknown): value is MutationCallback {
  return typeof value === "function";
}

function isPlanModeRef(value: unknown): value is { current: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { current?: unknown }).current === "boolean"
  );
}

const WriteParams = z.object({
  file_path: z.string().describe("The file path to write to"),
  content: z.string().describe("The content to write"),
});

export function createWriteTool(
  cwd: string,
  readFiles?: ReadTracker,
  ops: ToolOperations = localOperations,
  goalModeRefOrOnFileMutated?: { current: GoalMode } | MutationCallback,
  planModeRefOrOnFileMutated?: { current: boolean } | MutationCallback,
  onFileMutated?: MutationCallback,
  onPreFileMutation?: MutationCallback,
): AgentTool<typeof WriteParams> {
  const goalModeRef = isMutationCallback(goalModeRefOrOnFileMutated)
    ? undefined
    : goalModeRefOrOnFileMutated;
  const planModeRef = isPlanModeRef(planModeRefOrOnFileMutated)
    ? planModeRefOrOnFileMutated
    : undefined;
  const mutationCallback = isMutationCallback(goalModeRefOrOnFileMutated)
    ? goalModeRefOrOnFileMutated
    : isMutationCallback(planModeRefOrOnFileMutated)
      ? planModeRefOrOnFileMutated
      : onFileMutated;
  return {
    name: "write",
    description:
      "Write content to a file. Creates parent directories if needed. " +
      "Existing files must be read first before overwriting. Use for new files or complete rewrites.",
    parameters: WriteParams,
    executionMode: "sequential",
    async execute({ file_path, content }) {
      const resolved = resolvePath(cwd, file_path);
      await rejectSymlink(resolved);

      if (isGoalModeActive(goalModeRef)) {
        return goalModeRestriction("write", "Goal metadata, evidence plans, and task creation");
      }
      if (isPlanModeActive(planModeRef)) {
        const plansDir = path.join(cwd, ".gg", "plans");
        const relative = path.relative(plansDir, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          return `Error: write is restricted in plan mode. You can only write to .gg/plans/. Got: ${file_path}`;
        }
        await fs.mkdir(plansDir, { recursive: true });
      }

      // Block overwriting existing files that haven't been read, or that
      // changed since the last read.
      if (readFiles) {
        const exists = await ops.stat(resolved).then(
          () => true,
          () => false,
        );
        if (exists) {
          await assertFresh(readFiles, resolved, ops);
        }
      }
      // Snapshot the pre-mutation on-disk state for /rewind before writing.
      await onPreFileMutation?.(resolved);
      await ops.writeFile(resolved, content);
      await recordWrite(readFiles, resolved, content, ops);
      await mutationCallback?.(resolved);
      const lines = content.split("\n").length;
      return `Wrote ${lines} lines to ${resolved}`;
    },
  };
}
