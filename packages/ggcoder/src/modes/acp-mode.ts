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
 * `session/list`, `session/load`, `session/resume`, `session/close`,
 * `session/delete`, `session/set_mode` and `session/set_config_option`.
 * Everything advertised in `agentCapabilities` is implemented, because a client
 * must be able to trust that list — advertising a method that then errors is
 * worse than advertising nothing.
 *
 * stdout carries protocol frames ONLY. Anything diagnostic goes to stderr or
 * the log file; a stray `console.log` anywhere in the process corrupts the
 * stream and the client disconnects.
 */
import readline from "node:readline";
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Message, MessageProvenance, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { isAbortError, type ToolExecuteResult } from "@kenkaiiii/gg-agent";
import { getAllModels, getAppPaths, getMaxThinkingLevel, getModel } from "@kenkaiiii/gg-core";
import { AgentSession, type SessionAttachment } from "../core/agent-session.js";
import type { ChildModelPick, SubAgentSnapshot } from "../core/subagent-manager.js";
import {
  createAskUserBridge,
  formatLateAnswer,
  type AskQuestion,
  type AskUserResult,
  type LateAskAnswer,
} from "../core/ask-user.js";
import { createAskUserTool } from "../tools/ask-user.js";
import {
  deleteGoal,
  goalKickoffPrompt,
  goalNeedsKickoff,
  goalPhase,
  goalResumePrompt,
  goalSettingsNote,
  goalWasInterrupted,
  goalsRoot,
  isGoalDir,
  markGoalKickoff,
  readGoal,
  setGoalCritterModel,
  setGoalPaused,
  startGoalOnAnswer,
  updateGoal,
  type GoalBriefExtras,
  type GoalRecord,
} from "../core/goals-store.js";
import { goalRunningElsewhere } from "../core/goal-run-marker.js";
import { GOAL_RUNTIME_PROVENANCE } from "../core/goal-summary.js";
import {
  createGoalsAgentSession,
  goalCritterPick,
  loadGoalBriefExtras,
} from "../goals-agent/goals-agent.js";
import { prepareAttachments } from "../app-sidecar/attachments.js";
import { acpImageAttachments, createAcpGoal, goalWorkers, listAcpGoals } from "./acp-goals.js";
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
  normalizeAutopilotMarkersForHistory,
  reconstructCheckpointHistory,
  restoreUserRow,
} from "../core/session-history.js";
import { findUserSessionPrompt } from "../core/session-preview.js";
import { sessionGroupPaths } from "../core/session-storage.js";
import type { AutopilotMarkerPayload } from "../core/session-manager.js";
import {
  extractPlanSteps,
  findCompletedMarkers,
  markStepsCompleted,
  rebasePlanSteps,
  type PlanStep,
} from "../utils/plan-steps.js";
import { formatUserError } from "../utils/error-handler.js";
import { closeLogger } from "../core/logger.js";
import { acpToolImages } from "./acp-images.js";
import {
  buildUserPlanFeedbackPrompt,
  IMPLEMENT_PLAN_PROMPT,
  PLAN_SUBMITTED_FOR_REVIEW,
  shouldOfferPendingPlan,
} from "../core/plan-handoff.js";
import { readChecklistSnapshot } from "../core/checklist-snapshot.js";
import { CHECKLIST_FILE } from "../core/checklist-items.js";
import { loadAutopilot, saveAutopilot } from "../app-sidecar/app-settings.js";
import { formatErrorForDisplay } from "@kenkaiiii/gg-ai";
import { buildKenAutopilotContext, buildKenAutopilotPlanContext } from "../core/ken-context.js";
import { parseAutopilotVerdict, type AutopilotVerdict } from "../core/autopilot-verdict.js";
import {
  countAssistantMessages,
  extractTurnToolCalls,
  isMechanicalOnlyTurn,
  isWorkflowCommandText,
  shouldStartAutopilotCycle,
  type WorkflowCommandSpec,
} from "../core/autopilot-gate.js";
import {
  driveAutopilotCycle,
  frameAutopilotInjection,
  type AutopilotCycleEmit,
} from "../core/autopilot-cycle.js";
import { createAcpKenReviewer, type AcpKenReviewer } from "./acp-autopilot.js";

/** The ACP major version this mode implements. Bumped only for breaking changes. */
export const ACP_PROTOCOL_VERSION = 1;

// ── JSON-RPC framing ───────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc?: string;
  /** Absent on notifications, which take no response. */
  id?: string | number;
  method?: string;
  params?: unknown;
  /** Present on responses to our own outbound requests (`_gg/ask_user`). */
  result?: unknown;
  error?: unknown;
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
  /** `provenance` marks GG Goals' hidden kickoff/resume instructions. */
  prompt(content: string, provenance?: MessageProvenance): Promise<void>;
  /** Image prompts (`promptCapabilities.image`); without it images are ignored. */
  promptWithAttachments?(text: string, attachments: SessionAttachment[]): Promise<void>;
  /**
   * Mid-run steering (`_gg/queue`). Optional so a test double or alternative
   * session need not support it; `_gg/queue` then answers -32602.
   */
  queueMessage?(text: string): number;
  listQueuedMessages?(): Array<{ id: string; text: string }>;
  cancelQueuedMessage?(id: string): boolean;
  drainQueue?(): string;
  /** GG Goals' workers, for `_gg/goal_state`. */
  listSubAgents?(): SubAgentSnapshot[];
  /** Adds a goal's attached folder to the workspace. */
  addDirectory?(dir: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Tell the agent a fact at its next turn (goal settings changed). */
  notify?(id: string, text: string): void;
  getState(): { sessionId: string; provider: Provider; model: string };
  /**
   * Context accounting for the ACP `usage_update` notification. Optional so a
   * test double or an alternative session implementation need not carry token
   * accounting — a session without it simply reports no usage.
   */
  getContextUsage?(): { used: number; size: number; costUsd?: number };
  dispose(): Promise<void>;
  /** Replace the turn-cancellation signal so the session remains reusable. */
  setSignal(signal: AbortSignal): void;
  /** Replay a session file from disk into this session. */
  loadSession(sessionPath: string): Promise<void>;
  /**
   * Ken's verdict markers (desktop `persistAutopilotMarker`). Optional so a
   * test double need not persist; without them a reopened session has no
   * Ken bubbles.
   */
  persistAutopilotMarker?(
    phase: AutopilotMarkerPayload["phase"],
    extra?: { reason?: string; body?: string },
  ): Promise<void>;
  getAutopilotMarkers?(): AutopilotMarkerPayload[];
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
  /** Host verification evidence for Ken's digest; optional for test doubles. */
  getVerificationEvidence?(): AgentSession["getVerificationEvidence"] extends () => infer R
    ? R
    : never;
  getVerificationProblem?(): string | null;
  /** Fresh context for an accepted plan (desktop /plan/accept). Optional:
   *  without it an accept keeps the current context and sends no reset. */
  newSession?(preserveConversation?: boolean): Promise<void>;
  /**
   * Registry commands (/model, /compact, …), including any an extension
   * registered during `initialize`. Optional so a test double need not carry a
   * registry — a session without one simply advertises no registry commands.
   */
  readonly slashCommands?: {
    getAll(): { name: string; aliases: string[]; description: string; usage: string }[];
  };
}

/**
 * The plan-mode callbacks the agent loop calls when the model uses the
 * `enter_plan` / `exit_plan` tools.
 *
 * Handed to the session factory rather than built inside it so a test double
 * can drive plan mode without a model: approving a plan is what turns it into
 * the client's to-do list, and that path is otherwise unreachable.
 */
export interface AcpPlanHooks {
  onEnterPlan: () => Promise<void>;
  /** Returns the instruction handed back to the model after approval. */
  onExitPlan: (planPath: string) => Promise<ToolExecuteResult>;
}

/**
 * What a session is being built for, beyond the plan hooks.
 *
 * A third argument rather than a change to the first two so existing session
 * factories (tests) keep working unchanged.
 */
export interface AcpSessionContext {
  /** The session's working directory: the goal folder for a goal session. */
  cwd: string;
  /** Set when the cwd is a goal folder: build a GG Goals coordinator. */
  goal: { dir: string; record: GoalRecord } | null;
  /** The goal's brief extras (memory, attached projects' rules), read once. */
  goalExtras?: GoalBriefExtras;
  /** Read live: true once the user has started the goal. */
  isGoalActive: () => boolean;
  /** Read live at each worker spawn. */
  getChildModel: () => ChildModelPick | undefined;
  /**
   * The `ask_user` tool, present only when the client opted in with
   * `clientCapabilities._meta.gg.askUser`. Goes in `additionalTools` at
   * construction (the tool array is append-only for the prompt cache).
   */
  askUserTool?: ReturnType<typeof createAskUserTool>;
  /**
   * The client reviews plans itself (`clientCapabilities._meta.gg.planReview`):
   * exit_plan parks the plan for a human decision instead of auto-approving,
   * and the session gets the desktop's `planSubmissionGate`.
   */
  planReview?: boolean;
}

/**
 * A plan submitted via exit_plan that awaits a decision (desktop parity:
 * app-sidecar.ts pendingPlanPath/planGeneration/offeredPlanGeneration). One
 * object so the autopilot cycle can read and settle it.
 */
