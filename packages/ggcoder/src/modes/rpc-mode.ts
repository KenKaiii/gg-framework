import readline from "node:readline";
import type { Provider, ThinkingLevel } from "@kleio/ai";
import { AgentSession, PaidModelConfirmationError } from "../core/agent-session.js";
import { isAbortError } from "@kleio/agent";
import { formatUserError } from "../utils/error-handler.js";
import { closeLogger } from "../core/logger.js";

export interface RpcModeOptions {
  provider: Provider;
  model: string;
  cwd: string;
  baseUrl?: string;
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
}

// ── RPC Command Types ──────────────────────────────────────

interface RpcPromptCommand {
  id: string;
  command: "prompt";
  text: string;
}

interface RpcCompactCommand {
  id: string;
  command: "compact";
}

interface RpcNewSessionCommand {
  id: string;
  command: "new_session";
}

interface RpcSwitchModelCommand {
  id: string;
  command: "switch_model";
  provider: string;
  model: string;
  /** Required for a model that spends real money (Claude fast mode). */
  confirm_paid?: boolean;
}

interface RpcBranchCommand {
  id: string;
  command: "branch";
  steps_back?: number;
}

interface RpcGetStateCommand {
  id: string;
  command: "get_state";
}

interface RpcAbortCommand {
  id: string;
  command: "abort";
}

type RpcCommand =
  | RpcPromptCommand
  | RpcCompactCommand
  | RpcNewSessionCommand
  | RpcSwitchModelCommand
  | RpcBranchCommand
  | RpcGetStateCommand
  | RpcAbortCommand;

// ── RPC Response Types ──────────────────────────────────────

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function emitResult(id: string, data: unknown): void {
  emit({ id, type: "result", data });
}

function emitError(id: string, message: string): void {
  emit({ id, type: "error", message });
}

// ── Main RPC Loop ──────────────────────────────────────────

/**
 * RPC mode: read JSON commands from stdin, execute them, emit events + results to stdout.
 * This enables IDE integrations, test harnesses, and custom UIs to control the agent programmatically.
 *
 * Protocol:
 * - Input: one JSON object per line on stdin
 * - Output: one JSON object per line on stdout (events + results)
 *
 * Commands:
 * - { id, command: "prompt", text } → run agent loop, stream events, return result
 * - { id, command: "compact" } → compact conversation
 * - { id, command: "new_session" } → start new session
 * - { id, command: "switch_model", provider, model, confirm_paid? } → switch model
 *   (`confirm_paid: true` is required for a model that spends real money)
 * - { id, command: "branch", steps_back? } → create conversation branch
 * - { id, command: "get_state" } → return current session state
 * - { id, command: "abort" } → abort current operation
 */
export async function runRpcMode(options: RpcModeOptions): Promise<void> {
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on("SIGINT", onSigint);

  const session = new AgentSession({
    provider: options.provider,
    model: options.model,
    cwd: options.cwd,
    baseUrl: options.baseUrl,
    systemPrompt: options.systemPrompt,
    thinkingLevel: options.thinkingLevel,
    signal: ac.signal,
  });

  // Forward all agent events as NDJSON
  // Forward all agent events as NDJSON
  session.eventBus.on("text_delta", (p) => emit({ type: "text_delta", ...p }));
  session.eventBus.on("thinking_delta", (p) => emit({ type: "thinking_delta", ...p }));
  session.eventBus.on("tool_call_start", (p) => emit({ type: "tool_call_start", ...p }));
  session.eventBus.on("tool_call_update", (p) => emit({ type: "tool_call_update", ...p }));
  session.eventBus.on("tool_call_end", (p) => emit({ type: "tool_call_end", ...p }));
  session.eventBus.on("turn_end", (p) => emit({ type: "turn_end", ...p }));
  session.eventBus.on("agent_done", (p) => emit({ type: "agent_done", ...p }));
  session.eventBus.on("server_tool_call", (p) => emit({ type: "server_tool_call", ...p }));
  session.eventBus.on("server_tool_result", (p) => emit({ type: "server_tool_result", ...p }));
  session.eventBus.on("compaction_start", (p) => emit({ type: "compaction_start", ...p }));
  session.eventBus.on("compaction_end", (p) => emit({ type: "compaction_end", ...p }));
  session.eventBus.on("session_start", (p) => emit({ type: "session_start", ...p }));
  session.eventBus.on("model_change", (p) => emit({ type: "model_change", ...p }));
  session.eventBus.on("branch_created", (p) => emit({ type: "branch_created", ...p }));
  session.eventBus.on("error", ({ error }) => emit({ type: "error", message: error.message }));

  try {
    await session.initialize();
    emit({ type: "ready", state: session.getState() });

    // Read commands from stdin line by line
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;

      let cmd: RpcCommand;
      try {
        cmd = JSON.parse(line) as RpcCommand;
      } catch {
        emit({ type: "error", message: `Invalid JSON: ${line}` });
        continue;
      }

      try {
        await handleCommand(session, cmd, ac);
      } catch (err) {
        emitError(cmd.id, formatUserError(err));
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      emit({ type: "error", message: "Interrupted" });
      process.exit(130);
    }
    process.stderr.write(formatUserError(err) + "\n");
    process.exit(1);
  } finally {
    process.removeListener("SIGINT", onSigint);
    await session.dispose();
    closeLogger();
  }
}

async function handleCommand(
  session: AgentSession,
  cmd: RpcCommand,
  ac: AbortController,
): Promise<void> {
  switch (cmd.command) {
    case "prompt":
      await session.prompt(cmd.text);
      emitResult(cmd.id, { status: "done" });
      break;

    case "compact":
      await session.compact();
      emitResult(cmd.id, { status: "compacted" });
      break;

    case "new_session":
      await session.newSession();
      emitResult(cmd.id, { status: "created", state: session.getState() });
      break;

    case "switch_model":
      try {
        await session.switchModel(cmd.provider, cmd.model, {
          confirmPaid: cmd.confirm_paid === true,
        });
      } catch (err) {
        if (err instanceof PaidModelConfirmationError) {
          emitError(cmd.id, `${err.message} Resend with "confirm_paid": true to use it.`);
          break;
        }
        throw err;
      }
      emitResult(cmd.id, { status: "switched", state: session.getState() });
      break;

    case "branch":
      try {
        const result = await session.branch(cmd.steps_back);
        emitResult(cmd.id, { status: "branched", ...result });
      } catch (err) {
        emitError(cmd.id, err instanceof Error ? err.message : String(err));
      }
      break;

    case "get_state":
      emitResult(cmd.id, session.getState());
      break;

    case "abort":
      ac.abort();
      emitResult(cmd.id, { status: "aborted" });
      break;

    default: {
      const unknown = cmd as { id: string; command: string };
      emitError(unknown.id, `Unknown command: ${unknown.command}`);
      break;
    }
  }
}
