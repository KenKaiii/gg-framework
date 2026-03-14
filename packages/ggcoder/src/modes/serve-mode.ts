import fs from "node:fs/promises";
import path from "node:path";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../core/agent-session.js";
import { TelegramBot, type TelegramMessage } from "../core/telegram.js";
import chalk from "chalk";
import { formatUserError } from "../utils/error-handler.js";
import { log, closeLogger } from "../core/logger.js";
import { getAppPaths } from "../config.js";
import { MODELS, getContextWindow } from "../core/model-registry.js";
import { estimateConversationTokens } from "../core/compaction/token-estimator.js";

export interface ServeModeOptions {
  provider: Provider;
  model: string;
  cwd: string;
  version: string;
  thinkingLevel?: ThinkingLevel;
  telegram: {
    botToken: string;
    userId: number;
  };
}

// ── Serve Config ───────────────────────────────────────────
// Maps Telegram chatId → project path. Stored at ~/.gg/serve.json.
// DMs use chatId of the private chat. Groups use the group chatId.

interface ServeConfig {
  chats: Record<string, string>; // chatId (as string) → absolute path
}

function getConfigPath(): string {
  return path.join(getAppPaths().agentDir, "serve.json");
}

async function loadConfig(): Promise<ServeConfig> {
  try {
    const content = await fs.readFile(getConfigPath(), "utf-8");
    const raw = JSON.parse(content) as ServeConfig;
    return { chats: raw.chats ?? {} };
  } catch {
    return { chats: {} };
  }
}

async function saveConfig(config: ServeConfig): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

// ── Project Discovery ──────────────────────────────────────

/**
 * Scan ~/.gg/sessions/ to find all project directories that have sessions.
 * Returns decoded absolute paths sorted alphabetically.
 */
async function discoverProjects(): Promise<string[]> {
  const sessionsDir = getAppPaths().sessionsDir;
  try {
    const entries = await fs.readdir(sessionsDir);
    const projects: string[] = [];
    for (const entry of entries) {
      // Decode: reverse of encodeCwd (replace _ back to /)
      // encodeCwd: replace /\\ with _, remove :, strip leading _
      // Decoding is imperfect but works for display — we reconstruct the path
      const decoded = "/" + entry.replace(/_/g, "/");
      // Verify the decoded path has session files
      const dir = path.join(sessionsDir, entry);
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) {
        const files = await fs.readdir(dir);
        if (files.some((f) => f.endsWith(".jsonl"))) {
          projects.push(decoded);
        }
      }
    }
    return projects.sort();
  } catch {
    return [];
  }
}

// ── Per-Chat State ─────────────────────────────────────────

interface ChatState {
  chatId: number;
  cwd: string;
  session: AgentSession;
  ac: AbortController;
  textBuffer: string;
  activeTools: Map<string, { name: string; startTime: number; args: Record<string, unknown> }>;
  isProcessing: boolean;
  typingInterval: ReturnType<typeof setInterval> | null;
}

/**
 * Serve mode: run ggcoder controlled via Telegram.
 *
 * - DMs to bot → default project (CWD where serve was started)
 * - Groups → linked projects via /link <path>
 * - Each chat gets its own AgentSession, tools, context
 */