export interface AcpPendingPlanState {
  planPath: string | null;
  content: string;
  /** Bumped on every set/clear; a stale decision is refused. */
  generation: number;
  /** Generation last offered to the client; -1 when none. */
  offeredGeneration: number;
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
  createSession?: (
    signal: AbortSignal,
    hooks: AcpPlanHooks,
    context: AcpSessionContext,
  ) => AcpAgentSession;
  /** `~/.gg` by default; where goals (`goals/`) and sessions live. */
  agentDir?: string;
  /**
   * `ask_user` soft deadline (default: the desktop's interactive 10 min). Past
   * it the model hears "no answer yet" and the client's question stays open.
   */
  askUserDeadlineMs?: number;
  /**
   * Builds Autopilot Ken's reviewer for a session's project. Overridden by
   * tests; production gets {@link createAcpKenReviewer}.
   */
  createKenReviewer?: (
    cwd: string,
    buildModel: () => { provider: Provider; model: string },
  ) => AcpKenReviewer;
}

/** Desktop MAX_AUTOPILOT_ROUNDS (app-sidecar.ts). */
const MAX_AUTOPILOT_ROUNDS = 3;

/** Autopilot-injected runs: hidden, as on the desktop (autopilot-runner.ts). */
const AUTOMATION_PROVENANCE: MessageProvenance = {
  source: "runtime",
  kind: "automation",
  visibility: "hidden",
};

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

// ── Tool locations ─────────────────────────────────────────

/**
 * Argument names that hold the path a tool works on, most specific first.
 *
 * Deliberately a small allowlist rather than "any string that looks like a
 * path": `bash`'s command and `web_fetch`'s url would both pass a heuristic and
 * both would send the client's editor somewhere that does not exist.
 */
const PATH_ARG_KEYS = ["file_path", "path", "out_path"] as const;

/**
 * The file a tool call touches, which is what drives "follow the agent" in a
 * client: the editor jumps to whatever GG is reading or editing right now.
 *
 * Paths are resolved to absolute against the session cwd, because the client
 * runs somewhere else entirely and cannot know what a relative path was
 * relative to. A wrong location is worse than none, so anything unrecognised
 * reports nothing.
 */
function toolLocations(
  args: Record<string, unknown>,
  cwd: string,
): { path: string; line?: number }[] {
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value !== "string" || !value) continue;
    const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value);
    // `read`'s offset is a 1-based line, which is exactly what ACP wants for
    // scrolling the client to the region being looked at.
    const offset = args.offset;
    return typeof offset === "number" && Number.isInteger(offset) && offset > 0
      ? [{ path: absolute, line: offset }]
      : [{ path: absolute }];
  }
  return [];
}

// ── File diffs ─────────────────────────────────────────────

/** Tools whose whole purpose is changing a file's contents. */
const DIFF_TOOLS = new Set(["edit", "write"]);

/**
 * Largest file we will snapshot to build a diff.
 *
 * The contents cross the wire twice (old and new) and are read on the event
 * loop, so a generated bundle or lockfile would stall the turn and flood the
 * client with a diff no human is going to read.
 */
const MAX_DIFF_BYTES = 256 * 1024;

/**
 * A snapshot of a file for diffing: its text, or `null` when the file does not
 * exist yet (which is the normal case for `write` creating one). `undefined`
 * means "do not diff this at all" — too big, or unreadable.
 */
type DiffSnapshot = { text: string | null } | undefined;

/**
 * Read a file for diffing, SYNCHRONOUSLY and on purpose.
 *
 * The "before" snapshot is taken inside the `tool_call_start` handler, and the
 * tool it belongs to begins writing in the same tick. An async read would race
 * that write and could capture the file as it is AFTER the edit, which renders
 * in the client as a real change with an empty diff.
 */
function snapshotForDiff(filePath: string): DiffSnapshot {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    // Missing: `write` creating a new file. ACP represents that as a null
    // `oldText`, which clients render as an all-additions diff.
    return { text: null };
  }
  if (size > MAX_DIFF_BYTES) return undefined;
  try {
    return { text: readFileSync(filePath, "utf8") };
  } catch {
    return undefined;
  }
}

// ── Plans ──────────────────────────────────────────────────

/**
 * GG's plan steps as ACP plan entries.
 *
 * ACP requires a priority per entry and GG's plans have no such concept, so
 * every entry reports `medium` rather than inventing a ranking the user never
 * expressed. The first unfinished step is reported `in_progress`: entries are
 * worked in order, so this is what the agent is actually doing now, and it
 * gives the client a live marker instead of a list that only ever flips from
 * pending to completed.
 */
function planEntries(steps: readonly PlanStep[]): Record<string, unknown>[] {
  let activeMarked = false;
  return steps.map((step) => {
    let status: string;
    if (step.completed) {
      status = "completed";
    } else if (activeMarked) {
      status = "pending";
    } else {
      activeMarked = true;
      status = "in_progress";
    }
    return { content: step.text, priority: "medium", status };
  });
}

