/**
 * ACP mode: expose GG Coder as an Agent Client Protocol agent over stdio.
 *
 * This is the integration surface for ACP clients (Zed, pew2, any editor that
 * speaks the protocol). It is deliberately a sibling of `rpc-mode.ts` — same
 * shape, same `AgentSession`, same NDJSON-on-stdio transport — but the frames
 * are the standard protocol instead of ggcoder's bespoke one, so a client
 * written against the spec works with no ggcoder-specific code.
 *
 * Spec: https://agentclientprotocol.com/protocol/overview
 *
 * Scope: `initialize`, `session/new`, `session/prompt`, `session/cancel`,
 * `session/list`, `session/load` and `session/set_config_option`. Everything
 * advertised in `agentCapabilities` is implemented, because a client must be
 * able to trust that list — advertising a method that then errors is worse
 * than advertising nothing.
 *
 * stdout carries protocol frames ONLY. Anything diagnostic goes to stderr or
 * the log file; a stray `console.log` anywhere in the process corrupts the
 * stream and the client disconnects.
 */
import readline from "node:readline";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { isAbortError } from "@kenkaiiii/gg-agent";
import { getAllModels, getMaxThinkingLevel, getModel } from "@kenkaiiii/gg-core";
import { AgentSession } from "../core/agent-session.js";
import type { EventBus } from "../core/event-bus.js";
import { PROMPT_COMMANDS } from "../core/prompt-commands.js";
import { loadCustomCommands } from "../core/custom-commands.js";
import {
  findSessionById,
  listAllSessions,
  listSessionSummaries,
  loadSessionCheckpointChain,
} from "../session.js";
import {
  getHistoryMessageVisibility,
  reconstructCheckpointHistory,
  restoreUserRow,
} from "../core/session-history.js";
import { formatUserError } from "../utils/error-handler.js";
import { closeLogger } from "../core/logger.js";

/** The ACP major version this mode implements. Bumped only for breaking changes. */
export const ACP_PROTOCOL_VERSION = 1;

// ── JSON-RPC framing ───────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc?: string;
  /** Absent on notifications, which take no response. */
  id?: string | number;
  method?: string;
  params?: unknown;
}

/** JSON-RPC 2.0 reserved codes. ACP adds no codes of its own. */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;

/**
 * The client asked for something impossible, as opposed to the agent failing.
 *
 * Typed rather than sniffed from the message text, so that a client can tell a
 * bug in its own sequencing from an agent that fell over — and so that a later
 * reworded message cannot silently change the code on the wire.
 */
class InvalidParams extends Error {}

// ── Session dependency ─────────────────────────────────────

/**
 * The slice of {@link AgentSession} this mode uses.
 *
 * Narrowed to an interface so a test can drive the whole protocol without a
 * provider, credentials or a network — the transport is what is under test,
 * and a real model would make the frames non-deterministic.
 */
export interface AcpAgentSession {
  readonly eventBus: Pick<EventBus, "on">;
  initialize(): Promise<void>;
  prompt(content: string): Promise<void>;
  getState(): { sessionId: string; provider: Provider; model: string };
  dispose(): Promise<void>;
  /** Replace the turn-cancellation signal so the session remains reusable. */
  setSignal(signal: AbortSignal): void;
  /** Replay a session file from disk into this session. */
  loadSession(sessionPath: string): Promise<void>;
  /** The conversation as restored, used to replay history to the client. */
  getMessages(): Message[];
  switchModel(provider: string, model: string): Promise<void>;
  getThinkingLevel(): ThinkingLevel | undefined;
  setThinkingLevel(level: ThinkingLevel | undefined): void;
  /** Plan mode is GG's session mode: read-only research until exit_plan. */
  getPlanMode(): boolean;
  setPlanMode(active: boolean): Promise<void>;
  /** Bake an approved plan into the prompt so [DONE:n] progress markers work. */
  setApprovedPlan(planPath: string | undefined): Promise<void>;
  /**
   * Registry commands (/model, /compact, …), including any an extension
   * registered during `initialize`. Optional so a test double need not carry a
   * registry — a session without one simply advertises no registry commands.
   */
  readonly slashCommands?: {
    getAll(): { name: string; aliases: string[]; description: string; usage: string }[];
  };
}

