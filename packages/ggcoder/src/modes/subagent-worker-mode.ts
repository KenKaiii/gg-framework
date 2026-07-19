import { createInterface } from "node:readline";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../core/agent-session.js";
import { isModelUnavailableError } from "../tools/subagent.js";
import { boundSubAgentOutput, SUB_AGENT_TIMEOUT_MS } from "../tools/subagent-shared.js";
import { captureSidecarError, flushSidecarErrors } from "../core/sidecar-error-reporter.js";

export interface SubagentWorkerInitialize {
  provider: Provider;
  model: string;
  fallbackModel?: string;
  cwd: string;
  baseUrl?: string;
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  allowedTools?: string[];
  promptCacheKey?: string;
  sessionRootDir: string;
  childSessionPath?: string;
}

type WorkerCommand =
  | { request_id: string; command: "initialize"; options: SubagentWorkerInitialize }
  | { request_id: string; command: "start"; task: string }
  | { request_id: string; command: "queue_message"; message: string }
  | { request_id: string; command: "followup"; task: string }
  | { request_id: string; command: "interrupt" }
  | { request_id: string; command: "shutdown" };

type WorkerState = "uninitialized" | "idle" | "running" | "interrupted" | "closed";

function emit(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSubagentWorkerMode(): Promise<void> {
  let session: AgentSession | undefined;
  let initializeOptions: SubagentWorkerInitialize | undefined;
  let state: WorkerState = "uninitialized";
  let controller = new AbortController();
  let activeTurn: Promise<void> | undefined;
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  let output = "";
  let producedToolCall = false;

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
      "server_tool_call",
      "server_tool_result",
    ] as const;
    activeSession.eventBus.on("text_delta", (payload) => {
      if (output.length < 200_000) output += payload.text;
      emit({ type: "event", event: "text_delta", payload });
    });
    for (const event of forwarded) {
      activeSession.eventBus.on(event, (payload) => {
        if (event === "tool_call_start") producedToolCall = true;
        emit({ type: "event", event, payload });
      });
    }
  };

  const createSession = async (options: SubagentWorkerInitialize): Promise<AgentSession> => {
    const { fallbackModel: _fallbackModel, childSessionPath, ...sessionOptions } = options;
    const next = new AgentSession({
      ...sessionOptions,
      maxTurns: 50,
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

  const runTurn = (task: string) => {
    if (!session) throw new Error("Worker is not initialized");
    if (state === "running") throw new Error("Worker already has an active turn");
    output = "";
    producedToolCall = false;
    controller = new AbortController();
    session.setSignal(controller.signal);
    setState("running");
    turnTimer = setTimeout(() => controller.abort(), SUB_AGENT_TIMEOUT_MS);
    activeTurn = (async () => {
      try {
        await session!.prompt(task);
      } catch (error) {
        const message = errorMessage(error);
        const fallbackModel = initializeOptions?.fallbackModel;
        if (
          fallbackModel &&
          !controller.signal.aborted &&
          !output &&
          !producedToolCall &&
          isModelUnavailableError(message)
        ) {
          await session!.dispose();
          initializeOptions = {
            ...initializeOptions!,
            model: fallbackModel,
            fallbackModel: undefined,
          };
          session = await createSession(initializeOptions);
          await session.prompt(task);
        } else {
          throw error;
        }
      }
      clearTimeout(turnTimer);
      const interrupted = controller.signal.aborted;
      setState(interrupted ? "interrupted" : "idle");
      emit({
        type: "turn_complete",
        status: interrupted ? "interrupted" : "completed",
        output: boundSubAgentOutput(output),
        ...(interrupted ? { error: "Interrupted" } : {}),
        model: initializeOptions?.model,
      });
    })()
      .catch((error: unknown) => {
        clearTimeout(turnTimer);
        const interrupted = controller.signal.aborted;
        if (!interrupted) {
          captureSidecarError(error, "subagent-worker.turn", {
            provider: initializeOptions?.provider ?? "unknown",
            model: initializeOptions?.model ?? "unknown",
          });
        }
        setState(interrupted ? "interrupted" : "idle");
        emit({
          type: "turn_complete",
          status: interrupted ? "interrupted" : "failed",
          output: boundSubAgentOutput(output),
          error: interrupted ? "Interrupted" : errorMessage(error),
          model: initializeOptions?.model,
        });
      })
      .finally(() => {
        activeTurn = undefined;
      });
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
          runTurn(command.task);
          return;
        case "queue_message": {
          if (!session || state !== "running") throw new Error("Worker is not running");
          const queued = session.queueMessage(command.message);
          acknowledge(command.request_id, { queued });
          return;
        }
        case "interrupt":
          if (!session || state !== "running") throw new Error("Worker is not running");
          controller.abort();
          acknowledge(command.request_id);
          return;
        case "shutdown":
          controller.abort();
          await activeTurn?.catch(() => undefined);
          await session?.dispose();
          setState("closed");
          acknowledge(command.request_id);
          process.exitCode = 0;
          return;
      }
    } catch (error) {
      captureSidecarError(error, "subagent-worker.command", { command: command.command });
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
      captureSidecarError(error, "subagent-worker.protocol");
      emit({ type: "protocol_error", error: errorMessage(error) });
      return;
    }
    void handle(command);
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  controller.abort();
  await activeTurn?.catch(() => undefined);
  await session?.dispose();
  await flushSidecarErrors();
}
