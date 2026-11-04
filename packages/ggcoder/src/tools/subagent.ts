import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { AgentTool } from "@kleio/agent";
import type { Provider, ThinkingLevel } from "@kleio/ai";
import { mcpServersForAgent, type AgentDefinition } from "../core/agents.js";
import { log } from "../core/logger.js";
import { isModelUnavailableError } from "../core/model-unavailable.js";
import { ReceiptRecorder } from "../core/subagent-receipt.js";
import {
  AcceptanceChecksParam,
  formatCheckResults,
  verifyAcceptanceChecks,
} from "../core/acceptance-checks.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import {
  boundSubAgentOutput,
  childSubAgentEnv,
  currentSubAgentDepth,
  MAX_BLOCKING_SUBAGENT_DEPTH,
  renderAgentRoster,
  resolveSubAgentCliEntry,
  selectSubAgent,
  subAgentCacheKey,
  subAgentThinkingLevel,
  type SubAgentTokenUsage,
  SUB_AGENT_MAX_OUTPUT_CHARS,
  SUB_AGENT_MAX_STDERR_CHARS,
  SUB_AGENT_MAX_TURNS,
  SUB_AGENT_TIMEOUT_MS,
} from "./subagent-shared.js";
import { editTargetLabel } from "./edit-targets.js";

