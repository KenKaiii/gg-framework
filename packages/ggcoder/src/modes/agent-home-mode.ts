import fs from "node:fs/promises";
import path from "node:path";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentHomeClient, type AgentSession as AHSession } from "@kenkaiiii/agent-home-sdk";
import { AgentSession } from "../core/agent-session.js";
import { isAbortError } from "@kenkaiiii/gg-agent";
import chalk from "chalk";
import { formatUserError } from "../utils/error-handler.js";
import { log, closeLogger } from "../core/logger.js";
import { getAppPaths } from "../config.js";
import { MODELS, getContextWindow } from "../core/model-registry.js";
import { estimateConversationTokens } from "../core/compaction/token-estimator.js";
import { PROMPT_COMMANDS } from "../core/prompt-commands.js";
import { loadCustomCommands } from "../core/custom-commands.js";
import { renderLogoBlock } from "../cli/shared.js";

export const AGENT_HOME_RELAY_URL = "wss://agent-home-relay.buzzbeamaustralia.workers.dev/ws";

export interface AgentHomeModeOptions {
  provider: Provider;
  model: string;
  cwd: string;
  version: string;
  thinkingLevel?: ThinkingLevel;
  agentHome: {
    token: string;
  };
}

// ── Project Discovery ──────────────────────────────────────

