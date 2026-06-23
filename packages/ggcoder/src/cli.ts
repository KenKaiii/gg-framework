#!/usr/bin/env -S node --max-old-space-size=8192 --expose-gc
// Default V8 heap (~1.5–4GB depending on Node version) can fatal-OOM on
// long sessions — tool results are capped at 50KB each but accumulate
// across thousands of turns, and Ink/React state plus the SDK clients
// share the same heap. 8GB gives ample headroom; --expose-gc is unused
// today but matches gg-boss for consistency. NODE_OPTIONS overrides via
// Node's standard flag merge.

// Catch stray abort-related promise rejections that escape the normal error
// handling chain (e.g. race conditions during Ctrl+C). Without this, Node.js
// v25+ crashes the process on any unhandled rejection.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error) {
    const msg = reason.message.toLowerCase();
    if (reason.name === "AbortError" || msg.includes("aborted") || msg.includes("abort")) {
      // Silently swallow abort rejections — these are expected during cancellation
      return;
    }
  }
  // Re-throw non-abort rejections so they still crash with a useful stack trace
  throw reason;
});

// Drain ALL performance entries to prevent unbounded memory growth.
// Node emits entries for marks, measures, resource timing (HTTP), DNS, net, etc.
// Without clearing, these accumulate across every LLM call and tool execution.
import { PerformanceObserver, performance } from "node:perf_hooks";
{
  const allTypes = PerformanceObserver.supportedEntryTypes.filter(
    (t) => t !== "gc" && t !== "function",
  );
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      switch (entry.entryType) {
        case "measure":
          performance.clearMeasures(entry.name);
          break;
        case "mark":
          performance.clearMarks(entry.name);
          break;
        case "resource":
          performance.clearResourceTimings();
          break;
      }
    }
  }).observe({ entryTypes: allTypes });
}

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import fs from "node:fs";
import readline from "node:readline/promises";
import { renderApp } from "./ui/render.js";
import { runJsonMode } from "./modes/json-mode.js";
import { runRpcMode } from "./modes/rpc-mode.js";
import { runServeMode } from "./modes/serve-mode.js";
import {
  loadTelegramConfig,
  saveTelegramConfig,
  isValidBotTokenFormat,
} from "./core/telegram-config.js";
import { runAgentHomeMode } from "./modes/agent-home-mode.js";
import { renderSessionSelector } from "./ui/sessions.js";
import type { CompletedItem } from "./ui/app-items.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { segmentDisplayText, stripDoneMarkers } from "./utils/plan-steps.js";
import { formatUserError } from "./utils/error-handler.js";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { ThemeName } from "./ui/theme/theme.js";
import { AuthStorage } from "./core/auth-storage.js";
import { SessionManager } from "./core/session-manager.js";
import { ensureAppDirs, getAppPaths, loadSavedSettings } from "./config.js";
import { initLogger, log, closeLogger } from "./core/logger.js";
import { setStreamDiagnostic } from "@kenkaiiii/gg-agent";
import { setProviderDiagnostic } from "@kenkaiiii/gg-ai";
import { buildSystemPrompt } from "./system-prompt.js";
import { PROMPT_COMMANDS } from "./core/prompt-commands.js";
import { createTools } from "./tools/index.js";
import { CheckpointStore } from "./core/checkpoint-store.js";
import { shouldCompact, compact } from "./core/compaction/compactor.js";
import {
  createCompactedSessionCheckpoint,
  formatRestoreInfoText,
  getRestoredMessagesForDisplay,
} from "./core/session-compaction.js";
import { setEstimatorModel } from "./core/compaction/token-estimator.js";
import {
  getContextWindow,
  getDefaultModel,
  getMaxThinkingLevel,
  getModel,
} from "./core/model-registry.js";
import { MCPClientManager, getAllMcpServers } from "./core/mcp/index.js";
import { runPixel } from "./cli/pixel.js";
import { runLogin, runLogout, runDoctor } from "./cli/auth.js";
import { runMcp } from "./cli/mcp.js";
import {
  CLI_VERSION,
  clearVisibleScreen,
  displayName,
  renderLogoBlock,
  requireInteractiveTTY,
} from "./cli/shared.js";
import { discoverAgents } from "./core/agents.js";
import { discoverSkills } from "./core/skills.js";
import path from "node:path";
import chalk from "chalk";
import { checkAndAutoUpdate } from "./core/auto-update.js";

import { routeCliCommandInput, type CliSubcommandName } from "./cli/command-routing.js";

const THINKING_LEVELS = new Set<ThinkingLevel>(["low", "medium", "high", "xhigh", "max"]);

export function parseThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (THINKING_LEVELS.has(value as ThinkingLevel)) return value as ThinkingLevel;
  throw new Error(
    `Invalid --thinking value "${value}". Expected low, medium, high, xhigh, or max.`,
  );
}

