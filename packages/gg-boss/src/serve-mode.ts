import path from "node:path";
import fs from "node:fs/promises";
import chalk from "chalk";
import { getAppPaths, MODELS, type ModelInfo } from "@kenkaiiii/ggcoder";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { GGBoss } from "./orchestrator.js";
import { loadLinks } from "./links.js";
import { tasksStore } from "./tasks-store.js";
import { saveSettings } from "./settings.js";
import { transcribeVoice, isModelLoaded, setProgressCallback } from "./voice-transcriber.js";
import {
  subscribeToBossStore,
  getBossState,
  bossStore,
  type HistoryItem,
  type BossUiState,
} from "./boss-store.js";
import { TelegramBot, type TelegramMessage, type TelegramVoiceMessage } from "./telegram.js";
import { initLogger, log, closeLogger } from "./logger.js";
import { VERSION, BRAND, AUTHOR, LOGO_LINES, LOGO_GAP, GRADIENT, COLORS } from "./branding.js";

/**
 * `ggboss serve` — drive the orchestrator from Telegram.
 *
 * Mirrors `ggcoder serve` shape (long-poll bot, allowedUserId gate) but instead
 * of one-AgentSession-per-chat, there's a single GGBoss instance. The user's
 * linked projects (from `~/.gg/boss/links.json`) are spun up as workers at
 * boot, just like `ggboss` interactive mode.
 *
 * Bridge model:
 *  - Telegram text → boss.enqueueUserMessage(text). The boss's run loop picks
 *    it up FIFO with worker_turn_complete events.
 *  - bossStore history additions → forwarded to Telegram. We subscribe to the
 *    same store the Ink TUI uses, diff history length on each notify, and
 *    format only the new items. This way every assistant reply, tool call,
 *    worker_event, and info row the user would see in the TUI also lands in
 *    the chat.
 *
 * Voice notes, multi-chat /link, and project-switching from Telegram are
 * intentionally out of scope for v1: the boss is tied to its linked projects
 * for the lifetime of the process.
 */

export interface BossServeOptions {
  bossProvider: Provider;
  bossModel: string;
  bossThinkingLevel?: ThinkingLevel;
  workerProvider: Provider;
  workerModel: string;
  workerThinkingLevel?: ThinkingLevel;
  telegram: {
    botToken: string;
    userId: number;
  };
}

export interface BossTelegramConfig {
  botToken: string;
  userId: number;
}

function getTelegramConfigPath(): string {
  return path.join(getAppPaths().agentDir, "boss", "telegram.json");
}

export async function loadBossTelegramConfig(): Promise<BossTelegramConfig | null> {
  try {
    const raw = await fs.readFile(getTelegramConfigPath(), "utf-8");
    const data = JSON.parse(raw) as BossTelegramConfig;
    if (data.botToken && data.userId) return data;
    return null;
  } catch {
    return null;
  }
}

export async function saveBossTelegramConfig(config: BossTelegramConfig): Promise<void> {
  const file = getTelegramConfigPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
}

// ── History → Telegram formatter ─────────────────────────────

/**
 * Telegram is a chat surface, not a scrollback buffer — every history item
 * becomes a phone notification. We aggressively prune to only what the user
 * needs to track progress on a phone:
 *
 *   keep   → boss assistant text (the actual reply), errors, dispatch
 *            announcements, update notices
 *   drop   → individual orchestration tool calls (prompt_worker,
 *            dispatch_pending, add_task, peek_worker, …), per-turn
 *            worker_event recaps (the boss already narrates these in its
 *            assistant reply), info-level chatter, and the user's own echo
 *
 * The dropped channels are still visible in the TUI on the user's machine —
 * Telegram just sees the distilled signal.
 */
