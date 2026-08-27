import {
  agentLoop,
  isAbortError,
  isUsageLimitError,
  type AgentEvent,
  type AgentTool,
  type AgentTurnEndEvent,
} from "@kenkaiiii/gg-agent";
import {
  ProviderError,
  type Message,
  type MessageProvenance,
  type Provider,
  type Usage,
  type ThinkingLevel,
  type TextContent,
  type ImageContent,
  type VideoContent,
} from "@kenkaiiii/gg-ai";
import { EventBus } from "./event-bus.js";
import {
  SlashCommandRegistry,
  createBuiltinCommands,
  type SlashCommandContext,
} from "./slash-commands.js";
import { PROMPT_COMMANDS, getPromptCommand } from "./prompt-commands.js";
import { loadCustomCommands } from "./custom-commands.js";
import { SettingsManager } from "./settings-manager.js";
import { AuthStorage } from "./auth-storage.js";
import { dualAuthProvider, type OAuthCredentials } from "@kenkaiiii/gg-core";
import { getClaudeCliUserAgent } from "./claude-code-version.js";
import { kimiCodingHeaders, isKimiCodingEndpoint } from "./oauth/kimi.js";
import { isGrokCliEndpoint } from "./oauth/xai.js";
import {
  SessionManager,
  KEN_TURN_CUSTOM_KIND,
  AUTOPILOT_MARKER_CUSTOM_KIND,
  APP_MARKER_CUSTOM_KIND,
  type MessageEntry,
  type BranchInfo,
  type CustomEntry,
  type KenTurnPayload,
  type AutopilotMarkerPayload,
  type AppMarkerPayload,
  type RunJournalEntry,
  type RunOutcome,
  type TurnMetricPayload,
} from "./session-manager.js";
import { ExtensionLoader } from "./extensions/loader.js";
import type { ExtensionContext } from "./extensions/types.js";
import {
  shouldCompact,
  compact,
  type CompactionAnchorRemap,
  type CompactionContextSelection,
  type CompactionResult,
} from "./compaction/compactor.js";
import {
  getHistoryMessageVisibility,
  remapAnchorForCompaction,
  stripRecordedPosition,
} from "./session-history.js";
import { sourceFingerprint as computeSourceFingerprint } from "./session-compaction.js";
import {
  getAuthStorageKeys,
  getContextWindow,
  getModel,
  getToolResultCharLimit,
  MODELS,
} from "./model-registry.js";
import { discoverSkills, type Skill } from "./skills.js";
import { ensureAppDirs } from "../config.js";
import {
  buildSubAgentSystemPrompt,
  buildSystemPrompt,
  type SystemPromptEnvironment,
} from "../system-prompt.js";
import {
  createTools,
  createWebSearchTool,
  type LspManager,
  type ProcessManager,
} from "../tools/index.js";
import { partitionToolsByTier } from "../tools/tool-tiers.js";
import type { BackgroundProcess } from "./process-manager.js";
import { buildProcessCompletionFollowUp } from "./process-gate.js";
import { buildSubAgentCompletionFollowUp, type SubAgentManager } from "./subagent-manager.js";
import { applyAsyncSubagentPolicy } from "./subagent-policy.js";
import { z } from "zod";
import { MCPClientManager, getAllMcpServers } from "./mcp/index.js";
import type { MCPElicitHandler } from "./mcp/index.js";
import type { MCPServerConfig } from "./mcp/types.js";
import { clampMcpToolDescription, DeferredToolCatalog } from "./mcp/deferred-catalog.js";
import { CONTEXT_LIMITS, resolveContextLimits, type ContextLimits } from "./context-limits.js";
import { McpCatalogCache, type CachedTool } from "./mcp/catalog-cache.js";
import {
  describeDropped,
  importForeignSession,
  type ImportForeignTranscriptResult,
} from "./foreign-session-import.js";
import { createToolSearchTool } from "../tools/tool-search.js";
import { log } from "./logger.js";
import { setEstimatorModel, calibrateEstimatorFromUsage } from "./compaction/token-estimator.js";
import { calculateActiveContextTokens } from "./compaction/active-context.js";
import { resolveCompactionPolicy } from "./compaction/policy.js";
import { pruneStaleToolResults } from "./compaction/tool-result-pruner.js";
import { discoverAgents } from "./agents.js";
import { enhancePrompt, type EnhanceResult } from "../utils/prompt-enhancer.js";
import { detectProjectStack } from "./language-detector.js";
import {
  type IdealReviewStats,
  evaluateIdealReview,
  buildIdealReviewMessage,
  buildReviewCoverageEscalationMessage,
  buildReviewCoverageMessage,
  MAX_REVIEW_COVERAGE_INJECTIONS,
  withReviewCoverageRequirements,
  detectTestDrift,
  ReviewCoverageTracker,
} from "./ideal-review.js";
import {
  evaluateLoopBreak,
  buildLoopBreakMessage,
  CycleDetector,
  ToolCallProgressTracker,
  detectTextRepetition,
  type CycleDetection,
} from "./loop-breaker.js";
import { buildRegroundingMessage } from "./regrounding.js";
import { buildEnvDeltaMessage } from "./env-delta.js";
import { wrapSteeringText, buildNotificationSteeringText, STEERING_PREFIX } from "./steering.js";
import { AgentNotificationQueue } from "./agent-notifications.js";
import {
  VerificationGate,
  extractAddedLines,
  isCheckOwnFile,
  isCodeFilePath,
  isVerificationCommand,
} from "./verification-gate.js";

import { findUserSessionPrompt, getUserSessionPrompt } from "./session-preview.js";
import { normalizeMessageImages } from "./message-images.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A run whose tool calls fail more often than this is thrashing, not
 * progressing — refuse to extend its turn budget.
 */
const TURN_EXTENSION_MAX_FAILURE_RATIO = 0.5;

// ── Options ────────────────────────────────────────────────

/** A chat attachment (image / video / other file) prepared for the model. The
 *  raw base64 `data` rides native blocks; `path` (when persisted to disk) lets
 *  the agent's tools open the file directly. */
export interface SessionAttachment {
  kind: "image" | "video" | "file";
  mediaType: string;
  data: string;
  name: string;
  path?: string;
}

export interface AgentSessionOptions {
  provider: Provider;
  model: string;
  cwd: string;
  baseUrl?: string;
  /** Replaces the whole system prompt — nothing else is rendered. */
  systemPrompt?: string;
  /**
   * A sub-agent definition's body, COMPOSED with the standard scaffolding
   * (Tools, project context, return contract, Environment) instead of replacing
   * it — see `buildSubAgentSystemPrompt`.
   *
   * Prefer this over `systemPrompt` for delegated children: a bare replacement
   * leaves the child with no Tools section and no Environment facts, which is
   * precisely how a sub-agent ends up misusing tools it was never told it had.
   * Ignored when `systemPrompt` is set.
   */
  agentPrompt?: string;
  /** Whether `agentPrompt` composition includes project instruction files. Default `"project"`. */
  agentContext?: "project" | "none";
  /** Synchronous volatile prompt suffix, refreshed immediately before every run. */
  getSystemPromptTail?: () => string;
  sessionId?: string;
  continueRecent?: boolean;
  maxTokens?: number;
  maxTurns?: number;
  /**
   * How many times the turn budget may be extended when the agent is still
   * making progress. Defaults to the agent-loop default (2); sub-agents pass a
   * stricter cap because a child's extensions multiply against the parent's
   * own budget.
   */
  maxTurnExtensions?: number;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  /** Prefix used for provider prompt-cache routing keys. */
  promptCacheKeyPrefix?: string;
  /**
   * Explicit prompt-cache routing key. When set, overrides the
   * `${promptCacheKeyPrefix}:${sessionId}` default so spawned sub-agents can
   * inherit a stable parent-scoped key — without this, each sub-agent process
   * generates a fresh sessionId and starts with a cold cache.
   */
  promptCacheKey?: string;
  /**
   * If true, this session does NOT create a `.jsonl` session file or persist
   * any messages. Used by subagent spawns (`--json` mode) so their transcripts
   * don't leak into `ggcoder continue` for the parent project. Subagent runs
   * are one-shot, NDJSON-streamed to the parent over stdout, and have no
   * resumable identity.
   */
  transient?: boolean;
  /**
   * If true, `initialize()` returns WITHOUT waiting for MCP servers to connect —
   * the connection runs in the background and tools are appended when ready.
   * Hosts whose readiness is gated on `initialize()` (the gg-app sidecar, which
   * can't emit its listening handshake until init resolves) set this so a slow
   * or hanging stdio MCP server (e.g. a first-run `npx -y …` download) can't
   * delay the session from becoming usable. Default (false) keeps the CLI's
   * connect-before-ready behavior so MCP tools are present on the first turn.
   */
  backgroundMcpConnect?: boolean;
  /**
   * Handler for a server-initiated MCP `elicitation/create` — a request for user
   * input in the middle of a tool call. Hosts that can render a form (the
   * gg-app sidecar) supply this; without it the session declares no elicitation
   * capability and servers fall back to their no-input behavior.
   */
  onMcpElicit?: MCPElicitHandler;
  /**
   * If true, an over-context restored session is NOT compacted inline during
   * `loadExistingSession()` — the existing pre-run auto-compaction in
   * `runLoop()` handles it on the first prompt instead (with proper
   * compaction_start/_end events). The inline load compaction makes a summary
   * LLM call with a 30s timeout, and hosts whose readiness is gated on
   * `initialize()` (the gg-app sidecar: waitForReady blocks the whole webview)
   * would freeze the UI for that entire call. Default (false) keeps the
   * compact-on-load behavior for CLI resume/`ggcoder continue`.
   */
  deferLoadCompaction?: boolean;
  /**
   * Plan-mode callbacks. When provided, the `enter_plan`/`exit_plan` tools are
   * registered and the session manages plan-mode restrictions + system-prompt
   * rebuilds. Hosts (e.g. the gg-app sidecar) use these to surface plan-mode
   * UI. Omitted by callers that don't want plan mode (CLI wires its own).
   */
  onEnterPlan?: (reason?: string) => void | Promise<void>;
  onExitPlan?: (planPath: string) => Promise<string>;
  /**
   * If provided, the session's tool set is filtered to ONLY these tool names
   * after `createTools()` runs, and the system prompt's Tools section lists only
   * them. Used by read-only advisory sessions (e.g. the Ken mentor agent) to
   * register a safe subset — excluded mutating tools (write/edit/bash/…) are
   * never registered, so a hallucinated call can't change the repo. Default
   * (undefined) = all tools, preserving every existing caller's behavior.
   */
  allowedTools?: string[];
  /**
   * MCP server names whose tools are allowed in an allow-listed session. Only
   * meaningful alongside `allowedTools`. With it set, the session connects ONLY
   * these named MCP servers (not the full configured set) and every tool they
   * expose (`mcp__<server>__*`) passes the allow-list. The Ken mentor agent uses
   * this to get `kencode-search` for real-code research while still being barred
   * from every mutating tool. Empty/undefined → an allow-listed session skips
   * MCP entirely (its dynamic tool names could never match a fixed allow-list).
   */
  allowedMcpServers?: string[];
  /**
   * Force 1-h prompt-cache TTL + pre-warm regardless of the user's global
   * `speedProfile` setting. Bursty read-only advisory sessions (the Ken
   * mentor + autopilot reviewer) call the same static system prompt on a
   * schedule that routinely exceeds the default 5-min cache window — a
   * dropped cache there resends the whole cached prefix at full price right
   * when it matters most, independent of whatever the user picked for the
   * main build session. Default (undefined) = follow `speedProfile`.
   */
  forceLongCacheRetention?: boolean;
  /** Hidden persistent subagent workers omit the async orchestration tool suite. */
  subagentWorker?: boolean;
  /** Session storage root override. Chat agents use a dedicated namespace. */
  sessionRootDir?: string;
  /** Register GG Coder built-in/prompt/custom slash commands. Defaults to true. */
  coderSlashCommands?: boolean;
  /** Enable loop-break, re-grounding, and Ideal review hooks. Defaults to true. */
  selfCorrectionHooks?: boolean;
  /** Load project skills/agents and create local .gg directories. Defaults to true. */
  projectCustomization?: boolean;
  /** Register global + bundled subagents without loading project customization. */
  globalSubagents?: boolean;
  /** Load GG Coder extensions. Defaults to true. */
  loadExtensions?: boolean;
  /** Inject GG Coder's model-specific subagent orchestration prompt. Defaults to true. */
  orchestrationPrompt?: boolean;
  /** Host-provided tools appended to this session only (for example, chat delegation). */
  additionalTools?: AgentTool[];
}

// ── Tool-result policy ─────────────────────────────────────

/** Resolve the per-result cap passed to the agent loop for the active transport. */
export function resolveSessionToolResultCharLimit(
  model: string,
  provider: Provider,
  accountId?: string,
): number {
  return (
    getToolResultCharLimit(model, { provider, accountId }) ??
    Math.floor(getContextWindow(model, { provider, accountId }) * 3.5 * 0.3)
  );
}

/**
 * Aggregate budget for ALL tool results produced in one assistant turn.
 * Individual results are already capped, but wide parallel fan-outs (GPT-5.6's
 * signature behavior) were observed injecting 100k+ uncached tokens in a single
 * turn. ~15% of the context window in chars (1 token ≈ 3.5 chars), floored at
 * 100KB so small windows still fit two full-size reads, ceilinged at 240KB so
 * 1M-context models don't waive the budget entirely.
 */
export function resolveSessionTurnToolResultCharLimit(
  model: string,
  provider: Provider,
  accountId?: string,
): number {
  const contextChars = getContextWindow(model, { provider, accountId }) * 3.5;
  return Math.max(100_000, Math.min(Math.floor(contextChars * 0.15), 240_000));
}

/** Marker the compactor prepends to the summary message it injects. */
/**
 * True when an assistant message ends a turn with tool calls still awaiting
 * their results. Inserting a user message there would orphan the tool_use
 * blocks and the provider rejects the next request.
 */
function hasUnresolvedToolCalls(message: Message): boolean {
  if (typeof message.content === "string" || !Array.isArray(message.content)) return false;
  return message.content.some((part) => part.type === "tool_call");
}

// ── State ──────────────────────────────────────────────────

export interface AgentSessionState {
  provider: Provider;
  model: string;
  cwd: string;
  sessionId: string;
  sessionPath: string;
  messageCount: number;
  planMode: boolean;
  /** accountId from the most recently resolved credentials, if any — lets
   *  callers compute the transport-specific context window (e.g. OpenAI Codex
   *  OAuth) without re-resolving credentials. */
  accountId?: string;
}

// ── Agent Session ──────────────────────────────────────────

export class AgentSession {
  readonly eventBus = new EventBus();
  readonly slashCommands = new SlashCommandRegistry();

  private settingsManager!: SettingsManager;
  private authStorage!: AuthStorage;
  private sessionManager!: SessionManager;
  private extensionLoader = new ExtensionLoader();