const SubAgentParams = z.object({
  task: z.string(),
  agent: z.string().optional().describe("Named agent"),
  checks: AcceptanceChecksParam,
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

const SUBAGENT_DESCRIPTION =
  "Run an isolated sub-agent on a focused task and wait for its answer. It sees none of this conversation, so the task must stand alone.";

/**
 * The `subagent` tool description. When `spawn_agent` is also active it
 * already carries the full roster, so repeating it here only adds ~1k chars
 * to every request; point at it instead.
 */
export function subAgentDescription(
  agents: readonly AgentDefinition[],
  rosterOnSpawnAgent: boolean,
): string {
  if (rosterOnSpawnAgent && agents.length > 0) {
    return `${SUBAGENT_DESCRIPTION} Named agents: see \`spawn_agent\`.`;
  }
  return SUBAGENT_DESCRIPTION + renderAgentRoster(agents);
}

export function createSubAgentTool(
  cwd: string,
  agents: AgentDefinition[],
  getParentProvider: () => string,
  getParentModel: () => string,
  getParentCacheKey?: () => string | undefined,
  planModeRef?: { current: boolean },
  getParentThinkingLevel?: () => ThinkingLevel | undefined,
): AgentTool<typeof SubAgentParams> {
  return {
    name: "subagent",
    description: subAgentDescription(agents, false),
    parameters: SubAgentParams,
    // Sub-agents are isolated child processes (own cwd, context, and PID), so
    // they're safe to run concurrently — unlike bash/edit/write, which mutate
    // shared local state. Parallel lets the model fan out 3+ sub-agents in one
    // turn. NOTE: the loop serializes the WHOLE batch if any call is
    // sequential, so this only fans out when every call in the turn is parallel.
    executionMode: "parallel",
    // This tool enforces its own SUB_AGENT_TIMEOUT_MS budget and reports a
    // specific message when it fires. Give the loop a slightly larger ceiling
    // so the child is stopped and explained here, instead of being cancelled
    // generically by the loop's shorter default before that can happen.
    timeoutMs: SUB_AGENT_TIMEOUT_MS + 30_000,
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
      const parentThinkingLevel = getParentThinkingLevel?.();
      const selection = selectSubAgent(
        agents,
        args.agent,
        useProvider,
        parentModel,
        parentThinkingLevel,
      );
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
        // Re-resolve from the original parent selection on a model retry,
        // rather than carrying the pinned model's ceiling into the fallback.
        const thinkingLevel = subAgentThinkingLevel(useProvider, model, parentThinkingLevel);
        if (thinkingLevel) {
          cliArgs.push("--thinking", thinkingLevel);
        }
        if (agentDef?.systemPrompt) {
          // --agent-prompt, not --system-prompt: the definition body is composed
          // with the Tools/project-context/Environment scaffolding instead of
          // replacing it. A replaced prompt left the child blind to its own
          // toolset and to where it was running.
          cliArgs.push("--agent-prompt", agentDef.systemPrompt);
          if (agentDef.context === "none") {
            cliArgs.push("--agent-context", "none");
          }
        }
        if (agentDef?.tools.length) {
          cliArgs.push("--tools", agentDef.tools.join(","));
          // An allow-listed child connects MCP servers only when they're named
          // here — otherwise a `mcp__<server>__*` entry in the agent's
          // tools list could never resolve and it falls back to training data.
          const mcpServers = mcpServersForAgent(agentDef.tools);
          if (mcpServers.length > 0) {
            cliArgs.push("--mcp-servers", mcpServers.join(","));
          }
        }
        cliArgs.push(args.task);
        return cliArgs;
      };

      // Track progress across both attempts. A pinned-model attempt can only
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
      /** Set when WE killed the child, so `exit null` can name its real cause. */
      let killReason: "timeout" | "aborted" | undefined;

      const killActiveChild = (reason: "timeout" | "aborted") => {
        const child = activeChild;
        if (!child || activeChildExited) return;
        killReason ??= reason;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (activeChild === child && !activeChildExited) child.kill("SIGKILL");
        }, 3000);
      };

      const abortHandler = () => killActiveChild("aborted");
      context.signal.addEventListener("abort", abortHandler, { once: true });

      // Engine-side record of every tool call the child made; rendered as a
      // receipt the child's model cannot write or forge.
      const receipt = new ReceiptRecorder();

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
          const timeout = setTimeout(() => killActiveChild("timeout"), remainingMs);
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
                  receipt.start(event.toolCallId, event.name, event.args);
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
                  receipt.end(event.toolCallId, event.result, event.isError);
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

          child.on("close", (code, signal) => {
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
              log("WARN", "subagent", "Pinned sub-agent model unavailable; retrying parent", {
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
              ...(signal && { signal }),
              ...(killReason && { killReason }),
              model,
            });

            const body = boundSubAgentOutput(textOutput);
            const checksBlock = formatCheckResults(
              verifyAcceptanceChecks(args.checks ?? [], receipt.snapshot(), cwd),
            );
            const receiptBlock = `\n\n${receipt.render(textOutput, cwd)}${checksBlock ? `\n${checksBlock}` : ""}`;
            if (code !== 0) {
              // A provider/process failure can happen AFTER the model has emitted
              // a progress sentence (for example: "I'll read both files now.").
              // Treating any partial text as a successful final answer hid the
              // non-zero exit and handed that sentence to the parent as if the
              // review/task had completed. Preserve the partial output for
              // diagnosis, but make the failure impossible to mistake for a
              // result.
              // `code` is null when the child died from a signal, which is
              // almost always us killing it. Reporting that as "exit null:
              // unknown error" hid the actual cause (a timeout) behind a
              // mystery, so name it explicitly.
              const error =
                stderr.trim() ||
                (killReason === "timeout"
                  ? `sub-agent exceeded its ${Math.round(SUB_AGENT_TIMEOUT_MS / 60000)}-minute time limit and was stopped`
                  : killReason === "aborted"
                    ? "sub-agent was cancelled by the parent (turn aborted or per-tool timeout)"
                    : signal
                      ? `sub-agent terminated by ${signal}`
                      : "unknown error");
              finish({
                // `boundSubAgentOutput("")` intentionally returns
                // "(no output)" for successful empty children. Test the raw
                // stream here so that placeholder is not mislabeled as partial
                // model output on failures.
                // The receipt only rides along when there is something to
                // check: partial output or tool calls the child made.
                content: textOutput
                  ? `Sub-agent failed (exit ${code}): ${error}\n\nPartial output before failure:\n${body}${receiptBlock}`
                  : toolUseCount > 0 || checksBlock
                    ? `Sub-agent failed (exit ${code}): ${error}${receiptBlock}`
                    : `Sub-agent failed (exit ${code}): ${error}`,
                details,
              });
              return;
            }

            const content = hitMaxTurns
              ? `[Sub-agent reached its ${maxTurnsLimit}-turn limit — it stopped mid-task and this output may be incomplete.]\n\n${body}`
              : body;
            finish({ content: `${content}${receiptBlock}`, details });
          });

          child.on("error", (err) => {
            if (activeChild === child) activeChildExited = true;
            clearTimeout(timeout);
            rl.close();
            finish({ content: `Failed to spawn sub-agent: ${err.message}` });
          });

          if (context.signal.aborted) killActiveChild("aborted");
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
      return `Editing ${editTargetLabel(args, shortenPath)}`;
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