export async function runServeMode(options: ServeModeOptions): Promise<void> {
  const bot = new TelegramBot({
    botToken: options.telegram.botToken,
    allowedUserId: options.telegram.userId,
  });

  const config = await loadConfig();
  const chatStates = new Map<number, ChatState>();
  /** Chats waiting for a number selection after /link showed the project list. */
  const pendingLinkSelections = new Map<number, string[]>();

  // ── Session lifecycle ──────────────────────────────────

  async function getOrCreateChat(chatId: number, cwd: string): Promise<ChatState> {
    const existing = chatStates.get(chatId);
    if (existing) return existing;

    const ac = new AbortController();
    const session = new AgentSession({
      provider: options.provider,
      model: options.model,
      cwd,
      thinkingLevel: options.thinkingLevel,
      signal: ac.signal,
    });

    await session.initialize();
    log("INFO", "serve", `Session initialized for chat ${chatId}`, { cwd });

    const state: ChatState = {
      chatId,
      cwd,
      session,
      ac,
      textBuffer: "",
      activeTools: new Map(),
      isProcessing: false,
      typingInterval: null,
    };

    chatStates.set(chatId, state);
    wireSessionEvents(state);
    return state;
  }

  function resolveProjectPath(chatId: number): string {
    return config.chats[String(chatId)] ?? options.cwd;
  }

  // ── Per-chat typing ────────────────────────────────────

  function startTyping(state: ChatState): void {
    if (state.typingInterval) return;
    bot.sendTyping(state.chatId).catch(() => {});
    state.typingInterval = setInterval(() => {
      bot.sendTyping(state.chatId).catch(() => {});
    }, 4000);
  }

  function stopTyping(state: ChatState): void {
    if (state.typingInterval) {
      clearInterval(state.typingInterval);
      state.typingInterval = null;
    }
  }

  function flushText(state: ChatState): Promise<void> {
    const text = state.textBuffer.trim();
    state.textBuffer = "";
    if (text) {
      return bot.send(state.chatId, text);
    }
    return Promise.resolve();
  }

  // ── Agent → Telegram bridge (per chat) ─────────────────

  function wireSessionEvents(state: ChatState): void {
    const { session, chatId } = state;

    session.eventBus.on("text_delta", ({ text }) => {
      state.textBuffer += text;
    });

    session.eventBus.on("thinking_delta", () => {
      // Thinking not displayed in Telegram
    });

    session.eventBus.on("tool_call_start", ({ toolCallId, name, args }) => {
      state.activeTools.set(toolCallId, { name, startTime: Date.now(), args });
    });

    session.eventBus.on("tool_call_end", ({ toolCallId, isError, durationMs }) => {
      const tool = state.activeTools.get(toolCallId);
      state.activeTools.delete(toolCallId);
      if (tool) {
        const icon = isError ? "✗" : "✓";
        const argsStr = formatArgs(tool.args);
        const msg = `${icon} \`${tool.name}\` ${argsStr}  _${formatDuration(durationMs)}_`;
        bot.send(chatId, msg).catch((err) => {
          log(
            "WARN",
            "telegram",
            `Failed to send tool message for ${tool.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Retry without markdown formatting
          bot
            .sendPlain(chatId, `${icon} ${tool.name} ${argsStr} ${formatDuration(durationMs)}`)
            .catch(() => {});
        });
      }
    });

    session.eventBus.on("turn_end", () => {
      // Don't flush — let agent_done send response + summary as one message
    });

    session.eventBus.on("agent_done", ({ totalTurns, totalUsage }) => {
      stopTyping(state);
      state.isProcessing = false;
      const total = totalUsage.inputTokens + totalUsage.outputTokens;
      const tokens = total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
      const turns = totalTurns === 1 ? "1 turn" : `${totalTurns} turns`;

      // Context usage percentage
      const modelId = session.getState().model;
      const contextWindow = getContextWindow(modelId);
      const contextTokens = estimateConversationTokens(session.getMessages());
      const contextPctRaw = (contextTokens / contextWindow) * 100;
      const contextStr =
        contextPctRaw > 0 && contextPctRaw < 1 ? "<1" : String(Math.round(contextPctRaw));

      state.textBuffer += `\n\n_${tokens} tokens · ${turns} · ${contextStr}% context_`;
      flushText(state).catch(() => {});
    });

    session.eventBus.on("error", ({ error }) => {
      stopTyping(state);
      state.isProcessing = false;
      bot.send(chatId, `✗ *Error*\n${error.message}`).catch(() => {});
    });

    session.eventBus.on("compaction_end", ({ originalCount, newCount }) => {
      bot.send(chatId, `✓ *Compacted* — ${originalCount} → ${newCount} messages`).catch((err) => {
        log(
          "WARN",
          "telegram",
          `Failed to send compaction message: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  // ── Telegram command handlers ──────────────────────────

  const TELEGRAM_COMMANDS = new Set([
    "help",
    "status",
    "cancel",
    "link",
    "unlink",
    "start",
    "m",
    "model",
  ]);
  /** Chats waiting for a model number selection. */
  const pendingModelSelections = new Map<number, typeof MODELS>();

  function buildHelpText(chatId: number): string {
    const projectPath = resolveProjectPath(chatId);
    const linked = config.chats[String(chatId)];
    const state = chatStates.get(chatId);
    const currentModel = state?.session.getState().model ?? options.model;
    const modelInfo = MODELS.find((m) => m.id === currentModel);

    let text = `*ggcoder* — remote coding agent\n\n`;
    text += `Project: \`${path.basename(projectPath)}\`\n`;
    text += `Model: *${modelInfo?.name ?? currentModel}*\n\n`;

    text += `*Commands*\n`;
    text += `/m — switch model\n`;
    text += `/link — switch project\n`;
    text += `/status — current state\n`;
    text += `/compact — compress context\n`;
    text += `/branch — fork conversation\n`;
    text += `/new — fresh session\n`;
    text += `/cancel — abort current task\n`;
    text += `/help — this message\n`;

    if (!linked) {
      text += `\n_Tip: send /link to connect this chat to a specific project._`;
    }

    text += `\n\nSend any message to start coding.`;

    return text;
  }

  async function linkChat(chatId: number, projectPath: string, chatTitle?: string): Promise<void> {
    config.chats[String(chatId)] = projectPath;
    await saveConfig(config);

    // Dispose existing session if switching projects
    const existing = chatStates.get(chatId);
    if (existing && existing.cwd !== projectPath) {
      await existing.session.dispose();
      chatStates.delete(chatId);
    }

    const name = chatTitle ?? path.basename(projectPath);
    await bot.send(chatId, `Linked *${name}* → \`${projectPath}\``);
  }

  bot.onAddedToGroup(async (chatId, chatTitle) => {
    const groupName = chatTitle ?? "this group";
    await bot.send(
      chatId,
      `*ggcoder* joined *${groupName}*\n\n` +
        `Send /link to connect to a project\n` +
        `Send /help for all commands`,
    );
    log("INFO", "serve", `Bot added to group ${chatId}`, { title: chatTitle ?? "unknown" });
  });

  bot.onRemovedFromGroup(async (chatId) => {
    // Clean up config and session when bot is removed from a group
    const existing = chatStates.get(chatId);
    if (existing) {
      stopTyping(existing);
      await existing.session.dispose();
      chatStates.delete(chatId);
    }
    if (config.chats[String(chatId)]) {
      delete config.chats[String(chatId)];
      await saveConfig(config);
    }
    log("INFO", "serve", `Bot removed from group ${chatId} — unlinked`);
  });

  bot.onText(async (msg: TelegramMessage) => {
    const { text, chatId } = msg;

    // Check for pending selections (user sent a number after /link or /m)
    const pendingProjects = pendingLinkSelections.get(chatId);
    if (pendingProjects) {
      pendingLinkSelections.delete(chatId);
      const num = parseInt(text.trim(), 10);
      if (isNaN(num) || num < 1 || num > pendingProjects.length) {
        await bot.send(chatId, "Invalid selection. Send /link to try again.");
        return;
      }
      const selected = pendingProjects[num - 1]!;
      await linkChat(chatId, selected, msg.chatTitle);
      return;
    }

    const pendingModels = pendingModelSelections.get(chatId);
    if (pendingModels) {
      pendingModelSelections.delete(chatId);
      const num = parseInt(text.trim(), 10);
      if (isNaN(num) || num < 1 || num > pendingModels.length) {
        await bot.send(chatId, "Invalid selection. Send /m to try again.");
        return;
      }
      const selected = pendingModels[num - 1]!;
      const projectPath = resolveProjectPath(chatId);
      const chatState = await getOrCreateChat(chatId, projectPath);
      await chatState.session.switchModel(selected.provider, selected.id);
      await bot.send(chatId, `Switched to *${selected.name}*`);
      return;
    }

    if (!text.startsWith("/")) {
      await handlePrompt(chatId, text);
      return;
    }

    const parts = text.trim().split(/\s+/);
    const cmd = parts[0]!.slice(1).toLowerCase().replace(/@\w+$/, ""); // strip /cmd@botname
    const args = parts.slice(1).join(" ");

    // ── Telegram-specific commands ──

    if (cmd === "help") {
      await bot.send(chatId, buildHelpText(chatId));
      return;
    }

    if (cmd === "status") {
      const projectPath = resolveProjectPath(chatId);
      const state = chatStates.get(chatId);
      const linked = config.chats[String(chatId)];
      const projectName = linked ? path.basename(projectPath) : "default";

      if (!state) {
        await bot.send(
          chatId,
          `*${projectName}*\n\n` +
            `Path  \`${projectPath}\`\n` +
            `Session  _not started_\n\n` +
            `_Send a message to initialize._`,
        );
        return;
      }

      const sessionState = state.session.getState();
      const modelInfo = MODELS.find((m) => m.id === sessionState.model);
      const contextWindow = getContextWindow(sessionState.model);
      const contextTokens = estimateConversationTokens(state.session.getMessages());
      const statusPctRaw = (contextTokens / contextWindow) * 100;
      const statusContextStr =
        statusPctRaw > 0 && statusPctRaw < 1 ? "<1" : String(Math.round(statusPctRaw));

      await bot.send(
        chatId,
        `*${projectName}*\n\n` +
          `Model  *${modelInfo?.name ?? sessionState.model}*\n` +
          `Messages  ${sessionState.messageCount}\n` +
          `Context  ${statusContextStr}%\n` +
          `Status  ${state.isProcessing ? "_working..._" : "_idle_"}\n\n` +
          `\`${sessionState.cwd}\``,
      );
      return;
    }

    if (cmd === "cancel") {
      const state = chatStates.get(chatId);
      if (state?.isProcessing) {
        state.ac.abort();
        // Replace AbortController so the session's next prompt gets a fresh signal
        const newAc = new AbortController();
        state.ac = newAc;
        state.session.setSignal(newAc.signal);
        await bot.send(chatId, "Cancelled.");
      } else {
        await bot.send(chatId, "_Nothing to cancel._");
      }
      return;
    }

    if (cmd === "link") {
      if (args && path.isAbsolute(args.trim())) {
        // Direct path provided — link immediately
        const projectPath = args.trim();
        await linkChat(chatId, projectPath, msg.chatTitle);
        return;
      }

      // No path — show project picker
      const projects = await discoverProjects();
      if (projects.length === 0) {
        await bot.send(chatId, "_No projects found._\n\nUse /link `<path>` to link manually.");
        return;
      }

      const current = config.chats[String(chatId)];
      const lines = projects.map((p, i) => {
        const name = path.basename(p);
        const active = p === current ? "  _current_" : "";
        return `*${i + 1}.* *${name}*${active}\n    \`${p}\``;
      });

      pendingLinkSelections.set(chatId, projects);
      await bot.send(
        chatId,
        `*Select a project*\n\n${lines.join("\n\n")}\n\nSend the number to link.`,
      );
      return;
    }

    if (cmd === "unlink") {
      if (!config.chats[String(chatId)]) {
        await bot.send(chatId, "_This chat isn't linked to a project._");
        return;
      }
      const existing = chatStates.get(chatId);
      if (existing) {
        await existing.session.dispose();
        chatStates.delete(chatId);
      }
      delete config.chats[String(chatId)];
      await saveConfig(config);
      await bot.send(chatId, `✓ *Unlinked*\n\nDefault project: \`${path.basename(options.cwd)}\``);
      return;
    }

    if (cmd === "start") {
      await bot.send(chatId, buildHelpText(chatId));
      return;
    }

    if (cmd === "m" || cmd === "model") {
      const state = chatStates.get(chatId);
      const currentModel = state?.session.getState().model;

      if (args) {
        // Direct switch: /m 3 (number) or /m opus (name fragment)
        const num = parseInt(args, 10);
        if (!isNaN(num) && num >= 1 && num <= MODELS.length) {
          const selected = MODELS[num - 1]!;
          const projectPath = resolveProjectPath(chatId);
          const chatState = await getOrCreateChat(chatId, projectPath);
          await chatState.session.switchModel(selected.provider, selected.id);
          await bot.send(chatId, `Switched to *${selected.name}*`);
          return;
        }
        // Try matching by name fragment
        const lower = args.toLowerCase();
        const match = MODELS.find(
          (m) => m.name.toLowerCase().includes(lower) || m.id.toLowerCase().includes(lower),
        );
        if (match) {
          const projectPath = resolveProjectPath(chatId);
          const chatState = await getOrCreateChat(chatId, projectPath);
          await chatState.session.switchModel(match.provider, match.id);
          await bot.send(chatId, `Switched to *${match.name}*`);
          return;
        }
        await bot.send(chatId, `No model matching "${args}". Send /m to see the list.`);
        return;
      }

      // No args — show numbered list grouped by provider
      let listText = "*Models*\n";
      let lastProvider = "";
      const modelList = [...MODELS];
      modelList.forEach((m, i) => {
        if (m.provider !== lastProvider) {
          lastProvider = m.provider;
          const providerName =
            m.provider === "anthropic"
              ? "Anthropic"
              : m.provider === "openai"
                ? "OpenAI"
                : m.provider === "glm"
                  ? "Z.AI"
                  : "Moonshot";
          listText += `\n_${providerName}_\n`;
        }
        const active = m.id === currentModel ? "  ←" : "";
        listText += `  *${i + 1}.* ${m.name}${active}\n`;
      });

      pendingModelSelections.set(chatId, modelList);
      listText += `\nSend number or name to switch.`;
      await bot.send(chatId, listText);
      return;
    }

    // ── Forward to ggcoder slash commands ──

    if (!TELEGRAM_COMMANDS.has(cmd)) {
      const projectPath = resolveProjectPath(chatId);
      const state = await getOrCreateChat(chatId, projectPath);

      if (state.isProcessing) {
        await bot.send(chatId, "_Working..._ send /cancel to interrupt.");
        return;
      }

      try {
        state.textBuffer = "";
        await state.session.prompt(text.trim());
        await flushText(state);
      } catch (err) {
        await bot.send(chatId, `Command failed: ${formatUserError(err)}`);
      }
      return;
    }
  });

  // ── Prompt handler ──────────────────────────────────

  async function handlePrompt(chatId: number, text: string): Promise<void> {
    const projectPath = resolveProjectPath(chatId);
    const state = await getOrCreateChat(chatId, projectPath);

    if (state.isProcessing) {
      await bot.send(chatId, "_Working..._ send /cancel to interrupt.");
      return;
    }

    state.isProcessing = true;
    startTyping(state);
    state.textBuffer = "";
    state.activeTools = new Map();

    try {
      await state.session.prompt(text);
    } catch (err) {
      stopTyping(state);
      state.isProcessing = false;
      if (err instanceof Error && err.name === "AbortError") {
        await bot.send(chatId, "Cancelled.");
      } else {
        await bot.send(chatId, `Error: ${formatUserError(err)}`);
      }
    }
  }

  // ── Initialize and start ─────────────────────────────

  try {
    // Clear terminal
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

    const linkedCount = Object.keys(config.chats).length;
    const modelInfo = MODELS.find((m) => m.id === options.model);
    const modelName = modelInfo?.name ?? options.model;
    const home = process.env.HOME ?? "";
    const displayPath =
      home && options.cwd.startsWith(home) ? "~" + options.cwd.slice(home.length) : options.cwd;

    // GG logo with gradient (matches Banner.tsx)
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
        chalk.hex("#6b7280")(` v${options.version}`) +
        chalk.hex("#6b7280")(" · By ") +
        chalk.white.bold("Ken Kai"),
    );
    console.log(`  ${gradientText(LOGO[1]!)}${GAP}` + chalk.hex("#a78bfa")(modelName));
    console.log(`  ${gradientText(LOGO[2]!)}${GAP}` + chalk.hex("#6b7280")(displayPath));
    console.log();
    console.log(
      chalk.hex("#6b7280")("  Mode      ") +
        chalk.hex("#a78bfa")("Telegram") +
        chalk.hex("#6b7280")("  ·  User ") +
        chalk.white(String(options.telegram.userId)) +
        (linkedCount > 0 ? chalk.hex("#6b7280")(`  ·  ${linkedCount} linked chat(s)`) : ""),
    );
    console.log();
    console.log(
      chalk.hex("#4ade80")("  Ready. ") +
        chalk.hex("#6b7280")("Open Telegram and message your bot."),
    );
    console.log();
    console.log(
      chalk.hex("#6b7280")("  /help  ") +
        chalk.hex("#6b7280")("all commands") +
        chalk.hex("#6b7280")("    /link  ") +
        chalk.hex("#6b7280")("switch project") +
        chalk.hex("#6b7280")("    /m  ") +
        chalk.hex("#6b7280")("switch model"),
    );
    console.log();

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log("\nShutting down...");
      bot.stop();
      for (const state of chatStates.values()) {
        stopTyping(state);
        await state.session.dispose();
      }
      closeLogger();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await bot.start();
  } catch (err) {
    console.error(`Failed to start: ${formatUserError(err)}`);
    for (const state of chatStates.values()) {
      await state.session.dispose();
    }
    closeLogger();
    process.exit(1);
  }
}

// ── Helpers ───────────────────────────────────────────────

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const [_key, value] = entries[0]!;
  const str = typeof value === "string" ? value : JSON.stringify(value);
  const truncated = str.length > 60 ? str.slice(0, 57) + "..." : str;
  // Strip backticks to avoid breaking Telegram markdown code spans
  const safe = truncated.replace(/`/g, "'");
  return `\`${safe}\``;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