async function discoverProjects(): Promise<string[]> {
  const sessionsDir = getAppPaths().sessionsDir;
  try {
    const entries = await fs.readdir(sessionsDir);
    const projects: string[] = [];
    for (const entry of entries) {
      const decoded = "/" + entry.replace(/_/g, "/");
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

// ── Per-Session State ─────────────────────────────────────

interface SessionState {
  sessionId: string;
  cwd: string;
  session: AgentSession;
  ac: AbortController;
  textBuffer: string;
  activeTools: Map<string, { name: string; startTime: number; args: Record<string, unknown> }>;
  isProcessing: boolean;
}

// ── Commands handled before the agent loop ────────────────

const HANDLED_COMMANDS = new Set([
  "help",
  "status",
  "cancel",
  "link",
  "unlink",
  "start",
  "new",
  "n",
  "m",
  "model",
]);

/**
 * Agent Home mode: run ggcoder as an Agent Home agent.
 *
 * Connects to the Agent Home relay via WebSocket and bridges
 * messages between the iOS app and the ggcoder agent loop.
 * Each Agent Home session maps to its own AgentSession.
 */
export async function runAgentHomeMode(options: AgentHomeModeOptions): Promise<void> {
  const sessionStates = new Map<string, SessionState>();
  const sessionCreationLocks = new Map<string, Promise<SessionState>>();
  const defaultCwd = options.cwd;
  const sessionProjects = new Map<string, string>();
  const pendingLinkSelections = new Map<string, string[]>();
  const pendingModelSelections = new Map<string, typeof MODELS>();

  const client = new AgentHomeClient({
    relayUrl: AGENT_HOME_RELAY_URL,
    token: options.agentHome.token,
    agent: {
      id: "ggcoder",
      name: "GG Coder",
      description: `AI coding agent — ${options.model}`,
    },
  });

  // ── Helpers ────────────────────────────────────────────

  /** Send a response, tagging with sessionId for new sessions. */
  function reply(
    stream: { end: (text: string, opts?: { sessionId: string }) => void },
    text: string,
    isNewSession: boolean,
    targetSessionId: string,
  ): void {
    if (isNewSession) {
      stream.end(text, { sessionId: targetSessionId });
    } else {
      stream.end(text);
    }
  }

  // ── Session lifecycle ──────────────────────────────────

  function resolveProjectPath(sessionId?: string): string {
    if (sessionId && sessionProjects.has(sessionId)) {
      return sessionProjects.get(sessionId)!;
    }
    return defaultCwd;
  }

  async function createSession(sessionId: string, cwd: string): Promise<SessionState> {
    const ac = new AbortController();
    const session = new AgentSession({
      provider: options.provider,
      model: options.model,
      cwd,
      thinkingLevel: options.thinkingLevel,
      signal: ac.signal,
    });

    await session.initialize();
    log("INFO", "agent-home", `Session initialized: ${sessionId}`, { cwd });

    const state: SessionState = {
      sessionId,
      cwd,
      session,
      ac,
      textBuffer: "",
      activeTools: new Map(),
      isProcessing: false,
    };

    sessionStates.set(sessionId, state);
    return state;
  }

  async function getOrCreateSession(sessionId: string): Promise<SessionState> {
    const existing = sessionStates.get(sessionId);
    if (existing) return existing;

    const pending = sessionCreationLocks.get(sessionId);
    if (pending) return pending;

    const cwd = resolveProjectPath(sessionId);
    const promise = createSession(sessionId, cwd);

    sessionCreationLocks.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      sessionCreationLocks.delete(sessionId);
    }
  }

  async function switchProject(sessionId: string, projectPath: string): Promise<void> {
    const existing = sessionStates.get(sessionId);
    if (existing) {
      await existing.session.dispose();
      sessionStates.delete(sessionId);
    }
    sessionProjects.set(sessionId, projectPath);
    await createSession(sessionId, projectPath);
  }

  function pushSessions(): void {
    const list: AHSession[] = Array.from(sessionStates.values()).map((s) => ({
      id: s.sessionId,
      title: `${path.basename(s.cwd)} — ${s.session.getState().model}`,
      updatedAt: Date.now(),
    }));
    client.updateSessions(list);
  }

  // ── Help text builder ──────────────────────────────────

  async function buildHelpText(sessionId: string): Promise<string> {
    const state = sessionStates.get(sessionId);
    const currentCwd = state?.cwd ?? resolveProjectPath(sessionId);
    const currentModel = state?.session.getState().model ?? options.model;
    const modelInfo = MODELS.find((m) => m.id === currentModel);

    let text = "";
    text += `**GG Coder**\n`;
    text += `Project: **${path.basename(currentCwd)}** \u00b7 Model: **${modelInfo?.name ?? currentModel}**\n\n`;

    text += `**Commands**\n`;
    text += `\`/m\` \u2014 Switch model\n`;
    text += `\`/link\` \u2014 Switch project\n`;
    text += `\`/unlink\` \u2014 Reset to default project\n`;
    text += `\`/status\` \u2014 Current state\n`;
    text += `\`/cancel\` \u2014 Abort current task\n`;
    text += `\`/help\` \u2014 This message\n\n`;

    text += `**Session**\n`;
    text += `\`/compact\` \u2014 Compress context\n`;
    text += `\`/new\` \u2014 Fresh session\n`;
    text += `\`/session\` \u2014 List sessions\n`;
    text += `\`/branch\` \u2014 Fork conversation\n`;
    text += `\`/branches\` \u2014 List branches\n`;
    text += `\`/clear\` \u2014 Clear session\n`;
    text += `\`/settings\` \u2014 Show/modify settings\n`;

    if (PROMPT_COMMANDS.length > 0) {
      text += `\n**Agent**\n`;
      for (const cmd of PROMPT_COMMANDS) {
        text += `\`/${cmd.name}\` \u2014 ${cmd.description}\n`;
      }
    }

    const customCmds = await loadCustomCommands(currentCwd);
    if (customCmds.length > 0) {
      text += `\n**Custom**\n`;
      for (const cmd of customCmds) {
        text += `\`/${cmd.name}\` \u2014 ${cmd.description}\n`;
      }
    }

    text += `\n_Send any message to start coding._`;
    return text;
  }

  // ── Message handler ────────────────────────────────────

  client.onMessage(async (message, stream) => {
    const { content, sessionId } = message;
    const trimmed = content.trim();

    let targetSessionId: string;
    let isNewSession = false;

    if (sessionId) {
      targetSessionId = sessionId;
    } else {
      targetSessionId = `session-${Date.now()}`;
      isNewSession = true;
    }

    // ── Pending link selection ────────────────────────────
    const pendingProjects = pendingLinkSelections.get(targetSessionId);
    if (pendingProjects) {
      pendingLinkSelections.delete(targetSessionId);
      const num = parseInt(trimmed, 10);
      if (isNaN(num) || num < 1 || num > pendingProjects.length) {
        reply(
          stream,
          "Invalid selection. Send `/link` to try again.",
          isNewSession,
          targetSessionId,
        );
        return;
      }
      const selected = pendingProjects[num - 1]!;
      await switchProject(targetSessionId, selected);
      pushSessions();
      reply(
        stream,
        `\u2713 Switched to **${path.basename(selected)}**`,
        isNewSession,
        targetSessionId,
      );
      log("INFO", "agent-home", `Linked session ${targetSessionId} to ${selected}`);
      return;
    }

    // ── Pending model selection ───────────────────────────
    const pendingModels = pendingModelSelections.get(targetSessionId);
    if (pendingModels) {
      pendingModelSelections.delete(targetSessionId);
      const num = parseInt(trimmed, 10);
      if (isNaN(num) || num < 1 || num > pendingModels.length) {
        reply(stream, "Invalid selection. Send `/m` to try again.", isNewSession, targetSessionId);
        return;
      }
      const selected = pendingModels[num - 1]!;
      const state = await getOrCreateSession(targetSessionId);
      await state.session.switchModel(selected.provider, selected.id);
      pushSessions();
      reply(stream, `\u2713 Switched to **${selected.name}**`, isNewSession, targetSessionId);
      return;
    }

    // ── Command handling ──────────────────────────────────
    if (trimmed.startsWith("/")) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0]!.slice(1).toLowerCase();
      const args = parts.slice(1).join(" ");

      // ── /help ──
      if (cmd === "help" || cmd === "start") {
        const text = await buildHelpText(targetSessionId);
        reply(stream, text, isNewSession, targetSessionId);
        return;
      }

      // ── /status ──
      if (cmd === "status") {
        const state = sessionStates.get(targetSessionId);
        const currentCwd = state?.cwd ?? resolveProjectPath(targetSessionId);
        const projectName = path.basename(currentCwd);

        if (!state) {
          reply(
            stream,
            `**${projectName}**\n\n` +
              `Status: _Not started_\n\n` +
              `_Send a message to initialize._`,
            isNewSession,
            targetSessionId,
          );
          return;
        }

        const sessionState = state.session.getState();
        const modelInfo = MODELS.find((m) => m.id === sessionState.model);
        const contextWindow = getContextWindow(sessionState.model);
        const contextTokens = estimateConversationTokens(state.session.getMessages());
        const pctRaw = (contextTokens / contextWindow) * 100;
        const contextStr = pctRaw > 0 && pctRaw < 1 ? "<1" : String(Math.round(pctRaw));

        reply(
          stream,
          `**${projectName}**\n\n` +
            `| | |\n|---|---|\n` +
            `| Model | **${modelInfo?.name ?? sessionState.model}** |\n` +
            `| Messages | ${sessionState.messageCount} |\n` +
            `| Context | ${contextStr}% |\n` +
            `| Status | ${state.isProcessing ? "Working..." : "Idle"} |`,
          isNewSession,
          targetSessionId,
        );
        return;
      }

      // ── /cancel ──
      if (cmd === "cancel") {
        const state = sessionStates.get(targetSessionId);
        if (state?.isProcessing) {
          state.ac.abort();
          const newAc = new AbortController();
          state.ac = newAc;
          state.session.setSignal(newAc.signal);
          reply(stream, "\u2713 Cancelled.", isNewSession, targetSessionId);
        } else {
          reply(stream, "_Nothing to cancel._", isNewSession, targetSessionId);
        }
        return;
      }

      // ── /new, /n ──
      if (cmd === "new" || cmd === "n") {
        const state = await getOrCreateSession(targetSessionId);
        await state.session.newSession();
        pushSessions();
        reply(stream, "\u2713 **New session started.**", isNewSession, targetSessionId);
        return;
      }

      // ── /m, /model ──
      if (cmd === "m" || cmd === "model") {
        const state = sessionStates.get(targetSessionId);
        const currentModel = state?.session.getState().model;

        if (args) {
          // Direct switch: /m 3 (number) or /m opus (name fragment)
          const num = parseInt(args, 10);
          if (!isNaN(num) && num >= 1 && num <= MODELS.length) {
            const selected = MODELS[num - 1]!;
            const s = await getOrCreateSession(targetSessionId);
            await s.session.switchModel(selected.provider, selected.id);
            pushSessions();
            reply(stream, `\u2713 Switched to **${selected.name}**`, isNewSession, targetSessionId);
            return;
          }
          // Try matching by name fragment
          const lower = args.toLowerCase();
          const match = MODELS.find(
            (m) => m.name.toLowerCase().includes(lower) || m.id.toLowerCase().includes(lower),
          );
          if (match) {
            const s = await getOrCreateSession(targetSessionId);
            await s.session.switchModel(match.provider, match.id);
            pushSessions();
            reply(stream, `\u2713 Switched to **${match.name}**`, isNewSession, targetSessionId);
            return;
          }
          reply(
            stream,
            `No model matching "${args}". Send \`/m\` to see the list.`,
            isNewSession,
            targetSessionId,
          );
          return;
        }

        // No args — show numbered list
        let listText = `**Models**\n\n`;
        const modelList = [...MODELS];
        modelList.forEach((m, i) => {
          const active = m.id === currentModel ? " \u2190" : "";
          listText += `${i + 1}. ${m.name}${active}\n`;
        });

        pendingModelSelections.set(targetSessionId, modelList);
        listText += `\n_Send number or name to switch._`;
        reply(stream, listText, isNewSession, targetSessionId);
        return;
      }

      // ── /link ──
      if (cmd === "link") {
        if (args && path.isAbsolute(args.trim())) {
          const projectPath = args.trim();
          await switchProject(targetSessionId, projectPath);
          pushSessions();
          reply(
            stream,
            `\u2713 Switched to **${path.basename(projectPath)}**`,
            isNewSession,
            targetSessionId,
          );
          log("INFO", "agent-home", `Linked session ${targetSessionId} to ${projectPath}`);
          return;
        }

        const projects = await discoverProjects();
        if (projects.length === 0) {
          reply(
            stream,
            "No projects found.\n\nUse `/link <path>` to link manually.",
            isNewSession,
            targetSessionId,
          );
          return;
        }

        const currentCwd =
          sessionStates.get(targetSessionId)?.cwd ?? resolveProjectPath(targetSessionId);
        const lines = projects.map((p, i) => {
          const name = path.basename(p);
          const marker = p === currentCwd ? " \u2190" : "";
          return `${i + 1}. **${name}**${marker}`;
        });

        pendingLinkSelections.set(targetSessionId, projects);
        reply(
          stream,
          `**Projects**\n\n${lines.join("\n")}\n\n_Send the number to switch._`,
          isNewSession,
          targetSessionId,
        );
        return;
      }

      // ── /unlink ──
      if (cmd === "unlink") {
        if (!sessionProjects.has(targetSessionId)) {
          reply(stream, "_This session isn't linked to a project._", isNewSession, targetSessionId);
          return;
        }
        const existing = sessionStates.get(targetSessionId);
        if (existing) {
          await existing.session.dispose();
          sessionStates.delete(targetSessionId);
        }
        sessionProjects.delete(targetSessionId);
        pushSessions();
        reply(
          stream,
          `\u2713 Unlinked. Reset to **${path.basename(defaultCwd)}**`,
          isNewSession,
          targetSessionId,
        );
        return;
      }

      // ── Non-handled slash commands → forward to agent loop ──
      if (!HANDLED_COMMANDS.has(cmd)) {
        // Falls through to the agent loop below
      } else {
        // Shouldn't reach here, but guard against it
        return;
      }
    }

    // ── Forward to agent loop ────────────────────────────
    const state = await getOrCreateSession(targetSessionId);

    if (state.isProcessing) {
      stream.error("GG Coder is still processing a previous message. Please wait.");
      return;
    }

    state.isProcessing = true;
    state.textBuffer = "";
    state.activeTools = new Map();

    const unsubs: Array<() => void> = [];
    const bus = state.session.eventBus;

    unsubs.push(
      bus.on("text_delta", ({ text }) => {
        state.textBuffer += text;
        stream.token(text);
      }),
    );

    unsubs.push(
      bus.on("tool_call_start", ({ toolCallId, name, args: toolArgs }) => {
        state.activeTools.set(toolCallId, { name, startTime: Date.now(), args: toolArgs });
      }),
    );

    unsubs.push(
      bus.on("tool_call_end", ({ toolCallId, isError, durationMs }) => {
        const tool = state.activeTools.get(toolCallId);
        state.activeTools.delete(toolCallId);
        if (tool) {
          const icon = isError ? "\u2717" : "\u2713";
          const argsStr = formatArgs(tool.args);
          const duration = formatDuration(durationMs);
          const argsPart = argsStr ? ` \`${argsStr}\`` : "";
          stream.token(`\n${icon} **${tool.name}**${argsPart}  _${duration}_\n`);
        }
      }),
    );

    unsubs.push(
      bus.on("compaction_end", ({ originalCount, newCount }) => {
        stream.token(`\n\u2713 **Compacted** ${originalCount} \u2192 ${newCount} messages\n`);
      }),
    );

    try {
      await state.session.prompt(content);

      const finalText = state.textBuffer.trim() || "Done.";

      const modelId = state.session.getState().model;
      const contextWindow = getContextWindow(modelId);
      const contextTokens = estimateConversationTokens(state.session.getMessages());
      const contextPctRaw = (contextTokens / contextWindow) * 100;
      const contextStr =
        contextPctRaw > 0 && contextPctRaw < 1 ? "<1" : String(Math.round(contextPctRaw));

      const footer = `\n\n---\n_${contextStr}% context_`;

      reply(stream, finalText + footer, isNewSession, targetSessionId);
      pushSessions();
    } catch (err) {
      if (isAbortError(err)) {
        reply(stream, "Cancelled.", isNewSession, targetSessionId);
      } else {
        stream.error(`Error: ${formatUserError(err)}`);
      }
    } finally {
      for (const off of unsubs) off();
      state.isProcessing = false;
    }
  });

  // ── Session deletion ───────────────────────────────────

  client.onSessionDelete((sessionId) => {
    const state = sessionStates.get(sessionId);
    if (state) {
      state.session.dispose();
      sessionStates.delete(sessionId);
      sessionProjects.delete(sessionId);
      pendingLinkSelections.delete(sessionId);
      pendingModelSelections.delete(sessionId);
    }
    log("INFO", "agent-home", `Session deleted: ${sessionId}`);
  });

  // ── Connection events ──────────────────────────────────

  client.onConnect(() => {
    log("INFO", "agent-home", "Connected to relay");
    console.log(chalk.hex("#4ade80")("  Connected to Agent Home relay."));
    pushSessions();
  });

  client.onDisconnect(() => {
    log("INFO", "agent-home", "Disconnected from relay (will auto-reconnect)");
    console.log(chalk.hex("#ef4444")("  Disconnected from relay. Reconnecting..."));
  });

  // ── Initialize and start ─────────────────────────────

  try {
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

    const modelInfo = MODELS.find((m) => m.id === options.model);
    const modelName = modelInfo?.name ?? options.model;
    const home = process.env.HOME ?? "";
    const displayPath =
      home && options.cwd.startsWith(home) ? "~" + options.cwd.slice(home.length) : options.cwd;

    console.log();
    for (const row of renderLogoBlock([
      chalk.hex("#60a5fa").bold("GG Coder") +
        chalk.hex("#6b7280")(` v${options.version}`) +
        chalk.hex("#6b7280")(" \u00b7 By ") +
        chalk.white.bold("Ken Kai"),
      chalk.hex("#a78bfa")(modelName),
      chalk.hex("#6b7280")(displayPath),
    ])) {
      console.log(row);
    }
    console.log();
    console.log(
      chalk.hex("#6b7280")("  Mode      ") +
        chalk.hex("#a78bfa")("Agent Home") +
        chalk.hex("#6b7280")("  \u00b7  Agent ") +
        chalk.white("GG Coder"),
    );
    console.log();
    console.log(chalk.hex("#6b7280")("  Connecting to relay..."));
    console.log();

    const shutdown = async () => {
      console.log("\nShutting down...");
      client.disconnect();
      for (const state of sessionStates.values()) {
        await state.session.dispose();
      }
      closeLogger();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    client.connect();
  } catch (err) {
    console.error(`Failed to start: ${formatUserError(err)}`);
    for (const state of sessionStates.values()) {
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
  return str.length > 50 ? str.slice(0, 47) + "..." : str;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
