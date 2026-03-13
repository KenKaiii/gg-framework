import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { AgentDefinition } from "../core/agents.js";
import type { HookRunner } from "../core/hooks.js";
import {
  createWorktree,
  removeWorktree,
  isWorktreeDirty,
  getRepoRoot,
  generateWorktreeName,
  sanitizeWorktreeName,
} from "../core/worktree.js";
import { truncateTail } from "./truncate.js";

const SUB_AGENT_MAX_TURNS = 10;
const SUB_AGENT_MAX_OUTPUT_CHARS = 100_000; // ~25k tokens, matches other tool limits
const SUB_AGENT_MAX_OUTPUT_LINES = 500;
const SUB_AGENT_MAX_STDERR_CHARS = 10_000; // Cap stderr to prevent unbounded growth

const SubAgentParams = z.object({
  task: z.string().describe("The task to delegate to the sub-agent"),
  agent: z
    .string()
    .optional()
    .describe("Named agent definition to use (from ~/.gg/agents/ or .gg/agents/)"),
});

export interface SubAgentUpdate {
  toolUseCount: number;
  tokenUsage: { input: number; output: number };
  currentActivity?: string;
}

export interface SubAgentDetails {
  toolUseCount: number;
  tokenUsage: { input: number; output: number };
  durationMs: number;
}

