import type { ProcessManager } from "../core/process-manager.js";
import type { CompletedItem } from "./app-items.js";
import { killTask } from "./stores/taskbar-store.js";

const STOP_FAILURE_PREFIX = "Failed to stop process";

export type AppendTaskKillFeedback = (item: CompletedItem) => void;

export function createTaskKillFeedback(result: string, id: string): CompletedItem {
  if (result.startsWith(STOP_FAILURE_PREFIX)) {
    return {
      kind: "error",
      headline: "Could not stop background task.",
      message: result,
      guidance: "The task may still be running. Try stopping it again.",
      id,
    };
  }

  return { kind: "info", text: result, id };
}

/** Await task termination and surface its exact status in the live transcript. */
export async function killTaskWithFeedback(
  processManager: ProcessManager,
  taskId: string,
  feedbackId: string,
  appendFeedback: AppendTaskKillFeedback,
): Promise<void> {
  try {
    const result = await killTask(processManager, taskId);
    appendFeedback(createTaskKillFeedback(result, feedbackId));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendFeedback(
      createTaskKillFeedback(`Failed to stop process ${taskId}: ${detail}`, feedbackId),
    );
  }
}
