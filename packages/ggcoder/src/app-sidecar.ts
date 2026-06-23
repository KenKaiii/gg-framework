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
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { ToolResultContent } from "@kenkaiiii/gg-ai";
import type { AddressInfo } from "node:net";
import { runJsonMode } from "./modes/json-mode.js";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./core/agent-session.js";
import { AuthStorage } from "./core/auth-storage.js";
import { MOONSHOT_OAUTH_KEY } from "@kenkaiiii/gg-core";
import { loginAnthropic } from "./core/oauth/anthropic.js";
import { loginOpenAI } from "./core/oauth/openai.js";
import { loginGemini } from "./core/oauth/gemini.js";
import { loginKimi } from "./core/oauth/kimi.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./core/oauth/types.js";
import { AUTH_PROVIDERS, type AuthProviderMeta } from "./core/auth-providers.js";
import { ensureAppDirs, loadSavedSettings } from "./config.js";
import { SettingsManager, type Settings } from "./core/settings-manager.js";
import { getModel, getMaxThinkingLevel, getContextWindow, MODELS } from "./core/model-registry.js";
import { resolveStartOrFallback } from "./core/resolve-start.js";
import { getGitBranch, isGitRepo } from "./utils/git.js";
import {
  getNextThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevelSupported,
} from "./core/thinking-level.js";
import { PROMPT_COMMANDS } from "./core/prompt-commands.js";
import { loadCustomCommands } from "./core/custom-commands.js";
import { discoverProjects, listRecentSessions } from "./core/project-discovery.js";
import {
  loadTasksSync,
  saveTasksSync,
  getNextPendingTask,
  markTaskInProgress,
} from "./core/tasks-store.js";
import { initLogger, log } from "./core/logger.js";
import { RADIO_STATIONS, getCurrentStation, playRadio, stopRadio } from "./core/radio.js";
import { enrichProcessPath } from "./core/shell-path.js";
import { downscaleForPreview } from "./utils/image.js";
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

