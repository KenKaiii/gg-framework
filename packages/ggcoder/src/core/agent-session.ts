import { agentLoop, type AgentEvent, type AgentTool } from "@kenkaiiii/gg-agent";
import { ProviderError, type Message, type Provider, type ThinkingLevel } from "@kenkaiiii/gg-ai";
import { EventBus } from "./event-bus.js";
import {
  SlashCommandRegistry,
  createBuiltinCommands,
  type SlashCommandContext,
} from "./slash-commands.js";
import { SettingsManager } from "./settings-manager.js";
import { AuthStorage } from "./auth-storage.js";
import { SessionManager, type MessageEntry } from "./session-manager.js";
import { ExtensionLoader } from "./extensions/loader.js";
import type { ExtensionContext } from "./extensions/types.js";
import { shouldCompact, compact } from "./compaction/compactor.js";
import { getContextWindow, MODELS } from "./model-registry.js";
import { discoverSkills, type Skill } from "./skills.js";
import { ensureAppDirs } from "../config.js";
import { buildSystemPrompt } from "../system-prompt.js";
import { createTools, type ProcessManager } from "../tools/index.js";
import { MCPClientManager, getMCPServers } from "./mcp/index.js";
import { log } from "./logger.js";
import crypto from "node:crypto";

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

  private opts: AgentSessionOptions;

  constructor(options: AgentSessionOptions) {
    this.opts = options;
    this.provider = options.provider;
    this.model = options.model;
    this.cwd = options.cwd;
    this.baseUrl = options.baseUrl;
    this.maxTokens = options.maxTokens ?? 16384;
    this.thinkingLevel = options.thinkingLevel;
    this.customSystemPrompt = options.systemPrompt;
  }

  async initialize(): Promise<void> {
    const paths = await ensureAppDirs();

    // Load settings & auth
    this.settingsManager = new SettingsManager(paths.settingsFile);
    await this.settingsManager.load();

    this.authStorage = new AuthStorage(paths.authFile);
    await this.authStorage.load();

    // Session manager
    this.sessionManager = new SessionManager(paths.sessionsDir);

    // Discover skills
    this.skills = await discoverSkills({
      globalSkillsDir: paths.skillsDir,
      projectDir: this.cwd,
    });

    // Build system prompt
    const basePrompt = this.customSystemPrompt ?? (await buildSystemPrompt(this.cwd, this.skills));
    this.messages = [{ role: "system", content: basePrompt }];

    // Create tools
    const { tools, processManager } = createTools(this.cwd);
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

    // Wire up /help to show all registered commands
    const helpCmd = this.slashCommands.get("help");
    if (helpCmd) {
      const registry = this.slashCommands;
      helpCmd.execute = () => {
        const all = registry.getAll();
        const lines = all.map(
          (c) =>
            `  /${c.name}${c.aliases.length ? ` (${c.aliases.map((a) => "/" + a).join(", ")})` : ""} — ${c.description}`,
        );
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
      });

      for await (const event of generator as AsyncIterable<AgentEvent>) {
        this.eventBus.forwardAgentEvent(event);
      }
    };

    try {
      await runAgentLoop(creds.accessToken, creds.accountId);
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 401) {
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
    this.eventBus.emit("model_change", { provider: this.provider, model: this.model });

    // Reconnect MCP servers when provider changes (e.g. GLM needs Z.AI tools, others don't)
    if (provider && provider !== prevProvider && this.mcpManager) {
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
    this.lastPersistedIndex = 0; // Re-persist all after compaction

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

  async dispose(): Promise<void> {
    this.processManager?.shutdownAll();
    await this.mcpManager?.dispose();
    await this.extensionLoader.deactivateAll();
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
    const loadedMessages = this.sessionManager.getMessages(loaded.entries);

    // Rebuild messages: keep system, add loaded
    const systemMsg = this.messages[0]; // Already built
    this.messages = [systemMsg, ...loadedMessages];

    // Create new session file for continuation
    const session = await this.sessionManager.create(this.cwd, this.provider, this.model);
    this.sessionId = session.id;
    this.sessionPath = session.path;

    // Re-persist loaded messages
    for (const msg of loadedMessages) {
      await this.persistMessage(msg);
    }
    this.lastPersistedIndex = this.messages.length;
  }

  private async persistMessage(message: Message): Promise<void> {
    const entry: MessageEntry = {
      type: "message",
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      message,
    };
    await this.sessionManager.appendEntry(this.sessionPath, entry);
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
    };
  }
}
