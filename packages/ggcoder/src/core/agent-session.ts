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
import { MOONSHOT_OAUTH_KEY } from "@kenkaiiii/gg-core";
import { getClaudeCliUserAgent } from "./claude-code-version.js";
import { kimiCodingHeaders, isKimiCodingEndpoint } from "./oauth/kimi.js";
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
  type TurnMetricPayload,
} from "./session-manager.js";
import { ExtensionLoader } from "./extensions/loader.js";
import type { ExtensionContext } from "./extensions/types.js";
import { shouldCompact, compact } from "./compaction/compactor.js";
import {
  getAuthStorageKeys,
  getContextWindow,
  getModel,
  getToolResultCharLimit,
  MODELS,
} from "./model-registry.js";
import { discoverSkills, type Skill } from "./skills.js";
import { ensureAppDirs } from "../config.js";
import { buildSystemPrompt } from "../system-prompt.js";
import {
  createTools,
  createWebSearchTool,
  type LspManager,
  type ProcessManager,
} from "../tools/index.js";
import type { BackgroundProcess } from "./process-manager.js";
import { buildSubAgentCompletionFollowUp, type SubAgentManager } from "./subagent-manager.js";
import { applyAsyncSubagentPolicy } from "./subagent-policy.js";
import { MCPClientManager, getAllMcpServers } from "./mcp/index.js";
import { DeferredToolCatalog } from "./mcp/deferred-catalog.js";
import { createToolSearchTool } from "../tools/tool-search.js";
import { log } from "./logger.js";
import { setEstimatorModel } from "./compaction/token-estimator.js";
import { calculateActiveContextTokens } from "./compaction/active-context.js";
import { pruneStaleToolResults } from "./compaction/tool-result-pruner.js";
import { discoverAgents } from "./agents.js";
import { enhancePrompt, type EnhanceResult } from "../utils/prompt-enhancer.js";
import { detectProjectStack } from "./language-detector.js";
import {
  type IdealReviewStats,
  evaluateIdealReview,
  buildIdealReviewMessage,
  buildReviewCoverageMessage,
  withReviewCoverageRequirements,
  detectTestDrift,
  ReviewCoverageTracker,
} from "./ideal-review.js";
import {
  evaluateLoopBreak,
  buildLoopBreakMessage,
  ToolCallProgressTracker,
  detectTextRepetition,
} from "./loop-breaker.js";
import { buildRegroundingMessage } from "./regrounding.js";
import { wrapSteeringText, STEERING_PREFIX } from "./steering.js";
import { findUserSessionPrompt, getUserSessionPrompt } from "./session-preview.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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
  systemPrompt?: string;
  /** Synchronous volatile prompt suffix, refreshed immediately before every run. */
  getSystemPromptTail?: () => string;
  sessionId?: string;
  continueRecent?: boolean;
  maxTokens?: number;
  maxTurns?: number;
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
  private hookFileEditCounts = new Map<string, number>();
  private hookToolCalls = new Map<string, { name: string; args: Record<string, unknown> }>();
  private idealReviewPhase: "idle" | "reviewing" | "complete" = "idle";
  /** Runtime-only suppression while Ken owns verification in autopilot mode. */
  private idealReviewSuppressed = false;
  private readonly reviewCoverage: ReviewCoverageTracker;
  private loopBreakInjected = false;
  private regroundingInjected = false;
  private compactionOccurred = false;
  private lastCompactionCompacted = false;
  private compactionRetryAfter = 0;
  /** Latest provider count, anchored to the assistant response it measured. */
  private providerContext: { usage: Usage; anchor: Message } | null = null;
  private originalRequest = "";
  // Messages queued by the user while a run is in flight. Drained at the
  // mid-loop steering boundary (user steering wins over the hooks), mirroring
  // the TUI's getSteeringMessages. Each entry carries its own attachments so a
  // user can queue media (images/video/files) mid-run, not just plain text.
  private userQueue: Array<{ text: string; attachments: SessionAttachment[] }> = [];
  private processManager?: ProcessManager;
  private lspManager?: LspManager;
  private subAgentManager?: SubAgentManager;
  private managerAbortSignal?: AbortSignal;
  private readonly managerAbortHandler = () => {
    void this.subAgentManager?.interruptAll();
  };
  private mcpManager?: MCPClientManager;
  /** Deferred MCP tools awaiting discovery via tool_search (bench A win). */
  private mcpCatalog?: DeferredToolCatalog;
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
  /** Stable prompt prefix retained separately from the volatile uncached tail. */
  private baseSystemPrompt = "";
  /** Shared with the tool layer so plan-mode restrictions read live state. */
  private planModeRef = { current: false };
  /** Path of the approved plan currently being implemented, or undefined. When
   *  set, the system prompt carries the `[DONE:n]` progress contract so the
   *  model emits step-completion markers the UI's plan-progress widget reads. */
  private approvedPlanPath?: string;

  private sessionId = "";
  /** Stable identity shared by compaction and approved-plan checkpoint files. */
  private conversationId = "";
  /** Original user-authored prompt, retained when internal messages replace history. */
  private sessionPreview = "";
  /** Runtime conversation identity for provider transport headers. Transient
   *  children need one even though they intentionally have no persisted session. */
  private readonly transportSessionId = crypto.randomUUID();
  private sessionPath = "";
  private lastPersistedIndex = 0;
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
      provider: this.provider,
      model: this.model,
      lspDiagnostics: this.settingsManager.get("lspDiagnostics"),
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
      disableAsyncSubagents: this.opts.subagentWorker,
      onSubAgentState: (snapshot) => this.eventBus.emit("subagent_state", snapshot),
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
    this.mcpManager = new MCPClientManager();
    if (this.opts.backgroundMcpConnect) {
      void this.connectMcpServers();
    } else {
      await this.connectMcpServers();
    }

    const basePrompt =
      this.customSystemPrompt ??
      (await buildSystemPrompt(
        this.cwd,
        this.skills,
        false,
        undefined,
        this.tools.map((tool) => tool.name),
        undefined,
        this.provider,
      ));
    this.baseSystemPrompt = basePrompt;
    this.messages = [{ role: "system", content: this.withSystemPromptTail(basePrompt) }];
    this.syncUltraOrchestrationPrompt();

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
      let servers = await getAllMcpServers(this.provider, apiKey, this.cwd);
      // Whitelisted allow-listed session: connect ONLY the named servers, never
      // the user's full configured set (which could include mutating tools). The
      // whitelist only restricts in allow-list mode (the documented contract) so
      // a normal session is never affected by a stray allowedMcpServers.
      if (this.opts.allowedTools && mcpWhitelist) {
        servers = servers.filter((s) => mcpWhitelist.includes(s.name));
      }
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
    } catch (err) {
      log(
        "WARN",
        "mcp",
        `MCP initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Route freshly connected MCP tools: deferred into the tool_search catalog
   * (default — keeps ~8k tokens of schema out of every cache-miss turn, see
   * bench/RESULTS.md bench A) or pushed eagerly when the user opted out.
   * Allow-listed sessions (Ken) always get the eager path — their fixed tool
   * expectations predate the catalog, and tool_search isn't allow-listed.
   * Promotion pushes onto the live `this.tools` array the running agent loop
   * re-reads every turn, so promoted tools are callable on the next step.
   */
  private addMcpTools(mcpTools: AgentTool[]): void {
    if (mcpTools.length === 0) return;
    const defer = !this.opts.allowedTools && this.settingsManager.get("deferredMcpTools");
    if (!defer) {
      this.tools.push(...mcpTools);
      return;
    }
    this.mcpCatalog ??= new DeferredToolCatalog();
    this.mcpCatalog.add(mcpTools);
    if (!this.tools.some((t) => t.name === "tool_search")) {
      this.tools.push(
        createToolSearchTool(this.mcpCatalog, (promoted) => {
          this.tools.push(...promoted);
        }),
      );
    }
  }

  /**
   * Process user input. Handles slash commands or runs agent loop.
   */
  async prompt(content: string): Promise<void> {
    const parsedInput = this.slashCommands.parse(content);
    const coderCommands = this.opts.coderSlashCommands !== false;
    // Non-coder agents only intercept commands registered in their own registry.
    // Unknown `/text` stays a normal conversational prompt.
    const parsed =
      parsedInput && (coderCommands || this.slashCommands.get(parsedInput.name))
        ? parsedInput
        : null;
    if (parsed) {
      // GG Coder alone can resolve its prompt-template and project commands.
      const builtinPromptCmd = coderCommands ? getPromptCommand(parsed.name) : undefined;
      const customCmds = coderCommands ? await loadCustomCommands(this.cwd) : [];
      const customPromptCmd = !builtinPromptCmd
        ? customCmds.find((c) => c.name === parsed.name)
        : undefined;
      const promptText = builtinPromptCmd?.prompt ?? customPromptCmd?.prompt;

      if (promptText) {
        // Inject the prompt-template command as a user message to the agent
        const fullPrompt = parsed.args
          ? `${promptText}\n\n## User Instructions\n\n${parsed.args}`
          : promptText;
        // Run as a normal prompt (push message + agent loop)
        const userMessage: Message = { role: "user", content: fullPrompt };
        this.messages.push(userMessage);
        await this.persistMessage(userMessage);
        this.lastPersistedIndex = this.messages.length;
        await this.runLoop();
        return;
      }

      const cmdContext = this.createSlashCommandContext();
      const result = await this.slashCommands.execute(content, cmdContext);
      if (result) {
        this.eventBus.emit("text_delta", { text: result + "\n" });
      }
      return;
    }

    // Push user message
    const userMessage: Message = { role: "user", content };
    this.messages.push(userMessage);
    await this.persistMessage(userMessage);
    this.lastPersistedIndex = this.messages.length;

    await this.runLoop();
  }

  /**
   * Prompt with multimodal attachments (images / videos) alongside optional
   * text. Images and videos become native content blocks the model can see;
   * non-media files are surfaced as a text note with their saved path so the
   * agent can open them with its tools. Slash-command parsing is skipped —
   * attachments are always a direct conversational turn.
   */
  async promptWithAttachments(text: string, attachments: SessionAttachment[]): Promise<void> {
    const parts = this.buildAttachmentParts(text, attachments);
    if (parts.length === 0) return;
    const userMessage: Message = { role: "user", content: parts };
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
    const modelSupportsVideo = getModel(this.model)?.supportsVideo ?? false;
    for (const a of attachments) {
      if (a.kind === "image") {
        parts.push({ type: "image", mediaType: a.mediaType, data: a.data });
        if (a.path) {
          parts.push({ type: "text", text: `[Image saved at ${a.path}]` });
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
    this.hookFileEditCounts.clear();
    this.hookToolCalls.clear();
    this.reviewCoverage.reset();
    this.idealReviewPhase = "idle";
    this.loopBreakInjected = false;
    this.regroundingInjected = false;
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
        if (name === "edit" && !event.isError) {
          const diff = (event.details as { diff?: string } | undefined)?.diff ?? event.result;
          const added = (diff.match(/^\+[^+]/gm) ?? []).length;
          const removed = (diff.match(/^-[^-]/gm) ?? []).length;
          this.hookStats.changedLines += added + removed;
        }
        break;
      }
      case "turn_end":
        this.hookStats.turns = event.turn;
        for (let index = this.messages.length - 1; index >= 0; index--) {
          const anchor = this.messages[index];
          if (anchor?.role === "assistant") {
            this.providerContext = { usage: { ...event.usage }, anchor };
            break;
          }
        }
        await this.persistTurnMetric(event);
        break;
    }
  }

  /**
   * Mid-loop steering hook: fires the loop-breaker when the agent looks stuck,
   * then post-compaction re-grounding. At most one of each per run. Mirrors the
   * TUI's getSteeringMessages ordering (minus user steering, which the app
   * delivers as normal prompts).
   */
  private getHookSteeringMessages(): Message[] | null {
    // User steering wins: drain any messages queued during this run first so the
    // agent sees them mid-loop instead of after it stops.
    if (this.userQueue.length > 0) {
      const queued = this.userQueue.splice(0);
      // Frame each queued item as concurrent steering — without this wrapper
      // the model treats a mid-run message as a fresh request that supersedes
      // the original task and silently drops it. ONE message per queued item
      // (not merged): each persists as its own user message, so a resumed
      // session shows the same number of bubbles the live run did.
      return queued.map((m): Message => {
        if (m.attachments.length === 0) {
          return { role: "user", content: wrapSteeringText(m.text) };
        }
        // Queued attachments ride the same native-block path as a non-queued
        // attachment prompt, prefixed with the steering framing.
        const parts: Array<TextContent | ImageContent | VideoContent> = [
          { type: "text", text: STEERING_PREFIX },
          ...this.buildAttachmentParts(m.text, m.attachments),
        ];
        return { role: "user", content: parts };
      });
    }
    if (this.opts.selfCorrectionHooks === false) return null;
    if (!this.settingsManager.get("idealReviewEnabled")) return null;
    if (!this.loopBreakInjected) {
      const decision = evaluateLoopBreak({
        consecutiveFailures: this.hookConsecutiveFailures,
        repeatedNoProgressCalls: this.hookRepeatedNoProgressCalls,
        textRepetitionDetected: detectTextRepetition(this.hookText),
      });
      if (decision.shouldBreak) {
        this.loopBreakInjected = true;
        log("INFO", "loop-break", "Injecting loop-break nudge", {
          reasons: decision.reasons.join(", "),
        });
        this.eventBus.emit("hook", { kind: "loop_break" });
        return [buildLoopBreakMessage(decision.reasons)];
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
   * Pre-stop Ideal review phase machine. Once review starts, completion is
   * blocked until harness-owned post-injection reads cover every changed file.
   */
  private getHookFollowUpMessages(): Message[] | null {
    const childCompletionFollowUp = buildSubAgentCompletionFollowUp(this.subAgentManager);
    if (childCompletionFollowUp) return childCompletionFollowUp;
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
        return [
          this.withReviewLspEvidence(buildReviewCoverageMessage(coverage.missing), lspEvidence),
        ];
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
    return { role: "user", content: `${String(message.content)}\n\n${notes.join(" ")}` };
  }

  /** Auto-compact if needed, run agent loop with auth retry, and persist messages. */
  private async runLoop(): Promise<void> {
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

    // Auto-compact if needed. This must happen after credential resolution so
    // OpenAI OAuth/Codex sessions use the Codex product context window instead
    // of the public API model window. Failed/no-op attempts cool down across
    // prompts; provider overflow recovery still bypasses this path entirely.
    if (this.settingsManager.get("autoCompact") && Date.now() >= this.compactionRetryAfter) {
      const contextWindow = getContextWindow(this.model, {
        provider: this.provider,
        accountId: creds.accountId,
      });
      const threshold = this.settingsManager.get("compactThreshold");
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
      if (shouldCompact(this.messages, contextWindow, threshold, activeTokens)) {
        try {
          await this.compact(creds);
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
      const modelInfo = getModel(this.model);
      const effectiveBaseUrl = this.baseUrl ?? creds.baseUrl;
      const generator = agentLoop(loopMessages, {
        provider: this.provider,
        model: this.model,
        tools: this.tools,
        webSearch: true,
        maxTokens: this.maxTokens,
        maxTurns: this.opts.maxTurns,
        thinking: this.thinkingLevel,
        apiKey,
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
        // Check authoritative provider usage before every model/tool step.
        // Forced overflow recovery bypasses settings and cooldown; proactive
        // checks honor both and estimate only messages unseen by the provider.
        transformContext: async (messages, transformOpts) => {
          if (transformOpts.usage) {
            const anchorIndex = messages.length - transformOpts.pendingMessages.length - 1;
            const anchor = messages[anchorIndex];
            if (anchor?.role === "assistant") {
              this.providerContext = { usage: { ...transformOpts.usage }, anchor };
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
            const threshold = this.settingsManager.get("compactThreshold");
            const activeTokens = calculateActiveContextTokens(messages, {
              usage,
              pendingMessages,
            });
            if (!shouldCompact(messages, contextWindow, threshold, activeTokens)) return messages;
          }

          // compact() operates on this.messages, while an earlier transform may
          // have replaced the loop's in-flight array. Rebind before every attempt
          // so the current tool results are included in the summary.
          this.messages = messages;
          try {
            await this.compact({
              accessToken: apiKey,
              accountId,
              projectId,
              baseUrl: effectiveBaseUrl,
            });
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

      for await (const event of generator as AsyncIterable<AgentEvent>) {
        await this.trackHookEvent(event);
        this.eventBus.forwardAgentEvent(event);
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
      // Kimi OAuth plan ran out of usage (hard usage-limit stop, or an HTTP 402
      // billing stop). If the user ALSO configured a Moonshot API key, mark
      // the OAuth credential usage-exhausted (honoring the provider-stated
      // reset time when present) and retry this turn on the API key — OAuth
      // stays the preferred credential and resumes automatically once the mark
      // lapses. A generic 429 is deliberately excluded: it may be a transient
      // rate limit and must not silently switch the user to a billed API key.
      // Guarded on the Kimi managed endpoint actually being in use: if the API
      // key was already active, the same error means BOTH are out and must surface.
      if (
        this.provider === "moonshot" &&
        !this.baseUrl &&
        isKimiCodingEndpoint(creds.baseUrl) &&
        (isUsageLimitError(err) || (err instanceof ProviderError && err.statusCode === 402)) &&
        (await this.authStorage.hasCredentials("moonshot"))
      ) {
        const resetsAt = err instanceof ProviderError ? err.resetsAt : undefined;
        await this.authStorage.markUsageExhausted(MOONSHOT_OAUTH_KEY, resetsAt);
        log(
          "WARN",
          "auth",
          "Kimi OAuth usage limit reached — retrying this turn on the Moonshot API key",
          { resetsAt: resetsAt !== undefined ? String(resetsAt) : "unknown" },
        );
        creds = await this.authStorage.resolveCredentials(this.provider, {
          storageKeys: this.currentAuthStorageKeys(),
        });
        this.lastAccountId = creds.accountId;
        // The runAgentLoop closure re-reads `creds`, so the retry picks up the
        // API key's baseUrl (api.moonshot.ai) and drops the Kimi coding headers.
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
        // credential and surface the error so the user re-logins. Kimi OAuth
        // (active for `moonshot` when present) is refreshable, so it falls
        // through to the force-refresh path below.
        if (await clearInvalidStaticApiKey(err)) throw err;

        log("INFO", "auth", "Got 401, force-refreshing token and retrying");
        creds = await this.authStorage.resolveCredentials(this.provider, {
          forceRefresh: true,
          storageKeys: this.currentAuthStorageKeys(),
        });
        this.lastAccountId = creds.accountId;
        await runAgentLoop(creds.accessToken, creds.accountId, creds.projectId);
      } else {
        throw err;
      }
    }

    this.messages = loopMessages;

    // Persist new messages
    for (let i = this.lastPersistedIndex; i < this.messages.length; i++) {
      await this.persistMessage(this.messages[i]);
    }
    this.lastPersistedIndex = this.messages.length;
  }

  async switchModel(provider: string, model: string): Promise<void> {
    const prevProvider = this.provider;
    if (provider) this.provider = provider as Provider;
    this.model = model;
    this.providerContext = null;
    // Keep host-provided option closures (notably chat delegation) aligned with
    // the live selection after an in-session model switch.
    this.opts.provider = this.provider;
    this.opts.model = this.model;
    this.syncUltraOrchestrationPrompt();
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
        this.tools.push(createWebSearchTool());
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
          const servers = await getAllMcpServers(this.provider, apiKey, this.cwd);
          const mcpTools = await this.mcpManager.connectAll(servers);
          // Drop stale MCP tools from both the live set and deferred catalog before
          // re-adding. Some tools may already have been promoted out of the catalog.
          this.tools = this.tools.filter((t) => !t.name.startsWith("mcp__"));
          this.mcpCatalog?.removeWhere((name) => name.startsWith("mcp__"));
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

  async compact(existingCredentials?: {
    accessToken: string;
    accountId?: string;
    projectId?: string;
    baseUrl?: string;
  }): Promise<void> {
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
    this.eventBus.emit("compaction_start", { messageCount: this.messages.length });

    const result = await compact(this.messages, {
      provider: this.provider,
      model: this.model,
      apiKey: creds.accessToken,
      accountId: creds.accountId,
      projectId: creds.projectId,
      baseUrl: this.baseUrl ?? creds.baseUrl,
      contextWindow,
      signal: this.opts.signal,
    });

    this.messages = result.messages;
    this.lastCompactionCompacted = result.result.compacted;

    if (!result.result.compacted) {
      this.eventBus.emit("compaction_end", {
        originalCount: result.result.originalCount,
        newCount: result.result.newCount,
      });
      return;
    }

    this.providerContext = null;

    // Transient sessions (Ken chat/autopilot, subagent spawns) must NEVER touch
    // the session store: without this guard, the first auto-compaction called
    // sessionManager.create() and assigned a real sessionPath, silently turning
    // the "in-memory only" session into a persisted one — every later turn (and
    // every further compaction) then leaked a Ken transcript file into the
    // project's session list. Compact in memory only and keep sessionPath empty.
    if (this.opts.transient) {
      this.lastPersistedIndex = this.messages.length;
    } else {
      // Persist compacted messages to a new session file so `ggcoder continue`
      // picks up the compacted state instead of the full original history.
      const session = await this.sessionManager.create(this.cwd, this.provider, this.model, {
        conversationId: this.conversationId || undefined,
        preview: this.sessionPreview || undefined,
      });
      this.sessionId = session.id;
      this.conversationId = session.header.conversationId ?? session.id;
      this.sessionPath = session.path;
      await this.subAgentManager?.rebindParentSession(this.sessionId);

      // Write compacted messages (skip system — it's rebuilt on load)
      for (const msg of this.messages) {
        if (msg.role === "system") continue;
        await this.persistMessage(msg);
      }
      this.lastPersistedIndex = this.messages.length;
      // Carry evidence records into the new file so they survive compaction.
      await this.rePersistTurnMetrics();
      await this.rePersistKenTurns();
      await this.rePersistAutopilotMarkers();
      await this.rePersistAppMarkers();
      // Persist the compaction counts so a resumed session's quiet notice can
      // show the same "N → M messages" summary the live run did.
      await this.persistAppMarker("compaction", {
        originalCount: result.result.originalCount,
        newCount: result.result.newCount,
      });
    }

    this.eventBus.emit("compaction_end", {
      originalCount: result.result.originalCount,
      newCount: result.result.newCount,
    });
  }

  async newSession(preserveConversation = false): Promise<void> {
    // Approved-plan execution is a clean checkpoint of the same conversation;
    // explicit new sessions reset the conversation identity.
    if (!preserveConversation) {
      this.conversationId = "";
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
    const basePrompt =
      this.customSystemPrompt ??
      (await buildSystemPrompt(
        this.cwd,
        this.skills,
        false,
        undefined,
        this.tools.map((tool) => tool.name),
        undefined,
        this.provider,
      ));
    this.baseSystemPrompt = basePrompt;
    this.messages = [{ role: "system", content: this.withSystemPromptTail(basePrompt) }];
    this.syncUltraOrchestrationPrompt();
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
      this.sessionPreview = "";
      this.sessionPath = "";
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
  }

  /** Queue a user message (optionally with attachments) to be injected mid-run
   *  as steering. Returns the new queue length. No-op semantics are the caller's
   *  concern. */
  queueMessage(text: string, attachments: SessionAttachment[] = []): number {
    this.userQueue.push({ text, attachments });
    return this.userQueue.length;
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
    return this.userQueue.shift() ?? null;
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
    this.syncUltraOrchestrationPrompt();
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

  /** Rebuild messages[0] from current plan-mode + approved-plan state. */
  private async rebuildSystemPromptInPlace(): Promise<void> {
    if (this.customSystemPrompt) return;
    const rebuilt = await buildSystemPrompt(
      this.cwd,
      this.skills,
      this.planModeRef.current,
      this.approvedPlanPath,
      this.tools.map((tool) => tool.name),
      undefined,
      this.provider,
    );
    this.baseSystemPrompt = rebuilt;
    const content = this.withSystemPromptTail(rebuilt);
    if (this.messages[0]?.role === "system") {
      this.messages[0] = { role: "system", content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
    this.syncUltraOrchestrationPrompt();
  }

  private withSystemPromptTail(basePrompt: string): string {
    if (!this.opts.getSystemPromptTail) return basePrompt;
    return `${basePrompt}\n\n<!-- uncached -->\n${this.opts.getSystemPromptTail()}`;
  }

  private refreshSystemPromptTail(): void {
    if (!this.opts.getSystemPromptTail) return;
    const content = this.withSystemPromptTail(this.baseSystemPrompt);
    if (this.messages[0]?.role === "system") {
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
    const afterMessageCount = this.messages.filter((m) => m.role !== "system").length;
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
        data: payload,
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
    const afterMessageCount = this.messages.filter((m) => m.role !== "system").length;
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
        data: payload,
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
    const afterMessageCount =
      this.messages.filter((m) => m.role !== "system").length + anchorOffset;
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
        data: payload,
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
    this.syncUltraOrchestrationPrompt();
  }

  /** Sol/Terra Ultra delegates proactively; lower levels require an explicit request. */
  private syncUltraOrchestrationPrompt(): void {
    if (this.opts.orchestrationPrompt === false) return;
    const systemMessage = this.messages[0];
    if (systemMessage?.role !== "system" || typeof systemMessage.content !== "string") return;

    systemMessage.content = applyAsyncSubagentPolicy(
      systemMessage.content,
      this.provider,
      this.model,
      this.thinkingLevel,
      this.tools.map((tool) => tool.name),
    );
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
    this.eventBus.removeAllListeners();
    this.messages = [];
    this.tools = [];
  }

  // ── Private ────────────────────────────────────────────

  private async createNewSession(): Promise<void> {
    const session = await this.sessionManager.create(this.cwd, this.provider, this.model, {
      conversationId: this.conversationId || undefined,
      preview: this.sessionPreview || undefined,
    });
    this.sessionId = session.id;
    this.conversationId = session.header.conversationId ?? session.id;
    this.sessionPath = session.path;
    this.lastPersistedIndex = this.messages.length;
  }

  private async loadExistingSession(sessionPath: string): Promise<void> {
    const loaded = await this.sessionManager.load(sessionPath);
    // Use the leaf from the header to walk the correct branch
    const loadedMessages = this.sessionManager.getMessages(loaded.entries, loaded.header.leafId);
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
    this.kenTurns = this.sessionManager.getKenTurns(loaded.entries);
    // Restore autopilot verdict markers the same way (not on the message DAG).
    this.autopilotMarkers = this.sessionManager.getAutopilotMarkers(loaded.entries);
    // Restore app transcript markers (plan banner / task header / errors / hints).
    this.appMarkers = this.sessionManager.getAppMarkers(loaded.entries);
    this.turnMetrics = this.sessionManager.getTurnMetrics(loaded.entries);

    // Track the current leaf for subsequent entries
    this.currentLeafId = loaded.header.leafId;

    // Rebuild messages: keep system, add loaded
    const systemMsg = this.messages[0]; // Already built
    this.messages = [systemMsg, ...loadedMessages];

    // Auto-compact on load if the restored session exceeds the context window.
    // Without this, huge sessions (1M+ tokens) get loaded into memory and OOM.
    const creds = await this.authStorage.resolveCredentials(this.provider, {
      storageKeys: this.currentAuthStorageKeys(),
    });
    // Cache for sync callers (see field doc) so the app-sidecar's footer shows
    // the right context window immediately on resume, before any prompt runs
    // runLoop() and would otherwise be the first to set this.
    this.lastAccountId = creds.accountId;
    const contextWindow = getContextWindow(this.model, {
      provider: this.provider,
      accountId: creds.accountId,
    });
    const needsLoadCompaction =
      this.settingsManager.get("autoCompact") &&
      shouldCompact(this.messages, contextWindow, this.settingsManager.get("compactThreshold"));
    if (needsLoadCompaction && this.opts.deferLoadCompaction) {
      // Host readiness is gated on initialize() — don't block it on a summary
      // LLM call (up to 30s). runLoop()'s pre-run auto-compaction picks this
      // up on the first prompt and emits compaction_start/_end for the UI.
      log(
        "INFO",
        "session",
        "Restored session exceeds context — deferring compaction to first prompt",
      );
    } else if (needsLoadCompaction) {
      await this.subAgentManager?.hydrate(loaded.header.id);
      log("INFO", "session", `Restored session exceeds context — auto-compacting`);
      const compacted = await compact(this.messages, {
        provider: this.provider,
        model: this.model,
        apiKey: creds.accessToken,
        accountId: creds.accountId,
        projectId: creds.projectId,
        baseUrl: this.baseUrl ?? creds.baseUrl,
        contextWindow,
        signal: this.opts.signal,
      });
      this.messages = compacted.messages;
      log("INFO", "session", `Auto-compaction complete`, {
        before: String(compacted.result.originalCount),
        after: String(compacted.result.newCount),
      });

      // Compaction rewrote history, so the on-disk file no longer reflects
      // what's in memory — fork a fresh session file for the compacted state
      // (mirrors compact()'s own persistence) so `ggcoder continue` picks up
      // the summary instead of the full original transcript.
      const session = await this.sessionManager.create(this.cwd, this.provider, this.model, {
        conversationId: this.conversationId || undefined,
        preview: this.sessionPreview || undefined,
      });
      this.sessionId = session.id;
      this.conversationId = session.header.conversationId ?? session.id;
      this.sessionPath = session.path;
      await this.subAgentManager?.rebindParentSession(this.sessionId);
      this.currentLeafId = null;

      // Re-persist (compacted) messages — skip system, it's rebuilt on load
      for (const msg of this.messages) {
        if (msg.role === "system") continue;
        await this.persistMessage(msg);
      }
      this.lastPersistedIndex = this.messages.length;
      // Carry restored evidence into the continuation file.
      await this.rePersistTurnMetrics();
      await this.rePersistKenTurns();
      await this.rePersistAutopilotMarkers();
      await this.rePersistAppMarkers();
      // Record this load-time auto-compaction's counts for the resumed notice.
      await this.persistAppMarker("compaction", {
        originalCount: compacted.result.originalCount,
        newCount: compacted.result.newCount,
      });
      return;
    }

    // Plain resume (no compaction needed): keep using the original session
    // file/id and append future turns to it in place. Forking a new file here
    // unconditionally used to create a byte-identical duplicate every time a
    // session was merely reopened (e.g. app/window restart) with zero new
    // messages in between — the duplicate entries seen in the session list.
    this.sessionId = loaded.header.id;
    this.sessionPath = sessionPath;
    this.lastPersistedIndex = this.messages.length;
  }

  private async prepareDynamicContext(_latestUserPrompt?: string): Promise<Message[]> {
    return this.messages;
  }

  private async persistMessage(message: Message): Promise<void> {
    if (!this.sessionPreview && message.role === "user") {
      this.sessionPreview = getUserSessionPrompt(message.content) ?? "";
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
      compact: () => this.compact(),
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
    };
  }
}