const ALL_PROVIDERS: Provider[] = [
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
    try {
      await fs.writeFile(filePath, Buffer.from(a.data, "base64"));
      out.push({ ...a, path: filePath });
    } catch {
      out.push({ ...a });
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
      "prompt-cache-key": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const maxTurnsRaw = values["max-turns"];
  await runJsonMode({
    message: positionals[0] ?? "",
    provider: (values.provider ?? "anthropic") as Provider,
    model: values.model ?? "claude-opus-4-8",
    cwd: process.cwd(),
    systemPrompt: values["system-prompt"],
    maxTurns: maxTurnsRaw ? parseInt(maxTurnsRaw, 10) : undefined,
    promptCacheKey: values["prompt-cache-key"],
  }).catch((err: unknown) => {
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

  const auth = new AuthStorage(paths.authFile);
  await auth.load();

  // Every window's session lives here as an in-process object, keyed by the id
  // the daemon hands back from POST /session. The Rust shell routes each proxy
  // request to its window's session via the `x-gg-session` header (and the
  // `?session=` query for the SSE /events stream).
  const sessions = new Map<string, SessionContext>();

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

  const server = http.createServer((req, res) => {
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
    // Create a session for a window: { cwd, sessionPath? } → { sessionId }.
    if (method === "POST" && url === "/session") {
      void daemonReadBody(req).then(async (raw) => {
        let body: { cwd?: unknown; sessionPath?: unknown } = {};
        try {
          body = raw ? (JSON.parse(raw) as typeof body) : {};
        } catch {
          /* empty/invalid body → defaults below */
        }
        const sessionCwd =
          typeof body.cwd === "string" && body.cwd
            ? body.cwd
            : (process.env.GG_APP_CWD ?? process.cwd());
        const sessionPath =
          typeof body.sessionPath === "string" && body.sessionPath ? body.sessionPath : undefined;
        const id = randomUUID();
        try {
          const ctx = await createSession({ auth, paths }, { id, cwd: sessionCwd, sessionPath });
          sessions.set(id, ctx);
          log("INFO", "app-sidecar", "session created", { id, cwd: sessionCwd });
          daemonJson(res, 200, { sessionId: id });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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

    // ── Per-session delegation ───────────────────────────────────────────
    const id = sessionIdFromReq(req, url);
    const ctx = id ? sessions.get(id) : undefined;
    if (!ctx) {
      daemonJson(res, 404, { error: "unknown session" });
      return;
    }
    ctx.handle(req, res, url, method);
  });
  server.listen(port, host, () => {
    const addr = server.address() as AddressInfo;
    // The Rust shell reads this line to learn the daemon port.
    process.stdout.write(`GG_APP_LISTENING ${addr.port}\n`);
    log("INFO", "app-sidecar", "daemon listening", { port: String(addr.port), host });
  });

  const shutdown = async (): Promise<void> => {
    // Radio playback is app-wide (one stream across all windows), so it stops
    // at the daemon level, not per session.
    stopRadio();
    await Promise.all([...sessions.values()].map((c) => c.dispose().catch(() => {})));
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

interface SessionContext {
  id: string;
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
  deps: { auth: AuthStorage; paths: Awaited<ReturnType<typeof ensureAppDirs>> },
  opts: { id: string; cwd: string; sessionPath?: string },
): Promise<SessionContext> {
  const { auth } = deps;
  const paths = deps.paths;
  const cwd = opts.cwd;
  // Base host for parsing request-URL query params (value is irrelevant to
  // parsing); the daemon owns the real listen host.
  const host = "127.0.0.1";

  const saved = loadSavedSettings(paths.settingsFile);
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
  const thinkEnabled = projectPrefs?.thinkingEnabled ?? saved.thinkingEnabled;
  const thinkingLevel: ThinkingLevel | undefined = thinkEnabled
    ? (projectPrefs?.thinkingLevel ?? saved.thinkingLevel ?? getMaxThinkingLevel(model))
    : undefined;

  // ── SSE fan-out (declared before the session so plan callbacks can use it) ─
  const clients = new Set<SseClient>();
  let clientSeq = 0;

  function broadcast(type: string, data: unknown): void {
    const frame = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const c of clients) c.res.write(frame);
  }

  // The session file path to resume (passed by the daemon's POST /session);
  // empty/unset starts a fresh session.
  const resumeSessionPath = opts.sessionPath;

  let abort = new AbortController();
  const session = new AgentSession({
    provider,
    model,
    cwd,
    thinkingLevel,
    sessionId: resumeSessionPath,
    signal: abort.signal,
    // The shell gates window readiness on the GG_APP_LISTENING handshake, which
    // can't fire until initialize() resolves. Connect MCP in the background so a
    // slow or hanging stdio server (e.g. a first-run `npx -y @playwright/mcp`
    // download) can't delay the sidecar past the webview's startup timeout
    // ("sidecar did not start in time"). Tools attach when the servers come up.
    backgroundMcpConnect: true,
    // Plan mode: the agent's enter_plan/exit_plan tools drive these. We flip
    // session plan state (rebuilds the system prompt + enforces read-only
    // tools) and surface the transition to the webview.
    onEnterPlan: async (reason) => {
      await session.setPlanMode(true);
      broadcast("plan_enter", { reason: reason ?? "" });
    },
    onExitPlan: async (planPath: string) => {
      await session.setPlanMode(false);
      // Surface the plan's path + markdown so the webview can show the review
      // modal (Accept / Feedback / Reject). Best-effort content read.
      let content: string;
      try {
        content = await fs.readFile(planPath, "utf-8");
      } catch {
        content = "";
      }
      broadcast("plan_exit", { planPath, content });
      return "Plan submitted for user review. Wait for the user to approve, reject, or dismiss it before implementing.";
    },
  });
  await session.initialize();
  log("INFO", "app-sidecar", "session ready", { provider, model, cwd });

  // Footer extras (context window, git branch, background tasks). The git
  // branch is resolved once at startup and refreshed lazily; the context
  // window follows the active model.
  let gitBranch: string | null = await getGitBranch(cwd).catch(() => null);
  let gitIsRepo: boolean = await isGitRepo(cwd).catch(() => false);
  function currentContextWindow(): number {
    const st = session.getState();
    return getContextWindow(st.model, { provider: st.provider });
  }
  // Shared shape merged into /state + the SSE `ready` frame so the footer can
  // render context %, branch, and tasks immediately on connect.
  function footerExtras(): {
    contextWindow: number;
    gitBranch: string | null;
    isGitRepo: boolean;
    tasks: ReturnType<typeof session.listBackgroundProcesses>;
  } {
    return {
      contextWindow: currentContextWindow(),
      gitBranch,
      isGitRepo: gitIsRepo,
      tasks: session.listBackgroundProcesses(),
    };
  }

  // tool_call_end carries no tool name (only the id), so remember each call's
  // name from tool_call_start to log a useful line on completion. Mirrors the
  // CLI's logging so the app sidecar's ~/.gg/gg-app-sidecar.log records tool
  // failures (e.g. repeated invalid-argument errors) instead of leaving the
  // fatal-abort path with no forensic trail.
  const toolCallNames = new Map<string, string>();

  // Forward every relevant bus event to the webview.
  session.eventBus.on("text_delta", (d) => broadcast("text_delta", d));
  session.eventBus.on("thinking_delta", (d) => broadcast("thinking_delta", d));
  session.eventBus.on("tool_call_start", (d) => {
    toolCallNames.set(d.toolCallId, d.name);
    broadcast("tool_call_start", d);
  });
  session.eventBus.on("tool_call_update", (d) => broadcast("tool_call_update", d));
  session.eventBus.on("tool_call_end", (d) => {
    const name = toolCallNames.get(d.toolCallId) ?? "unknown";
    toolCallNames.delete(d.toolCallId);
    log(d.isError ? "ERROR" : "INFO", "tool", `Tool call ended: ${name}`, {
      id: d.toolCallId,
      durationMs: String(d.durationMs),
      isError: String(d.isError),
      ...(d.isError ? { result: d.result.slice(0, 500) } : {}),
    });
    broadcast("tool_call_end", d);
  });
  // Native server tools (e.g. Anthropic web_search) do NOT end the turn — text
  // streams before and after them in the SAME turn. The webview must reset its
  // streaming bubble here, or the two text blocks concatenate with no separator
  // ("…command.Let me pull…"). Mirrors the TUI's server_tool_call handling.
  session.eventBus.on("server_tool_call", (d) => broadcast("server_tool_call", d));
  session.eventBus.on("turn_end", (d) => broadcast("turn_end", d));
  session.eventBus.on("agent_done", (d) => broadcast("agent_done", d));
  session.eventBus.on("error", (d) => {
    const message = d.error instanceof Error ? d.error.message : String(d.error);
    log("ERROR", "app-sidecar", "agent error", { message });
    broadcast("error", { message });
  });
  session.eventBus.on("model_change", (d) => broadcast("model_change", d));
  session.eventBus.on("hook", (d) => broadcast("hook", d));
  session.eventBus.on("compaction_start", (d) => broadcast("compaction_start", d));
  session.eventBus.on("compaction_end", (d) => broadcast("compaction_end", d));

  let running = false;
  let titleGenerated = false;

  // ── Telegram serve (remote control via Telegram) ───────────
  // A single embedded serve session lives in this sidecar process. Only the main
  // window's home screen exposes the controls, so there's one bot per app.
  let serveController: ServeController | null = null;

  // Resumed session: if it already has a conversation, generate its title now so
  // the title bar shows it immediately on load (not just after the next prompt).
  {
    const hasHistory = session
      .getMessages()
      .some((m) => m.role === "user" || m.role === "assistant");
    if (hasHistory) {
      titleGenerated = true;
      void session.generateTitle().then((title) => {
        if (title) broadcast("session_title", { title });
      });
    }
  }

  // Core run lifecycle shared by /prompt and the task runner: flips `running`,
  // brackets the run with run_start/run_end, refreshes the footer extras, and
  // generates the session title once. `label` is the text shown live with the
  // run_start frame.
  async function runAgent(label: string, run: () => Promise<void>): Promise<void> {
    running = true;
    broadcast("run_start", { text: label });
    try {
      await run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast("error", { message });
      log("ERROR", "app-sidecar", "run failed", { message });
    } finally {
      running = false;
      // A run may have switched branches (git checkout) or spawned/finished
      // background tasks — refresh the footer extras once it settles.
      gitBranch = await getGitBranch(cwd).catch(() => gitBranch);
      gitIsRepo = await isGitRepo(cwd).catch(() => gitIsRepo);
      broadcast("run_end", {});
      // Queue drains into the run as steering, so it's empty by run_end —
      // sync the webview indicator.
      broadcast("queued", { count: session.getQueuedCount() });
      broadcast("extras", footerExtras());
      // Generate a session title once, after the first run, for the title bar
      // (best-effort, async — don't block the response).
      if (!titleGenerated) {
        titleGenerated = true;
        void session.generateTitle().then((title) => {
          if (title) broadcast("session_title", { title });
        });
      }
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
    titleGenerated = false;
    broadcast("session_reset", {});
    markTaskInProgress(cwd, task.id);
    broadcast("tasks_list", { tasks: loadTasksSync(cwd) });
    broadcast("task_start", { id: task.id, title: task.title });
    const shortId = task.id.slice(0, 8);
    const completionHint =
      `\n\n---\nWhen you have fully completed this task, call the tasks tool to mark it done:\n` +
      `tasks({ action: "done", id: "${shortId}" })`;
    await runAgent(task.title, () => session.prompt(task.prompt + completionHint));
    // The agent typically marks the task done via the tasks tool during the run;
    // push the refreshed list so the webview's task modal reflects it.
    broadcast("tasks_list", { tasks: loadTasksSync(cwd) });
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

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
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
        running,
        ready: true,
        thinkingLevel: session.getThinkingLevel() ?? null,
        supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
        supportsVideo: getModel(st.model)?.supportsVideo ?? false,
        ...footerExtras(),
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
            running,
            thinkingLevel: session.getThinkingLevel() ?? null,
            supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
            supportsVideo: getModel(st.model)?.supportsVideo ?? false,
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
      void listRecentSessions(target, 5)
        .then((sessions) => json(res, 200, { sessions }))
        .catch(() => json(res, 200, { sessions: [] }));
      return;
    }

    if (method === "GET" && url.startsWith("/files")) {
      const q = new URL(url, `http://${host}`).searchParams.get("q") ?? "";
      void searchProjectFiles(cwd, q)
        .then((files) => json(res, 200, { files }))
        .catch((err) => {
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

        for (const msg of messages) {
          if (msg.role === "system") continue;

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

          // User or assistant message — existing text/hook/command/compacted
          // extraction, plus sub-agent group detection for assistant tool_calls.
          const text =
            typeof msg.content === "string"
              ? msg.content
              : msg.content
                  .map((c) =>
                    c.type === "text" && "text" in c && typeof c.text === "string" ? c.text : "",
                  )
                  .join("");
          const images =
            typeof msg.content === "string"
              ? []
              : msg.content.flatMap((c) =>
                  c.type === "image" ? [`data:${c.mediaType};base64,${c.data}`] : [],
                );
          const hook = msg.role === "user" ? detectHookKind(text) : null;
          const compacted =
            msg.role === "user" && !hook && text.startsWith("[Previous conversation summary]");
          const command =
            msg.role === "user" && !hook && !compacted
              ? detectPromptCommand(text, commandCandidates)
              : null;

          if (text.trim() || images.length > 0) {
            history.push({
              role: msg.role as "user" | "assistant",
              text: command ?? text,
              images,
              hook,
              command: command !== null,
              compacted,
            });
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
              } => c.type === "tool_call" && c.name === "subagent",
            );
            if (subagentCalls.length > 0) {
              const agents = subagentCalls.map((c) => {
                const result = toolResultMap.get(c.id);
                return {
                  agentName: typeof c.args?.agent === "string" ? c.args.agent : undefined,
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
        }

        json(res, 200, { history });
      })();
      return;
    }

    if (method === "GET" && url === "/commands") {
      // Workflow commands with agent functionality: built-in prompt templates +
      // the user's own `.gg/commands/*.md`. UI commands (model/quit/etc.) are
      // handled webview-side and intentionally excluded.
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
        try {
          const body = JSON.parse(raw) as { text?: string; attachments?: AppAttachment[] };
          text = body.text ?? "";
          attachments = Array.isArray(body.attachments) ? body.attachments : [];
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        if (!text.trim() && attachments.length === 0) {
          json(res, 400, { error: "empty prompt" });
          return;
        }
        if (running) {
          // Queue prompts as mid-run steering (mirrors the CLI). Attachments are
          // persisted to .gg/uploads first so the queued media rides the same
          // native-block path as a non-queued attachment prompt when it drains.
          const prepared = attachments.length > 0 ? await prepareAttachments(cwd, attachments) : [];
          const count = session.queueMessage(text, prepared);
          broadcast("queued", { count });
          json(res, 202, { queued: true, count });
          return;
        }
        json(res, 202, { accepted: true });
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
      });
      return;
    }

    if (method === "GET" && url === "/tasks") {
      json(res, 200, { tasks: loadTasksSync(cwd) });
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
      json(res, 200, { stations: RADIO_STATIONS, current: getCurrentStation() });
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
        // The new model usually has a different context window — push extras so
        // the footer's context meter rescales immediately.
        broadcast("extras", footerExtras());
        json(res, 200, { provider: target.provider, model: target.id, ...payload });
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
      abort.abort();
      abort = new AbortController();
      session.setSignal(abort.signal);
      running = false;
      // Stop a run-all sweep so the next pending task isn't auto-started.
      taskRunAll = false;
      // Drop any queued steering and return it so the webview can restore it to
      // the composer.
      const drained = session.drainQueue();
      broadcast("run_end", { cancelled: true });
      broadcast("queued", { count: 0 });
      json(res, 200, { cancelled: true, drained });
      return;
    }

    if (method === "POST" && url === "/new-session") {
      if (running) {
        json(res, 409, { error: "cannot start a new session while running" });
        return;
      }
      void session
        .newSession()
        .then(() => {
          broadcast("session_reset", {});
          json(res, 200, { ok: true });
        })
        .catch((err) => {
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        });
      return;
    }

    // Bake an approved plan into the system prompt before the implementation
    // prompt runs, so the model is told to emit `[DONE:n]` markers and the
    // webview's plan-progress widget advances (mirrors the CLI accept flow).
    if (method === "POST" && url === "/plan/accept") {
      void readBody(req).then(async (raw) => {
        let planPath: string | undefined;
        try {
          planPath = (JSON.parse(raw) as { planPath?: string }).planPath || undefined;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        try {
          await session.setApprovedPlan(planPath);
          json(res, 200, { ok: true });
        } catch (err) {
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
        try {
          const body = JSON.parse(raw) as { provider?: string; key?: string };
          provider = body.provider ?? "";
          key = (body.key ?? "").trim();
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
        const creds: OAuthCredentials = {
          accessToken: key,
          refreshToken: "",
          expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 * 100, // ~100y
          ...(meta.apiKeyBaseUrl ? { baseUrl: meta.apiKeyBaseUrl } : {}),
        };
        await auth.setCredentials(provider, creds);
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
    // Stop the Telegram serve loop + dispose its per-chat sessions.
    if (serveController) await serveController.stop().catch(() => {});
    for (const c of clients) c.res.end();
    await session.dispose().catch(() => {});
  }

  return {
    id: opts.id,
    cwd,
    sessionPath: opts.sessionPath,
    session,
    clients,
    broadcast,
    handle,
    dispose,
  };
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`GG_APP_FATAL ${message}\n`);
  process.exit(1);
});
