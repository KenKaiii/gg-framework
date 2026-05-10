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

import { parseArgs } from "node:util";
import fs from "node:fs";
import readline from "node:readline/promises";
import { execFile, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { renderApp } from "./ui/render.js";
import { runJsonMode } from "./modes/json-mode.js";
import { runRpcMode } from "./modes/rpc-mode.js";
import { runServeMode } from "./modes/serve-mode.js";
import { runAgentHomeMode } from "./modes/agent-home-mode.js";
import { renderLoginSelector } from "./ui/login.js";
import { renderSessionSelector } from "./ui/sessions.js";
import type { CompletedItem } from "./ui/App.js";
import { formatUserError } from "./utils/error-handler.js";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import type { ThemeName } from "./ui/theme/theme.js";
import { AuthStorage } from "./core/auth-storage.js";
import { SessionManager } from "./core/session-manager.js";
import { ensureAppDirs, getAppPaths, loadSavedSettings } from "./config.js";
import { initLogger, log, closeLogger } from "./core/logger.js";
import { setStreamDiagnostic } from "@kenkaiiii/gg-agent";
import { buildSystemPrompt } from "./system-prompt.js";
import { isEyesActive, journalCount } from "@kenkaiiii/ggcoder-eyes";
import { createTools } from "./tools/index.js";
import { shouldCompact, compact } from "./core/compaction/compactor.js";
import { setEstimatorModel } from "./core/compaction/token-estimator.js";
import { getContextWindow, getDefaultModel } from "./core/model-registry.js";
import { MCPClientManager, getMCPServers } from "./core/mcp/index.js";
import { discoverAgents } from "./core/agents.js";
import { discoverSkills } from "./core/skills.js";
import path from "node:path";
import { loginAnthropic } from "./core/oauth/anthropic.js";
import { loginOpenAI } from "./core/oauth/openai.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./core/oauth/types.js";
import chalk from "chalk";
import { checkAndAutoUpdate } from "./core/auto-update.js";

const _require = createRequire(import.meta.url);
const CLI_VERSION = (_require("../package.json") as { version: string }).version;

// ── Logo + gradient (mirrors Banner.tsx) ────────────────────────────
const LOGO_LINES = [
  " \u2584\u2580\u2580\u2580 \u2584\u2580\u2580\u2580",
  " \u2588 \u2580\u2588 \u2588 \u2580\u2588",
  " \u2580\u2584\u2584\u2580 \u2580\u2584\u2584\u2580",
];
const GRADIENT = [
  "#60a5fa",
  "#6da1f9",
  "#7a9df7",
  "#8799f5",
  "#9495f3",
  "#a18ff1",
  "#a78bfa",
  "#a18ff1",
  "#9495f3",
  "#8799f5",
  "#7a9df7",
  "#6da1f9",
];

function gradientLine(text: string): string {
  let result = "";
  let colorIdx = 0;
  for (const ch of text) {
    if (ch === " ") {
      result += ch;
    } else {
      result += chalk.hex(GRADIENT[colorIdx % GRADIENT.length])(ch);
      colorIdx++;
    }
  }
  return result;
}

function printHelp(): void {
  // Clear screen for a clean look, consistent with the TUI startup
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  const dim = chalk.dim;
  const primary = chalk.hex("#60a5fa");
  const accent = chalk.hex("#a78bfa");
  const bold = chalk.bold;
  const gap = "   ";

  // Banner — matches the Ink Banner component layout
  console.log();
  console.log(
    gradientLine(LOGO_LINES[0]) +
      gap +
      primary.bold("GG Coder") +
      dim(` v${CLI_VERSION}`) +
      dim(" · By ") +
      bold("Ken Kai"),
  );
  console.log(gradientLine(LOGO_LINES[1]) + gap + dim("AI coding agent"));
  console.log(gradientLine(LOGO_LINES[2]));
  console.log();

  // Usage
  console.log(primary("Usage:") + "  ggcoder " + dim("[options]") + " " + dim("[prompt]"));
  console.log();

  // Commands
  console.log(primary("Commands:"));
  const cmds: [string, string][] = [
    ["login", "Log in to an AI provider (Anthropic, OpenAI)"],
    ["logout", "Log out and clear stored credentials"],
    ["doctor", "Diagnose and fix auth/config issues"],
    ["sessions", "Browse and resume previous sessions"],
    ["continue", "Resume the most recent session"],
    ["serve", "Start the HTTP/WebSocket API server"],
    ["telegram", "Configure Telegram bot integration"],
    ["agent-home-login", "Configure Agent Home relay connection"],
    ["agent-home", "Connect to Agent Home as a remote agent"],
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
      "AI provider (anthropic, xiaomi, openai, glm, moonshot, minimax, deepseek, openrouter)",
    ],
    ["--model <name>", "Model to use (e.g. claude-sonnet-4-6, gpt-5.5)"],
    ["--max-turns <n>", "Maximum agent turns per prompt"],
    ["--system-prompt <text>", "Override the system prompt"],
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
    ["Ctrl+T", "Toggle task overlay"],
    ["Ctrl+S", "Toggle skills overlay"],
    ["Ctrl+P", "Toggle plan mode"],
    ["Shift+Tab", "Toggle thinking"],
    ["Shift+Enter", "New line in input"],
  ];
  for (const [key, desc] of shortcuts) {
    console.log(`  ${accent(key.padEnd(20))} ${dim(desc)}`);
  }
  console.log();
}