function formatItemForTelegram(item: HistoryItem): string | null {
  switch (item.kind) {
    case "user":
    case "tool":
    case "worker_event":
      // user: echo of what they just sent
      // tool: orchestration plumbing the boss already summarizes in prose
      // worker_event: boss replies with its own narrative of the same outcome
      return null;

    case "assistant": {
      const cleaned = stripScopePrefix(item.text).trim();
      return cleaned ? truncate(cleaned, 1500) : null;
    }

    case "worker_error":
      return `✗ *${item.project}* — ${truncate(item.message, 300)}`;

    case "info":
      // Skip plain info — those are TUI-hint level ("Ctrl+T to view tasks",
      // "Compacted N → M", etc.) and just add notification noise on mobile.
      if (item.level !== "warning" && item.level !== "error") return null;
      return `${item.level === "error" ? "✗ " : "⚠ "}_${truncate(item.text, 300)}_`;

    case "task_dispatch": {
      if (item.tasks.length === 0) return null;
      const projects = [...new Set(item.tasks.map((t) => t.project))];
      // Single-project, single-task → one-liner. Multi → short list.
      if (item.tasks.length === 1) {
        const t = item.tasks[0]!;
        return `→ *${t.project}*: ${truncate(t.title, 140)}`;
      }
      return `→ Dispatched ${item.tasks.length} tasks across ${projects.length} project${projects.length === 1 ? "" : "s"}`;
    }

    case "update_notice":
      return `✨ ${item.text}`;
  }
}

function stripScopePrefix(text: string): string {
  // Boss occasionally echoes its own scope tag back in assistant text; drop it.
  return text.replace(/^\s*\[scope:[^\]]+\]\s*/, "");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

/** Mirrors the TUI's scope pill — prefixes user messages with the active scope
 *  so the boss knows whether to think globally or focus on one project. */
function scopePrefix(scope: string): string {
  if (scope === "all") return "[scope:all] ";
  return `[scope:${scope}] `;
}

// ── Run ──────────────────────────────────────────────────────

