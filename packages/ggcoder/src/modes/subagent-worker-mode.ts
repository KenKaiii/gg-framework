import { createInterface } from "node:readline";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../core/agent-session.js";
import { isModelUnavailableError } from "../core/model-unavailable.js";
import {
  boundSubAgentOutput,
  promptSubAgent,
  SUB_AGENT_MAX_TURN_EXTENSIONS,
  SUB_AGENT_TIMEOUT_MS,
  SUB_AGENT_TIMEOUT_RECOVERY_MS,
  subAgentThinkingLevel,
} from "../tools/subagent-shared.js";
import { writeTurnRecord } from "../core/subagent-turn-record.js";
import { ReceiptRecorder } from "../core/subagent-receipt.js";
import {
  formatCheckResults,
  parseAcceptanceChecks,
  summarizeCheckResults,
  verifyAcceptanceChecks,
  type AcceptanceCheck,
} from "../core/acceptance-checks.js";

const TIMEOUT_RECOVERY_PROMPT = `Your execution time limit was reached and the active operation was stopped.
You have one final 60-second recovery turn. Do not call any tools. Immediately return the best concise answer you can from the evidence already in this conversation, in the format your task asked for. Clearly state what remains incomplete or unverified.`;

/**
 * One bounded, tool-free chance to turn the durable transcript into a useful
 * result. Effort is capped: at max effort a model can still be thinking when
 * the 60 seconds run out, and the whole run then comes back with nothing.
 */
export async function recoverTimedOutTurn(
  activeSession: Pick<AgentSession, "prompt" | "setSignal">,
  currentOutput: () => string,
  setController: (controller: AbortController) => void,
): Promise<boolean> {
  const recoveryOutputStart = currentOutput().length;
  const recoveryController = new AbortController();
  setController(recoveryController);
  activeSession.setSignal(recoveryController.signal);
  const recoveryTimer = setTimeout(() => recoveryController.abort(), SUB_AGENT_TIMEOUT_RECOVERY_MS);
  try {
    await activeSession.prompt(
      TIMEOUT_RECOVERY_PROMPT,
      { source: "runtime", kind: "completion_gate", visibility: "hidden" },
      { disableTools: true, capThinking: true },
    );
    return (
      !recoveryController.signal.aborted &&
      currentOutput().slice(recoveryOutputStart).trim().length > 0
    );
  } catch {
    return false;
  } finally {
    clearTimeout(recoveryTimer);
  }
}

export type AbortReason = "timeout" | "interrupt" | "shutdown" | "stdin_closed";

/**
 * A turn's time limit. The spawner may shorten the default (the independent
 * reviewer does) but never extend it; anything unusable falls back to it.
 */
export function resolveTurnTimeLimit(requested: unknown): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, SUB_AGENT_TIMEOUT_MS)
    : SUB_AGENT_TIMEOUT_MS;
}

function timeoutError(timeLimitMs: number): string {
  const unit =
    timeLimitMs % 60_000 === 0 ? { ms: 60_000, name: "minute" } : { ms: 1000, name: "second" };
  const count = Math.max(1, Math.round(timeLimitMs / unit.ms));
  return `Timed out after ${count} ${unit.name}${count === 1 ? "" : "s"}; recovery summary failed`;
}

export interface TurnOutcome {
  status: "completed" | "interrupted" | "failed";
  error?: string;
  recovered_after_timeout?: true;
}

/**
 * Settle a turn whose prompt resolved instead of throwing. A timeout or an
 * interrupt explains the stop better than whatever the loop reported on its
 * way out, so they win; after that, `loopError` (the error the loop stopped
 * on — see promptSubAgent) must still fail a turn that otherwise looks done.
 */
export function classifyResolvedTurn(turn: {
  aborted: boolean;
  abortReason: AbortReason | undefined;
  recoveredAfterTimeout: boolean;
  loopError: string | undefined;
  /** The limit the turn ran under, for the timeout message. Defaults to SUB_AGENT_TIMEOUT_MS. */
  timeLimitMs?: number;
}): TurnOutcome {
  if (turn.recoveredAfterTimeout) return { status: "completed", recovered_after_timeout: true };
  if (turn.abortReason === "timeout") {
    return { status: "failed", error: timeoutError(turn.timeLimitMs ?? SUB_AGENT_TIMEOUT_MS) };
  }
  if (turn.aborted || turn.abortReason !== undefined) {
    return { status: "interrupted", error: "Interrupted" };
  }
  if (turn.loopError !== undefined) return { status: "failed", error: turn.loopError };
  return { status: "completed" };
}