export interface AcpModeOptions {
  provider: Provider;
  model: string;
  cwd: string;
  version: string;
  baseUrl?: string;
  systemPrompt?: string;
  thinkingLevel?: ThinkingLevel;
  /** Defaults to `process.stdin` / `process.stdout`. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /**
   * Builds the session for `session/new`. Overridden by tests; production
   * always gets a real {@link AgentSession}.
   */
  createSession?: (signal: AbortSignal) => AcpAgentSession;
}

// ── Tool mapping ───────────────────────────────────────────

/**
 * ggcoder tool name → ACP `ToolKind`.
 *
 * Purely cosmetic on the client (icon + progress treatment), so an unmapped
 * tool falls back to `other` rather than failing. Keep in step with
 * `src/tools/index.ts` as tools are added.
 */
const TOOL_KINDS: Record<string, string> = {
  read: "read",
  ls: "read",
  find: "read",
  grep: "search",
  code_search: "search",
  web_search: "search",
  edit: "edit",
  write: "edit",
  bash: "execute",
  screenshot: "execute",
  web_fetch: "fetch",
  source_path: "fetch",
  subagent: "think",
  spawn_agent: "think",
  enter_plan: "switch_mode",
  exit_plan: "switch_mode",
};

function toolKind(name: string): string {
  return TOOL_KINDS[name] ?? "other";
}

/**
 * A one-line tool title for the client's activity list.
 *
 * The first string-ish argument is nearly always the interesting one (a path, a
 * command, a query), and it is truncated because this renders on a phone.
 */
function toolTitle(name: string, args: Record<string, unknown>): string {
  for (const value of Object.values(args)) {
    if (typeof value !== "string" || value.length === 0) continue;
    const flat = value.replace(/\s+/g, " ").trim();
    const clipped = flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
    return `${name}(${clipped})`;
  }
  return name;
}

// ── Stop reasons ───────────────────────────────────────────

type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/**
 * Why the current prompt turn ended.
 *
 * ACP has a closed set; ggcoder's `turn_end` carries whatever the provider
 * said. Only the reasons that map cleanly are translated — everything else is
 * a normal completion, which is what the client renders anyway.
 */
function stopReasonFor(truncation: string | undefined, hitMaxTurns: boolean): StopReason {
  if (hitMaxTurns) return "max_turn_requests";
  if (truncation === "max_tokens") return "max_tokens";
  if (truncation === "refusal") return "refusal";
  return "end_turn";
}

// ── Config options ─────────────────────────────────────

/** The selectors this agent exposes. Ids are part of the wire contract. */
export const MODEL_CONFIG_ID = "model";
export const THINKING_CONFIG_ID = "thinking";
export const MODE_CONFIG_ID = "mode";

/** ACP session modes, mapped onto GG's plan mode. */
const MODE_DEFAULT = "default";
const MODE_PLAN = "plan";

/** Thinking off is a real choice, so it needs a value id of its own. */
const THINKING_OFF = "off";

const THINKING_LADDER: readonly ThinkingLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

interface ConfigSelectOption {
  value: string;
  name: string;
  description?: string;
}

interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category: string;
  type: "select";
  currentValue: string;
  options: ConfigSelectOption[];
}

/**
 * Thinking levels this model actually honours, hardest last.
 *
 * Offering levels above the model's ceiling would let a phone pick a setting
 * that silently degrades to something else — a control that lies.
 */
function thinkingOptionsFor(modelId: string): ConfigSelectOption[] {
  const ceiling = getMaxThinkingLevel(modelId);
  const top = THINKING_LADDER.indexOf(ceiling);
  const levels = THINKING_LADDER.slice(0, top < 0 ? THINKING_LADDER.length : top + 1);
  return [
    { value: THINKING_OFF, name: "Off", description: "No extended reasoning" },
    ...levels.map((level) => ({ value: level, name: level })),
  ];
}

