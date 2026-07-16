import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { Provider } from "@kenkaiiii/gg-ai";
import type { AgentDefinition } from "../core/agents.js";
import { log } from "../core/logger.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import {
  boundSubAgentOutput,
  childSubAgentEnv,
  currentSubAgentDepth,
  MAX_BLOCKING_SUBAGENT_DEPTH,
  resolveSubAgentCliEntry,
  selectSubAgent,
  subAgentCacheKey,
  type SubAgentTokenUsage,
  SUB_AGENT_MAX_OUTPUT_CHARS,
  SUB_AGENT_MAX_STDERR_CHARS,
  SUB_AGENT_MAX_TURNS,
  SUB_AGENT_TIMEOUT_MS,
} from "./subagent-shared.js";

/** Only retry errors that specifically mean the selected model cannot be used. */
export function isModelUnavailableError(stderr: string): boolean {
  return /does not recognize the requested model|requested model[^\n]*(?:not available|no access)|model[^\n]*(?:does not exist|not found|not available)/i.test(
    stderr,
  );
}

const SubAgentParams = z.object({
  task: z.string().describe("The task to delegate to the sub-agent"),
  agent: z
    .string()
    .optional()
    .describe("Named agent definition to use (from ~/.gg/agents/ or .gg/agents/)"),
});

export interface SubAgentUpdate {
  toolUseCount: number;
  tokenUsage: SubAgentTokenUsage;
  currentActivity?: string;
}

export interface SubAgentDetails {
  toolUseCount: number;
  tokenUsage: SubAgentTokenUsage;
  durationMs: number;
}