export async function runBossServeMode(options: BossServeOptions): Promise<void> {
  // Init persistent logger early so any boot failure has a paper trail.
  initLogger({
    version: VERSION,
    bossProvider: options.bossProvider,
    bossModel: options.bossModel,
    bossThinking: options.bossThinkingLevel,
    workerProvider: options.workerProvider,
    workerModel: options.workerModel,
    projectCount: 0,
  });

  // Load linked projects — same path as interactive `ggboss`. Without links
  // the boss has nothing to manage, so bail with a clear error.
  const links = await loadLinks();
  if (links.projects.length === 0) {
    console.error(
      chalk.hex(COLORS.error)("No linked projects.\n") +
        chalk.hex(COLORS.textDim)("Run ") +
        chalk.hex(COLORS.accent)("ggboss link") +
        chalk.hex(COLORS.textDim)(" first to choose which projects the boss should manage."),
    );
    process.exit(1);
  }
  const projects = links.projects.map((p) => ({ name: p.name, cwd: p.cwd }));

  await tasksStore.load();

  const bot = new TelegramBot({
    botToken: options.telegram.botToken,
    allowedUserId: options.telegram.userId,
  });

  const boss = new GGBoss({
    bossProvider: options.bossProvider,
    bossModel: options.bossModel,
    bossThinkingLevel: options.bossThinkingLevel,
    workerProvider: options.workerProvider,
    workerModel: options.workerModel,
    workerThinkingLevel: options.workerThinkingLevel,
    projects,
  });

  await boss.initialize();
  log("INFO", "serve", "boss initialized", { projects: projects.map((p) => p.name).join(",") });

  // ── Telegram bridge: history → chat ────────────────────────

  const allowedChatId = options.telegram.userId; // DM with the user. Group support could be added later.
  /** Chats waiting on a number reply after `/scope` showed the picker. */
  const pendingScopeSelections = new Map<number, string[]>();
  /** Chats waiting on a number reply after `/m` / `/model-*` showed the picker.
   *  Stores the target ("boss" or "workers") alongside the model list so the
   *  same numeric reply path handles both pickers. */
  const pendingModelSelections = new Map<
    number,
    { target: "boss" | "workers"; models: ModelInfo[] }
  >();
  let lastHistoryLen = getBossState().history.length;
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  let isStreaming = false;

  function sendQueued(text: string): void {
    bot.send(allowedChatId, text).catch((err) => {
      log("WARN", "telegram", `send failed: ${err instanceof Error ? err.message : String(err)}`);
      // Retry without markdown to survive any formatting edge case.
      bot.sendPlain(allowedChatId, text.replace(/[*_`]/g, "")).catch(() => {});
    });
  }

  function startTyping(): void {
    if (typingInterval) return;
    bot.sendTyping(allowedChatId).catch(() => {});
    typingInterval = setInterval(() => {
      bot.sendTyping(allowedChatId).catch(() => {});
    }, 4000);
  }

  function stopTyping(): void {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  }

  function flushNewItems(state: BossUiState): void {
    const len = state.history.length;
    if (len <= lastHistoryLen) return;
    const fresh = state.history.slice(lastHistoryLen);
    lastHistoryLen = len;
    for (const item of fresh) {
      const formatted = formatItemForTelegram(item);
      if (formatted) sendQueued(formatted);
    }
  }

  /**
   * Apply a model choice to either the boss or every worker, persist it to
   * settings.json so the next launch defaults to the same picks, and confirm
   * via Telegram. Used by both the picker reply path and the direct
   * `/m <name>` arg path.
   */
  async function applyModelChoice(target: "boss" | "workers", selected: ModelInfo): Promise<void> {
    try {
      if (target === "boss") {
        await boss.switchBossModel(selected.provider, selected.id);
        await saveSettings({ bossProvider: selected.provider, bossModel: selected.id });
        await bot.send(allowedChatId, `Boss → *${selected.name}*`);
      } else {
        await boss.switchWorkerModel(selected.provider, selected.id);
        await saveSettings({ workerProvider: selected.provider, workerModel: selected.id });
        await bot.send(allowedChatId, `Workers → *${selected.name}*`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("WARN", "model_switch", message, { target, model: selected.id });
      await bot.send(allowedChatId, `Failed to switch ${target}: ${message}`);
    }
  }

  const unsubscribe = subscribeToBossStore(() => {
    // Drain the two-phase flush queue. In the Ink TUI a useEffect calls this
    // on every render so log-update can shrink the live area before Static
    // grows; serve mode has no Ink, so without this items would sit in
    // pendingFlush forever and the user would see "Typing..." with no reply.
    if (getBossState().pendingFlush.length > 0) {
      bossStore.commitPendingFlush();
    }

    const state = getBossState();
    flushNewItems(state);

    // Drive a typing indicator off the streaming flag so the user sees
    // activity even between text chunks (tools running, etc.).
    const streamingNow = state.streaming !== null;
    if (streamingNow && !isStreaming) {
      isStreaming = true;
      startTyping();
    } else if (!streamingNow && isStreaming) {
      isStreaming = false;
      stopTyping();
    }
  });

  // ── Telegram → boss ─────────────────────────────────────────

  bot.onText(async (msg: TelegramMessage) => {
    const { text, chatId } = msg;
    if (chatId !== allowedChatId) return;

    // Pending /scope reply (user sent just a number after the picker).
    const pendingScopes = pendingScopeSelections.get(chatId);
    if (pendingScopes && /^\s*\d+\s*$/.test(text)) {
      pendingScopeSelections.delete(chatId);
      const num = parseInt(text.trim(), 10);
      if (num < 1 || num > pendingScopes.length) {
        await bot.send(chatId, "Invalid selection. Send /scope to try again.");
        return;
      }
      const chosen = pendingScopes[num - 1]!;
      bossStore.setScope(chosen);
      await bot.send(chatId, `Scope: *${chosen}*`);
      return;
    }

    // Pending /m or /model-* reply. Same number-only path for boss + workers;
    // the picker stashes which target the number applies to.
    const pendingModel = pendingModelSelections.get(chatId);
    if (pendingModel && /^\s*\d+\s*$/.test(text)) {
      pendingModelSelections.delete(chatId);
      const num = parseInt(text.trim(), 10);
      if (num < 1 || num > pendingModel.models.length) {
        await bot.send(chatId, "Invalid selection. Send /m to try again.");
        return;
      }
      const selected = pendingModel.models[num - 1]!;
      await applyModelChoice(pendingModel.target, selected);
      return;
    }

    if (!text.startsWith("/")) {
      // Match the TUI: prepend the active scope so the boss knows whether
      // the user is talking about all projects or a specific worker. Without
      // this every Telegram message would be implicitly "all" regardless of
      // /scope — same prefix the orchestrator-app uses on submit.
      const scoped = scopePrefix(getBossState().scope) + text;
      boss.enqueueUserMessage(scoped);
      return;
    }

    const parts = text.trim().split(/\s+/);
    const cmd = parts[0]!.slice(1).toLowerCase().replace(/@\w+$/, "");

    if (cmd === "help" || cmd === "start") {
      await bot.send(chatId, buildTelegramHelpText());
      return;
    }

    // /m, /model, /model-boss, /model-workers — mirrors the TUI's two pickers.
    // Bare /m and /model open the BOSS picker (most common ask); the explicit
    // -workers form is required to swap workers since that touches every active
    // session and we want it deliberate.
    if (cmd === "m" || cmd === "model" || cmd === "model-boss" || cmd === "model-workers") {
      const target: "boss" | "workers" = cmd === "model-workers" ? "workers" : "boss";
      const arg = parts.slice(1).join(" ").trim().toLowerCase();
      const state = getBossState();
      const currentId = target === "boss" ? state.bossModel : state.workerModel;

      if (arg) {
        const num = parseInt(arg, 10);
        let match: ModelInfo | undefined;
        if (!isNaN(num) && num >= 1 && num <= MODELS.length) {
          match = MODELS[num - 1]!;
        } else {
          match = MODELS.find(
            (m) => m.name.toLowerCase().includes(arg) || m.id.toLowerCase().includes(arg),
          );
        }
        if (!match) {
          await bot.send(chatId, `No model matching "${arg}". Send /${cmd} to see the list.`);
          return;
        }
        await applyModelChoice(target, match);
        return;
      }

      // No arg → numbered picker grouped by provider.
      let listText = `*${target === "boss" ? "Boss" : "Worker"} model*\n`;
      let lastProvider = "";
      MODELS.forEach((m, i) => {
        if (m.provider !== lastProvider) {
          lastProvider = m.provider;
          listText += `\n_${providerLabel(m.provider)}_\n`;
        }
        const active = m.id === currentId ? "  ←" : "";
        listText += `  *${i + 1}.* ${m.name}${active}\n`;
      });
      listText += `\nSend the number, or \`/${cmd} <name>\`.`;
      pendingModelSelections.set(chatId, { target, models: [...MODELS] });
      await bot.send(chatId, listText);
      return;
    }

    if (cmd === "scope" || cmd === "s") {
      const state = getBossState();
      const arg = parts.slice(1).join(" ").trim().toLowerCase();
      const names = ["all", ...state.workers.map((w) => w.name)];

      // No arg → show numbered picker. Tap-friendly on mobile.
      if (!arg) {
        const lines = names.map((n, i) => {
          const active = n === state.scope ? "  ←" : "";
          const label = n === "all" ? "*All*" : `*${n}*`;
          return `*${i + 1}.* ${label}${active}`;
        });
        pendingScopeSelections.set(chatId, names);
        await bot.send(
          chatId,
          `*Scope*  —  current: *${state.scope}*\n\n${lines.join("\n")}\n\nSend the number, or \`/scope <name>\`.`,
        );
        return;
      }

      // Direct switch by number or name fragment.
      const num = parseInt(arg, 10);
      let chosen: string | null;
      if (!isNaN(num) && num >= 1 && num <= names.length) {
        chosen = names[num - 1]!;
      } else {
        const exact = names.find((n) => n.toLowerCase() === arg);
        chosen = exact ?? names.find((n) => n.toLowerCase().includes(arg)) ?? null;
      }
      if (!chosen) {
        await bot.send(chatId, `No scope matching "${arg}". Send /scope to see the list.`);
        return;
      }
      bossStore.setScope(chosen);
      await bot.send(chatId, `Scope: *${chosen}*`);
      return;
    }

    if (cmd === "status") {
      const state = getBossState();
      const lines: string[] = [`*${BRAND}* — ${state.bossModel}`, `Scope  *${state.scope}*`, ""];
      lines.push("*Workers*");
      for (const w of state.workers) {
        const dot = w.status === "working" ? "●" : w.status === "error" ? "✗" : "○";
        lines.push(`  ${dot} *${w.name}* — _${w.status}_`);
      }
      const tasks = tasksStore.list();
      const open = tasks.filter((t) => t.status === "pending" || t.status === "in_progress").length;
      lines.push("");
      lines.push(`Tasks  ${open} open  ·  ${tasks.length} total`);
      await bot.send(chatId, lines.join("\n"));
      return;
    }

    if (cmd === "cancel") {
      boss.abort();
      await bot.send(chatId, "_Aborted current boss turn._");
      return;
    }

    if (cmd === "new" || cmd === "n") {
      await boss.newSession();
      await bot.send(chatId, "── *New session* ──");
      return;
    }

    if (cmd === "tasks") {
      const tasks = tasksStore.list();
      if (tasks.length === 0) {
        await bot.send(chatId, "_No tasks._");
        return;
      }
      const lines = tasks.slice(0, 30).map((t, i) => {
        const status = t.status.replace("_", " ");
        return `*${i + 1}.* [${status}] *${t.project}* — ${t.description.split("\n")[0]}`;
      });
      await bot.send(chatId, `*Tasks*\n\n${lines.join("\n")}`);
      return;
    }

    // Anything else — pass straight through as a prompt; the boss may
    // recognize its own slash conventions (e.g. /compact handled in the TUI
    // layer) or just treat it as text. For unknown commands we still ship
    // the raw text so the boss can interpret it in context.
    boss.enqueueUserMessage(text);
  });

  // ── Voice notes ──────────────────────────────────────────────
  //
  // Mirrors `ggcoder serve`: download the OGG Opus blob from Telegram, decode
  // + transcribe locally with Whisper-tiny.en, then route the transcribed text
  // through the same scope-prefix path as a typed message. Whisper model is
  // ~75MB and downloaded on first use; we surface that as a one-time hint so
  // the user understands the initial silence.
  bot.onVoice(async (msg: TelegramVoiceMessage) => {
    const { chatId } = msg;
    if (chatId !== allowedChatId) return;

    try {
      if (!isModelLoaded()) {
        await bot.send(
          chatId,
          "Setting up voice transcription — downloading Whisper model. This only happens once.",
        );
        setProgressCallback((info) => {
          if (info.status === "progress" && info.progress !== undefined) {
            const pct = Math.round(info.progress);
            // Keep the typing indicator alive while a long download streams.
            if (pct % 25 === 0 && pct > 0) {
              bot.sendTyping(chatId).catch(() => {});
            }
          }
        });
      }
      await bot.sendTyping(chatId);

      const fileUrl = await bot.getFileUrl(msg.fileId);
      const transcribed = await transcribeVoice(fileUrl);
      if (!transcribed) {
        await bot.send(chatId, "_Could not transcribe voice note._");
        return;
      }

      await bot.send(chatId, `_Voice: "${transcribed}"_`);
      const scoped = scopePrefix(getBossState().scope) + transcribed;
      boss.enqueueUserMessage(scoped);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("ERROR", "voice", message);
      // Common failure: optional dep missing on user's install.
      const hint = /Cannot find module|Cannot resolve|MODULE_NOT_FOUND/.test(message)
        ? "\n\nVoice transcription needs the optional `@huggingface/transformers` and `ogg-opus-decoder` packages. Reinstall with `npm i -g @kenkaiiii/gg-boss` and ensure optional deps installed."
        : "";
      await bot.send(chatId, `_Voice transcription failed: ${message}_${hint}`);
    }
  });

  // ── Boot banner ─────────────────────────────────────────────

  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  printBanner({
    bossModel: options.bossModel,
    workerModel: options.workerModel,
    userId: options.telegram.userId,
    projectCount: projects.length,
  });

  // ── Shutdown ────────────────────────────────────────────────

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.hex(COLORS.textDim)("\nShutting down..."));
    bot.stop();
    stopTyping();
    unsubscribe();
    await boss.dispose().catch(() => {});
    closeLogger();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // ── Run ─────────────────────────────────────────────────────

  // Boss event loop. Runs forever, processes user_message + worker events.
  const runPromise = boss.run().catch((err) => {
    log("ERROR", "boss", err instanceof Error ? err.message : String(err));
  });

  // Long-poll Telegram. Returns when bot.stop() is called.
  await bot.start();
  await runPromise;
}

// ── Help & banner ──────────────────────────────────────────────

function buildTelegramHelpText(): string {
  return [
    "*GG Boss* — orchestrator over Telegram",
    "",
    "*Commands*",
    "/scope (/s) — switch project focus (All / per-worker)",
    "/m, /model-boss — switch the orchestrator's model",
    "/model-workers — switch every worker's model",
    "/status — workers + open tasks",
    "/tasks — list tasks",
    "/new — fresh boss session",
    "/cancel — abort the current boss turn",
    "/help — this message",
    "",
    "Voice notes are transcribed locally with Whisper and sent as prompts.",
    "Send any message to talk to the boss.",
  ].join("\n");
}

function providerLabel(provider: Provider): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "glm":
      return "Z.AI";
    case "moonshot":
      return "Moonshot";
    case "minimax":
      return "MiniMax";
    case "deepseek":
      return "DeepSeek";
    case "openrouter":
      return "OpenRouter";
    case "xiaomi":
      return "Xiaomi";
    default:
      return provider;
  }
}