/**
 * The selectors a client renders for a session, with their live values.
 *
 * Model and thinking come from ggcoder's own registry rather than anything
 * pew2- or Zed-specific, which is what lets a phone show GG Coder's real model
 * list without either side hard-coding the other's.
 */
function configOptionsFor(session: AcpAgentSession): ConfigOption[] {
  const { model } = session.getState();
  const thinking = session.getThinkingLevel();
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: getAllModels().map((entry) => ({
        value: entry.id,
        name: entry.name,
        description: entry.provider,
      })),
    },
    {
      id: THINKING_CONFIG_ID,
      name: "Thinking",
      description: "Extended reasoning effort",
      category: "thought_level",
      type: "select",
      // A model that cannot think reports `off`, which is the truth rather than
      // a level it would ignore.
      currentValue: getModel(model)?.supportsThinking ? (thinking ?? THINKING_OFF) : THINKING_OFF,
      options: thinkingOptionsFor(model),
    },
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      description: "Plan mode is read-only research until a plan is approved",
      category: "mode",
      type: "select",
      currentValue: session.getPlanMode() ? MODE_PLAN : MODE_DEFAULT,
      options: [
        { value: MODE_DEFAULT, name: "Default", description: "Full tool access" },
        { value: MODE_PLAN, name: "Plan", description: "Read-only until exit_plan" },
      ],
    },
  ];
}

// ── Available commands ─────────────────────────────────────

/** One entry of ACP's `available_commands_update`. */
interface AcpCommand {
  name: string;
  description: string;
  /** Present only when the command does something with trailing text. */
  input?: { hint: string };
}

/** What a prompt-template command does with whatever follows the name. */
const TEMPLATE_ARG_HINT = "extra instructions (optional)";

/**
 * The argument hint for a registry command, taken from its own usage string.
 *
 * `/add-dir [path] — no path lists the current roots` becomes `[path]`: the
 * client renders a hint, not a man page, and the prose after the dash is the
 * description's job.
 */
function hintFromUsage(name: string, usage: string): { hint: string } | undefined {
  const withoutName = usage.replace(new RegExp(`^\\s*/${name}\\b`), "").trim();
  const hint = withoutName.split("—")[0].split(" - ")[0].trim();
  return hint ? { hint } : undefined;
}

/**
 * Every slash command this session would actually honour, in the precedence
 * `AgentSession.resolveSlashInput` uses: built-in prompt templates, then
 * `.gg/commands/*.md` from the project, then registry commands.
 *
 * That order is not cosmetic. `resolveSlashInput` looks for a template body
 * FIRST and only falls through to the registry when there is none, so a project
 * file named `new.md` really does shadow the registry's `/new`. Listing the
 * registry entry for that name would point a client's user at a description of
 * something the agent will not run.
 *
 * Names already claimed — including a built-in's ALIASES, which
 * `getPromptCommand` matches — are dropped rather than listed twice.
 */
async function availableCommands(session: AcpAgentSession, cwd: string): Promise<AcpCommand[]> {
  const commands: AcpCommand[] = [];
  const taken = new Set<string>();

  const add = (command: AcpCommand): void => {
    if (taken.has(command.name)) return;
    taken.add(command.name);
    commands.push(command);
  };

  for (const command of PROMPT_COMMANDS) {
    for (const alias of command.aliases) taken.add(alias);
    add({
      name: command.name,
      description: command.description,
      input: { hint: TEMPLATE_ARG_HINT },
    });
  }

  // Project commands are files on disk, so a client that never rescans still
  // gets whatever existed when the session opened.
  for (const command of await loadCustomCommands(cwd)) {
    add({
      name: command.name,
      description: command.description,
      input: { hint: TEMPLATE_ARG_HINT },
    });
  }

  // Last: anything above with the same NAME beats a registry command. An alias
  // collision does not, so aliases are deliberately not claimed here — a
  // project `q.md` shadows `/q` without hiding `/quit` itself.
  for (const command of session.slashCommands?.getAll() ?? []) {
    add({
      name: command.name,
      description: command.description,
      input: hintFromUsage(command.name, command.usage),
    });
  }

  return commands;
}