  private messages: Message[] = [];
  // Ken Kai (mentor agent) turns recorded against this build session. Advisory
  // only — NEVER part of `messages` (GG Coder must not see them), but persisted
  // alongside the session and reloaded on resume so they reappear in the
  // transcript. Each carries the non-system message count at record time so the
  // webview can interleave them chronologically.
  private kenTurns: KenTurnPayload[] = [];
  // Autopilot Ken (auto-reviewer) markers recorded against this build session:
  // the review verdict shown in the transcript (prompted / done / human /
  // capped). Same not-on-the-DAG treatment as kenTurns — advisory only,
  // persisted + reloaded so a resumed session shows the identical Ken bubble
  // the live run showed instead of dropping it or replaying a raw verdict.
  private autopilotMarkers: AutopilotMarkerPayload[] = [];
  // Generic app transcript markers (plan-mode banner, task header, error rows,
  // user-bubble display hints). Same not-on-the-DAG treatment as kenTurns —
  // display only, persisted + reloaded so a resumed session shows the same
  // transcript rows the live run showed.
  private appMarkers: AppMarkerPayload[] = [];
  private turnMetrics: TurnMetricPayload[] = [];
  private tools: AgentTool[] = [];
  /** Rebuilds the read tool for a new model (video byte cap is baked in at
   *  creation). Called from switchModel so video-capable models get the
   *  read-tool's native-video path after a mid-session model change. */
  private rebuildReadTool: ((model: string) => AgentTool) | undefined;
  private skills: Skill[] = [];
  private cacheKeyLogged = false;
  // ── Self-correction hook state (mirrors the TUI's useAgentLoop refs) ──
  // Reset at the start of every run; observed from the event stream; read by
  // the loop-break (mid-loop) and ideal-review (pre-stop) callbacks.
  private hookStats: IdealReviewStats = {
    changedLines: 0,
    toolCalls: 0,
    toolFailures: 0,
    turns: 0,
    writeCalls: 0,
    editCalls: 0,
    bashCalls: 0,
  };
  private hookText = "";
  private hookConsecutiveFailures = 0;
  private hookRepeatedNoProgressCalls = 0;
  private hookProgressTracker = new ToolCallProgressTracker();
  private hookCycleDetector = new CycleDetector();
  private hookCyclicPattern: CycleDetection | null = null;
  private hookFileEditCounts = new Map<string, number>();
  private hookToolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
  private idealReviewPhase: "idle" | "reviewing" | "complete" = "idle";
  /** Runtime-only suppression while Ken owns verification in autopilot mode. */
  private idealReviewSuppressed = false;
  /** Mirror of the last `hook_armed` value broadcast this run, so the event
   *  fires only on a real edge. */
  private idealReviewArmed = false;
  /** Cached test-drift probe, keyed by the size of the edited-file set. Drift
   *  depends only on WHICH files were edited and that set only grows, so this
   *  keeps the arming check off the filesystem on most tool results — the probe
   *  is several sync existsSync calls per edited file. */
  private idealDriftProbe: { files: number; drifted: boolean } | null = null;
  private readonly reviewCoverage: ReviewCoverageTracker;
  /** Coverage follow-ups spent this run, capped by MAX_REVIEW_COVERAGE_INJECTIONS. */
  private reviewCoverageInjected = 0;
  /** 0 = none; 1 = first nudge sent; 2 = final stop-and-report injected. */
  private loopBreakInjected: 0 | 1 | 2 = 0;
  private regroundingInjected = false;
  /**
   * The environment as the cached system prompt currently describes it.
   * Re-recorded on every prompt build, so a rebuild (e.g. `/add-dir`) needs no
   * delta; anything that changes WITHOUT one is caught by the hook below.
   */
  private renderedEnvironment: SystemPromptEnvironment = {};
  /** Wall-clock start of the current run; scopes the background-process gate. */
  private runStartedAt = 0;
  /** Gate injections spent this run, capped by MAX_PROCESS_GATE_INJECTIONS. */
  private processGateInjected = 0;
  /** Verification gate: code edited this run, nothing proved it since. */
  private readonly verificationGate = new VerificationGate();
  /** Mirror of the last verification `hook_armed` value, so the event fires
   *  only on a real edge. */
  private verificationArmed = false;
  private compactionOccurred = false;
  private lastCompactionCompacted = false;
  private compactionRetryAfter = 0;
  /** A restored oversized checkpoint must be canonicalized before its first prompt is persisted. */
  private deferredCompactionPending = false;
  /** Latest provider count, anchored to the assistant response it measured. */
  private providerContext: { usage: Usage; anchor: Message } | null = null;
  private originalRequest = "";
  // Messages queued by the user while a run is in flight. Drained at the
  // mid-loop steering boundary (user steering wins over the hooks), mirroring
  // the TUI's getSteeringMessages. Each entry carries its own attachments so a
  // user can queue media (images/video/files) mid-run, not just plain text.
  // Each entry carries a stable id so a client can cancel one specific pending
  // message by identity. Index-based removal would race: the queue drains at
  // every turn boundary, so an index captured by the UI can point at a
  // different message (or past the end) by the time the cancel arrives.
  private userQueue: Array<{ id: string; text: string; attachments: SessionAttachment[] }> = [];
  private queueSeq = 0;
  private processManager?: ProcessManager;
  private lspManager?: LspManager;
  private subAgentManager?: SubAgentManager;
  /**
   * Out-of-band push notifications (finished children, background-process
   * progress). Producers enqueue; `getHookSteeringMessages` drains into the
   * live turn so the agent never has to spend a turn asking.
   */
  private readonly notifications = new AgentNotificationQueue();
  private managerAbortSignal?: AbortSignal;
  private readonly managerAbortHandler = () => {
    void this.subAgentManager?.interruptAll();
  };
  private mcpManager?: MCPClientManager;
  /** Deferred MCP tools awaiting discovery via tool_search. */
  private mcpCatalog?: DeferredToolCatalog;
  /** Resolved prompt-injection byte budgets (contextLimits setting). */
  private contextLimits: ContextLimits = CONTEXT_LIMITS;
  /**
   * Built-in tools held in the catalog instead of the live toolset. Their names
   * still render as one-line hints in the prompt's Tools section, so the model
   * can discover and promote them; a promoted name drops out of this list.
   */
  private deferredBuiltinToolNames: string[] = [];
  /** Live (connected) MCP tools by name — the reconcile target for cached stubs. */
  private liveMcpTools = new Map<string, AgentTool>();
  /** Server name for each cached-only tool, so a stub knows what to wait on. */
  private cachedMcpToolServers = new Map<string, string>();
  private readonly mcpCatalogCache = new McpCatalogCache();
  private provider: Provider;
  private model: string;
  private cwd: string;
  /** accountId from the most recently resolved credentials — cached so sync
   *  callers (e.g. the app-sidecar's context-window footer stat) can reflect
   *  transport-specific windows (e.g. OpenAI Codex OAuth's smaller window)
   *  without re-resolving credentials on every poll. */
  private lastAccountId?: string;
  private baseUrl?: string;
  private maxTokens: number;
  private thinkingLevel?: ThinkingLevel;
  private customSystemPrompt?: string;
  /** Sub-agent definition body composed into the standard prompt scaffolding. */
  private agentPrompt?: string;
  /** Stable prompt prefix retained separately from the volatile uncached tail. */
  private baseSystemPrompt = "";
  /** Shared with the tool layer so plan-mode restrictions read live state. */
  private planModeRef = { current: false };
  /** Path of the approved plan currently being implemented, or undefined. When
   *  set, the system prompt carries the `[DONE:n]` progress contract so the
   *  model emits step-completion markers the UI's plan-progress widget reads. */
  private approvedPlanPath?: string;
  /** Extra workspace roots added with `/add-dir` (resolved, de-duplicated). */
  private additionalRoots: string[] = [];

  private sessionId = "";
  private checkpointGeneration = 0;
  /** Stable identity shared by compaction and approved-plan checkpoint files. */
  private conversationId = "";
  /** Original user-authored prompt, retained when internal messages replace history. */
  private sessionPreview = "";
  /** Runtime conversation identity for provider transport headers. Transient
   *  children need one even though they intentionally have no persisted session. */
  private readonly transportSessionId = crypto.randomUUID();
  private sessionPath = "";
  private lastPersistedIndex = 0;
  /**
   * The array `agentLoop` is currently mutating, while a run is in flight.
   *
   * Normally identical to `this.messages`, but a mid-loop compaction rebinds
   * `this.messages` to the compacted result while the loop keeps appending to
   * its own array. Step-boundary flushes must follow the loop's array or they
   * would silently persist nothing for the rest of the run.
   */
  private activeLoopMessages: Message[] | null = null;

  /**
   * Number of non-system messages guaranteed to be in the session file — the
   * anchor base for transcript markers (Ken turns, autopilot verdicts, app
   * markers). `this.messages` can run ahead of the file: the agent loop
   * appends assistant/tool/steering messages in place but they are only
   * persisted when the run SUCCEEDS, so after a failed run the in-memory list
   * carries an unpersisted tail. Markers anchored against that tail point past
   * their real position on resume — the row (notably an error) renders lower
   * in the transcript than it happened, bunching at the bottom, or gets
   * dropped as out-of-range. Anchoring to the persisted prefix keeps resume
   * placement 1:1 with where the row appeared live.
   */
  private persistedTranscriptCount(): number {
    return this.messages.slice(0, this.lastPersistedIndex).filter((m) => m.role !== "system")
      .length;
  }
  /** Current leaf entry ID in the session DAG — used to chain parentIds for branching. */
  private currentLeafId: string | null = null;

  private opts: AgentSessionOptions;

  constructor(options: AgentSessionOptions) {
    this.opts = options;
    this.provider = options.provider;
    this.model = options.model;
    this.cwd = options.cwd;
    this.reviewCoverage = new ReviewCoverageTracker(this.cwd);
    this.baseUrl = options.baseUrl;
    this.maxTokens = this.resolveMaxTokens(options.model);
    this.thinkingLevel = options.thinkingLevel;
    this.customSystemPrompt = options.systemPrompt;
    this.agentPrompt = options.agentPrompt;
  }

  /**
   * Derive the output-token cap for a model. Follows the active model's
   * `maxOutputTokens` so a session booted on a large-output model (e.g. Kimi's
   * 256K) doesn't carry that cap to a smaller one (e.g. Opus's 128K) after a
   * model switch — that mismatch surfaces from the provider as
   * `max_tokens: 262144 > 128000, which is the maximum allowed …`. An explicit
   * `maxTokens` override is honored but clamped to the model's ceiling.
   */
  private resolveMaxTokens(modelId: string): number {
    const modelInfo = getModel(modelId);
    if (this.opts.maxTokens) {
      return modelInfo
        ? Math.min(this.opts.maxTokens, modelInfo.maxOutputTokens)
        : this.opts.maxTokens;
    }
    return modelInfo?.maxOutputTokens ?? 16384;
  }

