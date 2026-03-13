#!/usr/bin/env node

// Drain performance entries to prevent buffer overflow warning from dependencies
import { PerformanceObserver } from "node:perf_hooks";
new PerformanceObserver(() => {}).observe({ entryTypes: ["measure", "mark"] });

import { parseArgs } from "node:util";
import fs from "node:fs";
import readline from "node:readline/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { renderApp } from "./ui/render.js";
import { renderLoginSelector } from "./ui/login.js";
import { renderSessionSelector } from "./ui/sessions.js";
import type { CompletedItem } from "./ui/App.js";
import { formatUserError } from "./utils/error-handler.js";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AuthStorage } from "./core/auth-storage.js";
import { SessionManager } from "./core/session-manager.js";
import { ensureAppDirs, getAppPaths } from "./config.js";
import { initLogger, log, closeLogger } from "./core/logger.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createTools } from "./tools/index.js";
import { MCPClientManager, getMCPServers } from "./core/mcp/index.js";
import { discoverAgents } from "./core/agents.js";
import { loginAnthropic } from "./core/oauth/anthropic.js";
import { loginOpenAI } from "./core/oauth/openai.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./core/oauth/types.js";
import chalk from "chalk";
import { checkAndAutoUpdate } from "./core/auto-update.js";

const _require = createRequire(import.meta.url);
const CLI_VERSION = (_require("../package.json") as { version: string }).version;

