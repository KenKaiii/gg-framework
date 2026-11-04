import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import type { ProcessManager } from "../core/process-manager.js";
import { checkDestructiveGit } from "../core/destructive-git-guard.js";

const TaskSendParams = z.object({
  id: z.string().describe("The background process ID to send input to"),
  input: z
    .string()
    .optional()
    .describe("Text to type into the process's stdin (e.g. an answer to a prompt or a REPL line)"),
  enter: z
    .boolean()
    .optional()
    .describe("Append a newline (press Enter) after the input. Default true."),
  eof: z
    .boolean()
    .optional()
    .describe("Close stdin after sending, signalling end-of-input (Ctrl-D)."),
});

export function createTaskSendTool(
  processManager: ProcessManager,
  cwd?: string,
): AgentTool<typeof TaskSendParams> {
  return {
    name: "task_send",
    description:
      "Send input to a running background process (started with run_in_background) to drive it " +
      "interactively — answer a [Y/n] or password-style prompt, type into a REPL, or feed a " +
      "scaffolder's questions. By default the input is followed by Enter. After sending, call " +
      "task_output to read the process's response. Set eof=true to close stdin (Ctrl-D).",
    parameters: TaskSendParams,
    executionMode: "sequential",
    async execute({ id, input, enter, eof }) {
      if ((input === undefined || input === "") && enter === false && !eof) {
        return "Nothing to send: provide input, or set enter=true to press Enter, or eof=true.";
      }
      // Input typed into a background shell is a shell command too. Background
      // processes start in the tool cwd; a later `cd` inside them is not seen.
      if (cwd !== undefined && input) {
        const gitBlocked = await checkDestructiveGit(input, { cwd });
        if (gitBlocked) return `Error: input not sent. ${gitBlocked}`;
      }
      return processManager.sendInput(id, input ?? "", { enter, eof });
    },
  };
}
