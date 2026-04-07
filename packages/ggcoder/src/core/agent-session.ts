import { agentLoop, isAbortError, type AgentEvent, type AgentTool } from "@kenkaiiii/gg-agent";
import { ProviderError, type Message, type Provider, type ThinkingLevel } from "@kenkaiiii/gg-ai";
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
import { SessionManager, type MessageEntry, type BranchInfo } from "./session-manager.js";
import { ExtensionLoader } from "./extensions/loader.js";
import type { ExtensionContext } from "./extensions/types.js";
import { shouldCompact, compact } from "./compaction/compactor.js";
import { getContextWindow, getModel, MODELS } from "./model-registry.js";
import { discoverSkills, type Skill } from "./skills.js";
import { ensureAppDirs } from "../config.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { createTools, createWebSearchTool, type ProcessManager } from "../tools/index.js";
import { MCPClientManager, getMCPServers } from "./mcp/index.js";
import { log } from "./logger.js";
import { setEstimatorModel } from "./compaction/token-estimator.js";
import { discoverAgents } from "./agents.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// ── Options ────────────────────────────────────────────────

export interface AgentSessionOptions {
  provider: Provider;
  model: string;
  cwd: string;
  baseUrl?: string;
  systemPrompt?: string;
  sessionId?: string;
  continueRecent?: boolean;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
}

// ── State ──────────────────────────────────────────────────

export interface AgentSessionState {
  provider: Provider;
  model: string;
  cwd: string;
  sessionId: string;
  sessionPath: string;
  messageCount: number;
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
  private tools: AgentTool[] = [];
  private skills: Skill[] = [];
  private processManager?: ProcessManager;
  private mcpManager?: MCPClientManager;

  private provider: Provider;
  private model: string;
  private cwd: string;
  private baseUrl?: string;
  private maxTokens: number;
  private thinkingLevel?: ThinkingLevel;
  private customSystemPrompt?: string;

  private sessionId = "";
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
    this.baseUrl = options.baseUrl;
    this.maxTokens = options.maxTokens ?? getModel(options.model)?.maxOutputTokens ?? 16384;
    this.thinkingLevel = options.thinkingLevel;
    this.customSystemPrompt = options.systemPrompt;
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

    // Session manager
    this.sessionManager = new SessionManager(paths.sessionsDir);

    // Ensure project-local .gg directories exist
    const localGGDir = path.join(this.cwd, ".gg");
    await fs.mkdir(path.join(localGGDir, "skills"), { recursive: true });
    await fs.mkdir(path.join(localGGDir, "commands"), { recursive: true });
    await fs.mkdir(path.join(localGGDir, "agents"), { recursive: true });

    // Discover skills
    this.skills = await discoverSkills({
      globalSkillsDir: paths.skillsDir,
      projectDir: this.cwd,
    });

    // Build system prompt
    const basePrompt = this.customSystemPrompt ?? (await buildSystemPrompt(this.cwd, this.skills));
    this.messages = [{ role: "system", content: basePrompt }];

    // Discover agents and create tools (with sub-agent support)
    const agents = await discoverAgents({
      globalAgentsDir: paths.agentsDir,
      projectDir: this.cwd,
    });
    const { tools, processManager } = createTools(this.cwd, {
      agents,
      skills: this.skills,
      provider: this.provider,
      model: this.model,
    });
    this.tools = tools;
    this.processManager = processManager;

