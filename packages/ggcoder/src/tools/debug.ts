import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { NodeDebugSession, type StopState } from "../core/node-debugger.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import type { SandboxPolicy } from "../core/sandbox.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { truncateTail } from "./truncate.js";

const DEFAULT_WAIT_MS = 15_000;
const MAX_WAIT_MS = 120_000;

const BreakpointSpec = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  condition: z.string().optional().describe("JS expression; pause only when it is truthy"),
});

const DebugParams = z.object({
  action: z
    .enum([
      "launch",
      "set_breakpoint",
      "remove_breakpoint",
      "continue",
      "step_over",
      "step_into",
      "step_out",
      "pause",
      "stack",
      "variables",
      "evaluate",
      "output",
      "stop",
    ])
    .describe("What to do"),
  program: z.string().optional().describe("launch: script to run (.js/.mjs/.cjs/.ts)"),
  args: z.array(z.string()).optional().describe("launch: arguments passed to the script"),
  node_args: z
    .array(z.string())
    .optional()
    .describe('launch: extra node flags, e.g. ["--test", "--test-isolation=none"]'),
  breakpoints: z
    .array(BreakpointSpec)
    .max(50)
    .optional()
    .describe("launch: breakpoints armed before the first line runs"),
  stop_on_entry: z.boolean().optional().describe("launch: stay paused on the first line"),
  pause_on_exceptions: z
    .enum(["none", "uncaught", "all"])
    .optional()
    .describe("launch: when to pause on a throw (default uncaught)"),
  file: z.string().optional().describe("set_breakpoint: file path"),
  line: z.number().int().positive().optional().describe("set_breakpoint: 1-based line"),
  condition: z.string().optional().describe("set_breakpoint: JS condition"),
  breakpoint_id: z.string().optional().describe("remove_breakpoint: id such as bp1"),
  frame: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("variables/evaluate: stack frame index (0 = innermost)"),
  expression: z.string().optional().describe("evaluate: JS expression"),
  timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(MAX_WAIT_MS)
    .optional()
    .describe(
      `launch/continue/step/pause: how long to wait for a stop (default ${DEFAULT_WAIT_MS})`,
    ),
});

type DebugArgs = z.infer<typeof DebugParams>;

/** Holds the one live debug session of an agent session; `shutdown` on dispose. */
export class DebugManager {
  private session: NodeDebugSession | undefined;

  get current(): NodeDebugSession | undefined {
    return this.session;
  }

  replace(next: NodeDebugSession | undefined): boolean {
    const replaced = this.session !== undefined && !this.session.hasExited;
    this.session?.stop();
    this.session = next;
    return replaced;
  }

  shutdown(): void {
    this.replace(undefined);
  }
}

function describeStop(session: NodeDebugSession, state: StopState, waitedMs: number): string {
  const parts: string[] = [];
  if (state.kind === "paused") {
    parts.push(session.pauseSummary());
    const snippet = session.sourceSnippet();
    if (snippet) parts.push(snippet);
  } else if (state.kind === "exited") {
    parts.push(`The program exited (code ${state.code ?? "unknown"}). The debug session is over.`);
  } else {
    parts.push(
      `Still running after ${waitedMs / 1000}s with no breakpoint hit. ` +
        "Use pause to stop it where it is, continue to keep waiting, or stop to end it.",
    );
  }
  const output = session.readNewOutput();
  if (output) parts.push(`Program output:\n${truncateTail(output).content}`);
  return parts.join("\n\n");
}

async function withLocals(session: NodeDebugSession, text: string): Promise<string> {
  if (!session.isPaused) return text;
  try {
    return `${text}\n\nVariables:\n${await session.variables(0)}`;
  } catch {
    return text;
  }
}

function need<T>(value: T | undefined, name: string, action: string): T {
  if (value === undefined) throw new Error(`${action} needs \`${name}\``);
  return value;
}