/** The `modes` block ACP clients like Zed read from session/new and session/load. */
function sessionModes(session: AcpAgentSession): Record<string, unknown> {
  return {
    currentModeId: session.getPlanMode() ? MODE_PLAN : MODE_DEFAULT,
    availableModes: [
      { id: MODE_DEFAULT, name: "Default", description: "Full tool access" },
      { id: MODE_PLAN, name: "Plan", description: "Read-only research until a plan is approved" },
    ],
  };
}

// ── History replay ───────────────────────────────────

/** Flatten a persisted message's content to the text a client would show. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => (block as { type?: string })?.type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("");
}

/**
 * Turn a restored conversation into the `session/update` stream a client needs
 * to draw it.
 *
 * ACP has no "here is the transcript" response: a loaded session is replayed as
 * the same notifications a live turn produces, so the client needs no second
 * rendering path. Thinking is deliberately NOT replayed — it is transient by
 * design, and a wall of stale reasoning above a resumed conversation buries the
 * thing the user came back for.
 */
export function historyUpdates(messages: readonly Message[]): Record<string, unknown>[] {
  const updates: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (getHistoryMessageVisibility(message) === "hidden") continue;

    if (message.role === "user") {
      const restored = restoreUserRow(message.content, message.provenance);
      if (restored.autopilotInjected || restored.notification) continue;
      if (restored.text) {
        updates.push({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: restored.text },
        });
      }
      continue;
    }

    if (message.role === "assistant") {
      const text = messageText(message.content);
      if (text) {
        updates.push({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if ((block as { type?: string }).type !== "tool_call") continue;
          const call = block as { id: string; name: string; args?: Record<string, unknown> };
          const args = call.args ?? {};
          updates.push({
            sessionUpdate: "tool_call",
            toolCallId: call.id,
            title: toolTitle(call.name, args),
            name: call.name,
            kind: toolKind(call.name),
            // History is settled: a replayed call that still said `in_progress`
            // would leave a spinner running forever on a resumed session.
            status: "completed",
            rawInput: args,
          });
        }
      }
      continue;
    }

    for (const result of message.content) {
      const entry = result as { toolCallId: string; content: unknown; isError?: boolean };
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: entry.toolCallId,
        status: entry.isError ? "failed" : "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: messageText(entry.content) },
          },
        ],
      });
    }
  }

  return updates;
}

// ── Mode ───────────────────────────────────────────────────

/**
 * Serve ACP on stdio until the input stream ends.
 *
 * Resolves when the client disconnects; the caller owns process exit.
 */