  async initialize(): Promise<void> {
    // Set model for accurate token estimation
    setEstimatorModel(this.model);

    const paths = await ensureAppDirs();

    // Load settings & auth
    this.settingsManager = new SettingsManager(paths.settingsFile);
    await this.settingsManager.load();
    this.contextLimits = resolveContextLimits(this.settingsManager.get("contextLimits"));

    this.authStorage = new AuthStorage(paths.authFile);
    await this.authStorage.load();

    // Session manager. Agent-specific roots keep chat and coder histories isolated.
    this.sessionManager = new SessionManager(this.opts.sessionRootDir ?? paths.sessionsDir);

    const projectCustomization = this.opts.projectCustomization !== false;
    if (projectCustomization) {
      // Ensure project-local .gg directories exist.
      const localGGDir = path.join(this.cwd, ".gg");
      await fs.mkdir(path.join(localGGDir, "skills"), { recursive: true });
      await fs.mkdir(path.join(localGGDir, "commands"), { recursive: true });
      await fs.mkdir(path.join(localGGDir, "agents"), { recursive: true });

      this.skills = await discoverSkills({
        globalSkillsDir: paths.skillsDir,
        projectDir: this.cwd,
      });
    } else {
      this.skills = [];
    }

    // Discover agents and create tools (with sub-agent support). Chat sessions
    // can retain bundled workers without loading project/global customization.
    const agents = projectCustomization
      ? await discoverAgents({
          globalAgentsDir: paths.agentsDir,
          projectDir: this.cwd,
        })
      : this.opts.globalSubagents
        ? await discoverAgents({ globalAgentsDir: paths.agentsDir })
        : [];
    const {
      tools: builtInTools,
      processManager,
      rebuildReadTool,
      lspManager,
      subAgentManager,
    } = await createTools(this.cwd, {
      agents,
      skills: this.skills,
      contextLimits: this.contextLimits,
      provider: this.provider,
      model: this.model,
      lspDiagnostics: this.settingsManager.get("lspDiagnostics"),
      getWriteGuardSettings: () => ({
        allowOutsideWorkspaceWrites: this.settingsManager.get("allowOutsideWorkspaceWrites"),
        additionalRoots: this.additionalRoots,
      }),
      getNetworkPolicy: () => ({
        mode: this.settingsManager.get("networkMode"),
        allow: this.settingsManager.get("networkAllow"),
      }),
      getSandboxPolicy: () => ({
        mode: this.settingsManager.get("sandboxMode"),
        // networkAllow always applies. Choosing "allowlist" is the user taking
        // over network policy, so the built-in developer defaults drop out and
        // only their hosts remain reachable.
        allowedDomains: this.settingsManager.get("networkAllow"),
        strictDomains: this.settingsManager.get("networkMode") === "allowlist",
        // Same source of truth as getWriteGuardSettings, so bash and the write
        // tool agree on which roots are writable.
        additionalRoots: this.additionalRoots,
        allowOutsideWorkspaceWrites: this.settingsManager.get("allowOutsideWorkspaceWrites"),
        allowUnixSockets: this.settingsManager.get("sandboxAllowUnixSockets"),
      }),
      getUseExternalGrep: () => this.settingsManager.get("grepUseRipgrep"),
      authStorage: this.authStorage,
      onFileRead: (filePath) => this.reviewCoverage.recordRead(filePath),
      onFileMutated: (filePath) => {
        const relative = path.relative(this.cwd, filePath) || path.basename(filePath);
        this.hookFileEditCounts.set(relative, (this.hookFileEditCounts.get(relative) ?? 0) + 1);
        this.reviewCoverage.recordChanged(filePath);
      },
      // Lazy — sessionId/model/provider can change after createTools() runs, so
      // sub-agent spawns read the current parent state at execution time.
      getProvider: () => this.provider,
      getModel: () => this.model,
      getThinkingLevel: () => this.thinkingLevel,
      getBaseUrl: () => this.baseUrl,
      getCacheKey: () => this.getPromptCacheKey(),
      getMaxPerModel: () => this.settingsManager.get("subagentMaxPerModel"),
      // A persistent child is already the single allowed fan-out level. Blocking
      // `subagent` here created a timeout sandwich: the nested call could consume
      // the child's entire 10-minute turn budget, discarding all nested results.
      disableSubagents: this.opts.subagentWorker,
      onSubAgentState: (snapshot) => this.eventBus.emit("subagent_state", snapshot),
      notifications: this.notifications,
      // Plan mode: only wired when the host supplies callbacks. The ref is
      // shared so bash/edit/write enforce read-only restrictions live.
      ...(this.opts.onEnterPlan || this.opts.onExitPlan
        ? {
            planModeRef: this.planModeRef,
            onEnterPlan: this.opts.onEnterPlan,
            onExitPlan: this.opts.onExitPlan,
          }
        : {}),
    });
    const tools = [...builtInTools, ...(this.opts.additionalTools ?? [])];
    // Apply the optional tool allow-list (read-only advisory sessions). Filtering
    // here means the excluded tools are never registered with the agent loop, so
    // a hallucinated call can't mutate the repo — and buildSystemPrompt below is
    // fed the same filtered names so the Tools section matches exactly.
    this.tools = this.opts.allowedTools ? tools.filter((t) => this.isToolAllowed(t.name)) : tools;
    // Tier the built-ins: rarely reached schemas move into the tool_search
    // catalog and cost one hint line each instead of a full parameter schema on
    // every request. Allow-listed sessions keep the eager path — their fixed
    // tool expectations predate the catalog, and tool_search isn't allow-listed.
    if (!this.opts.allowedTools && this.settingsManager.get("deferredBuiltinTools")) {
      const { core, deferred } = partitionToolsByTier(this.tools);
      if (deferred.length > 0) {
        // Append-only: `core` preserves the original relative order and
        // tool_search is pushed after it, so the serialized tool block that
        // sits inside the cached prefix stays byte-stable across turns.
        this.tools = core;
        this.deferredBuiltinToolNames = deferred.map((t) => t.name);
        this.mcpCatalog ??= new DeferredToolCatalog(this.contextLimits);
        this.mcpCatalog.add(deferred);
        this.ensureToolSearchTool();
      }
    }
    this.rebuildReadTool = rebuildReadTool;
    this.processManager = processManager;
    this.lspManager = lspManager;
    this.subAgentManager = subAgentManager;
    this.bindManagerCancellation(this.opts.signal);

    // Connect MCP servers. The connect attempt itself can block for up to the
    // per-server connect timeout (~30s) — a slow stdio server such as a
    // first-run `npx -y @playwright/mcp` download stalls here. When the host
    // gates its own readiness on initialize() (the gg-app sidecar can't emit
    // its listening handshake until this resolves), `backgroundMcpConnect`
    // moves the connect off the critical path so the session becomes usable
    // immediately and tools are appended whenever the servers come up.
    this.mcpManager = new MCPClientManager({
      catalogCache: this.mcpCatalogCache,
      modernProtocol: this.settingsManager.get("mcpModernProtocol"),
      onElicit: this.opts.onMcpElicit,
    });
    if (this.opts.backgroundMcpConnect) {
      void this.connectMcpServers();
    } else {
      await this.connectMcpServers();
    }

    const basePrompt = await this.buildBasePrompt(false, undefined);
    this.baseSystemPrompt = basePrompt;
    this.messages = [{ role: "system", content: this.withSystemPromptTail(basePrompt) }];

    // Load or create session. Transient sessions (subagent spawns) never
    // touch the session store — sessionPath stays empty and persistMessage
    // is a no-op so their transcripts can't pollute `ggcoder continue`.
    if (this.opts.transient) {
      this.lastPersistedIndex = this.messages.length;
    } else if (this.opts.sessionId) {
      await this.loadExistingSession(this.opts.sessionId);
    } else if (this.opts.continueRecent) {
      const recentPath = await this.sessionManager.getMostRecent(this.cwd);
      if (recentPath) {
        await this.loadExistingSession(recentPath);
      } else {
        await this.createNewSession();
      }
    } else {
      await this.createNewSession();
    }
    if (this.sessionId) await this.subAgentManager?.hydrate(this.sessionId);

    // Maintenance is deliberately queued after initialization work and never
    // awaited, so retention/compression cannot delay sidecar or CLI readiness.
    if (!this.opts.transient) {
      const retentionDays = this.settingsManager.get("sessionRetentionDays");
      void Promise.resolve()
        .then(() =>
          this.sessionManager.runMaintenance({
            retentionDays,
            keepPaths: this.sessionPath ? [this.sessionPath] : [],
          }),
        )
        .then((metrics) => {
          if (metrics.deletedFiles > 0 || metrics.archivedFiles > 0 || metrics.failures > 0) {
            log("INFO", "session", "Session maintenance complete", {
              deletedFiles: String(metrics.deletedFiles),
              deletedMB: (metrics.deletedBytes / 1024 / 1024).toFixed(1),
              archivedFiles: String(metrics.archivedFiles),
              savedMB: (metrics.bytesSaved / 1024 / 1024).toFixed(1),
              failures: String(metrics.failures),
            });
          }
        })
        .catch((error) => {
          log("WARN", "session", "Session maintenance failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }
    // GG Coder owns its command registry. Other agents start with an isolated
    // empty registry and can register their own commands in their own file.
    if (this.opts.coderSlashCommands !== false) {
      const builtins = createBuiltinCommands();
      for (const cmd of builtins) this.slashCommands.register(cmd);

      // Wire up /help to show all registered + prompt + custom commands.
      const helpCmd = this.slashCommands.get("help");
      if (helpCmd) {
        const registry = this.slashCommands;
        const cwd = this.cwd;
        helpCmd.execute = async () => {
          const all = registry.getAll();
          const lines = all.map(
            (c) =>
              `  /${c.name}${c.aliases.length ? ` (${c.aliases.map((a) => "/" + a).join(", ")})` : ""} — ${c.description}`,
          );

          if (PROMPT_COMMANDS.length > 0) {
            lines.push("", "Prompt commands:");
            for (const cmd of PROMPT_COMMANDS) {
              lines.push(
                `  /${cmd.name}${cmd.aliases.length ? ` (${cmd.aliases.map((a) => "/" + a).join(", ")})` : ""} — ${cmd.description}`,
              );
            }
          }

          const customCmds = await loadCustomCommands(cwd);
          if (customCmds.length > 0) {
            lines.push("", "Custom commands:");
            for (const cmd of customCmds) lines.push(`  /${cmd.name} — ${cmd.description}`);
          }
          return "Available commands:\n" + lines.join("\n");
        };
      }
    }

    if (this.opts.loadExtensions !== false) {
      const extContext: ExtensionContext = {
        eventBus: this.eventBus,
        registerTool: (tool) => this.tools.push(tool),
        registerSlashCommand: (cmd) => this.slashCommands.register(cmd),
        cwd: this.cwd,
        settingsManager: this.settingsManager,
      };
      await this.extensionLoader.loadAll(paths.extensionsDir, extContext);
    }

    this.eventBus.emit("session_start", { sessionId: this.sessionId });
  }

  /**
   * Whether a tool name is permitted for this session. With no `allowedTools`
   * everything passes (default behavior). Otherwise a tool is allowed when its
   * name is in `allowedTools`, OR it's an MCP tool (`mcp__<server>__<tool>`)
   * whose `<server>` is in `allowedMcpServers`. The MCP-prefix rule lets a
   * whitelisted research server (e.g. kencode-search) expose all its tools
   * without hard-coding each one, while every other tool stays blocked.
   */
  private isToolAllowed(name: string): boolean {
    const allowed = this.opts.allowedTools;
    if (!allowed) return true;
    if (allowed.includes(name)) return true;
    const mcpWhitelist = this.opts.allowedMcpServers;
    if (mcpWhitelist && name.startsWith("mcp__")) {
      const server = name.slice("mcp__".length).split("__")[0];
      return mcpWhitelist.includes(server);
    }
    return false;
  }

  /**
   * Connect all configured MCP servers and append their tools to `this.tools`.
   * Resolves the GLM api key first (Z.AI's bundled servers need it). Never
   * throws — a failed connect is logged and skipped — so it is safe to either
   * `await` (CLI: tools ready before the first turn) or fire-and-forget
   * (sidecar: `backgroundMcpConnect`, so a slow stdio server can't stall
   * startup). Tools are pushed onto the live array the agent loop reads each
   * turn, so background-connected servers become available on the next prompt.
   */
  private async connectMcpServers(): Promise<void> {
    if (!this.mcpManager) return;
    // Allow-listed (read-only advisory) sessions enforce a fixed tool set by
    // name. An MCP server is only connected when its name is explicitly
    // whitelisted via `allowedMcpServers` (the Ken mentor agent does this for
    // `kencode-search` so it can research real code). With no whitelist, skip
    // MCP entirely — dynamic `mcp__server__tool` names could never match a fixed
    // allow-list, and connecting would waste resources spawning stdio servers.
    const mcpWhitelist = this.opts.allowedMcpServers;
    if (this.opts.allowedTools && (!mcpWhitelist || mcpWhitelist.length === 0)) return;
    try {
      let apiKey: string | undefined;
      if (this.provider === "glm") {
        try {
          const glmCreds = await this.authStorage.resolveCredentials("glm");
          apiKey = glmCreds.accessToken;
        } catch {
          // GLM not configured — skip Z.AI MCP servers
        }
      }
      let servers = await getAllMcpServers(this.provider, apiKey, this.cwd, {
        allowProjectScope: this.settingsManager.isProjectTrusted(this.cwd),
      });
      // Whitelisted allow-listed session: connect ONLY the named servers, never
      // the user's full configured set (which could include mutating tools). The
      // whitelist only restricts in allow-list mode (the documented contract) so
      // a normal session is never affected by a stray allowedMcpServers.
      if (this.opts.allowedTools && mcpWhitelist) {
        servers = servers.filter((s) => mcpWhitelist.includes(s.name));
      }
      // Seed the catalog from the on-disk cache BEFORE connecting. With
      // `backgroundMcpConnect` the first turns would otherwise run against an
      // empty catalog and tool_search would answer "the catalog is empty" for
      // capabilities that genuinely exist — a wrong answer, not a slow one.
      await this.seedMcpCatalogFromCache(servers);

      const connected = await this.mcpManager.connectAll(servers);
      // Defense-in-depth: even from a whitelisted server, only push tools that
      // pass the allow-list (no-op when there's no allow-list).
      const mcpTools = this.opts.allowedTools
        ? connected.filter((t) => this.isToolAllowed(t.name))
        : connected;
      this.addMcpTools(mcpTools);
      // Background connect resolves AFTER initialize() has already built the
      // system prompt (the default path awaits this before buildSystemPrompt,
      // so its prompt already lists the tools). Refresh messages[0] so the
      // model is also told about the MCP tools by name on its next turn —
      // mirrors the TUI's replaceSystemPrompt after connectInitialMcpTools.
      // Safe ordering: this method's first await yields before initialize()
      // sets `messages`, and connectAll (process spawn / network) always
      // resolves long after the local-only remainder of init has finished.
      if (this.opts.backgroundMcpConnect && mcpTools.length > 0) {
        await this.rebuildSystemPromptInPlace();
      }
      // Detect project-scope servers excluded because the repo isn't trusted,
      // so the host can offer a per-repo "Trust" button. Computed after the
      // connect so the blocked list reflects the same connect attempt.
    } catch (err) {
      log(
        "WARN",
        "mcp",
        `MCP initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Persist `cwd` as a trusted project for project-scope MCP. Called by the
   *  sidecar's `/mcp/add` handler when a user adds a project-scope server via
   *  the MCP modal — the explicit add is itself the trust signal. The next
   *  session load connects its `.gg/mcp.json` servers. */
  async trustProject(cwd: string): Promise<void> {
    await this.settingsManager.trustProject(cwd);
  }

  /**
   * Route freshly connected MCP tools: deferred into the tool_search catalog
   * (default — keeps ~8k tokens of schema out of every cache-miss turn) or
   * pushed eagerly when the user opted out.
   * Allow-listed sessions (Ken) always get the eager path — their fixed tool
   * expectations predate the catalog, and tool_search isn't allow-listed.
   * Promotion pushes onto the live `this.tools` array the running agent loop
   * re-reads every turn, so promoted tools are callable on the next step.
   */
  private addMcpTools(mcpTools: AgentTool[]): void {
    if (mcpTools.length === 0) return;
    for (const tool of mcpTools) {
      this.liveMcpTools.set(tool.name, tool);
      this.cachedMcpToolServers.delete(tool.name);
    }
    const defer = !this.opts.allowedTools && this.settingsManager.get("deferredMcpTools");
    if (!defer) {
      // Eager path bypasses the catalog, so budget descriptions here too.
      this.replaceOrPushTools(
        mcpTools.map((tool) => clampMcpToolDescription(tool, this.contextLimits)),
      );
      return;
    }
    this.mcpCatalog ??= new DeferredToolCatalog(this.contextLimits);
    // `add` is name-keyed, so live definitions replace cached stubs in place.
    this.mcpCatalog.add(mcpTools);
    // A stub the model already promoted lives in `this.tools`; swap it for the
    // live tool so later calls dispatch directly instead of through the stub.
    this.replaceLivePromotedTools(mcpTools);
    this.ensureToolSearchTool();
  }

  /**
   * Register `tool_search` once. Promotion of a cached-only entry waits for its
   * server so the model is told immediately when that capability turns out to
   * be unreachable, instead of promoting a tool that fails on first call.
   *
   * The catalog is created on demand rather than required up front: deferred
   * built-in tools populate it with zero MCP servers connected, so gating
   * registration on an existing catalog would leave those tools unreachable.
   */
  private ensureToolSearchTool(): void {
    this.mcpCatalog ??= new DeferredToolCatalog(this.contextLimits);
    if (this.tools.some((t) => t.name === "tool_search")) return;
    this.tools.push(
      createToolSearchTool(
        this.mcpCatalog,
        (promoted) => {
          this.tools.push(...promoted);
        },
        async (toolName) => {
          if (this.liveMcpTools.has(toolName)) return undefined;
          const serverName = this.cachedMcpToolServers.get(toolName);
          if (!serverName) return undefined;
          const outcome = (await this.mcpManager?.whenConnected(serverName)) ?? {
            ok: false as const,
            error: "MCP is disabled for this session",
          };
          return outcome.ok
            ? { serverName, ok: true }
            : { serverName, ok: false, error: outcome.error };
        },
        this.contextLimits,
      ),
    );
  }

  /** Append tools, replacing any same-named entry (cached stub → live tool). */
  private replaceOrPushTools(tools: AgentTool[]): void {
    for (const tool of tools) {
      const index = this.tools.findIndex((t) => t.name === tool.name);
      if (index >= 0) this.tools[index] = tool;
      else this.tools.push(tool);
    }
  }

  /** Swap already-promoted cached stubs for their live equivalents, in place. */
  private replaceLivePromotedTools(tools: AgentTool[]): void {
    for (const tool of tools) {
      const index = this.tools.findIndex((t) => t.name === tool.name);
      if (index >= 0) this.tools[index] = tool;
    }
  }

  /**
   * Publish cached tool definitions into the deferred catalog so `tool_search`
   * answers correctly on turn 1. A cached stub carries the real name, one-line
   * description and input schema; calling it waits for the live connection and
   * then dispatches against the real client, or returns a clear error when that
   * server ultimately failed. Live tools replace stubs on connect.
   */
  private async seedMcpCatalogFromCache(servers: MCPServerConfig[]): Promise<void> {
    if (!this.opts.backgroundMcpConnect) return;
    if (this.opts.allowedTools || !this.settingsManager.get("deferredMcpTools")) return;
    let entries: Awaited<ReturnType<McpCatalogCache["entriesFor"]>>;
    try {
      entries = await this.mcpCatalogCache.entriesFor(servers);
    } catch {
      return;
    }
    const stubs: AgentTool[] = [];
    for (const [serverName, entry] of entries) {
      for (const cached of entry.tools) {
        if (this.liveMcpTools.has(cached.name)) continue;
        this.cachedMcpToolServers.set(cached.name, serverName);
        stubs.push(this.buildCachedMcpTool(serverName, cached));
      }
    }
    if (stubs.length === 0) return;
    log("INFO", "mcp", "Seeded deferred tool catalog from cache", {
      tools: String(stubs.length),
      servers: String(entries.size),
    });
    this.addCachedMcpTools(stubs);
  }

  /** Catalog-only registration for cached stubs — never marks them live. */
  private addCachedMcpTools(stubs: AgentTool[]): void {
    this.mcpCatalog ??= new DeferredToolCatalog(this.contextLimits);
    this.mcpCatalog.add(stubs);
    this.ensureToolSearchTool();
  }

  private buildCachedMcpTool(serverName: string, cached: CachedTool): AgentTool {
    return {
      name: cached.name,
      description: cached.description,
      parameters: z.record(z.string(), z.unknown()),
      rawInputSchema: cached.rawInputSchema,
      execute: async (args, context) => {
        const live = this.liveMcpTools.get(cached.name);
        if (live) return live.execute(args, context);
        const outcome = (await this.mcpManager?.whenConnected(serverName)) ?? {
          ok: false as const,
          error: "MCP is disabled for this session",
        };
        if (!outcome.ok) {
          return (
            `MCP tool ${cached.name} is unavailable: server "${serverName}" did not connect ` +
            `(${outcome.error}). This tool was offered from a cached catalog. ` +
            `Use a different approach or ask the user to check their MCP configuration.`
          );
        }
        const connected = this.liveMcpTools.get(cached.name);
        if (!connected) {
          return (
            `MCP tool ${cached.name} no longer exists: server "${serverName}" connected but ` +
            `does not expose it. The cached catalog entry was stale.`
          );
        }
        return connected.execute(args, context);
      },
    };
  }

  /**
   * Resolve a `/name [args]` input to the prompt template it expands into, or
   * null when it isn't a prompt-template command for THIS session (an ordinary
   * message, a registry/action command, or any slash input on a non-coder
   * agent). Shared by {@link prompt} and {@link willExpandPromptTemplate} so
   * callers can't drift from the expansion that actually happens.
   */
  private async resolveSlashInput(
    content: string,
  ): Promise<{ kind: "template"; fullPrompt: string } | { kind: "command" } | null> {
    const parsedInput = this.slashCommands.parse(content);
    const coderCommands = this.opts.coderSlashCommands !== false;
    // Non-coder agents only intercept commands registered in their own registry.
    // Unknown `/text` stays a normal conversational prompt.
    const parsed =
      parsedInput && (coderCommands || this.slashCommands.get(parsedInput.name))
        ? parsedInput
        : null;
    if (!parsed) return null;
    // GG Coder alone can resolve its prompt-template and project commands.
    const builtinPromptCmd = coderCommands ? getPromptCommand(parsed.name) : undefined;
    const customCmds = coderCommands ? await loadCustomCommands(this.cwd) : [];
    const customPromptCmd = !builtinPromptCmd
      ? customCmds.find((c) => c.name === parsed.name)
      : undefined;
    const promptText = builtinPromptCmd?.prompt ?? customPromptCmd?.prompt;
    // No template body — a registry/action command that runs and returns text
    // instead of becoming a user message.
    if (!promptText) return { kind: "command" };
    return {
      kind: "template",
      fullPrompt: parsed.args
        ? `${promptText}\n\n## User Instructions\n\n${parsed.args}`
        : promptText,
    };
  }

  /**
   * Whether {@link prompt} would expand this input into a template body and
   * persist it as a user message. Hosts use it to record the typed `/name` for
   * transcript restore — gating on anything looser risks tagging an unrelated
   * message when the command turns out NOT to expand.
   */
  async willExpandPromptTemplate(content: string): Promise<boolean> {
    return (await this.resolveSlashInput(content))?.kind === "template";
  }

  /**
   * Process user input. Handles slash commands or runs agent loop.
   */
  async prompt(
    content: string,
    provenance: MessageProvenance = {
      source: "human",
      kind: "prompt",
      visibility: "transcript",
    },
    options: { disableTools?: boolean } = {},
  ): Promise<void> {
    await this.adoptDeferredCheckpointBeforePrompt();
    const slash = await this.resolveSlashInput(content);
    if (slash?.kind === "template") {
      // Prompt templates remain human-originated: the user invoked the command.
      const userMessage: Message = { role: "user", content: slash.fullPrompt, provenance };
      this.messages.push(userMessage);
      await this.persistMessage(userMessage);
      this.lastPersistedIndex = this.messages.length;
      await this.runLoop(options);
      return;
    }
    if (slash?.kind === "command") {
      const cmdContext = this.createSlashCommandContext();
      const result = await this.slashCommands.execute(content, cmdContext);
      if (result) {
        this.eventBus.emit("text_delta", { text: result + "\n" });
      }
      return;
    }

    // Push user message
    const userMessage: Message = { role: "user", content, provenance };
    this.messages.push(userMessage);
    await this.persistMessage(userMessage);
    this.lastPersistedIndex = this.messages.length;

    await this.runLoop(options);
  }

  /**
   * Prompt with multimodal attachments (images / videos) alongside optional
   * text. Images and videos become native content blocks the model can see;
   * non-media files are surfaced as a text note with their saved path so the
   * agent can open them with its tools. Slash-command parsing is skipped —
   * attachments are always a direct conversational turn.
   */
  async promptWithAttachments(text: string, attachments: SessionAttachment[]): Promise<void> {
    await this.adoptDeferredCheckpointBeforePrompt();
    const parts = this.buildAttachmentParts(text, attachments);
    if (parts.length === 0) return;
    const userMessage: Message = {
      role: "user",
      content: parts,
      provenance: { source: "human", kind: "prompt", visibility: "transcript" },
    };
    this.messages.push(userMessage);
    await this.persistMessage(userMessage);
    this.lastPersistedIndex = this.messages.length;
    await this.runLoop();
  }

  /**
   * Build the native content blocks (text + image/video notes + file notes) for
   * a user message with attachments. Shared by {@link promptWithAttachments} and
   * the mid-run steering drain so queued media is delivered identically.
   */
  private buildAttachmentParts(
    text: string,
    attachments: SessionAttachment[],
  ): Array<TextContent | ImageContent | VideoContent> {
    const parts: Array<TextContent | ImageContent | VideoContent> = [];
    const fileNotes: string[] = [];
    const modelInfo = getModel(this.model);
    const modelSupportsVideo = modelInfo?.supportsVideo ?? false;
    // GLM only: GLM models have no native image input, but the GLM session is
    // the only one with the zai_vision MCP server connected (core/mcp/defaults.ts).
    // Point at the real tool instead of an inline image the provider layer would
    // blank into a placeholder. Every other provider keeps inline images.
    const glmImageHint = this.provider === "glm" && modelInfo?.supportsImages === false;
    for (const a of attachments) {
      if (a.kind === "image") {
        if (glmImageHint && a.path) {
          parts.push({
            type: "text",
            text:
              `[User attached an image saved at: ${a.path} — analyze it with the ` +
              `mcp__zai_vision__analyze_image tool (if that tool is not available yet, ` +
              `call tool_search with "analyze image" to unlock it first, then call it with image_source=${a.path})]`,
          });
        } else {
          parts.push({ type: "image", mediaType: a.mediaType, data: a.data });
          if (a.path) {
            parts.push({ type: "text", text: `[Image saved at ${a.path}]` });
          }
        }
      } else if (a.kind === "video") {
        // Mirror the CLI's buildUserContentWithAttachments: never send inline
        // VideoContent in the user message. Video-capable models (Kimi/Gemini/
        // MiniMax) watch video via the read tool, which auto-compresses to the
        // model's byte cap and delivers it in the provider's required shape.
        // Non-video models get a plain note so they know to use ffmpeg. The file
        // was already saved to disk by prepareAttachments in the sidecar.
        if (modelSupportsVideo && a.path) {
          parts.push({
            type: "text",
            text:
              `The user attached a video at ${a.path}. You CAN watch it: call the read tool ` +
              `on this exact path now, then answer based on what you see. Do not say you ` +
              `cannot watch video — reading the file lets you analyze it.`,
          });
        } else if (a.path) {
          parts.push({
            type: "text",
            text:
              `[User attached a video file at ${a.path}. You cannot watch video directly; ` +
              `if needed, use ffmpeg to extract frames or audio.]`,
          });
        } else {
          parts.push({
            type: "text",
            text: `[User attached a video file but it could not be saved for analysis.]`,
          });
        }
      } else if (a.path) {
        fileNotes.push(`- ${a.name} (saved at ${a.path})`);
      }
    }
    const textParts: string[] = [];
    if (text.trim()) textParts.push(text.trim());
    if (fileNotes.length > 0) {
      textParts.push(`Attached files (inspect with your tools):\n${fileNotes.join("\n")}`);
    }
    if (textParts.length > 0) parts.unshift({ type: "text", text: textParts.join("\n\n") });
    return parts;
  }

  /**
   * Reset per-run self-correction hook state. Mirrors the TUI's run_start
   * resets so each run evaluates the hooks from a clean slate. `originalRequest`
   * is the verbatim user ask, pinned for post-compaction re-grounding.
   */
  private resetHookState(originalRequest: string): void {
    this.hookStats = {
      changedLines: 0,
      toolCalls: 0,
      toolFailures: 0,
      turns: 0,
      writeCalls: 0,
      editCalls: 0,
      bashCalls: 0,
    };
    this.hookText = "";
    this.hookConsecutiveFailures = 0;
    this.hookRepeatedNoProgressCalls = 0;
    this.hookProgressTracker.reset();
    this.hookCycleDetector.reset();
    this.hookCyclicPattern = null;
    this.hookFileEditCounts.clear();
    this.hookToolCalls.clear();
    this.reviewCoverage.reset();
    this.reviewCoverageInjected = 0;
    this.idealReviewPhase = "idle";
    // No event here: clients reset their own hold on run_start.
    this.idealReviewArmed = false;
    this.verificationArmed = false;
    this.idealDriftProbe = null;
    this.loopBreakInjected = 0;
    this.regroundingInjected = false;
    this.runStartedAt = Date.now();
    this.processGateInjected = 0;
    this.verificationGate.reset();
    this.compactionOccurred = false;
    this.originalRequest = originalRequest;
  }

  /**
   * Fold one agent event into the hook stat accumulators. Pure bookkeeping —
   * the same signals the TUI's useAgentLoop collects, so the loop-break and
   * ideal-review decisions match across the CLI and the app.
   */
  private async trackHookEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "text_delta":
        this.hookText += event.text;
        break;
      case "tool_call_start":
        this.hookToolCalls.set(event.toolCallId, { name: event.name, args: event.args ?? {} });
        break;
      case "tool_call_end": {
        const call = this.hookToolCalls.get(event.toolCallId);
        const name = call?.name ?? "";
        const args = call?.args;
        this.hookStats.toolCalls += 1;
        if (event.isError) this.hookStats.toolFailures += 1;
        if (name === "write") this.hookStats.writeCalls += 1;
        if (name === "edit") this.hookStats.editCalls += 1;
        if (name === "bash") this.hookStats.bashCalls += 1;
        this.hookConsecutiveFailures = event.isError ? this.hookConsecutiveFailures + 1 : 0;
        this.hookRepeatedNoProgressCalls = this.hookProgressTracker.record(
          name,
          args,
          event.result,
          event.isError,
        );
        this.hookCyclicPattern = this.hookCycleDetector.record(
          name,
          args,
          event.result,
          event.isError,
        );
        if (name === "edit" && !event.isError) {
          const diff = (event.details as { diff?: string } | undefined)?.diff ?? event.result;
          const added = (diff.match(/^\+[^+]/gm) ?? []).length;
          const removed = (diff.match(/^-[^-]/gm) ?? []).length;
          this.hookStats.changedLines += added + removed;
        }
        // Verification-gate bookkeeping: successful code mutations and completed
        // foreground verification commands, in occurrence order.
        if (!event.isError && args) {
          if (name === "edit" || name === "write") {
            const filePath = String((args as { file_path?: unknown }).file_path ?? "");
            // Check-owning files (tsconfig.json, pytest.ini, vitest.config.ts …)
            // are tracked even when they are not source code: editing one is how
            // a red suite is turned green without fixing anything.
            if (filePath && (isCodeFilePath(filePath) || isCheckOwnFile(filePath))) {
              const addedText =
                name === "write"
                  ? String((args as { content?: unknown }).content ?? "")
                  : extractAddedLines(
                      (event.details as { diff?: string } | undefined)?.diff ?? event.result,
                    );
              this.verificationGate.recordMutation(filePath, addedText);
            }
          }
          if (
            name === "bash" &&
            !(args as { run_in_background?: unknown }).run_in_background &&
            isVerificationCommand(String((args as { command?: unknown }).command ?? ""))
          ) {
            this.verificationGate.recordVerification();
          }
          // Reading the final output of an EXITED background verification run
          // counts: the process gate forces this read anyway, so without it the
          // gate would demand a redundant foreground re-run of tests the agent
          // already watched finish.
          if (name === "task_output") {
            const proc = this.processManager
              ?.list()
              .find((p) => p.id === (args as { id?: unknown }).id);
            if (proc && proc.exitCode !== null && isVerificationCommand(proc.command)) {
              this.verificationGate.recordVerification();
            }
          }
        }
        // Tool results are what push the run over the review gate, and they all
        // land before the model writes its candidate final answer — so this is
        // the point where arming still beats the draft's first token.
        this.refreshHookArming();
        break;
      }
      case "turn_end":
        this.hookStats.turns = event.turn;
        this.refreshHookArming();
        for (let index = this.messages.length - 1; index >= 0; index--) {
          const anchor = this.messages[index];
          if (anchor?.role === "assistant") {
            this.providerContext = { usage: { ...event.usage }, anchor };
            break;
          }
        }
        await this.persistTurnMetric(event);
        // The assistant message for this turn is now in the array.
        await this.flushPendingMessages();
        break;
      case "checkpoint":
        // Tool results for this step are in the array and their side effects
        // already hit the filesystem. Flushing here is what makes a crash lose
        // at most the in-flight step instead of the entire turn.
        await this.flushPendingMessages();
        break;
    }
  }

  /**
   * Append every message added since the last flush to the session file.
   *
   * Safe to call mid-run: `agentLoop` mutates its message array in place, so
   * the slice from `lastPersistedIndex` is always exactly the new tail.
   * Transient sessions (subagent spawns) have no session file and
   * `persistMessage` no-ops for them.
   *
   * Persistence failures must never take down a live run — the post-loop flush
   * retries the same range.
   */
  private async flushPendingMessages(): Promise<void> {
    const messages = this.activeLoopMessages ?? this.messages;
    if (this.lastPersistedIndex >= messages.length) return;
    const target = messages.length;
    try {
      for (let i = this.lastPersistedIndex; i < target; i++) {
        await this.persistMessage(messages[i]);
        this.lastPersistedIndex = i + 1;
      }
    } catch (err) {
      log("WARN", "session", "Failed to flush messages at a step boundary", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Mid-loop steering hook: delivers pushed notifications and queued user
   * steering, fires the loop-breaker when the agent looks stuck, then
   * post-compaction re-grounding. At most one loop-break/re-grounding per run.
   * Mirrors the TUI's getSteeringMessages ordering.
   */
  private getHookSteeringMessages(): Message[] | null {
    // Environment drift: settings can move the network allowlist mid-session
    // with no prompt rebuild, leaving the cached Environment section describing
    // hosts that are no longer the real policy. Correcting it by appending is
    // ~30 tokens; re-rendering the prompt would invalidate every cached byte
    // from that section onward. Unconditional and cheap: identical facts
    // produce no message at all.
    // A verbatim custom prompt has no Environment section to correct, so a
    // note pointing at one would describe something the model cannot see.
    const environmentDelta = this.customSystemPrompt
      ? null
      : buildEnvDeltaMessage(this.renderedEnvironment, this.promptEnvironment());
    if (environmentDelta) {
      // The model has now been told; only a further change re-triggers this.
      this.renderedEnvironment = this.promptEnvironment();
      log("INFO", "session", "Injecting an environment update the prompt is too stale to show");
    }

    // Push notifications: a child that finished or a background build that
    // exited is new *fact*, not a correction, and it is cheap (bounded to 1 KiB
    // per drain). Drained above the loop-break checks so the agent can act on
    // it in the very next turn instead of discovering it at the pre-stop
    // completion gate — but it never displaces user steering, which rides out
    // in the same batch when both are pending.
    const notified = this.notifications.drain();
    const notificationMessage: Message | null =
      notified.length > 0
        ? {
            role: "user",
            content: buildNotificationSteeringText(notified.map((entry) => entry.text)),
            provenance: { source: "runtime", kind: "notification", visibility: "hidden" },
          }
        : null;
    if (notificationMessage) {
      log("INFO", "notifications", "Injecting pushed notifications", {
        count: String(notified.length),
        chars: String(notificationMessage.content.length),
      });
    }

    // User steering wins: drain any messages queued during this run first so the
    // agent sees them mid-loop instead of after it stops.
    if (this.userQueue.length > 0) {
      const queued = this.userQueue.splice(0);
      // The agent has now consumed these. Announce the new depth immediately so
      // clients can drop the "queued" affordance at the turn boundary rather
      // than holding it until the whole run ends — the message is already in
      // the loop, and showing it as still-pending for minutes is a lie.
      this.eventBus.emit("queue_drained", { count: this.userQueue.length });
      // Frame each queued item as concurrent steering — without this wrapper
      // the model treats a mid-run message as a fresh request that supersedes
      // the original task and silently drops it. ONE message per queued item
      // (not merged): each persists as its own user message, so a resumed
      // session shows the same number of bubbles the live run did.
      const steeringMessages = queued.map((m): Message => {
        const provenance: MessageProvenance = {
          source: "human",
          kind: "steering",
          visibility: "transcript",
        };
        if (m.attachments.length === 0) {
          return { role: "user", content: wrapSteeringText(m.text), provenance };
        }
        // Queued attachments ride the same native-block path as a non-queued
        // attachment prompt, prefixed with the steering framing.
        const parts: Array<TextContent | ImageContent | VideoContent> = [
          { type: "text", text: STEERING_PREFIX },
          ...this.buildAttachmentParts(m.text, m.attachments),
        ];
        return { role: "user", content: parts, provenance };
      });
      return [
        ...(environmentDelta ? [environmentDelta] : []),
        ...steeringMessages,
        ...(notificationMessage ? [notificationMessage] : []),
      ];
    }
    if (environmentDelta || notificationMessage) {
      return [
        ...(environmentDelta ? [environmentDelta] : []),
        ...(notificationMessage ? [notificationMessage] : []),
      ];
    }
    if (this.opts.selfCorrectionHooks === false) return null;
    if (!this.settingsManager.get("idealReviewEnabled")) return null;
    // Two-stage loop-breaker: stage 1 nudges; a FRESH detection after that
    // injects the harsher final stop-and-report prompt. Signals reset after
    // each injection so stage 2 only fires on new evidence.
    if (this.loopBreakInjected < 2) {
      const decision = evaluateLoopBreak({
        consecutiveFailures: this.hookConsecutiveFailures,
        repeatedNoProgressCalls: this.hookRepeatedNoProgressCalls,
        textRepetitionDetected: detectTextRepetition(this.hookText),
        ...(this.hookCyclicPattern ? { cyclicPattern: this.hookCyclicPattern } : {}),
      });
      if (decision.shouldBreak) {
        const stage = this.loopBreakInjected === 0 ? (1 as const) : (2 as const);
        this.loopBreakInjected = stage;
        this.hookProgressTracker.reset();
        this.hookCycleDetector.reset();
        this.hookCyclicPattern = null;
        this.hookConsecutiveFailures = 0;
        this.hookRepeatedNoProgressCalls = 0;
        // Clear the text buffer too — otherwise a stage-1 text-repetition
        // trigger still sees the same repeated tail on the next check and
        // escalates to stage 2 on stale evidence.
        this.hookText = "";
        log("INFO", "loop-break", "Injecting loop-break nudge", {
          stage: String(stage),
          reasons: decision.reasons.join(", "),
        });
        this.eventBus.emit("hook", { kind: "loop_break" });
        return [buildLoopBreakMessage(decision.reasons, stage === 2)];
      }
    }
    if (!this.regroundingInjected && this.compactionOccurred) {
      this.regroundingInjected = true;
      this.eventBus.emit("hook", { kind: "regrounding" });
      return [buildRegroundingMessage(this.originalRequest)];
    }
    return null;
  }

  /**
   * Turn-budget extension gate. The loop consults this instead of stopping
   * mid-task when it exhausts `maxTurns`. Grant ONLY on evidence of progress —
   * handing more turns to a spinning agent just buys it more tokens to spin
   * with — so reuse the same stuck signals that drive the loop-breaker.
   */
  private shouldExtendTurnBudget(ctx: {
    turn: number;
    maxTurns: number;
    extension: number;
  }): boolean {
    const refusals: string[] = [];

    const stuck = evaluateLoopBreak({
      consecutiveFailures: this.hookConsecutiveFailures,
      repeatedNoProgressCalls: this.hookRepeatedNoProgressCalls,
      textRepetitionDetected: detectTextRepetition(this.hookText),
      ...(this.hookCyclicPattern ? { cyclicPattern: this.hookCyclicPattern } : {}),
    });
    if (stuck.shouldBreak) refusals.push(...stuck.reasons);

    // Stage 2 means the loop-breaker already detected spinning twice and told
    // the agent to stop and report. Do not overrule that with more turns.
    if (this.loopBreakInjected >= 2) refusals.push("loop-breaker already escalated");

    const { toolCalls, toolFailures } = this.hookStats;
    if (toolCalls > 0 && toolFailures / toolCalls > TURN_EXTENSION_MAX_FAILURE_RATIO) {
      refusals.push(`${toolFailures}/${toolCalls} tool calls failed`);
    }

    const granted = refusals.length === 0;
    log(
      "INFO",
      "turn-budget",
      granted ? "Extending turn budget" : "Refusing turn-budget extension",
      {
        turn: String(ctx.turn),
        maxTurns: String(ctx.maxTurns),
        extension: String(ctx.extension),
        ...(granted ? {} : { reasons: refusals.join(", ") }),
      },
    );
    return granted;
  }

  /**
   * Would the stop AFTER the current turn inject the Ideal review? Same inputs
   * as the pre-stop gate below, evaluated early so clients know a candidate
   * final answer is a review draft BEFORE it streams.
   *
   * The turn count is looked ahead by one on purpose. `hookStats.turns` only
   * advances at `turn_end`, so while the model is writing the draft the counter
   * still reads the PREVIOUS turn; the real gate sees one more. Without the
   * lookahead a run sitting on score 3 crosses to 4 on the draft's own
   * `turn_end` — after the text already streamed — which is precisely the
   * appear-then-vanish flash. Over-arming by one turn point costs only live
   * token streaming on a final answer that then shows whole; under-arming costs
   * the flash, so this errs toward arming.
   */
  private wouldInjectIdealReview(): boolean {
    if (this.opts.selfCorrectionHooks === false || this.idealReviewSuppressed) return false;
    if (this.idealReviewPhase !== "idle") return false;
    if (!this.settingsManager.get("idealReviewEnabled")) return false;
    if (evaluateIdealReview({ ...this.hookStats, turns: this.hookStats.turns + 1 }).shouldReview) {
      return true;
    }
    const files = this.hookFileEditCounts.size;
    if (files === 0) return false;
    if (this.idealDriftProbe?.files !== files) {
      this.idealDriftProbe = {
        files,
        drifted: detectTestDrift(this.hookFileEditCounts.keys(), this.cwd).length > 0,
      };
    }
    return this.idealDriftProbe.drifted;
  }

  /** Would a stop right now inject the verification gate? Same conditions as
   *  the pre-stop branch below, so arming and injection cannot disagree. */
  private wouldInjectVerification(): boolean {
    if (this.opts.selfCorrectionHooks === false) return false;
    if (!this.settingsManager.get("verificationGateEnabled")) return false;
    if (this.opts.allowedTools && !this.opts.allowedTools.includes("bash")) return false;
    return this.verificationGate.willInject();
  }

  /** Broadcast pre-final hook arming on change. Both edges matter: armed=false
   *  after the hook fires is what lets a client stream the REVIEWED final
   *  answer live again.
   *
   *  Callable before `initialize()`: the sidecar sets Ken's review suppression
   *  on a freshly constructed session, and every arming predicate below reads
   *  settings that `initialize()` has not loaded yet. Nothing can be armed
   *  before the session can run a turn, and the first `tool_result`/`turn_end`
   *  recomputes both edges — so skipping is the correct answer, not a patch. */
  private refreshHookArming(): void {
    if (!this.settingsManager) return;
    this.refreshIdealReviewArmed();
    const armed = this.wouldInjectVerification();
    if (armed === this.verificationArmed) return;
    this.verificationArmed = armed;
    this.eventBus.emit("hook_armed", { kind: "verification", armed });
  }

  private refreshIdealReviewArmed(): void {
    const armed = this.wouldInjectIdealReview();
    if (armed === this.idealReviewArmed) return;
    this.idealReviewArmed = armed;
    this.eventBus.emit("hook_armed", { kind: "ideal", armed });
  }

  /**
   * Pre-stop Ideal review phase machine. Once review starts, completion is
   * blocked until harness-owned post-injection reads cover every changed file.
   */
  private getHookFollowUpMessages(): Message[] | null {
    const childCompletionFollowUp = buildSubAgentCompletionFollowUp(this.subAgentManager);
    if (childCompletionFollowUp) return childCompletionFollowUp;

    // Background processes started this run and never read block completion:
    // their progress/exit checkpoints only land on the steering path, which an
    // agent about to stop never reaches.
    const processFollowUp = buildProcessCompletionFollowUp(
      this.processManager?.list() ?? [],
      this.runStartedAt,
      this.processGateInjected,
    );
    if (processFollowUp) {
      this.processGateInjected += 1;
      log("INFO", "process-gate", "Injecting background-process completion gate", {
        injected: String(this.processGateInjected),
      });
      return processFollowUp;
    }

    // Verification gate: code was edited but nothing verified since the last
    // edit. Above the Ideal review so checks RUN before the read-based review
    // starts; off for allow-listed sessions that cannot run commands at all.
    if (
      this.opts.selfCorrectionHooks !== false &&
      this.settingsManager.get("verificationGateEnabled") &&
      (!this.opts.allowedTools || this.opts.allowedTools.includes("bash"))
    ) {
      const verificationFollowUp = this.verificationGate.followUp();
      if (verificationFollowUp) {
        log("INFO", "verification-gate", "Injecting verification follow-up", {});
        // Announce, THEN disarm: clients release held text on disarm, so the
        // reverse order paints the draft and immediately deletes it — the exact
        // flash arming exists to prevent.
        this.eventBus.emit("hook", { kind: "verification" });
        this.refreshHookArming();
        return verificationFollowUp;
      }
    }

    if (this.opts.selfCorrectionHooks === false || this.idealReviewSuppressed) return null;

    if (this.idealReviewPhase === "reviewing") {
      const coverage = this.reviewCoverage.evidence();
      const lspEvidence = this.reviewLspEvidence(coverage.expected);
      log("INFO", "ideal", "Ideal review coverage check", {
        covered: coverage.covered,
        missing: coverage.missing,
        lspLowConfidence: lspEvidence.lowConfidence,
        lspMissing: lspEvidence.missing,
      });
      if (coverage.missing.length > 0) {
        if (this.reviewCoverageInjected < MAX_REVIEW_COVERAGE_INJECTIONS) {
          this.reviewCoverageInjected += 1;
          return [
            this.withReviewLspEvidence(buildReviewCoverageMessage(coverage.missing), lspEvidence),
          ];
        }
        // Budget spent: close the gate so the run cannot spin on a file that
        // never becomes readable, and require the gap be reported to the user.
        this.idealReviewPhase = "complete";
        log("INFO", "ideal", "Ideal review coverage escalated after retry budget", {
          injected: String(this.reviewCoverageInjected),
          missing: coverage.missing,
        });
        return [buildReviewCoverageEscalationMessage(coverage.missing)];
      }
      this.idealReviewPhase = "complete";
      return null;
    }
    if (this.idealReviewPhase === "complete") return null;
    if (!this.settingsManager.get("idealReviewEnabled")) return null;

    const decision = evaluateIdealReview(this.hookStats);
    // Test drift fires the review even on a small change the score would skip:
    // a green-but-stale test is exactly what the volume gate sleeps through.
    const driftedFiles = detectTestDrift(this.hookFileEditCounts.keys(), this.cwd).slice(0, 5);
    if (!decision.shouldReview && driftedFiles.length === 0) return null;

    this.reviewCoverage.start(this.hookFileEditCounts.keys());
    this.idealReviewPhase = "reviewing";
    const coverage = this.reviewCoverage.evidence();
    const lspEvidence = this.reviewLspEvidence(coverage.expected);
    this.eventBus.emit("hook", {
      kind: "ideal",
      coverageExpected: coverage.expected,
      coverageMissing: coverage.missing,
    });
    // Disarm strictly AFTER the hook event. Clients release held text on
    // disarm, so the reverse order would paint the draft and then delete it —
    // the exact flash arming exists to prevent. Leaving `idle` is what lets the
    // reviewed final answer stream live instead of being held.
    this.refreshIdealReviewArmed();
    log("INFO", "ideal", "Injecting ideal review before final response", {
      coverageExpected: coverage.expected,
      coverageMissing: coverage.missing,
      lspLowConfidence: lspEvidence.lowConfidence,
      lspMissing: lspEvidence.missing,
    });
    return [
      this.withReviewLspEvidence(
        withReviewCoverageRequirements(
          buildIdealReviewMessage(decision.reasons, driftedFiles),
          coverage.missing,
        ),
        lspEvidence,
      ),
    ];
  }

  private reviewLspEvidence(files: readonly string[]): {
    lowConfidence: string[];
    missing: string[];
  } {
    const lowConfidence: string[] = [];
    const missing: string[] = [];
    for (const filePath of files) {
      const outcome = this.lspManager?.getLatestOutcome(filePath);
      if (outcome?.kind === "low_confidence") lowConfidence.push(filePath);
      else if (outcome?.kind !== "clean" && outcome?.kind !== "diagnostics") missing.push(filePath);
    }
    return { lowConfidence, missing };
  }

  private withReviewLspEvidence(
    message: Message,
    evidence: { lowConfidence: string[]; missing: string[] },
  ): Message {
    if (evidence.lowConfidence.length === 0 && evidence.missing.length === 0) return message;
    const notes = [
      ...(evidence.lowConfidence.length > 0
        ? [`Diagnostics are low confidence while indexing: ${evidence.lowConfidence.join(", ")}.`]
        : []),
      ...(evidence.missing.length > 0
        ? [`Diagnostics evidence is unavailable or missing: ${evidence.missing.join(", ")}.`]
        : []),
      "Do not describe those files as compiler-clean without other evidence.",
    ];
    return {
      role: "user",
      provenance: message.provenance,
      content: `${String(message.content)}\n\n${notes.join(" ")}`,
    };
  }

  /** Auto-compact if needed, run agent loop with auth retry, and persist messages. */
  private async runLoop(options: { disableTools?: boolean } = {}): Promise<void> {
    this.refreshSystemPromptTail();
    // One-shot cache-key marker per session so turn_end cacheRead numbers
    // in the log can be traced back to a specific routing namespace —
    // particularly useful when sub-agents inherit `parentKey:subagent`.
    if (!this.cacheKeyLogged) {
      this.cacheKeyLogged = true;
      log("INFO", "cache", "Session cache key", {
        provider: this.provider,
        model: this.model,
        key: this.getPromptCacheKey() ?? "(none)",
        transient: String(!!this.opts.transient),
      });
    }

    // Reset self-correction hook state for this run; pin the latest user message
    // as the verbatim original request for post-compaction re-grounding.
    const lastUser = [...this.messages].reverse().find((m) => m.role === "user");
    const originalRequest = typeof lastUser?.content === "string" ? lastUser.content : "";
    this.resetHookState(originalRequest);

    // Resolve OAuth credentials and run agent loop.
    // On 401, force-refresh the token and retry once — the provider may have
    // revoked the token server-side before the stored expiry (e.g. after a restart).
    let creds = await this.authStorage.resolveCredentials(this.provider, {
      storageKeys: this.currentAuthStorageKeys(),
    });
    // Cache for sync callers (see field doc) — kept in step with `creds`
    // through the 401 force-refresh retry below.
    this.lastAccountId = creds.accountId;
    // The access token most recently handed to the provider. Tracked separately
    // from `creds` because the per-turn resolver can rotate it mid-run, and the
    // 401 handler must name the token that was actually rejected.
    let lastResolvedAccessToken = creds.accessToken;

    // Auto-compact if needed. This must happen after credential resolution so
    // OpenAI OAuth/Codex sessions use the Codex product context window instead
    // of the public API model window. Failed/no-op attempts cool down across
    // prompts; provider overflow recovery still bypasses this path entirely.
    if (this.settingsManager.get("autoCompact") && Date.now() >= this.compactionRetryAfter) {
      const contextWindow = getContextWindow(this.model, {
        provider: this.provider,
        accountId: creds.accountId,
      });
      const policy = resolveCompactionPolicy({
        provider: this.provider,
        model: this.model,
        contextWindow,
        threshold: this.settingsManager.get("compactThreshold"),
        accountId: creds.accountId,
        approvedPlanPath: this.approvedPlanPath,
      });
      let activeTokens: number | undefined;
      if (this.providerContext) {
        const anchorIndex = this.messages.lastIndexOf(this.providerContext.anchor);
        if (anchorIndex >= 0) {
          activeTokens = calculateActiveContextTokens(this.messages, {
            usage: this.providerContext.usage,
            pendingMessages: this.messages.slice(anchorIndex + 1),
          });
        } else {
          this.providerContext = null;
        }
      }
      log("INFO", "compaction", "Pre-run compaction decision", {
        provider: this.provider,
        model: this.model,
        transport: this.provider === "openai" && creds.accountId ? "codex_oauth" : "public_api",
        contextWindow: String(contextWindow),
        activeTokens: activeTokens === undefined ? "estimated" : String(activeTokens),
        triggerLimit: String(policy.targetTokens),
      });
      if (shouldCompact(this.messages, contextWindow, policy.threshold, activeTokens)) {
        try {
          await this.compact(creds, "automatic");
          if (this.lastCompactionCompacted) {
            // Re-grounding hook keys off this — the context was just summarized.
            this.compactionOccurred = true;
            this.compactionRetryAfter = 0;
          } else {
            this.compactionRetryAfter = Date.now() + 30_000;
          }
        } catch (error) {
          this.compactionRetryAfter = Date.now() + 30_000;
          if (isAbortError(error) || this.opts.signal?.aborted) throw error;
          log(
            "WARN",
            "compaction",
            `Pre-run compaction failed; cooling down for 30s: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    const userAgent = this.provider === "anthropic" ? await getClaudeCliUserAgent() : undefined;

    const loopMessages = await this.prepareDynamicContext();

    const runAgentLoop = async (apiKey: string, accountId?: string, projectId?: string) => {
      lastResolvedAccessToken = apiKey;
      const modelInfo = getModel(this.model);
      const effectiveBaseUrl = this.baseUrl ?? creds.baseUrl;
      const generator = agentLoop(loopMessages, {
        provider: this.provider,
        model: this.model,
        tools: options.disableTools ? [] : this.tools,
        webSearch: !options.disableTools,
        maxTokens: this.maxTokens,
        maxTurns: this.opts.maxTurns,
        maxTurnExtensions: this.opts.maxTurnExtensions,
        thinking: this.thinkingLevel,
        apiKey,
        // Per-turn credential resolution. A run can span many minutes; if any
        // process sharing auth.json refreshes this grant meanwhile, the token
        // captured above is invalidated server-side and every remaining turn
        // would fail with an authentication error until the user restarted.
        // Static API keys resolve to the same value, so this is a no-op for them.
        resolveCredentials: async () => {
          const live = await this.authStorage.resolveCredentials(this.provider, {
            storageKeys: this.currentAuthStorageKeys(),
          });
          this.lastAccountId = live.accountId;
          lastResolvedAccessToken = live.accessToken;
          return {
            apiKey: live.accessToken,
            ...(live.accountId !== undefined ? { accountId: live.accountId } : {}),
            ...(live.projectId !== undefined ? { projectId: live.projectId } : {}),
          };
        },
        baseUrl: effectiveBaseUrl,
        signal: this.opts.signal,
        accountId,
        transportSessionId: this.sessionId || this.transportSessionId,
        projectId,
        // Kimi For Coding gates the managed endpoint on coding-agent identity
        // headers; attach them only when the Kimi OAuth token is in use.
        defaultHeaders:
          this.provider === "moonshot" && isKimiCodingEndpoint(effectiveBaseUrl)
            ? kimiCodingHeaders()
            : undefined,
        // speedProfile "optimized": 1-h cache TTL (survives turns >5 min apart)
        // + pre-warm before the first turn. "baseline": current 5-min default.
        cacheRetention: this.isSpeedOptimized() ? "long" : "short",
        promptCacheKey: this.getPromptCacheKey(),
        supportsImages: modelInfo?.supportsImages,
        supportsVideo: modelInfo?.supportsVideo,
        userAgent,
        // Codex caps each tool output at 10K tokens. Other transports retain the
        // generic 30%-of-context allowance used before this provider policy.
        maxToolResultChars: resolveSessionToolResultCharLimit(this.model, this.provider, accountId),
        // Aggregate per-turn budget across parallel tool results (fan-out guard).
        maxTurnToolResultChars: resolveSessionTurnToolResultCharLimit(
          this.model,
          this.provider,
          accountId,
        ),
        // Self-correction hooks (same as the TUI): loop-break + re-grounding are
        // polled mid-loop; the ideal review is polled when the agent would stop.
        getSteeringMessages: () => this.getHookSteeringMessages(),
        getFollowUpMessages: () => this.getHookFollowUpMessages(),
        onTurnBudgetExhausted: (ctx) => this.shouldExtendTurnBudget(ctx),
        // Check authoritative provider usage before every model/tool step.
        // Forced overflow recovery bypasses settings and cooldown; proactive
        // checks honor both and estimate only messages unseen by the provider.
        transformContext: async (messages, transformOpts) => {
          if (transformOpts.usage) {
            const anchorIndex = messages.length - transformOpts.pendingMessages.length - 1;
            const anchor = messages[anchorIndex];
            if (anchor?.role === "assistant") {
              this.providerContext = { usage: { ...transformOpts.usage }, anchor };
              // Feed the authoritative usage back into the token estimator so
              // char-based estimates track this session's real tokenizer.
              calibrateEstimatorFromUsage(messages.slice(0, anchorIndex), transformOpts.usage);
            }
          }

          const force = transformOpts.force === true;
          if (!force) {
            if (!this.settingsManager.get("autoCompact")) return messages;

            // Cheap stale-tool-output pruning before the expensive LLM
            // compaction check. In-place mutation preserves anchors; drop the
            // retained usage afterwards since it counted the pruned content.
            const pruneResult = pruneStaleToolResults(messages);
            if (pruneResult.pruned) {
              this.providerContext = null;
              log("INFO", "compaction", "Pruned stale tool outputs", {
                prunedResults: String(pruneResult.prunedResults),
                compactedToolCalls: String(pruneResult.compactedToolCalls),
                freedTokens: String(pruneResult.freedTokens),
              });
            }

            if (Date.now() < this.compactionRetryAfter) return messages;

            // The turn's own usage also counted the pruned content — after a
            // prune, fall back to estimating the (now smaller) history so the
            // freed tokens actually defer the LLM compaction.
            let usage = pruneResult.pruned ? undefined : transformOpts.usage;
            let pendingMessages = transformOpts.pendingMessages;
            if (!usage && this.providerContext) {
              const anchorIndex = messages.lastIndexOf(this.providerContext.anchor);
              if (anchorIndex >= 0) {
                usage = this.providerContext.usage;
                pendingMessages = messages.slice(anchorIndex + 1);
              } else {
                this.providerContext = null;
              }
            }

            const contextWindow = getContextWindow(this.model, {
              provider: this.provider,
              accountId,
            });
            const policy = resolveCompactionPolicy({
              provider: this.provider,
              model: this.model,
              contextWindow,
              threshold: this.settingsManager.get("compactThreshold"),
              accountId,
              approvedPlanPath: this.approvedPlanPath,
            });
            const activeTokens = calculateActiveContextTokens(messages, {
              usage,
              pendingMessages,
            });
            log("INFO", "compaction", "In-flight compaction decision", {
              provider: this.provider,
              model: this.model,
              transport: this.provider === "openai" && accountId ? "codex_oauth" : "public_api",
              contextWindow: String(contextWindow),
              activeTokens: String(activeTokens),
              triggerLimit: String(policy.targetTokens),
            });
            if (!shouldCompact(messages, contextWindow, policy.threshold, activeTokens))
              return messages;
          }

          // compact() operates on this.messages, while an earlier transform may
          // have replaced the loop's in-flight array. Rebind before every attempt
          // so the current tool results are included in the summary.
          this.messages = messages;
          try {
            await this.compact(
              {
                accessToken: apiKey,
                accountId,
                projectId,
                baseUrl: effectiveBaseUrl,
              },
              force ? "forced" : "automatic",
            );
          } catch (error) {
            this.messages = messages;
            this.compactionRetryAfter = Date.now() + 30_000;
            if (force || isAbortError(error) || this.opts.signal?.aborted) throw error;
            log(
              "WARN",
              "compaction",
              `In-flight compaction failed; cooling down for 30s: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return messages;
          }

          if (!this.lastCompactionCompacted) {
            this.messages = messages;
            this.compactionRetryAfter = Date.now() + 30_000;
            return messages;
          }

          this.compactionRetryAfter = 0;
          this.compactionOccurred = true;
          return this.messages;
        },
      });

      this.activeLoopMessages = loopMessages;
      try {
        for await (const event of generator as AsyncIterable<AgentEvent>) {
          await this.trackHookEvent(event);
          this.eventBus.forwardAgentEvent(event);
        }
      } finally {
        this.activeLoopMessages = null;
      }
    };

    const clearInvalidStaticApiKey = async (error: unknown): Promise<boolean> => {
      if (!(error instanceof ProviderError) || error.statusCode !== 401) return false;
      if (!(await this.authStorage.isStaticApiKey(this.provider))) return false;

      // Clear whichever key actually resolved (the request may have used a
      // fallback key, not the model's first preference).
      const badKey =
        (await this.authStorage.pickStorageKey(this.currentAuthStorageKeys())) ??
        this.currentAuthStorageKeys()[0]!;
      log(
        "WARN",
        "auth",
        `Got 401 for ${this.provider} (${badKey}) — API key is invalid or revoked`,
      );
      await this.authStorage.clearCredentials(badKey);
      return true;
    };

    try {
      await runAgentLoop(creds.accessToken, creds.accountId, creds.projectId);
    } catch (err) {
      // Abort errors are expected (user cancellation) — don't retry or re-throw
      if (isAbortError(err) || this.opts.signal?.aborted) {
        return;
      }
      // A subscription OAuth plan ran out of usage (hard usage-limit stop, or an
      // HTTP 402 billing stop). If the user ALSO configured that provider's API
      // key, mark the OAuth credential usage-exhausted (honoring the
      // provider-stated reset time when present) and retry this turn on the API
      // key — OAuth stays the preferred credential and resumes automatically once
      // the mark lapses. A generic 429 is deliberately excluded: it may be a
      // transient rate limit and must not silently switch the user to a billed
      // API key.
      //
      // Grok adds one case Kimi doesn't have: xAI gates its CLI chat proxy by
      // subscription tier, so an entitled-looking account can be refused outright
      // with a 403. That means "OAuth cannot serve this", not a transient error,
      // so it counts as exhausted too — otherwise a dual-configured user would
      // hard-fail while holding a perfectly good API key.
      //
      // Guarded on the subscription endpoint actually being in use: if the API key
      // was already active, the same error means BOTH are out and must surface.
      const dualAuth = dualAuthProvider(this.provider);
      const onSubscriptionEndpoint =
        (this.provider === "moonshot" && isKimiCodingEndpoint(creds.baseUrl)) ||
        (this.provider === "xai" && isGrokCliEndpoint(creds.baseUrl));
      const tierRefusal =
        this.provider === "xai" && err instanceof ProviderError && err.statusCode === 403;
      const oauthIsOut =
        isUsageLimitError(err) ||
        (err instanceof ProviderError && err.statusCode === 402) ||
        tierRefusal;
      if (
        dualAuth &&
        !this.baseUrl &&
        onSubscriptionEndpoint &&
        oauthIsOut &&
        (await this.authStorage.hasCredentials(dualAuth.provider))
      ) {
        const resetsAt = err instanceof ProviderError ? err.resetsAt : undefined;
        await this.authStorage.markUsageExhausted(dualAuth.oauthKey, resetsAt);
        log(
          "WARN",
          "auth",
          `${dualAuth.oauthLabel} usage limit reached — retrying this turn on the ${dualAuth.apiKeyLabel}`,
          { resetsAt: resetsAt !== undefined ? String(resetsAt) : "unknown" },
        );
        creds = await this.authStorage.resolveCredentials(this.provider, {
          storageKeys: this.currentAuthStorageKeys(),
        });
        this.lastAccountId = creds.accountId;
        // The runAgentLoop closure re-reads `creds`, so the retry picks up the
        // API key's public baseUrl (api.moonshot.ai / api.x.ai) and drops the
        // subscription endpoint's client-identity headers.
        try {
          await runAgentLoop(creds.accessToken, creds.accountId, creds.projectId);
        } catch (fallbackErr) {
          // The fallback is inside this catch branch, so its errors do not pass
          // through the outer 401 handler. Clear a rejected API key explicitly
          // before surfacing the error and prompting the user to log in again.
          await clearInvalidStaticApiKey(fallbackErr);
          throw fallbackErr;
        }
      } else if (err instanceof ProviderError && err.statusCode === 401) {
        // Static API-key providers (GLM, Moonshot API key, etc.) have no refresh
        // mechanism — retrying with the same key is pointless. Clear the
        // credential and surface the error so the user re-logins. Subscription
        // OAuth (active for `moonshot`/`xai` when present) is refreshable, so it
        // falls through to the force-refresh path below.
        if (await clearInvalidStaticApiKey(err)) throw err;

        log("INFO", "auth", "Got 401, force-refreshing token and retrying");
        creds = await this.authStorage.resolveCredentials(this.provider, {
          forceRefresh: true,
          storageKeys: this.currentAuthStorageKeys(),
          // Name the token the provider actually rejected (which the per-turn
          // resolver may have rotated since the run started). If disk already
          // holds a newer one, adopt it instead of minting another — a fresh
          // refresh would invalidate the token every sibling process is using
          // and turn one 401 into a cascade of them.
          rejectedToken: lastResolvedAccessToken,
        });
        this.lastAccountId = creds.accountId;
        await runAgentLoop(creds.accessToken, creds.accountId, creds.projectId);
      } else {
        throw err;
      }
    }

    this.messages = loopMessages;

    // Backstop. Step-boundary flushes (checkpoint / turn_end) normally leave
    // nothing here, but this still catches messages appended after the last
    // checkpoint — an aborted final step, or a flush that failed mid-run.
    for (let i = this.lastPersistedIndex; i < this.messages.length; i++) {
      await this.persistMessage(this.messages[i]);
    }
    this.lastPersistedIndex = this.messages.length;
  }

  async switchModel(provider: string, model: string): Promise<void> {
    const prevProvider = this.provider;
    const prevModel = this.model;
    // Diff gate: a "switch" to the model already in use is not state change.
    // Recording it anyway would write a redundant marker and a redundant
    // history note on every no-op re-selection from the UI.
    const changed = model !== prevModel || (Boolean(provider) && provider !== prevProvider);
    if (provider) this.provider = provider as Provider;
    this.model = model;
    this.providerContext = null;
    // Keep host-provided option closures (notably chat delegation) aligned with
    // the live selection after an in-session model switch.
    this.opts.provider = this.provider;
    this.opts.model = this.model;
    setEstimatorModel(model);
    // maxTokens must follow the active model — it was frozen at the boot
    // model's `maxOutputTokens` in the constructor, so without this a session
    // booted on e.g. Kimi (256K) keeps sending that cap after switching to a
    // smaller model (Opus 128K), which the provider rejects.
    this.maxTokens = this.resolveMaxTokens(model);
    this.eventBus.emit("model_change", {
      provider: this.provider,
      model: this.model,
      supportsVideo: getModel(this.model)?.supportsVideo ?? false,
    });

    // Rebuild the read tool for the new model's video byte cap. The tool's
    // video capability (description + native-video execute path) is baked in
    // at creation from the model's maxVideoBytes, so switching to/from a
    // video-capable model mid-session needs a fresh tool object — mirrors
    // the TUI's rebuildReadTool call on model switch.
    if (this.rebuildReadTool) {
      const newReadTool = this.rebuildReadTool(model);
      this.tools = this.tools.map((t) => (t.name === "read" ? newReadTool : t));
    }

    // Model-dependent guidance lives in the uncached tail, so this rewrites
    // only the bytes after the cache marker — the cached prefix survives the
    // switch intact and the next turn still reads from cache.
    this.refreshSystemPromptTail();

    if (changed) {
      // Durable, replayable record of which model produced which segment. Rides
      // the existing app-marker path (parentId null, anchored by message count)
      // so a resumed session reconstructs the switch without the LLM seeing an
      // extra transcript row.
      await this.persistAppMarker("model_switch", {
        from: prevModel,
        to: this.model,
        provider: this.provider,
        fromProvider: prevProvider,
      }).catch((error) => {
        log("WARN", "session", "Failed to persist model-switch marker", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.appendModelSwitchNote(prevModel, prevProvider);
    }

    // Update provider-specific tools when provider changes
    if (provider && provider !== prevProvider) {
      // Add/remove client-side web_search tool based on provider.
      // Anthropic has native server-side web search; all other providers need the client tool.
      const hasWebSearch = this.tools.some((t) => t.name === "web_search");
      if (this.provider === "anthropic" && hasWebSearch) {
        // Switching TO anthropic — remove client-side web_search (server-side handles it)
        this.tools = this.tools.filter((t) => t.name !== "web_search");
      } else if (this.provider !== "anthropic" && !hasWebSearch) {
        // Switching FROM anthropic — add client-side web_search
        this.tools.push(
          createWebSearchTool(() => ({
            mode: this.settingsManager.get("networkMode"),
            allow: this.settingsManager.get("networkAllow"),
          })),
        );
      }

      // Reconnect MCP servers ONLY when GLM is involved on either side — GLM
      // is the only provider with a different server set (Z.AI tools), so a
      // non-GLM switch keeps the identical set. Skipping the dispose/reconnect
      // there avoids tearing down a live stdio child (e.g. kencode-search) and
      // gambling on a `npx` re-spawn that could fail and drop the tools.
      const glmInvolved = this.provider === "glm" || prevProvider === "glm";
      if (this.mcpManager && glmInvolved) {
        // Remove old MCP tools
        this.tools = this.tools.filter((t) => !t.name.startsWith("mcp__"));

        // Disconnect old MCP servers
        await this.mcpManager.dispose();

        // Connect new MCP servers for the new provider
        try {
          let apiKey: string | undefined;
          if (this.provider === "glm") {
            try {
              const glmCreds = await this.authStorage.resolveCredentials("glm");
              apiKey = glmCreds.accessToken;
            } catch {
              // GLM not configured — skip Z.AI MCP servers
            }
          }
          // Use getAllMcpServers so user-configured servers survive the reconnect.
          const servers = await getAllMcpServers(this.provider, apiKey, this.cwd, {
            allowProjectScope: this.settingsManager.isProjectTrusted(this.cwd),
          });
          const mcpTools = await this.mcpManager.connectAll(servers);
          // Drop stale MCP tools from both the live set and deferred catalog before
          // re-adding. Some tools may already have been promoted out of the catalog.
          this.tools = this.tools.filter((t) => !t.name.startsWith("mcp__"));
          this.mcpCatalog?.removeWhere((name) => name.startsWith("mcp__"));
          this.liveMcpTools.clear();
          this.cachedMcpToolServers.clear();
          this.addMcpTools(mcpTools);
        } catch (err) {
          log(
            "WARN",
            "mcp",
            `MCP reconnection failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  /**
   * Record the switch as its own trailing message at the point it happened,
   * rather than by rewriting the system prompt. Two reasons: the system prompt
   * is the cached prefix and rewriting it costs a full cache write, and a
   * resumed transcript can only attribute output to the right model if the
   * switch sits in message order.
   *
   * Skipped before the conversation starts (nothing to disambiguate) and while
   * an assistant turn has unresolved tool calls, where inserting a user message
   * would break tool_use/tool_result pairing.
   */
  private appendModelSwitchNote(prevModel: string, prevProvider: Provider): void {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role === "system") return;
    if (last.role === "assistant" && hasUnresolvedToolCalls(last)) return;
    const from = prevProvider === this.provider ? prevModel : `${prevProvider}/${prevModel}`;
    const to = prevProvider === this.provider ? this.model : `${this.provider}/${this.model}`;
    this.messages.push({
      role: "user",
      content: `[Model switched from ${from} to ${to}. Everything above was produced under the previous model; continue the current task from here.]`,
      provenance: { source: "runtime", kind: "model_switch", visibility: "hidden" },
    });
  }

  private async adoptCompactionCheckpoint(
    loaded: Awaited<ReturnType<SessionManager["load"]>>,
  ): Promise<void> {
    const systemMessage = this.messages[0];
    const loadedMessages = this.sessionManager.getMessages(loaded.entries, loaded.header.leafId);
    this.messages = [systemMessage, ...loadedMessages];
    this.sessionId = loaded.header.id;
    this.conversationId = loaded.header.conversationId ?? loaded.header.id;
    this.checkpointGeneration = loaded.header.generation ?? 0;
    this.currentLeafId = loaded.header.leafId;
    this.setSessionPath(loaded.path);
    this.kenTurns = this.sessionManager.getKenTurns(loaded.entries, loaded.header.leafId);
    this.autopilotMarkers = this.sessionManager.getAutopilotMarkers(
      loaded.entries,
      loaded.header.leafId,
    );
    this.appMarkers = this.sessionManager.getAppMarkers(loaded.entries, loaded.header.leafId);
    this.turnMetrics = this.sessionManager.getTurnMetrics(loaded.entries);
    this.lastPersistedIndex = this.messages.length;
    this.providerContext = null;
    await this.subAgentManager?.rebindParentSession(this.sessionId);
  }

  /** Canonicalize a deferred restore before a new prompt can fork stale history. */
  private async adoptDeferredCheckpointBeforePrompt(): Promise<void> {
    if (!this.deferredCompactionPending || !this.conversationId) return;
    this.deferredCompactionPending = false;
    const canonicalPath = await this.sessionManager.resolveCanonicalSession(
      this.conversationId,
      this.cwd,
    );
    if (!canonicalPath || canonicalPath === this.sessionPath) return;
    await this.adoptCompactionCheckpoint(await this.sessionManager.load(canonicalPath));
  }

  private async persistCompactionCheckpoint(
    sourceFingerprint: string,
    result: CompactionResult,
  ): Promise<void> {
    const parentSessionId = this.sessionId || undefined;
    const session = await this.sessionManager.create(this.cwd, this.provider, this.model, {
      conversationId: this.conversationId || undefined,
      generation: this.checkpointGeneration + 1,
      parentSessionId,
      sourceFingerprint,
      retainedMessageCount:
        result.retainedCount === 0
          ? 0
          : this.messages
              .slice(-result.retainedCount)
              .filter((message) => getHistoryMessageVisibility(message) !== "hidden").length,
      preview: this.sessionPreview || undefined,
    });
    this.sessionId = session.id;
    this.checkpointGeneration = session.header.generation ?? 0;
    this.conversationId = session.header.conversationId ?? session.id;
    this.currentLeafId = null;
    this.setSessionPath(session.path);
    await this.subAgentManager?.rebindParentSession(this.sessionId);

    for (const message of this.messages) {
      if (message.role !== "system") await this.persistMessage(message);
    }
    this.lastPersistedIndex = this.messages.length;
    await this.rePersistTurnMetrics();
    await this.rePersistKenTurns();
    await this.rePersistAutopilotMarkers();
    await this.rePersistAppMarkers();
    await this.persistAppMarker("compaction", {
      originalCount: result.originalCount,
      newCount: result.newCount,
    });
  }

  async compact(
    existingCredentials?: {
      accessToken: string;
      accountId?: string;
      projectId?: string;
      baseUrl?: string;
    },
    mode: "manual" | "automatic" | "forced" = "manual",
  ): Promise<void> {
    this.lastCompactionCompacted = false;
    const creds =
      existingCredentials ??
      (await this.authStorage.resolveCredentials(this.provider, {
        storageKeys: this.currentAuthStorageKeys(),
      }));
    const contextWindow = getContextWindow(this.model, {
      provider: this.provider,
      accountId: creds.accountId,
    });
    const policy = resolveCompactionPolicy({
      provider: this.provider,
      model: this.model,
      contextWindow,
      threshold: this.settingsManager.get("compactThreshold"),
      accountId: creds.accountId,
      approvedPlanPath: this.approvedPlanPath,
    });
    const originalCount = this.messages.length;
    this.eventBus.emit("compaction_start", { messageCount: originalCount });

    let contextSelection: CompactionContextSelection | undefined;
    const runCompactor = async () => {
      const output = await compact(this.messages, {
        provider: this.provider,
        model: this.model,
        apiKey: creds.accessToken,
        accountId: creds.accountId,
        projectId: creds.projectId,
        baseUrl: this.baseUrl ?? creds.baseUrl,
        contextWindow,
        targetTokens: policy.targetTokens,
        signal: this.opts.signal,
        approvedPlanPath: this.approvedPlanPath,
      });
      contextSelection = output.result.contextSelection;
      return output;
    };

    let finalCount = originalCount;
    if (this.opts.transient || !this.conversationId) {
      const result = await runCompactor();
      finalCount = result.result.newCount;
      this.messages = result.messages;
      this.lastCompactionCompacted = result.result.compacted;
      if (result.result.compacted) {
        this.providerContext = null;
        this.remapMarkerAnchors(result.result.anchorRemap);
        this.lastPersistedIndex = this.messages.length;
      }
    } else {
      const conversationId = this.conversationId;
      await this.sessionManager.withCompactionLease(conversationId, this.opts.signal, async () => {
        let sourceFingerprint = computeSourceFingerprint(this.messages);
        const canonicalPath = await this.sessionManager.resolveCanonicalSession(
          conversationId,
          this.cwd,
        );
        if (canonicalPath && canonicalPath !== this.sessionPath) {
          const newest = await this.sessionManager.load(canonicalPath);
          if (newest.header.sourceFingerprint === sourceFingerprint) {
            await this.adoptCompactionCheckpoint(newest);
            this.lastCompactionCompacted = true;
            finalCount = this.messages.length;
            return;
          }
          // The canonical branch contains different progress. Rebase onto it before
          // compacting so a stale caller cannot supersede newer history by generation.
          await this.adoptCompactionCheckpoint(newest);
          sourceFingerprint = computeSourceFingerprint(this.messages);
        }

        const attempt = await this.sessionManager.readCompactionAttemptState(conversationId);
        const attemptActive = !attempt?.expiresAt || Date.parse(attempt.expiresAt) > Date.now();
        if (
          mode === "automatic" &&
          attempt?.fingerprint === sourceFingerprint &&
          attempt.policyKey === policy.policyKey &&
          attemptActive
        ) {
          if (attempt.outcome === "success" && attempt.checkpointId) {
            const checkpointPath = await this.sessionManager.findById(
              this.cwd,
              attempt.checkpointId,
            );
            if (checkpointPath) {
              const checkpoint = await this.sessionManager.load(checkpointPath);
              if (checkpoint.header.sourceFingerprint === sourceFingerprint) {
                await this.adoptCompactionCheckpoint(checkpoint);
                this.lastCompactionCompacted = true;
                finalCount = this.messages.length;
                return;
              }
            }
          } else if (attempt.outcome === "failed" || attempt.outcome === "noop") {
            return;
          }
        }

        try {
          const result = await runCompactor();
          finalCount = result.result.newCount;
          this.messages = result.messages;
          this.lastCompactionCompacted = result.result.compacted;
          if (!result.result.compacted) {
            await this.sessionManager.writeCompactionAttemptState(conversationId, {
              fingerprint: sourceFingerprint,
              policyKey: policy.policyKey,
              outcome: "noop",
              updatedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            });
            return;
          }

          this.providerContext = null;
          this.remapMarkerAnchors(result.result.anchorRemap);
          await this.persistCompactionCheckpoint(sourceFingerprint, result.result);
          await this.sessionManager.writeCompactionAttemptState(conversationId, {
            fingerprint: sourceFingerprint,
            policyKey: policy.policyKey,
            outcome: "success",
            checkpointId: this.sessionId,
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          await this.sessionManager
            .writeCompactionAttemptState(conversationId, {
              fingerprint: sourceFingerprint,
              policyKey: policy.policyKey,
              outcome: "failed",
              updatedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            })
            .catch(() => {});
          throw error;
        }
      });
    }

    this.eventBus.emit("compaction_end", {
      compacted: this.lastCompactionCompacted,
      originalCount,
      newCount: finalCount,
      ...(contextSelection
        ? {
            selectionStrategy: contextSelection.strategy,
            selectedMessages: contextSelection.selectedMessages,
            selectedTokens: contextSelection.selectedTokens,
            droppedMessages: contextSelection.droppedMessages,
            queryTerms: contextSelection.queryTerms,
            ...(contextSelection.fallbackReason
              ? { selectionFallback: contextSelection.fallbackReason }
              : {}),
          }
        : {}),
    });
  }

  async newSession(preserveConversation = false): Promise<void> {
    // Approved-plan execution is a clean checkpoint of the same conversation;
    // explicit new sessions reset the conversation identity.
    if (!preserveConversation) {
      this.conversationId = "";
      this.checkpointGeneration = 0;
      this.sessionPreview = "";
    }
    // A fresh session drops any in-flight plan state so its prompt is clean.
    this.planModeRef.current = false;
    this.approvedPlanPath = undefined;
    // Display-only history belongs to the OLD session. Without this, stale Ken
    // turns / autopilot verdicts / app markers linger in memory, show up in the
    // new session's /history, and get re-persisted into the new file by the
    // next compaction — the cross-session duplicate-marker propagation bug.
    this.kenTurns = [];
    this.autopilotMarkers = [];
    this.appMarkers = [];
    this.turnMetrics = [];
    const basePrompt = await this.buildBasePrompt(false, undefined);
    this.baseSystemPrompt = basePrompt;
    this.messages = [{ role: "system", content: this.withSystemPromptTail(basePrompt) }];
    // Fresh conversation — new entries must not chain onto the old DAG's leaf.
    this.currentLeafId = null;
    // Transient sessions (Ken chat/autopilot, subagent spawns) never touch the
    // session store. Without this guard, autopilot's per-cycle resetReviewer
    // (kenAutoSession.newSession()) created a real session file EVERY review
    // cycle — the stream of 3-line "## Who you are … Ken Kai" sessions that
    // polluted the project's session list.
    if (this.opts.transient) {
      this.sessionId = "";
      this.conversationId = "";
      this.checkpointGeneration = 0;
      this.sessionPreview = "";
      this.setSessionPath("");
      this.lastPersistedIndex = this.messages.length;
    } else {
      await this.createNewSession();
      await this.subAgentManager?.resetParentSession(this.sessionId);
    }
    this.eventBus.emit("session_start", { sessionId: this.sessionId });
  }

  async loadSession(sessionPath: string): Promise<void> {
    await this.loadExistingSession(sessionPath);
    if (this.sessionId) await this.subAgentManager?.hydrate(this.sessionId);
    this.eventBus.emit("session_start", { sessionId: this.sessionId });
  }

  /**
   * Create a branch at a specific point in the conversation.
   * Rewinds the message history to the given entry and sets the leaf
   * so new messages fork from that point.
   *
   * @param stepsBack Number of messages to rewind (default: 2 — backs up past last assistant + tool)
   */
  async branch(stepsBack = 2): Promise<{ branchedFrom: number; messagesKept: number }> {
    // Load the full session to access the DAG
    const loaded = await this.sessionManager.load(this.sessionPath);
    this.setSessionPath(loaded.path);
    const branch = this.sessionManager.getBranch(loaded.entries, this.currentLeafId);

    // Walk back stepsBack message entries
    const messageEntries = branch.filter((e) => e.type === "message");
    const targetIndex = Math.max(0, messageEntries.length - stepsBack);

    if (targetIndex === 0) {
      throw new Error("Cannot branch — already at the start of the conversation.");
    }

    // Set leaf to the entry just before the branch point
    const newLeafEntry = messageEntries[targetIndex - 1]!;
    this.currentLeafId = newLeafEntry.id;
    await this.sessionManager.updateLeaf(this.sessionPath, newLeafEntry.id);

    // Rebuild messages from the new branch
    const branchMessages = this.sessionManager.getMessages(loaded.entries, this.currentLeafId);
    const systemMsg = this.messages[0];
    this.messages = [systemMsg, ...branchMessages];
    this.lastPersistedIndex = this.messages.length;

    this.eventBus.emit("branch_created", {
      leafId: this.currentLeafId,
      messagesKept: branchMessages.length,
    });

    return {
      branchedFrom: messageEntries.length,
      messagesKept: branchMessages.length,
    };
  }

  /**
   * List all branches in the current session.
   */
  async listBranches(): Promise<BranchInfo[]> {
    const loaded = await this.sessionManager.load(this.sessionPath);
    this.setSessionPath(loaded.path);
    return this.sessionManager.listBranches(loaded.entries);
  }

  getState(): AgentSessionState {
    return {
      provider: this.provider,
      model: this.model,
      cwd: this.cwd,
      sessionId: this.sessionId,
      sessionPath: this.sessionPath,
      messageCount: this.messages.length,
      planMode: this.planModeRef.current,
      accountId: this.lastAccountId,
    };
  }

  /**
   * Tokens currently in context and the window they are measured against.
   *
   * Uses the same accounting as the compaction decision: authoritative provider
   * usage when we have it (it includes the system prompt and tool schemas),
   * plus a local estimate of anything appended after that sample. A client
   * reading this right after a compaction sees the drop, because compaction
   * clears the retained provider sample along with the messages it measured.
   *
   * `costUsd` is present only when EVERY recorded turn has an authoritative
   * price; a partial sum would read as a full session cost and understate it.
   */
  getContextUsage(): { used: number; size: number; costUsd?: number } {
    const size = getContextWindow(this.model, {
      provider: this.provider,
      accountId: this.lastAccountId,
    });

    let used: number;
    const anchorIndex = this.providerContext
      ? this.messages.lastIndexOf(this.providerContext.anchor)
      : -1;
    if (this.providerContext && anchorIndex >= 0) {
      used = calculateActiveContextTokens(this.messages, {
        usage: this.providerContext.usage,
        pendingMessages: this.messages.slice(anchorIndex + 1),
      });
    } else {
      used = calculateActiveContextTokens(this.messages);
    }

    const costUsd =
      this.turnMetrics.length > 0 && this.turnMetrics.every((m) => m.cost.status === "known")
        ? this.turnMetrics.reduce((sum, m) => sum + (m.cost.status === "known" ? m.cost.usd : 0), 0)
        : undefined;

    return costUsd === undefined ? { used, size } : { used, size, costUsd };
  }

  getPlanMode(): boolean {
    return this.planModeRef.current;
  }

  /**
   * Suppress only the pre-final Ideal self-review for this live session.
   * Autopilot uses this while Ken independently owns verification; loop-break
   * and post-compaction re-grounding remain active.
   */
  setIdealReviewSuppressed(suppressed: boolean): void {
    this.idealReviewSuppressed = suppressed;
    if (suppressed) {
      this.idealReviewPhase = "idle";
      this.reviewCoverage.reset();
    }
    // Suppression flips mid-run (autopilot takes over verification), so a client
    // holding a draft under a stale arming must be released.
    this.refreshHookArming();
  }

  /** Queue a user message (optionally with attachments) to be injected mid-run
   *  as steering. Returns the new queue length. No-op semantics are the caller's
   *  concern. */
  queueMessage(text: string, attachments: SessionAttachment[] = []): number {
    this.queueSeq += 1;
    this.userQueue.push({ id: `q${this.queueSeq}`, text, attachments });
    return this.userQueue.length;
  }

  /** Pending queued messages (id + text), oldest first, for client display. */
  listQueuedMessages(): Array<{ id: string; text: string }> {
    return this.userQueue.map((m) => ({ id: m.id, text: m.text }));
  }

  /** Cancel one pending message by id. Returns true if it was still queued.
   *  A false return is the normal race rather than an error: the message drained
   *  into the run between the client rendering the cancel affordance and the
   *  click arriving. */
  cancelQueuedMessage(id: string): boolean {
    const index = this.userQueue.findIndex((m) => m.id === id);
    if (index === -1) return false;
    this.userQueue.splice(index, 1);
    return true;
  }

  /** Number of messages currently queued. */
  getQueuedCount(): number {
    return this.userQueue.length;
  }

  /** Remove and return the oldest queued message (text + attachments), or null.
   *  Used by the sidecar to run a message that queued while autopilot was
   *  reviewing (no run in flight to steer it into) — unlike {@link drainQueue},
   *  attachments survive so queued media isn't silently dropped. */
  takeNextQueuedMessage(): { text: string; attachments: SessionAttachment[] } | null {
    const next = this.userQueue.shift();
    if (next === undefined) return null;
    // Strip the internal queue id: it exists only so clients can cancel a
    // specific pending message, and callers here feed the result straight into
    // a run.
    return { text: next.text, attachments: next.attachments };
  }

  /** Clear the queue, returning the combined text (to restore to the composer).
   *  Queued attachments are dropped on cancel — the composer only restores text. */
  drainQueue(): string {
    return this.userQueue
      .splice(0)
      .map((m) => m.text)
      .join("\n\n");
  }

  /** Snapshot of background processes (bash run_in_background), newest-state. */
  listBackgroundProcesses(): BackgroundProcess[] {
    return this.processManager?.list() ?? [];
  }

  /** Stop a background process by id. Returns a human-readable status string. */
  async killBackgroundProcess(id: string): Promise<string> {
    if (!this.processManager) return `No background process with id "${id}"`;
    return this.processManager.stop(id);
  }

  /** Replace a host-owned system prompt in place without resetting conversation history. */
  setCustomSystemPrompt(systemPrompt: string, promptCacheKeyPrefix?: string): void {
    this.customSystemPrompt = systemPrompt;
    this.baseSystemPrompt = systemPrompt;
    this.opts.systemPrompt = systemPrompt;
    if (promptCacheKeyPrefix) this.opts.promptCacheKeyPrefix = promptCacheKeyPrefix;
    const content = this.withSystemPromptTail(systemPrompt);
    if (this.messages[0]?.role === "system") {
      this.messages[0] = { role: "system", content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  /**
   * Toggle plan mode: flips the shared ref (so tools enforce read-only
   * restrictions) and rebuilds the system prompt in place so the model is told
   * about the mode change on its next turn. No-op when a custom system prompt
   * is in force (the host owns the prompt then).
   */
  async setPlanMode(active: boolean): Promise<void> {
    this.planModeRef.current = active;
    // Entering plan mode discards any prior approved-plan contract (a new plan
    // is about to be drafted); exiting keeps it (set explicitly via accept).
    if (active) this.approvedPlanPath = undefined;
    await this.rebuildSystemPromptInPlace();
  }

  /**
   * Bake an approved plan into the system prompt so the model is told to emit
   * `[DONE:n]` markers as it completes each step (the contract the UI's
   * plan-progress widget reads). Pass `undefined` to clear it. No-op when a
   * custom system prompt is in force (the host owns the prompt then).
   */
  async setApprovedPlan(approvedPlanPath: string | undefined): Promise<void> {
    this.approvedPlanPath = approvedPlanPath;
    await this.rebuildSystemPromptInPlace();
  }

  /** Extra workspace roots added with `/add-dir`, in the order added. */
  getAdditionalRoots(): string[] {
    return [...this.additionalRoots];
  }

  /**
   * Add another workspace root. Tools already accept absolute paths, so this
   * only widens the write guard and tells the model the root exists. Rebuilding
   * the system prompt costs one cache-miss turn — the alternative (an uncached
   * suffix) would drift from the tool behaviour it describes.
   *
   * @returns the resolved root, or an error message for the user.
   */
  async addDirectory(
    dir: string,
  ): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
    const resolved = path.resolve(this.cwd, dir.replace(/^~(?=[/\\]|$)/, os.homedir()));
    let stat: Stats;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return { ok: false, error: `Not found: ${resolved}` };
    }
    if (!stat.isDirectory()) return { ok: false, error: `Not a directory: ${resolved}` };

    const covered = [this.cwd, ...this.additionalRoots].some((root) => {
      const relative = path.relative(path.resolve(root), resolved);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (covered) return { ok: false, error: `Already in the workspace: ${resolved}` };

    // Drop roots the new one subsumes so the list stays minimal.
    this.additionalRoots = this.additionalRoots.filter((root) => {
      const relative = path.relative(resolved, path.resolve(root));
      return relative.startsWith("..") || path.isAbsolute(relative);
    });
    this.additionalRoots.push(resolved);
    await this.rebuildSystemPromptInPlace();
    return { ok: true, root: resolved };
  }

  /** Remove an exact root previously added with `/add-dir`. */
  async removeDirectory(
    dir: string,
  ): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
    const resolved = path.resolve(this.cwd, dir.replace(/^~(?=[/\\]|$)/, os.homedir()));
    const index = this.additionalRoots.findIndex((root) => path.resolve(root) === resolved);
    if (index === -1) {
      return { ok: false, error: `Not an additional workspace root: ${resolved}` };
    }

    this.additionalRoots.splice(index, 1);
    await this.rebuildSystemPromptInPlace();
    return { ok: true, root: resolved };
  }

  /**
   * Names to advertise as available-on-demand. A tool the model already
   * promoted lives in `this.tools` and carries its own schema, so it drops out
   * of the index rather than being listed twice.
   */
  private deferredToolNamesForPrompt(liveNames: readonly string[]): string[] {
    if (this.deferredBuiltinToolNames.length === 0) return [];
    const live = new Set(liveNames);
    return this.deferredBuiltinToolNames.filter((name) => !live.has(name));
  }

  /**
   * The environment about to be rendered into a prompt, remembered as the
   * truth the model has been told. Pairs with the env-delta hook: whatever the
   * prompt states, the model is only corrected when reality moves away from it.
   */
  private recordRenderedEnvironment(): SystemPromptEnvironment {
    const environment = this.promptEnvironment();
    this.renderedEnvironment = environment;
    return environment;
  }

  /** Environment facts that vary per session rather than per host. */
  private promptEnvironment(): SystemPromptEnvironment {
    const networkAllow =
      this.settingsManager.get("networkMode") === "allowlist"
        ? this.settingsManager.get("networkAllow")
        : [];
    return { additionalRoots: this.additionalRoots, networkAllow };
  }

  /**
   * Build the stable system-prompt prefix for the current tool set and state.
   *
   * Three modes, in precedence order: a full replacement (`systemPrompt`), a
   * composed sub-agent prompt (`agentPrompt` — agent body plus Tools, project
   * context, return contract and Environment), or the standard prompt.
   */
  private async buildBasePrompt(planMode: boolean, approvedPlanPath?: string): Promise<string> {
    if (this.customSystemPrompt) return this.customSystemPrompt;
    const toolNames = this.tools.map((tool) => tool.name);
    const deferredToolNames = this.deferredToolNamesForPrompt(toolNames);
    if (this.agentPrompt !== undefined) {
      return buildSubAgentSystemPrompt(this.agentPrompt, {
        cwd: this.cwd,
        toolNames,
        deferredToolNames,
        context: this.opts.agentContext,
        environment: this.recordRenderedEnvironment(),
        contextLimits: this.contextLimits,
      });
    }
    return buildSystemPrompt(
      this.cwd,
      this.skills,
      planMode,
      approvedPlanPath,
      toolNames,
      undefined,
      this.provider,
      this.recordRenderedEnvironment(),
      deferredToolNames,
      this.contextLimits,
    );
  }

  /** Rebuild messages[0] from current plan-mode + approved-plan state. */
  private async rebuildSystemPromptInPlace(): Promise<void> {
    // A full replacement is verbatim by contract — there is nothing to rebuild.
    // A composed agent prompt still must be: its Tools section has to follow
    // late-arriving MCP tools, or a compacted child loses tools it can call.
    if (this.customSystemPrompt) return;
    const rebuilt = await this.buildBasePrompt(this.planModeRef.current, this.approvedPlanPath);
    this.baseSystemPrompt = rebuilt;
    const content = this.withSystemPromptTail(rebuilt);
    if (this.messages[0]?.role === "system") {
      this.messages[0] = { role: "system", content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  /**
   * Compose the system message: stable prefix, then everything volatile behind
   * the `<!-- uncached -->` marker that providers split on for cache control.
   *
   * Anything that varies with the live model/provider/thinking level belongs in
   * the tail. Putting it in the prefix means every model switch rewrites cached
   * bytes and the next turn pays a full cache write instead of a read.
   */
  private withSystemPromptTail(basePrompt: string): string {
    const tailParts: string[] = [];
    const orchestration = this.orchestrationPolicyTail();
    if (orchestration) tailParts.push(orchestration);
    const hostTail = this.opts.getSystemPromptTail?.();
    if (hostTail) tailParts.push(hostTail);
    if (tailParts.length === 0) return basePrompt;
    return `${basePrompt}\n\n<!-- uncached -->\n${tailParts.join("\n\n")}`;
  }

  /**
   * Sol/Terra async-orchestration guidance for the CURRENT model and thinking
   * level. Per-switch volatile by definition, so it is rendered as a tail part
   * rather than spliced into the cached prefix.
   */
  private orchestrationPolicyTail(): string {
    if (this.opts.orchestrationPrompt === false) return "";
    return applyAsyncSubagentPolicy(
      "",
      this.provider,
      this.model,
      this.thinkingLevel,
      this.tools.map((tool) => tool.name),
    ).trim();
  }

  /**
   * Re-render the uncached tail of messages[0] in place. The cached prefix is
   * byte-identical afterwards, so this is safe to call on every model /
   * thinking-level change.
   */
  private refreshSystemPromptTail(): void {
    const content = this.withSystemPromptTail(this.baseSystemPrompt);
    if (this.messages[0]?.role === "system") {
      if (this.messages[0].content === content) return;
      this.messages[0] = { role: "system", content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  getMessages(): Message[] {
    return this.messages;
  }

  getTurnMetrics(): TurnMetricPayload[] {
    return this.turnMetrics.map((metric) => ({
      ...metric,
      usage: { ...metric.usage },
      timing: { ...metric.timing },
      cost: { ...metric.cost },
    }));
  }

  private async persistTurnMetric(event: AgentTurnEndEvent): Promise<void> {
    const payload: TurnMetricPayload = {
      version: 1,
      turn: event.turn,
      provider: this.provider,
      model: this.model,
      stopReason: event.stopReason,
      usage: { ...event.usage },
      timing: { ...event.timing },
      cost: {
        status: "unavailable",
        reason: "No authoritative effective-dated provider pricing is available",
      },
    };
    this.turnMetrics.push(payload);
    if (this.sessionPath) await this.sessionManager.appendTurnMetric(this.sessionPath, payload);
  }

  private async rePersistTurnMetrics(): Promise<void> {
    if (!this.sessionPath) return;
    for (const metric of this.turnMetrics) {
      await this.sessionManager.appendTurnMetric(this.sessionPath, metric);
    }
  }

  /** Ken Kai (mentor) turns recorded against this session, in record order. Used
   *  by the host to interleave Ken's advisory exchanges back into the transcript
   *  on resume. Never part of the LLM message history. */
  getKenTurns(): KenTurnPayload[] {
    return this.kenTurns;
  }

  /** Autopilot verdict markers recorded against this session, in record order.
   *  Used by the host to interleave the auto-review loop's markers back into
   *  the transcript on resume, mirroring `getKenTurns`. */
  getAutopilotMarkers(): AutopilotMarkerPayload[] {
    return this.autopilotMarkers;
  }

  /** Non-system messages that are actually on disk. Transcript markers anchor
   *  against this (not the in-memory list, which can run ahead after a failed
   *  run), so hosts computing marker-derived values must use the same base. */
  getPersistedTranscriptCount(): number {
    return this.persistedTranscriptCount();
  }

  /**
   * Rebase every transcript anchor (Ken turns, autopilot verdicts, app markers)
   * onto a freshly compacted message list. Called right after `this.messages`
   * is replaced and before the markers are re-persisted into the continuation
   * file, so the new file carries positions that match its own transcript.
   */
  private remapMarkerAnchors(remap: CompactionAnchorRemap | undefined): void {
    if (!remap) return;
    const move = <T extends { afterMessageCount: number }>(payload: T): T => ({
      ...payload,
      afterMessageCount: remapAnchorForCompaction(payload.afterMessageCount, remap),
    });
    this.kenTurns = this.kenTurns.map(move);
    this.autopilotMarkers = this.autopilotMarkers.map(move);
    this.appMarkers = this.appMarkers.map(move);
  }

  /**
   * Record one Ken Kai (mentor agent) turn against this build session: the
   * user's question + Ken's reply. Kept in memory for the live transcript and
   * persisted as a `custom` entry (parentId null, so it's never on the message
   * DAG and never seen by the LLM, and can't race the build session's leaf while
   * Ken runs concurrently). `afterMessageCount` anchors it among the messages so
   * the host can interleave it chronologically. No-op persistence for transient
   * sessions (kept in memory only). Best-effort: a write failure is swallowed by
   * appendEntry's own handling.
   */
  async persistKenTurn(question: string, reply: string): Promise<void> {
    const afterMessageCount = this.persistedTranscriptCount();
    const payload: KenTurnPayload = { version: 1, question, reply, afterMessageCount };
    this.kenTurns.push(payload);
    if (!this.sessionPath) return;
    const entry: CustomEntry = {
      type: "custom",
      kind: KEN_TURN_CUSTOM_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    await this.sessionManager.appendEntry(this.sessionPath, entry);
  }

  /** Re-append the in-memory Ken turns to the current session file. Called after
   *  a continuation/compaction file is created so Ken's advisory history isn't
   *  lost when the session is rewritten (those rewrites only re-persist
   *  messages). Each turn keeps its original `afterMessageCount` anchor. */
  private async rePersistKenTurns(): Promise<void> {
    if (!this.sessionPath) return;
    for (const payload of this.kenTurns) {
      const entry: CustomEntry = {
        type: "custom",
        kind: KEN_TURN_CUSTOM_KIND,
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        data: stripRecordedPosition(payload),
      };
      await this.sessionManager.appendEntry(this.sessionPath, entry);
    }
  }

  /**
   * Record one autopilot verdict marker (prompted / done / human / capped)
   * against this build session. Kept in memory for the live transcript and
   * persisted as a `custom` entry (parentId null, same as Ken turns) so a
   * resumed session renders the exact same Ken bubble the live run showed
   * instead of dropping the marker or falling back to a raw verdict string.
   * No-op persistence for transient sessions (kept in memory only).
   */
  async persistAutopilotMarker(
    phase: AutopilotMarkerPayload["phase"],
    extra?: { reason?: string; body?: string },
  ): Promise<void> {
    const afterMessageCount = this.persistedTranscriptCount();
    const payload: AutopilotMarkerPayload = {
      version: 1,
      phase,
      afterMessageCount,
      ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra?.body !== undefined ? { body: extra.body } : {}),
    };
    this.autopilotMarkers.push(payload);
    if (!this.sessionPath) return;
    const entry: CustomEntry = {
      type: "custom",
      kind: AUTOPILOT_MARKER_CUSTOM_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    await this.sessionManager.appendEntry(this.sessionPath, entry);
  }

  /** Re-append the in-memory autopilot markers to the current session file.
   *  Mirrors `rePersistKenTurns` — called after a continuation/compaction file
   *  is created so the auto-review history survives the rewrite. */
  private async rePersistAutopilotMarkers(): Promise<void> {
    if (!this.sessionPath) return;
    for (const payload of this.autopilotMarkers) {
      const entry: CustomEntry = {
        type: "custom",
        kind: AUTOPILOT_MARKER_CUSTOM_KIND,
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        data: stripRecordedPosition(payload),
      };
      await this.sessionManager.appendEntry(this.sessionPath, entry);
    }
  }

  /** App transcript markers recorded against this session, in record order.
   *  Used by the host to interleave display-only rows (plan banner, task
   *  header, errors, user-bubble hints) back into the transcript on resume. */
  getAppMarkers(): AppMarkerPayload[] {
    return this.appMarkers;
  }

  /**
   * Record one app transcript marker (display-only row) against this session.
   * Same treatment as autopilot markers: kept in memory for the live
   * transcript, persisted as a `custom` entry (parentId null, never on the
   * message DAG) so a resumed session shows the identical row. `anchorOffset`
   * shifts the recorded `afterMessageCount` — pass +1 for a marker that should
   * attach to the user message about to be pushed by the imminent prompt.
   * No-op persistence for transient sessions.
   */
  async persistAppMarker(
    kind: AppMarkerPayload["kind"],
    data: Record<string, unknown>,
    anchorOffset = 0,
  ): Promise<void> {
    const afterMessageCount = this.persistedTranscriptCount() + anchorOffset;
    const payload: AppMarkerPayload = { version: 1, kind, afterMessageCount, data };
    this.appMarkers.push(payload);
    if (!this.sessionPath) return;
    const entry: CustomEntry = {
      type: "custom",
      kind: APP_MARKER_CUSTOM_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    await this.sessionManager.appendEntry(this.sessionPath, entry);
  }

  /**
   * Open the run journal for one `RunLifecycle` generation.
   *
   * Never throws and never blocks the run: a session with no file (transient
   * children) writes nothing, and a write failure just means the run isn't
   * journalled — which is strictly better than failing the run over it.
   */
  async persistRunStarted(generation: number): Promise<void> {
    if (!this.sessionPath) return;
    await this.sessionManager.appendRunStarted(this.sessionPath, {
      version: 1,
      generation,
      startedAt: new Date().toISOString(),
      afterMessageCount: this.persistedTranscriptCount(),
    });
  }

  /** Close the run journal. Its absence is what marks a run as crashed. */
  async persistRunFinished(generation: number, outcome: RunOutcome): Promise<void> {
    if (!this.sessionPath) return;
    await this.sessionManager.appendRunFinished(this.sessionPath, {
      version: 1,
      generation,
      outcome,
    });
  }

  /** Re-append the in-memory app markers to the current session file. Mirrors
   *  `rePersistKenTurns` — called after a continuation/compaction file is
   *  created so display-only rows survive the rewrite. */
  private async rePersistAppMarkers(): Promise<void> {
    if (!this.sessionPath) return;
    for (const payload of this.appMarkers) {
      const entry: CustomEntry = {
        type: "custom",
        kind: APP_MARKER_CUSTOM_KIND,
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        data: stripRecordedPosition(payload),
      };
      await this.sessionManager.appendEntry(this.sessionPath, entry);
    }
  }

  /**
   * Rewrite a draft prompt into a tighter, terminology-correct version using
   * the ACTIVE provider/model. A stateless one-off LLM call (no agent loop, no
   * tools, no session mutation) — safe to run even mid-run. Returns the plain
   * enhanced text plus typed segments marking each corrected term. Errors throw
   * so the caller can surface them.
   */
  async enhancePrompt(text: string): Promise<EnhanceResult> {
    if (!text.trim()) return { enhanced: text, segments: [{ kind: "text", text }] };
    const creds = await this.authStorage.resolveCredentials(this.provider, {
      storageKeys: this.currentAuthStorageKeys(),
    });
    // Cheap, best-effort stack detection from the project root so terminology is
    // idiomatic to the user's stack. Never throws (returns "" on any failure).
    let stack = "";
    try {
      stack = detectProjectStack(this.cwd);
    } catch {
      /* detection is best-effort — fall back to no stack hint */
    }
    return enhancePrompt({
      provider: this.provider,
      model: this.model,
      prompt: text,
      stack,
      apiKey: creds.accessToken,
      baseUrl: this.baseUrl ?? creds.baseUrl,
      accountId: creds.accountId,
      signal: this.opts.signal,
    });
  }

  /** Current reasoning/thinking level, or undefined when thinking is off. */
  getThinkingLevel(): ThinkingLevel | undefined {
    return this.thinkingLevel;
  }

  /** Set the reasoning/thinking level (undefined turns thinking off). Takes
   * effect on the next prompt, since the in-flight loop reads it at start. */
  setThinkingLevel(level: ThinkingLevel | undefined): void {
    this.thinkingLevel = level;
    this.refreshSystemPromptTail();
  }

  /** Replace the abort signal (e.g. after cancellation). */
  setSignal(signal: AbortSignal): void {
    this.opts = { ...this.opts, signal };
    this.bindManagerCancellation(signal);
  }

  private bindManagerCancellation(signal: AbortSignal | undefined): void {
    this.managerAbortSignal?.removeEventListener("abort", this.managerAbortHandler);
    this.managerAbortSignal = signal;
    signal?.addEventListener("abort", this.managerAbortHandler, { once: true });
    if (signal?.aborted) this.managerAbortHandler();
  }

  /** True when speedProfile is "optimized" (1-h cache TTL + pre-warm), or the
   *  session was constructed with `forceLongCacheRetention` (Ken sessions). */
  private isSpeedOptimized(): boolean {
    return (
      this.opts.forceLongCacheRetention === true ||
      this.settingsManager?.get("speedProfile") === "optimized"
    );
  }

  /**
   * Ordered auth-storage keys the current (provider, model) pair tries, first
   * match wins. Almost always just the provider id; Xiaomi models can prefer
   * one endpoint and fall back to another the user configured instead (e.g.
   * `mimo-v2.5-pro` prefers the Token Plan, falls back to API Credits; the
   * API-only `mimo-v2.5-pro-ultraspeed` has no fallback).
   */
  private currentAuthStorageKeys(): string[] {
    return getAuthStorageKeys(this.provider, this.model);
  }

  private getPromptCacheKey(): string | undefined {
    if (this.opts.promptCacheKey) return this.opts.promptCacheKey;
    if (!this.sessionId) return undefined;
    return `${this.opts.promptCacheKeyPrefix ?? "ggcoder"}:${this.sessionId}`;
  }

  /** Stable cache-routing key for downstream sub-agent processes. */
  getCurrentCacheKey(): string | undefined {
    return this.getPromptCacheKey();
  }

  async dispose(): Promise<void> {
    this.managerAbortSignal?.removeEventListener("abort", this.managerAbortHandler);
    this.processManager?.shutdownAll();
    this.lspManager?.shutdownAll();
    await Promise.all([this.subAgentManager?.shutdownAll(), this.mcpManager?.dispose()]);
    await this.extensionLoader.deactivateAll();
    this.setSessionPath("");
    this.eventBus.removeAllListeners();
    this.messages = [];
    this.tools = [];
  }

  // ── Private ────────────────────────────────────────────

  private setSessionPath(nextPath: string): void {
    if (this.sessionPath === nextPath) return;
    if (this.sessionPath) this.sessionManager.unregisterActivePath(this.sessionPath);
    this.sessionPath = nextPath;
    if (nextPath) this.sessionManager.registerActivePath(nextPath);
  }

  private async createNewSession(): Promise<void> {
    const continuingConversation = Boolean(this.conversationId && this.sessionId);
    const session = await this.sessionManager.create(this.cwd, this.provider, this.model, {
      conversationId: this.conversationId || undefined,
      generation: continuingConversation ? this.checkpointGeneration + 1 : 0,
      parentSessionId: continuingConversation ? this.sessionId : undefined,
      preview: this.sessionPreview || undefined,
    });
    this.sessionId = session.id;
    this.checkpointGeneration = session.header.generation ?? 0;
    this.conversationId = session.header.conversationId ?? session.id;
    this.setSessionPath(session.path);
    this.lastPersistedIndex = this.messages.length;
  }

  private async loadExistingSession(sessionPath: string): Promise<void> {
    // A stale physical checkpoint is only an address, not the conversation tip.
    // Resolve every resume—not just over-threshold/deferred compaction resumes—
    // before reading history so the next prompt cannot continue an old branch.
    const canonicalPath =
      (await this.sessionManager.resolveCanonicalSession(sessionPath, this.cwd)) ?? sessionPath;
    const loaded = await this.sessionManager.load(canonicalPath);
    // Use the leaf from the header to walk the correct branch
    const loadedMessages = this.sessionManager.getMessages(loaded.entries, loaded.header.leafId);
    this.checkpointGeneration = loaded.header.generation ?? 0;
    this.conversationId = loaded.header.conversationId ?? loaded.header.id;
    const legacyLabel = [...loaded.entries]
      .reverse()
      .find((entry) => entry.type === "label")
      ?.label.replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    this.sessionPreview =
      legacyLabel || loaded.header.preview || findUserSessionPrompt(loadedMessages);
    // Restore Ken's advisory turns (custom entries, not on the message branch) so
    // they reappear in the transcript and survive into the continuation file.
    // The leaf is passed so each marker also carries its FILE-order position,
    // the fallback used when a legacy anchor is out of range (see
    // RecordedPosition).
    this.kenTurns = this.sessionManager.getKenTurns(loaded.entries, loaded.header.leafId);
    // Restore autopilot verdict markers the same way (not on the message DAG).
    this.autopilotMarkers = this.sessionManager.getAutopilotMarkers(
      loaded.entries,
      loaded.header.leafId,
    );
    // Restore app transcript markers (plan banner / task header / errors / hints).
    this.appMarkers = this.sessionManager.getAppMarkers(loaded.entries, loaded.header.leafId);
    this.turnMetrics = this.sessionManager.getTurnMetrics(loaded.entries);
    // A run that opened the journal and never closed it died mid-flight. Read
    // it here, before anything rewrites the file, and report it once the
    // transcript is in place.
    const interruptedRuns = this.sessionManager.getUnfinishedRuns(loaded.entries);

    // Track the current leaf for subsequent entries
    this.currentLeafId = loaded.header.leafId;

    // Rebuild messages: keep system, add loaded. Older gg-app sessions may
    // contain full-resolution attachments; repair them once on load so they do
    // not fail when Anthropic's stricter many-image limit activates later.
    const systemMsg = this.messages[0]; // Already built
    this.messages = [systemMsg, ...loadedMessages];
    const normalizedImageCount = await normalizeMessageImages(this.messages);
    if (normalizedImageCount > 0) {
      log("INFO", "session", `Resized ${normalizedImageCount} restored session image(s)`);
    }
    // Auto-compact on load if the restored session exceeds the context window.
    // Without this, huge sessions (1M+ tokens) get loaded into memory and OOM.
    //
    // These credentials only SIZE the context window here — but an expired
    // OAuth token makes resolving them refresh over the network, and restoring
    // a window awaits this method. Offline, that refresh rejects with "fetch
    // failed", session creation fails, the window never receives a port, and
    // its UI blames the sidecar for never starting. A transport failure must
    // not decide whether a session can open: degrade to no account context and
    // leave credentials to the first prompt, which needs them for real and can
    // report a failure honestly.
    let creds: OAuthCredentials | undefined;
    try {
      creds = await this.authStorage.resolveCredentials(this.provider, {
        storageKeys: this.currentAuthStorageKeys(),
      });
    } catch (err) {
      log(
        "WARN",
        "session",
        "Restore credential resolution failed — opening without account context",
        {
          provider: this.provider,
          message: err instanceof Error ? err.message : String(err),
        },
      );
    }
    // Cache for sync callers (see field doc) so the app-sidecar's footer shows
    // the right context window immediately on resume, before any prompt runs
    // runLoop() and would otherwise be the first to set this.
    this.lastAccountId = creds?.accountId;
    const contextWindow = getContextWindow(this.model, {
      provider: this.provider,
      accountId: creds?.accountId,
    });
    this.sessionId = loaded.header.id;
    this.setSessionPath(loaded.path);
    this.lastPersistedIndex = this.messages.length;

    const loadPolicy = resolveCompactionPolicy({
      provider: this.provider,
      model: this.model,
      contextWindow,
      threshold: this.settingsManager.get("compactThreshold"),
      accountId: creds?.accountId,
      approvedPlanPath: this.approvedPlanPath,
    });
    log("INFO", "compaction", "Restore compaction decision", {
      provider: this.provider,
      model: this.model,
      transport: this.provider === "openai" && creds?.accountId ? "codex_oauth" : "public_api",
      contextWindow: String(contextWindow),
      activeTokens: "estimated",
      triggerLimit: String(loadPolicy.targetTokens),
    });
    const needsLoadCompaction =
      this.settingsManager.get("autoCompact") &&
      shouldCompact(this.messages, contextWindow, loadPolicy.threshold);
    // Compacting needs a live provider call, so an unresolved credential
    // defers it to the first prompt rather than attempting it here.
    if (needsLoadCompaction && (this.opts.deferLoadCompaction || !creds)) {
      // Canonicalize again immediately before the first prompt is persisted:
      // another process may create the shared checkpoint after this load.
      this.deferredCompactionPending = true;
      log(
        "INFO",
        "session",
        "Restored session exceeds context — deferring compaction to first prompt",
      );
    } else if (needsLoadCompaction && creds) {
      await this.subAgentManager?.hydrate(loaded.header.id);
      log("INFO", "session", `Restored session exceeds context — auto-compacting`);
      await this.compact(creds, "automatic");
      if (this.lastCompactionCompacted) {
        await this.recordInterruptedRuns(interruptedRuns);
        return;
      }
    }

    // Plain resume (no compaction needed): keep using the original session
    // file/id and append future turns to it in place. Forking a new file here
    // unconditionally used to create a byte-identical duplicate every time a
    // session was merely reopened (e.g. app/window restart) with zero new
    // messages in between — the duplicate entries seen in the session list.
    this.sessionId = loaded.header.id;
    this.setSessionPath(loaded.path);
    this.lastPersistedIndex = this.messages.length;
    await this.recordInterruptedRuns(interruptedRuns);
  }

  /**
   * Surface runs that died mid-flight, without resuming them.
   *
   * Deliberately NOT auto-resumed: the dead run's tools already wrote files,
   * ran commands and made commits. Replaying it would duplicate those effects.
   * The user gets a transcript row and decides.
   *
   * Each detected run is also closed as `aborted`, so reopening the session
   * reports it once rather than on every load.
   */
  private async recordInterruptedRuns(runs: RunJournalEntry[]): Promise<void> {
    for (const run of runs) {
      log("WARN", "session", "Restored a session with an unfinished run", {
        generation: String(run.generation),
        startedAt: run.startedAt,
      });
      await this.persistAppMarker("interrupted_run", {
        generation: run.generation,
        startedAt: run.startedAt,
      });
      await this.persistRunFinished(run.generation, "aborted");
    }
  }

  private async prepareDynamicContext(_latestUserPrompt?: string): Promise<Message[]> {
    return this.messages;
  }

  private async persistMessage(message: Message): Promise<void> {
    if (
      !this.sessionPreview &&
      message.role === "user" &&
      (message.provenance?.source === "human" || !message.provenance)
    ) {
      this.sessionPreview = getUserSessionPrompt(message.content, message.provenance) ?? "";
    }
    // Transient sessions (subagent spawns) have no session file — skip.
    if (!this.sessionPath) return;
    const entryId = crypto.randomUUID();
    const entry: MessageEntry = {
      type: "message",
      id: entryId,
      parentId: this.currentLeafId,
      timestamp: new Date().toISOString(),
      message,
    };
    await this.sessionManager.appendEntry(this.sessionPath, entry);
    this.currentLeafId = entryId;
    await this.sessionManager.updateLeaf(this.sessionPath, entryId);
  }

  private createSlashCommandContext(): SlashCommandContext {
    return {
      switchModel: (provider, model) => this.switchModel(provider, model),
      compact: () => this.compact(undefined, "manual"),
      newSession: () => this.newSession(),
      listSessions: async () => {
        const sessions = await this.sessionManager.list(this.cwd);
        if (sessions.length === 0) return "No sessions found.";
        return sessions
          .map((s) => `  ${s.id.slice(0, 8)} — ${s.timestamp} (${s.messageCount} messages)`)
          .join("\n");
      },
      getSettings: () => this.settingsManager.getAll() as unknown as Record<string, unknown>,
      setSetting: async (key, value) => {
        await this.settingsManager.set(
          key as keyof ReturnType<SettingsManager["getAll"]>,
          value as never,
        );
      },
      getModelList: () => {
        const current = `Current: ${this.provider}:${this.model}\n\nAvailable models:\n`;
        const list = MODELS.map((m) => `  ${m.provider}:${m.id} — ${m.name} (${m.costTier})`).join(
          "\n",
        );
        return current + list;
      },
      quit: () => {
        process.exit(0);
      },
      branch: async (stepsBack?: number) => {
        const result = await this.branch(stepsBack);
        return `Branched: rewound from ${result.branchedFrom} to ${result.messagesKept} messages. New messages will fork from here.`;
      },
      listBranches: async () => {
        const branches = await this.listBranches();
        if (branches.length <= 1) return "No branches — conversation is linear.";
        const lines = branches.map(
          (b, i) =>
            `  ${i + 1}. ${b.leafId.slice(0, 8)} — ${b.entryCount} entries (${b.leafId === this.currentLeafId ? "active" : "inactive"})`,
        );
        return `${branches.length} branch(es):\n${lines.join("\n")}`;
      },
      addDirectory: (dir) => this.addDirectory(dir),
      removeDirectory: (dir) => this.removeDirectory(dir),
      getAdditionalRoots: () => this.getAdditionalRoots(),
    };
  }

  /**
   * Import a Claude Code / Codex / Cursor transcript as a resumable GG Coder
   * session in this session's sessions directory. Never throws — a bad path or
   * an unrecognized format comes back as `{ ok: false, error }` so both the CLI
   * and the desktop app can show it verbatim.
   */
  async importForeignTranscript(
    filePath: string,
    opts: { cwd?: string } = {},
  ): Promise<ImportForeignTranscriptResult> {
    try {
      const imported = await importForeignSession({
        filePath: resolveHomePath(filePath),
        sessionManager: this.sessionManager,
        provider: this.provider,
        model: this.model,
        cwd: opts.cwd ?? undefined,
      });
      log("INFO", "import", "Imported foreign transcript", {
        format: imported.format,
        messages: String(imported.messageCount),
      });
      return {
        ok: true,
        sessionId: imported.sessionId,
        sessionPath: imported.sessionPath,
        cwd: imported.cwd,
        format: imported.format,
        messageCount: imported.messageCount,
        dropped: describeDropped(imported.dropped),
        ...(imported.preview ? { preview: imported.preview } : {}),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Expand a leading `~` so `/import ~/.codex/...` works from any shell. */
function resolveHomePath(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}
