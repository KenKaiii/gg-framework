/**
 * gg-app sidecar — bridges the full ggcoder AgentSession to the Tauri webview
 * over plain HTTP + Server-Sent Events (zero browser-side dependencies).
 *
 * Transport:
 *   GET  /state    → { provider, model, cwd, ready }
 *   GET  /events   → text/event-stream of forwarded agent + session events
 *   POST /prompt   → { text } ; runs AgentSession.prompt(text)
 *   POST /cancel   → aborts the in-flight run
 *
 * The agent spine (gg-ai → gg-agent → gg-core) and every tool are reused
 * unchanged via AgentSession — this file is only a network seam.
 */
import http from "node:http";
import fs from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  environmentSecrets,
  formatError,
  redactValue,
  type ToolResultContent,
} from "@kenkaiiii/gg-ai";
import type { AddressInfo } from "node:net";
import { runJsonMode } from "./modes/json-mode.js";
import { runSubagentWorkerMode } from "./modes/subagent-worker-mode.js";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./core/agent-session.js";
import { RunLifecycle } from "./core/run-lifecycle.js";
import {
  CHAT_AGENT_IDS,
  chatAgentSessionsDir,
  createChatAgent,
  parseChatAgentId,
  switchChatAgent,
  type ChatAgentId,
} from "./chat-agents/index.js";
import { buildJiwaTools, JiwaStore } from "./chat-agents/jiwa.js";
import { buildMemoryTools, MemoryStore } from "./chat-agents/memory.js";
import { buildKenSystemPrompt, buildKenAutopilotSystemPrompt } from "./core/ken-prompt.js";
import {
  buildKenDigest,
  buildKenAutopilotContext,
  buildKenAutopilotPlanContext,
} from "./core/ken-context.js";
import { parseAutopilotVerdict, type AutopilotVerdict } from "./core/autopilot-verdict.js";
import {
  isWorkflowCommandText,
  countAssistantMessages,
  shouldStartAutopilotCycle,
  extractTurnToolCalls,
  isMechanicalOnlyTurn,
  type WorkflowCommandSpec,
} from "./core/autopilot-gate.js";
import { driveAutopilotCycle, frameAutopilotInjection } from "./core/autopilot-cycle.js";
import { validateKenModelPref, effectiveKenModel, type KenModelPref } from "./core/ken-model.js";
import type { KenTurnPayload, AppMarkerPayload } from "./core/session-manager.js";
import {
  normalizeAutopilotMarkersForHistory,
  normalizeAppMarkersForHistory,
  normalizeKenTurnsForHistory,
  restoreUserRow,
  restoreAssistantTexts,
  autopilotMarkerCopySeed,
} from "./core/session-history.js";
import { AuthStorage } from "./core/auth-storage.js";
import { cleanupToolOutputs } from "./tools/overflow.js";
import {
  fetchSubscriptionUsage,
  MOONSHOT_OAUTH_KEY,
  SubscriptionUsageError,
  XIAOMI_CREDITS_KEY,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshot,
} from "@kenkaiiii/gg-core";
import { loginAnthropic } from "./core/oauth/anthropic.js";
import { loginOpenAI } from "./core/oauth/openai.js";
import { loginGemini } from "./core/oauth/gemini.js";
import { loginKimi } from "./core/oauth/kimi.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./core/oauth/types.js";
import { AUTH_PROVIDERS, type AuthProviderMeta } from "./core/auth-providers.js";
import { ensureAppDirs, loadSavedSettings } from "./config.js";
import { SettingsManager, type Settings } from "./core/settings-manager.js";
import {
  getModel,
  getDefaultThinkingLevel,
  getContextWindow,
  MODELS,
} from "./core/model-registry.js";
import { resolveStartOrFallback } from "./core/resolve-start.js";
import { getGitBranch, getGitDirtyFileCount, isGitRepo } from "./utils/git.js";
import { extractPlanSteps } from "./utils/plan-steps.js";
import {
  getNextThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevelSupported,
} from "./core/thinking-level.js";
import { PROMPT_COMMANDS } from "./core/prompt-commands.js";
import { loadCustomCommands } from "./core/custom-commands.js";
import { discoverProjects } from "./core/project-discovery.js";
import { listSidecarSessions } from "./app-sidecar-sessions.js";
import {
  loadTasksSync,
  saveTasksSync,
  pruneDoneTasksSync,
  getNextPendingTask,
  markTaskInProgress,
} from "./core/tasks-store.js";
import { initLogger, log } from "./core/logger.js";
import {
  RADIO_STATIONS,
  getCurrentStation,
  getRadioVolume,
  playRadio,
  setRadioVolume,
  stopRadio,
} from "./core/radio.js";
import { enrichProcessPath } from "./core/shell-path.js";
import { downscaleForPreview, shrinkToFit, validateVisionImage } from "./utils/image.js";
import { startServeMode, type ServeController } from "./modes/serve-mode.js";
import { loadTelegramConfig, saveTelegramConfig, verifyBotToken } from "./core/telegram-config.js";
import {
  loadServers,
  addServer,
  removeServer,
  getServer,
  parseMcpAddCommand,
  MCPClientManager,
  McpOAuthStore,
  type MCPScope,
  type MCPServerConfig,
} from "./core/mcp/index.js";
import { buildSnapshot, levelForXp, rankForLevel } from "./core/progress/ranks.js";
import { loadProgress, peekProgress, updateProgress } from "./core/progress/store.js";
import { awardPrompt, awardCommits } from "./core/progress/engine.js";
import { detectNewCommits, repoKey } from "./core/progress/git-xp.js";
import { rebuildFromSessions } from "./core/progress/rebuild.js";
import type { ProgressFile, ProgressSnapshot } from "./core/progress/types.js";
import {
  captureSidecarError,
  flushSidecarErrors,
  shouldCaptureToolFailure,
  shouldCaptureUsagePollingError,
  wrapSidecarHandler,
} from "./core/sidecar-error-reporter.js";

const ALL_PROVIDERS: Provider[] = [
  // US
  "anthropic",
  "openai",
  "gemini",
  "xai",
  // China
  "moonshot",
  "glm",
  "minimax",
  "xiaomi",
  "deepseek",
  // Japan, then provider-agnostic gateway last
  "sakana",
  "openrouter",
];

// ── gg-app settings (~/.gg/gg-app.json) ────────────────────
// App-specific, separate from the shared ggcoder settings file so the desktop
// app's preferences never collide with the CLI's.

/** Per-project model + thinking preferences. Persisted so each window (one
 *  project cwd) restores its OWN model across app restarts — instead of every
 *  window reading the same single global slot that the last writer clobbered. */
interface ProjectModelPrefs {
  provider: Provider;
  model: string;
  thinkingEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
}

interface AppSettings {
  /** Folder new projects are created inside. Defaults to ~/gg-projects. */
  projectsRoot: string;
  /** Model + thinking prefs keyed by normalized project cwd. A window restores
   *  its own entry on boot; absent → global settings.json → provider default. */
  projectModels?: Record<string, ProjectModelPrefs>;
  /** Autopilot (auto-review) on/off keyed by normalized project cwd. Per-window
   *  (one window = one cwd); absent/false → off. Restored on boot. */
  autopilot?: Record<string, boolean>;
  /** Ken's model override keyed by normalized project cwd. Absent → Ken follows
   *  GG Coder's model (the historical behavior). Set → Ken (chat + autopilot)
   *  uses this model regardless of GG Coder's. */
  kenModels?: Record<string, KenModelPref>;
}

function appSettingsFile(): string {
  return path.join(os.homedir(), ".gg", "gg-app.json");
}

function defaultProjectsRoot(): string {
  return path.join(os.homedir(), "gg-projects");
}

/** Normalize a project cwd to a stable settings key so trailing slashes /
 *  relative segments collapse — the same project always maps to one entry. */
function projectModelKey(cwd: string): string {
  return path.resolve(cwd);
}

async function loadAppSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(appSettingsFile(), "utf-8")) as Partial<AppSettings>;
    return {
      projectsRoot:
        typeof raw.projectsRoot === "string" && raw.projectsRoot.trim()
          ? raw.projectsRoot
          : defaultProjectsRoot(),
      // Preserve the per-project map verbatim (validated + written by the
      // model/thinking handlers below).
      projectModels:
        raw.projectModels && typeof raw.projectModels === "object" ? raw.projectModels : undefined,
      autopilot: raw.autopilot && typeof raw.autopilot === "object" ? raw.autopilot : undefined,
      kenModels: raw.kenModels && typeof raw.kenModels === "object" ? raw.kenModels : undefined,
    };
  } catch {
    return { projectsRoot: defaultProjectsRoot() };
  }
}

async function saveAppSettings(settings: AppSettings): Promise<void> {
  await fs.mkdir(path.dirname(appSettingsFile()), { recursive: true });
  await fs.writeFile(appSettingsFile(), JSON.stringify(settings, null, 2), "utf-8");
}

/** Read this project's persisted model/thinking prefs, if any. */
async function loadProjectModelPrefs(cwd: string): Promise<ProjectModelPrefs | undefined> {
  const s = await loadAppSettings();
  return s.projectModels?.[projectModelKey(cwd)];
}

/** Persist this project's model/thinking prefs via read-modify-write so the rest
 *  of the settings file (projectsRoot, other projects' entries) is preserved. */
async function saveProjectModelPrefs(cwd: string, prefs: ProjectModelPrefs): Promise<void> {
  const s = await loadAppSettings();
  const key = projectModelKey(cwd);
  s.projectModels = { ...(s.projectModels ?? {}), [key]: prefs };
  await saveAppSettings(s);
}

/** Read this project's persisted Ken model override, if any. */
async function loadKenModelPref(cwd: string): Promise<KenModelPref | undefined> {
  const s = await loadAppSettings();
  return s.kenModels?.[projectModelKey(cwd)];
}

/** Persist (or with null, clear) this project's Ken model override via
 *  read-modify-write so the rest of the settings file is preserved. */
async function saveKenModelPref(cwd: string, pref: KenModelPref | null): Promise<void> {
  const s = await loadAppSettings();
  const key = projectModelKey(cwd);
  const next = { ...(s.kenModels ?? {}) };
  if (pref) next[key] = pref;
  else delete next[key];
  s.kenModels = next;
  await saveAppSettings(s);
}

/** Read this project's persisted autopilot flag (default off). */
async function loadAutopilot(cwd: string): Promise<boolean> {
  const s = await loadAppSettings();
  return s.autopilot?.[projectModelKey(cwd)] ?? false;
}

/** Persist this project's autopilot flag via read-modify-write so the rest of
 *  the settings file (projectsRoot, model map, other projects) is preserved. */
async function saveAutopilot(cwd: string, enabled: boolean): Promise<void> {
  const s = await loadAppSettings();
  const key = projectModelKey(cwd);
  s.autopilot = { ...(s.autopilot ?? {}), [key]: enabled };
  await saveAppSettings(s);
}

/**
 * Persist the active model selection to ~/.gg/settings.json so it survives app
 * restarts. Mirrors the CLI's handleModelSelect persistence (App.tsx).
 */
async function persistModelSelection(
  settingsFile: string,
  provider: Provider,
  model: string,
): Promise<void> {
  try {
    const sm = new SettingsManager(settingsFile);
    await sm.load();
    await sm.set("defaultProvider", provider as Settings["defaultProvider"]);
    await sm.set("defaultModel", model);
  } catch (err) {
    captureSidecarError(err, "app-sidecar.settings.persist-model");
    log("WARN", "app-sidecar", "failed to persist model selection", { err: String(err) });
  }
}

/**
 * Persist the thinking level to ~/.gg/settings.json so it survives app restarts.
 * Mirrors the CLI's handleToggleThinking persistence (App.tsx).
 */
async function persistThinkingLevel(
  settingsFile: string,
  level: ThinkingLevel | undefined,
): Promise<void> {
  try {
    const sm = new SettingsManager(settingsFile);
    await sm.load();
    await sm.set("thinkingEnabled", !!level);
    if (level) await sm.set("thinkingLevel", level);
  } catch (err) {
    captureSidecarError(err, "app-sidecar.settings.persist-thinking");
    log("WARN", "app-sidecar", "failed to persist thinking level", { err: String(err) });
  }
}

/** Validate a project folder name: lowercase letters, digits, dashes only. */
function isValidProjectName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

// ── History reconstruction types ──────────────────────────
// Mirrors HistoryEntry in gg-app/src/agent.ts — the wire shape the webview
// receives from GET /history. Fields beyond role/text carry the transcript
// item kinds that are reconstructed from persisted session data.
interface HistoryEntryForWire {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  hook?: "ideal" | "loop_break" | "regrounding" | null;
  command?: boolean;
  compacted?: boolean;
  /** Persisted counts for a compacted row's "N → M messages" summary. */
  compactionCounts?: { originalCount: number; newCount: number };
  /** True when this entry is a Ken Kai (mentor) turn: a `user` row is the `@Ken`
   *  question, an `assistant` row is Ken's reply. The webview renders these in
   *  Ken's color (user bubble tinted; assistant as a Ken bubble). */
  ken?: boolean;
  /** Present when this entry is a persisted autopilot verdict marker (an
   *  `assistant` row with empty `text`). The webview renders it exactly like
   *  the live `autopilot` item — never the raw verdict keyword the model
   *  actually replied with (e.g. `ALL_CLEAR`). */
  autopilot?: {
    phase: "prompted" | "done" | "human" | "capped" | "plan_approved";
    reason?: string;
    body?: string;
    /** Stable seed derived from persisted marker data for deterministic all-clear copy. */
    copySeed?: string;
  };
  /** True when this user prompt came from a Ken "Send to GG Coder" button —
   *  the webview renders the shimmering label instead of the prompt body. */
  kenSent?: boolean;
  /** Enhancer highlight segments for this user prompt (unedited enhanced sends). */
  enhancements?: unknown[];
  /** Plan-mode entry banner (ASCII logo + reason), persisted at plan_enter. */
  plan?: { reason: string };
  /** Task header row (task title), persisted at task_start. */
  task?: { title: string };
  /** Error row (headline/message/guidance), persisted by broadcastError.
   *  `scope` selects the live prefix (ken_error → "Ken: ", autopilot_error →
   *  "Autopilot: "). */
  error?: { scope: string; headline: string; message?: string; guidance?: string };
  /** Webview-copy info row marker (e.g. the video-capability warning). */
  infoKind?: "video_warning";
  toolImages?: Array<{ src: string; path?: string }>;
  subagentGroup?: Array<{
    agentName?: string;
    status: "done" | "error";
    toolUseCount: number;
  }>;
}

// ── Chat attachments (images / videos / files dropped into the input) ──────
// The webview sends base64 payloads; we persist each under .gg/uploads/ so the
// agent's tools can open files, then hand media to the model as native blocks.
interface AppAttachment {
  kind: "image" | "video" | "file";
  name: string;
  mediaType: string;
  /** base64 (no data: prefix). */
  data: string;
}

interface PreparedAttachment extends AppAttachment {
  path?: string;
}

async function prepareAttachments(
  cwd: string,
  attachments: AppAttachment[],
): Promise<PreparedAttachment[]> {
  const dir = path.join(cwd, ".gg", "uploads");
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const out: PreparedAttachment[] = [];
  for (const a of attachments) {
    // Sanitize the filename and prefix with a short timestamp to avoid clobber.
    const safe = a.name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
    const fileName = `${Date.now().toString(36)}-${safe}`;
    const filePath = path.join(dir, fileName);
    const buf = Buffer.from(a.data, "base64");
    // Validate and cap image attachments before they become native image content
    // blocks. Anthropic applies a 2000 px per-dimension cap once conversation
    // history contains more than 20 images, so every attachment must be safe for
    // later turns too. Keep the original on disk, but send the resized bytes.
    // Corrupt or unsupported images become plain files so they cannot reject the
    // entire provider request.
    let prepared: PreparedAttachment = { ...a };
    if (a.kind === "image") {
      try {
        const resized = await shrinkToFit(buf, a.mediaType);
        const validatedType = await validateVisionImage(resized.buffer);
        prepared = validatedType
          ? {
              ...a,
              mediaType: validatedType,
              data: resized.buffer.toString("base64"),
            }
          : { ...a, kind: "file" };
      } catch {
        prepared = { ...a, kind: "file" };
      }
    }
    try {
      await fs.writeFile(filePath, buf);
      out.push({ ...prepared, path: filePath });
    } catch {
      out.push({ ...prepared });
    }
  }
  return out;
}

// ── @-mention file search (chat-input file picker) ─────────────────────────
// Lists project files for the webview's `@` picker. Empty query → newest files
// by mtime; a query → fuzzy-ranked basename/path matches. Honors .gitignore and
// skips node_modules/.git so the picker mirrors the agent's `find` tool.
interface FileHit {
  /** Project-relative POSIX path, e.g. "src/App.tsx". */
  path: string;
  /** File name only, e.g. "App.tsx". */
  name: string;
}

const FILE_SEARCH_LIMIT = 20;

/** Score a candidate path against a lowercased query. Higher is better; a
 *  negative score means "no match". Basename hits beat path hits; prefix beats
 *  substring; shorter paths break ties. */
function scoreFile(relPath: string, name: string, query: string): number {
  const lcPath = relPath.toLowerCase();
  const lcName = name.toLowerCase();
  let score = -1;
  if (lcName === query) score = 1000;
  else if (lcName.startsWith(query)) score = 800;
  else if (lcName.includes(query)) score = 600;
  else if (lcPath.startsWith(query)) score = 400;
  else if (lcPath.includes(query)) score = 200;
  else if (subsequenceMatch(lcPath, query)) score = 100;
  if (score < 0) return -1;
  // Prefer shorter paths (closer to root, less nesting) on equal match class.
  return score - relPath.length * 0.1;
}