export interface SubagentWorkerInitialize {
  provider: Provider;
  model: string;
  fallbackModel?: string;
  cwd: string;
  baseUrl?: string;
  /** Replaces the whole system prompt. */
  systemPrompt?: string;
  /** Agent body composed with the standard prompt scaffolding — the delegation path. */
  agentPrompt?: string;
  /** Whether the composed prompt includes project instruction files. */
  agentContext?: "project" | "none";
  thinkingLevel?: ThinkingLevel;
  /** Original selection before a pinned child model's ceiling was applied. */
  parentThinkingLevel?: ThinkingLevel;
  allowedTools?: string[];
  /** MCP servers this agent may connect, derived from its `tools:` frontmatter. */
  allowedMcpServers?: string[];
  promptCacheKey?: string;
  sessionRootDir: string;
  childSessionPath?: string;
  /**
   * Per-turn time limit, shorter than SUB_AGENT_TIMEOUT_MS. Reaching it ends
   * the turn the same way the default limit does: one tool-free recovery turn
   * that answers from what the child has gathered.
   */
  turnTimeoutMs?: number;
}

type WorkerCommand =
  | { request_id: string; command: "initialize"; options: SubagentWorkerInitialize }
  | { request_id: string; command: "start"; task: string; checks?: unknown }
  | { request_id: string; command: "queue_message"; message: string }
  | { request_id: string; command: "followup"; task: string; checks?: unknown }
  | { request_id: string; command: "interrupt" }
  | { request_id: string; command: "shutdown" };

type WorkerState = "uninitialized" | "idle" | "running" | "interrupted" | "closed";

/** Set once our stdout pipe dies (parent restart). See runSubagentWorkerMode. */
let orphaned = false;