/** Read a plan markdown file, or empty string when it has gone missing. */
function readPlanFile(planPath: string): string {
  try {
    return readFileSync(planPath, "utf8");
  } catch {
    return "";
  }
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
      // Editors have no "spend real money" confirmation, so a paid model
      // (Claude fast mode) is never offered here unless it's already current.
      options: getAllModels()
        .filter((entry) => entry.billing?.paid !== true || entry.id === model)
        .map((entry) => ({
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
 *
 * Each replayed chunk carries a `messageId` so a client can group chunks into
 * the messages they came from; ids are per-replay and positional, which is all
 * the protocol needs of them.
 */
export function historyUpdates(messages: readonly Message[]): Record<string, unknown>[] {
  return historyFrames(messages, []).flatMap((f) => ("update" in f ? [f.update] : []));
}

/** A replayed Ken marker, as `_gg/autopilot_event` params (sans sessionId). */
export interface HistoryAutopilotEvent {
  phase: string;
  reason?: string;
  body?: string;
  history: true;
}

/**
 * {@link historyUpdates} with Ken's verdict markers interleaved at their
 * `afterMessageCount` (non-system messages, as the desktop history route
 * counts them). Marker phase `plan_approved` replays as ACP `plan_accepted`.
 */
export function historyFrames(
  messages: readonly Message[],
  markers: readonly AutopilotMarkerPayload[],
): Array<{ update: Record<string, unknown> } | { autopilot: HistoryAutopilotEvent }> {
  const frames: Array<{ update: Record<string, unknown> } | { autopilot: HistoryAutopilotEvent }> =
    [];
  const updates = {
    push: (update: Record<string, unknown>) => frames.push({ update }),
  };
  const byCount = new Map<number, AutopilotMarkerPayload[]>();
  const nonSystem = messages.filter((m) => m.role !== "system").length;
  for (const marker of normalizeAutopilotMarkersForHistory(markers, nonSystem)) {
    const list = byCount.get(marker.afterMessageCount) ?? [];
    list.push(marker);
    byCount.set(marker.afterMessageCount, list);
  }
  const flush = (count: number): void => {
    for (const marker of byCount.get(count) ?? []) {
      frames.push({
        autopilot: {
          phase: marker.phase === "plan_approved" ? "plan_accepted" : marker.phase,
          ...(marker.reason !== undefined ? { reason: marker.reason } : {}),
          ...(marker.body !== undefined ? { body: marker.body } : {}),
          history: true,
        },
      });
    }
    byCount.delete(count);
  };
  let replayed = 0;
  let counted = 0;
  const nextMessageId = (): string => `hist-${++replayed}`;

  flush(0);
  for (const message of messages) {
    replayMessage(message);
    if (message.role !== "system") {
      counted += 1;
      flush(counted);
    }
  }
  return frames;

  function replayMessage(message: Message): void {
    if (getHistoryMessageVisibility(message) === "hidden") return;

    if (message.role === "user") {
      const restored = restoreUserRow(message.content, message.provenance);
      if (restored.autopilotInjected || restored.notification) return;
      if (restored.text) {
        updates.push({
          sessionUpdate: "user_message_chunk",
          messageId: nextMessageId(),
          content: { type: "text", text: restored.text },
        });
      }
      return;
    }

    if (message.role === "assistant") {
      const text = messageText(message.content);
      if (text) {
        updates.push({
          sessionUpdate: "agent_message_chunk",
          messageId: nextMessageId(),
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
      return;
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
          ...acpToolImages(entry.content),
        ],
      });
    }
  }
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

  /**
   * Chunk grouping. A message runs until something interrupts it — a tool call
   * or the end of the turn — so the id is minted lazily on the first chunk and
   * dropped at those boundaries, which is exactly where the client should start
   * a new bubble.
   */
  let messageSeq = 0;
  let currentMessageId: string | null = null;

  /** Before-snapshots for in-flight `edit`/`write` calls, keyed by tool call. */
  const diffSnapshots = new Map<string, { path: string; before: DiffSnapshot }>();

  /** The approved plan being implemented, and how far through it the agent is. */
  let planPath: string | undefined;
  let planSteps: PlanStep[] = [];
  const completedSteps = new Set<number>();
  /** This turn's assistant text, scanned for `[DONE:n]` markers. */
  let turnText = "";

  /** Whether this session has already announced a title to the client. */
  let titleAnnounced = false;

  // ── GG extensions (namespace `gg`) ──
  const agentDir = options.agentDir ?? getAppPaths().agentDir;
  /** The client answers `_gg/ask_user` (clientCapabilities._meta.gg.askUser). */
  let clientAsksUser = false;
  /** The client reviews plans (`clientCapabilities._meta.gg.planReview`). */
  let clientPlanReview = false;
  /** The client sent any `clientCapabilities._meta.gg` (reads `_gg/*` notifications). */
  let clientSpeaksGg = false;
  /** Whether the CURRENT session was built with plan review on. */
  let sessionPlanReview = false;
  /** Pending plan, reachable by the autopilot cycle. */
  const pendingPlan: AcpPendingPlanState = {
    planPath: null,
    content: "",
    generation: 0,
    offeredGeneration: -1,
  };
  /** Autopilot (Ken) state for the session's project; `reviewing` is set by the cycle. */
  const autopilot = { enabled: false, reviewing: false };
  /**
   * The cycle in flight inside a `session/prompt`. `stop` is set by
   * session/cancel ("cancelled") or a queued message during review ("ignored").
   */
  const cycle: { active: boolean; stop: "cancelled" | "ignored" | null } = {
    active: false,
    stop: null,
  };
  /** Ken's reviewer for the current session, built on first review. */
  let kenReviewer: AcpKenReviewer | null = null;
  /** The text of the user turn the cycle reviews (pinned in Ken's digest). */
  let originalRequest = "";
  /** Bodies Ken injected this conversation, framed (digest labelling). */
  let injectedPrompts: string[] = [];
  /** The active session's working directory: the goal folder for a goal session. */
  let sessionCwd = options.cwd;
  /** The goal the active session coordinates, kept current as it changes. */
  let goal: { dir: string; record: GoalRecord } | null = null;
  /** The queue as last reported, to tell which entries a `queue_drained` took. */
  let knownQueue: Array<{ id: string; text: string }> = [];
  /** Trailing throttle for worker-driven `_gg/goal_state` (≤ 4/s). */
  const GOAL_STATE_INTERVAL_MS = 250;
  let goalStateTimer: ReturnType<typeof setTimeout> | null = null;
  let lastGoalStateAt = 0;

  function queueSnapshot(): Array<{ id: string; text: string }> {
    return session?.listQueuedMessages?.() ?? [];
  }

  /** `_gg/queue_update`: the current queue, plus what was drained or returned. */
  function notifyQueue(extra: Record<string, unknown>): void {
    const queued = queueSnapshot();
    knownQueue = queued;
    write({
      jsonrpc: "2.0",
      method: "_gg/queue_update",
      params: { sessionId, queued, ...extra },
    });
  }

  /**
   * Hand whatever is still queued back to the client instead of running it:
   * on `session/cancel`, and at a turn end that never reached a steering
   * boundary (`turnEnded`, so the client sends it as the next prompt).
   */
  function returnQueue(turnEnded: boolean): void {
    const left = queueSnapshot();
    if (left.length === 0 || !session?.drainQueue) return;
    session.drainQueue();
    notifyQueue({ returned: left, ...(turnEnded ? { turnEnded: true } : {}) });
  }

  function goalStatePayload(): Record<string, unknown> | null {
    if (!goal || !session) return null;
    const { record } = goal;
    return {
      sessionId,
      goalId: record.id,
      phase: goalPhase(record),
      paused: Boolean(record.pausedAt),
      critterModel: goalCritterPick(record)?.model ?? null,
      workers: goalWorkers(session.listSubAgents?.() ?? []),
    };
  }

  /** `_gg/goal_state`, now: full state each time. */
  function notifyGoalState(): void {
    if (goalStateTimer) {
      clearTimeout(goalStateTimer);
      goalStateTimer = null;
    }
    const params = goalStatePayload();
    if (!params) return;
    lastGoalStateAt = Date.now();
    write({ jsonrpc: "2.0", method: "_gg/goal_state", params });
  }

  /** `_gg/goal_state` for worker churn, at most every 250ms (trailing). */
  function notifyGoalStateSoon(): void {
    if (goalStateTimer || !goal) return;
    const wait = Math.max(0, GOAL_STATE_INTERVAL_MS - (Date.now() - lastGoalStateAt));
    goalStateTimer = setTimeout(() => {
      goalStateTimer = null;
      notifyGoalState();
    }, wait);
  }

  /** `_meta.gg.goal` for session/new|load|resume responses on a goal session. */
  function goalMeta(target: AcpAgentSession): Record<string, unknown> {
    if (!goal) return {};
    const { record } = goal;
    return {
      _meta: {
        gg: {
          goal: {
            id: record.id,
            phase: goalPhase(record),
            paused: Boolean(record.pausedAt),
            needsKickoff: goalNeedsKickoff(record, target.getMessages()),
          },
        },
      },
    };
  }

  /**
   * `_gg/ask_user`, on the desktop's ask bridge: the JSON-RPC id is the
   * bridge's question id. Past the soft deadline the model is told "no answer
   * yet" and proceeds, while the client's request stays OPEN; a late answer
   * goes to {@link deliverLateAnswer}. A JSON-RPC error or malformed reply
   * counts as cancel; `session/cancel`, close and disconnect cancel everything
   * (including deferred questions, whose later replies are then ignored).
   */
  const asks = createAskUserBridge({
    broadcast: (prompt) =>
      write({
        jsonrpc: "2.0",
        id: prompt.id,
        method: "_gg/ask_user",
        params: { sessionId, questions: prompt.questions },
      }),
    ...(options.askUserDeadlineMs !== undefined ? { timeoutMs: options.askUserDeadlineMs } : {}),
    onLateAnswer: (late) => void deliverLateAnswer(late),
  });

  /**
   * A late answer reaches the agent the way the desktop delivers it: a goal
   * start is recorded at once, then the "Late answer to:" text joins the queue.
   * Mid-run it is steering (reported like any queued message). Idle, ggcoder
   * never starts a turn itself, so it is handed back as `returned` with
   * `turnEnded` and the client sends it as the next prompt.
   */
  async function deliverLateAnswer(late: LateAskAnswer): Promise<void> {
    const target = session;
    await startGoalFrom({ action: "answer", answers: late.answers }, late.prompt.questions);
    if (!target || target !== session) return;
    const text = formatLateAnswer(late);
    if (running && target.queueMessage) {
      target.queueMessage(text);
      notifyQueue({});
      return;
    }
    write({
      jsonrpc: "2.0",
      method: "_gg/queue_update",
      params: {
        sessionId,
        queued: queueSnapshot(),
        returned: [{ id: `late-${late.prompt.id}`, text }],
        turnEnded: true,
      },
    });
  }

  function cancelPendingAsks(): void {
    asks.cancelAll();
  }

  /** The client's answer to an outbound `_gg/ask_user`, validated. */
  function settleAsk(id: string, frame: { result?: unknown; error?: unknown }): void {
    const result = frame.result as { action?: unknown; answers?: unknown } | undefined;
    if (
      frame.error === undefined &&
      result?.action === "answer" &&
      result.answers &&
      typeof result.answers === "object" &&
      !Array.isArray(result.answers)
    ) {
      const answers: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(result.answers as Record<string, unknown>)) {
        if (typeof value === "string") answers[key] = value;
        else if (Array.isArray(value)) {
          answers[key] = value.filter((v): v is string => typeof v === "string");
        }
      }
      asks.settle(id, { action: "answer", answers });
      return;
    }
    asks.settle(id, { action: "cancel" });
  }

  /**
   * A goal starts when the user picks "Start the goal now", exactly as the
   * desktop sidecar does. Never throws: a failed write leaves it briefing.
   */
  async function startGoalFrom(
    result: AskUserResult,
    questions: ReadonlyArray<AskQuestion>,
  ): Promise<void> {
    const current = goal;
    if (!current) return;
    const started = await startGoalOnAnswer(
      current.dir,
      current.record,
      result,
      new Date(),
      questions,
    ).catch(() => null);
    if (started && goal === current) {
      goal = { dir: current.dir, record: started };
      notifyGoalState();
    }
  }

  const askUserTool = createAskUserTool(async (request) => {
    const result = await asks.park(request);
    await startGoalFrom(result, request.questions);
    return result;
  });

  function notifyUpdate(update: Record<string, unknown>): void {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  /**
   * Report context-window usage to the client.
   *
   * Sent whenever token accounting moves — after each model response and after
   * a compaction — because a client's context meter is otherwise frozen at
   * whatever it last inferred. Compaction is only visible to a client as a drop
   * in `used` at unchanged `size`, so the post-compaction emit is what makes
   * that detectable at all.
   *
   * `used`/`size` are required by the schema; a session that cannot count
   * tokens sends nothing rather than a zero, which would render as an empty
   * context the user does not have.
   */
  function notifyUsage(target: AcpAgentSession | null = session): void {
    if (!target || target !== session || !sessionId) return;
    const usage = target.getContextUsage?.();
    if (!usage || !Number.isFinite(usage.used) || !Number.isFinite(usage.size)) return;
    notifyUpdate({
      sessionUpdate: "usage_update",
      used: usage.used,
      size: usage.size,
      ...(usage.costUsd === undefined ? {} : { cost: { amount: usage.costUsd, currency: "USD" } }),
    });
  }

  /**
   * State for a session that was just created or restored, sent after the
   * response that told the client the session exists.
   *
   * Same deferral (and same staleness guard) as {@link notifyAvailableCommands}:
   * a notification addressed to a sessionId the client has not seen yet has
   * nowhere to land. Without this a resumed conversation shows no usage and no
   * title until its first reply, which is exactly when they matter least.
   */
  function announceSessionSoon(target: AcpAgentSession): void {
    const forSession = sessionId;
    setTimeout(() => {
      if (session !== target || sessionId !== forSession) return;
      notifyUsage(target);
      notifySessionInfo(target);
      notifyGoalState();
      notifyPlanState();
      notifyAutopilotState();
    }, 0);
  }

  // ── GG extensions: plan review, autopilot state ──

  function setPendingPlan(planFile: string, content: string): void {
    pendingPlan.planPath = planFile;
    pendingPlan.content = content;
    pendingPlan.generation++;
  }

  function clearPendingPlan(): void {
    if (pendingPlan.planPath === null) return;
    pendingPlan.planPath = null;
    pendingPlan.content = "";
    pendingPlan.generation++;
  }

  /** `_gg/plan_state`: full state. `pending` only once offered to the human. */
  function notifyPlanState(): void {
    if (!sessionPlanReview || !session) return;
    const offered =
      pendingPlan.planPath !== null && pendingPlan.offeredGeneration === pendingPlan.generation;
    write({
      jsonrpc: "2.0",
      method: "_gg/plan_state",
      params: {
        sessionId,
        planMode: session.getPlanMode(),
        pending: offered
          ? {
              planPath: pendingPlan.planPath,
              content: pendingPlan.content,
              generation: pendingPlan.generation,
            }
          : null,
      },
    });
  }

  /** Desktop offerPendingPlan: hand the plan over once everything settled. */
  function offerPendingPlan(): void {
    if (!sessionPlanReview || !session) return;
    const offer = shouldOfferPendingPlan({
      planPath: pendingPlan.planPath,
      generation: pendingPlan.generation,
      offeredGeneration: pendingPlan.offeredGeneration,
      running,
      starting: false,
      autopilotActive: autopilot.reviewing,
      queued: session.listQueuedMessages?.().length ?? 0,
    });
    if (!offer) return;
    pendingPlan.offeredGeneration = pendingPlan.generation;
    notifyPlanState();
  }

  /** `_gg/autopilot_state` for coding sessions of a client that speaks `_gg`. */
  function notifyAutopilotState(): void {
    if (!clientSpeaksGg || !session || goal) return;
    write({
      jsonrpc: "2.0",
      method: "_gg/autopilot_state",
      params: { sessionId, enabled: autopilot.enabled, reviewing: autopilot.reviewing },
    });
  }

  function setReviewing(on: boolean): void {
    if (autopilot.reviewing === on) return;
    autopilot.reviewing = on;
    notifyAutopilotState();
  }

  /** `_gg/autopilot_event`, one per desktop `autopilot_*` frame. */
  function notifyAutopilotEvent(params: {
    phase: string;
    reason?: string;
    body?: string;
    round?: number;
  }): void {
    write({ jsonrpc: "2.0", method: "_gg/autopilot_event", params: { sessionId, ...params } });
  }

  /** Desktop autopilot-runner's `persistAutopilotMarker`, same phases and moments. */
  function persistMarker(
    target: AcpAgentSession,
    phase: AutopilotMarkerPayload["phase"],
    extra?: { reason?: string; body?: string },
  ): void {
    void target.persistAutopilotMarker?.(phase, extra).catch(() => {});
  }

  function emitCycleFrame(event: AutopilotCycleEmit): void {
    switch (event.type) {
      case "autopilot_done":
        notifyAutopilotEvent({ phase: "done", ...event.data });
        return;
      case "autopilot_ignored":
        notifyAutopilotEvent({ phase: "ignored" });
        return;
      case "autopilot_human":
        notifyAutopilotEvent({ phase: "human", reason: event.data.reason });
        return;
      case "autopilot_capped":
        notifyAutopilotEvent({ phase: "capped", round: event.data.rounds });
        return;
      case "autopilot_plan_accepted":
        notifyAutopilotEvent({ phase: "plan_accepted" });
        return;
    }
  }

  async function workflowCommandSpecs(): Promise<WorkflowCommandSpec[]> {
    const custom = await loadCustomCommands(sessionCwd).catch(() => []);
    return [
      ...PROMPT_COMMANDS.map((c) => ({ name: c.name, aliases: c.aliases, prompt: c.prompt })),
      ...custom.map((c) => ({ name: c.name, aliases: [] as string[], prompt: c.prompt })),
    ];
  }

  function reviewer(target: AcpAgentSession): AcpKenReviewer {
    kenReviewer ??= (options.createKenReviewer ?? defaultKenReviewer)(sessionCwd, () => {
      const st = target.getState();
      return { provider: st.provider, model: st.model };
    });
    return kenReviewer;
  }

  function defaultKenReviewer(
    cwd: string,
    buildModel: () => { provider: Provider; model: string },
  ): AcpKenReviewer {
    return createAcpKenReviewer({ cwd, buildModel });
  }

  /** One Ken review (work or plan); null on failure or when the cycle stopped. */
  async function kenReview(
    target: AcpAgentSession,
    plan: { content: string; generation: number } | null,
  ): Promise<AutopilotVerdict | null> {
    setReviewing(true);
    notifyAutopilotEvent({ phase: "review_start" });
    try {
      const input = {
        cwd: sessionCwd,
        gitBranch: null,
        messages: target.getMessages(),
        verificationEvidence: target.getVerificationEvidence?.() ?? [],
        verificationProblem: target.getVerificationProblem?.() ?? null,
        originalRequest,
        injectedPrompts: [...injectedPrompts],
        workflowCommands: await workflowCommandSpecs(),
      };
      const digest = plan
        ? buildKenAutopilotPlanContext({ ...input, planContent: plan.content })
        : buildKenAutopilotContext(input);
      const reply = await reviewer(target).review(digest);
      if (cycle.stop || (plan && plan.generation !== pendingPlan.generation)) return null;
      return parseAutopilotVerdict(reply);
    } catch (err) {
      if (!cycle.stop) notifyAutopilotEvent({ phase: "error", reason: formatErrorForDisplay(err) });
      return null;
    } finally {
      setReviewing(false);
    }
  }

  /**
   * AUTOPILOT HOOK — runs inside `session/prompt` after a non-cancelled build
   * turn: desktop runAutopilotCycle over the shared driveAutopilotCycle. The
   * prompt response waits for it; injected runs stream as normal turns.
   * Returns the stop result the prompt answers with.
   */
  async function afterBuildTurn(
    target: AcpAgentSession,
    result: unknown,
    turn: { messagesBefore: number; assistantBefore: number; text: string },
  ): Promise<unknown> {
    const messages = target.getMessages();
    const gate = shouldStartAutopilotCycle({
      enabled: autopilot.enabled && !goal,
      cancelled: false,
      planMode: target.getPlanMode(),
      planPending: pendingPlan.planPath !== null,
      workflowCommand: isWorkflowCommandText(turn.text, await workflowCommandSpecs()),
      assistantMessagesAdded: countAssistantMessages(messages) - turn.assistantBefore,
      mechanicalOnly: isMechanicalOnlyTurn(extractTurnToolCalls(messages, turn.messagesBefore)),
    });
    if (!gate.start) return result;

    originalRequest = turn.text;
    cycle.active = true;
    cycle.stop = null;
    let last = result;
    let planGenAtReview = -1;
    const isStopped = () => cycle.stop !== null || target !== session;
    const injectedRun = async (prompt: string, before?: () => Promise<void>) => {
      last = await runTurn(async (t) => {
        await before?.();
        await t.prompt(prompt, AUTOMATION_PROVENANCE);
      });
      if (cancelled) cycle.stop ??= "cancelled";
    };
    try {
      await driveAutopilotCycle({
        maxRounds: pendingPlan.planPath !== null ? MAX_AUTOPILOT_ROUNDS + 2 : MAX_AUTOPILOT_ROUNDS,
        isCancelled: isStopped,
        verificationProblem: () => target.getVerificationProblem?.() ?? null,
        isPlanMode: () => target.getPlanMode(),
        planPending: () => pendingPlan.planPath !== null,
        resetReviewer: async () => {
          await kenReviewer?.reset();
        },
        review: () => kenReview(target, null),
        reviewPlan: () => {
          planGenAtReview = pendingPlan.generation;
          return kenReview(target, {
            content: pendingPlan.planPath
              ? readPlanFile(pendingPlan.planPath) || pendingPlan.content
              : pendingPlan.content,
            generation: planGenAtReview,
          });
        },
        acceptPlan: async (reason) => {
          if (pendingPlan.planPath === null || pendingPlan.generation !== planGenAtReview) {
            return false;
          }
          notifyAutopilotEvent({ phase: "plan_accepted" });
          try {
            await acceptPendingPlan(target);
          } catch (err) {
            notifyAutopilotEvent({ phase: "error", reason: formatErrorForDisplay(err) });
            return false;
          }
          // Persisted into the NEW session (as the desktop does) so a reload
          // shows the marker.
          persistMarker(target, "plan_approved", { reason });
          injectedPrompts = [];
          return true;
        },
        runImplement: async () => {
          const framed = frameAutopilotInjection(IMPLEMENT_PLAN_PROMPT);
          injectedPrompts.push(framed);
          await injectedRun(framed);
        },
        onInjected: (body, round) => {
          clearPendingPlan();
          injectedPrompts.push(frameAutopilotInjection(body));
          notifyAutopilotEvent({ phase: "prompted", body, round });
          persistMarker(target, "prompted", { body });
        },
        runPrompt: (body, opts) =>
          injectedRun(
            frameAutopilotInjection(body),
            opts?.planRevision ? () => reenterPlanModeForRevision(target) : undefined,
          ),
        emit: (event) => {
          // plan_accepted is sent by acceptPlan, ahead of _gg/session_reset.
          if (event.type !== "autopilot_plan_accepted") emitCycleFrame(event);
          if (event.type === "autopilot_done") persistMarker(target, "done", event.data);
          else if (event.type === "autopilot_human") {
            persistMarker(target, "human", { reason: event.data.reason });
          } else if (event.type === "autopilot_capped") persistMarker(target, "capped");
        },
      });
    } finally {
      const stop = cycle.stop;
      cycle.active = false;
      cycle.stop = null;
      setReviewing(false);
      // A queued message ended the cycle: hand it back as the next prompt.
      if (stop === "ignored") {
        notifyAutopilotEvent({ phase: "ignored" });
        if (target === session) returnQueue(true);
      }
      if (stop === "cancelled") last = { stopReason: "cancelled" };
    }
    return last;
  }

  /** mtime of the project's checklist file, or null when absent. */
  function checklistStamp(): number | null {
    try {
      return statSync(path.join(sessionCwd, CHECKLIST_FILE)).mtimeMs;
    } catch {
      return null;
    }
  }

  /** A build turn plus the settle steps (autopilot hook, plan offer, checklist). */
  async function runBuildTurn(
    text: string,
    work: (target: AcpAgentSession) => Promise<void>,
  ): Promise<unknown> {
    const target = session;
    const before = checklistStamp();
    const messagesBefore = target?.getMessages() ?? [];
    const turn = {
      messagesBefore: messagesBefore.length,
      assistantBefore: countAssistantMessages(messagesBefore),
      text,
    };
    let result = await runTurn(work);
    if (target && target === session) {
      if (!cancelled) result = await afterBuildTurn(target, result, turn);
      offerPendingPlan();
      if (checklistStamp() !== before) {
        write({ jsonrpc: "2.0", method: "_gg/checklist_changed", params: { sessionId } });
      }
    }
    return result;
  }

  /** `_meta.gg.planDecision` on a `session/prompt`. */
  function planDecisionOf(
    params: unknown,
  ): { action: "accept" | "feedback" | "reject"; feedback: string; generation: number } | null {
    const raw = (params as { _meta?: { gg?: { planDecision?: unknown } } } | undefined)?._meta?.gg
      ?.planDecision;
    if (!raw || typeof raw !== "object") return null;
    const { action, feedback, generation } = raw as Record<string, unknown>;
    if (action !== "accept" && action !== "feedback" && action !== "reject") {
      throw new InvalidParams("planDecision.action must be accept, feedback or reject.");
    }
    if (typeof generation !== "number") {
      throw new InvalidParams("planDecision.generation must be a number.");
    }
    return { action, feedback: typeof feedback === "string" ? feedback : "", generation };
  }

  /**
   * Desktop /plan/accept: fresh context with the plan baked in, ACP sessionId
   * kept stable, `_gg/session_reset` then the ACP `plan`. A session without
   * `newSession` keeps its context and sends no reset.
   */
  async function acceptPendingPlan(target: AcpAgentSession): Promise<void> {
    const planFile = pendingPlan.planPath ?? undefined;
    clearPendingPlan();
    if (target.newSession) {
      await target.newSession(true);
      titleAnnounced = false;
    }
    await target.setApprovedPlan(planFile);
    const steps = planFile ? extractPlanSteps(readPlanFile(planFile)) : [];
    if (target.newSession) {
      write({
        jsonrpc: "2.0",
        method: "_gg/session_reset",
        params: { sessionId, agentSessionId: target.getState().sessionId, planTotal: steps.length },
      });
    }
    notifyPlanState();
    if (planFile) adoptPlan(planFile);
  }

  /** Desktop reenterPlanModeForRevision. */
  async function reenterPlanModeForRevision(target: AcpAgentSession): Promise<void> {
    if (target.getPlanMode()) return;
    await target.setPlanMode(true);
    notifyModeChange(MODE_PLAN);
  }

  async function handlePlanDecision(
    decision: NonNullable<ReturnType<typeof planDecisionOf>>,
  ): Promise<unknown> {
    const target = session;
    if (!target) throw new InvalidParams("No session. Call session/new first.");
    if (pendingPlan.planPath === null || decision.generation !== pendingPlan.generation) {
      throw new InvalidParams("That plan is no longer pending.");
    }
    if (decision.action === "reject") {
      clearPendingPlan();
      if (target.getPlanMode()) {
        await target.setPlanMode(false);
        notifyModeChange(MODE_DEFAULT);
      }
      notifyPlanState();
      return { stopReason: "end_turn" };
    }
    if (decision.action === "accept") {
      await acceptPendingPlan(target);
      return runBuildTurn(IMPLEMENT_PLAN_PROMPT, (t) =>
        t.prompt(IMPLEMENT_PLAN_PROMPT, {
          source: "runtime",
          kind: "notification",
          visibility: "hidden",
        }),
      );
    }
    const feedback = decision.feedback.trim();
    if (!feedback) throw new InvalidParams("planDecision feedback needs text.");
    clearPendingPlan();
    await reenterPlanModeForRevision(target);
    notifyPlanState();
    notifyUpdate({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: feedback },
    });
    return runBuildTurn(feedback, (t) => t.prompt(buildUserPlanFeedbackPrompt(feedback)));
  }

  async function handleAutopilotSet(params: unknown): Promise<unknown> {
    activeSession(params, "_gg/autopilot/set");
    const enabled = (params as { enabled?: unknown }).enabled;
    if (typeof enabled !== "boolean") throw new InvalidParams("_gg/autopilot/set needs enabled.");
    if (goal) throw new InvalidParams("Autopilot is for coding sessions.");
    await saveAutopilot(sessionCwd, enabled);
    if (autopilot.enabled !== enabled) {
      autopilot.enabled = enabled;
      notifyAutopilotState();
    }
    return { enabled };
  }

  async function handleChecklist(params: unknown): Promise<unknown> {
    activeSession(params, "_gg/checklist");
    const snapshot = await readChecklistSnapshot(sessionCwd, new Date());
    if (!snapshot.ok) throw new InvalidParams(snapshot.error);
    return snapshot.value;
  }

  /**
   * The id chunks of the current agent message share, minted on demand.
   */
  function messageId(): string {
    currentMessageId ??= `msg-${++messageSeq}`;
    return currentMessageId;
  }

  /** Start a new message at the next chunk (tool call, or end of turn). */
  function endMessage(): void {
    currentMessageId = null;
  }

  /**
   * Send the whole plan, which is what ACP requires: the client REPLACES its
   * copy on every update rather than patching it, so a partial list would
   * silently delete steps.
   */
  function notifyPlan(): void {
    if (planSteps.length === 0) return;
    notifyUpdate({ sessionUpdate: "plan", entries: planEntries(planSteps) });
  }

  /**
   * Adopt a freshly approved plan and show it to the client as a to-do list.
   *
   * Progress resets with the plan: `[DONE:n]` markers are relative to the plan
   * that was approved, so carrying completions across a new one would mark
   * steps of the new plan done that nobody has started.
   */
  function adoptPlan(approvedPath: string): void {
    planPath = approvedPath;
    planSteps = extractPlanSteps(readPlanFile(approvedPath));
    completedSteps.clear();
    notifyPlan();
  }

  /**
   * Advance the plan from `[DONE:n]` markers in the agent's own text.
   *
   * The plan is re-read rather than trusted from approval time because the
   * agent is allowed to rewrite it while implementing (a 2-step plan becoming
   * 12 is normal), and a frozen snapshot would report the wrong total and drop
   * markers for steps it has never heard of.
   */
  function refreshPlanProgress(): void {
    if (planSteps.length === 0) return;

    let advanced = false;
    for (const step of findCompletedMarkers(turnText)) {
      if (completedSteps.has(step)) continue;
      completedSteps.add(step);
      advanced = true;
    }
    if (!advanced) return;

    const fresh = planPath ? extractPlanSteps(readPlanFile(planPath)) : [];
    planSteps = markStepsCompleted(rebasePlanSteps(planSteps, fresh), completedSteps);
    notifyPlan();
  }

  /**
   * Give the session a human-readable title, once.
   *
   * ACP expects this "after the first meaningful exchange", and GG already
   * derives the same first-prompt title for its own session list — reusing it
   * means a session is named identically on a phone, in the picker, and on
   * disk instead of three near-misses.
   */
  function notifySessionInfo(target: AcpAgentSession): void {
    if (titleAnnounced || target !== session || !sessionId) return;
    const prompt = findUserSessionPrompt(target.getMessages()).replace(/\s+/g, " ").trim();
    if (!prompt) return;
    titleAnnounced = true;
    notifyUpdate({
      sessionUpdate: "session_info_update",
      title: prompt.length > 80 ? `${prompt.slice(0, 79)}…` : prompt,
      updatedAt: new Date().toISOString(),
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
      void availableCommands(target, sessionCwd)
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
   * The finished tool call's result as an ACP file diff, or undefined when we
   * cannot honestly produce one.
   *
   * A real diff is what lets a client render a reviewable side-by-side edit
   * instead of a wall of text. It REPLACES the tool's text result rather than
   * accompanying it: `edit` already returns a unified diff as prose, and
   * showing both means the same change twice in two formats.
   *
   * A failed call is left as text on purpose — the error message is the useful
   * output, and the file on disk did not change.
   */
  function diffContent(
    toolCallId: string,
    isError: boolean,
  ): Record<string, unknown>[] | undefined {
    const snapshot = diffSnapshots.get(toolCallId);
    if (!snapshot) return undefined;
    diffSnapshots.delete(toolCallId);
    if (isError || !snapshot.before) return undefined;

    const after = snapshotForDiff(snapshot.path);
    // `newText` is required by the schema, so a file that vanished or grew past
    // the diff budget mid-call falls back to the tool's own text output.
    if (!after || after.text === null) return undefined;

    return [
      {
        type: "diff",
        path: snapshot.path,
        oldText: snapshot.before.text,
        newText: after.text,
      },
    ];
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
          messageId: messageId(),
          content: { type: "text", text },
        });
        // Plan markers arrive inside this text and can straddle two deltas, so
        // the scan runs over the turn's accumulated text rather than the chunk.
        // Only a delta that closes a bracket can complete a marker, which keeps
        // this from re-scanning the whole turn on every token.
        turnText += text;
        if (text.includes("]")) refreshPlanProgress();
      }),

      bus.on("thinking_delta", ({ text }) => {
        notifyUpdate({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text },
        });
      }),

      bus.on("tool_call_start", ({ toolCallId, name, args }) => {
        // A tool call ends the message it interrupted; whatever the agent says
        // afterwards is a new one.
        endMessage();

        const locations = toolLocations(args, sessionCwd);
        // Snapshot BEFORE the tool runs. This handler is synchronous and the
        // tool starts writing immediately after it, which is the only window
        // where the file still holds its pre-edit contents.
        if (DIFF_TOOLS.has(name) && locations[0]) {
          diffSnapshots.set(toolCallId, {
            path: locations[0].path,
            before: snapshotForDiff(locations[0].path),
          });
        }

        notifyUpdate({
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolTitle(name, args),
          name,
          kind: toolKind(name),
          status: "in_progress",
          rawInput: args,
          ...(locations.length > 0 ? { locations } : {}),
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

      bus.on("tool_call_end", ({ toolCallId, result, isError, details }) => {
        notifyUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content: [
            ...(diffContent(toolCallId, isError) ?? [
              { type: "content", content: { type: "text", text: result } },
            ]),
            ...acpToolImages(undefined, details),
          ],
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

      // Token accounting changes: after every model response, and after a
      // compaction rebuilds the context. `compaction_end` fires once the
      // compacted messages are installed, so the emit carries the POST-
      // compaction count — the drop the client watches for.
      bus.on("turn_end", () => {
        notifyUsage(target);
        notifySessionInfo(target);
        // The turn is over: the next chunk starts a new message, and the next
        // turn's markers are scanned against its own text.
        endMessage();
        turnText = "";
      }),

      bus.on("compaction_end", () => {
        notifyUsage(target);
      }),

      // Queued steering was folded into the run: tell the client which ones,
      // so it can log them as user turns at this point.
      bus.on("queue_drained", () => {
        if (target !== session) return;
        const current = queueSnapshot();
        const drained = knownQueue.filter((m) => !current.some((c) => c.id === m.id));
        if (drained.length > 0) notifyQueue({ drained });
        else knownQueue = current;
      }),

      bus.on("subagent_state", () => {
        if (target === session) notifyGoalStateSoon();
      }),
    ];
  }

  function unwireAll(): void {
    for (const off of unwire) off();
    unwire = [];
  }

  /**
   * Drop everything scoped to one session's lifetime. A new session inherits
   * none of it: another session's plan progress, half-finished diffs or message
   * numbering would all be reported as if they were its own.
   */
  function resetSessionState(): void {
    diffSnapshots.clear();
    injectedPrompts = [];
    planPath = undefined;
    planSteps = [];
    completedSteps.clear();
    turnText = "";
    titleAnnounced = false;
    currentMessageId = null;
    messageSeq = 0;
    knownQueue = [];
    pendingPlan.planPath = null;
    pendingPlan.content = "";
    pendingPlan.generation++;
    pendingPlan.offeredGeneration = -1;
    if (goalStateTimer) clearTimeout(goalStateTimer);
    goalStateTimer = null;
  }

  async function disposeSession(): Promise<void> {
    if (!session) return;
    // Questions belong to the session that asked them.
    asks.cancelAll();
    unwireAll();
    resetSessionState();
    cycle.stop ??= cycle.active ? "cancelled" : null;
    const ken = kenReviewer;
    kenReviewer = null;
    await ken?.dispose().catch(() => undefined);
    const previous = session;
    session = null;
    sessionId = "";
    goal = null;
    await previous.dispose();
  }

  /**
   * Plan mode. Supplying these callbacks is what registers the
   * enter_plan/exit_plan tools at all — without them the mode exists but the
   * model cannot move between states. GG Coder runs without approvals, so a
   * submitted plan is auto-approved, the [DONE:n] contract is baked in so
   * progress markers work as on the desktop, and the client is told about every
   * mode change.
   *
   * They act on the CURRENT session rather than closing over one: a tool can
   * only run inside a prompt, which is long after `startSession` published it.
   */
  const planHooks: AcpPlanHooks = {
    onEnterPlan: async () => {
      await session?.setPlanMode(true);
      notifyModeChange(MODE_PLAN);
      notifyPlanState();
    },
    onExitPlan: async (approvedPath) => {
      if (sessionPlanReview) {
        // Desktop onExitPlan: park the plan; it is offered once the run settles.
        await session?.setPlanMode(false);
        notifyModeChange(MODE_DEFAULT);
        setPendingPlan(approvedPath, readPlanFile(approvedPath));
        notifyPlanState();
        return PLAN_SUBMITTED_FOR_REVIEW;
      }
      await session?.setPlanMode(false);
      await session?.setApprovedPlan(approvedPath);
      notifyModeChange(MODE_DEFAULT);
      // The approved plan becomes the client's to-do list, which then advances
      // from the [DONE:n] markers the returned instruction asks for.
      adoptPlan(approvedPath);
      return {
        content:
          "Plan approved. Proceed with implementation, marking each completed step with [DONE:n].",
        endRun: false,
      };
    },
  };

  const createSession =
    options.createSession ??
    ((signal: AbortSignal, hooks: AcpPlanHooks, context: AcpSessionContext): AcpAgentSession => {
      const additionalTools = context.askUserTool ? [context.askUserTool] : [];
      if (context.goal) {
        // A goal folder's session is GG Goals, the coordinator, as on the desktop.
        return createGoalsAgentSession({
          provider: options.provider,
          model: options.model,
          cwd: context.cwd,
          baseUrl: options.baseUrl,
          thinkingLevel: options.thinkingLevel,
          backgroundMcpConnect: true,
          signal,
          goal: context.goal,
          extras: context.goalExtras,
          isActive: context.isGoalActive,
          getChildModel: context.getChildModel,
          additionalTools,
        });
      }
      return new AgentSession({
        provider: options.provider,
        model: options.model,
        cwd: context.cwd,
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
        onEnterPlan: hooks.onEnterPlan,
        onExitPlan: hooks.onExitPlan,
        ...(context.planReview ? { planSubmissionGate: true } : {}),
        ...(additionalTools.length > 0 ? { additionalTools } : {}),
        signal,
      });
    });

  // ── Method handlers ──────────────────────────────────────

  function handleInitialize(params: unknown): unknown {
    const gg = (
      params as
        | { clientCapabilities?: { _meta?: { gg?: { askUser?: unknown; planReview?: unknown } } } }
        | undefined
    )?.clientCapabilities?._meta?.gg;
    clientAsksUser = gg?.askUser === true;
    clientPlanReview = gg?.planReview === true;
    clientSpeaksGg = gg !== undefined && gg !== null;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false, acp: false },
        // `{}` is how ACP says "supported" for a capability with no options of
        // its own. Omitting the key means unsupported, so this is not cosmetic.
        sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
        // GG's own extensions (custom `_gg/*` methods). Clients that don't
        // read this see standard ACP only.
        _meta: {
          gg: { queue: 1, askUser: 1, goals: 1, planReview: 1, autopilot: 1, checklist: 1 },
        },
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
  async function startSession(
    restorePath: string | undefined,
    requestedCwd: string,
  ): Promise<AcpAgentSession> {
    // Replacing an in-flight session would strand the prompt that is running
    // on it, so the old one is stopped first, deliberately and visibly.
    await disposeSession();
    // A session whose cwd is a goal folder is that goal's coordinator.
    // Everything else keeps the directory the agent was started in.
    const record = isGoalDir(goalsRoot(agentDir), requestedCwd)
      ? await readGoal(requestedCwd)
      : null;
    goal = record ? { dir: requestedCwd, record } : null;
    sessionCwd = goal ? goal.dir : options.cwd;
    const goalExtras = goal ? await loadGoalBriefExtras(goal) : undefined;
    abort = new AbortController();
    // Plan review is for coding sessions only; GG Goals has no plan mode.
    sessionPlanReview = clientPlanReview && !goal;
    autopilot.enabled = goal ? false : await loadAutopilot(sessionCwd).catch(() => false);
    autopilot.reviewing = false;
    const created = createSession(abort.signal, planHooks, {
      ...(sessionPlanReview ? { planReview: true } : {}),
      cwd: sessionCwd,
      goal,
      ...(goalExtras ? { goalExtras } : {}),
      isGoalActive: () => Boolean(goal?.record.startedAt),
      getChildModel: () => goalCritterPick(goal?.record),
      ...(clientAsksUser ? { askUserTool } : {}),
    });
    await created.initialize();
    if (restorePath) await created.loadSession(restorePath);
    // A goal's attached folders join its workspace so the coordinator can read
    // them. A resumed session may already carry them.
    if (goal && created.addDirectory) {
      for (const item of goal.record.context) {
        if (item.kind !== "folder") continue;
        await created.addDirectory(item.path).catch(() => undefined);
      }
    }
    session = created;
    sessionId = created.getState().sessionId;
    wire(created);
    return created;
  }

  async function handleNewSession(params: unknown): Promise<unknown> {
    const created = await startSession(undefined, requestCwd(params));
    notifyAvailableCommands(created);
    announceSessionSoon(created);
    return {
      sessionId,
      configOptions: configOptionsFor(created),
      modes: sessionModes(created),
      ...goalMeta(created),
    };
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

    const restored = await startSession(sessionPath, requestCwd(params));
    // Display history is reconstructed separately. The live AgentSession above
    // deliberately keeps only the canonical newest checkpoint as model context.
    const checkpoints = await loadSessionCheckpointChain(sessionPath);
    const displayMessages = reconstructCheckpointHistory(checkpoints);
    // The id the client asked for is the id it keeps using; `loadSession` may
    // adopt a different internal one, and answering with that would leave the
    // client addressing a session it never heard of.
    sessionId = requested;

    // Ken's verdict markers ride between the replayed frames as
    // `_gg/autopilot_event` with `history: true`, only for `_gg` clients.
    const markers = clientSpeaksGg ? (restored.getAutopilotMarkers?.() ?? []) : [];
    for (const frame of historyFrames(displayMessages, markers)) {
      if ("update" in frame) notifyUpdate(frame.update);
      else
        write({
          jsonrpc: "2.0",
          method: "_gg/autopilot_event",
          params: { sessionId, ...frame.autopilot },
        });
    }
    notifyAvailableCommands(restored);
    announceSessionSoon(restored);

    return {
      configOptions: configOptionsFor(restored),
      modes: sessionModes(restored),
      ...goalMeta(restored),
    };
  }

  /**
   * Abort the running turn and WAIT for it to unwind.
   *
   * `handleCancel` only signals: `session.prompt()` keeps unwinding after it
   * returns, and its last act is persisting the turn. Disposing before that
   * finishes clears the session path out from under the write, so the final
   * exchange is silently dropped and the session is missing its tail when the
   * user comes back to it. The read loop's own teardown already waits like
   * this; a lifecycle request that tears a session down mid-turn must too.
   */
  async function cancelAndSettle(): Promise<void> {
    handleCancel();
    await Promise.allSettled([...inFlight]);
  }

  /** The sessionId a lifecycle request names, validated. */
  function requestedSessionId(params: unknown, method: string): string {
    const requested = (params as { sessionId?: unknown })?.sessionId;
    if (typeof requested !== "string" || !requested) {
      throw new InvalidParams(`${method} requires a sessionId.`);
    }
    return requested;
  }

  /**
   * Reconnect to a stored session WITHOUT replaying it.
   *
   * The difference from `session/load` is the whole point: a client that still
   * holds the transcript (it was showing this session a moment ago) wants the
   * agent-side context back, not a second copy of every message pushed at it.
   */
  async function handleResumeSession(params: unknown): Promise<unknown> {
    const requested = requestedSessionId(params, "session/resume");
    const sessionPath = await findSessionById(requested, requestCwd(params));
    if (!sessionPath) throw new InvalidParams(`Unknown session '${requested}'.`);

    const restored = await startSession(sessionPath, requestCwd(params));
    // As in session/load: the client keeps addressing the id it asked for.
    sessionId = requested;
    notifyAvailableCommands(restored);
    announceSessionSoon(restored);

    return {
      configOptions: configOptionsFor(restored),
      modes: sessionModes(restored),
      ...goalMeta(restored),
    };
  }

  /**
   * Close the active session, cancelling whatever it is doing.
   *
   * The spec requires the in-flight turn to be cancelled exactly as
   * `session/cancel` would, so this reuses that path rather than tearing the
   * session down underneath a running agent loop.
   */
  async function handleCloseSession(params: unknown): Promise<unknown> {
    const requested = requestedSessionId(params, "session/close");
    if (!session || requested !== sessionId) {
      throw new InvalidParams(`Session '${requested}' is not active.`);
    }
    await cancelAndSettle();
    await disposeSession();
    return {};
  }

  /**
   * Delete a stored session from disk.
   *
   * Hard delete, including the archive and asset siblings, because a session
   * left half-present would come back as a broken row in the next
   * `session/list`. Deleting something that is not there succeeds silently:
   * the spec asks for idempotence, and the user's intent is already satisfied.
   */
  async function handleDeleteSession(params: unknown): Promise<unknown> {
    const requested = requestedSessionId(params, "session/delete");
    const sessionPath = await findSessionById(requested, requestCwd(params));
    if (!sessionPath) return {};

    // Deleting the session we are serving would leave a live AgentSession
    // appending to a file that no longer exists, quietly recreating it.
    if (session && requested === sessionId) {
      await cancelAndSettle();
      await disposeSession();
    }

    const group = sessionGroupPaths(sessionPath);
    for (const target of [group.plainPath, group.archivePath, group.assetsPath]) {
      await rm(target, { recursive: true, force: true });
    }
    return {};
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
      if (target.billing?.paid && target.id !== session.getState().model) {
        throw new InvalidParams(
          `${target.name} spends real money (${target.billing.detail}) and can only be switched to in the GG Coder app or CLI, where you confirm it.`,
        );
      }
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

  /** `_meta.gg.goalTurn` on a `session/prompt`: GG Goals' kickoff or resume. */
  function goalTurnOf(params: unknown): "kickoff" | "resume" | undefined {
    const turn = (params as { _meta?: { gg?: { goalTurn?: unknown } } } | undefined)?._meta?.gg
      ?.goalTurn;
    return turn === "kickoff" || turn === "resume" ? turn : undefined;
  }

  /**
   * Run one turn with the ACP lifecycle around it: one at a time, cancel
   * resolves as `cancelled`, leftover queued steering is handed back.
   */
  async function runTurn(work: (target: AcpAgentSession) => Promise<void>): Promise<unknown> {
    const target = session;
    if (!target) throw new InvalidParams("No session. Call session/new first.");
    running = true;
    cancelled = false;
    truncation = undefined;
    hitMaxTurns = false;
    knownQueue = [];

    try {
      await work(target);
    } catch (err) {
      // A cancel aborts the loop, which surfaces here. The spec requires the
      // turn to still resolve with `cancelled` rather than reject — the client
      // is confirming its own cancel, not being told something went wrong.
      if (cancelled || isAbortError(err)) return { stopReason: "cancelled" };
      throw err;
    } finally {
      running = false;
      // Drop any before-snapshot whose tool never reported an end. A cancelled
      // turn stops emitting tool events, so `diffContent` — the only other
      // place these are removed — never runs for the call that was in flight,
      // and its file contents would stay pinned for the rest of the session.
      // Cleared here rather than on `turn_end`, which fires before that turn's
      // tools execute and would discard snapshots still in use.
      diffSnapshots.clear();
      // Steering that never reached a boundary goes back to the client as the
      // next prompt; ggcoder never starts a turn by itself.
      if (!cancelled && target === session) returnQueue(true);
    }

    return { stopReason: cancelled ? "cancelled" : stopReasonFor(truncation, hitMaxTurns) };
  }

  async function handlePrompt(params: unknown): Promise<unknown> {
    if (!session) throw new InvalidParams("No session. Call session/new first.");
    if (running || cycle.active) {
      throw new InvalidParams("A prompt is already running in this session.");
    }

    const goalTurn = goalTurnOf(params);
    if (goalTurn) return runGoalTurn(goalTurn);
    const decision = planDecisionOf(params);
    if (decision) return handlePlanDecision(decision);

    const text = promptText(params);
    const images = acpImageAttachments((params as { prompt?: unknown })?.prompt);
    if (!text && images.length === 0) {
      throw new InvalidParams("prompt must contain at least one non-empty text block.");
    }

    return runBuildTurn(text, async (target) => {
      if (images.length > 0 && target.promptWithAttachments) {
        // Same path as the desktop: saved under .gg/uploads, sent as native blocks.
        const prepared = await prepareAttachments(sessionCwd, images);
        await target.promptWithAttachments(text, prepared);
        return;
      }
      if (!text) return;
      await target.prompt(text);
    });
  }

  /**
   * GG Goals' kickoff / resume as an ordinary turn, with the hidden runtime
   * provenance the desktop uses. Nothing to do answers `end_turn` at once.
   */
  async function runGoalTurn(kind: "kickoff" | "resume"): Promise<unknown> {
    const current = goal;
    if (!current || !session) return { stopReason: "end_turn" };
    if (kind === "kickoff" && !goalNeedsKickoff(current.record, session.getMessages())) {
      return { stopReason: "end_turn" };
    }

    return runTurn(async (target) => {
      if (kind === "kickoff") {
        const updated = await markGoalKickoff(current.dir, new Date());
        if (!updated) return;
        if (goal === current) goal = { dir: current.dir, record: updated };
        await target.prompt(goalKickoffPrompt(updated), GOAL_RUNTIME_PROVENANCE);
        return;
      }
      const wasPaused = Boolean(current.record.pausedAt);
      const record = wasPaused
        ? ((await setGoalPaused(current.dir, false, new Date())) ?? current.record)
        : current.record;
      if (goal === current) goal = { dir: current.dir, record };
      if (wasPaused) notifyGoalState();
      // Never resume a goal another process is running (the desktop app):
      // that would start a second coordinator on it.
      const cutOff =
        !goalRunningElsewhere(current.dir) &&
        (wasPaused ||
          goalWasInterrupted(record, target.getMessages(), target.listSubAgents?.() ?? []));
      if (!cutOff) return;
      await target.prompt(goalResumePrompt(record), GOAL_RUNTIME_PROVENANCE);
    });
  }

  function handleCancel(): void {
    // A question parked on the user is not released by the signal.
    cancelPendingAsks();
    if (cycle.active) {
      cycle.stop = "cancelled";
      kenReviewer?.abort();
    }
    if (!running || !session) return;
    cancelled = true;
    // Whatever was still queued is handed back, not run.
    returnQueue(false);
    abort.abort();
    // `AgentSession` keeps the construction signal for future turns. Re-arm it
    // immediately after aborting this turn, or every later prompt sees an
    // already-aborted signal and silently completes with no output.
    abort = new AbortController();
    session.setSignal(abort.signal);
  }

  // ── GG extensions: queue ──

  /** The active session a `_gg/*` request names, validated. */
  function activeSession(params: unknown, method: string): AcpAgentSession {
    const requested = requestedSessionId(params, method);
    if (!session || requested !== sessionId) {
      throw new InvalidParams(`Session '${requested}' is not active.`);
    }
    return session;
  }

  function handleQueue(params: unknown): unknown {
    const target = activeSession(params, "_gg/queue");
    const text = (params as { text?: unknown }).text;
    if (typeof text !== "string" || !text.trim()) {
      throw new InvalidParams("_gg/queue requires non-empty text.");
    }
    if (cycle.active && !running && target.queueMessage && target.listQueuedMessages) {
      // Desktop: a user message during Ken's review ends the cycle (ignored)
      // and runs next; here it is handed back with turnEnded when the cycle ends.
      cycle.stop ??= "ignored";
      kenReviewer?.abort();
    } else if (!running || !target.queueMessage || !target.listQueuedMessages) {
      throw new InvalidParams("No prompt is running. Send session/prompt instead.");
    }
    target.queueMessage(text);
    const queued = target.listQueuedMessages();
    knownQueue = queued;
    return { id: queued.at(-1)?.id ?? "", queued };
  }

  function handleQueueCancel(params: unknown): unknown {
    const target = activeSession(params, "_gg/queue/cancel");
    const id = (params as { id?: unknown }).id;
    if (typeof id !== "string" || !id) throw new InvalidParams("_gg/queue/cancel requires an id.");
    // false is the normal race (it already drained), not an error.
    const cancelled = target.cancelQueuedMessage?.(id) ?? false;
    const queued = queueSnapshot();
    knownQueue = queued;
    return { cancelled, queued };
  }

  // ── GG extensions: goals ──

  async function handleGoalsCreate(params: unknown): Promise<unknown> {
    const created = await createAcpGoal(agentDir, params);
    if (!created.ok) throw new InvalidParams(created.error);
    return { goal: created.value };
  }

  async function handleGoalsDelete(params: unknown): Promise<unknown> {
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !id) throw new InvalidParams("Missing goal id");
    const ownsIt = goal?.record.id === id;
    if (ownsIt && running) throw new InvalidParams("This goal is still working. Stop it first.");
    const deleted = await deleteGoal(goalsRoot(agentDir), path.join(agentDir, "sessions"), id);
    if (!deleted.ok) throw new InvalidParams(deleted.error);
    if (ownsIt) goal = null;
    return { ok: true };
  }

  /** The goal the named session coordinates. */
  function activeGoal(
    params: unknown,
    method: string,
  ): { target: AcpAgentSession; current: { dir: string; record: GoalRecord } } {
    const target = activeSession(params, method);
    if (!goal) throw new InvalidParams("This session is not a goal.");
    return { target, current: goal };
  }

  async function handleGoalPause(params: unknown): Promise<unknown> {
    const { current } = activeGoal(params, "_gg/goal/pause");
    const updated = await setGoalPaused(current.dir, true, new Date());
    if (!updated) throw new InvalidParams("Unknown goal");
    if (goal === current) goal = { dir: current.dir, record: updated };
    // Stops the run; its workers stop through the same signal.
    handleCancel();
    notifyGoalState();
    return { paused: true };
  }

  async function handleGoalUpdate(params: unknown): Promise<unknown> {
    const { target, current } = activeGoal(params, "_gg/goal/update");
    if (running) throw new InvalidParams("This goal is still working. Pause it first.");
    const { context, instructions } = params as { context?: unknown; instructions?: unknown };
    const updated = await updateGoal(current.dir, {
      ...(Array.isArray(context)
        ? { context: context.filter((p): p is string => typeof p === "string") }
        : {}),
      ...(typeof instructions === "string" ? { instructions } : {}),
    });
    if (!updated.ok) throw new InvalidParams(updated.error);
    if (goal === current) goal = { dir: current.dir, record: updated.value };
    // GG Goals' brief is fixed for the session (prompt cache): it hears the new
    // settings at its next turn, and they're in the brief from the next session.
    target.notify?.("goal-settings", goalSettingsNote(updated.value));
    for (const item of updated.value.context) {
      if (item.kind !== "folder") continue;
      await target.addDirectory?.(item.path).catch(() => undefined);
    }
    return { context: updated.value.context, instructions: updated.value.instructions ?? "" };
  }

  async function handleGoalCritterModel(params: unknown): Promise<unknown> {
    const { current } = activeGoal(params, "_gg/goal/critter_model");
    const raw = (params as { model?: unknown }).model;
    const requested = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    let pick: { provider: string; model: string } | null = null;
    if (requested !== null) {
      const target = getModel(requested);
      if (!target) throw new InvalidParams(`unknown model: ${requested}`);
      pick = { provider: target.provider, model: target.id };
    }
    const updated = await setGoalCritterModel(current.dir, pick);
    if (!updated) throw new InvalidParams("Unknown goal");
    if (goal === current) goal = { dir: current.dir, record: updated };
    notifyGoalState();
    return { critterModel: goalCritterPick(updated)?.model ?? null };
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return handleInitialize(params);
      case "session/new":
        return handleNewSession(params);
      case "session/prompt":
        return handlePrompt(params);
      case "session/list":
        return handleListSessions(params);
      case "session/load":
        return handleLoadSession(params);
      case "session/resume":
        return handleResumeSession(params);
      case "session/close":
        return handleCloseSession(params);
      case "session/delete":
        return handleDeleteSession(params);
      case "session/set_config_option":
        return handleSetConfigOption(params);
      case "session/set_mode":
        return handleSetMode(params);
      case "_gg/queue":
        return handleQueue(params);
      case "_gg/queue/cancel":
        return handleQueueCancel(params);
      case "_gg/goals/list":
        return { goals: await listAcpGoals(agentDir) };
      case "_gg/goals/create":
        return handleGoalsCreate(params);
      case "_gg/goals/delete":
        return handleGoalsDelete(params);
      case "_gg/goal/pause":
        return handleGoalPause(params);
      case "_gg/goal/update":
        return handleGoalUpdate(params);
      case "_gg/goal/critter_model":
        return handleGoalCritterModel(params);
      case "_gg/autopilot/set":
        return handleAutopilotSet(params);
      case "_gg/checklist":
        return handleChecklist(params);
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
        // A response to one of our own requests (`_gg/ask_user`).
        if (typeof id === "string" && asks.openIds().includes(id)) {
          settleAsk(id, frame);
          continue;
        }
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
    // Nobody is left to answer a question: it counts as cancel.
    cancelPendingAsks();
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