function gradientText(text: string): string {
  let i = 0;
  return text
    .split("")
    .map((ch) => (ch === " " ? ch : chalk.hex(GRADIENT[i++ % GRADIENT.length]!)(ch)))
    .join("");
}

function printBanner(opts: {
  bossModel: string;
  workerModel: string;
  userId: number;
  projectCount: number;
}): void {
  console.log();
  console.log(
    `  ${gradientText(LOGO_LINES[0]!)}${LOGO_GAP}` +
      chalk.hex(COLORS.primary).bold(BRAND) +
      chalk.hex(COLORS.textDim)(` v${VERSION}`) +
      chalk.hex(COLORS.textDim)(" · By ") +
      chalk.white.bold(AUTHOR),
  );
  console.log(
    `  ${gradientText(LOGO_LINES[1]!)}${LOGO_GAP}` +
      chalk.hex(COLORS.accent)(`Boss: ${opts.bossModel}`),
  );
  console.log(
    `  ${gradientText(LOGO_LINES[2]!)}${LOGO_GAP}` +
      chalk.hex(COLORS.textDim)(`Workers: ${opts.workerModel}`),
  );
  console.log();
  console.log(
    chalk.hex(COLORS.textDim)("  Mode      ") +
      chalk.hex(COLORS.accent)("Telegram") +
      chalk.hex(COLORS.textDim)("  ·  User ") +
      chalk.white(String(opts.userId)) +
      chalk.hex(COLORS.textDim)(
        `  ·  ${opts.projectCount} project${opts.projectCount === 1 ? "" : "s"}`,
      ),
  );
  console.log();
  console.log(
    chalk.hex(COLORS.success)("  Ready. ") +
      chalk.hex(COLORS.textDim)("Open Telegram and message your bot."),
  );
  console.log();
  console.log(
    chalk.hex(COLORS.textDim)("  /help  ") +
      chalk.hex(COLORS.textDim)("commands") +
      chalk.hex(COLORS.textDim)("    /status  ") +
      chalk.hex(COLORS.textDim)("workers + tasks") +
      chalk.hex(COLORS.textDim)("    /cancel  ") +
      chalk.hex(COLORS.textDim)("abort turn"),
  );
  console.log();
}