function emit(frame: Record<string, unknown>): void {
  if (orphaned) return;
  try {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  } catch {
    // A racing pipe teardown between the guard and the write — the error
    // handler below flips `orphaned` for subsequent frames.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSubagentWorkerMode(): Promise<void> {
  // Detached child outliving its parent: a parent restart kills our stdout
  // pipe, and the first write after that would crash us mid-turn (EPIPE).
  // Swallow it, stop emitting, and keep running — the durable session
  // transcript plus the turn record written beside it are what the
  // rehydrated parent adopts.
  const pipeError = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      orphaned = true;
      return;
    }
    throw error;
  };
  process.stdout.on("error", pipeError);
  process.stderr.on("error", pipeError);

  let session: AgentSession | undefined;
  let initializeOptions: SubagentWorkerInitialize | undefined;
  let state: WorkerState = "uninitialized";
  let controller = new AbortController();
  let activeTurn: Promise<void> | undefined;
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  let abortReason: AbortReason | undefined;
  let output = "";
  let recoveryOutput = "";
  let recoveringAfterTimeout = false;
  let producedToolCall = false;
  // Engine-side record of this turn's tool calls → the turn's receipt.
  const receipt = new ReceiptRecorder();
  // The parent's acceptance checks for the current turn, decided at its end.
  let turnChecks: AcceptanceCheck[] = [];
  // This worker's LIFETIME totals — one initialize = one agent_id = one
  // worker lifetime, so the durable turn record carries authoritative
  // cumulative numbers an adopting parent can trust.
  let turnCount = 0;
  const tokenUsage = { input: 0, output: 0 };

  const setState = (next: WorkerState, extra: Record<string, unknown> = {}) => {
    state = next;
    emit({ type: "state", state: next, ...extra });
  };

  const wireEvents = (activeSession: AgentSession) => {
    const forwarded = [
      "thinking_delta",
      "tool_call_start",
      "tool_call_update",
      "tool_call_end",
      "turn_end",
      "max_turns",
      "turn_budget_extended",
      "truncated",
      "server_tool_call",
      "server_tool_result",
    ] as const;
    activeSession.eventBus.on("text_delta", (payload) => {
      if (recoveringAfterTimeout) {
        if (recoveryOutput.length < 200_000) recoveryOutput += payload.text;
      } else if (output.length < 200_000) {
        output += payload.text;
      }
      emit({ type: "event", event: "text_delta", payload });
    });
    for (const event of forwarded) {
      activeSession.eventBus.on(event, (payload) => {
        if (event === "tool_call_start") {
          producedToolCall = true;
          const start = payload as { toolCallId?: unknown; name?: unknown; args?: unknown };
          receipt.start(start.toolCallId, start.name, start.args);
        } else if (event === "tool_call_end") {
          const end = payload as { toolCallId?: unknown; result?: unknown; isError?: unknown };
          receipt.end(end.toolCallId, end.result, end.isError);
        }
        if (event === "turn_end") {
          turnCount++;
          const usage = (payload as { usage?: { inputTokens?: number; outputTokens?: number } })
            .usage;
          tokenUsage.input += usage?.inputTokens ?? 0;
          tokenUsage.output += usage?.outputTokens ?? 0;
        }
        emit({ type: "event", event, payload });
      });
    }
  };

  const createSession = async (options: SubagentWorkerInitialize): Promise<AgentSession> => {
    const {
      fallbackModel: _fallbackModel,
      childSessionPath,
      turnTimeoutMs: _turnTimeoutMs,
      ...sessionOptions
    } = options;
    const next = new AgentSession({
      ...sessionOptions,
      maxTurns: 50,
      maxTurnExtensions: SUB_AGENT_MAX_TURN_EXTENSIONS,
      transient: false,
      sessionRootDir: options.sessionRootDir,
      sessionId: childSessionPath,
      signal: controller.signal,
      subagentWorker: true,
    });
    wireEvents(next);
    await next.initialize();
    return next;
  };

  const runTurn = (task: string, checks: AcceptanceCheck[]) => {
    if (!session || !initializeOptions) throw new Error("Worker is not initialized");
    // The turn keeps its own handles: the async body below outlives this
    // narrowing, and a model fallback swaps both mid-turn.
    let turnSession: AgentSession = session;
    const turnOptions: SubagentWorkerInitialize = initializeOptions;
    if (state === "running") throw new Error("Worker already has an active turn");
    output = "";
    recoveryOutput = "";
    recoveringAfterTimeout = false;
    producedToolCall = false;
    receipt.reset();
    turnChecks = checks;
    abortReason = undefined;
    controller = new AbortController();
    session.setSignal(controller.signal);
    setState("running");
    const timeLimitMs = resolveTurnTimeLimit(initializeOptions?.turnTimeoutMs);
    turnTimer = setTimeout(() => {
      abortReason = "timeout";
      controller.abort();
    }, timeLimitMs);
    activeTurn = (async () => {
      let loopError: Error | undefined;
      try {
        loopError = await promptSubAgent(turnSession, task);
      } catch (error) {
        const message = errorMessage(error);
        const fallbackModel = initializeOptions?.fallbackModel;
        if (abortReason === "timeout") {
          // The timed-out turn remains in the durable child transcript. Continue
          // below with one bounded summary turn using that same context.
        } else if (
          fallbackModel &&
          !controller.signal.aborted &&
          !output &&
          !producedToolCall &&
          isModelUnavailableError(message)
        ) {
          await turnSession.dispose();
          initializeOptions = {
            ...turnOptions,
            model: fallbackModel,
            fallbackModel: undefined,
            thinkingLevel: subAgentThinkingLevel(
              turnOptions.provider,
              fallbackModel,
              turnOptions.parentThinkingLevel,
            ),
          };
          turnSession = await createSession(initializeOptions);
          session = turnSession;
          loopError = await promptSubAgent(turnSession, task);
        } else {
          throw error;
        }
      }
      clearTimeout(turnTimer);

      let recoveredAfterTimeout = false;
      if (abortReason === "timeout") {
        recoveringAfterTimeout = true;
        try {
          recoveredAfterTimeout = await recoverTimedOutTurn(
            turnSession,
            () => recoveryOutput,
            (recoveryController) => {
              controller = recoveryController;
            },
          );
        } finally {
          recoveringAfterTimeout = false;
        }
        if (recoveryOutput.trim()) {
          output += `\n\n[Timeout recovery summary]\n${recoveryOutput}`;
        }
      }

      const outcome = classifyResolvedTurn({
        aborted: controller.signal.aborted,
        abortReason,
        recoveredAfterTimeout,
        loopError: loopError?.message,
        timeLimitMs,
      });
      setState(outcome.status === "interrupted" ? "interrupted" : "idle");
      await completeTurn({
        ...outcome,
        output: boundSubAgentOutput(output),
        model: initializeOptions?.model,
      });
    })()
      .catch(async (error: unknown) => {
        clearTimeout(turnTimer);
        const interrupted = controller.signal.aborted;
        const timedOut = abortReason === "timeout";
        setState(interrupted && !timedOut ? "interrupted" : "idle");
        await completeTurn({
          status: timedOut ? "failed" : interrupted ? "interrupted" : "failed",
          output: boundSubAgentOutput(output),
          error: timedOut
            ? timeoutError(timeLimitMs)
            : interrupted
              ? "Interrupted"
              : errorMessage(error),
          model: initializeOptions?.model,
        });
      })
      .finally(() => {
        activeTurn = undefined;
      });
  };

  /** Durably record the turn, then announce it. Record FIRST: an adopting
   * parent must never observe a terminal frame with no record behind it.
   * Awaited inside the turn, so anything that waits for the turn (shutdown,
   * stdin closing) also waits for the record. */
  const completeTurn = async (turn: Record<string, unknown>): Promise<void> => {
    const cwd = initializeOptions?.cwd ?? process.cwd();
    const checkResults = verifyAcceptanceChecks(turnChecks, receipt.snapshot(), cwd);
    const checksBlock = formatCheckResults(checkResults);
    const receiptText = receipt.render(typeof turn.output === "string" ? turn.output : "", cwd);
    const frame: Record<string, unknown> = {
      ...turn,
      receipt: checksBlock ? `${receiptText}\n${checksBlock}` : receiptText,
      ...(checkResults.length > 0 && { acceptance: summarizeCheckResults(checkResults) }),
    };
    await writeTurnRecord(initializeOptions?.childSessionPath, {
      status: (frame.status as "completed" | "interrupted" | "failed") ?? "failed",
      output: typeof frame.output === "string" ? frame.output : undefined,
      receipt: frame.receipt as string,
      error: typeof frame.error === "string" ? frame.error : undefined,
      model: typeof frame.model === "string" ? frame.model : undefined,
      turn_count: turnCount,
      token_usage: { input: tokenUsage.input, output: tokenUsage.output },
      completed_at: Date.now(),
    });
    emit({ type: "turn_complete", ...frame });
  };

  const acknowledge = (requestId: string, result: Record<string, unknown> = {}) =>
    emit({ type: "ack", request_id: requestId, ok: true, ...result });
  const reject = (requestId: string, error: unknown) =>
    emit({ type: "ack", request_id: requestId, ok: false, error: errorMessage(error) });

  const handle = async (command: WorkerCommand): Promise<void> => {
    try {
      switch (command.command) {
        case "initialize": {
          if (session) throw new Error("Worker is already initialized");
          initializeOptions = command.options;
          session = await createSession(initializeOptions);
          setState("idle");
          const state = session.getState();
          initializeOptions = { ...initializeOptions, childSessionPath: state.sessionPath };
          acknowledge(command.request_id, {
            child_session_id: state.sessionId,
            child_session_path: state.sessionPath,
            model: initializeOptions.model,
          });
          return;
        }
        case "start":
        case "followup":
          if (!session) throw new Error("Worker is not initialized");
          if (state === "running") throw new Error("Worker already has an active turn");
          acknowledge(command.request_id, { status: "running" });
          runTurn(command.task, parseAcceptanceChecks(command.checks));
          return;
        case "queue_message": {
          if (!session || state !== "running") throw new Error("Worker is not running");
          const queued = session.queueMessage(command.message);
          acknowledge(command.request_id, { queued });
          return;
        }
        case "interrupt":
          if (!session || state !== "running") throw new Error("Worker is not running");
          abortReason = "interrupt";
          controller.abort();
          acknowledge(command.request_id);
          return;
        case "shutdown":
          abortReason = "shutdown";
          controller.abort();
          await activeTurn?.catch(() => undefined);
          await session?.dispose();
          setState("closed");
          acknowledge(command.request_id);
          process.exitCode = 0;
          return;
      }
    } catch (error) {
      reject(command.request_id, error);
    }
  };

  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    let command: WorkerCommand;
    try {
      command = JSON.parse(line) as WorkerCommand;
      if (!command.request_id || !command.command) throw new Error("Invalid command frame");
    } catch (error) {
      emit({ type: "protocol_error", error: errorMessage(error) });
      return;
    }
    void handle(command);
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  if (activeTurn) {
    // Stdin closed mid-turn: the parent is gone. Finish the turn so its
    // result lands in the durable turn record (the rehydrated parent adopts
    // it); emit() is a no-op by then. The turn's own time limit still
    // bounds it — the process cannot linger past that.
    orphaned = true;
    await activeTurn.catch(() => undefined);
  } else {
    abortReason = "stdin_closed";
    controller.abort();
  }
  await session?.dispose();
}