export function createSubAgentTool(
  cwd: string,
  agents: AgentDefinition[],
  parentProvider: string,
  parentModel: string,
  hookRunner?: HookRunner,
): AgentTool<typeof SubAgentParams> {
  const agentList = agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
  const agentDesc = agentList
    ? `\n\nAvailable named agents:\n${agentList}`
    : "\n\nNo named agents configured.";

  return {
    name: "subagent",
    description:
      `Spawn an isolated sub-agent to handle a focused task. The sub-agent runs as a separate process with its own context window, tools, and system prompt. Use this for tasks that benefit from isolation or parallelism.` +
      agentDesc,
    parameters: SubAgentParams,
    async execute(args, context) {
      const startTime = Date.now();

      // Resolve agent definition if specified
      let agentDef: AgentDefinition | undefined;
      if (args.agent) {
        agentDef = agents.find((a) => a.name.toLowerCase() === args.agent!.toLowerCase());
        if (!agentDef) {
          return {
            content: `Unknown agent: "${args.agent}". Available agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
          };
        }
      }

      const useProvider = parentProvider;

      // Build CLI args — limit turns to prevent runaway context growth
      const cliArgs: string[] = [
        "--json",
        "--provider",
        useProvider,
        "--model",
        parentModel,
        "--max-turns",
        String(SUB_AGENT_MAX_TURNS),
      ];

      if (agentDef?.systemPrompt) {
        cliArgs.push("--system-prompt", agentDef.systemPrompt);
      }
      cliArgs.push(args.task);

      // Set up worktree isolation if requested
      let childCwd = cwd;
      let worktreeInfo: { repoRoot: string; name: string; path: string } | undefined;
      let worktreeWarning = "";

      if (agentDef?.isolation === "worktree") {
        try {
          const repoRoot = await getRepoRoot(cwd);
          if (repoRoot) {
            const wtName = sanitizeWorktreeName(generateWorktreeName());
            const hookPath = await hookRunner?.runWorktreeCreateHook(wtName);
            if (hookPath && isAbsolute(hookPath)) {
              try {
                await stat(hookPath);
                childCwd = hookPath;
                worktreeInfo = { repoRoot, name: wtName, path: hookPath };
              } catch {
                // Hook path doesn't exist, fall through to createWorktree
              }
            }
            if (!worktreeInfo) {
              const wtPath = await createWorktree({ repoRoot, name: wtName });
              childCwd = wtPath;
              worktreeInfo = { repoRoot, name: wtName, path: wtPath };
            }
          }
        } catch (err) {
          worktreeWarning = `[Worktree creation failed, running without isolation: ${err instanceof Error ? err.message : String(err)}]\n`;
        }
      }

      // Spawn child process using same binary
      const binPath = process.argv[1];
      const child = spawn(process.execPath, [binPath, ...cliArgs], {
        cwd: childCwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      // Track progress
      let toolUseCount = 0;
      const tokenUsage = { input: 0, output: 0 };
      let currentActivity: string | undefined;
      let textOutput = "";

      // Handle abort signal
      const abortHandler = () => {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 3000);
      };
      context.signal.addEventListener("abort", abortHandler, { once: true });

      return new Promise((resolve) => {
        // Read NDJSON from stdout
        const rl = createInterface({ input: child.stdout! });
        rl.on("line", (line) => {
          try {
            const event = JSON.parse(line);
            const type = event.type as string;
            switch (type) {
              case "text_delta":
                // Cap accumulation to ~2x the truncation limit (keeps tail for truncateTail)
                if (textOutput.length < SUB_AGENT_MAX_OUTPUT_CHARS * 2) {
                  textOutput += event.text;
                } else if (!textOutput.endsWith("[output capped]")) {
                  textOutput += "\n[output capped]";
                }
                break;
              case "tool_call_start":
                toolUseCount++;
                currentActivity = `${event.name}: ${truncateStr(JSON.stringify(event.args), 60)}`;
                context.onUpdate?.({
                  toolUseCount,
                  tokenUsage: { ...tokenUsage },
                  currentActivity,
                });
                break;
              case "tool_call_end":
                break;
              case "turn_end": {
                const usage = event.usage as
                  | { inputTokens: number; outputTokens: number }
                  | undefined;
                if (usage) {
                  tokenUsage.input += usage.inputTokens;
                  tokenUsage.output += usage.outputTokens;
                }
                context.onUpdate?.({
                  toolUseCount,
                  tokenUsage: { ...tokenUsage },
                  currentActivity,
                });
                break;
              }
            }
          } catch {
            // Skip malformed lines
          }
        });

        // Collect stderr (capped to prevent unbounded memory growth)
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length < SUB_AGENT_MAX_STDERR_CHARS) {
            stderr += chunk.toString();
            if (stderr.length > SUB_AGENT_MAX_STDERR_CHARS) {
              stderr = stderr.slice(0, SUB_AGENT_MAX_STDERR_CHARS);
            }
          }
        });

        child.on("close", async (code) => {
          rl.close();
          context.signal.removeEventListener("abort", abortHandler);
          const durationMs = Date.now() - startTime;
          const details: SubAgentDetails = {
            toolUseCount,
            tokenUsage: { ...tokenUsage },
            durationMs,
          };

          // Worktree cleanup
          let worktreeNote = "";
          if (worktreeInfo) {
            try {
              const dirty = await isWorktreeDirty(worktreeInfo.path);
              if (!dirty) {
                const hookHandled =
                  (await hookRunner?.runWorktreeRemoveHook(worktreeInfo.path)) ?? false;
                if (!hookHandled) {
                  await removeWorktree({
                    repoRoot: worktreeInfo.repoRoot,
                    worktreePath: worktreeInfo.path,
                    branchName: `worktree-${worktreeInfo.name}`,
                  });
                }
              } else {
                worktreeNote = `\n[Worktree preserved: branch worktree-${worktreeInfo.name} at ${worktreeInfo.path}]`;
              }
            } catch {
              // Best-effort cleanup — don't fail the result
            }
          }

          if (code !== 0 && !textOutput) {
            resolve({
              content:
                worktreeWarning +
                `Sub-agent failed (exit ${code}): ${stderr.trim() || "unknown error"}` +
                worktreeNote,
              details,
            });
            return;
          }

          // Truncate output to prevent blowing up parent's context
          const raw = textOutput || "(no output)";
          const result = truncateTail(raw, SUB_AGENT_MAX_OUTPUT_LINES, SUB_AGENT_MAX_OUTPUT_CHARS);
          const content =
            worktreeWarning +
            (result.truncated
              ? `[Sub-agent output truncated: ${result.totalLines} total lines, showing last ${result.keptLines}]\n\n` +
                result.content
              : result.content) +
            worktreeNote;

          resolve({ content, details });
        });

        child.on("error", (err) => {
          rl.close();
          context.signal.removeEventListener("abort", abortHandler);
          resolve({
            content: `Failed to spawn sub-agent: ${err.message}`,
          });
        });
      });
    },
  };
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