    // Connect MCP servers (non-blocking — failures are logged and skipped)
    this.mcpManager = new MCPClientManager();
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
      const mcpTools = await this.mcpManager.connectAll(getMCPServers(this.provider, apiKey));
      this.tools.push(...mcpTools);
    } catch (err) {
      log(
        "WARN",
        "mcp",
        `MCP initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Load or create session
    if (this.opts.sessionId) {
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

    // Register slash commands
    const builtins = createBuiltinCommands();
    for (const cmd of builtins) {
      this.slashCommands.register(cmd);
    }

    // Wire up /help to show all registered + prompt + custom commands
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

        // Add prompt-template commands
        if (PROMPT_COMMANDS.length > 0) {
          lines.push("");
          lines.push("Prompt commands:");
          for (const cmd of PROMPT_COMMANDS) {
            lines.push(
              `  /${cmd.name}${cmd.aliases.length ? ` (${cmd.aliases.map((a) => "/" + a).join(", ")})` : ""} — ${cmd.description}`,
            );
          }
        }

        // Add custom commands from .gg/commands/
        const customCmds = await loadCustomCommands(cwd);
        if (customCmds.length > 0) {
          lines.push("");
          lines.push("Custom commands:");
          for (const cmd of customCmds) {
            lines.push(`  /${cmd.name} — ${cmd.description}`);
          }
        }

        return "Available commands:\n" + lines.join("\n");
      };
    }

    // Load extensions
    const extContext: ExtensionContext = {
      eventBus: this.eventBus,
      registerTool: (tool) => this.tools.push(tool),
      registerSlashCommand: (cmd) => this.slashCommands.register(cmd),
      cwd: this.cwd,
      settingsManager: this.settingsManager,
    };
    await this.extensionLoader.loadAll(paths.extensionsDir, extContext);

    this.eventBus.emit("session_start", { sessionId: this.sessionId });
  }

  /**
   * Process user input. Handles slash commands or runs agent loop.
   */
  async prompt(content: string): Promise<void> {
    // Check for slash commands
    const parsed = this.slashCommands.parse(content);
    if (parsed) {
      // Check prompt-template commands first (built-in + custom)
      const builtinPromptCmd = getPromptCommand(parsed.name);
      const customCmds = await loadCustomCommands(this.cwd);
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

  /** Auto-compact if needed, run agent loop with auth retry, and persist messages. */
  private async runLoop(): Promise<void> {
    // Auto-compact if needed
    if (this.settingsManager.get("autoCompact")) {
      const contextWindow = getContextWindow(this.model);
      const threshold = this.settingsManager.get("compactThreshold");
      if (shouldCompact(this.messages, contextWindow, threshold)) {
        await this.compact();
      }
    }

    // Resolve OAuth credentials and run agent loop.
    // On 401, force-refresh the token and retry once — the provider may have
    // revoked the token server-side before the stored expiry (e.g. after a restart).
    let creds = await this.authStorage.resolveCredentials(this.provider);

    const runAgentLoop = async (apiKey: string, accountId?: string) => {
      const generator = agentLoop(this.messages, {
        provider: this.provider,
        model: this.model,
        tools: this.tools,
        webSearch: true,
        maxTokens: this.maxTokens,
        thinking: this.thinkingLevel,
        apiKey,
        baseUrl: this.baseUrl,
        signal: this.opts.signal,
        accountId,
        cacheRetention: "short",
        // clearToolUses disabled — causes model to output unsolicited context summaries
        // Single tool result shouldn't exceed 30% of context window (in chars)
        maxToolResultChars: Math.floor(getContextWindow(this.model) * 3.5 * 0.3),
      });

      for await (const event of generator as AsyncIterable<AgentEvent>) {
        this.eventBus.forwardAgentEvent(event);
      }
    };

    try {
      await runAgentLoop(creds.accessToken, creds.accountId);
    } catch (err) {
      // Abort errors are expected (user cancellation) — don't retry or re-throw
      if (isAbortError(err) || this.opts.signal?.aborted) {
        return;
      }
      if (err instanceof ProviderError && err.statusCode === 401) {
        // API-key providers (GLM, Moonshot) have no refresh mechanism — retrying
        // with the same key is pointless. Clear the credential and let the error
        // surface so the user knows to re-login with a valid key.
        if (this.provider === "glm" || this.provider === "moonshot") {
          log("WARN", "auth", `Got 401 for ${this.provider} — API key is invalid or revoked`);
          await this.authStorage.clearCredentials(this.provider);
          throw err;
        }
        log("INFO", "auth", "Got 401, force-refreshing token and retrying");
        creds = await this.authStorage.resolveCredentials(this.provider, { forceRefresh: true });
        await runAgentLoop(creds.accessToken, creds.accountId);
      } else {
        throw err;
      }
    }

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
    setEstimatorModel(model);
    this.eventBus.emit("model_change", { provider: this.provider, model: this.model });

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

      // Reconnect MCP servers (e.g. GLM needs Z.AI tools, others don't)
      if (this.mcpManager) {
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
          const mcpTools = await this.mcpManager.connectAll(getMCPServers(this.provider, apiKey));
          this.tools.push(...mcpTools);
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

  async compact(): Promise<void> {
    const contextWindow = getContextWindow(this.model);
    this.eventBus.emit("compaction_start", { messageCount: this.messages.length });

    const creds = await this.authStorage.resolveCredentials(this.provider);

    const result = await compact(this.messages, {
      provider: this.provider,
      model: this.model,
      apiKey: creds.accessToken,
      contextWindow,
      signal: this.opts.signal,
    });

    this.messages = result.messages;

    // Persist compacted messages to a new session file so `ggcoder continue`
    // picks up the compacted state instead of the full original history.
    const session = await this.sessionManager.create(this.cwd, this.provider, this.model);
    this.sessionId = session.id;
    this.sessionPath = session.path;

    // Write compacted messages (skip system — it's rebuilt on load)
    for (const msg of this.messages) {
      if (msg.role === "system") continue;
      await this.persistMessage(msg);
    }
    this.lastPersistedIndex = this.messages.length;

    this.eventBus.emit("compaction_end", {
      originalCount: result.result.originalCount,
      newCount: result.result.newCount,
    });
  }

  async newSession(): Promise<void> {
    const basePrompt = this.customSystemPrompt ?? (await buildSystemPrompt(this.cwd, this.skills));
    this.messages = [{ role: "system", content: basePrompt }];
    await this.createNewSession();
    this.eventBus.emit("session_start", { sessionId: this.sessionId });
  }

  async loadSession(sessionPath: string): Promise<void> {
    await this.loadExistingSession(sessionPath);
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
    };
  }

  getMessages(): Message[] {
    return this.messages;
  }

  /** Replace the abort signal (e.g. after cancellation). */
  setSignal(signal: AbortSignal): void {
    this.opts = { ...this.opts, signal };
  }

  async dispose(): Promise<void> {
    this.processManager?.shutdownAll();
    await this.mcpManager?.dispose();
    await this.extensionLoader.deactivateAll();
    this.eventBus.removeAllListeners();
    this.messages = [];
    this.tools = [];
  }

  // ── Private ────────────────────────────────────────────

  private async createNewSession(): Promise<void> {
    const session = await this.sessionManager.create(this.cwd, this.provider, this.model);
    this.sessionId = session.id;
    this.sessionPath = session.path;
    this.lastPersistedIndex = this.messages.length;
  }

  private async loadExistingSession(sessionPath: string): Promise<void> {
    const loaded = await this.sessionManager.load(sessionPath);
    // Use the leaf from the header to walk the correct branch
    const loadedMessages = this.sessionManager.getMessages(loaded.entries, loaded.header.leafId);

    // Track the current leaf for subsequent entries
    this.currentLeafId = loaded.header.leafId;

    // Rebuild messages: keep system, add loaded
    const systemMsg = this.messages[0]; // Already built
    this.messages = [systemMsg, ...loadedMessages];

    // Auto-compact on load if the restored session exceeds the context window.
    // Without this, huge sessions (1M+ tokens) get loaded into memory and OOM.
    const contextWindow = getContextWindow(this.model);
    if (shouldCompact(this.messages, contextWindow, 0.8)) {
      log("INFO", "session", `Restored session exceeds context — auto-compacting`);
      const creds = await this.authStorage.resolveCredentials(this.provider);
      const compacted = await compact(this.messages, {
        provider: this.provider,
        model: this.model,
        apiKey: creds.accessToken,
        contextWindow,
        signal: this.opts.signal,
      });
      this.messages = compacted.messages;
      log("INFO", "session", `Auto-compaction complete`, {
        before: String(compacted.result.originalCount),
        after: String(compacted.result.newCount),
      });
    }

    // Create new session file for continuation
    const session = await this.sessionManager.create(this.cwd, this.provider, this.model);
    this.sessionId = session.id;
    this.sessionPath = session.path;

    // Re-persist (compacted) messages — skip system, it's rebuilt on load
    for (const msg of this.messages) {
      if (msg.role === "system") continue;
      await this.persistMessage(msg);
    }
    this.lastPersistedIndex = this.messages.length;
  }

  private async persistMessage(message: Message): Promise<void> {
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
