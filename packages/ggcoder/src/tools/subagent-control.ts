import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { SubAgentManager, SubAgentSnapshot } from "../core/subagent-manager.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import { renderAgentRoster } from "./subagent-shared.js";
import { AcceptanceChecksParam } from "../core/acceptance-checks.js";
import { ACTIVE_LIMIT, DEFAULT_WAIT_MS, MAX_WAIT_MS } from "../core/subagent-manager.js";

const AgentId = z.string().min(1).describe("Eight-character agent ID returned by spawn_agent");

function json(value: unknown): { content: string } {
  return { content: JSON.stringify(value) };
}

/**
 * What the parent model sees of a child. The full snapshot (timestamps,
 * session ids, provider, collected flag, token split) is UI/persistence
 * state; resent in every later request it only costs tokens. The
 * transcript path rides once, on the result that carries the output.
 */
function spawnView(s: SubAgentSnapshot) {
  return {
    agent_id: s.agent_id,
    task_name: s.task_name,
    state: s.state,
    ...(s.agent_name && { agent_name: s.agent_name }),
    ...(s.model && { model: s.model }),
    ...(s.cwd && { cwd: s.cwd }),
    ...(s.error && { error: s.error }),
  };
}

function waitView(s: SubAgentSnapshot) {
  return {
    agent_id: s.agent_id,
    task_name: s.task_name,
    state: s.state,
    turn_count: s.turn_count,
    tool_use_count: s.tool_use_count,
    ...(s.current_activity && { current_activity: s.current_activity }),
    ...(s.output !== undefined && { output: s.output }),
    ...(s.error && { error: s.error }),
    ...(s.acceptance && { acceptance: s.acceptance }),
    ...(s.receipt && { receipt: s.receipt }),
    ...(s.child_session_path && { transcript: s.child_session_path }),
    ...(s.cwd && { cwd: s.cwd }),
    ...(s.recovered && { recovered: true }),
  };
}

function listView(s: SubAgentSnapshot) {
  return {
    agent_id: s.agent_id,
    task_name: s.task_name,
    state: s.state,
    elapsed_ms: s.elapsed_ms,
    turn_count: s.turn_count,
    tool_use_count: s.tool_use_count,
    token_usage: { input: s.token_usage.input, output: s.token_usage.output },
    ...(s.current_activity && { current_activity: s.current_activity }),
    ...(s.agent_name && { agent_name: s.agent_name }),
    ...(s.model && { model: s.model }),
    ...(s.acceptance && { acceptance: s.acceptance }),
  };
}