function printHelp(): void {
  // Clear the visible viewport for a clean look without erasing scrollback.
  clearVisibleScreen();

  const dim = chalk.dim;
  const primary = chalk.hex("#60a5fa");
  const accent = chalk.hex("#a78bfa");
  const bold = chalk.bold;

  // Banner — matches the interactive TUI banner layout
  console.log();
  for (const row of renderLogoBlock([
    primary.bold("GG Coder") + dim(` v${CLI_VERSION}`) + dim(" · By ") + bold("Ken Kai"),
    dim("AI coding agent"),
  ])) {
    console.log(row);
  }
  console.log();

  // Usage
  console.log(primary("Usage:") + "  ggcoder " + dim("[options]") + " " + dim("[prompt]"));
  console.log();

  // Commands
  console.log(primary("Commands:"));
  const cmds: [string, string][] = [
    ["login", "Log in to an AI provider (Anthropic, OpenAI, Gemini)"],
    ["logout", "Log out and clear stored credentials"],
    ["doctor", "Diagnose and fix auth/config issues"],
    ["sessions", "Browse and resume previous sessions"],
    ["continue", "Resume the most recent session"],
    ["serve", "Start the HTTP/WebSocket API server"],
    ["telegram", "Configure Telegram bot integration"],
    ["agent-home-login", "Configure Agent Home relay connection"],
    ["agent-home", "Connect to Agent Home as a remote agent"],
    ["mcp", "Add and manage MCP servers"],
  ];
  for (const [name, desc] of cmds) {
    console.log(`  ${accent(name.padEnd(20))} ${dim(desc)}`);
  }
  console.log();

  // Options
  console.log(primary("Options:"));
  const opts: [string, string][] = [
    ["-h, --help", "Show this help message"],
    ["-v, --version", "Show version number"],
    [
      "--provider <name>",
      "AI provider (anthropic, xiaomi, openai, gemini, glm, moonshot, minimax, deepseek, openrouter, sakana)",
    ],
    ["--model <name>", "Model to use (e.g. claude-sonnet-4-6, gpt-5.5)"],
    ["--max-turns <n>", "Maximum agent turns per prompt"],
    ["--system-prompt <text>", "Override the system prompt"],
    ["--thinking <level>", "Enable thinking level (low, medium, high, xhigh, max)"],
    ["--resume <id>", "Resume a session by id"],
    ["--json", "JSON output mode (for sub-agents)"],
    ["--rpc", "JSON-RPC mode (for IDE integrations)"],
  ];
  for (const [flag, desc] of opts) {
    console.log(`  ${accent(flag.padEnd(24))} ${dim(desc)}`);
  }
  console.log();

  // Interactive commands
  console.log(primary("Interactive commands") + dim(" (inside the chat):"));
  const slashCmds: [string, string][] = [
    ["/help", "Show available slash commands"],
    ["/model", "Switch AI model"],
    ["/compact", "Compact conversation context"],
    ["/session", "Switch or create sessions"],
    ["/new", "Start a new session"],
    ["/settings", "Open settings"],
    ["/quit", "Exit ggcoder"],
  ];
  for (const [name, desc] of slashCmds) {
    console.log(`  ${accent(name.padEnd(20))} ${dim(desc)}`);
  }
  console.log();

  // Keyboard shortcuts
  console.log(primary("Keyboard shortcuts:"));
  const shortcuts: [string, string][] = [
    ["Ctrl+S", "Toggle skills overlay"],
    ["Shift+Tab", "Toggle thinking"],
    ["Shift+Enter", "New line in input"],
  ];
  for (const [key, desc] of shortcuts) {
    console.log(`  ${accent(key.padEnd(20))} ${dim(desc)}`);
  }
  console.log();
}