function main(): void {
  // Silent auto-update check (throttled, non-blocking on failure)
  const updateMessage = checkAndAutoUpdate(CLI_VERSION);
  if (updateMessage) {
    console.error(chalk.bold.hex("#4ade80")(`✨ ${updateMessage}`));
  }

  // Intercept --help / -h before anything else so it works with subcommands
  // (e.g. `ggcoder login --help` or `ggcoder --help`)
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // Handle subcommands before parseArgs
  const subcommand = process.argv[2];

  // Passthrough to @kenkaiiii/ggcoder-eyes CLI. Agents call this from bash as
  // `ggcoder eyes log rough "..."` etc. — `ggcoder` is guaranteed on PATH
  // (user launched it), so this avoids depending on nested bin visibility in
  // global npm/pnpm installs.
  if (subcommand === "eyes") {
    let cliPath: string;
    try {
      cliPath = _require.resolve("@kenkaiiii/ggcoder-eyes/cli");
    } catch {
      process.stderr.write("ggcoder-eyes package not installed\n");
      process.exit(1);
    }
    const r = spawnSync(process.execPath, [cliPath, ...process.argv.slice(3)], {
      stdio: "inherit",
    });
    process.exit(r.status ?? 0);
  }

  if (subcommand === "pixel") {
    runPixel().catch((err) => {
      // Log the full stack — `pixel install` failures are usually bugs in our
      // own AST/wiring code, and the stack is the only useful diagnostic.
      log("ERROR", "fatal", err instanceof Error ? (err.stack ?? err.message) : String(err));
      closeLogger();
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

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

  if (subcommand === "telegram") {
    runTelegramSetup().catch((err) => {
      log("ERROR", "fatal", err instanceof Error ? err.message : String(err));
      closeLogger();
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  if (subcommand === "serve") {
    process.argv.splice(2, 1);
    runServe().catch((err) => {
      log("ERROR", "fatal", err instanceof Error ? err.message : String(err));
      closeLogger();
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  if (subcommand === "doctor") {
    runDoctor().catch((err) => {
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  if (subcommand === "agent-home-login") {
    runAgentHomeLogin().catch((err) => {
      log("ERROR", "fatal", err instanceof Error ? err.message : String(err));
      closeLogger();
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  if (subcommand === "agent-home") {
    process.argv.splice(2, 1);
    runAgentHome().catch((err) => {
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
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      rpc: { type: "boolean" },
      provider: { type: "string" },
      model: { type: "string" },
      "max-turns": { type: "string" },
      "system-prompt": { type: "string" },
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
    const jsonModel = values.model ?? "claude-opus-4-7";
    const maxTurns = values["max-turns"] ? parseInt(values["max-turns"], 10) : undefined;
    const systemPrompt = values["system-prompt"];
    const cwd = process.cwd();
    runJsonMode({
      message,
      provider: jsonProvider,
      model: jsonModel,
      cwd,
      systemPrompt,
      maxTurns,
    }).catch((err: unknown) => {
      process.stderr.write(formatUserError(err) + "\n");
      process.exit(1);
    });
    return;
  }

  // RPC mode — headless JSON-over-stdio for IDE integrations
  if (values.rpc) {
    const rpcProvider = (values.provider ?? "anthropic") as Provider;
    const rpcModel = values.model ?? "claude-opus-4-7";
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
    if (p === "glm") return "glm-5.1";
    if (p === "moonshot") return "kimi-k2.6";
    if (p === "minimax") return "MiniMax-M2.7";
    if (p === "deepseek") return "deepseek-v4-pro";
    if (p === "openrouter") return "qwen/qwen3.6-plus";
    return "claude-opus-4-7";
  }

  const model: string = saved.model ?? getHardcodedDefault(provider);
  const thinkingLevel: ThinkingLevel | undefined = saved.thinkingEnabled ? "medium" : undefined;

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

/**
 * Bail with a friendly message if stdin isn't a TTY. Ink's raw-mode crash is
 * cryptic; this catches the common case (piped stdin, API shells, CI).
 */
function requireInteractiveTTY(): void {
  if (process.stdin.isTTY) return;
  process.stderr.write(
    chalk.red("ggcoder needs an interactive terminal — your stdin isn't a TTY.\n") +
      chalk.hex("#6b7280")(
        "Run ggcoder directly in your terminal (not piped or through an API shell). " +
          'For headless use try "ggcoder --json \'<prompt>\'" or "ggcoder --rpc".\n',
      ),
  );
  process.exit(1);
}

async function runInkTUI(opts: {
  provider: Provider;
  model: string;
  cwd: string;
  thinkingLevel?: ThinkingLevel;
  continueRecent?: boolean;
  resumeSessionPath?: string;
  theme?: "auto" | ThemeName;
  initialOverlay?: "pixel";
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

  const authStorage = new AuthStorage(paths.authFile);
  await authStorage.load();

  const { provider, model, loggedInProviders } = await resolveActiveProvider(
    authStorage,
    opts.provider,
    opts.model,
  );

  // Preload every logged-in provider's credentials for the model switcher.
  const credentialsByProvider: Record<
    string,
    { accessToken: string; accountId?: string; baseUrl?: string }
  > = {};
  for (const p of loggedInProviders) {
    try {
      const resolved = await authStorage.resolveCredentials(p);
      credentialsByProvider[p] = {
        accessToken: resolved.accessToken,
        accountId: resolved.accountId,
        baseUrl: resolved.baseUrl,
      };
    } catch {
      // Token refresh failed — still leave them in loggedInProviders
    }
  }

  // Set model for token estimation accuracy (after provider is finalized)
  setEstimatorModel(model);

  initLogger(paths.logFile, {
    version: CLI_VERSION,
    provider,
    model,
    thinking: opts.thinkingLevel,
  });

  const creds = await authStorage.resolveCredentials(provider);

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

  // Build system prompt & tools (with sub-agent support)
  const systemPrompt = await buildSystemPrompt(cwd, skills);

  // Plan mode refs — shared between tools and UI
  const planModeRef = { current: false };
  const onEnterPlanRef: { current: (reason?: string) => void } = {
    current: () => {},
  };
  const onExitPlanRef: { current: (planPath: string) => Promise<string> } = {
    current: () => Promise.resolve("cancelled"),
  };

  const { tools, processManager } = createTools(cwd, {
    agents,
    skills,
    provider,
    model,
    planModeRef,
    onEnterPlan: (reason) => onEnterPlanRef.current(reason),
    onExitPlan: (planPath) => onExitPlanRef.current(planPath),
  });

  // Rebuilds the cwd-bound tools for a different project root. Used by the
  // pixel-fix flow so the agent operates in the error's project, not in
  // wherever ggcoder was launched from.
  const rebuildToolsForCwd = (newCwd: string) => {
    const { tools: rebuilt } = createTools(newCwd, {
      agents,
      skills,
      provider,
      model,
      planModeRef,
      onEnterPlan: (reason) => onEnterPlanRef.current(reason),
      onExitPlan: (planPath) => onExitPlanRef.current(planPath),
    });
    return rebuilt;
  };

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

        // Auto-compact on load if the restored session exceeds the context window.
        // Without this, huge sessions (1M+ tokens) get loaded into memory and OOM.
        const contextWindow = getContextWindow(model);
        if (shouldCompact(messages, contextWindow, 0.8)) {
          log("INFO", "session", `Restored session exceeds context — auto-compacting`);
          const compacted = await compact(messages, {
            provider,
            model,
            apiKey: creds.accessToken,
            contextWindow,
          });
          // Replace messages array contents with compacted messages
          messages.length = 0;
          messages.push(...compacted.messages);
          log("INFO", "session", `Auto-compaction complete`, {
            before: String(compacted.result.originalCount),
            after: String(compacted.result.newCount),
          });
        }

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

  // Eyes startup banner — surface open journal signals from past sessions so the
  // user isn't relying on reading agent prose to know improvements are pending.
  if (isEyesActive(cwd)) {
    const openCount = journalCount({ status: "open" }, cwd);
    if (openCount > 0) {
      const s = openCount === 1 ? "" : "s";
      if (!initialHistory) initialHistory = [];
      initialHistory.push({
        kind: "info",
        text: `👁  Eyes: ${openCount} open improvement signal${s} from recent sessions. Run /eyes-improve to triage.`,
        id: "eyes-banner",
      });
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
    planModeRef,
    onEnterPlanRef,
    onExitPlanRef,
    skills,
    initialOverlay: opts.initialOverlay,
    rebuildToolsForCwd,
  });

  closeLogger();
}

// ── Login ──────────────────────────────────────────────────

async function runLogin(): Promise<void> {
  requireInteractiveTTY();
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "auth", "Login flow started");

  const authStorage = new AuthStorage();
  await authStorage.load();

  // Phase 1: Ink-based provider selector
  const provider = await renderLoginSelector(CLI_VERSION);
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
    if (
      provider === "glm" ||
      provider === "moonshot" ||
      provider === "xiaomi" ||
      provider === "minimax" ||
      provider === "deepseek" ||
      provider === "openrouter"
    ) {
      const keyLabel =
        provider === "glm"
          ? "Z.AI"
          : provider === "xiaomi"
            ? "Xiaomi MiMo"
            : provider === "minimax"
              ? "MiniMax"
              : provider === "deepseek"
                ? "DeepSeek"
                : provider === "openrouter"
                  ? "OpenRouter"
                  : "Moonshot";
      const apiKey = await rl.question(chalk.hex("#60a5fa")(`Paste your ${keyLabel} API key: `));
      if (!apiKey.trim()) {
        console.log(chalk.hex("#ef4444")("No API key provided. Login cancelled."));
        return;
      }
      creds = {
        accessToken: apiKey.trim(),
        refreshToken: "",
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 * 100, // ~100 years
        ...(provider === "xiaomi" ? { baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" } : {}),
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

// ── Doctor ─────────────────────────────────────────────────

async function runDoctor(): Promise<void> {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  const os = await import("node:os");
  const fsP = await import("node:fs/promises");

  const dim = chalk.hex("#6b7280");
  const primary = chalk.hex("#60a5fa");
  const accent = chalk.hex("#a78bfa");
  const good = chalk.hex("#4ade80");
  const warn = chalk.hex("#fbbf24");
  const bad = chalk.hex("#ef4444");

  // ── Banner ──────────────────────────────────────────────────
  const LOGO = LOGO_LINES;
  const GAP = "   ";
  console.log();
  console.log(
    `  ${gradientLine(LOGO[0]!)}${GAP}` +
      primary.bold("GG Coder") +
      dim(` v${CLI_VERSION}`) +
      dim(" · By ") +
      chalk.white.bold("Ken Kai"),
  );
  console.log(`  ${gradientLine(LOGO[1]!)}${GAP}` + accent("Doctor"));
  console.log(`  ${gradientLine(LOGO[2]!)}${GAP}` + dim("Diagnose & Fix"));
  console.log();

  const home = os.homedir();
  const ggDir = path.join(home, ".gg");
  const authFile = path.join(ggDir, "auth.json");
  const lockFile = authFile + ".lock";
  const myUid = process.getuid!();
  let fixed = 0;

  // ── Environment ─────────────────────────────────────────────
  console.log(accent("  Environment\n"));
  console.log(dim(`    Home:      ${home}`));
  console.log(dim(`    $HOME:     ${process.env.HOME ?? "(not set)"}`));
  console.log(dim(`    Node.js:   ${process.version}`));
  console.log(dim(`    Platform:  ${process.platform} ${process.arch}`));
  console.log(dim(`    UID:       ${myUid}  EUID: ${process.geteuid!()}`));

  if (process.env.HOME && process.env.HOME !== home) {
    console.log(warn("\n    ⚠ $HOME differs from os.homedir() — this can cause auth mismatches"));
  }
  if (myUid !== process.geteuid!()) {
    console.log(warn("    ⚠ uid ≠ euid — running with elevated privileges (sudo?)"));
    console.log(dim("      Running ggcoder with sudo can cause ownership issues."));
    console.log(dim("      Use without sudo, or fix after: sudo chown -R $(whoami) ~/.gg"));
  }
  console.log();

  // ── Config Directory ────────────────────────────────────────
  console.log(accent("  Config Directory\n"));

  try {
    const stat = await fsP.stat(ggDir);
    const mode = stat.mode & 0o777;
    console.log(dim(`    Path:  ${ggDir}`));
    console.log(dim(`    Mode:  0o${mode.toString(8)}  UID: ${stat.uid}`));

    // Fix ownership
    if (stat.uid !== myUid) {
      console.log(warn(`    ⚠ Owned by uid ${stat.uid}, expected ${myUid}`));
      try {
        await fsP.chown(ggDir, myUid, process.getgid!());
        console.log(good("    ✓ Fixed directory ownership"));
        fixed++;
      } catch {
        console.log(bad(`    ✗ Cannot fix — try: sudo chown -R $(whoami) ${ggDir}`));
      }
    }

    // Fix permissions (should be 0o700)
    if (mode !== 0o700) {
      try {
        await fsP.chmod(ggDir, 0o700);
        console.log(good("    ✓ Fixed directory permissions → 0o700"));
        fixed++;
      } catch {
        console.log(bad(`    ✗ Cannot fix — try: chmod 700 ${ggDir}`));
      }
    }
  } catch {
    console.log(warn(`    ${ggDir} missing — creating...`));
    try {
      await fsP.mkdir(ggDir, { recursive: true, mode: 0o700 });
      console.log(good(`    ✓ Created ${ggDir}`));
      fixed++;
    } catch (mkErr) {
      console.log(
        bad(`    ✗ Cannot create: ${mkErr instanceof Error ? mkErr.message : String(mkErr)}`),
      );
      console.log();
      return;
    }
  }
  console.log();

  // ── Lock File ───────────────────────────────────────────────
  try {
    const lockStat = await fsP.stat(lockFile);
    const ageMs = Date.now() - lockStat.mtimeMs;
    console.log(accent("  Lock File\n"));
    console.log(warn(`    ⚠ Stale lock found (age: ${Math.round(ageMs / 1000)}s)`));
    await fsP.unlink(lockFile);
    console.log(good("    ✓ Removed"));
    fixed++;
    console.log();
  } catch {
    // No lock file — good, skip section entirely
  }

  // ── Auth File ───────────────────────────────────────────────
  console.log(accent("  Auth File\n"));

  let authData: Record<string, unknown> | null = null;
  let authNeedsRewrite = false;

  try {
    const stat = await fsP.stat(authFile);
    const mode = stat.mode & 0o777;
    console.log(dim(`    Path:  ${authFile}`));
    console.log(
      dim(`    Size:  ${stat.size} bytes  Mode: 0o${mode.toString(8)}  UID: ${stat.uid}`),
    );

    // Fix ownership
    if (stat.uid !== myUid) {
      console.log(warn(`    ⚠ Owned by uid ${stat.uid}, expected ${myUid}`));
      try {
        await fsP.chown(authFile, myUid, process.getgid!());
        console.log(good("    ✓ Fixed file ownership"));
        fixed++;
      } catch {
        console.log(bad(`    ✗ Cannot fix — try: sudo chown $(whoami) ${authFile}`));
      }
    }

    // Fix permissions (should be 0o600)
    if (mode !== 0o600) {
      try {
        await fsP.chmod(authFile, 0o600);
        console.log(good("    ✓ Fixed file permissions → 0o600"));
        fixed++;
      } catch {
        console.log(bad(`    ✗ Cannot fix — try: chmod 600 ${authFile}`));
      }
    }

    // Try to read and parse
    try {
      const content = await fsP.readFile(authFile, "utf-8");
      try {
        authData = JSON.parse(content) as Record<string, unknown>;
      } catch {
        console.log(bad("    ✗ Invalid JSON — backing up and resetting"));
        const backupName = `auth.json.corrupt.${Date.now()}`;
        await fsP.copyFile(authFile, path.join(ggDir, backupName));
        await fsP.writeFile(authFile, "{}", { encoding: "utf-8", mode: 0o600 });
        console.log(good(`    ✓ Corrupt file backed up as ${backupName}`));
        console.log(dim('      Run "ggcoder login" to re-authenticate'));
        authData = {};
        fixed++;
      }
    } catch (readErr) {
      const code = (readErr as NodeJS.ErrnoException).code;
      if (code === "EACCES") {
        console.log(bad("    ✗ Permission denied reading auth.json"));
        console.log(dim(`      Try: sudo chown $(whoami) ${authFile} && chmod 600 ${authFile}`));
      } else {
        console.log(
          bad(`    ✗ Read error: ${readErr instanceof Error ? readErr.message : String(readErr)}`),
        );
      }
    }
  } catch {
    console.log(dim(`    Path:  ${authFile}`));
    console.log(warn('    Not found — run "ggcoder login" to authenticate'));
  }
  console.log();

  // ── Credentials ─────────────────────────────────────────────
  if (authData && Object.keys(authData).length > 0) {
    console.log(accent("  Credentials\n"));

    for (const p of Object.keys(authData)) {
      const cred = authData[p] as Record<string, unknown> | undefined;
      if (!cred || typeof cred !== "object") {
        console.log(bad(`    ✗ ${p}: invalid entry — removing`));
        delete authData[p];
        authNeedsRewrite = true;
        fixed++;
        continue;
      }
      if (!cred.accessToken || typeof cred.accessToken !== "string") {
        console.log(bad(`    ✗ ${p}: missing accessToken — removing`));
        delete authData[p];
        authNeedsRewrite = true;
        fixed++;
        continue;
      }
      const token = String(cred.accessToken);
      const masked = token.slice(0, 8) + "..." + token.slice(-4);
      const expires =
        typeof cred.expiresAt === "number" ? new Date(cred.expiresAt).toISOString() : "unknown";
      const expired = typeof cred.expiresAt === "number" && Date.now() > cred.expiresAt;
      if (expired) {
        console.log(warn(`    ⚠ ${p}: ${masked}  expired ${expires}`));
      } else {
        console.log(good(`    ✓ ${p}: ${masked}  expires ${expires}`));
      }
    }

    if (authNeedsRewrite) {
      try {
        await fsP.writeFile(authFile, JSON.stringify(authData, null, 2), {
          encoding: "utf-8",
          mode: 0o600,
        });
        console.log(good("    ✓ Cleaned up auth.json"));
      } catch {
        console.log(bad("    ✗ Failed to write cleaned auth.json"));
      }
    }
    console.log();
  }

  // ── Temp Files ──────────────────────────────────────────────
  try {
    const entries = await fsP.readdir(ggDir);
    const tmpFiles = entries.filter((e) => e.startsWith("auth.json.") && e.endsWith(".tmp"));
    if (tmpFiles.length > 0) {
      console.log(accent("  Temp Files\n"));
      console.log(warn(`    ⚠ ${tmpFiles.length} orphaned temp file(s) from interrupted writes`));
      for (const tmp of tmpFiles) {
        await fsP.unlink(path.join(ggDir, tmp)).catch(() => {});
      }
      console.log(good(`    ✓ Removed ${tmpFiles.length} file(s)`));
      fixed++;
      console.log();
    }
  } catch {
    // Can't read directory — already flagged above
  }

  // ── Summary ─────────────────────────────────────────────────
  if (fixed > 0) {
    console.log(good(`  ✓ Fixed ${fixed} issue${fixed > 1 ? "s" : ""}.`));
  } else {
    console.log(good("  ✓ Everything looks good."));
  }
  console.log();
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
  requireInteractiveTTY();
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
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
    if (p === "glm") return "glm-5.1";
    if (p === "moonshot") return "kimi-k2.6";
    if (p === "minimax") return "MiniMax-M2.7";
    if (p === "deepseek") return "deepseek-v4-pro";
    return "claude-opus-4-7";
  }

  const model = saved2.model ?? getDefault(provider);
  const thinkingLevel: ThinkingLevel | undefined = saved2.thinkingEnabled ? "medium" : undefined;

  closeLogger();

  await runInkTUI({
    provider,
    model,
    cwd,
    thinkingLevel,
    resumeSessionPath: selectedPath,
    theme: saved2.theme,
  });
}

// ── Telegram Setup ───────────────────────────────────────

interface TelegramConfig {
  botToken: string;
  userId: number;
}

async function loadTelegramConfig(): Promise<TelegramConfig | null> {
  try {
    const raw = await fs.promises.readFile(getAppPaths().telegramFile, "utf-8");
    const data = JSON.parse(raw) as TelegramConfig;
    if (data.botToken && data.userId) return data;
    return null;
  } catch {
    return null;
  }
}

async function saveTelegramConfig(config: TelegramConfig): Promise<void> {
  const paths = await ensureAppDirs();
  await fs.promises.writeFile(paths.telegramFile, JSON.stringify(config, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

async function runTelegramSetup(): Promise<void> {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "telegram", "Telegram setup started");

  const existing = await loadTelegramConfig();

  // Banner (matches Banner.tsx)
  const LOGO = [
    " \u2584\u2580\u2580\u2580 \u2584\u2580\u2580\u2580",
    " \u2588 \u2580\u2588 \u2588 \u2580\u2588",
    " \u2580\u2584\u2584\u2580 \u2580\u2584\u2584\u2580",
  ];
  const GRADIENT = [
    "#60a5fa",
    "#6da1f9",
    "#7a9df7",
    "#8799f5",
    "#9495f3",
    "#a18ff1",
    "#a78bfa",
    "#a18ff1",
    "#9495f3",
    "#8799f5",
    "#7a9df7",
    "#6da1f9",
  ];
  function gradientText(text: string): string {
    let colorIdx = 0;
    return text
      .split("")
      .map((ch) => {
        if (ch === " ") return ch;
        const color = GRADIENT[colorIdx++ % GRADIENT.length]!;
        return chalk.hex(color)(ch);
      })
      .join("");
  }
  const GAP = "   ";
  console.log();
  console.log(
    `  ${gradientText(LOGO[0]!)}${GAP}` +
      chalk.hex("#60a5fa").bold("GG Coder") +
      chalk.hex("#6b7280")(` v${CLI_VERSION}`) +
      chalk.hex("#6b7280")(" · By ") +
      chalk.white.bold("Ken Kai"),
  );
  console.log(`  ${gradientText(LOGO[1]!)}${GAP}` + chalk.hex("#a78bfa")("Telegram Setup"));
  console.log(`  ${gradientText(LOGO[2]!)}${GAP}` + chalk.hex("#6b7280")("Remote Control"));
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
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
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
  const thinkingLevel: ThinkingLevel | undefined = saved3.thinkingEnabled ? "medium" : undefined;

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
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  const paths = await ensureAppDirs();
  initLogger(paths.logFile, { version: CLI_VERSION });
  log("INFO", "agent-home", "Agent Home login started");

  const existing = await loadAgentHomeConfig();

  // Banner
  const LOGO = [
    " \u2584\u2580\u2580\u2580 \u2584\u2580\u2580\u2580",
    " \u2588 \u2580\u2588 \u2588 \u2580\u2588",
    " \u2580\u2584\u2584\u2580 \u2580\u2584\u2584\u2580",
  ];
  function gradientTextLocal(text: string): string {
    let colorIdx = 0;
    return text
      .split("")
      .map((ch) => {
        if (ch === " ") return ch;
        const color = GRADIENT[colorIdx++ % GRADIENT.length]!;
        return chalk.hex(color)(ch);
      })
      .join("");
  }
  const GAP = "   ";
  console.log();
  console.log(
    `  ${gradientTextLocal(LOGO[0]!)}${GAP}` +
      chalk.hex("#60a5fa").bold("GG Coder") +
      chalk.hex("#6b7280")(` v${CLI_VERSION}`) +
      chalk.hex("#6b7280")(" \u00b7 By ") +
      chalk.white.bold("Ken Kai"),
  );
  console.log(`  ${gradientTextLocal(LOGO[1]!)}${GAP}` + chalk.hex("#a78bfa")("Agent Home Setup"));
  console.log(
    `  ${gradientTextLocal(LOGO[2]!)}${GAP}` + chalk.hex("#6b7280")("Remote Control via iOS"),
  );
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
  const thinkingLevel: ThinkingLevel | undefined = saved4.thinkingEnabled ? "medium" : undefined;

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

async function runPixel(): Promise<void> {
  const sub = process.argv[3];
  const rest = process.argv.slice(4);

  if (sub === "install") {
    const { runPixelInstall } = await import("./core/pixel.js");
    const opts = parsePixelInstallArgs(rest);
    await runPixelInstall(opts);
    return;
  }

  if (sub === "fix") {
    const errorId = rest[0];
    if (!errorId) {
      process.stderr.write("Usage: ggcoder pixel fix <error_id>\n");
      process.exit(1);
    }
    const { fixError } = await import("./core/pixel-fix.js");
    const result = await fixError(errorId);
    if (result.outcome === "awaiting_review") {
      console.log(chalk.hex("#4ade80")(`✓ ${result.reason}`));
    } else {
      console.log(chalk.hex("#ef4444")(`✗ ${result.reason}`));
      process.exit(1);
    }
    return;
  }

  if (sub === "run") {
    const { runQueue } = await import("./core/pixel-fix.js");
    const result = await runQueue();
    console.log(
      chalk.bold(`${result.fixed} fixed · ${result.failed} failed · ${result.total} total`),
    );
    if (result.failed > 0) process.exit(1);
    return;
  }

  if (sub === "--help" || sub === "-h") {
    printPixelHelp();
    return;
  }

  if (sub === "list") {
    const { listAllErrors } = await import("./core/pixel.js");
    await listAllErrors();
    return;
  }

  if (sub) {
    process.stderr.write(`Unknown pixel subcommand: ${sub}\n`);
    printPixelHelp();
    process.exit(1);
  }

  // No subcommand → launch the Ink TUI with the pixel overlay open. The fix
  // flow runs through the same agent loop as a Task, streaming live in the
  // chat instead of spawning a subprocess.
  // Non-TTY (CI, piped) → fall back to text list.
  if (!process.stdin.isTTY) {
    const { listAllErrors } = await import("./core/pixel.js");
    await listAllErrors();
    return;
  }

  const saved = loadSavedSettings();
  const provider: Provider = saved.provider ?? "anthropic";
  const model: string = saved.model ?? defaultModelFor(provider);
  await runInkTUI({
    provider,
    model,
    cwd: process.cwd(),
    thinkingLevel: saved.thinkingEnabled ? "medium" : undefined,
    theme: saved.theme,
    initialOverlay: "pixel",
  });
}

function defaultModelFor(p: string): string {
  if (p === "openai") return "gpt-5.5";
  if (p === "glm") return "glm-5.1";
  if (p === "moonshot") return "kimi-k2.6";
  if (p === "minimax") return "MiniMax-M2.7";
  if (p === "deepseek") return "deepseek-v4-pro";
  if (p === "openrouter") return "qwen/qwen3.6-plus";
  return "claude-opus-4-7";
}

interface ParsedInstall {
  ingestUrl?: string;
  name?: string;
  skipPackageInstall: boolean;
}

function parsePixelInstallArgs(args: string[]): ParsedInstall {
  const out: ParsedInstall = { skipPackageInstall: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--ingest-url") out.ingestUrl = args[++i];
    else if (a === "--name") out.name = args[++i];
    else if (a === "--skip-install") out.skipPackageInstall = true;
  }
  return out;
}

function printPixelHelp(): void {
  console.log(`ggcoder pixel — error tracking + auto-fix queue

Usage:
  ggcoder pixel                  List open errors across every registered project
  ggcoder pixel install          Register the current project and wire up the SDK
  ggcoder pixel fix <error_id>   Fix one specific error end-to-end
  ggcoder pixel run              Auto-fix every open error across all projects

  ggcoder pixel install --name <name>      Override the project name
  ggcoder pixel install --ingest-url <url> Use a custom backend URL
  ggcoder pixel install --skip-install     Don't run the package manager
`);
}

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
    "glm",
    "moonshot",
    "minimax",
    "deepseek",
    "openrouter",
  ];
  const loggedInProviders: Provider[] = [];
  for (const p of allProviders) {
    if (await authStorage.getCredentials(p)) loggedInProviders.push(p);
  }

  if (loggedInProviders.length === 0) {
    throw new Error('Not logged in to any provider. Run "ggcoder login" to authenticate.');
  }

  if (loggedInProviders.includes(preferred)) {
    return {
      provider: preferred,
      model: savedModel ?? getDefaultModel(preferred).id,
      loggedInProviders,
    };
  }

  // Preferred provider isn't authenticated — fall back to the first one
  // that is, and use that provider's default model (the saved model
  // belonged to a provider the user can no longer reach).
  const provider = loggedInProviders[0]!;
  return { provider, model: getDefaultModel(provider).id, loggedInProviders };
}

function displayName(provider: Provider): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "xiaomi") return "Xiaomi (MiMo)";
  if (provider === "glm") return "Z.AI (GLM)";
  if (provider === "moonshot") return "Moonshot";
  if (provider === "minimax") return "MiniMax";
  if (provider === "deepseek") return "DeepSeek";
  if (provider === "openrouter") return "OpenRouter";
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
      if (text) items.push({ kind: "user", text, id: `restore-${id++}` });
    } else if (msg.role === "assistant") {
      const content = msg.content;
      if (typeof content === "string") {
        if (content) items.push({ kind: "assistant", text: content, id: `restore-${id++}` });
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
          items.push({ kind: "assistant", text: textBuf, id: `restore-${id++}` });
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

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";

  execFile(cmd, [url], () => {
    // Ignore errors — user can copy URL manually
  });
}

main();