export function createDebugTool(
  cwd: string,
  manager: DebugManager,
  ops: ToolOperations = localOperations,
  planModeRef?: { current: boolean },
  getSandboxPolicy?: () => SandboxPolicy,
): AgentTool<typeof DebugParams> {
  return {
    name: "debug",
    description:
      "Debug a Node.js program (JS, or TS via type stripping) with real breakpoints when a bug " +
      "depends on runtime state, instead of adding prints. launch/continue/step_*/pause return the " +
      "stop location, surrounding source and locals; pauses on uncaught exceptions by default. One " +
      'session at a time (launch stops the previous). node:test files: node_args ["--test", ' +
      '"--test-isolation=none"]. Worker-process runners (vitest, jest) never reach breakpoints.',
    parameters: DebugParams,
    async execute(args: DebugArgs, context) {
      const waitMs = args.timeout_ms ?? DEFAULT_WAIT_MS;
      const session = manager.current;

      if (args.action === "launch") {
        if (isPlanModeActive(planModeRef)) return planModeRestriction("debug launch");
        const program = need(args.program, "program", "launch");
        let next: NodeDebugSession;
        try {
          next = await NodeDebugSession.launch({
            cwd,
            program,
            ...(args.args && { args: args.args }),
            ...(args.node_args && { nodeArgs: args.node_args }),
            ...(args.breakpoints && { breakpoints: args.breakpoints }),
            ...(args.pause_on_exceptions && { pauseOnExceptions: args.pause_on_exceptions }),
            ...(getSandboxPolicy && { sandboxPolicy: getSandboxPolicy() }),
            ops,
          });
        } catch (error) {
          return `Error: could not start the debugger: ${(error as Error).message}`;
        }
        const replaced = manager.replace(next);
        // The first stop is always "Break on start", after breakpoints are armed.
        let state = await next.waitForStop(waitMs, context.signal);
        if (state.kind === "paused" && !args.stop_on_entry) {
          state = await next.resume("continue", waitMs, context.signal);
        }
        const armed = next
          .listBreakpoints()
          .map((bp) => `${bp.id} ${bp.file}:${bp.line}`)
          .join(", ");
        const header =
          (replaced ? "Stopped the previous debug session.\n" : "") +
          `Launched ${program} under the debugger.` +
          (armed ? ` Breakpoints: ${armed}.` : "");
        return withLocals(next, `${header}\n\n${describeStop(next, state, waitMs)}`);
      }

      if (!session) return 'Error: no debug session. Start one with action "launch".';
      if (args.action === "output") {
        return session.readNewOutput() || "(no new output)";
      }
      if (args.action === "stop") {
        manager.replace(undefined);
        const output = session.readNewOutput();
        return `Debug session stopped.${output ? `\n\nProgram output:\n${truncateTail(output).content}` : ""}`;
      }
      if (session.hasExited) {
        return `Error: the program already exited (${describeStop(session, session.state(), 0)}). Launch it again.`;
      }

      try {
        switch (args.action) {
          case "set_breakpoint": {
            const file = need(args.file, "file", "set_breakpoint");
            const line = need(args.line, "line", "set_breakpoint");
            const bp = await session.setBreakpoint(file, line, args.condition);
            const where =
              bp.boundLines.length > 0
                ? `bound at line ${bp.boundLines.join(", ")}`
                : "pending until the file loads (check the path if it never hits)";
            return `Breakpoint ${bp.id} set at ${file}:${line}, ${where}.`;
          }
          case "remove_breakpoint": {
            const id = need(args.breakpoint_id, "breakpoint_id", "remove_breakpoint");
            return (await session.removeBreakpoint(id))
              ? `Removed ${id}.`
              : `Error: no breakpoint ${id}. Set: ${
                  session
                    .listBreakpoints()
                    .map((b) => b.id)
                    .join(", ") || "none"
                }.`;
          }
          case "continue":
          case "step_over":
          case "step_into":
          case "step_out": {
            if (!session.isPaused) {
              return "Error: the program is running, not paused. Use pause first, or wait for a breakpoint.";
            }
            const state = await session.resume(args.action, waitMs, context.signal);
            return withLocals(session, describeStop(session, state, waitMs));
          }
          case "pause": {
            const state = await session.pause(waitMs, context.signal);
            return withLocals(session, describeStop(session, state, waitMs));
          }
          case "stack":
            if (!session.isPaused)
              return "Error: the program is running; there is no stack to show.";
            return session.stack();
          case "variables":
            if (!session.isPaused) return "Error: the program is running; pause it first.";
            return session.variables(args.frame ?? 0);
          case "evaluate":
            return session.evaluate(
              need(args.expression, "expression", "evaluate"),
              args.frame ?? 0,
            );
        }
      } catch (error) {
        return `Error: ${(error as Error).message}`;
      }
      return "Error: unknown action";
    },
  };
}