/** True when every char of `needle` appears in `haystack` in order (fuzzy). */
function subsequenceMatch(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

async function searchProjectFiles(cwd: string, rawQuery: string): Promise<FileHit[]> {
  const fg = await import("fast-glob");
  const ignore = await import("ignore");
  const query = rawQuery.trim().toLowerCase();

  let gitignore: string[] = [];
  try {
    const content = await fs.readFile(path.join(cwd, ".gitignore"), "utf-8");
    gitignore = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    // No .gitignore — nothing extra to ignore.
  }
  const ig = ignore.default().add(gitignore);

  // `stats: true` gives mtime without a second stat pass, so the empty-query
  // "recent files" path is a single walk.
  const entries = await fg.default("**/*", {
    cwd,
    dot: false,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/.gg/**"],
    suppressErrors: true,
    followSymbolicLinks: false,
    stats: true,
  });
  const files = entries.filter((e) => !ig.ignores(e.path));

  if (!query) {
    return files
      .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
      .slice(0, FILE_SEARCH_LIMIT)
      .map((e) => ({ path: e.path, name: path.posix.basename(e.path) }));
  }

  const scored: { hit: FileHit; score: number }[] = [];
  for (const e of files) {
    const name = path.posix.basename(e.path);
    const score = scoreFile(e.path, name, query);
    if (score >= 0) scored.push({ hit: { path: e.path, name }, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, FILE_SEARCH_LIMIT).map((s) => s.hit);
}

/**
 * Detect whether a restored user message is actually an injected self-correction
 * hook prompt, by its distinctive opening phrase. Returns the hook kind so the
 * webview can render the short notice line instead of the full prompt body.
 */
function detectHookKind(text: string): "ideal" | "loop_break" | "regrounding" | null {
  const t = text.trimStart();
  if (t.startsWith("Ideal? Review the actual work")) return "ideal";
  if (t.startsWith("Stuck? You've repeated essentially")) return "loop_break";
  if (t.startsWith("Re-ground. The conversation was just compacted")) return "regrounding";
  return null;
}

// Separator AgentSession.prompt() inserts between a command's prompt body and
// the user's trailing args. Must stay in sync with the expansion there.
const COMMAND_ARGS_SEP = "\n\n## User Instructions\n\n";

/**
 * Reverse a prompt-template command's expansion. When a `/name` command runs,
 * the agent persists the FULL expanded prompt body as the user message — so on
 * resume the raw body would render instead of the short `/name` chip the user
 * saw live. Given the candidate commands (built-in + custom) and a restored
 * message body, recover the original `/name [args]` invocation. Returns null
 * when the text isn't a known command body (an ordinary user message).
 */
function detectPromptCommand(
  text: string,
  candidates: ReadonlyArray<{ name: string; prompt: string }>,
): string | null {
  for (const c of candidates) {
    if (!c.prompt) continue;
    if (text === c.prompt) return `/${c.name}`;
    if (text.startsWith(c.prompt + COMMAND_ARGS_SEP)) {
      const args = text.slice(c.prompt.length + COMMAND_ARGS_SEP.length).trim();
      return args ? `/${c.name} ${args}` : `/${c.name}`;
    }
  }
  return null;
}

// ── MCP server management (mirrors `ggcoder mcp`) ───────────────────────────
// The webview's MCP modal lists configured servers with live connection status,
// adds them via the same paste-a-`claude mcp add …` grammar, and removes them.
// All persistence + connection logic lives in core/mcp (single source of truth);
// these helpers only shape it for the wire.

/** One wire row for the MCP list: a server config joined with its live status. */
interface McpWireRow {
  name: string;
  scope: MCPScope;
  ok: boolean;
  toolCount: number;
  error?: string;
  kind: "stdio" | "http";
  summary: string;
  /** True when the server needs an interactive OAuth login before it connects. */
  requiresAuth?: boolean;
}

/** A short transport summary for display (URL for http/sse, command+args for stdio). */
function mcpRowSummary(config: MCPServerConfig): string {
  if (config.url) return config.url;
  return [config.command, ...(config.args ?? [])].filter(Boolean).join(" ");
}

/** Load + connect every server, returning one wire row per server. Mirrors the
 *  CLI dashboard's buildRows (connectAllDetailed, then dispose). Empty list
 *  short-circuits before spawning any stdio process / opening any HTTP conn. */
async function buildMcpRows(cwd: string): Promise<McpWireRow[]> {
  const scoped = await loadServers(cwd);
  if (scoped.length === 0) return [];

  const manager = new MCPClientManager();
  try {
    const results = await manager.connectAllDetailed(scoped.map((s) => s.config));
    return scoped.map((s): McpWireRow => {
      const result = results.find((r) => r.name === s.config.name);
      return {
        name: s.config.name,
        scope: s.scope,
        ok: result?.ok ?? false,
        toolCount: result?.toolCount ?? 0,
        error: result?.error,
        kind: s.config.url ? "http" : "stdio",
        summary: mcpRowSummary(s.config),
        requiresAuth: result?.requiresAuth,
      };
    });
  } finally {
    await manager.dispose();
  }
}

/** Probe a single server's connection before persisting it. Never throws — a
 *  failed probe returns ok:false with a human-readable error so the config can
 *  still be saved. Mirrors the CLI's probeServer. */
async function probeMcp(
  config: MCPServerConfig,
): Promise<{ ok: boolean; toolCount: number; error?: string; requiresAuth?: boolean }> {
  const manager = new MCPClientManager();
  try {
    const result = await manager.probe(config);
    return {
      ok: result.ok,
      toolCount: result.toolCount,
      error: result.error,
      requiresAuth: result.requiresAuth,
    };
  } finally {
    await manager.dispose();
  }
}

interface SseClient {
  id: number;
  res: http.ServerResponse;
}

/**
 * Sub-agents spawn the ggcoder CLI in JSON mode to run a delegated task. In the
 * packaged desktop app the only runnable entry is THIS bundle (there's no
 * sibling `cli.js`), so the subagent tool ends up spawning the sidecar itself.
 * Without this guard that would boot a second HTTP server, emit no NDJSON, and
 * hang until the 10-minute hard timeout. So when invoked with `--json`, behave
 * exactly like `ggcoder --json …`: stream the sub-agent run as NDJSON and exit,
 * never starting the HTTP/SSE server. Mirrors the `values.json` branch in cli.ts.
 */
async function runJsonModeIfRequested(): Promise<boolean> {
  if (!process.argv.includes("--json")) return false;
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "boolean" },
      provider: { type: "string" },
      model: { type: "string" },
      "max-turns": { type: "string" },
      "system-prompt": { type: "string" },
      tools: { type: "string" },
      "prompt-cache-key": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const maxTurnsRaw = values["max-turns"];
  // Optional tool allow-list forwarded by the subagent spawner from an agent
  // definition's `tools:` frontmatter. Mirrors the identical parsing in
  // cli.ts's `values.json` branch — keep both in sync (see subagent.ts).
  const parsedTools = values.tools
    ? values.tools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const allowedTools = parsedTools.length > 0 ? parsedTools : undefined;
  await runJsonMode({
    message: positionals[0] ?? "",
    provider: (values.provider ?? "anthropic") as Provider,
    model: values.model ?? "claude-opus-4-8",
    cwd: process.cwd(),
    systemPrompt: values["system-prompt"],
    maxTurns: maxTurnsRaw ? parseInt(maxTurnsRaw, 10) : undefined,
    allowedTools,
    promptCacheKey: values["prompt-cache-key"],
  }).catch(async (err: unknown) => {
    captureSidecarError(err, "app-sidecar.json-mode", {
      provider: String(values.provider ?? "anthropic"),
    });
    await flushSidecarErrors();
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    process.exit(1);
  });
  return true;
}

// ── Daemon-level HTTP helpers (shared by the session-management routes) ─────
// The per-session route table has its own local copies; these serve the
// daemon's own POST /session / DELETE /session routes.
function daemonReadBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function daemonJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  // Hidden persistent-worker dispatch must win before strict JSON/server parsing.
  if (process.argv.includes("--subagent-worker")) {
    await runSubagentWorkerMode();
    return;
  }
  // Sub-agent JSON-mode dispatch must win before any sidecar/server setup.
  if (await runJsonModeIfRequested()) return;

  // Default to an ephemeral port (0) so concurrent/orphaned instances never
  // collide on a fixed port. The actual port is reported via the
  // GG_APP_LISTENING handshake and consumed by the shell.
  const port = Number(process.env.GG_APP_PORT ?? 0);
  const host = "127.0.0.1";

  const paths = await ensureAppDirs();
  // Own log file so the app sidecar never clobbers the interactive CLI's
  // ~/.gg/debug.log (initLogger truncates on each start).
  const sidecarLog = path.join(paths.agentDir, "gg-app-sidecar.log");
  initLogger(sidecarLog);

  // Global last-resort guards, installed as early as the logger allows so they
  // cover the WHOLE lifecycle — including startup/initialize, the phase the
  // "sidecar did not start in time" bug lives in. The sidecar is a long-lived
  // HTTP server the Rust shell can respawn: a stray rejection or thrown error
  // from one request (e.g. an MCP probe spawning a misbehaving child) must not
  // tear down the whole process and strand the window on its next call. Log and
  // keep serving (mirrors astro/vscode/gstack long-lived-server handlers).
  process.on("unhandledRejection", (reason) => {
    log("ERROR", "app-sidecar", "unhandledRejection", {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
  process.on("uncaughtException", (err) => {
    log("ERROR", "app-sidecar", "uncaughtException", {
      message: err.message,
      stack: err.stack,
    });
  });

  // The packaged desktop app launches from Finder/Dock with a minimal PATH that
  // omits Homebrew/Cargo/version-manager dirs, so the agent can't find node,
  // git, python, rg, etc. Enrich process.env.PATH from the login shell once,
  // before anything spawns (bash tool, background tasks, LSP, git helpers all
  // inherit it). Best-effort — never blocks startup beyond its internal cap.
  await enrichProcessPath();

  // Sweep recoverable full tool outputs (~/.gg/tool-output/) older than 48h.
  // Fire-and-forget: cleanup must never delay or break startup.
  void cleanupToolOutputs().catch(() => {});

  const auth = new AuthStorage(paths.authFile);
  await auth.load();

  // Every window's session lives here as an in-process object, keyed by the id
  // the daemon hands back from POST /session. The Rust shell routes each proxy
  // request to its window's session via the `x-gg-session` header (and the
  // `?session=` query for the SSE /events stream).
  const sessions = new Map<string, SessionContext>();
  const memoryStore = new MemoryStore({
    onChange: ({ memories }) => {
      for (const ctx of sessions.values()) {
        ctx.broadcast("memory_change", { count: memories.length });
      }
    },
  });
  const jiwaStore = new JiwaStore({
    onChange: ({ jiwa }) => {
      for (const ctx of sessions.values()) {
        ctx.broadcast("jiwa_change", { count: jiwa.length });
      }
    },
  });

  // XP/rank progress — loaded once per daemon; awards fan out to every window.
  // Each frame is tagged `origin: true` only for the session that earned the
  // XP, so that window alone plays sounds/chips while the rest just re-render.
  const progress = await createProgressManager(paths.agentDir, (snapshot, originId) => {
    for (const ctx of sessions.values())
      ctx.broadcast("progress", { ...snapshot, origin: ctx.id === originId });
  });

  type UsageResult =
    | (SubscriptionUsageSnapshot & { connected: true; error?: never })
    | {
        provider: SubscriptionUsageProvider;
        displayName: string;
        connected: boolean;
        windows: [];
        fetchedAt: number;
        error?: string;
      };
  const usageCache = new Map<
    SubscriptionUsageProvider,
    { expiresAt: number; result: UsageResult }
  >();
  const usageRequests = new Map<SubscriptionUsageProvider, Promise<UsageResult>>();
  // 429 backoff: when the provider rate-limits the usage endpoint, hold the
  // error result until this timestamp instead of re-polling (and re-logging a
  // WARN) every 60s — the old cadence hammered a limited endpoint for hours.
  const usageRateLimitedUntil = new Map<SubscriptionUsageProvider, number>();
  const USAGE_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

  async function fetchUsageProvider(provider: SubscriptionUsageProvider): Promise<UsageResult> {
    const displayName = provider === "anthropic" ? "Anthropic" : "Codex";
    if (!(await auth.hasProviderAuth(provider))) {
      return { provider, displayName, connected: false, windows: [], fetchedAt: Date.now() };
    }
    try {
      let credentials = await auth.resolveCredentials(provider);
      try {
        const snapshot = {
          ...(await fetchSubscriptionUsage(provider, credentials)),
          connected: true as const,
        };
        usageRateLimitedUntil.delete(provider);
        return snapshot;
      } catch (error) {
        // A provider can revoke an access token before its stored expiry. Refresh
        // once on 401, matching inference auth recovery, then retry the usage call.
        if (error instanceof SubscriptionUsageError && error.status === 401) {
          credentials = await auth.resolveCredentials(provider, { forceRefresh: true });
          const snapshot = {
            ...(await fetchSubscriptionUsage(provider, credentials)),
            connected: true as const,
          };
          usageRateLimitedUntil.delete(provider);
          return snapshot;
        }
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (shouldCaptureUsagePollingError(error)) {
        captureSidecarError(error, "app-sidecar.usage.fetch", { provider });
      }
      log("WARN", "app-sidecar", "subscription usage fetch failed", { provider, message });
      if (error instanceof SubscriptionUsageError && error.status === 429) {
        usageRateLimitedUntil.set(provider, Date.now() + USAGE_RATE_LIMIT_BACKOFF_MS);
      }
      const connected = await auth.hasProviderAuth(provider);
      return {
        provider,
        displayName,
        connected,
        windows: [],
        fetchedAt: Date.now(),
        error: connected ? "Usage is temporarily unavailable." : undefined,
      };
    }
  }

  async function subscriptionUsage(provider: SubscriptionUsageProvider): Promise<UsageResult> {
    const cached = usageCache.get(provider);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    const inFlight = usageRequests.get(provider);
    if (inFlight) return inFlight;
    const request = fetchUsageProvider(provider);
    usageRequests.set(provider, request);
    try {
      const result = await request;
      // Anthropic can return utilization before it assigns reset timestamps
      // (notably before the account's first active request). Retry that partial
      // snapshot quickly; complete snapshots keep the normal one-minute cache.
      const missingReset =
        result.connected &&
        result.windows.length > 0 &&
        result.windows.some((window) => window.resetsAt === undefined);
      const rateLimitedUntil = usageRateLimitedUntil.get(provider) ?? 0;
      usageCache.set(provider, {
        result,
        expiresAt:
          rateLimitedUntil > Date.now()
            ? rateLimitedUntil
            : Date.now() + (missingReset ? 10_000 : 60_000),
      });
      return result;
    } finally {
      if (usageRequests.get(provider) === request) usageRequests.delete(provider);
    }
  }

  /** Resolve the target session id: the `x-gg-session` header, else a
   *  `?session=` query param (used by the SSE /events connection). */
  function sessionIdFromReq(req: http.IncomingMessage, url: string): string | null {
    const header = req.headers["x-gg-session"];
    if (typeof header === "string" && header.length > 0) return header;
    try {
      return new URL(url, `http://${host}`).searchParams.get("session");
    } catch {
      return null;
    }
  }

  const server = http.createServer(
    wrapSidecarHandler((req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      // CORS preflight — the webview origin differs from 127.0.0.1.
      if (method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "content-type, x-gg-session",
        });
        res.end();
        return;
      }

      // ── Daemon-level routes (session lifecycle) ──────────────────────────
      // Create a session for a window: { mode?, cwd, sessionPath? } → { sessionId }.
      if (method === "POST" && url === "/session") {
        void daemonReadBody(req).then(async (raw) => {
          let body: { mode?: unknown; chatAgent?: unknown; cwd?: unknown; sessionPath?: unknown } =
            {};
          try {
            body = raw ? (JSON.parse(raw) as typeof body) : {};
          } catch {
            /* empty/invalid body → defaults below */
          }
          const mode: WorkspaceMode = body.mode === "chat" ? "chat" : "code";
          const chatAgent = parseChatAgentId(body.chatAgent);
          const sessionCwd =
            typeof body.cwd === "string" && body.cwd
              ? body.cwd
              : (process.env.GG_APP_CWD ?? process.cwd());
          const sessionPath =
            typeof body.sessionPath === "string" && body.sessionPath ? body.sessionPath : undefined;
          const id = randomUUID();
          try {
            const ctx = await createSession(
              { auth, paths, progress, memoryStore, jiwaStore },
              { id, mode, chatAgent, cwd: sessionCwd, sessionPath },
            );
            sessions.set(id, ctx);
            log("INFO", "app-sidecar", "session created", {
              id,
              mode,
              chatAgent,
              cwd: sessionCwd,
            });
            daemonJson(res, 200, { sessionId: id });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            captureSidecarError(err, "app-sidecar.session.create");
            log("ERROR", "app-sidecar", "session create failed", { message });
            daemonJson(res, 500, { error: message });
          }
        });
        return;
      }

      // Dispose a session: DELETE /session/:id.
      if (method === "DELETE" && url.startsWith("/session/")) {
        const id = decodeURIComponent(url.slice("/session/".length));
        const ctx = sessions.get(id);
        if (ctx) {
          sessions.delete(id);
          void ctx.dispose().catch(() => {});
          log("INFO", "app-sidecar", "session disposed", { id });
        }
        daemonJson(res, 200, { ok: true });
        return;
      }

      // Progress is daemon-level so the Home screen can paint before a project
      // session exists; per-session callers still work through the same endpoint.
      if (method === "GET" && url === "/progress") {
        daemonJson(res, 200, progress.snapshot());
        return;
      }

      // Subscription quota is account-wide, not project/session-specific. OAuth
      // tokens stay in this daemon; only the active provider's normalized snapshot
      // reaches the webview.
      if (method === "GET" && (url === "/usage" || url.startsWith("/usage?"))) {
        void (async () => {
          const provider = new URL(url, `http://${host}`).searchParams.get("provider");
          if (provider !== "anthropic" && provider !== "openai") {
            daemonJson(res, 400, { error: "unsupported usage provider" });
            return;
          }
          daemonJson(res, 200, await subscriptionUsage(provider));
        })().catch((error) => {
          captureSidecarError(error, "app-sidecar.usage.request");
          log("ERROR", "app-sidecar", "subscription usage request failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          daemonJson(res, 500, { error: "Usage is temporarily unavailable." });
        });
        return;
      }

      // ── Per-session delegation ───────────────────────────────────────────
      const id = sessionIdFromReq(req, url);
      const ctx = id ? sessions.get(id) : undefined;
      if (!ctx) {
        daemonJson(res, 404, { error: "unknown session" });
        return;
      }
      ctx.handle(req, res, url, method);
    }, "app-sidecar.http"),
  );
  server.listen(port, host, () => {
    const addr = server.address() as AddressInfo;
    // The Rust shell reads this line to learn the daemon port.
    process.stdout.write(`GG_APP_LISTENING ${addr.port}\n`);
    log("INFO", "app-sidecar", "daemon listening", { port: String(addr.port), host });
  });

  const shellPid = process.ppid;
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(parentWatch);
    // Radio playback is app-wide (one stream across all windows), so it stops
    // at the daemon level, not per session.
    stopRadio();
    await Promise.all([...sessions.values()].map((c) => c.dispose().catch(() => {})));
    server.close();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.once("exit", stopRadio);

  // Tauri can disappear without delivering a signal (force-quit, dev runner
  // teardown, crash). Detect reparenting or a dead shell so the daemon and its
  // radio player do not survive as audible orphans.
  const parentWatch = setInterval(() => {
    let parentAlive = process.ppid === shellPid;
    if (parentAlive && shellPid > 1) {
      try {
        process.kill(shellPid, 0);
      } catch (error) {
        parentAlive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    if (!parentAlive) void shutdown();
  }, 1_000);
  parentWatch.unref?.();
}

/** Ken's read-only tool allow-list. Excludes every mutating tool (write/edit/
 *  bash/tasks/subagent/generate_image/enter_plan/exit_plan/task_*) so the mentor
 *  agent can research + see, but never change the repo. */
const KEN_ALLOWED_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "source_path",
  "web_fetch",
  "web_search",
  "screenshot",
];

/** MCP servers Ken is allowed to use. kencode-search lets him look into real
 *  public repos / verify against actual code instead of assuming — core to how
 *  he's meant to work. Read-only research; no other MCP server is connected. */
const KEN_ALLOWED_MCP_SERVERS = ["kencode-search"];

/** Extract the plain text of the most recent assistant message (Ken's reply).
 *  Strips tool-call / image blocks, returning just the prose Ken streamed. */
function lastAssistantText(messages: ReturnType<AgentSession["getMessages"]>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    return m.content
      .map((c) => (c.type === "text" && "text" in c && typeof c.text === "string" ? c.text : ""))
      .join("");
  }
  return "";
}

/**
 * Assemble Ken's context digest for one `@Ken` question: git/env + the build
 * session's compaction summary + recent activity. Prepended to the user's
 * question as Ken's prompt body each turn. Project docs (CLAUDE.md/AGENTS.md)
 * are NOT here — they're folded into Ken's cached system prompt once per
 * session instead (see ken-prompt.ts), so they hit the provider prompt cache
 * instead of being re-sent uncached on every question. Workflow commands +
 * autopilot-injected prompts are passed through so the digest labels them as
 * what they are instead of user-authored asks.
 */
function buildKenContext(
  buildSession: AgentSession,
  cwd: string,
  gitBranch: string | null,
  question: string,
  workflowCommands: readonly WorkflowCommandSpec[],
  injectedPrompts: readonly string[],
): string {
  return buildKenDigest({
    question,
    cwd,
    gitBranch,
    messages: buildSession.getMessages(),
    workflowCommands,
    injectedPrompts,
  });
}

// ── Progress ("Ranks") ──────────────────────────────────────────────────
// Daemon-level XP/rank manager: one durable file (~/.gg/progress.json), awards
// applied under a file lock, snapshots broadcast to EVERY session's SSE clients,
// and an fs.watch on ~/.gg so writes from OTHER daemon processes (dev + packaged
// app side by side) re-broadcast here too — deduped by the lastEvent nonce.
// XP failures are debug-log-only; progress must never break a run.

interface ProgressManager {
  /** Current snapshot for GET /progress + the SSE ready path. */
  snapshot: () => ProgressSnapshot;
  /** Award XP for one successfully completed run (prompt + any new commits). */
  awardRun: (cwd: string, runStartedAt: number, originId?: string) => Promise<void>;
}

async function createProgressManager(
  agentDir: string,
  broadcastAll: (snapshot: ProgressSnapshot, originId?: string) => void,
): Promise<ProgressManager> {
  // Boot: recovery chain main → backup → coding + chat session rebuild → empty.
  const coderSessionsDir = path.join(agentDir, "sessions");
  let file: ProgressFile = await loadProgress({
    rebuild: () =>
      rebuildFromSessions([
        coderSessionsDir,
        ...CHAT_AGENT_IDS.map((agentId) => chatAgentSessionsDir(coderSessionsDir, agentId)),
      ]),
  });
  // Don't re-celebrate an old levelUp event on boot.
  let lastSeenNonce: string | null = file.lastEvent?.nonce ?? null;
  log("INFO", "app-sidecar", "progress loaded", {
    xp: String(file.xp),
    level: String(levelForXp(file.xp)),
  });

  function snapshot(): ProgressSnapshot {
    return buildSnapshot(file);
  }

  async function awardRun(cwd: string, runStartedAt: number, originId?: string): Promise<void> {
    try {
      const now = Date.now();
      const updated = await updateProgress(async (f) => {
        const levelBefore = levelForXp(f.xp);
        awardPrompt(f, now, cwd);

        // Commit XP: probe repo root + HEAD, then score lastHead..HEAD bounded
        // by the run window. First sight of a repo records HEAD, scores nothing.
        const probe = await detectNewCommits(cwd, undefined, runStartedAt);
        if (probe) {
          const key = repoKey(probe.repoRoot);
          const lastHead = f.repos[key]?.lastHead;
          if (lastHead && lastHead !== probe.head) {
            const detected = await detectNewCommits(cwd, lastHead, runStartedAt);
            if (detected && detected.commits.length > 0) {
              awardCommits(f, detected.commits, now, cwd);
            }
          }
          f.repos[key] = { lastHead: probe.head };
        }

        // One combined lastEvent per run so other windows celebrate exactly once.
        const levelAfter = levelForXp(f.xp);
        const levelUp =
          levelAfter > levelBefore
            ? { from: levelBefore, to: levelAfter, rankName: rankForLevel(levelAfter).name }
            : null;
        f.lastEvent = { nonce: randomUUID(), levelUp };
        return { file: f, levelledUp: levelUp !== null };
      });
      file = updated;
      lastSeenNonce = updated.lastEvent?.nonce ?? null;
      broadcastAll(buildSnapshot(updated), originId);
    } catch (err) {
      captureSidecarError(err, "app-sidecar.progress.award");
      log("DEBUG", "app-sidecar", "progress award failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Watch ~/.gg (dir watch survives the atomic tmp+rename) for progress.json
  // writes from other daemon processes; debounce, reload read-only, dedupe by nonce.
  let watchDebounce: NodeJS.Timeout | null = null;
  try {
    const watcher = fsWatch(agentDir, (_event, filename) => {
      if (filename !== "progress.json") return;
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        void (async () => {
          const reloaded = await peekProgress();
          if (!reloaded) return;
          const nonce = reloaded.lastEvent?.nonce ?? null;
          if (nonce === lastSeenNonce) return;
          file = reloaded;
          lastSeenNonce = nonce;
          broadcastAll(buildSnapshot(reloaded));
        })();
      }, 150);
    });
    watcher.unref();
  } catch (err) {
    captureSidecarError(err, "app-sidecar.progress.watch");
    log("DEBUG", "app-sidecar", "progress watch unavailable", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return { snapshot, awardRun };
}

type WorkspaceMode = "code" | "chat";

interface SessionContext {
  id: string;
  mode: WorkspaceMode;
  chatAgent: ChatAgentId;
  cwd: string;
  sessionPath?: string;
  session: AgentSession;
  clients: Set<SseClient>;
  broadcast: (type: string, data: unknown) => void;
  /** Handle one HTTP request for this session. Owns its own 404 fallthrough. */
  handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ) => void;
  dispose: () => Promise<void>;
}

/**
 * Build one in-process agent session: its AgentSession, SSE client set, event
 * bridge, task runner, auth/login bridge, and the full HTTP route table exposed
 * as a `handle()` method. Many of these live inside one daemon process, fully
 * isolated (separate AgentSession, cwd, history, model) — only the HTTP server,
 * logger, PATH, shared auth file, and radio live at the daemon level.
 */
async function createSession(
  deps: {
    auth: AuthStorage;
    paths: Awaited<ReturnType<typeof ensureAppDirs>>;
    progress: ProgressManager;
    memoryStore: MemoryStore;
    jiwaStore: JiwaStore;
  },
  opts: {
    id: string;
    mode: WorkspaceMode;
    chatAgent: ChatAgentId;
    cwd: string;
    sessionPath?: string;
  },
): Promise<SessionContext> {
  const { auth, progress, memoryStore, jiwaStore } = deps;
  const paths = deps.paths;
  const mode = opts.mode;
  let chatAgent = opts.chatAgent;
  const cwd = opts.cwd;
  // Base host for parsing request-URL query params (value is irrelevant to
  // parsing); the daemon owns the real listen host.
  const host = "127.0.0.1";

  const saved = loadSavedSettings(paths.settingsFile);
  // Native login/logout and other live sessions share auth.json. Refresh the
  // daemon-level snapshot before choosing this session's provider so a project
  // never boots against credentials that were just replaced or disconnected.
  await auth.load();
  // Per-project model/thinking prefs win over the shared global settings.json:
  // each window (one project cwd) restores its own selection instead of every
  // window reading the same single global slot that the last writer clobbered
  // (the old bug — switching models in one window reset every other window).
  const projectPrefs = await loadProjectModelPrefs(cwd);
  const preferred: Provider = projectPrefs?.provider ?? saved.provider ?? "anthropic";
  const savedModel = projectPrefs?.model ?? saved.model;
  // Boot-tolerant: when no provider is configured this returns a logged-out
  // fallback instead of throwing, so the sidecar still listens and the login
  // endpoints are reachable for a fresh user (throwing here used to kill the
  // sidecar before server.listen, making first-time login impossible).
  const { provider, model, loggedIn } = await resolveStartOrFallback(
    auth,
    ALL_PROVIDERS,
    preferred,
    savedModel,
  );
  if (!loggedIn) {
    log("WARN", "app-sidecar", "no provider configured — booting logged-out for login", {
      fallbackProvider: provider,
    });
  }

  // Per-project thinking prefs win over the global settings.json fallback.
  // With no saved level, the default follows the active credential's endpoint:
  // Kimi K3 on the OAuth coding endpoint starts at its declared default (high),
  // matching the official kimi-code CLI's plan-usage profile.
  const thinkEnabled = projectPrefs?.thinkingEnabled ?? saved.thinkingEnabled;
  const thinkingLevel: ThinkingLevel | undefined = thinkEnabled
    ? (projectPrefs?.thinkingLevel ??
      saved.thinkingLevel ??
      getDefaultThinkingLevel(model, { baseUrl: auth.getStoredBaseUrl(provider) }))
    : undefined;

  // ── SSE fan-out (declared before the session so plan callbacks can use it) ─
  const clients = new Set<SseClient>();
  let clientSeq = 0;

  function broadcast(type: string, data: unknown): void {
    const safePayload = redactValue({ type, data }, { secrets: environmentSecrets(process.env) });
    const frame = `data: ${JSON.stringify(safePayload)}\n\n`;
    for (const c of clients) c.res.write(frame);
  }

  // Replace CLI-specific guidance (slash commands, CLI tool names) with
  // desktop-app equivalents so the webview never shows "run ggcoder login".
  // Applied to BOTH the message and guidance fields — the auth "Not logged in…
  // Run "ggcoder login"" string lives in `message`, not `guidance`.
  function desktopGuidance(guidance: string): string {
    return (
      guidance
        // Auth: `Run "ggcoder login"` / `Run 'ggcoder login'` / `Run `ggcoder login``
        // (any quote style, or none) → button. Do this first so the whole phrase
        // is rewritten cleanly instead of leaving a dangling `Run "…"`.
        .replaceAll(/Run ["'`]?ggcoder login["'`]?/gi, "Use the Login to AI Providers button")
        // Any remaining bare mention.
        .replaceAll(/ggcoder login/gi, "the Login to AI Providers button")
        // /compact: the app has NO manual compact command or button — it only
        // auto-compacts (and now auto-recovers on overflow). If this guidance is
        // reached, auto-compaction already couldn't reduce enough, so the only
        // real affordance is a fresh session. Don't tell the user to run a
        // command that doesn't exist in the app.
        .replaceAll(
          /Run \/compact to shrink history, or start a new session\./gi,
          "Start a new session to reset the context.",
        )
        // /model: handle each phrasing pattern
        .replaceAll(
          /switch to claude-fable-5 with \/model/gi,
          "switch to claude-fable-5 using the model selector",
        )
        .replaceAll(/Switch with \/model\./gi, "Switch using the model selector.")
        .replaceAll(
          /try a different model with \/model\./gi,
          "try a different model using the model selector.",
        )
        .replaceAll(/Use \/model to switch/gi, "Use the model selector to switch")
        // /help
        .replaceAll(/see \/help/gi, "check the help menu")
    );
  }

  // Turn any thrown value into the same clear headline/message/guidance shape
  // the TUI shows (see gg-ai's formatError) instead of a bare `err.message`, log
  // the full detail, and broadcast it under `type` ("error" or "ken_error").
  // Without this the webview only ever saw a raw provider string like
  // `400 {"code":"400",...}` with no "is this me or them / when does it reset"
  // context that the CLI has always given.
  function broadcastError(
    type: "error" | "ken_error" | "autopilot_error",
    logLabel: string,
    err: unknown,
  ): void {
    const f = formatError(err);
    const message = f.message ? desktopGuidance(f.message) : undefined;
    const guidance = desktopGuidance(f.guidance);
    captureSidecarError(err, `app-sidecar.${logLabel.replaceAll(" ", "-")}`, {
      scope: type,
      ...(f.provider ? { provider: f.provider } : {}),
      ...(f.statusCode != null ? { status: String(f.statusCode) } : {}),
    });
    log("ERROR", "app-sidecar", logLabel, {
      headline: f.headline,
      source: f.source,
      ...(message ? { message } : {}),
      ...(f.provider ? { provider: f.provider } : {}),
      ...(f.statusCode != null ? { statusCode: String(f.statusCode) } : {}),
      ...(f.requestId ? { requestId: f.requestId } : {}),
    });
    broadcast(type, {
      headline: f.headline,
      ...(message ? { message } : {}),
      guidance,
      ...(f.provider ? { provider: f.provider } : {}),
      ...(f.statusCode != null ? { statusCode: f.statusCode } : {}),
      ...(f.resetsAt != null ? { resetsAt: f.resetsAt } : {}),
    });
    // Persist the error row (display-only marker) so a resumed session shows
    // the same headline/message/guidance the live run did. Best-effort.
    void session
      .persistAppMarker("error", {
        scope: type,
        headline: f.headline,
        ...(message ? { message } : {}),
        guidance,
      })
      .catch(() => {});
  }

  // The session file path to resume (passed by the daemon's POST /session);
  // empty/unset starts a fresh session.
  const resumeSessionPath = opts.sessionPath;

  let abort = new AbortController();
  const baseSessionOptions = {
    provider,
    model,
    cwd,
    thinkingLevel,
    sessionId: resumeSessionPath,
    signal: abort.signal,
    // Keep MCP startup off the readiness path in both modes.
    backgroundMcpConnect: true,
    // Keep restore-time auto-compaction off the readiness path too: its summary
    // LLM call (30s timeout) used to freeze waitForReady — and with it the whole
    // window (project picker, session list) — whenever a resumed session was
    // over the context threshold. First prompt compacts instead, with UI events.
    deferLoadCompaction: true,
  };
  let session!: AgentSession;
  if (mode === "chat") {
    session = createChatAgent(chatAgent, {
      ...baseSessionOptions,
      sessionsDir: paths.sessionsDir,
      additionalTools: [...buildMemoryTools(memoryStore), ...buildJiwaTools(jiwaStore)],
      getSystemPromptTail: () =>
        `${memoryStore.renderForPrompt()}\n\n${jiwaStore.renderForPrompt()}`,
      onAgentChange: async (nextAgent) => {
        chatAgent = nextAgent;
        broadcast("chat_agent_change", { chatAgent: nextAgent });
        await session.persistAppMarker("agent_handoff", { chatAgent: nextAgent }).catch((error) => {
          captureSidecarError(error, "app-sidecar.chat-agent.persist-handoff");
          log("WARN", "app-sidecar", "agent handoff marker persist failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      },
    });
  } else {
    session = new AgentSession({
      ...baseSessionOptions,
      // Plan mode belongs only to the coding agent.
      onEnterPlan: async (reason) => {
        deactivateApprovedPlan();
        await session.setPlanMode(true);
        broadcast("plan_progress", { total: 0, completed: [] });
        broadcast("plan_enter", { reason: reason ?? "" });
        void session.persistAppMarker("plan", { reason: reason ?? "" }).catch(() => {});
      },
      onExitPlan: async (planPath: string) => {
        await session.setPlanMode(false);
        let content: string;
        try {
          content = await fs.readFile(planPath, "utf-8");
        } catch {
          content = "";
        }
        setPendingPlan(planPath, content);
        broadcast("plan_exit", { planPath, content });
        return "Plan submitted for user review. Wait for the user to approve, reject, or dismiss it before implementing.";
      },
    });
  }
  await session.initialize();
  if (mode === "chat") {
    const restoredAgent = [...session.getAppMarkers()]
      .reverse()
      .find((marker) => marker.kind === "agent_handoff")?.data.chatAgent;
    if (typeof restoredAgent === "string") {
      chatAgent = parseChatAgentId(restoredAgent);
      await switchChatAgent(session, chatAgent, false);
    }
  }
  log("INFO", "app-sidecar", "session ready", { provider, model, mode, chatAgent, cwd });

  // Workspace extras (context window, git status, background tasks). Git state
  // is resolved once at startup and refreshed after every run; the context
  // window follows the active model.
  const [initialGitBranch, initialGitIsRepo, initialDirtyFileCount] = await Promise.all([
    getGitBranch(cwd).catch(() => null),
    isGitRepo(cwd).catch(() => false),
    getGitDirtyFileCount(cwd).catch(() => 0),
  ]);
  let gitBranch: string | null = initialGitBranch;
  let gitIsRepo: boolean = initialGitIsRepo;
  let gitDirtyFileCount = initialDirtyFileCount;
  function currentContextWindow(): number {
    const st = session.getState();
    return getContextWindow(st.model, { provider: st.provider, accountId: st.accountId });
  }
  // Shared shape merged into /state + the SSE `ready` frame so the footer can
  // render context %, branch, and tasks immediately on connect.
  function footerExtras(): {
    contextWindow: number;
    gitBranch: string | null;
    isGitRepo: boolean;
    gitDirtyFileCount: number;
    tasks: ReturnType<typeof session.listBackgroundProcesses>;
  } {
    return {
      contextWindow: currentContextWindow(),
      gitBranch,
      isGitRepo: gitIsRepo,
      gitDirtyFileCount,
      tasks: session.listBackgroundProcesses(),
    };
  }

  // tool_call_end carries no tool name (only the id), so remember each call's
  // name from tool_call_start to log a useful line on completion. Mirrors the
  // CLI's logging so the app sidecar's ~/.gg/gg-app-sidecar.log records tool
  // failures (e.g. repeated invalid-argument errors) instead of leaving the
  // fatal-abort path with no forensic trail.
  const toolCallNames = new Map<string, string>();

  // Approved-plan progress belongs beside the plan file, not in the webview.
  // The implementation can rewrite/expand that file mid-run, so a step count
  // frozen at approval time becomes dishonest (the exact stale-total bug the
  // CLI already fixed). Re-read the live file after tools/markers, retain the
  // last valid step section during transient edits, and send one authoritative
  // snapshot to the app.
  let approvedPlanPath: string | null = null;
  let approvedPlanTotal = 0;
  let approvedPlanMarkers = new Set<number>();
  let approvedPlanGeneration = 0;
  let planMarkerTail = "";
  let planProgressSync: Promise<boolean> = Promise.resolve(false);

  function planProgressPayload(): { total: number; completed: number[] } {
    const completed = [...approvedPlanMarkers]
      .filter((step) => step >= 1 && step <= approvedPlanTotal)
      .sort((a, b) => a - b);
    return { total: approvedPlanTotal, completed };
  }

  async function syncApprovedPlanProgress(generation: number): Promise<boolean> {
    const planPath = approvedPlanPath;
    if (planPath === null || generation !== approvedPlanGeneration) return false;
    const content = await fs.readFile(planPath, "utf-8").catch(() => null);
    if (approvedPlanPath !== planPath || generation !== approvedPlanGeneration) return false;
    if (content !== null) {
      const freshTotal = extractPlanSteps(content).length;
      // During an in-place rewrite the step section can briefly disappear.
      // Keep the last real total instead of flashing 0 or declaring completion.
      if (freshTotal > 0 || approvedPlanTotal === 0) approvedPlanTotal = freshTotal;
    }
    broadcast("plan_progress", planProgressPayload());
    return (
      approvedPlanTotal > 0 &&
      Array.from({ length: approvedPlanTotal }, (_, index) => index + 1).every((step) =>
        approvedPlanMarkers.has(step),
      )
    );
  }

  function queueApprovedPlanProgressSync(): Promise<boolean> {
    const generation = approvedPlanGeneration;
    planProgressSync = planProgressSync
      .catch(() => false)
      .then(() => syncApprovedPlanProgress(generation))
      .catch((error) => {
        captureSidecarError(error, "app-sidecar.plan.refresh-progress");
        log("WARN", "app-sidecar", "plan progress refresh failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      });
    return planProgressSync;
  }

  async function activateApprovedPlan(planPath: string | undefined): Promise<number> {
    deactivateApprovedPlan();
    await session.setApprovedPlan(planPath);
    if (!planPath) return 0;
    approvedPlanPath = planPath;
    await queueApprovedPlanProgressSync();
    return approvedPlanTotal;
  }

  function deactivateApprovedPlan(): void {
    approvedPlanGeneration++;
    approvedPlanPath = null;
    approvedPlanTotal = 0;
    approvedPlanMarkers = new Set();
    planMarkerTail = "";
    planProgressSync = Promise.resolve(false);
  }

  function recordApprovedPlanMarkers(text: string): void {
    if (approvedPlanPath === null || !text) return;
    const candidate = planMarkerTail + text;
    let changed = false;
    for (const match of candidate.matchAll(/\[DONE:(\d+)\]/gi)) {
      const step = Number.parseInt(match[1], 10);
      if (step >= 1 && !approvedPlanMarkers.has(step)) {
        approvedPlanMarkers.add(step);
        changed = true;
      }
    }
    planMarkerTail = candidate.slice(-32);
    if (changed) void queueApprovedPlanProgressSync();
  }

  // Forward every relevant bus event to the webview.
  session.eventBus.on("text_delta", (d) => {
    broadcast("text_delta", d);
    recordApprovedPlanMarkers(d.text);
  });
  session.eventBus.on("thinking_delta", (d) => broadcast("thinking_delta", d));
  session.eventBus.on("tool_call_start", (d) => {
    toolCallNames.set(d.toolCallId, d.name);
    broadcast("tool_call_start", d);
  });
  session.eventBus.on("tool_call_update", (d) => broadcast("tool_call_update", d));
  session.eventBus.on("tool_call_end", (d) => {
    const name = toolCallNames.get(d.toolCallId) ?? "unknown";
    toolCallNames.delete(d.toolCallId);
    if (d.isError && shouldCaptureToolFailure(name, d.result)) {
      // Expected model-correctable validation failures stay in the local log and
      // conversation. Unexpected failures are reported without private result data.
      captureSidecarError(new Error(`Tool ${name} failed`), `tool.${name}`, { tool: name });
    }
    log(d.isError ? "ERROR" : "INFO", "tool", `Tool call ended: ${name}`, {
      id: d.toolCallId,
      durationMs: String(d.durationMs),
      isError: String(d.isError),
      ...(d.isError ? { result: d.result.slice(0, 500) } : {}),
    });
    broadcast("tool_call_end", d);
    // Any tool can mutate the approved plan (including bash), so refresh after
    // every completed call while tracking is active. The file is tiny and this
    // keeps the displayed total aligned before the next completion marker.
    if (approvedPlanPath !== null) void queueApprovedPlanProgressSync();
  });
  // Native server tools (e.g. Anthropic web_search) do NOT end the turn — text
  // streams before and after them in the SAME turn. The webview must reset its
  // streaming bubble here, or the two text blocks concatenate with no separator
  // ("…command.Let me pull…"). Mirrors the TUI's server_tool_call handling.
  session.eventBus.on("server_tool_call", (d) => broadcast("server_tool_call", d));
  session.eventBus.on("turn_end", (d) => broadcast("turn_end", d));
  session.eventBus.on("agent_done", (d) => broadcast("agent_done", d));
  // Non-clean stop (max_tokens/refusal/provider error) — info-style frame so
  // the webview can warn instead of presenting truncated output as complete.
  session.eventBus.on("truncated", (d) => broadcast("truncated", d));
  session.eventBus.on("error", (d) => {
    broadcastError("error", "agent error", d.error);
  });
  session.eventBus.on("model_change", (d) => broadcast("model_change", d));
  session.eventBus.on("hook", (d) => broadcast("hook", d));
  session.eventBus.on("subagent_state", (d) => broadcast("subagent_state", d));
  session.eventBus.on("compaction_start", (d) => broadcast("compaction_start", d));
  session.eventBus.on("compaction_end", (d) => broadcast("compaction_end", d));

  let running = false;
  const runLifecycle = new RunLifecycle((runState) => {
    running = runState !== "idle";
    if (runState === "cancelling") broadcast("run_cancelling", { runState });
  });
  const cancelledRunEndGenerations = new Set<number>();
  let pendingCancelDrain: { generation: number; text: string } | null = null;
  // Bumped by /cancel — a run whose cancel generation changed mid-flight was
  // canceled and earns no XP.
  let cancelGeneration = 0;
  // Autopilot (auto-review) toggle for THIS window's project. Loaded from
  // gg-app.json on boot; flipped via POST /autopilot. When on, POST /prompt runs
  // runAutopilotCycle after the user's turn settles — Ken auto-reviews the work
  // and drives the review→prompt→review loop. Ken is the sole verification
  // owner in this mode, so suppress the build session's redundant Ideal hook.
  let autopilot = mode === "code" && (await loadAutopilot(cwd));
  session.setIdealReviewSuppressed(autopilot);
  // True while an autopilot review is in flight (used to defer kenAuto model
  // switches, like kenRunning does for chat Ken, and to drive the spinner).
  let autopilotReviewing = false;
  // True for the WHOLE autopilot cycle (reviews + injected runs). The build
  // `running` flag is false during the review windows between injected runs, so
  // this is the extra guard that makes a user /prompt queue as steering instead
  // of starting a run that would collide with an injected one on the same
  // session (AgentSession.prompt has no concurrency guard).
  let autopilotActive = false;
  // Set by /cancel to break out of an in-flight autopilot cycle between steps.
  let autopilotCancelled = false;
  // Hard cap on review→prompt→review rounds per user turn (loop safety).
  const MAX_AUTOPILOT_ROUNDS = 3;
  const CANCEL_TIMEOUT_MS = 5_000;
  // Prompt bodies Autopilot Ken injected into the BUILD session this
  // conversation. Passed into every Ken digest so injected prompts render as
  // "Ken autopilot (injected)" instead of `**User:**` — otherwise multi-round
  // cycles drift into Ken reviewing against his own last prompt. Cleared
  // whenever the conversation resets (new session / plan accept / task run).
  let injectedAutopilotPrompts: string[] = [];
  // The plan GG Coder submitted via exit_plan that still awaits a decision
  // (Ken's auto-review in autopilot, or the user's modal). Path + the content
  // read at submission time (fallback if the file becomes unreadable).
  let pendingPlanPath: string | null = null;
  let pendingPlanContent = "";
  // Bumped on EVERY pending-plan set/clear. Ken's plan review captures it
  // before reviewing and re-checks it before acting on the verdict, so a user
  // Accept/Reject racing an in-flight review always wins — the stale verdict
  // is discarded silently.
  let planGeneration = 0;

  function setPendingPlan(planPath: string, content: string): void {
    pendingPlanPath = planPath;
    pendingPlanContent = content;
    planGeneration++;
  }

  function clearPendingPlan(): void {
    if (pendingPlanPath === null) return;
    pendingPlanPath = null;
    pendingPlanContent = "";
    planGeneration++;
  }

  // Workflow (prompt-template) commands: built-in + the project's custom
  // `.gg/commands/*.md`. Used to gate autopilot off command turns and to label
  // expanded templates in Ken's digests. Loaded fresh so a newly added custom
  // command is picked up without a restart (mirrors GET /commands).
  async function loadWorkflowCommandSpecs(): Promise<WorkflowCommandSpec[]> {
    const custom = await loadCustomCommands(cwd).catch(() => []);
    return [
      ...PROMPT_COMMANDS.map((c) => ({ name: c.name, aliases: c.aliases, prompt: c.prompt })),
      ...custom.map((c) => ({ name: c.name, aliases: [] as string[], prompt: c.prompt })),
    ];
  }

  // ── Telegram serve (remote control via Telegram) ───────────
  // A single embedded serve session lives in this sidecar process. Only the main
  // window's home screen exposes the controls, so there's one bot per app.
  let serveController: ServeController | null = null;

  // ── Ken Kai (mentor agent) ─────────────────────────────────
  // A second, read-only AgentSession on this same window. The user talks to him
  // with `@Ken …`; he reads GG Coder's transcript (one-way — GG Coder never sees
  // Ken's) and hands back runnable prompts + mentorship. Created lazily on the
  // first `@Ken` so windows that never use Ken pay zero cost. His events ride the
  // SAME SSE stream with `ken_`-prefixed types, routed to the Ken bubble.
  let kenSession: AgentSession | null = null;
  let kenAbort = new AbortController();
  let kenRunning = false;
  let pendingKenModel: { provider: Provider; model: string } | null = null;
  const kenToolCallNames = new Map<string, string>();

  // Ken's per-project model override. null → Ken (chat + autopilot) follows GG
  // Coder's model, including live switches (the historical behavior). Set → Ken
  // is pinned to his own model and GG Coder switches no longer touch him. A
  // stale persisted pin (model dropped from the registry / provider logged
  // out) validates to null so Ken degrades to following instead of erroring.
  let kenModelOverride: KenModelPref | null = validateKenModelPref(await loadKenModelPref(cwd), {
    modelExists: (id) => getModel(id) !== undefined,
    providerConnected: () => true, // async auth checked below
  });
  if (kenModelOverride && !(await auth.hasProviderAuth(kenModelOverride.provider))) {
    log("WARN", "app-sidecar", "ken model override provider not connected — following GG", {
      provider: kenModelOverride.provider,
      model: kenModelOverride.model,
    });
    kenModelOverride = null;
  }

  /** The model Ken uses next turn: the pin when set, else GG Coder's. */
  function kenCurrentModel(): { provider: Provider; model: string } {
    if (kenModelOverride) return kenModelOverride;
    const st = session.getState();
    return { provider: st.provider, model: st.model };
  }

  /** Footer payload: Ken's effective model + whether it's a pin. Merged into
   *  /state, the SSE ready frame, and every ken_model_change broadcast. */
  function kenStatePayload(): ReturnType<typeof effectiveKenModel> {
    const st = session.getState();
    return effectiveKenModel(kenModelOverride, { provider: st.provider, model: st.model });
  }

  async function syncKenModel(provider: Provider, model: string): Promise<void> {
    if (kenRunning) {
      pendingKenModel = { provider, model };
      return;
    }
    if (!kenSession) return;
    const st = kenSession.getState();
    if (st.provider === provider && st.model === model) return;
    await kenSession.switchModel(provider, model);
    log("INFO", "app-sidecar", "ken session model synced", { provider, model });
  }

  async function ensureKenSession(): Promise<AgentSession> {
    if (kenSession) return kenSession;
    const target = kenCurrentModel();
    const ken = new AgentSession({
      provider: target.provider,
      model: target.model,
      cwd,
      systemPrompt: await buildKenSystemPrompt(cwd),
      allowedTools: KEN_ALLOWED_TOOLS,
      allowedMcpServers: KEN_ALLOWED_MCP_SERVERS,
      transient: true,
      signal: kenAbort.signal,
      // Ken's bursty, spread-out turns (chat) outlast the default 5-min cache
      // TTL regardless of the user's global speedProfile pick.
      forceLongCacheRetention: true,
    });
    await ken.initialize();
    // Bridge Ken's bus to the shared SSE fan-out with ken_-prefixed types so the
    // webview routes them to the Ken bubble, never GG Coder's.
    ken.eventBus.on("text_delta", (d) => broadcast("ken_text_delta", d));
    ken.eventBus.on("thinking_delta", (d) => broadcast("ken_thinking_delta", d));
    ken.eventBus.on("tool_call_start", (d) => {
      kenToolCallNames.set(d.toolCallId, d.name);
      broadcast("ken_tool_call_start", d);
    });
    ken.eventBus.on("tool_call_update", (d) => broadcast("ken_tool_call_update", d));
    ken.eventBus.on("tool_call_end", (d) => {
      kenToolCallNames.delete(d.toolCallId);
      broadcast("ken_tool_call_end", d);
    });
    // Native server tools (Anthropic web_search) stream text both before AND
    // after them in the same turn; forward so the webview can break the bubble
    // (otherwise "...work.Local tools..." glues together). Mirrors the build bus.
    ken.eventBus.on("server_tool_call", (d) => broadcast("ken_server_tool_call", d));
    ken.eventBus.on("turn_end", (d) => broadcast("ken_turn_end", d));
    ken.eventBus.on("error", (d) => {
      broadcastError("ken_error", "ken error", d.error);
    });
    kenSession = ken;
    log("INFO", "app-sidecar", "ken session ready", {
      provider: target.provider,
      model: target.model,
    });
    return ken;
  }

  // ── Autopilot Ken (auto-reviewer) ──────────────────────────
  // A THIRD read-only AgentSession, separate from chat Ken. In autopilot mode
  // Ken silently reviews each finished GG Coder turn and returns a verdict
  // (PROMPT / ALL_CLEAR / HUMAN). Its bus is intentionally NOT bridged to the
  // ken_* chat bubbles — the review is silent; we read its final assistant text
  // and parse it. Uses the lean autopilot system prompt + the same read-only
  // tools. Created lazily on the first autopilot cycle.
  let kenAutoSession: AgentSession | null = null;
  let kenAutoAbort = new AbortController();
  let pendingKenAutoModel: { provider: Provider; model: string } | null = null;

  async function syncKenAutoModel(provider: Provider, model: string): Promise<void> {
    if (autopilotReviewing) {
      pendingKenAutoModel = { provider, model };
      return;
    }
    if (!kenAutoSession) return;
    const st = kenAutoSession.getState();
    if (st.provider === provider && st.model === model) return;
    await kenAutoSession.switchModel(provider, model);
    log("INFO", "app-sidecar", "ken autopilot session model synced", { provider, model });
  }

  async function ensureKenAutoSession(): Promise<AgentSession> {
    if (kenAutoSession) return kenAutoSession;
    const target = kenCurrentModel();
    const ken = new AgentSession({
      provider: target.provider,
      model: target.model,
      cwd,
      systemPrompt: await buildKenAutopilotSystemPrompt(cwd),
      allowedTools: KEN_ALLOWED_TOOLS,
      allowedMcpServers: KEN_ALLOWED_MCP_SERVERS,
      transient: true,
      signal: kenAutoAbort.signal,
      // Autopilot review rounds routinely span the injected GG Coder run
      // (often >5 min) regardless of the user's global speedProfile pick.
      forceLongCacheRetention: true,
    });
    // Ken is already the independent autopilot reviewer; recursively running
    // his own Ideal self-review adds latency and can corrupt the verdict shape.
    ken.setIdealReviewSuppressed(true);
    await ken.initialize();
    // Deliberately no bus bridge: the review is silent. Errors surface via the
    // runAutopilotReview try/catch as autopilot_error frames.
    kenAutoSession = ken;
    log("INFO", "app-sidecar", "ken autopilot session ready", {
      provider: target.provider,
      model: target.model,
    });
    return ken;
  }

  function abortOwnedWork(): void {
    cancelGeneration++;
    abort.abort();
    // Stop a run-all sweep and every async child through AgentSession's signal.
    taskRunAll = false;
    autopilotCancelled = true;
    kenAutoAbort.abort();
  }

  function installFreshRunControllers(): void {
    abort = new AbortController();
    session.setSignal(abort.signal);
    kenAutoAbort = new AbortController();
    kenAutoSession?.setSignal(kenAutoAbort.signal);
  }

  function finishOwnedGeneration(generation: number, emitCancelledFallback: boolean): boolean {
    const cancelled = runLifecycle.isCancellationRequested(generation);
    const settlement = runLifecycle.settle(generation);
    if (!settlement.settled) return cancelled;
    // A replacement signal is safe only after the provider-backed owner settled.
    installFreshRunControllers();
    if (cancelled && emitCancelledFallback && !cancelledRunEndGenerations.has(generation)) {
      cancelledRunEndGenerations.add(generation);
      broadcast("run_end", { cancelled: true, runState: runLifecycle.state });
    }
    return cancelled;
  }

  // Core provider-run bracket. Standalone runs own a lifecycle generation;
  // injected autopilot runs share the cycle's outer generation.
  async function runAgent(label: string, run: () => Promise<void>): Promise<void> {
    const ownsGeneration = !runLifecycle.running;
    const generation = ownsGeneration
      ? runLifecycle.begin(abortOwnedWork).generation
      : runLifecycle.generation;
    if (ownsGeneration) pendingCancelDrain = null;
    // Progress (Ranks): completed, non-canceled runs with ≥1 assistant turn earn
    // XP — prompt + any commits authored during the run window.
    const runStartedAt = Date.now();
    const cancelGenAtStart = cancelGeneration;
    const assistantsBeforeRun = countAssistantMessages(session.getMessages());
    let runSucceeded = false;
    broadcast("run_start", { text: label, runState: runLifecycle.state });
    try {
      if (!runLifecycle.isCancellationRequested(generation)) await run();
      runSucceeded = true;
    } catch (err) {
      if (!runLifecycle.isCancellationRequested(generation)) {
        broadcastError("error", "run failed", err);
      }
    } finally {
      const cancelled = runLifecycle.isCancellationRequested(generation);
      if (
        runSucceeded &&
        !cancelled &&
        cancelGeneration === cancelGenAtStart &&
        countAssistantMessages(session.getMessages()) > assistantsBeforeRun
      ) {
        // Fire-and-forget — XP must never delay or break run teardown.
        void progress.awardRun(cwd, runStartedAt, opts.id);
      }
      // A run may have switched branches, changed files, or spawned/finished
      // background tasks. Refresh the workspace extras once it settles.
      [gitBranch, gitIsRepo, gitDirtyFileCount] = await Promise.all([
        getGitBranch(cwd).catch(() => gitBranch),
        isGitRepo(cwd).catch(() => gitIsRepo),
        getGitDirtyFileCount(cwd).catch(() => gitDirtyFileCount),
      ]);
      // Serialize behind any marker/tool-triggered refresh so the terminal
      // progress snapshot uses the live plan file. Once every canonical step
      // is complete, remove the approved plan from future system prompts and
      // clear the widget before run_end paints the idle activity bar.
      if (
        runSucceeded &&
        !cancelled &&
        approvedPlanPath !== null &&
        (await queueApprovedPlanProgressSync())
      ) {
        try {
          await session.setApprovedPlan(undefined);
          deactivateApprovedPlan();
          broadcast("plan_progress", { total: 0, completed: [] });
        } catch (error) {
          // Keep tracking when prompt cleanup fails; hiding the widget here
          // would claim completion while the approved-plan contract remained.
          captureSidecarError(error, "app-sidecar.plan.cleanup");
          log("WARN", "app-sidecar", "completed plan cleanup failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (ownsGeneration) finishOwnedGeneration(generation, false);
      // A cancelled injected run is still owned by the surrounding autopilot
      // cycle; its outer finalizer emits the one terminal cancelled run_end.
      if (!(cancelled && !ownsGeneration)) {
        if (cancelled) cancelledRunEndGenerations.add(generation);
        broadcast("run_end", {
          ...(cancelled ? { cancelled: true } : {}),
          runState: runLifecycle.state,
        });
      }
      // Autopilot's review loop is driven explicitly from POST /prompt (see
      // runAutopilotCycle), NOT from this shared finally — that keeps injected
      // runs from recursively entering the same review loop.
      broadcast("tasks_list", { tasks: pruneDoneTasksSync(cwd) });
      broadcast("queued", { count: session.getQueuedCount() });
      broadcast("extras", footerExtras());
    }
  }

  // ── Autopilot orchestration ─────────────────────────────────
  // One review = prompt the kenAuto session with the review digest, read its
  // final assistant text, parse a verdict. Returns null on failure (surfaced as
  // an autopilot_error frame) so the cycle stops rather than looping blind.
  // `originalRequest` is the user prompt that started the turn under review —
  // pinned in the digest so it can't scroll out during multi-round cycles.
  async function runAutopilotReview(originalRequest: string): Promise<AutopilotVerdict | null> {
    autopilotReviewing = true;
    broadcast("autopilot_review_start", {});
    try {
      const ken = await ensureKenAutoSession();
      const digest = buildKenAutopilotContext({
        cwd,
        gitBranch,
        messages: session.getMessages(),
        originalRequest,
        injectedPrompts: [...injectedAutopilotPrompts],
        workflowCommands: await loadWorkflowCommandSpecs(),
      });
      await ken.prompt(digest);
      return parseAutopilotVerdict(lastAssistantText(ken.getMessages()));
    } catch (err) {
      if (!autopilotCancelled) broadcastError("autopilot_error", "autopilot review failed", err);
      return null;
    } finally {
      autopilotReviewing = false;
      // Apply any model switch that landed mid-review.
      const pending = pendingKenAutoModel;
      pendingKenAutoModel = null;
      if (pending) await syncKenAutoModel(pending.provider, pending.model);
    }
  }

  // One PLAN review: like runAutopilotReview but the digest carries the
  // submitted plan's markdown (`## Plan under review`) and the plan-review
  // instruction — Ken judges the plan itself, not finished work. Returns null
  // on failure; a failure caused by the user's own action racing the review
  // (cancel or a manual Accept/Reject that bumped planGeneration) stays
  // SILENT — no autopilot_error — because the user's decision already won.
  async function runAutopilotPlanReview(originalRequest: string): Promise<AutopilotVerdict | null> {
    const planPath = pendingPlanPath;
    if (planPath === null) return null;
    const genAtStart = planGeneration;
    autopilotReviewing = true;
    broadcast("autopilot_review_start", {});
    try {
      const ken = await ensureKenAutoSession();
      // Re-read the plan file (the run may have revised it in place); fall
      // back to the content captured at exit_plan time.
      const planContent = await fs.readFile(planPath, "utf-8").catch(() => pendingPlanContent);
      const digest = buildKenAutopilotPlanContext({
        cwd,
        gitBranch,
        messages: session.getMessages(),
        originalRequest,
        injectedPrompts: [...injectedAutopilotPrompts],
        workflowCommands: await loadWorkflowCommandSpecs(),
        planContent,
      });
      await ken.prompt(digest);
      if (autopilotCancelled || planGeneration !== genAtStart) return null;
      return parseAutopilotVerdict(lastAssistantText(ken.getMessages()));
    } catch (err) {
      // User action mid-review (manual Accept aborts the kenAuto run): drop
      // the review silently — the user's decision supersedes Ken's.
      if (autopilotCancelled || planGeneration !== genAtStart) return null;
      broadcastError("autopilot_error", "autopilot plan review failed", err);
      return null;
    } finally {
      autopilotReviewing = false;
      // Apply any model switch that landed mid-review.
      const pending = pendingKenAutoModel;
      pendingKenAutoModel = null;
      if (pending) await syncKenAutoModel(pending.provider, pending.model);
    }
  }

  // The prompt fed to the fresh session after a plan is accepted — the SAME
  // string the webview sends on a manual Accept (see PlanReviewModal's accept
  // handler in gg-app/src/App.tsx). Keep the two in lockstep so auto- and
  // manual approval produce identical implementation turns.
  const IMPLEMENT_PLAN_PROMPT =
    "The plan has been approved. Implement it now, following each step in order.";

  // Drive the review→prompt→review loop for one finished user turn. Only ever
  // called after shouldStartAutopilotCycle approves the turn (POST /prompt or
  // the stranded-queue drain) — never from the task runner, resume, /ken, or
  // error paths, so there's no recursion and no guard tangle. The loop's
  // control flow lives in driveAutopilotCycle (core/autopilot-cycle.ts) so
  // every exit path is unit-tested; this only wires the real dependencies.
  async function runAutopilotCycle(originalRequest: string): Promise<void> {
    if (!autopilot || autopilotCancelled) return;
    const generation = runLifecycle.begin(abortOwnedWork).generation;
    pendingCancelDrain = null;
    autopilotActive = true;
    session.setIdealReviewSuppressed(true);
    // Generation captured by the last plan review; acceptPlan re-checks it so
    // a user Accept/Reject landing mid-review always wins.
    let planGenAtReview = -1;
    try {
      await driveAutopilotCycle({
        // A plan-pending cycle needs extra rounds: approve+implement and the
        // post-implement work review each consume one, so +2 keeps a real fix
        // round available.
        maxRounds: pendingPlanPath !== null ? MAX_AUTOPILOT_ROUNDS + 2 : MAX_AUTOPILOT_ROUNDS,
        isCancelled: () => autopilotCancelled,
        // An injected run entering plan mode WITHOUT submitting (enter_plan,
        // no exit_plan) halts the cycle — Ken never prompts into a read-only
        // plan-mode session. A submitted plan takes the planPending branch.
        isPlanMode: () => session.getPlanMode(),
        planPending: () => pendingPlanPath !== null,
        reviewPlan: async () => {
          planGenAtReview = planGeneration;
          return runAutopilotPlanReview(originalRequest);
        },
        // Auto-accept: the inlined POST /plan/accept body. Returns false when
        // the plan generation moved since the review (user acted) — the cycle
        // exits silently and the user's action stands.
        acceptPlan: async () => {
          if (pendingPlanPath === null || planGeneration !== planGenAtReview) return false;
          const planPath = pendingPlanPath;
          let planTotal: number;
          try {
            await session.newSession(true);
            injectedAutopilotPrompts = [];
            planTotal = await activateApprovedPlan(planPath);
          } catch (err) {
            broadcastError("autopilot_error", "autopilot plan accept failed", err);
            return false;
          }
          clearPendingPlan();
          // Keep the approval marker ahead of the reset, then seed the reset
          // with the sidecar's canonical count from the actual plan file.
          broadcast("autopilot_plan_accepted", {});
          broadcast("session_reset", { planTotal });
          broadcast("plan_progress", planProgressPayload());
          // Persisted into the NEW session so a resume shows the marker.
          void session.persistAutopilotMarker("plan_approved");
          return true;
        },
        runImplement: () => {
          // Autopilot-injected run: frame it so GG Coder knows no human is
          // watching the implementation. Record the framed string so Ken's
          // digest labels it as injected, not as the user's ask. The run_start
          // label stays the clean prompt.
          const framed = frameAutopilotInjection(IMPLEMENT_PLAN_PROMPT);
          injectedAutopilotPrompts.push(framed);
          return runAgent(IMPLEMENT_PLAN_PROMPT, () => session.prompt(framed));
        },
        // Lean context per user turn: wipe prior review history so each new
        // turn starts cheap, while within this cycle the few review messages
        // persist so Ken remembers what he already asked GG Coder to fix.
        resetReviewer: async () => {
          await kenAutoSession?.newSession().catch(() => {});
        },
        review: () => runAutopilotReview(originalRequest),
        // prompt → record the injected body (so later digests label it as
        // Ken's, not the user's), show a compact Ken-tinted marker (not the
        // prompt body), then feed GG Coder bracketed by runAgent so the run
        // streams normally; the shared finally never re-triggers autopilot,
        // so this can't recurse.
        onInjected: (body, round) => {
          // A revision injection supersedes the pending plan — if the run
          // resubmits via exit_plan, onExitPlan re-sets it (no-op for work-
          // branch injections, where nothing is pending).
          clearPendingPlan();
          // Record the FRAMED string (what actually lands in the build session,
          // see runPrompt) so Ken's digest matches and labels it as injected.
          // The webview marker + persisted body stay the CLEAN prompt so the UI
          // shows Ken's actual instruction, not the autopilot preamble.
          injectedAutopilotPrompts.push(frameAutopilotInjection(body));
          broadcast("autopilot_prompted", { round, body });
          void session.persistAutopilotMarker("prompted", { body });
        },
        // Autopilot-injected run: GG Coder receives the framed prompt (no human
        // is watching this turn) while run_start keeps the clean label.
        runPrompt: (body) => runAgent(body, () => session.prompt(frameAutopilotInjection(body))),
        emit: (event) => {
          // Persist the terminal verdict marker so a resumed session renders the
          // same Ken bubble the live run showed instead of dropping it or
          // falling back to the raw verdict text (e.g. ALL_CLEAR).
          if (event.type === "autopilot_done") {
            // Broadcast the SAME copySeed the persisted marker will produce on
            // resume, so the live all-clear wording matches the resumed one
            // (computed before persist — same synchronous message count).
            const seed = autopilotMarkerCopySeed({
              version: 1,
              phase: "done",
              afterMessageCount: session.getMessages().filter((m) => m.role !== "system").length,
            });
            broadcast(event.type, { ...event.data, copySeed: seed });
            void session.persistAutopilotMarker("done");
            return;
          }
          broadcast(event.type, event.data);
          if (event.type === "autopilot_human") {
            void session.persistAutopilotMarker("human", { reason: event.data.reason });
          } else if (event.type === "autopilot_capped") {
            void session.persistAutopilotMarker("capped");
          }
          // autopilot_ignored renders nothing live, so nothing is persisted either.
        },
      });
    } finally {
      autopilotActive = false;
      session.setIdealReviewSuppressed(autopilot);
      finishOwnedGeneration(generation, true);
      queueMicrotask(() => void runStrandedQueue());
    }
  }

  // ── Stranded-queue drain ───────────────────────────────
  // A prompt POSTed while an autopilot cycle is between injected runs (build
  // idle, Ken reviewing) queues — but the queue only drains INTO a running
  // turn as steering. If the cycle ends without another run (ALL_CLEAR /
  // IGNORE / HUMAN / error), that message would sit stranded until the next
  // unrelated prompt, then land mislabeled as "concurrent steering" of an
  // unrelated run. Drain it here as a fresh turn of its own (with its own
  // gated review). Also covers the non-autopilot tail window: a message queued
  // after the run's last steering drain but before run_end.
  let drainingStrandedQueue = false;
  async function runStrandedQueue(): Promise<void> {
    if (drainingStrandedQueue) return;
    drainingStrandedQueue = true;
    try {
      for (;;) {
        if (running || autopilotActive) return;
        const next = session.takeNextQueuedMessage();
        if (!next) return;
        broadcast("queued", { count: session.getQueuedCount() });
        if (!next.text.trim() && next.attachments.length === 0) continue;
        // A queued message draining as a fresh turn supersedes any pending
        // plan, exactly like a direct POST /prompt turn.
        clearPendingPlan();
        const workflowCommand =
          next.attachments.length === 0 &&
          isWorkflowCommandText(next.text, await loadWorkflowCommandSpecs());
        const assistantsBefore = countAssistantMessages(session.getMessages());
        const messagesBefore = session.getMessages().length;
        await runAgent(next.text, async () => {
          if (next.attachments.length > 0) {
            await session.promptWithAttachments(next.text, next.attachments);
          } else {
            await session.prompt(next.text);
          }
        });
        const decision = shouldStartAutopilotCycle({
          enabled: autopilot,
          cancelled: autopilotCancelled,
          planMode: session.getPlanMode(),
          // A submitted plan (exit_plan fired) routes into the PLAN review
          // branch — the cycle reviews the plan itself instead of skipping.
          planPending: pendingPlanPath !== null,
          workflowCommand,
          assistantMessagesAdded: countAssistantMessages(session.getMessages()) - assistantsBefore,
          // Skip the review API call outright for turns that only started a
          // background process (dev server/watcher), ran a read-only lookup, or
          // committed/pushed — Ken's autopilot contract already IGNOREs these,
          // so there's no reason to pay for that verdict.
          mechanicalOnly: isMechanicalOnlyTurn(
            extractTurnToolCalls(session.getMessages(), messagesBefore),
          ),
        });
        if (decision.start) {
          log("INFO", "app-sidecar", "autopilot cycle starting (queued turn)", {
            kind: decision.kind,
          });
          await runAutopilotCycle(next.text);
        } else if (autopilot) {
          log("INFO", "app-sidecar", "autopilot skipped (queued turn)", {
            reason: decision.reason,
          });
        }
      }
    } finally {
      drainingStrandedQueue = false;
    }
  }

  // ── Task runner (project task list → sessions) ──────────────
  // Mirrors the CLI's task flow: each task runs in its OWN fresh session, with a
  // completion hint instructing the agent to mark the task done via the tasks
  // tool. Run-all advances to the next pending task after each run finishes.
  let taskRunAll = false;

  async function runTaskById(taskId: string): Promise<boolean> {
    const task = loadTasksSync(cwd).find((t) => t.id === taskId || t.id.startsWith(taskId));
    if (!task) return false;
    // Fresh session per task so one task's context never bleeds into the next.
    await session.newSession();
    deactivateApprovedPlan();
    injectedAutopilotPrompts = [];
    clearPendingPlan();
    broadcast("session_reset", {});
    markTaskInProgress(cwd, task.id);
    broadcast("tasks_list", { tasks: loadTasksSync(cwd) });
    broadcast("task_start", { id: task.id, title: task.title });
    // Persist the task header so a resumed task session shows what ran.
    void session.persistAppMarker("task", { title: task.title }).catch(() => {});
    const shortId = task.id.slice(0, 8);
    const completionHint =
      `\n\n---\nWhen you have fully completed this task, call the tasks tool to mark it done:\n` +
      `tasks({ action: "done", id: "${shortId}" })`;
    await runAgent(task.title, () => session.prompt(task.prompt + completionHint));
    // The agent typically marks the task done via the tasks tool during the run;
    // prune completed tasks and push the refreshed list so the modal drops them.
    broadcast("tasks_list", { tasks: pruneDoneTasksSync(cwd) });
    return true;
  }

  async function runTasks(startId: string | null, all: boolean): Promise<void> {
    taskRunAll = all;
    let currentId: string | null = startId ?? getNextPendingTask(cwd)?.id ?? null;
    while (currentId) {
      const ran = await runTaskById(currentId);
      if (!ran || !taskRunAll) break;
      const next = getNextPendingTask(cwd);
      currentId = next ? next.id : null;
      // Brief pause between tasks (mirrors the CLI cadence).
      if (currentId) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    taskRunAll = false;
    broadcast("tasks_run_done", {});
  }

  // ── Provider auth (login) bridge ───────────────────────────
  // OAuth login functions are interactive (open a URL, sometimes prompt for a
  // pasted code). We run one at a time and surface every step over SSE so the
  // webview can open the URL and collect a code via a modal. `pendingCode`
  // resolves when the webview POSTs /auth/oauth/code.
  let oauthInFlight = false;
  let pendingCode: ((code: string) => void) | null = null;

  function authCallbacks(): OAuthLoginCallbacks {
    return {
      onOpenUrl: (url) => broadcast("auth_url", { url }),
      onStatus: (message) => broadcast("auth_status", { message }),
      onPromptCode: (message) =>
        new Promise<string>((resolve) => {
          pendingCode = resolve;
          broadcast("auth_need_code", { message });
        }),
    };
  }

  async function authStatusPayload(): Promise<{
    providers: (AuthProviderMeta & { connected: boolean })[];
  }> {
    const providers = await Promise.all(
      AUTH_PROVIDERS.map(async (p) => ({
        ...p,
        connected: await auth.hasProviderAuth(p.value),
      })),
    );
    return { providers };
  }

  // Background tasks have no event source (the bash tool just spawns them), so
  // poll the process manager and broadcast only when the snapshot changes. This
  // keeps the webview footer live without a busy render loop. Adaptive cadence:
  // tasks can only change while a run is active (the bash tool spawns them), so
  // poll fast (1500ms) while running or while tasks exist, and back off to
  // 5000ms when fully idle — fewer wakeups per idle window.
  let lastTasksJson = "[]";
  let tasksPoll: NodeJS.Timeout | undefined;
  let tasksPollStopped = false;
  const scheduleTasksPoll = (delay: number): void => {
    if (tasksPollStopped) return;
    tasksPoll = setTimeout(() => {
      const tasks = session.listBackgroundProcesses();
      const next = JSON.stringify(tasks);
      if (next !== lastTasksJson) {
        lastTasksJson = next;
        broadcast("tasks", { tasks });
      }
      const active = running || tasks.length > 0;
      scheduleTasksPoll(active ? 1500 : 5000);
    }, delay);
    tasksPoll.unref?.();
  };
  scheduleTasksPoll(1500);

  // Files can change outside the agent (editor saves, terminal commits), so keep
  // the dirty count current while idle. Branch/repo state already refreshes after
  // agent runs; polling only the count avoids spawning three git processes per tick.
  let gitPoll: NodeJS.Timeout | undefined;
  let gitPollStopped = false;
  const scheduleGitPoll = (delay: number): void => {
    if (gitPollStopped) return;
    gitPoll = setTimeout(() => {
      void getGitDirtyFileCount(cwd)
        .catch(() => gitDirtyFileCount)
        .then((nextDirtyFileCount) => {
          if (gitPollStopped) return;
          if (nextDirtyFileCount !== gitDirtyFileCount) {
            gitDirtyFileCount = nextDirtyFileCount;
            broadcast("extras", footerExtras());
          }
          scheduleGitPoll(5000);
        });
    }, delay);
    gitPoll.unref?.();
  };
  scheduleGitPoll(5000);

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(redactValue(body, { secrets: environmentSecrets(process.env) }));
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(payload);
  }

  // OPTIONS/CORS preflight is handled at the daemon level before delegation.
  function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): void {
    if (method === "GET" && url === "/state") {
      const st = session.getState();
      json(res, 200, {
        ...st,
        mode,
        chatAgent,
        running,
        runState: runLifecycle.state,
        ready: true,
        thinkingLevel: session.getThinkingLevel() ?? null,
        supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
        supportsVideo: getModel(st.model)?.supportsVideo ?? false,
        autopilot,
        ...kenStatePayload(),
        ...footerExtras(),
      });
      return;
    }

    if (method === "GET" && url === "/progress") {
      json(res, 200, progress.snapshot());
      return;
    }

    if (method === "GET" && url === "/memories") {
      void memoryStore
        .snapshot()
        .then((snapshot) => json(res, 200, snapshot))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.memory.snapshot");
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "DELETE" && url.startsWith("/memories/")) {
      const id = decodeURIComponent(url.slice("/memories/".length));
      if (!id) {
        json(res, 400, { error: "memory id is required" });
        return;
      }
      void memoryStore
        .forget(id)
        .then(() => memoryStore.snapshot())
        .then((snapshot) => json(res, 200, snapshot))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.memory.forget");
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "GET" && url === "/jiwa") {
      void jiwaStore
        .snapshot()
        .then((snapshot) => json(res, 200, snapshot))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.jiwa.snapshot");
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }

    if (method === "DELETE" && url.startsWith("/jiwa/")) {
      const id = decodeURIComponent(url.slice("/jiwa/".length));
      if (!id) {
        json(res, 400, { error: "Jiwa entry id is required" });
        return;
      }
      void jiwaStore
        .forget(id)
        .then(() => jiwaStore.snapshot())
        .then((snapshot) => json(res, 200, snapshot))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.jiwa.forget");
          json(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      return;
    }
    if (method === "GET" && (url === "/events" || url.startsWith("/events?"))) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      res.write(`retry: 1000\n\n`);
      const client: SseClient = { id: ++clientSeq, res };
      clients.add(client);
      const st = session.getState();
      res.write(
        `data: ${JSON.stringify({
          type: "ready",
          data: {
            ...st,
            mode,
            chatAgent,
            running,
            runState: runLifecycle.state,
            thinkingLevel: session.getThinkingLevel() ?? null,
            supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
            supportsVideo: getModel(st.model)?.supportsVideo ?? false,
            autopilot,
            ...kenStatePayload(),
            ...footerExtras(),
          },
        })}\n\n`,
      );
      const keepAlive = setInterval(() => res.write(`: ping\n\n`), 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(client);
      });
      return;
    }

    if (method === "GET" && url === "/settings") {
      // `configured` is true only when the user explicitly saved a projects root
      // (the gg-app.json file exists with a value) — not when we fall back to the
      // default. The home screen gates "Your Projects" on this.
      void (async () => {
        const s = await loadAppSettings();
        let configured: boolean;
        try {
          const raw = JSON.parse(await fs.readFile(appSettingsFile(), "utf-8")) as {
            projectsRoot?: string;
          };
          configured = typeof raw.projectsRoot === "string" && raw.projectsRoot.trim().length > 0;
        } catch {
          configured = false;
        }
        // Only projectsRoot + configured flag are webview-facing; the
        // per-project model map is internal persistence, never shipped out.
        json(res, 200, { projectsRoot: s.projectsRoot, configured });
      })();
      return;
    }

    if (method === "POST" && url === "/settings") {
      void readBody(req).then(async (raw) => {
        let projectsRoot: string;
        try {
          projectsRoot = (JSON.parse(raw) as { projectsRoot?: string }).projectsRoot ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!projectsRoot.trim()) {
          json(res, 400, { error: "projectsRoot is required" });
          return;
        }
        // Read-modify-write so the per-project model map survives a projectsRoot
        // change (a naive overwrite would drop every window's saved model).
        const s = await loadAppSettings();
        s.projectsRoot = projectsRoot;
        await saveAppSettings(s);
        json(res, 200, { projectsRoot });
      });
      return;
    }

    if (method === "POST" && url === "/create-project") {
      void readBody(req).then(async (raw) => {
        let name: string;
        try {
          name = (JSON.parse(raw) as { name?: string }).name ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        name = name.trim();
        if (!isValidProjectName(name)) {
          json(res, 400, {
            error: "Project name must be lowercase letters, digits, and dashes (e.g. my-project).",
          });
          return;
        }
        const { projectsRoot } = await loadAppSettings();
        const dir = path.join(projectsRoot, name);
        try {
          // Refuse to clobber an existing directory.
          const exists = await fs
            .stat(dir)
            .then(() => true)
            .catch(() => false);
          if (exists) {
            json(res, 409, { error: `A folder named "${name}" already exists.` });
            return;
          }
          await fs.mkdir(dir, { recursive: true });
          json(res, 200, { path: dir });
        } catch (err) {
          captureSidecarError(err, "app-sidecar.project.create");
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }

    if (method === "GET" && url === "/projects") {
      // Scan ggcoder + Claude Code + Codex session stores for known projects.
      void discoverProjects()
        .then((projects) => json(res, 200, { projects }))
        .catch((err) => {
          captureSidecarError(err, "app-sidecar.projects.discover");
          log("ERROR", "app-sidecar", "discoverProjects failed", {
            message: err instanceof Error ? err.message : String(err),
          });
          json(res, 200, { projects: [] });
        });
      return;
    }

    if (method === "GET" && url.startsWith("/sessions")) {
      const target = new URL(url, `http://${host}`).searchParams.get("cwd");
      if (!target) {
        json(res, 400, { error: "missing cwd query param" });
        return;
      }
      const requestedAgent = new URL(url, `http://${host}`).searchParams.get("chatAgent");
      // An omitted chatAgent means coding history; chat callers identify one
      // agent or request the combined, recency-sorted "all" listing.
      void listSidecarSessions(target, requestedAgent, paths.sessionsDir)
        .then((sessions) => json(res, 200, { sessions }))
        .catch((error) => {
          captureSidecarError(error, "app-sidecar.sessions.list");
          json(res, 200, { sessions: [] });
        });
      return;
    }

    if (method === "GET" && url.startsWith("/files")) {
      const q = new URL(url, `http://${host}`).searchParams.get("q") ?? "";
      void searchProjectFiles(cwd, q)
        .then((files) => json(res, 200, { files }))
        .catch((err) => {
          captureSidecarError(err, "app-sidecar.files.search");
          log("ERROR", "app-sidecar", "searchProjectFiles failed", {
            message: err instanceof Error ? err.message : String(err),
          });
          json(res, 200, { files: [] });
        });
      return;
    }

    if (method === "GET" && url === "/history") {
      // Reconstruct the transcript from persisted messages so resume is 1:1 with
      // the live SSE stream. Walks ALL message types (not just user/assistant):
      // tool result messages carry ImageContent blocks (screenshots,
      // generate_image) that must re-render inline, and assistant tool_call
      // blocks carry sub-agent delegations that must re-appear as group items.
      //
      // The `details` object (imagePreviews with path + downscaled preview) is
      // event-only and never persisted — we reconstruct from the raw
      // ImageContent in the tool result, downsampling on the sidecar side and
      // extracting the path from the text block ("Generated image → /path").
      void (async () => {
        const commandCandidates = [...PROMPT_COMMANDS, ...(await loadCustomCommands(cwd))];
        const messages = session.getMessages();

        // An Ideal hook is injected immediately after the assistant's candidate
        // no-tool response. That response is review scratch, not a user-visible
        // final answer. Live SSE drops it when the hook event arrives; mark the
        // same assistant message here so resumed history stays identical.
        const hiddenIdealDrafts = new Set<(typeof messages)[number]>();
        for (let i = 0; i < messages.length - 1; i++) {
          const draft = messages[i];
          const hookPrompt = messages[i + 1];
          if (draft?.role !== "assistant" || hookPrompt?.role !== "user") continue;
          const restored = restoreUserRow(hookPrompt.content);
          if (detectHookKind(restored.text) === "ideal") hiddenIdealDrafts.add(draft);
        }

        // Pre-index tool results by toolCallId so we can pair tool calls with
        // their results (for sub-agent status + image extraction).
        const toolResultMap = new Map<string, { content: ToolResultContent; isError: boolean }>();
        for (const msg of messages) {
          if (msg.role !== "tool") continue;
          for (const tr of msg.content) {
            toolResultMap.set(tr.toolCallId, {
              content: tr.content,
              isError: tr.isError ?? false,
            });
          }
        }

        const history: HistoryEntryForWire[] = [];

        // Ken (mentor) turns to interleave: group by the non-system message count
        // they were recorded after, so each lands right after that message. A
        // turn becomes two wire rows: the `@Ken` question (user) + Ken's reply
        // (assistant), both flagged `ken` so the webview tints them.
        // Deduped; stale anchors are clamped to the last message (Ken turns
        // carry real conversation, so they render at the end instead of
        // vanishing).
        const kenByCount = new Map<number, KenTurnPayload[]>();
        for (const turn of normalizeKenTurnsForHistory(
          session.getKenTurns(),
          messages.filter((m) => m.role !== "system").length,
        )) {
          const list = kenByCount.get(turn.afterMessageCount) ?? [];
          list.push(turn);
          kenByCount.set(turn.afterMessageCount, list);
        }
        const flushKen = (count: number): void => {
          const turns = kenByCount.get(count);
          if (!turns) return;
          kenByCount.delete(count);
          for (const turn of turns) {
            history.push({ role: "user", text: `@Ken ${turn.question}`, ken: true });
            history.push({ role: "assistant", text: turn.reply, ken: true });
          }
        };

        // Autopilot verdict markers to interleave, same anchor scheme as Ken
        // turns — each becomes a single assistant row the webview renders
        // exactly like the live `autopilot` item (never a raw verdict string).
        // Compact/continuation rewrites can carry old markers whose original
        // afterMessageCount is beyond the restored message list; dropping those
        // prevents stale all-clear bubbles from bunching at the bottom on resume.
        const restoredMessageCount = messages.filter((m) => m.role !== "system").length;
        const autopilotByCount = new Map<
          number,
          ReturnType<typeof normalizeAutopilotMarkersForHistory>
        >();
        for (const marker of normalizeAutopilotMarkersForHistory(
          session.getAutopilotMarkers(),
          restoredMessageCount,
        )) {
          const list = autopilotByCount.get(marker.afterMessageCount) ?? [];
          list.push(marker);
          autopilotByCount.set(marker.afterMessageCount, list);
        }
        const flushAutopilot = (count: number): void => {
          const markers = autopilotByCount.get(count);
          if (!markers) return;
          autopilotByCount.delete(count);
          for (const marker of markers) {
            history.push({
              role: "assistant",
              text: "",
              autopilot: {
                phase: marker.phase,
                ...(marker.reason !== undefined ? { reason: marker.reason } : {}),
                ...(marker.body !== undefined ? { body: marker.body } : {}),
                copySeed: marker.copySeed,
              },
            });
          }
        };

        // App transcript markers (plan banner / task header / error rows /
        // user-bubble hints), same anchor scheme. user_hint markers don't
        // become rows — they decorate the user row at their anchor instead.
        const appMarkersByCount = new Map<number, AppMarkerPayload[]>();
        const userHintByCount = new Map<number, Record<string, unknown>>();
        // Compaction-count markers pair with compacted summary rows in file
        // order (FIFO), not by anchor — the summary user message is what
        // positions the notice.
        const compactionCounts: Array<{ originalCount: number; newCount: number }> = [];
        for (const marker of normalizeAppMarkersForHistory(
          session.getAppMarkers(),
          restoredMessageCount,
        )) {
          if (marker.kind === "user_hint") {
            userHintByCount.set(marker.afterMessageCount, marker.data);
            continue;
          }
          if (marker.kind === "compaction") {
            const d = marker.data;
            if (typeof d.originalCount === "number" && typeof d.newCount === "number") {
              compactionCounts.push({ originalCount: d.originalCount, newCount: d.newCount });
            }
            continue;
          }
          const list = appMarkersByCount.get(marker.afterMessageCount) ?? [];
          list.push(marker);
          appMarkersByCount.set(marker.afterMessageCount, list);
        }
        const flushAppMarkers = (count: number): void => {
          const markers = appMarkersByCount.get(count);
          if (!markers) return;
          appMarkersByCount.delete(count);
          for (const marker of markers) {
            const d = marker.data;
            if (marker.kind === "plan") {
              history.push({
                role: "assistant",
                text: "",
                plan: { reason: typeof d.reason === "string" ? d.reason : "" },
              });
            } else if (marker.kind === "task") {
              history.push({
                role: "assistant",
                text: "",
                task: { title: typeof d.title === "string" ? d.title : "" },
              });
            } else if (marker.kind === "error" && typeof d.headline === "string") {
              history.push({
                role: "assistant",
                text: "",
                error: {
                  scope: typeof d.scope === "string" ? d.scope : "error",
                  headline: d.headline,
                  ...(typeof d.message === "string" ? { message: d.message } : {}),
                  ...(typeof d.guidance === "string" ? { guidance: d.guidance } : {}),
                },
              });
            }
          }
        };
        let nonSystemCount = 0;
        // Turns/markers recorded before any build message (anchor 0) render at
        // the top.
        flushKen(0);
        flushAutopilot(0);
        flushAppMarkers(0);

        for (const msg of messages) {
          if (msg.role === "system") continue;
          nonSystemCount++;

          if (msg.role === "tool") {
            // Tool result messages: check for ImageContent blocks (screenshots,
            // generated images) and emit a toolImages entry.
            for (const tr of msg.content) {
              if (typeof tr.content === "string") continue;
              const imageBlocks = tr.content.filter((c) => c.type === "image");
              if (imageBlocks.length === 0) continue;
              // Extract the path from the text block (e.g. "Generated image → /path").
              const textBlock = tr.content.find(
                (c) => c.type === "text" && "text" in c && typeof c.text === "string",
              );
              const textContent = textBlock && textBlock.type === "text" ? textBlock.text : "";
              const pathMatch = textContent.match(/→\s*(\S+)/);
              const imgPath = pathMatch?.[1];

              // Downscale each image for the webview preview.
              const toolImages: Array<{ src: string; path?: string }> = [];
              for (const block of imageBlocks) {
                if (block.type !== "image") continue;
                try {
                  const rawBuf = Buffer.from(block.data, "base64");
                  const previewBuf = await downscaleForPreview(rawBuf);
                  toolImages.push({
                    src: `data:${block.mediaType};base64,${previewBuf.toString("base64")}`,
                    path: imgPath,
                  });
                } catch {
                  // Downscale failed — use the raw data.
                  toolImages.push({
                    src: `data:${block.mediaType};base64,${block.data}`,
                    path: imgPath,
                  });
                }
              }
              if (toolImages.length > 0) {
                history.push({
                  role: "assistant",
                  text: "",
                  toolImages,
                });
              }
            }
            continue;
          }

          // User or assistant message — text/hook/command/compacted extraction,
          // plus sub-agent group detection for assistant tool_calls.
          if (msg.role === "user") {
            // Rebuild the live bubble: strip the steering wrapper, drop
            // attachment/file notes the model saw but the bubble never showed.
            const restored = restoreUserRow(msg.content);
            const text = restored.text;
            const hook = detectHookKind(text);
            const compacted = !hook && text.startsWith("[Previous conversation summary]");
            const command =
              !hook && !compacted ? detectPromptCommand(text, commandCandidates) : null;
            if (text.trim() || restored.images.length > 0) {
              const hint = userHintByCount.get(nonSystemCount);
              history.push({
                role: "user",
                text: command ?? text,
                images: restored.images,
                hook,
                command: command !== null,
                compacted,
                // Markers accumulate across continuation files (each rewrite
                // re-persists prior ones) but only the LATEST summary row
                // survives compaction — so consume from the newest end.
                ...(compacted && compactionCounts.length > 0
                  ? { compactionCounts: compactionCounts.pop() }
                  : {}),
                ...(hint?.kenSent === true ? { kenSent: true } : {}),
                ...(Array.isArray(hint?.enhancements) ? { enhancements: hint.enhancements } : {}),
              });
              // Live showed the video-capability warning right after the bubble.
              if (restored.videoWarning) {
                history.push({ role: "assistant", text: "", infoKind: "video_warning" });
              }
            }
          } else if (!hiddenIdealDrafts.has(msg)) {
            // Assistant: one wire row per persisted text block — live streaming
            // splits bubbles at server_tool_call boundaries, and the persisted
            // content keeps those blocks separate. Ideal-review candidate drafts
            // are intentionally omitted to match the live pre-final hook flow.
            for (const blockText of restoreAssistantTexts(msg.content)) {
              history.push({
                role: "assistant",
                text: blockText,
                images: [],
                hook: null,
                command: false,
                compacted: false,
              });
            }
          }

          // Assistant tool_call blocks: detect sub-agent delegations.
          if (msg.role === "assistant" && typeof msg.content !== "string") {
            const subagentCalls = msg.content.filter(
              (
                c,
              ): c is typeof c & {
                type: "tool_call";
                id: string;
                name: string;
                args: Record<string, unknown>;
              } => c.type === "tool_call" && (c.name === "subagent" || c.name === "spawn_agent"),
            );
            if (subagentCalls.length > 0) {
              const agents = subagentCalls.map((c) => {
                const result = toolResultMap.get(c.id);
                return {
                  agentName:
                    c.name === "spawn_agent" && typeof c.args?.task_name === "string"
                      ? c.args.task_name
                      : typeof c.args?.agent === "string"
                        ? c.args.agent
                        : undefined,
                  // Async workers are intentionally non-resumable; restored rows are historical.
                  status: result?.isError ? ("error" as const) : ("done" as const),
                  toolUseCount: 0,
                };
              });
              history.push({
                role: "assistant",
                text: "",
                subagentGroup: agents,
              });
            }
          }

          // Interleave any Ken turns / autopilot / app markers recorded right
          // after this message.
          flushKen(nonSystemCount);
          flushAutopilot(nonSystemCount);
          flushAppMarkers(nonSystemCount);
        }

        // Flush remaining Ken turns whose anchor is at/after the message count so
        // none are dropped. Autopilot/app markers beyond the restored message
        // count were already filtered above; any remaining marker here is valid.
        for (const count of [...kenByCount.keys()].sort((a, b) => a - b)) flushKen(count);
        for (const count of [...autopilotByCount.keys()].sort((a, b) => a - b))
          flushAutopilot(count);
        for (const count of [...appMarkersByCount.keys()].sort((a, b) => a - b))
          flushAppMarkers(count);

        json(res, 200, { history });
      })();
      return;
    }

    if (method === "GET" && url === "/commands") {
      if (mode === "chat") {
        json(res, 200, { commands: [] });
        return;
      }
      // Workflow commands with agent functionality: built-in prompt templates +
      // the user's own `.gg/commands/*.md`.
      void (async () => {
        const builtins = PROMPT_COMMANDS.map((c) => ({
          name: c.name,
          aliases: c.aliases,
          description: c.description,
          source: "built-in" as const,
        }));
        const custom = (await loadCustomCommands(cwd))
          // A custom command can't shadow a built-in name.
          .filter((c) => !PROMPT_COMMANDS.some((b) => b.name === c.name))
          .map((c) => ({
            name: c.name,
            aliases: [] as string[],
            description: c.description,
            source: "custom" as const,
          }));
        json(res, 200, { commands: [...builtins, ...custom] });
      })();
      return;
    }

    if (method === "POST" && url === "/prompt") {
      void readBody(req).then(async (raw) => {
        let text: string;
        let attachments: AppAttachment[];
        let meta: { kenSent?: boolean; enhancements?: unknown[] } | undefined;
        try {
          const body = JSON.parse(raw) as {
            text?: string;
            attachments?: AppAttachment[];
            meta?: { kenSent?: boolean; enhancements?: unknown[] };
          };
          text = body.text ?? "";
          attachments = Array.isArray(body.attachments) ? body.attachments : [];
          meta = typeof body.meta === "object" && body.meta !== null ? body.meta : undefined;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!text.trim() && attachments.length === 0) {
          json(res, 400, { error: "empty prompt" });
          return;
        }
        if (runLifecycle.running && runLifecycle.isCancellationRequested(runLifecycle.generation)) {
          json(res, 409, {
            error: runLifecycle.state === "cancelling" ? "run_cancelling" : "cancel_failed",
            runState: runLifecycle.state,
          });
          return;
        }
        if (running || autopilotActive) {
          // Queue prompts as mid-run steering (mirrors the CLI). Also queue while
          // an autopilot cycle is active but between injected runs (build idle,
          // Ken reviewing) so the message never starts a run that collides with
          // an injected one on the same session. Attachments are persisted to
          // .gg/uploads first so the queued media rides the same native-block
          // path as a non-queued attachment prompt when it drains.
          const prepared = attachments.length > 0 ? await prepareAttachments(cwd, attachments) : [];
          const count = session.queueMessage(text, prepared);
          broadcast("queued", { count });
          json(res, 202, { queued: true, count });
          return;
        }
        json(res, 202, { accepted: true });
        // Webview display hint for this prompt's user bubble (kenSent shimmer
        // label / enhancer highlight segments). Anchored +1 so it attaches to
        // the user message the prompt below is about to push. Queued prompts
        // skip this (their position in the run is unpredictable).
        if (meta && (meta.kenSent === true || Array.isArray(meta.enhancements))) {
          void session
            .persistAppMarker(
              "user_hint",
              {
                ...(meta.kenSent === true ? { kenSent: true } : {}),
                ...(Array.isArray(meta.enhancements) ? { enhancements: meta.enhancements } : {}),
              },
              1,
            )
            .catch(() => {});
        }
        // Fresh user turn: clear any cancel flag left from a prior cycle so this
        // turn's autopilot review can run.
        autopilotCancelled = false;
        // A typed message while a plan modal/review is pending (reject,
        // feedback, anything) supersedes the pending plan — the bump also
        // invalidates any in-flight Ken plan review.
        clearPendingPlan();
        // Gate inputs captured around the run: whether this turn is a workflow
        // slash command (attachment prompts skip slash expansion entirely), and
        // how many assistant messages the run actually adds. Computed even when
        // autopilot is currently off — the toggle can flip ON mid-run, and the
        // gate reads the post-run value.
        const workflowCommand =
          attachments.length === 0 && isWorkflowCommandText(text, await loadWorkflowCommandSpecs());
        const assistantsBefore = countAssistantMessages(session.getMessages());
        const messagesBefore = session.getMessages().length;
        await runAgent(text, async () => {
          if (attachments.length > 0) {
            // Persist each attachment under .gg/uploads so files are inspectable
            // by the agent's tools, then prompt with the media as native blocks.
            const prepared = await prepareAttachments(cwd, attachments);
            await session.promptWithAttachments(text, prepared);
          } else {
            // Pass the raw text straight through. AgentSession.prompt() is the
            // single source of truth for slash-command expansion (built-in +
            // `.gg/commands/*.md` custom), so the agent gets the right body
            // while the webview keeps showing the short `/name`.
            await session.prompt(text);
          }
        });
        // After the user's run settles, kick off Ken's auto-review loop — but
        // only when the turn is actually reviewable (shouldStartAutopilotCycle):
        // workflow commands (/compare, /bullet-proof, …) end with reports or
        // A/B/C choices reserved for the USER; registry commands (/help) and
        // failed runs add no assistant work to judge; a turn that ended in plan
        // mode has a pending Accept/Reject modal Ken must not preempt. This is
        // the ONLY entry point into the cycle besides the stranded-queue drain —
        // it drives any follow-up GG Coder runs itself, so the shared runAgent
        // finally never recurses.
        const decision = shouldStartAutopilotCycle({
          enabled: autopilot,
          cancelled: autopilotCancelled,
          planMode: session.getPlanMode(),
          // A submitted plan (exit_plan fired) routes into the PLAN review
          // branch — the cycle reviews the plan itself instead of skipping.
          planPending: pendingPlanPath !== null,
          workflowCommand,
          assistantMessagesAdded: countAssistantMessages(session.getMessages()) - assistantsBefore,
          // Skip the review API call outright for turns that only started a
          // background process (dev server/watcher), ran a read-only lookup, or
          // committed/pushed — Ken's autopilot contract already IGNOREs these,
          // so there's no reason to pay for that verdict.
          mechanicalOnly: isMechanicalOnlyTurn(
            extractTurnToolCalls(session.getMessages(), messagesBefore),
          ),
        });
        if (decision.start) {
          log("INFO", "app-sidecar", "autopilot cycle starting", { kind: decision.kind });
          await runAutopilotCycle(text);
        } else if (autopilot) {
          log("INFO", "app-sidecar", "autopilot skipped", { reason: decision.reason });
        }
        // A prompt sent while Ken was reviewing (build idle) queued but had no
        // run to steer into — run it now as a fresh turn so it never strands.
        await runStrandedQueue();
      });
      return;
    }

    // Ken Kai (mentor): an independent read-only advisory run on the kenSession.
    // Runs concurrently with a build run — its events are ken_-prefixed so the
    // webview keeps the bubbles separate. The context digest is assembled fresh
    // from the BUILD session's transcript each turn (one-way mirror).
    if (method === "POST" && url === "/ken/prompt") {
      if (mode === "chat") {
        json(res, 404, { error: "Ken is not available in GG Chat." });
        return;
      }
      void readBody(req).then(async (raw) => {
        let text: string;
        try {
          text = (JSON.parse(raw) as { text?: string }).text ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!text.trim()) {
          json(res, 400, { error: "empty prompt" });
          return;
        }
        if (kenRunning) {
          json(res, 409, { error: "Ken is already thinking — wait for his reply." });
          return;
        }
        json(res, 202, { accepted: true });
        kenRunning = true;
        broadcast("ken_run_start", { text });
        try {
          const ken = await ensureKenSession();
          const digest = await buildKenContext(
            session,
            cwd,
            gitBranch,
            text,
            await loadWorkflowCommandSpecs(),
            injectedAutopilotPrompts,
          );
          await ken.prompt(digest);
          // Record the turn against the BUILD session so it persists + survives
          // resume (advisory custom entry, never an LLM message). Reply is Ken's
          // last assistant message; skip persistence if he produced nothing.
          const reply = lastAssistantText(ken.getMessages());
          if (reply.trim()) await session.persistKenTurn(text, reply);
        } catch (err) {
          broadcastError("ken_error", "ken run failed", err);
        } finally {
          kenRunning = false;
          broadcast("ken_run_end", {});
          const pending = pendingKenModel;
          pendingKenModel = null;
          if (pending) await syncKenModel(pending.provider, pending.model);
        }
      });
      return;
    }

    if (method === "POST" && url === "/ken/cancel") {
      kenAbort.abort();
      kenAbort = new AbortController();
      kenSession?.setSignal(kenAbort.signal);
      kenRunning = false;
      broadcast("ken_run_end", { cancelled: true });
      json(res, 200, { cancelled: true });
      return;
    }

    if (method === "POST" && url === "/autopilot") {
      if (mode === "chat") {
        json(res, 404, { error: "Autopilot is not available in GG Chat." });
        return;
      }
      void readBody(req).then(async (raw) => {
        let enabled: boolean;
        try {
          enabled = Boolean((JSON.parse(raw) as { enabled?: boolean }).enabled);
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        autopilot = enabled;
        // A toggle-off during an active cycle takes effect after Ken finishes;
        // until then, injected build runs must not re-enable Ideal self-review.
        session.setIdealReviewSuppressed(enabled || autopilotActive);
        await saveAutopilot(cwd, enabled);
        log("INFO", "app-sidecar", "autopilot toggled", { enabled: String(enabled) });
        broadcast("autopilot", { autopilot: enabled });
        json(res, 200, { autopilot: enabled });
      });
      return;
    }

    if (method === "POST" && url === "/enhance") {
      void readBody(req).then(async (raw) => {
        let text: string;
        try {
          text = (JSON.parse(raw) as { text?: string }).text ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!text.trim()) {
          json(res, 400, { error: "empty prompt" });
          return;
        }
        // An independent read-only LLM call — touches no session state, so it's
        // allowed even while a run is in flight.
        try {
          const result = await session.enhancePrompt(text);
          json(res, 200, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          captureSidecarError(err, "app-sidecar.prompt-enhancer");
          log("ERROR", "app-sidecar", "enhance failed", { message });
          json(res, 500, { error: message });
        }
      });
      return;
    }

    if (method === "GET" && url === "/tasks") {
      json(res, 200, { tasks: pruneDoneTasksSync(cwd) });
      return;
    }

    // ── Radio (app-wide) ──────────────────────────────────────
    // Radio is now APP-WIDE: all windows share one daemon process, and the
    // player lives in `core/radio.ts` module-level singletons (one stream for
    // the whole app). Any window's /radio reads/controls that single stream —
    // starting a station in one window replaces whatever was playing, and every
    // window's footer reflects the same `current`. This intentionally prevents
    // duplicate audio across windows (the original per-window goal), now for
    // free. (To restore per-window radio, key playback by sessionId.)
    if (method === "GET" && url === "/radio") {
      json(res, 200, {
        stations: RADIO_STATIONS,
        current: getCurrentStation(),
        volume: getRadioVolume(),
      });
      return;
    }

    if (method === "POST" && url === "/radio/volume") {
      void readBody(req).then((raw) => {
        let volume: number;
        try {
          volume = Number((JSON.parse(raw) as { volume?: number }).volume);
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!Number.isFinite(volume)) {
          json(res, 400, { error: "volume must be a number" });
          return;
        }
        const result = setRadioVolume(volume);
        if (!result.ok) {
          json(res, 400, { error: result.error ?? "Radio volume failed to update." });
          return;
        }
        json(res, 200, { current: getCurrentStation(), volume: getRadioVolume() });
      });
      return;
    }

    if (method === "POST" && url === "/radio") {
      void readBody(req).then((raw) => {
        let station: string;
        try {
          station = (JSON.parse(raw) as { station?: string }).station ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!station || station === "off") {
          stopRadio();
          json(res, 200, { current: null });
          return;
        }
        const result = playRadio(station);
        if (!result.ok) {
          json(res, 400, { error: result.error ?? "Radio failed to start." });
          return;
        }
        json(res, 200, { current: getCurrentStation() });
      });
      return;
    }

    if (method === "POST" && url === "/tasks/run") {
      void readBody(req).then((raw) => {
        let id: string | null;
        let all: boolean;
        try {
          const body = JSON.parse(raw) as { id?: string | null; all?: boolean };
          id = body.id ?? null;
          all = Boolean(body.all);
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (running) {
          json(res, 409, { error: "cannot run a task while the agent is running" });
          return;
        }
        json(res, 202, { accepted: true });
        void runTasks(id, all);
      });
      return;
    }

    if (method === "POST" && url === "/tasks/delete") {
      void readBody(req).then((raw) => {
        let id: string;
        try {
          id = (JSON.parse(raw) as { id?: string }).id ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!id.trim()) {
          json(res, 400, { error: "missing task id" });
          return;
        }
        const remaining = loadTasksSync(cwd).filter((t) => t.id !== id && !t.id.startsWith(id));
        saveTasksSync(cwd, remaining);
        json(res, 200, { tasks: remaining });
      });
      return;
    }

    if (method === "GET" && url === "/models") {
      void (async () => {
        const loggedIn: Provider[] = [];
        for (const p of ALL_PROVIDERS) {
          if (await auth.hasProviderAuth(p)) loggedIn.push(p);
        }
        // Just the names, grouped by provider in registry order — the UI shows
        // a clean multi-column list of model ids.
        const models = MODELS.filter((m) => loggedIn.includes(m.provider)).map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
        }));
        json(res, 200, { models });
      })();
      return;
    }

    if (method === "POST" && url === "/model") {
      void readBody(req).then(async (raw) => {
        let modelId: string;
        try {
          modelId = (JSON.parse(raw) as { model?: string }).model ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const target = getModel(modelId);
        if (!target) {
          json(res, 404, { error: `unknown model: ${modelId}` });
          return;
        }
        if (running) {
          json(res, 409, { error: "cannot switch model while running" });
          return;
        }
        await session.switchModel(target.provider, target.id);
        // Ken follows GG Coder's model only while un-pinned; a user-set Ken
        // override survives GG model switches untouched.
        if (!kenModelOverride) {
          await syncKenModel(target.provider, target.id);
          await syncKenAutoModel(target.provider, target.id);
        }
        // Clamp the reasoning level to what the new model supports (mirrors the
        // CLI): keep thinking on at the first supported tier if it was on but
        // the prior level is unsupported here; leave it off if it was off.
        const prevLevel = session.getThinkingLevel();
        if (prevLevel && !isThinkingLevelSupported(target.provider, target.id, prevLevel)) {
          session.setThinkingLevel(getNextThinkingLevel(target.provider, target.id, undefined));
        }
        // Persist per-project so THIS window/project restores its own model on
        // restart (not the single global slot every window shares). Keep the
        // global write too as a "last used" fallback for never-opened projects
        // and so the CLI stays in sync.
        await saveProjectModelPrefs(cwd, {
          provider: target.provider,
          model: target.id,
          thinkingEnabled: !!session.getThinkingLevel(),
          thinkingLevel: session.getThinkingLevel() ?? undefined,
        });
        await persistModelSelection(paths.settingsFile, target.provider, target.id);
        await persistThinkingLevel(paths.settingsFile, session.getThinkingLevel());
        const payload = {
          thinkingLevel: session.getThinkingLevel() ?? null,
          supportedThinkingLevels: getSupportedThinkingLevels(target.provider, target.id),
        };
        // model_change is emitted by switchModel; follow with thinking_change so
        // the footer toggle reflects the new model's supported levels.
        broadcast("thinking_change", payload);
        // Un-pinned Ken just followed the switch — update his footer chip too.
        // When Ken is pinned, his effective model did not change, so skip the
        // no-op event (keeps footer/event tests from treating a GG switch as a
        // Ken switch).
        if (!kenModelOverride) broadcast("ken_model_change", kenStatePayload());
        // The new model usually has a different context window — push extras so
        // the footer's context meter rescales immediately.
        broadcast("extras", footerExtras());
        json(res, 200, { provider: target.provider, model: target.id, ...payload });
      });
      return;
    }

    // Set or clear Ken's model pin. Body: { model: "<id>" } to pin, or
    // { model: null } / "" to clear (Ken resumes following GG Coder). Applies
    // to BOTH Ken sessions (chat + autopilot reviewer); a switch landing while
    // either is mid-run defers via the pending-model mechanics.
    if (method === "POST" && url === "/ken/model") {
      void readBody(req).then(async (raw) => {
        let modelId: string | null;
        try {
          const parsed = (JSON.parse(raw) as { model?: string | null }).model;
          modelId = typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (modelId === null) {
          // Clear the pin → follow GG Coder again, syncing both sessions back.
          kenModelOverride = null;
          await saveKenModelPref(cwd, null);
          const st = session.getState();
          await syncKenModel(st.provider, st.model);
          await syncKenAutoModel(st.provider, st.model);
          log("INFO", "app-sidecar", "ken model pin cleared — following GG", {
            provider: st.provider,
            model: st.model,
          });
        } else {
          const target = getModel(modelId);
          if (!target) {
            json(res, 404, { error: `unknown model: ${modelId}` });
            return;
          }
          kenModelOverride = { provider: target.provider, model: target.id };
          await saveKenModelPref(cwd, kenModelOverride);
          await syncKenModel(target.provider, target.id);
          await syncKenAutoModel(target.provider, target.id);
          log("INFO", "app-sidecar", "ken model pinned", {
            provider: target.provider,
            model: target.id,
          });
        }
        const payload = kenStatePayload();
        broadcast("ken_model_change", payload);
        json(res, 200, payload);
      });
      return;
    }

    if (method === "POST" && url === "/kill") {
      void readBody(req).then(async (raw) => {
        let id: string;
        try {
          id = (JSON.parse(raw) as { id?: string }).id ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!id.trim()) {
          json(res, 400, { error: "missing task id" });
          return;
        }
        const message = await session.killBackgroundProcess(id);
        // Push the updated task list right away rather than waiting for the poll.
        broadcast("tasks", { tasks: session.listBackgroundProcesses() });
        json(res, 200, { message });
      });
      return;
    }

    if (method === "POST" && url === "/thinking") {
      const st = session.getState();
      const next = getNextThinkingLevel(st.provider, st.model, session.getThinkingLevel());
      session.setThinkingLevel(next);
      // Persist per-project so THIS window restores its thinking state on
      // restart; keep the global write as a fallback (mirrors the CLI).
      void saveProjectModelPrefs(cwd, {
        provider: st.provider,
        model: st.model,
        thinkingEnabled: !!next,
        thinkingLevel: next ?? undefined,
      }).then(() => persistThinkingLevel(paths.settingsFile, next));
      const payload = {
        thinkingLevel: next ?? null,
        supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
      };
      broadcast("thinking_change", payload);
      json(res, 200, payload);
      return;
    }

    if (method === "POST" && url === "/cancel") {
      void (async () => {
        // Even between task runs, cancellation stops the sweep. Active provider
        // ownership invokes the full abort hook exactly once through lifecycle.
        taskRunAll = false;
        autopilotCancelled = true;
        if (!runLifecycle.running) {
          kenAutoAbort.abort();
          kenAutoAbort = new AbortController();
          kenAutoSession?.setSignal(kenAutoAbort.signal);
        }

        const generation = runLifecycle.generation;
        if (!pendingCancelDrain || pendingCancelDrain.generation !== generation) {
          pendingCancelDrain = { generation, text: session.drainQueue() };
          broadcast("queued", { count: 0 });
        }
        const result = await runLifecycle.cancel(CANCEL_TIMEOUT_MS);
        const drained = pendingCancelDrain.text;
        if (result.status === "failed") {
          broadcast("cancel_failed", {
            error: "cancel_failed",
            reason: result.reason,
            runState: runLifecycle.state,
          });
          json(res, 504, {
            error: "cancel_failed",
            reason: result.reason,
            runState: runLifecycle.state,
            drained,
          });
          return;
        }
        json(res, 200, {
          cancelled: result.status === "cancelled",
          runState: runLifecycle.state,
          drained,
        });
      })().catch((error) => {
        captureSidecarError(error, "app-sidecar.run.cancel");
        broadcast("cancel_failed", { error: "cancel_failed", runState: runLifecycle.state });
        json(res, 500, {
          error: "cancel_failed",
          message: error instanceof Error ? error.message : String(error),
          runState: runLifecycle.state,
        });
      });
      return;
    }

    if (method === "POST" && url === "/new-session") {
      if (running) {
        json(res, 409, { error: "cannot start a new session while running" });
        return;
      }
      void session
        .newSession()
        .then(async () => {
          if (mode === "chat") {
            await session.persistAppMarker("agent_handoff", { chatAgent });
          }
          deactivateApprovedPlan();
          injectedAutopilotPrompts = [];
          clearPendingPlan();
          broadcast("session_reset", {});
          json(res, 200, { ok: true });
        })
        .catch((err) => {
          captureSidecarError(err, "app-sidecar.session.new");
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }

    // Accept an approved plan and begin implementation in a FRESH session
    // (mirrors the CLI's handleApprovePlan). The plan-mode conversation — all the
    // research, file reads, and exploration done while drafting — must NOT bleed
    // into the build, or it bloats the context and distracts the model. So:
    //   1. newSession() wipes history + starts a new session file.
    //   2. setApprovedPlan() bakes the plan into the fresh system prompt so the
    //      model emits `[DONE:n]` markers the plan-progress widget reads.
    //   3. session_reset tells the webview to clear its transcript; it then runs
    //      the "implement it now" prompt in the clean session.
    if (method === "POST" && url === "/plan/accept") {
      void readBody(req).then(async (raw) => {
        let planPath: string | undefined;
        try {
          planPath = (JSON.parse(raw) as { planPath?: string }).planPath || undefined;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (running) {
          json(res, 409, { error: "cannot accept a plan while the agent is running" });
          return;
        }
        // Manual accept, possibly racing Ken's autopilot plan review: the user
        // always wins. Bump the plan generation (invalidates any in-flight
        // review's verdict), stop the cycle, abort a mid-prompt review on the
        // kenAuto session, and clear the spinner — autopilot_ignored renders
        // nothing, so no stale "approve or reject" bubble ever lands. The
        // webview's follow-up "implement" /prompt arrives as a fresh turn
        // (resetting autopilotCancelled), so the implementation still gets its
        // normal post-run review; if it lands while the cycle is winding down
        // it queues and runStrandedQueue drains it as a fresh turn.
        clearPendingPlan();
        autopilotCancelled = true;
        kenAutoAbort.abort();
        kenAutoAbort = new AbortController();
        kenAutoSession?.setSignal(kenAutoAbort.signal);
        if (autopilotReviewing) {
          autopilotReviewing = false;
          broadcast("autopilot_ignored", {});
        }
        try {
          await session.newSession(true);
          injectedAutopilotPrompts = [];
          const planTotal = await activateApprovedPlan(planPath);
          broadcast("session_reset", { planTotal });
          broadcast("plan_progress", planProgressPayload());
          json(res, 200, { ok: true, planTotal });
        } catch (err) {
          captureSidecarError(err, "app-sidecar.plan.accept");
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }

    // ── Provider auth (login) ───────────────────────────────
    if (method === "GET" && url === "/auth/status") {
      void authStatusPayload().then((payload) => json(res, 200, payload));
      return;
    }

    if (method === "POST" && url === "/auth/apikey") {
      void readBody(req).then(async (raw) => {
        let provider = "";
        let key: string;
        let variant: string | undefined;
        try {
          const body = JSON.parse(raw) as { provider?: string; key?: string; variant?: string };
          provider = body.provider ?? "";
          key = (body.key ?? "").trim();
          variant = body.variant;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const meta = AUTH_PROVIDERS.find((p) => p.value === provider);
        if (!meta || !meta.methods.includes("apikey")) {
          json(res, 400, { error: "provider does not support API key auth" });
          return;
        }
        if (!key) {
          json(res, 400, { error: "API key is required" });
          return;
        }
        // Providers with multiple API-key variants (currently only Xiaomi: Token
        // Plan vs. API Credits) store under the chosen variant's key/baseUrl,
        // defaulting to the first variant. Single-variant providers fall back to
        // the legacy provider-id storage key + flat apiKeyBaseUrl.
        const chosenVariant =
          meta.apiKeyVariants?.find((v) => v.key === variant) ?? meta.apiKeyVariants?.[0];
        const storageKey = chosenVariant?.key ?? provider;
        const baseUrl = chosenVariant?.baseUrl ?? meta.apiKeyBaseUrl;
        const creds: OAuthCredentials = {
          accessToken: key,
          refreshToken: "",
          expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 * 100, // ~100y
          ...(baseUrl ? { baseUrl } : {}),
        };
        await auth.setCredentials(storageKey, creds);
        broadcast("auth_done", { provider });
        json(res, 200, { ok: true });
      });
      return;
    }

    if (method === "POST" && url === "/auth/oauth/start") {
      void readBody(req).then((raw) => {
        let provider = "";
        try {
          provider = (JSON.parse(raw) as { provider?: string }).provider ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const meta = AUTH_PROVIDERS.find((p) => p.value === provider);
        if (!meta || !meta.methods.includes("oauth")) {
          json(res, 400, { error: "provider does not support OAuth" });
          return;
        }
        if (oauthInFlight) {
          json(res, 409, { error: "a login is already in progress" });
          return;
        }
        oauthInFlight = true;
        json(res, 202, { accepted: true });
        void (async () => {
          const cb = authCallbacks();
          try {
            let creds: OAuthCredentials;
            let storageKey = provider;
            if (provider === "anthropic") creds = await loginAnthropic(cb);
            else if (provider === "openai") creds = await loginOpenAI(cb);
            else if (provider === "gemini") creds = await loginGemini(cb);
            else if (provider === "moonshot") {
              creds = await loginKimi(cb);
              storageKey = MOONSHOT_OAUTH_KEY;
            } else {
              throw new Error(`OAuth not implemented for ${provider}`);
            }
            await auth.setCredentials(storageKey, creds);
            broadcast("auth_done", { provider });
          } catch (err) {
            captureSidecarError(err, "app-sidecar.auth.oauth", { provider });
            broadcast("auth_error", {
              provider,
              message: err instanceof Error ? err.message : String(err),
            });
          } finally {
            oauthInFlight = false;
            pendingCode = null;
          }
        })();
      });
      return;
    }

    if (method === "POST" && url === "/auth/oauth/code") {
      void readBody(req).then((raw) => {
        let code: string;
        try {
          code = (JSON.parse(raw) as { code?: string }).code ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!pendingCode) {
          json(res, 409, { error: "no login is awaiting a code" });
          return;
        }
        pendingCode(code.trim());
        pendingCode = null;
        json(res, 200, { ok: true });
      });
      return;
    }

    if (method === "POST" && url === "/auth/logout") {
      void readBody(req).then(async (raw) => {
        let provider: string;
        try {
          provider = (JSON.parse(raw) as { provider?: string }).provider ?? "";
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        await auth.clearCredentials(provider);
        // Moonshot's OAuth credential lives under a distinct key — clear both so
        // "disconnect" fully removes Kimi OAuth and the API key.
        if (provider === "moonshot") await auth.clearCredentials(MOONSHOT_OAUTH_KEY);
        // Xiaomi's API Credits credential lives under a distinct key — clear it
        // too so "disconnect" fully removes both the Token Plan and Credits keys.
        if (provider === "xiaomi") await auth.clearCredentials(XIAOMI_CREDITS_KEY);
        broadcast("auth_done", { provider });
        json(res, 200, { ok: true });
      });
      return;
    }

    // ── Telegram config (mirrors `ggcoder telegram`) ─────────
    if (method === "GET" && url === "/telegram") {
      void loadTelegramConfig().then((cfg) => {
        if (!cfg) {
          json(res, 200, { configured: false });
          return;
        }
        // Never return the raw token to the webview — a short masked preview is
        // enough to show "already set".
        const t = cfg.botToken;
        const tokenPreview = t.length > 14 ? `${t.slice(0, 10)}\u2026${t.slice(-4)}` : "set";
        json(res, 200, { configured: true, userId: cfg.userId, tokenPreview });
      });
      return;
    }

    if (method === "POST" && url === "/telegram") {
      void readBody(req).then(async (raw) => {
        let botTokenInput: string;
        let userIdInput: string;
        try {
          const body = JSON.parse(raw) as { botToken?: string; userId?: string | number };
          botTokenInput = (body.botToken ?? "").trim();
          userIdInput = String(body.userId ?? "").trim();
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        // Keep the existing token when the field is left blank (the webview shows
        // a masked preview, not the real token).
        const existing = await loadTelegramConfig();
        const botToken = botTokenInput || existing?.botToken || "";
        if (!botToken) {
          json(res, 400, { error: "Bot token is required." });
          return;
        }
        const userId = userIdInput ? parseInt(userIdInput, 10) : existing?.userId;
        if (!userId || Number.isNaN(userId)) {
          json(res, 400, { error: "A numeric Telegram user ID is required." });
          return;
        }
        const verified = await verifyBotToken(botToken);
        if (!verified.ok) {
          json(res, 400, { error: "Invalid bot token — Telegram rejected it." });
          return;
        }
        await saveTelegramConfig({ botToken, userId });
        json(res, 200, { ok: true, userId, username: verified.username ?? null });
      });
      return;
    }

    // ── Serve lifecycle (mirrors `ggcoder serve`) ───────────
    if (method === "GET" && url === "/serve") {
      void loadTelegramConfig().then((cfg) =>
        json(res, 200, { running: serveController !== null, configured: cfg !== null }),
      );
      return;
    }

    if (method === "POST" && url === "/serve/start") {
      void (async () => {
        if (serveController) {
          json(res, 200, { running: true });
          return;
        }
        const cfg = await loadTelegramConfig();
        if (!cfg) {
          json(res, 400, { error: "Telegram isn't set up yet. Open Serve settings first." });
          return;
        }
        const st = session.getState();
        try {
          serveController = await startServeMode({
            provider: st.provider,
            model: st.model,
            cwd,
            version: "app",
            thinkingLevel: session.getThinkingLevel() ?? undefined,
            telegram: { botToken: cfg.botToken, userId: cfg.userId },
            embedded: true,
          });
          broadcast("serve_change", { running: true });
          log("INFO", "app-sidecar", "serve started", { userId: cfg.userId });
          json(res, 200, { running: true });
        } catch (err) {
          serveController = null;
          captureSidecarError(err, "app-sidecar.serve.start", { provider: st.provider });
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return;
    }

    if (method === "POST" && url === "/serve/stop") {
      void (async () => {
        if (serveController) {
          await serveController.stop().catch(() => {});
          serveController = null;
          broadcast("serve_change", { running: false });
          log("INFO", "app-sidecar", "serve stopped");
        }
        json(res, 200, { running: false });
      })();
      return;
    }

    // ── MCP server management (mirrors `ggcoder mcp`) ──────────────────
    // `targetCwd` (project scope) overrides the window cwd so a server can be
    // added/removed for ANY discovered project, not just this window's. Global
    // scope ignores it (always ~/.gg/mcp.json).
    if (method === "GET" && (url === "/mcp" || url.startsWith("/mcp?"))) {
      const targetCwd = new URL(url, `http://${host}`).searchParams.get("cwd") ?? cwd;
      void buildMcpRows(targetCwd)
        .then((servers) => json(res, 200, { servers }))
        .catch((err) => {
          captureSidecarError(err, "app-sidecar.mcp.list");
          log("ERROR", "app-sidecar", "buildMcpRows failed", {
            message: err instanceof Error ? err.message : String(err),
          });
          json(res, 200, { servers: [] });
        });
      return;
    }

    if (method === "POST" && url === "/mcp/add") {
      void readBody(req).then(async (raw) => {
        let line: string;
        let scopeValue: string;
        let bodyCwd: string | undefined;
        try {
          const body = JSON.parse(raw) as {
            line?: string;
            scope?: string;
            cwd?: string;
          };
          line = body.line ?? "";
          scopeValue = body.scope ?? "global";
          bodyCwd = body.cwd;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const scope: MCPScope = scopeValue === "project" ? "project" : "global";
        if (scope === "project" && !bodyCwd) {
          json(res, 400, { error: "project scope requires a project (cwd)." });
          return;
        }
        const targetCwd = bodyCwd ?? cwd;
        const parsed = parseMcpAddCommand(line);
        if (!parsed.ok) {
          json(res, 400, { error: parsed.error });
          return;
        }
        const config = parsed.value.config;
        try {
          // Best-effort probe — never blocks the save. A failed connect is
          // surfaced to the UI but the config is still persisted (mirrors the
          // CLI). probeMcp swallows connect errors; the try/catch guards the
          // persist step so a write failure returns a 500 instead of becoming
          // an unhandled rejection that would crash the sidecar.
          const probe = await probeMcp(config);
          const saved = await addServer(config, scope, targetCwd, true);
          if (!saved.ok) {
            json(res, 400, { error: saved.error });
            return;
          }
          json(res, 200, {
            ok: true,
            name: config.name,
            connected: probe.ok,
            toolCount: probe.toolCount,
            error: probe.error,
            requiresAuth: probe.requiresAuth,
          });
        } catch (err) {
          captureSidecarError(err, "app-sidecar.mcp.add", { server: config.name });
          json(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
      return;
    }

    if (method === "POST" && url === "/mcp/remove") {
      void readBody(req).then(async (raw) => {
        let name: string;
        let scopeValue: string;
        let bodyCwd: string | undefined;
        try {
          const body = JSON.parse(raw) as {
            name?: string;
            scope?: string;
            cwd?: string;
          };
          name = body.name ?? "";
          scopeValue = body.scope ?? "global";
          bodyCwd = body.cwd;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!name.trim()) {
          json(res, 400, { error: "missing server name" });
          return;
        }
        const scope: MCPScope = scopeValue === "project" ? "project" : "global";
        if (scope === "project" && !bodyCwd) {
          json(res, 400, { error: "project scope requires a project (cwd)." });
          return;
        }
        const targetCwd = bodyCwd ?? cwd;
        const removed = await removeServer(name, scope, targetCwd);
        // Drop any saved OAuth tokens for this server so a re-add starts clean.
        await new McpOAuthStore().clear(name).catch(() => {});
        json(res, 200, { removed });
      });
      return;
    }

    // Interactive OAuth login for a remote (HTTP) MCP server. The browser is
    // opened by the webview in response to the broadcast `mcp_auth_url` event;
    // progress + outcome stream via `mcp_auth_status` / `mcp_auth_done` /
    // `mcp_auth_error`. Responds 202 immediately and runs the flow in the
    // background (the browser round-trip can take a while).
    if (method === "POST" && url === "/mcp/login") {
      void readBody(req).then(async (raw) => {
        let name: string;
        let scopeValue: string;
        let bodyCwd: string | undefined;
        try {
          const body = JSON.parse(raw) as { name?: string; scope?: string; cwd?: string };
          name = body.name ?? "";
          scopeValue = body.scope ?? "global";
          bodyCwd = body.cwd;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!name.trim()) {
          json(res, 400, { error: "missing server name" });
          return;
        }
        const scope: MCPScope = scopeValue === "project" ? "project" : "global";
        const targetCwd = bodyCwd ?? cwd;
        const scoped = await getServer(name, targetCwd);
        if (!scoped || scoped.scope !== scope) {
          json(res, 404, { error: `No "${name}" server found.` });
          return;
        }
        if (!scoped.config.url) {
          json(res, 400, { error: "Login is only supported for HTTP MCP servers." });
          return;
        }
        json(res, 202, { accepted: true });
        broadcast("mcp_auth_status", { name, message: "Starting login\u2026" });
        const manager = new MCPClientManager();
        try {
          const result = await manager.login(scoped.config, (authUrl) => {
            broadcast("mcp_auth_url", { name, url: authUrl });
          });
          if (result.ok) {
            broadcast("mcp_auth_done", { name, toolCount: result.toolCount });
          } else {
            broadcast("mcp_auth_error", { name, message: result.error ?? "Login failed." });
          }
        } catch (err) {
          captureSidecarError(err, "app-sidecar.mcp.login", { server: name });
          broadcast("mcp_auth_error", {
            name,
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await manager.dispose().catch(() => {});
        }
      });
      return;
    }

    json(res, 404, { error: "not found" });
  }

  async function dispose(): Promise<void> {
    tasksPollStopped = true;
    if (tasksPoll) clearTimeout(tasksPoll);
    gitPollStopped = true;
    if (gitPoll) clearTimeout(gitPoll);
    // Stop the Telegram serve loop + dispose its per-chat sessions.
    if (serveController) await serveController.stop().catch(() => {});
    for (const c of clients) c.res.end();
    kenAbort.abort();
    kenAutoAbort.abort();
    await kenSession?.dispose().catch(() => {});
    await kenAutoSession?.dispose().catch(() => {});
    await session.dispose().catch(() => {});
  }

  return {
    id: opts.id,
    mode,
    get chatAgent() {
      return chatAgent;
    },
    cwd,
    sessionPath: opts.sessionPath,
    session,
    clients,
    broadcast,
    handle,
    dispose,
  };
}

main().catch(async (err) => {
  captureSidecarError(err, "app-sidecar.main", { severity: "fatal" });
  await flushSidecarErrors();
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`GG_APP_FATAL ${message}\n`);
  process.exit(1);
});