function createCliSubcommandHandlers(): Record<CliSubcommandName, () => void> {
  const runWithStandardErrorHandling = (operation: () => Promise<void>, logStack = false): void => {
    operation().catch((err) => {
      log(
        "ERROR",
        "fatal",
        err instanceof Error ? (logStack ? (err.stack ?? err.message) : err.message) : String(err),
      );
      closeLogger();
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
  };

  return {
    pixel: () => runWithStandardErrorHandling(() => runPixel({ runInkTUI }), true),
    mcp: () => runWithStandardErrorHandling(runMcp),
    login: () => runWithStandardErrorHandling(runLogin),
    logout: () => runWithStandardErrorHandling(runLogout),
    sessions: () => runWithStandardErrorHandling(runSessions),
    telegram: () => runWithStandardErrorHandling(runTelegramSetup),
    serve: () => runWithStandardErrorHandling(runServe),
    doctor: () => {
      runDoctor().catch((err) => {
        process.stderr.write(formatUserError(err) + "\n");
        process.exit(1);
      });
    },
    "agent-home-login": () => runWithStandardErrorHandling(runAgentHomeLogin),
    "agent-home": () => runWithStandardErrorHandling(runAgentHome),
  };
}

function main(): void {
  // Silent auto-update check (throttled, non-blocking on failure)
  const updateMessage = checkAndAutoUpdate(CLI_VERSION);
  if (updateMessage) {
    console.error(chalk.bold.hex("#4ade80")(`✨ ${updateMessage}`));
  }

  const commandRoute = routeCliCommandInput({
    argv: process.argv,
    printHelp,
    exit: process.exit,
    handlers: createCliSubcommandHandlers(),
  });

  if (commandRoute.kind === "handled") {
    return;
  }

  const subcommand = commandRoute.kind === "continue" ? "continue" : commandRoute.subcommand;

  const { values, positionals } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      rpc: { type: "boolean" },
      provider: { type: "string" },
      model: { type: "string" },
      "max-turns": { type: "string" },
      "system-prompt": { type: "string" },
      "prompt-cache-key": { type: "string" },
      thinking: { type: "string" },
      resume: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (values.version) {
    console.log(CLI_VERSION);
    process.exit(0);
  }

  // JSON mode — used by sub-agents
  if (values.json) {
    const message = positionals[0] ?? "";
    const jsonProvider = (values.provider ?? "anthropic") as Provider;
    const jsonModel = values.model ?? "claude-opus-4-8";
    const maxTurns = values["max-turns"] ? parseInt(values["max-turns"], 10) : undefined;
    const systemPrompt = values["system-prompt"];
    const promptCacheKey = values["prompt-cache-key"];
    const thinkingLevel = parseThinkingLevel(values.thinking);
    const cwd = process.cwd();
    runJsonMode({
      message,
      provider: jsonProvider,
      model: jsonModel,
      cwd,
      systemPrompt,
      maxTurns,
      promptCacheKey,
      thinkingLevel,
    }).catch((err: unknown) => {
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  // RPC mode — headless JSON-over-stdio for IDE integrations
  if (values.rpc) {
    const rpcProvider = (values.provider ?? "anthropic") as Provider;
    const rpcModel = values.model ?? "claude-opus-4-8";
    const systemPrompt = values["system-prompt"];
    const cwd = process.cwd();
    runRpcMode({
      provider: rpcProvider,
      model: rpcModel,
      cwd,
      systemPrompt,
    }).catch((err: unknown) => {
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  // Load saved settings for model/provider persistence
  const saved = loadSavedSettings();
  const savedTheme = saved.theme;

  const provider: Provider = saved.provider ?? "anthropic";

  function getHardcodedDefault(p: string): string {
    if (p === "openai") return "gpt-5.5";
    if (p === "gemini") return "gemini-3.1-flash-lite-preview";
    if (p === "glm") return "glm-5.2";
    if (p === "moonshot") return "kimi-k2.7-code";
    if (p === "minimax") return "MiniMax-M3";
    if (p === "deepseek") return "deepseek-v4-pro";
    if (p === "openrouter") return "qwen/qwen3.6-plus";
    if (p === "sakana") return "fugu";
    return "claude-opus-4-8";
  }

  const model: string = saved.model ?? getHardcodedDefault(provider);
  const thinkingLevel: ThinkingLevel | undefined = saved.thinkingEnabled
    ? (saved.thinkingLevel ?? getMaxThinkingLevel(model))
    : undefined;

  // Interactive mode (Ink TUI)
  const cwd = process.cwd();
  const continueRecent = subcommand === "continue";

  runInkTUI({
    provider,
    model,
    cwd,
    thinkingLevel,
    idealReviewEnabled: saved.idealReviewEnabled,
    lspDiagnostics: saved.lspDiagnostics,
    continueRecent,
    resumeSessionPath: values.resume,
    theme: savedTheme,
  }).catch((err) => {
    log("ERROR", "fatal", err instanceof Error ? err.message : String(err));
    closeLogger();
    process.stderr.write(formatUserError(err) + "\n");
    process.exit(1);
  });
}

// ── Ink TUI ───────────────────────────────────────────────

async function runInkTUI(opts: {
  provider: Provider;
  model: string;
  cwd: string;
  thinkingLevel?: ThinkingLevel;
  continueRecent?: boolean;
  resumeSessionPath?: string;
  theme?: "auto" | ThemeName;
  initialOverlay?: "pixel";
  idealReviewEnabled?: boolean;
  lspDiagnostics?: boolean;
}): Promise<void> {
  requireInteractiveTTY();

  const { cwd } = opts;

  // Resolve auth first so we can pick an active provider the user has
  // actually logged in with — we must never default to a provider they
  // haven't authenticated against.
  const paths = await ensureAppDirs();

  // Wire stream stall diagnostics into the debug log
  setStreamDiagnostic((phase, data) => {
    log("INFO", "stream", phase, data as Record<string, unknown>);
  });
  setProviderDiagnostic((phase, data) => {
    log("INFO", "provider", phase, data as Record<string, unknown>);
  });

  const authStorage = new AuthStorage(paths.authFile);
  await authStorage.load();

  const {
    provider: preferredProvider,
    model: preferredModel,
    loggedInProviders,
  } = await resolveActiveProvider(authStorage, opts.provider, opts.model);

  // Preload every logged-in provider's credentials for the model switcher.
  // Resolve each one BEFORE picking the active provider, so a dead OAuth
  // refresh token (preferredProvider expired) doesn't crash startup — we
  // fall back to whichever other provider actually resolved.
  const credentialsByProvider: Record<
    string,
    { accessToken: string; accountId?: string; projectId?: string; baseUrl?: string }
  > = {};
  const expiredProviders: Provider[] = [];
  for (const p of loggedInProviders) {
    try {
      const resolved = await authStorage.resolveCredentials(p);
      credentialsByProvider[p] = {
        accessToken: resolved.accessToken,
        accountId: resolved.accountId,
        projectId: resolved.projectId,
        baseUrl: resolved.baseUrl,
      };
    } catch {
      // Refresh failed (resolveCredentials wipes the bad creds when the
      // refresh token is dead). Track so we can warn the user, and fall
      // back to another working provider below.
      expiredProviders.push(p);
    }
  }

  // Fall back if the preferred provider didn't resolve. The settings file
  // is NOT updated — user might re-login to the preferred one later and
  // expect to come back. This is a per-launch override.
  let provider = preferredProvider;
  let model = preferredModel;
  if (!credentialsByProvider[provider]) {
    const fallback = loggedInProviders.find((p) => credentialsByProvider[p]);
    if (!fallback) {
      throw new Error(
        'All logged-in providers expired or failed to authenticate. Run "ggcoder login" to re-authenticate.',
      );
    }
    console.warn(
      chalk.yellow(
        `⚠ ${displayName(preferredProvider)} session expired — switched to ${displayName(fallback)} for this launch.\n` +
          `  Run "ggcoder login" to re-authenticate ${displayName(preferredProvider)}.`,
      ),
    );
    provider = fallback;
    model = getDefaultModel(fallback).id;
  } else if (expiredProviders.length > 0) {
    console.warn(
      chalk.yellow(
        `⚠ Sessions expired: ${expiredProviders.map(displayName).join(", ")}. ` +
          `Run "ggcoder login" to re-authenticate.`,
      ),
    );
  }

  // Set model for token estimation accuracy (after provider is finalized)
  setEstimatorModel(model);

  initLogger(paths.logFile, {
    version: CLI_VERSION,
    provider,
    model,
    thinking: opts.thinkingLevel,
  });

  // Use the already-resolved credentials from the preload loop — no need
  // to re-resolve and risk hitting the same dead refresh path again.
  const cached = credentialsByProvider[provider]!;
  const creds = {
    accessToken: cached.accessToken,
    accountId: cached.accountId,
    projectId: cached.projectId,
    refreshToken: "", // not needed downstream; SDK only uses accessToken
    expiresAt: Number.POSITIVE_INFINITY,
  };

  // Ensure project-local .gg directories exist
  const localGGDir = path.join(cwd, ".gg");
  await fs.promises.mkdir(path.join(localGGDir, "skills"), { recursive: true });
  await fs.promises.mkdir(path.join(localGGDir, "commands"), { recursive: true });
  await fs.promises.mkdir(path.join(localGGDir, "agents"), { recursive: true });

  // Discover agents and skills
  const agents = await discoverAgents({
    globalAgentsDir: paths.agentsDir,
    projectDir: cwd,
  });
  const skills = await discoverSkills({
    globalSkillsDir: paths.skillsDir,
    projectDir: cwd,
  });

  // Runtime mode refs — shared between tools and UI
  const planModeRef = { current: false };
  const planToolCallbacks: {
    onEnterPlan?: (reason?: string) => void | Promise<void>;
    onExitPlan?: (planPath: string) => Promise<string>;
  } = {};

  // Holder so the (cwd-bound) tools can snapshot pre-mutation file state for
  // /rewind. The store is created once the session id is known (below).
  const checkpointRef: { current: CheckpointStore | null } = { current: null };
  const onPreFileMutation = (filePath: string): Promise<void> =>
    checkpointRef.current?.recordPreMutation(filePath) ?? Promise.resolve();

  const { tools, processManager, rebuildReadTool, lspManager } = await createTools(cwd, {
    agents,
    skills,
    provider,
    model,
    planModeRef,
    onPreFileMutation,
    lspDiagnostics: opts.lspDiagnostics,
    authStorage,
    onEnterPlan: (reason) => planToolCallbacks.onEnterPlan?.(reason),
    onExitPlan: (planPath) =>
      planToolCallbacks.onExitPlan?.(planPath) ?? Promise.resolve("Plan review is unavailable."),
  });

  // The active LSP pool follows the active tool set — rebuilds (pixel chdir)
  // shut the old pool down and swap in the new one.
  let activeLspManager = lspManager;

  // Rebuilds the cwd-bound tools for a different project root. Used by the
  // pixel-fix flow so the agent operates in the error's project, not in
  // wherever ggcoder was launched from.
  const rebuildToolsForCwd = async (newCwd: string) => {
    activeLspManager?.shutdownAll();
    const { tools: rebuilt, lspManager: rebuiltLspManager } = await createTools(newCwd, {
      agents,
      skills,
      provider,
      model,
      planModeRef,
      onPreFileMutation,
      lspDiagnostics: opts.lspDiagnostics,
      authStorage,
      onEnterPlan: (reason) => planToolCallbacks.onEnterPlan?.(reason),
      onExitPlan: (planPath) =>
        planToolCallbacks.onExitPlan?.(planPath) ?? Promise.resolve("Plan review is unavailable."),
    });
    activeLspManager = rebuiltLspManager;
    return rebuilt;
  };

  // MCP startup can involve `npx` installing/booting servers. Do it after the
  // TUI paints so a slow network or npm cache never looks like "nothing happens".
  const mcpManager = new MCPClientManager();
  let initialMcpConnectPromise: Promise<AgentTool[]> | undefined;
  const connectInitialMcpTools = async (): Promise<AgentTool[]> => {
    initialMcpConnectPromise ??= (async () => {
      const providerApiKey =
        provider === "glm" ? credentialsByProvider["glm"]?.accessToken : undefined;
      const servers = await getAllMcpServers(provider, providerApiKey, cwd);
      return mcpManager.connectAll(servers);
    })();
    return initialMcpConnectPromise;
  };

  const systemPrompt = await buildSystemPrompt(
    cwd,
    skills,
    planModeRef.current,
    undefined,
    tools.map((tool) => tool.name),
    undefined,
    provider,
  );

  // Kill all background processes on exit (synchronous — catches all exit paths)
  process.on("exit", () => {
    processManager.shutdownAll();
    activeLspManager?.shutdownAll();
    mcpManager.dispose().catch(() => {});
  });

  // Seed messages with system prompt
  const messages: Message[] = [{ role: "system" as const, content: systemPrompt }];

  // Session management — create or reuse session file
  const sessionManager = new SessionManager(paths.sessionsDir);
  let sessionPath: string | undefined;
  let sessionId: string | undefined;
  let initialHistory: CompletedItem[] | undefined;

  // Determine which session to resume (explicit path or most recent)
  const explicitResumePath = opts.resumeSessionPath
    ? opts.resumeSessionPath.includes("/")
      ? opts.resumeSessionPath
      : await sessionManager.findById(cwd, opts.resumeSessionPath)
    : null;
  const resumePath =
    explicitResumePath ?? (opts.continueRecent ? await sessionManager.getMostRecent(cwd) : null);

  if (resumePath) {
    try {
      const loaded = await sessionManager.load(resumePath);
      const loadedMessages = sessionManager.getMessages(loaded.entries);

      if (loadedMessages.length > 0) {
        messages.push(...loadedMessages);
        sessionPath = resumePath;
        sessionId = loaded.header.id;
        log("INFO", "session", `Restored session`, {
          path: resumePath,
          messageCount: String(loadedMessages.length),
        });

        // Auto-compact on load if the restored session exceeds the context window.
        // Without this, huge sessions (1M+ tokens) get loaded into memory and OOM.
        const contextWindow = getContextWindow(model, { provider, accountId: creds.accountId });
        if (shouldCompact(messages, contextWindow, 0.8)) {
          log("INFO", "session", `Restored session exceeds context — auto-compacting`);
          const compactionAbort = new AbortController();
          const onSigint = () => compactionAbort.abort();
          process.once("SIGINT", onSigint);
          try {
            const compacted = await compact(messages, {
              provider,
              model,
              apiKey: creds.accessToken,
              accountId: creds.accountId,
              projectId: creds.projectId,
              baseUrl: cached.baseUrl,
              contextWindow,
              signal: compactionAbort.signal,
            });
            // Persist compacted continuation to a fresh session so future
            // `ggcoder continue` starts from the compacted checkpoint instead
            // of repeatedly restoring the oversized source session.
            const compactedSession = await createCompactedSessionCheckpoint(sessionManager, {
              cwd,
              provider,
              model,
              messages: compacted.messages,
            });
            sessionPath = compactedSession.path;
            sessionId = compactedSession.id;
            messages.length = 0;
            messages.push(...compacted.messages);
            log("INFO", "session", `Auto-compaction complete`, {
              before: String(compacted.result.originalCount),
              after: String(compacted.result.newCount),
              path: sessionPath,
            });
          } finally {
            process.off("SIGINT", onSigint);
          }
        }

        const restoredMessages = getRestoredMessagesForDisplay(messages);
        const restoredDisplayItems = sessionManager.getDisplayItems(
          loaded.entries,
          loaded.header.leafId,
        );
        initialHistory =
          restoredDisplayItems.length > 0
            ? restoredDisplayItems
            : messagesToHistoryItems(restoredMessages);
        initialHistory.push({
          kind: "info",
          text: formatRestoreInfoText(loadedMessages.length, restoredMessages.length),
          id: `restore-info`,
        });
      }
    } catch {
      // Session file corrupt or missing — start fresh
    }
  }

  // Create a new session file if we didn't reuse one
  if (!sessionPath) {
    const session = await sessionManager.create(cwd, provider, model);
    sessionPath = session.path;
    sessionId = session.id;
    log("INFO", "session", `New session created`, { path: sessionPath });
  }

  // Now that the session id is finalized, back /rewind with a checkpoint store.
  if (sessionId) {
    checkpointRef.current = new CheckpointStore({ sessionId, cwd });
  }

  // Prune old session transcripts in the background — they're append-only
  // JSONL and can reach 100MB+ each, so without cleanup ~/.gg/sessions grows
  // unbounded and eventually fills the disk. Fire-and-forget: pruning must
  // never delay or break startup. The active session is explicitly protected.
  {
    const { sessionRetentionDays } = loadSavedSettings(paths.settingsFile);
    if (sessionRetentionDays > 0) {
      const keepPaths = sessionPath ? [sessionPath] : [];
      void sessionManager
        .pruneOldSessions({ maxAgeDays: sessionRetentionDays, keepPaths })
        .then(({ deletedFiles, freedBytes }) => {
          if (deletedFiles > 0) {
            log("INFO", "session", `Pruned old sessions`, {
              deletedFiles: String(deletedFiles),
              freedMB: (freedBytes / 1024 / 1024).toFixed(1),
              retentionDays: String(sessionRetentionDays),
            });
          }
        })
        .catch(() => {});
    }
  }

  await renderApp({
    provider,
    model,
    tools,
    webSearch: true,
    messages,
    version: CLI_VERSION,
    maxTokens: 16384,
    thinking: opts.thinkingLevel,
    apiKey: creds.accessToken,
    accountId: creds.accountId,
    projectId: creds.projectId,
    cwd,
    theme: opts.theme,
    loggedInProviders,
    credentialsByProvider,
    initialHistory,
    sessionsDir: paths.sessionsDir,
    sessionPath,
    sessionId,
    processManager,
    settingsFile: paths.settingsFile,
    mcpManager,
    authStorage,
    planModeRef,
    skills,
    checkpointStore: checkpointRef.current ?? undefined,
    initialOverlay: opts.initialOverlay,
    idealReviewEnabled: opts.idealReviewEnabled,
    rebuildToolsForCwd,
    rebuildReadTool,
    connectInitialMcpTools,
    planCallbacks: planToolCallbacks,
  });

  closeLogger();
}

// ── Sessions ──────────────────────────────────────────────

async function runSessions(): Promise<void> {
  requireInteractiveTTY();
  clearVisibleScreen();
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "session", "Sessions selector started");

  const cwd = process.cwd();
  const selectedPath = await renderSessionSelector(paths.sessionsDir, cwd, CLI_VERSION);

  if (!selectedPath) {
    console.log(chalk.hex("#6b7280")("No session selected."));
    closeLogger();
    process.exit(0);
  }

  const saved2 = loadSavedSettings(paths.settingsFile);

  const provider: Provider = saved2.provider ?? "anthropic";

  function getDefault(p: string): string {
    if (p === "openai") return "gpt-5.5";
    if (p === "gemini") return "gemini-3.1-flash-lite-preview";
    if (p === "glm") return "glm-5.2";
    if (p === "moonshot") return "kimi-k2.7-code";
    if (p === "minimax") return "MiniMax-M3";
    if (p === "deepseek") return "deepseek-v4-pro";
    if (p === "sakana") return "fugu";
    return "claude-opus-4-8";
  }

  const model = saved2.model ?? getDefault(provider);
  const thinkingLevel: ThinkingLevel | undefined = saved2.thinkingEnabled
    ? (saved2.thinkingLevel ?? getMaxThinkingLevel(model))
    : undefined;

  closeLogger();

  await runInkTUI({
    provider,
    model,
    cwd,
    thinkingLevel,
    idealReviewEnabled: saved2.idealReviewEnabled,
    lspDiagnostics: saved2.lspDiagnostics,
    resumeSessionPath: selectedPath,
    theme: saved2.theme,
  });
}

// ── Telegram Setup ───────────────────────────────────────

async function runTelegramSetup(): Promise<void> {
  clearVisibleScreen();
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "telegram", "Telegram setup started");

  const existing = await loadTelegramConfig();

  // Banner
  console.log();
  for (const row of renderLogoBlock([
    chalk.hex("#60a5fa").bold("GG Coder") +
      chalk.hex("#6b7280")(` v${CLI_VERSION}`) +
      chalk.hex("#6b7280")(" · By ") +
      chalk.white.bold("Ken Kai"),
    chalk.hex("#a78bfa")("Telegram Setup"),
    chalk.hex("#6b7280")("Remote Control"),
  ])) {
    console.log(row);
  }
  console.log();

  if (existing) {
    console.log(
      chalk.hex("#6b7280")("  Current config:\n") +
        chalk.hex("#6b7280")(
          `    Bot token: ${existing.botToken.slice(0, 10)}...${existing.botToken.slice(-4)}\n`,
        ) +
        chalk.hex("#6b7280")(`    User ID:   ${existing.userId}\n`),
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // Step 1: Bot token
    console.log(
      chalk.hex("#a78bfa")("  Step 1: Bot Token\n") +
        chalk.hex("#6b7280")("    1. Open BotFather: ") +
        chalk.hex("#60a5fa").underline("https://t.me/BotFather") +
        "\n" +
        chalk.hex("#6b7280")("    2. Send /newbot and follow the prompts\n") +
        chalk.hex("#6b7280")("    3. Copy the bot token\n"),
    );

    const tokenPrompt = existing
      ? chalk.hex("#60a5fa")("  Paste bot token (enter to keep current): ")
      : chalk.hex("#60a5fa")("  Paste bot token: ");
    const tokenInput = await rl.question(tokenPrompt);
    const botToken = tokenInput.trim() || existing?.botToken;

    if (!botToken) {
      console.log(chalk.hex("#ef4444")("\n  No bot token provided. Setup cancelled."));
      return;
    }

    // Validate token format (roughly: digits:alphanumeric)
    if (!isValidBotTokenFormat(botToken)) {
      console.log(chalk.hex("#ef4444")("\n  Invalid token format. Expected: 123456789:ABCdef..."));
      return;
    }

    // Step 2: User ID
    console.log(
      chalk.hex("#a78bfa")("\n  Step 2: User ID\n") +
        chalk.hex("#6b7280")("    1. Open userinfobot: ") +
        chalk.hex("#60a5fa").underline("https://t.me/userinfobot") +
        "\n" +
        chalk.hex("#6b7280")("    2. Send any message — it replies with your numeric ID\n") +
        chalk.hex("#6b7280")("    Only this user ID can control the bot.\n"),
    );

    const userPrompt = existing
      ? chalk.hex("#60a5fa")(`  Your Telegram user ID (enter to keep ${existing.userId}): `)
      : chalk.hex("#60a5fa")("  Your Telegram user ID: ");
    const userInput = await rl.question(userPrompt);
    const userId = userInput.trim() ? parseInt(userInput.trim(), 10) : existing?.userId;

    if (!userId || isNaN(userId)) {
      console.log(chalk.hex("#ef4444")("\n  Invalid user ID. Must be a number."));
      return;
    }

    // Step 3: Verify bot token by calling getMe
    console.log(chalk.hex("#6b7280")("\n  Verifying bot token..."));

    const verifyRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      method: "POST",
    });
    const verifyData = (await verifyRes.json()) as {
      ok: boolean;
      result?: { username: string; first_name: string };
    };

    if (!verifyData.ok || !verifyData.result) {
      console.log(
        chalk.hex("#ef4444")("\n  Invalid bot token — Telegram rejected it. Check and try again."),
      );
      return;
    }

    const botName = verifyData.result.first_name;
    const botUsername = verifyData.result.username;

    // Save config
    await saveTelegramConfig({ botToken, userId });

    log("INFO", "telegram", `Telegram setup complete: @${botUsername} (user ${userId})`);

    console.log(
      chalk.hex("#4ade80")(`\n  ✓ Connected to @${botUsername} (${botName})\n`) +
        chalk.hex("#4ade80")(`  ✓ Authorized user ID: ${userId}\n`) +
        chalk.hex("#4ade80")(`  ✓ Config saved to ${paths.telegramFile}\n\n`) +
        chalk.hex("#a78bfa")("  For group chats:\n") +
        chalk.hex("#6b7280")(
          "    1. Message @BotFather → /setprivacy → select your bot → Disable\n",
        ) +
        chalk.hex("#6b7280")("    2. Add the bot to your group\n") +
        chalk.hex("#6b7280")("    3. Send /link in the group to connect it to a project\n\n") +
        chalk.hex("#60a5fa")("  To start:\n") +
        chalk.hex("#6b7280")("    cd your-project && ggcoder serve\n"),
    );
  } finally {
    rl.close();
    closeLogger();
  }
}

// ── Serve (Telegram) ─────────────────────────────────────

async function runServe(): Promise<void> {
  const { values: serveValues } = parseArgs({
    options: {
      "bot-token": { type: "string" },
      "user-id": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
    },
    strict: true,
  });

  // Priority: CLI flags > env vars > saved config
  const saved = await loadTelegramConfig();
  const botToken = serveValues["bot-token"] ?? process.env.GG_TELEGRAM_BOT_TOKEN ?? saved?.botToken;
  const userIdStr = serveValues["user-id"] ?? process.env.GG_TELEGRAM_USER_ID;
  const userId = userIdStr ? parseInt(userIdStr, 10) : saved?.userId;

  if (!botToken || !userId || isNaN(userId)) {
    console.error(
      chalk.hex("#ef4444")("Telegram not configured.\n\n") +
        "Run " +
        chalk.hex("#60a5fa").bold("ggcoder telegram") +
        " to set up your bot token and user ID.\n\n" +
        chalk.hex("#6b7280")("Or provide manually:\n") +
        chalk.hex("#6b7280")("  ggcoder serve --bot-token TOKEN --user-id ID"),
    );
    process.exit(1);
  }

  const saved3 = loadSavedSettings();

  const paths = await ensureAppDirs();
  const authStorage = new AuthStorage(paths.authFile);
  await authStorage.load();

  const preferredProvider: Provider =
    (serveValues.provider as Provider | undefined) ?? saved3.provider ?? "anthropic";
  const { provider, model } = await resolveActiveProvider(
    authStorage,
    preferredProvider,
    serveValues.model ?? saved3.model,
  );

  const thinkingLevel: ThinkingLevel | undefined = saved3.thinkingEnabled
    ? (saved3.thinkingLevel ?? getMaxThinkingLevel(model))
    : undefined;

  initLogger(paths.logFile, {
    version: CLI_VERSION,
    provider,
    model,
  });

  setEstimatorModel(model);

  await runServeMode({
    provider,
    model,
    cwd: process.cwd(),
    version: CLI_VERSION,
    thinkingLevel,
    telegram: { botToken, userId },
  });
}

// ── Agent Home Setup ────────────────────────────────────

interface AgentHomeConfig {
  token: string;
}

async function loadAgentHomeConfig(): Promise<AgentHomeConfig | null> {
  try {
    const raw = await fs.promises.readFile(getAppPaths().agentHomeFile, "utf-8");
    const data = JSON.parse(raw) as AgentHomeConfig;
    if (data.token) return data;
    return null;
  } catch {
    return null;
  }
}

async function saveAgentHomeConfig(config: AgentHomeConfig): Promise<void> {
  const paths = await ensureAppDirs();
  await fs.promises.writeFile(paths.agentHomeFile, JSON.stringify(config, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

async function runAgentHomeLogin(): Promise<void> {
  clearVisibleScreen();
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "agent-home", "Agent Home login started");

  const existing = await loadAgentHomeConfig();

  // Banner
  console.log();
  for (const row of renderLogoBlock([
    chalk.hex("#60a5fa").bold("GG Coder") +
      chalk.hex("#6b7280")(` v${CLI_VERSION}`) +
      chalk.hex("#6b7280")(" \u00b7 By ") +
      chalk.white.bold("Ken Kai"),
    chalk.hex("#a78bfa")("Agent Home Setup"),
    chalk.hex("#6b7280")("Remote Control via iOS"),
  ])) {
    console.log(row);
  }
  console.log();

  if (existing) {
    console.log(
      chalk.hex("#6b7280")("  Current config:\n") +
        chalk.hex("#6b7280")(
          `    Token:  ${existing.token.slice(0, 8)}...${existing.token.slice(-4)}\n`,
        ),
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log(
      chalk.hex("#a78bfa")("  Auth Token\n") +
        chalk.hex("#6b7280")(
          "    Open Agent Home iOS app \u2192 Settings \u2192 Generate SDK Token\n",
        ) +
        chalk.hex("#6b7280")("    Copy the token\n"),
    );

    const tokenPrompt = existing
      ? chalk.hex("#60a5fa")("  Auth token (enter to keep current): ")
      : chalk.hex("#60a5fa")("  Auth token: ");
    const tokenInput = await rl.question(tokenPrompt);
    const token = tokenInput.trim() || existing?.token;

    if (!token) {
      console.log(chalk.hex("#ef4444")("\n  No token provided. Setup cancelled."));
      return;
    }

    // Save config
    await saveAgentHomeConfig({ token });

    log("INFO", "agent-home", `Agent Home setup complete`);

    console.log(
      chalk.hex("#4ade80")(`\n  \u2713 Token saved`) +
        "\n" +
        chalk.hex("#4ade80")(`  \u2713 Config saved to ${paths.agentHomeFile}`) +
        "\n\n" +
        chalk.hex("#60a5fa")("  To start:\n") +
        chalk.hex("#6b7280")("    cd your-project && ggcoder agent-home\n"),
    );
  } finally {
    rl.close();
    closeLogger();
  }
}

// ── Agent Home (Run) ────────────────────────────────────

async function runAgentHome(): Promise<void> {
  const { values: ahValues } = parseArgs({
    options: {
      token: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
    },
    strict: true,
  });

  // Priority: CLI flags > saved config
  const saved = await loadAgentHomeConfig();
  const token = ahValues.token ?? saved?.token;

  if (!token) {
    console.error(
      chalk.hex("#ef4444")("Agent Home not configured.\n\n") +
        "Run " +
        chalk.hex("#60a5fa").bold("ggcoder agent-home-login") +
        " to set up your token.\n\n" +
        chalk.hex("#6b7280")("Or provide manually:\n") +
        chalk.hex("#6b7280")("  ggcoder agent-home --token TOKEN"),
    );
    process.exit(1);
  }

  const saved4 = loadSavedSettings();

  const paths = await ensureAppDirs();
  const authStorage = new AuthStorage(paths.authFile);
  await authStorage.load();

  const preferredProvider: Provider =
    (ahValues.provider as Provider | undefined) ?? saved4.provider ?? "anthropic";
  const { provider, model } = await resolveActiveProvider(
    authStorage,
    preferredProvider,
    ahValues.model ?? saved4.model,
  );

  const thinkingLevel: ThinkingLevel | undefined = saved4.thinkingEnabled
    ? (saved4.thinkingLevel ?? getMaxThinkingLevel(model))
    : undefined;

  initLogger(paths.logFile, {
    version: CLI_VERSION,
    provider,
    model,
  });

  setEstimatorModel(model);

  await runAgentHomeMode({
    provider,
    model,
    cwd: process.cwd(),
    version: CLI_VERSION,
    thinkingLevel,
    agentHome: { token },
  });
}

// ── Pixel ──────────────────────────────────────────────────

// ── Helpers ────────────────────────────────────────────────

/**
 * Pick the provider/model to start with. If the preferred provider isn't
 * one the user is logged into, fall back to the first provider they ARE
 * logged into (in `allProviders` order). Throws if nothing is logged in.
 *
 * This prevents the CLI from crashing with "Not logged in" on startup just
 * because settings.json remembers a provider the user later logged out of.
 */
async function resolveActiveProvider(
  authStorage: AuthStorage,
  preferred: Provider,
  savedModel: string | undefined,
): Promise<{ provider: Provider; model: string; loggedInProviders: Provider[] }> {
  const allProviders: Provider[] = [
    "anthropic",
    "xiaomi",
    "openai",
    "gemini",
    "glm",
    "moonshot",
    "minimax",
    "deepseek",
    "openrouter",
    "sakana",
  ];
  const loggedInProviders: Provider[] = [];
  for (const p of allProviders) {
    if (await authStorage.hasProviderAuth(p)) loggedInProviders.push(p);
  }

  if (loggedInProviders.length === 0) {
    throw new Error('Not logged in to any provider. Run "ggcoder login" to authenticate.');
  }

  if (loggedInProviders.includes(preferred)) {
    const savedModelInfo = savedModel ? getModel(savedModel) : undefined;
    return {
      provider: preferred,
      model:
        savedModelInfo?.provider === preferred ? savedModelInfo.id : getDefaultModel(preferred).id,
      loggedInProviders,
    };
  }

  // Preferred provider isn't authenticated — fall back to the first one
  // that is, and use that provider's default model (the saved model
  // belonged to a provider the user can no longer reach).
  const provider = loggedInProviders[0]!;
  return { provider, model: getDefaultModel(provider).id, loggedInProviders };
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

function restoredPromptCommandDisplayText(text: string): string | null {
  for (const command of PROMPT_COMMANDS) {
    if (text === command.prompt) return `/${command.name}`;
    const prefix = `${command.prompt}\n\n## User Instructions\n\n`;
    if (text.startsWith(prefix)) {
      const args = text.slice(prefix.length).trim();
      return args ? `/${command.name} ${args}` : `/${command.name}`;
    }
  }
  return null;
}

export function messagesToHistoryItems(msgs: Message[]): CompletedItem[] {
  const items: CompletedItem[] = [];
  let id = 0;

  const pushRestoredAssistantText = (text: string) => {
    const segments = segmentDisplayText(text, []);
    if (segments.length === 0) {
      const stripped = stripDoneMarkers(text);
      if (stripped) items.push({ kind: "assistant", text: stripped, id: `restore-${id++}` });
      return;
    }
    for (const segment of segments) {
      if (segment.kind === "text") {
        const stripped = stripDoneMarkers(segment.text).trimStart();
        if (stripped) items.push({ kind: "assistant", text: stripped, id: `restore-${id++}` });
      } else {
        items.push({
          kind: "step_done",
          stepNum: segment.stepNum,
          description: segment.description,
          id: `restore-${id++}`,
        });
      }
    }
  };

  // Index tool results by toolCallId for pairing with tool calls
  const toolResults = new Map<string, { content: string; isError: boolean }>();
  for (const msg of msgs) {
    if (msg.role === "tool") {
      for (const tr of msg.content) {
        const text =
          typeof tr.content === "string"
            ? tr.content
            : tr.content
                .map((b) => (b.type === "text" ? b.text : `[image ${b.mediaType}]`))
                .join("\n");
        toolResults.set(tr.toolCallId, {
          content: text,
          isError: tr.isError ?? false,
        });
      }
    }
  }

  const roleCounts: Record<string, number> = {};
  const blockTypeCounts: Record<string, number> = {};

  for (const msg of msgs) {
    roleCounts[msg.role] = (roleCounts[msg.role] ?? 0) + 1;

    if (msg.role === "user") {
      const text = extractText(msg.content);
      if (!text) continue;
      items.push({
        kind: "user",
        text: restoredPromptCommandDisplayText(text) ?? text,
        id: `restore-${id++}`,
      });
    } else if (msg.role === "assistant") {
      const content = msg.content;
      if (typeof content === "string") {
        if (content) pushRestoredAssistantText(content);
        continue;
      }
      for (const block of content) {
        blockTypeCounts[block.type] = (blockTypeCounts[block.type] ?? 0) + 1;
      }
      // Pair server_tool_result blocks with their server_tool_call by id
      // (both live in the same assistant message for provider-side tools).
      const serverResults = new Map<string, { resultType: string; data: unknown }>();
      for (const block of content) {
        if (block.type === "server_tool_result") {
          serverResults.set(block.toolUseId, {
            resultType: block.resultType,
            data: block.data,
          });
        }
      }
      // Walk blocks in order. Buffer consecutive text blocks into a single
      // assistant item (mirrors live rendering), and flush the buffer before
      // each tool_call / server_tool_call so chronology is preserved.
      let textBuf = "";
      const flushText = () => {
        if (textBuf) {
          pushRestoredAssistantText(textBuf);
          textBuf = "";
        }
      };
      for (const block of content) {
        switch (block.type) {
          case "text":
            if (block.text) textBuf += (textBuf ? "\n" : "") + block.text;
            break;
          case "tool_call": {
            flushText();
            const result = toolResults.get(block.id);
            items.push({
              kind: "tool_done",
              name: block.name,
              args: block.args,
              result: result?.content ?? "",
              isError: result?.isError ?? false,
              durationMs: 0,
              id: `restore-${id++}`,
            });
            break;
          }
          case "server_tool_call": {
            flushText();
            const serverResult = serverResults.get(block.id);
            items.push({
              kind: "server_tool_done",
              name: block.name,
              input: block.input,
              resultType: serverResult?.resultType ?? "",
              data: serverResult?.data ?? null,
              durationMs: 0,
              id: `restore-${id++}`,
            });
            break;
          }
          // thinking, image, raw, server_tool_result: not surfaced in restored history
        }
      }
      flushText();
    }
  }

  log("INFO", "session", "messagesToHistoryItems", {
    totalMessages: String(msgs.length),
    roleCounts: JSON.stringify(roleCounts),
    blockTypeCounts: JSON.stringify(blockTypeCounts),
    toolResultsIndexed: String(toolResults.size),
    historyItemsProduced: String(items.length),
    itemKinds: JSON.stringify(items.map((i) => i.kind)),
  });

  return items;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fs.realpathSync(path.resolve(process.argv[1]))
) {
  main();
}