export function createSubAgentTool(
  cwd: string,
  agents: AgentDefinition[],
  getParentProvider: () => string,
  getParentModel: () => string,
  getParentCacheKey?: () => string | undefined,
  planModeRef?: { current: boolean },
): AgentTool<typeof SubAgentParams> {
  const agentList = agents.map((a) => `- ${a.name}: ${a.description}`).join("\n");
  const agentDesc = agentList
    ? `\n\nAvailable named agents:\n${agentList}`
    : "\n\nNo named agents configured.";

  return {
    name: "subagent",
    description:
      `Spawn an isolated sub-agent to handle a focused task. The sub-agent runs as a separate process with its own context window, tools, and system prompt. Use this for tasks that benefit from an isolated context.` +
      agentDesc,
    parameters: SubAgentParams,
    // Sub-agents are isolated child processes (own cwd, context, and PID), so
    // they're safe to run concurrently — unlike bash/edit/write, which mutate
    // shared local state. Parallel lets the model fan out 3+ sub-agents in one
    // turn. NOTE: the loop serializes the WHOLE batch if any call is
    // sequential, so this only fans out when every call in the turn is parallel.
    executionMode: "parallel",
    async execute(args, context) {
      if (isPlanModeActive(planModeRef)) {
        return planModeRestriction("subagent");
      }

      if (currentSubAgentDepth() >= MAX_BLOCKING_SUBAGENT_DEPTH) {
        return {
          content: `Sub-agent nesting limit reached (${MAX_BLOCKING_SUBAGENT_DEPTH}). Complete this task in the current agent.`,
        };
      }

      const startTime = Date.now();
      const useProvider = getParentProvider() as Provider;
      const parentModel = getParentModel();
      const selection = selectSubAgent(agents, args.agent, useProvider, parentModel);
      const agentDef = selection.agentDef;
      if (args.agent && !agentDef) {
        return {
          content: `Unknown agent: "${args.agent}". Available agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
        };
      }
      const useModel = selection.model;
      const parentCacheKey = getParentCacheKey?.();
      const childCacheKey = subAgentCacheKey(parentCacheKey, useModel, agentDef?.name ?? "default");
      const subCacheKey = childCacheKey ?? "(unset)";

      const buildCliArgs = (model: string): string[] => {
        const cliArgs: string[] = [
          "--json",
          "--provider",
          useProvider,
          "--model",
          model,
          "--max-turns",
          String(SUB_AGENT_MAX_TURNS),
        ];

        if (childCacheKey) {
          cliArgs.push("--prompt-cache-key", childCacheKey);
        }
        if (agentDef?.systemPrompt) {
          cliArgs.push("--system-prompt", agentDef.systemPrompt);
        }
        if (agentDef?.tools.length) {
          cliArgs.push("--tools", agentDef.tools.join(","));
        }
        cliArgs.push(args.task);
        return cliArgs;
      };

      // Track progress across both attempts. The cheap-model attempt can only
      // fall back before producing output or using a tool, so these totals remain
      // an accurate picture of the actual agent run.
      let toolUseCount = 0;
      const tokenUsage: SubAgentTokenUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      let turnCount = 0;
      let currentActivity: string | undefined;
      let textOutput = "";
      let hitMaxTurns = false;
      let maxTurnsLimit = 0;
      let activeChild: ReturnType<typeof spawn> | undefined;
      let activeChildExited = true;

      const killActiveChild = () => {
        const child = activeChild;
        if (!child || activeChildExited) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (activeChild === child && !activeChildExited) child.kill("SIGKILL");
        }, 3000);
      };

      const abortHandler = () => killActiveChild();
      context.signal.addEventListener("abort", abortHandler, { once: true });

      return new Promise((resolve) => {
        const finish = (result: { content: string; details?: SubAgentDetails }) => {
          context.signal.removeEventListener("abort", abortHandler);
          resolve(result);
        };

        const startAttempt = (model: string, fallbackFrom?: string) => {
          // Spawn the CLI entry, not process.argv[1]: the desktop host is the
          // app sidecar and does not understand JSON-mode agent arguments.
          const child = spawn(
            process.execPath,
            [resolveSubAgentCliEntry(), ...buildCliArgs(model)],
            {
              cwd,
              stdio: ["ignore", "pipe", "pipe"],
              env: childSubAgentEnv(),
            },
          );
          activeChild = child;
          activeChildExited = false;

          log("INFO", "subagent", "Sub-agent spawn", {
            cacheKey: subCacheKey,
            provider: useProvider,
            model,
            agent: agentDef?.name ?? "(default)",
            ...(fallbackFrom && { fallbackFrom }),
          });

          // Both attempts share the original hard timeout; a retry never doubles
          // the maximum runtime of one sub-agent call.
          const remainingMs = Math.max(1, SUB_AGENT_TIMEOUT_MS - (Date.now() - startTime));
          const timeout = setTimeout(killActiveChild, remainingMs);
          const rl = createInterface({ input: child.stdout! });
          rl.on("line", (line) => {
            try {
              const event = JSON.parse(line);
              const type = event.type as string;
              switch (type) {
                case "text_delta":
                  if (textOutput.length < SUB_AGENT_MAX_OUTPUT_CHARS * 2) {
                    textOutput += event.text;
                  } else if (!textOutput.endsWith("[output capped]")) {
                    textOutput += "\n[output capped]";
                  }
                  break;
                case "tool_call_start":
                  toolUseCount++;
                  currentActivity = formatToolActivity(
                    event.name as string,
                    event.args as Record<string, unknown>,
                  );
                  context.onUpdate?.({
                    toolUseCount,
                    tokenUsage: { ...tokenUsage },
                    currentActivity,
                  });
                  break;
                case "tool_call_end":
                  break;
                case "max_turns":
                  hitMaxTurns = true;
                  maxTurnsLimit = Number(event.maxTurns) || SUB_AGENT_MAX_TURNS;
                  break;
                case "turn_end": {
                  const usage = event.usage as
                    | {
                        inputTokens: number;
                        outputTokens: number;
                        cacheRead?: number;
                        cacheWrite?: number;
                      }
                    | undefined;
                  if (usage) {
                    tokenUsage.input += usage.inputTokens;
                    tokenUsage.output += usage.outputTokens;
                    tokenUsage.cacheRead = (tokenUsage.cacheRead ?? 0) + (usage.cacheRead ?? 0);
                    tokenUsage.cacheWrite = (tokenUsage.cacheWrite ?? 0) + (usage.cacheWrite ?? 0);
                    turnCount++;
                    log("INFO", "subagent", "Sub-agent turn", {
                      turn: turnCount,
                      inputTokens: String(usage.inputTokens),
                      outputTokens: String(usage.outputTokens),
                      ...(usage.cacheRead != null && { cacheRead: String(usage.cacheRead) }),
                      ...(usage.cacheWrite != null && { cacheWrite: String(usage.cacheWrite) }),
                    });
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
              // Skip malformed lines.
            }
          });

          let stderr = "";
          child.stderr?.on("data", (chunk: Buffer) => {
            if (stderr.length >= SUB_AGENT_MAX_STDERR_CHARS) return;
            stderr = (stderr + chunk.toString()).slice(0, SUB_AGENT_MAX_STDERR_CHARS);
          });

          child.on("close", (code) => {
            if (activeChild === child) activeChildExited = true;
            clearTimeout(timeout);
            rl.close();

            const canFallback =
              model !== parentModel &&
              code !== 0 &&
              !textOutput &&
              turnCount === 0 &&
              toolUseCount === 0 &&
              !context.signal.aborted &&
              isModelUnavailableError(stderr);
            if (canFallback) {
              log("WARN", "subagent", "Cheap sub-agent model unavailable; retrying parent", {
                provider: useProvider,
                model,
                fallbackModel: parentModel,
              });
              startAttempt(parentModel, model);
              return;
            }

            const durationMs = Date.now() - startTime;
            const details: SubAgentDetails = {
              toolUseCount,
              tokenUsage: { ...tokenUsage },
              durationMs,
            };
            log("INFO", "subagent", "Sub-agent done", {
              durationMs: String(durationMs),
              turns: String(turnCount),
              toolUseCount: String(toolUseCount),
              inputTokens: String(tokenUsage.input),
              outputTokens: String(tokenUsage.output),
              cacheRead: String(tokenUsage.cacheRead ?? 0),
              cacheWrite: String(tokenUsage.cacheWrite ?? 0),
              exitCode: String(code),
              model,
            });

            if (code !== 0 && !textOutput) {
              finish({
                content: `Sub-agent failed (exit ${code}): ${stderr.trim() || "unknown error"}`,
                details,
              });
              return;
            }

            const body = boundSubAgentOutput(textOutput);
            const content = hitMaxTurns
              ? `[Sub-agent reached its ${maxTurnsLimit}-turn limit — it stopped mid-task and this output may be incomplete.]\n\n${body}`
              : body;
            finish({ content, details });
          });

          child.on("error", (err) => {
            if (activeChild === child) activeChildExited = true;
            clearTimeout(timeout);
            rl.close();
            finish({ content: `Failed to spawn sub-agent: ${err.message}` });
          });

          if (context.signal.aborted) killActiveChild();
        };

        startAttempt(useModel);
      });
    },
  };
}

/** Build a short, human-readable activity string for a sub-agent tool call. */
function formatToolActivity(name: string, args: Record<string, unknown>): string {
  // Extract the most meaningful short value for common tools
  switch (name) {
    case "read":
      return `Reading ${shortenPath(String(args.file_path ?? ""))}`;
    case "write":
      return `Writing ${shortenPath(String(args.file_path ?? ""))}`;
    case "edit":
      return `Editing ${shortenPath(String(args.file_path ?? ""))}`;
    case "grep": {
      const pat = String(args.pattern ?? "");
      return `Searching for "${truncateStr(pat, 30)}"`;
    }
    case "find": {
      const pat = String(args.pattern ?? "");
      return `Finding "${truncateStr(pat, 30)}"`;
    }
    case "ls":
      return `Listing ${shortenPath(String(args.path ?? "."))}`;
    case "bash": {
      const cmd = String(args.command ?? "").split("\n")[0];
      return `Running ${truncateStr(cmd, 35)}`;
    }
    case "web_fetch":
      return `Fetching ${truncateStr(String(args.url ?? ""), 35)}`;
    case "source_path":
      return `Resolving source for ${truncateStr(String(args.package ?? ""), 30)}`;
    case "task_output":
      return `Reading task output ${truncateStr(String(args.id ?? ""), 20)}`;
    case "task_stop":
      return `Stopping task ${truncateStr(String(args.id ?? ""), 20)}`;
    case "web_search":
      return `Searching web for ${truncateStr(String(args.query ?? ""), 30)}`;
    case "skill":
      return `Loading skill ${truncateStr(String(args.skill ?? ""), 30)}`;
    default: {
      // MCP or unknown tools — show name + first short arg value
      const firstVal = Object.values(args).find((v) => typeof v === "string" && v.length > 0);
      const detail = firstVal ? truncateStr(String(firstVal), 30) : "";
      return detail ? `${name}: ${detail}` : name;
    }
  }
}

function shortenPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return "…/" + parts.slice(-2).join("/");
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