function main(): void {
  // Silent auto-update check (throttled, non-blocking on failure)
  const updateMessage = checkAndAutoUpdate(CLI_VERSION);
  if (updateMessage) {
    console.error(chalk.hex("#60a5fa")(updateMessage));
  }

  // Handle subcommands before parseArgs
  const subcommand = process.argv[2];

  if (subcommand === "login") {
    runLogin().catch((err) => {
      log("ERROR", "fatal", err instanceof Error ? err.message : String(err));
      closeLogger();
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  if (subcommand === "logout") {
    runLogout().catch((err) => {
      log("ERROR", "fatal", err instanceof Error ? err.message : String(err));
      closeLogger();
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  if (subcommand === "sessions") {
    process.argv.splice(2, 1);
    runSessions().catch((err) => {
      log("ERROR", "fatal", err instanceof Error ? err.message : String(err));
      closeLogger();
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  if (subcommand === "continue") {
    // Remove "continue" so parseArgs handles remaining flags
    process.argv.splice(2, 1);
  }

  const { values } = parseArgs({
    options: {
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.version) {
    console.log(CLI_VERSION);
    process.exit(0);
  }

  // Load saved settings for model/provider persistence
  let savedProvider: "anthropic" | "openai" | "glm" | "moonshot" | undefined;
  let savedModel: string | undefined;
  let savedThinkingEnabled = false;
  let savedTheme: "auto" | "dark" | "light" = "auto";
  try {
    const raw = JSON.parse(fs.readFileSync(getAppPaths().settingsFile, "utf-8"));
    if (raw.defaultProvider) savedProvider = raw.defaultProvider;
    if (raw.defaultModel) savedModel = raw.defaultModel;
    if (raw.thinkingEnabled === true) savedThinkingEnabled = true;
    if (raw.theme === "dark" || raw.theme === "light" || raw.theme === "auto")
      savedTheme = raw.theme;
  } catch {
    // No settings file or invalid JSON — use defaults
  }

  const provider: "anthropic" | "openai" | "glm" | "moonshot" = savedProvider ?? "anthropic";

  function getHardcodedDefault(p: string): string {
    if (p === "openai") return "gpt-5.3-codex";
    if (p === "glm") return "glm-5";
    if (p === "moonshot") return "kimi-k2.5";
    return "claude-opus-4-6";
  }

  const model: string = savedModel ?? getHardcodedDefault(provider);
  const thinkingLevel: ThinkingLevel | undefined = savedThinkingEnabled ? "medium" : undefined;

  // Interactive mode (Ink TUI)
  const cwd = process.cwd();
  const continueRecent = subcommand === "continue";

  runInkTUI({
    provider,
    model,
    cwd,
    thinkingLevel,
    continueRecent,
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
  theme?: "auto" | "dark" | "light";
}): Promise<void> {
  const { provider, model, cwd } = opts;

  // Resolve auth
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, {
    version: CLI_VERSION,
    provider,
    model,
    thinking: opts.thinkingLevel,
  });

  const authStorage = new AuthStorage(paths.authFile);
  await authStorage.load();
  const creds = await authStorage.resolveCredentials(provider);

  // Detect all logged-in providers and preload their credentials
  const allProviders: Provider[] = ["anthropic", "openai", "glm", "moonshot"];
  const loggedInProviders: Provider[] = [];
  const credentialsByProvider: Record<string, { accessToken: string; accountId?: string }> = {};

  for (const p of allProviders) {
    const stored = await authStorage.getCredentials(p);
    if (stored) {
      loggedInProviders.push(p);
      try {
        const resolved = await authStorage.resolveCredentials(p);
        credentialsByProvider[p] = {
          accessToken: resolved.accessToken,
          accountId: resolved.accountId,
        };
      } catch {
        // Token refresh failed — still mark as logged in
      }
    }
  }

  // Discover agents and build tools
  const agents = await discoverAgents({
    globalAgentsDir: paths.agentsDir,
    projectDir: cwd,
  });

  // Build system prompt & tools (with sub-agent support)
  const systemPrompt = await buildSystemPrompt(cwd);
  const { tools, processManager } = createTools(cwd, { agents, provider, model });

  // Connect MCP servers
  const mcpManager = new MCPClientManager();
  try {
    const providerApiKey =
      provider === "glm" ? credentialsByProvider["glm"]?.accessToken : undefined;
    const mcpTools = await mcpManager.connectAll(getMCPServers(provider, providerApiKey));
    tools.push(...mcpTools);
  } catch (err) {
    log(
      "WARN",
      "mcp",
      `MCP initialization failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Kill all background processes on exit (synchronous — catches all exit paths)
  process.on("exit", () => {
    processManager.shutdownAll();
    mcpManager.dispose().catch(() => {});
  });

  // Seed messages with system prompt
  const messages: Message[] = [{ role: "system" as const, content: systemPrompt }];

  // Session management — create or reuse session file
  const sessionManager = new SessionManager(paths.sessionsDir);
  let sessionPath: string | undefined;
  let initialHistory: CompletedItem[] | undefined;

  // Determine which session to resume (explicit path or most recent)
  const resumePath =
    opts.resumeSessionPath ??
    (opts.continueRecent ? await sessionManager.getMostRecent(cwd) : null);

  if (resumePath) {
    try {
      const loaded = await sessionManager.load(resumePath);
      const loadedMessages = sessionManager.getMessages(loaded.entries);

      if (loadedMessages.length > 0) {
        messages.push(...loadedMessages);
        sessionPath = resumePath;
        log("INFO", "session", `Restored session`, {
          path: resumePath,
          messageCount: String(loadedMessages.length),
        });
        initialHistory = messagesToHistoryItems(loadedMessages);
        initialHistory.push({
          kind: "info",
          text: `↻ Restored session (${loadedMessages.length} messages)`,
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
    log("INFO", "session", `New session created`, { path: sessionPath });
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
    cwd,
    theme: opts.theme,
    loggedInProviders,
    credentialsByProvider,
    initialHistory,
    sessionsDir: paths.sessionsDir,
    sessionPath,
    processManager,
    settingsFile: paths.settingsFile,
    mcpManager,
    authStorage,
  });

  closeLogger();
}

// ── Login ──────────────────────────────────────────────────

async function runLogin(): Promise<void> {
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "auth", "Login flow started");

  const authStorage = new AuthStorage();
  await authStorage.load();

  // Phase 1: Ink-based provider selector
  const provider = await renderLoginSelector();
  if (!provider) {
    console.log(chalk.hex("#6b7280")("Login cancelled."));
    return;
  }

  console.log(
    chalk.hex("#60a5fa").bold("\nLogging in to ") +
      chalk.hex("#a78bfa")(displayName(provider)) +
      chalk.hex("#60a5fa").bold("...\n"),
  );

  // Phase 2: OAuth flow (readline needed for Anthropic code paste)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const callbacks: OAuthLoginCallbacks = {
      onOpenUrl: (url) => {
        console.log(chalk.hex("#60a5fa").bold("Opening browser..."));
        openBrowser(url);
        console.log(
          chalk.hex("#6b7280")("\nIf the browser didn't open, visit:\n") +
            chalk.hex("#6b7280")(url) +
            "\n",
        );
      },
      onPromptCode: async (message) => {
        return rl.question(message + " ");
      },
      onStatus: (message) => {
        console.log(chalk.hex("#6b7280")(message));
      },
    };

    let creds;
    if (provider === "glm" || provider === "moonshot") {
      const keyLabel = provider === "glm" ? "Z.AI" : "Moonshot";
      const apiKey = await rl.question(chalk.hex("#60a5fa")(`Paste your ${keyLabel} API key: `));
      if (!apiKey.trim()) {
        console.log(chalk.hex("#ef4444")("No API key provided. Login cancelled."));
        return;
      }
      creds = {
        accessToken: apiKey.trim(),
        refreshToken: "",
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 * 100, // ~100 years
      } satisfies OAuthCredentials;
    } else {
      creds =
        provider === "anthropic" ? await loginAnthropic(callbacks) : await loginOpenAI(callbacks);
    }

    await authStorage.setCredentials(provider, creds);
    log("INFO", "auth", `Login succeeded for ${displayName(provider)}`);
    console.log(chalk.hex("#4ade80")(`\n✓ Logged in to ${displayName(provider)} successfully!`));
  } finally {
    rl.close();
    closeLogger();
  }
}

// ── Logout ─────────────────────────────────────────────────

async function runLogout(): Promise<void> {
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "auth", "Logout requested");

  const authStorage = new AuthStorage();
  await authStorage.load();
  await authStorage.clearAll();
  log("INFO", "auth", "Logout succeeded");
  closeLogger();
  console.log(chalk.green("Logged out successfully."));
}

// ── Sessions ──────────────────────────────────────────────

async function runSessions(): Promise<void> {
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "session", "Sessions selector started");

  const cwd = process.cwd();
  const selectedPath = await renderSessionSelector(paths.sessionsDir, cwd);

  if (!selectedPath) {
    console.log(chalk.hex("#6b7280")("No session selected."));
    closeLogger();
    process.exit(0);
  }

  // Load saved settings for provider/model/theme
  let savedProvider: "anthropic" | "openai" | "glm" | "moonshot" | undefined;
  let savedModel: string | undefined;
  let savedThinkingEnabled = false;
  let savedTheme: "auto" | "dark" | "light" = "auto";
  try {
    const raw = JSON.parse(fs.readFileSync(paths.settingsFile, "utf-8"));
    if (raw.defaultProvider) savedProvider = raw.defaultProvider;
    if (raw.defaultModel) savedModel = raw.defaultModel;
    if (raw.thinkingEnabled === true) savedThinkingEnabled = true;
    if (raw.theme === "dark" || raw.theme === "light" || raw.theme === "auto")
      savedTheme = raw.theme;
  } catch {
    // No settings file — use defaults
  }

  const provider: "anthropic" | "openai" | "glm" | "moonshot" = savedProvider ?? "anthropic";

  function getDefault(p: string): string {
    if (p === "openai") return "gpt-5.3-codex";
    if (p === "glm") return "glm-5";
    if (p === "moonshot") return "kimi-k2.5";
    return "claude-opus-4-6";
  }

  const model = savedModel ?? getDefault(provider);
  const thinkingLevel: ThinkingLevel | undefined = savedThinkingEnabled ? "medium" : undefined;

  closeLogger();

  await runInkTUI({
    provider,
    model,
    cwd,
    thinkingLevel,
    resumeSessionPath: selectedPath,
    theme: savedTheme,
  });
}

// ── Helpers ────────────────────────────────────────────────

function displayName(provider: Provider): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "glm") return "Z.AI (GLM)";
  if (provider === "moonshot") return "Moonshot";
  return "OpenAI";
}

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}

function messagesToHistoryItems(msgs: Message[]): CompletedItem[] {
  const items: CompletedItem[] = [];
  let id = 0;

  // Index tool results by toolCallId for pairing with tool calls
  const toolResults = new Map<string, { content: string; isError: boolean }>();
  for (const msg of msgs) {
    if (msg.role === "tool") {
      for (const tr of msg.content) {
        toolResults.set(tr.toolCallId, {
          content: tr.content,
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
      if (text) items.push({ kind: "user", text, id: `restore-${id++}` });
    } else if (msg.role === "assistant") {
      const content = msg.content;
      if (typeof content === "string") {
        if (content) items.push({ kind: "assistant", text: content, id: `restore-${id++}` });
        continue;
      }
      // Count block types for debugging
      for (const block of content) {
        blockTypeCounts[block.type] = (blockTypeCounts[block.type] ?? 0) + 1;
      }
      // Process content blocks in order — text and tool calls
      const text = extractText(content);
      if (text) items.push({ kind: "assistant", text, id: `restore-${id++}` });
      for (const block of content) {
        if (block.type === "tool_call") {
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
        }
      }
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

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  execFile(cmd, [url], () => {
    // Ignore errors — user can copy URL manually
  });
}

main();
