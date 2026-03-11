#!/usr/bin/env node

// Drain performance entries to prevent buffer overflow warning from dependencies
import { PerformanceObserver } from "node:perf_hooks";
new PerformanceObserver(() => {}).observe({ entryTypes: ["measure", "mark"] });

import { parseArgs } from "node:util";
import fs from "node:fs";
import readline from "node:readline/promises";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { runPrintMode } from "./modes/print-mode.js";
import { runJsonMode } from "./modes/json-mode.js";
import { renderApp } from "./ui/render.js";
import { renderLoginSelector } from "./ui/login.js";
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
import {
  getRepoRoot,
  createWorktree,
  generateWorktreeName,
  sanitizeWorktreeName,
} from "./core/worktree.js";
import { HookRunner } from "./core/hooks.js";

const _require = createRequire(import.meta.url);
const CLI_VERSION = (_require("../package.json") as { version: string }).version;

const USAGE = `
Usage: ggcoder [command] [options] [message...]

Commands:
  login                     Log in to a provider via OAuth
  logout                    Log out (clear stored credentials)
  continue                  Resume the most recent session for this directory

Options:
  -p, --provider <name>     LLM provider (anthropic, openai, glm, moonshot) [default: anthropic]
  -m, --model <name>        Model name [default: claude-opus-4-6]
      --base-url <url>      Custom API base URL
      --system-prompt <text> Override system prompt
      --thinking <level>    Thinking level (low, medium, high, max)
      --max-turns <n>       Maximum agent loop turns [default: 40]
  -s, --session <path>      Resume a specific session file
  -w, --worktree            Run in a git worktree (auto-generates name)
      --worktree-name <n>   Name for the worktree (used with -w)
      --print               Print mode: one-shot, output to stdout, then exit
      --json                JSON mode: one-shot, output NDJSON events to stdout
  -v, --version             Show version number
  -h, --help                Show this help message

Print mode:
  echo "hello" | ggcoder --print
  ggcoder --print "explain this code"

Authentication:
  ggcoder login             Log in (select provider interactively)
  ggcoder logout            Log out from all providers
`.trim();

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

  if (subcommand === "continue") {
    // Remove "continue" so parseArgs handles remaining flags
    process.argv.splice(2, 1);
  }

  const { values, positionals } = parseArgs({
    options: {
      provider: { type: "string", short: "p" },
      model: { type: "string", short: "m" },
      "base-url": { type: "string" },
      "system-prompt": { type: "string" },
      thinking: { type: "string" },
      "max-turns": { type: "string" },
      session: { type: "string", short: "s" },
      worktree: { type: "boolean", short: "w" },
      "worktree-name": { type: "string" },
      print: { type: "boolean" },
      json: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.version) {
    console.log(CLI_VERSION);
    process.exit(0);
  }

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  // Load saved settings for model/provider persistence
  let savedProvider: "anthropic" | "openai" | "glm" | "moonshot" | undefined;
  let savedModel: string | undefined;
  let savedThinkingEnabled = false;
  try {
    const raw = JSON.parse(fs.readFileSync(getAppPaths().settingsFile, "utf-8"));
    if (raw.defaultProvider) savedProvider = raw.defaultProvider;
    if (raw.defaultModel) savedModel = raw.defaultModel;
    if (raw.thinkingEnabled === true) savedThinkingEnabled = true;
  } catch {
    // No settings file or invalid JSON — use defaults
  }

  // Priority: CLI flag > saved setting > hardcoded default
  const providerFromFlag = values.provider as
    | "anthropic"
    | "openai"
    | "glm"
    | "moonshot"
    | undefined;
  const provider: "anthropic" | "openai" | "glm" | "moonshot" =
    providerFromFlag ?? savedProvider ?? "anthropic";

  function getHardcodedDefault(p: string): string {
    if (p === "openai") return "gpt-5.3-codex";
    if (p === "glm") return "glm-5";
    if (p === "moonshot") return "kimi-k2.5";
    return "claude-opus-4-6";
  }

  // Use saved model only if provider matches (or no provider flag was given)
  const model: string =
    values.model ?? (!providerFromFlag && savedModel ? savedModel : getHardcodedDefault(provider));

  // CLI --thinking flag overrides saved setting; saved thinkingEnabled provides default
  const thinkingLevel: ThinkingLevel | undefined =
    (values.thinking as ThinkingLevel | undefined) ?? (savedThinkingEnabled ? "medium" : undefined);
  const maxTurns = values["max-turns"] ? parseInt(values["max-turns"], 10) : undefined;

  // --worktree is only supported in interactive mode
  if (values.worktree && (values.print || values.json)) {
    console.error(
      "Error: --worktree is only supported in interactive mode (not with --print or --json)",
    );
    process.exit(1);
  }

  // Print mode
  if (values.print) {
    const message = positionals.join(" ").trim() || readStdinSync();
    if (!message) {
      console.error("Error: --print requires a message (positional args or stdin)");
      process.exit(1);
    }

    runPrintMode({
      message,
      provider,
      model,
      baseUrl: values["base-url"],
      systemPrompt: values["system-prompt"],
      cwd: process.cwd(),
      thinkingLevel,
    }).catch((err) => {
      log("ERROR", "fatal", err instanceof Error ? err.message : String(err));
      closeLogger();
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  // JSON mode
  if (values.json) {
    const message = positionals.join(" ").trim() || readStdinSync();
    if (!message) {
      console.error("Error: --json requires a message (positional args or stdin)");
      process.exit(1);
    }

    runJsonMode({
      message,
      provider,
      model,
      baseUrl: values["base-url"],
      systemPrompt: values["system-prompt"],
      cwd: process.cwd(),
      thinkingLevel,
      maxTurns,
    }).catch((err) => {
      log("ERROR", "fatal", err instanceof Error ? err.message : String(err));
      closeLogger();
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  // Interactive mode (Ink TUI)
  const cwd = process.cwd();
  const continueRecent = subcommand === "continue";

  runInkTUI({
    provider,
    model,
    baseUrl: values["base-url"],
    cwd,
    thinkingLevel,
    systemPrompt: values["system-prompt"],
    continueRecent,
    sessionPath: values.session,
    worktree: values.worktree ? values["worktree-name"] || undefined : undefined,
    useWorktree: values.worktree,
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
  baseUrl?: string;
  cwd: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  continueRecent?: boolean;
  sessionPath?: string;
  worktree?: string;
  useWorktree?: boolean;
}): Promise<void> {
  const { provider, model } = opts;
  let { cwd } = opts;

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

  // Set up worktree hook runner (used for CLI worktree creation + subagent worktrees)
  const hookRunner = new HookRunner(cwd, crypto.randomUUID());
  await hookRunner.loadConfig(paths.settingsFile);

  // Set up worktree if requested
  let worktreeMeta:
    | { path: string; branchName: string; repoRoot: string; name: string }
    | undefined;

  if (opts.useWorktree) {
    const repoRoot = await getRepoRoot(cwd);
    if (!repoRoot) {
      throw new Error("--worktree requires a git repository, but no git repo was found");
    }

    const rawName = opts.worktree || generateWorktreeName();
    const name = sanitizeWorktreeName(rawName);

    // Fire WorktreeCreate hook if configured, otherwise use git default
    const hookPath = await hookRunner.runWorktreeCreateHook(name);
    const worktreePath = hookPath ?? (await createWorktree({ repoRoot, name }));
    cwd = worktreePath;

    worktreeMeta = {
      path: worktreePath,
      branchName: `worktree-${name}`,
      repoRoot,
      name,
    };

    log("INFO", "worktree", `Created worktree`, {
      name,
      path: worktreePath,
      repoRoot,
    });
  }

  // Discover agents and build tools
  const agents = await discoverAgents({
    globalAgentsDir: paths.agentsDir,
    projectDir: cwd,
  });

  // Build system prompt & tools (with sub-agent support)
  const systemPrompt = opts.systemPrompt ?? (await buildSystemPrompt(cwd));
  const { tools, processManager } = createTools(cwd, { agents, provider, model, hookRunner });

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

  if (opts.continueRecent || opts.sessionPath) {
    const existingPath = opts.sessionPath ?? (await sessionManager.getMostRecent(cwd));

    if (existingPath) {
      try {
        const loaded = await sessionManager.load(existingPath);
        const loadedMessages = sessionManager.getMessages(loaded.entries);

        if (loadedMessages.length > 0) {
          messages.push(...loadedMessages);
          sessionPath = existingPath;
          log("INFO", "session", `Restored session`, {
            path: existingPath,
            messageCount: String(loadedMessages.length),
          });
          initialHistory = messagesToHistoryItems(loadedMessages);
          initialHistory.push({
            kind: "info",
            text: `↻ Restored session (${loadedMessages.length} messages)`,
            id: `restore-info`,
          });
        }
      } catch (err) {
        // Session file corrupt, missing, or worktree deleted — start fresh
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Worktree directory no longer exists")) {
          console.error(`Warning: ${msg}\nStarting a new session.`);
        }
        log("WARN", "session", `Could not restore session: ${msg}`);
      }
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
    baseUrl: opts.baseUrl,
    accountId: creds.accountId,
    cwd,
    loggedInProviders,
    credentialsByProvider,
    initialHistory,
    sessionsDir: paths.sessionsDir,
    sessionPath,
    processManager,
    settingsFile: paths.settingsFile,
    mcpManager,
    worktree: worktreeMeta,
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

// ── Helpers ────────────────────────────────────────────────

function readStdinSync(): string {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf-8").trim();
  } catch {
    return "";
  }
}

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