export async function runAcpMode(options: AcpModeOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  function write(frame: Record<string, unknown>): void {
    output.write(`${JSON.stringify(frame)}\n`);
  }

  function respond(id: string | number, result: unknown): void {
    write({ jsonrpc: "2.0", id, result });
  }

  function fail(id: string | number, code: number, message: string): void {
    write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /**
   * The single session this process serves.
   *
   * ACP allows many per connection, but an ACP client spawns one agent process
   * per session anyway, and `AgentSession` owns process-wide state (cwd, tool
   * registry, session file). One-per-process is the honest model; a second
   * `session/new` replaces the first rather than pretending to multiplex.
   */
  let session: AcpAgentSession | null = null;
  let sessionId = "";
  let abort = new AbortController();
  /** Set while a `session/prompt` is in flight, so a second one is rejected. */
  let running = false;
  let cancelled = false;
  let truncation: string | undefined;
  let hitMaxTurns = false;
  /** Detaches every event listener when the session is replaced or disposed. */
  let unwire: (() => void)[] = [];

  function notifyUpdate(update: Record<string, unknown>): void {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  /**
   * Tell the client the session mode changed outside a request it made — the
   * model itself can enter/exit plan mode mid-run via the enter_plan/exit_plan
   * tools, and a picker that only tracks its own changes would lie.
   */
  function notifyModeChange(modeId: string): void {
    if (!session) return;
    notifyUpdate({ sessionUpdate: "current_mode_update", currentModeId: modeId });
    notifyUpdate({
      sessionUpdate: "config_option_update",
      configOptions: configOptionsFor(session),
    });
  }

  /**
   * Tell the client which slash commands exist, once the session is up.
   *
   * Sent as a notification AFTER the response that created the session (a
   * timer, not a microtask, so it cannot overtake it): the payload is addressed
   * by sessionId, and a client that has not yet seen its own session/new result
   * has nowhere to put it. The agent is the only party that can know its
   * built-ins, so a client scanning `.gg/commands` on its own would miss them.
   */
  function notifyAvailableCommands(target: AcpAgentSession): void {
    const forSession = sessionId;
    setTimeout(() => {
      // A second session/new (or a dispose) beat us here; that session will
      // announce its own commands.
      if (session !== target || sessionId !== forSession) return;
      void availableCommands(target, options.cwd)
        .then((commands) => {
          if (session !== target || sessionId !== forSession) return;
          notifyUpdate({
            sessionUpdate: "available_commands_update",
            availableCommands: commands,
          });
        })
        // Command discovery reads the disk. A failure there must not take down
        // a session that is otherwise fine.
        .catch(() => {});
    }, 0);
  }

  /**
   * Bridge ggcoder's event bus onto `session/update` notifications.
   *
   * Every handler is synchronous and writes immediately, which is what keeps
   * updates ordered ahead of the `session/prompt` response — a client that sees
   * the result before the chunks renders an empty turn.
   */
  function wire(target: AcpAgentSession): void {
    const bus = target.eventBus;
    unwire = [
      bus.on("text_delta", ({ text }) => {
        notifyUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
      }),

      bus.on("thinking_delta", ({ text }) => {
        notifyUpdate({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text },
        });
      }),

      bus.on("tool_call_start", ({ toolCallId, name, args }) => {
        notifyUpdate({
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolTitle(name, args),
          name,
          kind: toolKind(name),
          status: "in_progress",
          rawInput: args,
        });
      }),

      // Mid-flight tool progress. The payload is tool-defined, so it rides in
      // `rawOutput` rather than being invented into content the client would
      // then render as if it were final.
      bus.on("tool_call_update", ({ toolCallId, update }) => {
        notifyUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          rawOutput: update,
        });
      }),

      bus.on("tool_call_end", ({ toolCallId, result, isError }) => {
        notifyUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content: [{ type: "content", content: { type: "text", text: result } }],
        });
      }),

      // Turn-level outcomes are remembered rather than sent: ACP reports them
      // once, as the `stopReason` of the prompt response.
      bus.on("truncated", ({ reason }) => {
        truncation = reason;
      }),

      bus.on("max_turns", () => {
        hitMaxTurns = true;
      }),
    ];
  }

  function unwireAll(): void {
    for (const off of unwire) off();
    unwire = [];
  }

  async function disposeSession(): Promise<void> {
    if (!session) return;
    unwireAll();
    const previous = session;
    session = null;
    sessionId = "";
    await previous.dispose();
  }

  const createSession =
    options.createSession ??
    ((signal: AbortSignal): AcpAgentSession => {
      // Self-reference is safe: the callbacks only run once the agent loop is
      // executing tools, long after the constructor returns.
      const created = new AgentSession({
        provider: options.provider,
        model: options.model,
        cwd: options.cwd,
        baseUrl: options.baseUrl,
        systemPrompt: options.systemPrompt,
        thinkingLevel: options.thinkingLevel,
        // MCP connect (spawning stdio servers, HTTP handshakes) takes seconds
        // and would otherwise sit on the critical path of session/new and
        // session/load. The desktop sidecar already ships this path: the tool
        // catalog is seeded from the disk cache so tools are visible
        // immediately, and live connections promote in the background. A phone
        // client gets its session in milliseconds and the same tools a moment
        // later.
        backgroundMcpConnect: true,
        // Plan mode. Supplying these callbacks is what registers the
        // enter_plan/exit_plan tools at all — without them the mode exists but
        // the model cannot move between states. GG Coder runs without
        // approvals, so a submitted plan is auto-approved, the [DONE:n]
        // contract is baked in so progress markers work as on the desktop, and
        // the client is told about every mode change.
        onEnterPlan: async () => {
          await created.setPlanMode(true);
          notifyModeChange(MODE_PLAN);
        },
        onExitPlan: async (planPath) => {
          await created.setPlanMode(false);
          await created.setApprovedPlan(planPath);
          notifyModeChange(MODE_DEFAULT);
          return "Plan approved. Proceed with implementation, marking each completed step with [DONE:n].";
        },
        signal,
      });
      return created;
    });

  // ── Method handlers ──────────────────────────────────────

  function handleInitialize(): unknown {
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false, acp: false },
        // `{}` is how ACP says "supported" for a capability with no options of
        // its own. Omitting the key means unsupported, so this is not cosmetic.
        sessionCapabilities: { list: {}, resume: {} },
      },
      authMethods: [],
      agentInfo: { name: "ggcoder", title: "GG Coder", version: options.version },
    };
  }

  /**
   * Start a session, optionally replaying a stored one into it.
   *
   * `session/new` and `session/load` differ only in whether history is
   * restored first, so they share this path rather than drifting apart.
   */
  async function startSession(restorePath?: string): Promise<AcpAgentSession> {
    // Replacing an in-flight session would strand the prompt that is running
    // on it, so the old one is stopped first, deliberately and visibly.
    await disposeSession();
    abort = new AbortController();
    const created = createSession(abort.signal);
    await created.initialize();
    if (restorePath) await created.loadSession(restorePath);
    session = created;
    sessionId = created.getState().sessionId;
    wire(created);
    return created;
  }

  async function handleNewSession(): Promise<unknown> {
    const created = await startSession();
    notifyAvailableCommands(created);
    return { sessionId, configOptions: configOptionsFor(created), modes: sessionModes(created) };
  }

  /** The directory a request is about, defaulting to the one we were started in. */
  function requestCwd(params: unknown): string {
    const cwd = (params as { cwd?: unknown })?.cwd;
    return typeof cwd === "string" && cwd ? cwd : options.cwd;
  }

  /**
   * Stored sessions, newest first.
   *
   * This is the answer to "see everything that was on GG Coder": the phone asks
   * the agent, and the agent reads the same `~/.gg/sessions` files the desktop
   * browses — no separate index to fall out of step.
   *
   * ACP makes `cwd` nullable here on purpose. Omitted means EVERY project, not
   * the agent's own directory: a remote client is asking what you have been
   * working on, and that spans checkouts. Each entry carries its own `cwd` so
   * the client can group by project.
   */
  async function handleListSessions(params: unknown): Promise<unknown> {
    const scope = (params as { cwd?: unknown })?.cwd;
    const stored =
      typeof scope === "string" && scope
        ? await listSessionSummaries(scope)
        : await listAllSessions();

    return {
      sessions: stored
        // An empty session has nothing to resume and nothing to title; listing
        // it would fill the phone with identical blank rows.
        .filter((entry) => entry.hasMessages)
        .map((entry) => ({
          sessionId: entry.id,
          cwd: entry.cwd,
          // Captured during the listing pass, so titling the whole machine's
          // history costs no extra reads.
          title: entry.preview ?? null,
          updatedAt: entry.lastActivity,
        })),
    };
  }

  /**
   * Resume a stored session and replay it to the client.
   *
   * The transcript is streamed as `session/update` notifications BEFORE this
   * resolves, which is what the protocol requires and what lets a client draw a
   * resumed conversation with its normal live-turn rendering.
   */
  async function handleLoadSession(params: unknown): Promise<unknown> {
    const requested = (params as { sessionId?: unknown })?.sessionId;
    if (typeof requested !== "string" || !requested) {
      throw new InvalidParams("session/load requires a sessionId.");
    }

    // Searched by id across every project directory, not just `cwd`: a client
    // lists sessions from wherever it probed and reopens them against the
    // directory the session belongs to, so those two rarely match.
    const sessionPath = await findSessionById(requested, requestCwd(params));
    if (!sessionPath) throw new InvalidParams(`Unknown session '${requested}'.`);

    const restored = await startSession(sessionPath);
    // Display history is reconstructed separately. The live AgentSession above
    // deliberately keeps only the canonical newest checkpoint as model context.
    const checkpoints = await loadSessionCheckpointChain(sessionPath);
    const displayMessages = reconstructCheckpointHistory(checkpoints);
    // The id the client asked for is the id it keeps using; `loadSession` may
    // adopt a different internal one, and answering with that would leave the
    // client addressing a session it never heard of.
    sessionId = requested;

    for (const update of historyUpdates(displayMessages)) notifyUpdate(update);
    notifyAvailableCommands(restored);

    return { configOptions: configOptionsFor(restored), modes: sessionModes(restored) };
  }

  /**
   * Switch session mode (ACP `session/set_mode`; Zed's mode picker uses this,
   * pew2 routes it through session/set_config_option with configId "mode").
   */
  async function handleSetMode(params: unknown): Promise<unknown> {
    if (!session) throw new InvalidParams("No session. Call session/new first.");
    const modeId = (params as { modeId?: unknown })?.modeId;
    if (modeId !== MODE_DEFAULT && modeId !== MODE_PLAN) {
      throw new InvalidParams(`Unknown mode '${String(modeId)}'.`);
    }
    const plan = modeId === MODE_PLAN;
    if (session.getPlanMode() !== plan) {
      await session.setPlanMode(plan);
      notifyModeChange(modeId);
    }
    return {};
  }

  /**
   * Apply a selector change from the client.
   *
   * Replies with the COMPLETE option set rather than the one that changed:
   * switching model can move the thinking ceiling, and a client that only
   * patched the field it sent would keep offering levels the new model ignores.
   */
  async function handleSetConfigOption(params: unknown): Promise<unknown> {
    if (!session) throw new InvalidParams("No session. Call session/new first.");
    const { configId, value } = (params ?? {}) as { configId?: unknown; value?: unknown };
    if (typeof configId !== "string" || typeof value !== "string") {
      throw new InvalidParams("session/set_config_option requires a configId and a string value.");
    }

    if (configId === MODEL_CONFIG_ID) {
      const target = getModel(value);
      if (!target) throw new InvalidParams(`Unknown model '${value}'.`);
      await session.switchModel(target.provider, target.id);
      // Thinking levels are per-model, so a level the previous model allowed can
      // be above the new one's ceiling. Clamping here keeps the session's actual
      // effort equal to what the client is about to be told it is.
      const current = session.getThinkingLevel();
      if (current) {
        const allowed = thinkingOptionsFor(target.id).map((option) => option.value);
        if (!allowed.includes(current)) session.setThinkingLevel(getMaxThinkingLevel(target.id));
      }
    } else if (configId === MODE_CONFIG_ID) {
      // Share the dedicated handler so both entry points behave identically.
      await handleSetMode({
        sessionId: (params as { sessionId?: unknown })?.sessionId,
        modeId: value,
      });
    } else if (configId === THINKING_CONFIG_ID) {
      if (value === THINKING_OFF) {
        session.setThinkingLevel(undefined);
      } else {
        const { model } = session.getState();
        const allowed = thinkingOptionsFor(model).map((option) => option.value);
        if (!allowed.includes(value)) {
          throw new InvalidParams(`Model '${model}' does not support thinking level '${value}'.`);
        }
        session.setThinkingLevel(value as ThinkingLevel);
      }
    } else {
      throw new InvalidParams(`Unknown config option '${configId}'.`);
    }

    return { configOptions: configOptionsFor(session) };
  }

  /** Flatten ACP prompt blocks to the plain text `AgentSession` accepts. */
  function promptText(params: unknown): string {
    const blocks = (params as { prompt?: unknown })?.prompt;
    if (!Array.isArray(blocks)) return "";
    return blocks
      .map((block) => {
        const entry = block as { type?: string; text?: string };
        return entry?.type === "text" && typeof entry.text === "string" ? entry.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  async function handlePrompt(params: unknown): Promise<unknown> {
    if (!session) throw new InvalidParams("No session. Call session/new first.");
    if (running) throw new InvalidParams("A prompt is already running in this session.");

    const text = promptText(params);
    if (!text) throw new InvalidParams("prompt must contain at least one non-empty text block.");

    running = true;
    cancelled = false;
    truncation = undefined;
    hitMaxTurns = false;

    try {
      await session.prompt(text);
    } catch (err) {
      // A cancel aborts the loop, which surfaces here. The spec requires the
      // turn to still resolve with `cancelled` rather than reject — the client
      // is confirming its own cancel, not being told something went wrong.
      if (cancelled || isAbortError(err)) return { stopReason: "cancelled" };
      throw err;
    } finally {
      running = false;
    }

    return { stopReason: cancelled ? "cancelled" : stopReasonFor(truncation, hitMaxTurns) };
  }

  function handleCancel(): void {
    if (!running || !session) return;
    cancelled = true;
    abort.abort();
    // `AgentSession` keeps the construction signal for future turns. Re-arm it
    // immediately after aborting this turn, or every later prompt sees an
    // already-aborted signal and silently completes with no output.
    abort = new AbortController();
    session.setSignal(abort.signal);
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return handleInitialize();
      case "session/new":
        return handleNewSession();
      case "session/prompt":
        return handlePrompt(params);
      case "session/list":
        return handleListSessions(params);
      case "session/load":
        return handleLoadSession(params);
      case "session/set_config_option":
        return handleSetConfigOption(params);
      case "session/set_mode":
        return handleSetMode(params);
      default:
        return undefined;
    }
  }

  // ── Read loop ────────────────────────────────────────────

  const rl = readline.createInterface({ input, terminal: false });

  /**
   * Requests still being served.
   *
   * Requests are dispatched WITHOUT blocking the read loop, because
   * `session/prompt` runs for as long as the agent does — awaiting it here
   * would mean `session/cancel` is not read until the turn it cancels has
   * already finished. That is a deadlock, not a slow path.
   */
  const inFlight = new Set<Promise<void>>();

  function serve(id: string | number, method: string, params: unknown): void {
    const task = (async () => {
      try {
        const result = await dispatch(method, params);
        if (result === undefined) {
          fail(id, RPC_METHOD_NOT_FOUND, `Unsupported method: ${method}`);
          return;
        }
        respond(id, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof InvalidParams ? RPC_INVALID_PARAMS : RPC_INTERNAL_ERROR;
        fail(id, code, message);
      }
    })();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  }

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let frame: JsonRpcRequest;
      try {
        frame = JSON.parse(line) as JsonRpcRequest;
      } catch {
        // No id to answer against, so this is the one case that uses a null id,
        // exactly as JSON-RPC 2.0 prescribes for unparseable input.
        write({
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC_PARSE_ERROR, message: "Invalid JSON" },
        });
        continue;
      }

      const { id, method } = frame;

      if (typeof method !== "string") {
        if (id !== undefined) fail(id, RPC_INVALID_REQUEST, "Missing 'method'");
        continue;
      }

      // Notifications: no id, no response, ever — answering one is a protocol
      // violation that some clients treat as a fatal desync.
      if (id === undefined) {
        if (method === "session/cancel") handleCancel();
        continue;
      }

      serve(id, method, frame.params);
    }
  } finally {
    rl.close();
    // The client is gone, so a turn still running has nowhere to report to.
    // Cancelling first is what stops the wait below from being unbounded.
    handleCancel();
    // A disconnect mid-turn must still not tear the session out from under the
    // run that is writing to it.
    await Promise.allSettled([...inFlight]);
    await disposeSession().catch(() => {});
  }
}

/**
 * CLI entry point: serve ACP on the real stdio, then exit.
 *
 * Split from {@link runAcpMode} so the protocol can be tested without the
 * process-level side effects (signal handlers, logger teardown, exit codes).
 */
export async function runAcpModeCli(options: AcpModeOptions): Promise<void> {
  const onSigint = (): void => {
    // An ACP agent is driven entirely by its client; Ctrl-C is the user asking
    // the process to end, not the current turn to stop.
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    await runAcpMode(options);
  } catch (err) {
    process.stderr.write(`${formatUserError(err)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    closeLogger();
  }
}