export function createSubAgentControlTools(
  manager: SubAgentManager,
  planModeRef?: { current: boolean },
): AgentTool[] {
  const blocked = (name: string) =>
    isPlanModeActive(planModeRef) ? planModeRestriction(name) : undefined;

  // Constrain `agent` to the real roster when one exists: a name the model
  // invented then fails schema validation, which it can correct, instead of
  // throwing at spawn time or silently starting a generic child with no agent
  // prompt and the full toolset.
  const agentNames = manager.agents.map((agent) => agent.name);
  const anyAgent = agentNames.length > 0 ? z.enum(agentNames as [string, ...string[]]) : z.string();
  // A fixed team (GG Goals) must pick each worker's role: left out, every task
  // went to the default builder, research without web search included.
  const agentParam =
    manager.defaultAgent && agentNames.length > 0
      ? anyAgent.describe("Which team member does this task: pick the one whose role fits it")
      : anyAgent.optional();
  const taskParams = z.object({
    task_name: z.string().min(1),
    task: z.string().min(1).describe("Standalone brief"),
    agent: agentParam,
    checks: AcceptanceChecksParam,
    cwd: z
      .string()
      .min(1)
      .optional()
      .describe("Absolute folder to work in (a workspace root); default: yours"),
    context_files: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe(
        "Files you already read that it needs: their contents go in its brief, so it doesn't read them again",
      ),
  });
  // A list, so one call starts every child: on models that send one tool call
  // per turn (GPT-6.x), a one-child-per-call shape cost a model turn per child
  // (bench 41: 8 children 66.8s → 31.9s, parent tokens −57%).
  const spawnParams = z.object({
    tasks: z.array(taskParams).min(1).max(ACTIVE_LIMIT),
  });
  const spawnTool: AgentTool<typeof spawnParams> = {
    name: "spawn_agent",
    // Starting children is quick but not undoable: an interrupted call would
    // leave running agents whose ids the model never saw.
    interruptible: false,
    description:
      "Start all child agents in one call; each reports back when done (no polling)." +
      renderAgentRoster(manager.agents),
    parameters: spawnParams,
    executionMode: "parallel",
    async execute(args) {
      const restriction = blocked("spawn_agent");
      if (restriction) return restriction;
      // Each spawn runs its limit and duplicate-name checks and registers its
      // worker before its first await, so starting them together cannot
      // exceed ACTIVE_LIMIT or the per-model cap.
      const settled = await Promise.allSettled(
        args.tasks.map((t) =>
          t.checks || t.cwd || t.context_files
            ? manager.spawn(t.task_name, t.task, t.agent, {
                ...(t.checks && { checks: t.checks }),
                ...(t.cwd && { cwd: t.cwd }),
                ...(t.context_files && { contextFiles: t.context_files }),
              })
            : manager.spawn(t.task_name, t.task, t.agent),
        ),
      );
      const results = settled.map((result, index) =>
        result.status === "fulfilled"
          ? spawnView(result.value)
          : {
              task_name: args.tasks[index]?.task_name,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            },
      );
      // Nothing started: fail the call, as a single failed spawn always has.
      if (settled.every((result) => result.status === "rejected")) {
        throw new Error(`No agent started: ${JSON.stringify(results)}`);
      }
      return json(results);
    },
  };

  const messageParams = z.object({ agent_id: AgentId, message: z.string().min(1) });
  const messageTool: AgentTool<typeof messageParams> = {
    name: "send_message",
    description: "Queue steering into a running child agent without starting another turn.",
    parameters: messageParams,
    async execute(args) {
      const restriction = blocked("send_message");
      if (restriction) return restriction;
      return json({
        agent_id: args.agent_id,
        queued: await manager.sendMessage(args.agent_id, args.message),
      });
    },
  };

  const followupParams = z.object({
    agent_id: AgentId,
    task: z.string().min(1),
    checks: AcceptanceChecksParam,
  });
  const followupTool: AgentTool<typeof followupParams> = {
    name: "followup_task",
    description: "Start another turn in an idle child while preserving that child's context.",
    parameters: followupParams,
    async execute(args) {
      const restriction = blocked("followup_task");
      if (restriction) return restriction;
      return json(spawnView(await manager.followup(args.agent_id, args.task, args.checks)));
    },
  };

  const waitParams = z.object({
    agent_ids: z
      .array(AgentId)
      .optional()
      .describe("Agents to wait for; omitted means active agents"),
    condition: z.enum(["any", "all"]).optional().describe("Default: any"),
    timeout_ms: z
      .number()
      .int()
      .min(0)
      .max(MAX_WAIT_MS)
      .optional()
      .describe(`Default ${DEFAULT_WAIT_MS}; max ${MAX_WAIT_MS}`),
  });
  const waitTool: AgentTool<typeof waitParams> = {
    name: "wait_agent",
    description:
      "Wait for child agents only when you need their output to continue (processes: " +
      "task_output).",
    parameters: waitParams,
    async execute(args) {
      const { timed_out, agents } = await manager.wait(
        args.agent_ids,
        args.condition,
        args.timeout_ms,
      );
      return json({ timed_out, agents: agents.map(waitView) });
    },
  };

  const listParams = z.object({});
  const listTool: AgentTool<typeof listParams> = {
    name: "list_agents",
    description:
      "List child IDs, task names, lifecycle states, activity, turns, tools, and token totals.",
    parameters: listParams,
    async execute() {
      return json(manager.list().map(listView));
    },
  };

  const interruptParams = z.object({ agent_id: AgentId });
  const interruptTool: AgentTool<typeof interruptParams> = {
    name: "interrupt_agent",
    description:
      "Interrupt a child's current turn while retaining its context for a later follow-up.",
    parameters: interruptParams,
    async execute(args) {
      return json(waitView(await manager.interrupt(args.agent_id)));
    },
  };

  return [spawnTool, messageTool, followupTool, waitTool, listTool, interruptTool];
}
