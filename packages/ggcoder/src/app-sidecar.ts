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
import { environmentSecrets, formatChatError, redactValue } from "@kenkaiiii/gg-ai";
import type { AddressInfo } from "node:net";
import { createAppErrorPayload } from "./app-error.js";
import { runSubagentWorkerMode } from "./modes/subagent-worker-mode.js";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { setStreamDiagnostic } from "@kenkaiiii/gg-agent";
import { AgentSession } from "./core/agent-session.js";
import { RunLifecycle } from "./core/run-lifecycle.js";
import { RunClaim } from "./core/run-claim.js";
import { shouldOfferPendingPlan } from "./core/plan-handoff.js";
import {
  createChatAgent,
  parseChatAgentId,
  switchChatAgent,
  type ChatAgentId,
} from "./chat-agents/index.js";
import { createMotionAgentSession } from "./motion-agent/motion-agent.js";
import { buildJiwaTools, JiwaStore } from "./chat-agents/jiwa.js";
import { buildMemoryTools, MemoryStore } from "./chat-agents/memory.js";
import { buildKenSystemPrompt, buildKenAutopilotSystemPrompt } from "./core/ken-prompt.js";
import { countAssistantMessages, type WorkflowCommandSpec } from "./core/autopilot-gate.js";
import { describeRunVerification, describeTurnVerification } from "./core/run-status.js";
import { validateKenModelPref, effectiveKenModel, type KenModelPref } from "./core/ken-model.js";
import type { RunOutcome } from "./core/session-manager.js";
import { AuthStorage } from "./core/auth-storage.js";
import { cleanupToolOutputs } from "./tools/overflow.js";
import {
  dualAuthProvider,
  discoverLocalModels,
  formatLocalModelId,
  parseLocalModelId,
  probeEndpoint,
  toModelInfo as localModelInfo,
  type LocalEndpoint,
  type LocalEndpointProbe,
} from "@kenkaiiii/gg-core";
import { listAllEndpoints, syncEndpointCredentials } from "./core/local-endpoint-store.js";
import type { OAuthLoginCallbacks } from "./core/oauth/types.js";
import {
  AUTH_PROVIDERS,
  authPriorityNote,
  describeAuthMethods,
  type AuthMethod,
  type AuthMethodMeta,
  type AuthProviderMeta,
} from "./core/auth-providers.js";
import { ensureAppDirs, loadSavedSettings } from "./config.js";
import { SettingsManager } from "./core/settings-manager.js";
import {
  getModel,
  getDefaultThinkingLevel,
  getContextWindow,
  clearRuntimeModels,
  registerRuntimeModels,
} from "./core/model-registry.js";
import { resolveStartOrFallback } from "./core/resolve-start.js";
import { getGitBranch, getGitDirtyFileCount, isGitRepo } from "./utils/git.js";
import { getGitHubRepoSlug } from "./utils/github.js";
import type { GitHubCI } from "./utils/github-ci.js";
import type { ProjectHealthScan } from "./core/project-health-scan.js";
import { scoreProjectHealth, type ProjectHealth } from "./core/project-health-score.js";
import { type RepoPolls, createRepoPolls } from "./app-sidecar/repo-polls.js";
import { extractPlanSteps } from "./utils/plan-steps.js";
import { getSupportedThinkingLevels, isThinkingLevelSupported } from "./core/thinking-level.js";
import { PROMPT_COMMANDS } from "./core/prompt-commands.js";
import { loadCustomCommands } from "./core/custom-commands.js";
import { pruneDoneTasksSync } from "./core/tasks-store.js";
import { initLogger, log } from "./core/logger.js";
import { installTerminationHandlers } from "./core/shutdown.js";
import { stopRadio } from "./core/radio.js";
import { enrichProcessPath } from "./core/shell-path.js";
import type { ServeController } from "./modes/serve-mode.js";
import { createElicitationBridge } from "./core/mcp/index.js";
import { askSoftDeadlineMs, createAskUserBridge, deliverLateAnswer } from "./core/ask-user.js";
import { createAskUserTool } from "./tools/ask-user.js";
import { createUsageService } from "./app-sidecar/usage.js";
import { daemonReadBody, daemonJson, json } from "./app-sidecar/http.js";
import { runJsonModeIfRequested } from "./app-sidecar/json-mode.js";
import {
  type SseClient,
  type WorkspaceMode,
  parseWorkspaceMode,
  type SessionContext,
} from "./app-sidecar/session-types.js";
import {
  ALL_PROVIDERS,
  loadProjectModelPrefs,
  loadKenModelPref,
  loadAutopilot,
} from "./app-sidecar/app-settings.js";
import { KEN_ALLOWED_TOOLS } from "./app-sidecar/ken-context.js";
import { type ProgressManager, createProgressManager } from "./app-sidecar/progress-manager.js";
import { handleSessionRoutes } from "./app-sidecar/session-routes.js";
import { handleWorkspaceRoutes } from "./app-sidecar/workspace-routes.js";
import { handleHistoryRoutes } from "./app-sidecar/history-routes.js";
import { handlePromptRoutes } from "./app-sidecar/prompt-routes.js";
import { handleTaskRoutes } from "./app-sidecar/task-routes.js";
import { handleRunControlRoutes } from "./app-sidecar/run-control-routes.js";
import { handleAuthRoutes } from "./app-sidecar/auth-routes.js";
import { handleIntegrationRoutes } from "./app-sidecar/integration-routes.js";
import { handleMcpRoutes } from "./app-sidecar/mcp-routes.js";
import type { SessionRouteContext } from "./app-sidecar/route-context.js";
import { createHfPullManager } from "./app-sidecar/hf-pull-manager.js";
import { keepAwake } from "./app-sidecar/keep-awake.js";
import { createAutopilotRunner } from "./app-sidecar/autopilot-runner.js";

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

  // Per-launch bearer token. The Rust shell generates one and passes it via
  // GG_APP_TOKEN; spawned any other way (dev, tests, smoke) we mint our own
  // and report it on the GG_APP_LISTENING line. Every request must carry it
  // as x-gg-token: this daemon creates sessions for arbitrary cwds, runs
  // prompts, and installs plugins, so an unauthenticated loopback port lets
  // any local process drive the agent as the user.
  const authToken = process.env.GG_APP_TOKEN ?? randomUUID();

  const paths = await ensureAppDirs();
  // Own log file so the app sidecar never clobbers the interactive CLI's
  // ~/.gg/debug.log (initLogger truncates on each start).
  const sidecarLog = path.join(paths.agentDir, "gg-app-sidecar.log");
  initLogger(sidecarLog);
  // Apply the saved keepAwake setting before any run can acquire the guard.
  keepAwake.setEnabled((await new SettingsManager(paths.settingsFile).load()).keepAwake);

  // The desktop sidecar previously omitted the stream diagnostic hook used by
  // the CLI, leaving device-specific provider stalls impossible to distinguish from
  // event-loop starvation or a broken streaming network path. Keep routine
  // phases lightweight; timeout phases include non-sensitive runtime context.
  setStreamDiagnostic((phase, data) => {
    const includeRuntime =
      phase === "idle_timeout_fired" ||
      phase === "hard_timeout_fired" ||
      phase === "stall_exhausted";
    // A session stuck on the non-streaming fallback costs real money and real
    // latency; it does not belong in the INFO noise floor.
    log(phase === "non_streaming_session" ? "WARN" : "INFO", "stream", phase, {
      ...(data ?? {}),
      ...(includeRuntime
        ? {
            platform: process.platform,
            arch: process.arch,
            osRelease: os.release(),
            node: process.version,
            logicalCpus: os.cpus().length,
            totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
            freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
            rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            processUptimeSec: Math.round(process.uptime()),
          }
        : {}),
    });
  });

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

  /**
   * Fan one frame out to every window.
   *
   * For state that is genuinely global rather than per-session — `~/.gg/auth.json`
   * is shared by all windows, so connecting a provider in one must refresh the
   * model picker in all of them. Mirrors the memory/jiwa/progress fan-outs.
   */
  const broadcastAll = (type: string, data: unknown): void => {
    for (const ctx of sessions.values()) ctx.broadcast(type, data);
  };

  // Providers currently mid-OAuth in some window. Daemon-level so two windows
  // cannot race two browser flows for the same provider into one auth file.
  const oauthInFlightProviders = new Set<string>();

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

  const { subscriptionUsage } = createUsageService(auth);

  // git status / GitHub counts / CI pollers, one per repo however many windows
  // have it open (each window used to run its own).
  const repoPolls = createRepoPolls();

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

  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // Answer preflights with a bare 204 but grant NO origins — the webview
    // reaches the daemon through the Rust proxy, never cross-origin, so any
    // browser page's preflight must fail here.
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Host allowlist. The daemon binds 127.0.0.1 only; rejecting any other
    // Host blocks DNS rebinding, where a web page's request arrives with
    // the attacker's hostname (browsers cannot spoof Host).
    const reqHost = req.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(reqHost)) {
      daemonJson(res, 403, { error: "forbidden host" });
      return;
    }

    if (req.headers["x-gg-token"] !== authToken) {
      daemonJson(res, 401, { error: "unauthorized" });
      return;
    }

    // ── Daemon-level routes (session lifecycle) ──────────────────────────
    // Create a session for a window: { mode?, cwd, sessionPath? } → { sessionId }.
    if (method === "POST" && url === "/session") {
      void daemonReadBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let body: { mode?: unknown; chatAgent?: unknown; cwd?: unknown; sessionPath?: unknown } =
          {};
        try {
          body = raw ? (JSON.parse(raw) as typeof body) : {};
        } catch {
          /* empty/invalid body → defaults below */
        }
        const mode = parseWorkspaceMode(body.mode);
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
            {
              auth,
              paths,
              progress,
              memoryStore,
              jiwaStore,
              broadcastAll,
              oauthInFlightProviders,
              repoPolls,
            },
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

    // Keep-awake is app-wide (one OS assertion for every window), so its
    // setting lives at the daemon level and applies live to in-flight runs.
    if (method === "GET" && url === "/keep-awake") {
      daemonJson(res, 200, { enabled: keepAwake.isEnabled });
      return;
    }
    if (method === "POST" && url === "/keep-awake") {
      void daemonReadBody(req, res).then(async (raw) => {
        if (raw === null) return;
        let enabled: unknown;
        try {
          enabled = (JSON.parse(raw) as { enabled?: unknown }).enabled;
        } catch {
          enabled = undefined;
        }
        if (typeof enabled !== "boolean") {
          daemonJson(res, 400, { error: "enabled must be a boolean" });
          return;
        }
        keepAwake.setEnabled(enabled);
        try {
          const sm = new SettingsManager(paths.settingsFile);
          await sm.load();
          await sm.set("keepAwake", enabled);
        } catch (err) {
          log("WARN", "app-sidecar", "failed to persist keepAwake", { err: String(err) });
        }
        daemonJson(res, 200, { enabled });
      });
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
        if (provider !== "anthropic" && provider !== "openai" && provider !== "moonshot") {
          daemonJson(res, 400, { error: "unsupported usage provider" });
          return;
        }
        daemonJson(res, 200, await subscriptionUsage(provider));
      })().catch((error) => {
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
  });
  server.listen(port, host, () => {
    const addr = server.address() as AddressInfo;
    // The Rust shell reads this line to learn the daemon port (it already
    // knows the token — it set GG_APP_TOKEN; the field serves other spawners).
    process.stdout.write(`GG_APP_LISTENING ${addr.port} ${authToken}\n`);
    log("INFO", "app-sidecar", "daemon listening", { port: String(addr.port), host });
  });

  const shellPid = process.ppid;
  // Session teardown awaits MCP servers, LSP servers and third-party extension
  // `deactivate()` hooks. Any of those can hang, and an unbounded await here
  // means the daemon never exits: the app looks quit while this process keeps
  // the port and the radio stream alive. The deadline exits regardless.
  const shutdown = installTerminationHandlers({
    scope: "app-sidecar",
    teardown: async () => {
      // Before any await: background commands live outside the daemon's process
      // group, and the app force-kills that group after 3 s. If a slow session
      // teardown is still pending then, these would never be stopped.
      for (const c of sessions.values()) c.stopBackgroundProcesses();
      clearInterval(parentWatch);
      // Radio playback is app-wide (one stream across all windows), so it stops
      // at the daemon level, not per session.
      stopRadio();
      // Drop the idle-sleep assertion first: session teardown may hang.
      keepAwake.dispose();
      // Close the ~/.gg progress fs.watch handle (baseline #8 leak fix).
      progress.dispose();
      await Promise.all([...sessions.values()].map((c) => c.dispose().catch(() => {})));
      server.close();
    },
    onTimeout: (timeoutMs) => {
      // Radio is audible, so it must stop even when the rest is wedged.
      stopRadio();
      log("WARN", "app-sidecar", "daemon teardown hung; exiting on deadline", {
        timeoutMs: String(timeoutMs),
        sessions: String(sessions.size),
      });
    },
  });
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
    if (!parentAlive) shutdown();
  }, 1_000);
  parentWatch.unref?.();
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
    /** Fan one frame out to EVERY window, not just this session's. */
    broadcastAll: (type: string, data: unknown) => void;
    /**
     * Providers with an OAuth flow in progress in SOME window. Daemon-wide
     * because a login writes the shared auth file — see `/auth/oauth/start`.
     */
    oauthInFlightProviders: Set<string>;
    /** Daemon-wide repo pollers shared by windows on the same repo. */
    repoPolls: RepoPolls;
  },
  opts: {
    id: string;
    mode: WorkspaceMode;
    chatAgent: ChatAgentId;
    cwd: string;
    sessionPath?: string;
  },
): Promise<SessionContext> {
  const {
    auth,
    progress,
    memoryStore,
    jiwaStore,
    broadcastAll,
    oauthInFlightProviders,
    repoPolls,
  } = deps;
  const paths = deps.paths;
  const mode = opts.mode;
  let chatAgent = opts.chatAgent;
  const cwd = opts.cwd;
  // Motion's workspace is a dedicated folder the app names inside the projects
  // root; create it on first use so a fresh install can start a video at once.
  if (mode === "motion") await fs.mkdir(cwd, { recursive: true });
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
        .replaceAll(/switch to (\S+) with \/model/gi, "switch to $1 using the model selector")
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

  /**
   * Guidance for a connection failure against the ACTIVE local endpoint, or
   * undefined when that isn't the situation (so the generic wording stands).
   * "Disable your VPN / allow us through the firewall" is useless advice for a
   * server running on this machine — name what the user has to restart.
   */
  function localNetworkGuidance(source: string | undefined): string | undefined {
    if (source !== "network") return undefined;
    const state = session.getState();
    if (state.provider !== "local") return undefined;
    const parsed = parseLocalModelId(state.model);
    const probe = localProbes.find((p) => p.endpoint.id === parsed?.endpointId);
    if (!probe) return undefined;
    return (
      `${probe.endpoint.label} stopped responding at ${probe.endpoint.baseUrl}. ` +
      "Start it again and retry, or pick another model."
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
    const f = formatChatError(err);
    const message = f.message ? desktopGuidance(f.message) : undefined;
    const guidance = localNetworkGuidance(f.source) ?? desktopGuidance(f.guidance);
    const payload = createAppErrorPayload(
      { ...f, ...(message ? { message } : {}), guidance },
      type,
      Date.now(),
      environmentSecrets(process.env),
    );
    log("ERROR", "app-sidecar", logLabel, {
      headline: payload.headline,
      source: f.source,
      ...(payload.message ? { message: payload.message } : {}),
      ...(payload.provider ? { provider: payload.provider } : {}),
      ...(payload.statusCode != null ? { statusCode: String(payload.statusCode) } : {}),
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
    });
    broadcast(type, payload);
    // Same sanitized snapshot for live and restored rows, including reset metadata.
    void session.persistAppMarker("error", payload).catch(() => {});
  }

  // ── MCP elicitation bridge ─────────────────────────────────
  // An MCP server can ask for user input in the middle of a tool call. The
  // bridge parks the promise; we broadcast the prompt over SSE and resolve it
  // when the webview POSTs /mcp/elicit/:id.
  const elicitations = createElicitationBridge({
    broadcast: (prompt) => broadcast("mcp_elicit", prompt),
    onTimeout: (prompt) =>
      log("WARN", "app-sidecar", "MCP elicitation timed out", {
        id: prompt.id,
        server: prompt.server,
      }),
  });

  // ── ask_user bridge ────────────────────────────────────────
  // The `ask_user` tool parks the turn on a human answer. Same shape as the
  // MCP bridge above: broadcast over SSE, resolved when the webview POSTs
  // /ask/:id. Registered ONLY here — a TUI/headless/subagent run has nobody to
  // answer, so the tool is absent there rather than hanging on a dead channel.
  //
  // Soft deadline ("async ask"): past it the tool returns "no answer yet —
  // proceed on your best guess" and the question STAYS OPEN. A later answer
  // rides the ordinary user queue: steering into a live run, or the next turn
  // when idle. The deadline is short when nobody is watching (autopilot, task
  // run-all, a scheduled prompt).
  let scheduledRunActive = false;
  const asks = createAskUserBridge({
    broadcast: (prompt) => broadcast("ask_user", prompt),
    timeoutMs: () =>
      askSoftDeadlineMs(autopilot || autopilotActive || taskRunAll || scheduledRunActive),
    onTimeout: (prompt) => {
      log("WARN", "app-sidecar", "ask_user deadline passed; agent proceeding", { id: prompt.id });
      broadcast("ask_user_deferred", { id: prompt.id });
    },
    onClosed: (ids) => broadcast("ask_user_closed", { ids }),
    onLateAnswer: (late) => {
      log("INFO", "app-sidecar", "ask_user late answer queued", { id: late.prompt.id });
      deliverLateAnswer(late, {
        queueMessage: (text) => session.queueMessage(text),
        isBusy: () => running || runClaim.active || autopilotActive,
        onQueued: () =>
          broadcast("queued", {
            count: session.getQueuedCount(),
            messages: session.listQueuedMessages(),
          }),
        startIdleRun: () => void runStrandedQueue(),
      });
    },
  });
  const askUserTool = createAskUserTool(asks.park);

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
    onMcpElicit: elicitations.onElicit,
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
      additionalTools: [
        askUserTool,
        ...buildMemoryTools(memoryStore),
        ...buildJiwaTools(jiwaStore),
      ],
      getSystemPromptTail: () =>
        `${memoryStore.renderForPrompt()}\n\n${jiwaStore.renderForPrompt()}`,
      onAgentChange: async (nextAgent) => {
        chatAgent = nextAgent;
        broadcast("chat_agent_change", { chatAgent: nextAgent });
        await session.persistAppMarker("agent_handoff", { chatAgent: nextAgent }).catch((error) => {
          log("WARN", "app-sidecar", "agent handoff marker persist failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      },
    });
  } else if (mode === "motion") {
    session = await createMotionAgentSession({
      ...baseSessionOptions,
      sessionsDir: paths.sessionsDir,
      additionalTools: [askUserTool],
    });
  } else {
    session = new AgentSession({
      ...baseSessionOptions,
      additionalTools: [askUserTool],
      // A run must not end mid-plan with nothing submitted: nobody could review it.
      planSubmissionGate: true,
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

  // ── Local models (Ollama, plus user-added custom endpoints) ──
  // Probing endpoints must never delay readiness, so this runs in the
  // background (same shape as backgroundMcpConnect) and pushes a models_change
  // frame when it lands.
  let localProbes: LocalEndpointProbe[] = [];

  async function scanLocalModels(force: boolean): Promise<LocalEndpointProbe[]> {
    const endpoints = await listAllEndpoints();
    const { probes, models } = await discoverLocalModels(endpoints, { force });
    localProbes = probes;
    // Only endpoints that answered get a credential: writing one for a server
    // that isn't running would make `hasProviderAuth("local")` true forever.
    await syncEndpointCredentials(
      probes.filter((probe) => probe.reachable).map((probe) => probe.endpoint),
    );
    clearRuntimeModels((m) => m.provider === "local");
    registerRuntimeModels(models);
    log("INFO", "app-sidecar", "local model scan", {
      reachable: probes.filter((p) => p.reachable).length + "/" + probes.length,
      models: String(models.length),
    });
    return probes;
  }

  /** Endpoint rows + models, in the shape the Local models UI renders. */
  function localStatePayload(): {
    endpoints: {
      id: string;
      label: string;
      baseUrl: string;
      kind: LocalEndpoint["kind"];
      custom: boolean;
      reachable: boolean;
      reason?: string;
      models: {
        id: string;
        rawId: string;
        contextWindow: number;
        contextWindowKnown: boolean;
        supportsTools: boolean;
        supportsImages: boolean;
        supportsThinking: boolean;
        loaded?: boolean;
      }[];
    }[];
  } {
    return {
      endpoints: localProbes.map((probe) => ({
        id: probe.endpoint.id,
        label: probe.endpoint.label,
        baseUrl: probe.endpoint.baseUrl,
        kind: probe.endpoint.kind,
        custom: probe.endpoint.custom === true,
        reachable: probe.reachable,
        ...(probe.reason ? { reason: probe.reason } : {}),
        models: probe.models.map((m) => ({
          id: formatLocalModelId(probe.endpoint.id, m.rawId),
          rawId: m.rawId,
          contextWindow: m.contextWindow,
          contextWindowKnown: m.contextWindowKnown,
          supportsTools: m.supportsTools,
          supportsImages: m.supportsImages,
          supportsThinking: m.supportsThinking,
          ...(m.loaded === undefined ? {} : { loaded: m.loaded }),
        })),
      })),
    };
  }

  // ── Hugging Face → Ollama pulls (see app-sidecar/hf-pull-manager.ts) ──
  const hf = createHfPullManager({
    paths,
    broadcast,
    broadcastAll,
    scanLocalModels: (force) => scanLocalModels(force),
    localStatePayload: () => localStatePayload(),
  });
  const { hfPullPayload, hfSearch, startHfPull, cancelHfPull } = hf;

  /**
   * Why `modelId` can't be selected right now, or `undefined` when it can.
   * Two real footguns get a clear answer instead of a mid-run provider error:
   * a model with no tool calling (can't drive the agent at all), and a server
   * that has since been shut down.
   */
  async function localModelBlocker(modelId: string): Promise<string | undefined> {
    const parsed = parseLocalModelId(modelId);
    if (!parsed) return undefined;
    const endpoints = await listAllEndpoints();
    const endpoint = endpoints.find((e) => e.id === parsed.endpointId);
    if (!endpoint)
      return `Unknown local endpoint "${parsed.endpointId}" — re-scan for local models.`;

    const probe = await probeEndpoint(endpoint);
    // Keep the cached view honest: this probe is fresher than the last scan.
    localProbes = localProbes.map((p) => (p.endpoint.id === endpoint.id ? probe : p));
    if (!probe.reachable) {
      return `${endpoint.label} isn't running at ${endpoint.baseUrl}. Start it and scan again.`;
    }
    const model = probe.models.find((m) => m.rawId === parsed.rawId);
    if (!model) {
      return `${endpoint.label} no longer serves "${parsed.rawId}".`;
    }
    if (!model.supportsTools) {
      return `${parsed.rawId} has no tool calling, so it can't run the agent. Pick a tool-capable model.`;
    }
    registerRuntimeModels(probe.models.map((m) => localModelInfo(m, endpoint)));
    return undefined;
  }

  /**
   * A restored per-project pref can ask for thinking on a local model that
   * turns out not to reason (capabilities are only known after a probe). Drop
   * the level once we know, so the first prompt doesn't carry a
   * `reasoning_effort` the server rejects.
   */
  function clampLocalThinking(): void {
    const st = session.getState();
    const level = session.getThinkingLevel();
    if (!level || st.provider !== "local") return;
    if (isThinkingLevelSupported(st.provider, st.model, level)) return;
    session.setThinkingLevel(undefined);
    broadcast("thinking_change", {
      thinkingLevel: null,
      supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
    });
  }

  // Workspace extras (context window, git status, background tasks). Git state
  // is resolved once at startup and refreshed after every run; the context
  // window follows the active model.
  const [initialGitBranch, initialGitIsRepo, initialDirtyFileCount, initialGitHubSlug] =
    await Promise.all([
      getGitBranch(cwd).catch(() => null),
      isGitRepo(cwd).catch(() => false),
      getGitDirtyFileCount(cwd).catch(() => 0),
      getGitHubRepoSlug(cwd).catch(() => null),
    ]);
  let gitBranch: string | null = initialGitBranch;
  let gitIsRepo: boolean = initialGitIsRepo;
  let gitDirtyFileCount = initialDirtyFileCount;
  // Open issue/PR counts for the origin repo's GitHub slug, via the `gh` CLI's
  // auth. null = unknown (gh missing/unauthed, non-GitHub origin) → chips hidden.
  const gitHubSlug: string | null = initialGitHubSlug;
  let gitHubIssues: number | null = null;
  let gitHubPRs: number | null = null;
  let gitHubCI: GitHubCI | null = null;
  // Latest Project Health scan (code mode only); scored with the live CI result.
  let projectHealthScan: ProjectHealthScan | null = null;
  // Footer extras go out on every git/CI/task change; score only when the scan
  // or CI result actually changed.
  let scoredHealth: {
    scan: ProjectHealthScan;
    ci: GitHubCI | null;
    health: ProjectHealth | null;
  } | null = null;
  function currentProjectHealth(): ProjectHealth | null {
    if (!projectHealthScan) return null;
    if (scoredHealth?.scan !== projectHealthScan || scoredHealth.ci !== gitHubCI) {
      scoredHealth = {
        scan: projectHealthScan,
        ci: gitHubCI,
        health: scoreProjectHealth(projectHealthScan, gitHubCI),
      };
    }
    return scoredHealth.health;
  }
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
    gitHubIssues: number | null;
    gitHubPRs: number | null;
    gitHubRepoUrl: string | null;
    gitHubCI: GitHubCI | null;
    projectHealth: ProjectHealth | null;
    tasks: ReturnType<typeof session.listBackgroundProcesses>;
    additionalRoots: string[];
  } {
    return {
      contextWindow: currentContextWindow(),
      gitBranch,
      isGitRepo: gitIsRepo,
      gitDirtyFileCount,
      gitHubIssues,
      gitHubPRs,
      gitHubCI,
      gitHubRepoUrl: gitHubSlug ? `https://github.com/${gitHubSlug}` : null,
      projectHealth: currentProjectHealth(),
      tasks: session.listBackgroundProcesses(),
      // Roots added with /add-dir — the header shows a badge when non-empty.
      additionalRoots: session.getAdditionalRoots(),
    };
  }

  void scanLocalModels(false)
    .then(() => {
      clampLocalThinking();
      broadcast("extras", footerExtras());
    })
    .then(() => broadcast("models_change", { local: localStatePayload() }))
    .catch((err: unknown) => {
      // A discovery failure is never fatal — the user simply has no local
      // models. Log it; don't push an error row into the transcript.
      log("WARN", "app-sidecar", "local model scan failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

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
  session.eventBus.on("retry", (d) => {
    if (!d.silent) broadcast("retry", { reason: d.reason, attempt: d.attempt, delayMs: d.delayMs });
  });
  session.eventBus.on("stream_rule_triggered", (d) =>
    broadcast("stream_rule_triggered", { rules: d.rules, source: d.source, toolName: d.toolName }),
  );
  session.eventBus.on("max_turns", (d) => broadcast("max_turns", d));
  // The agent consumed queued steering at a turn boundary. Re-broadcast as the
  // usual `queued` depth update so the webview drops the pending affordance the
  // moment the message lands in the loop, not at run_end.
  session.eventBus.on("queue_drained", (d) =>
    broadcast("queued", { count: d.count, messages: session.listQueuedMessages() }),
  );
  // A fresh/loaded session must not receive late answers to the old one's questions.
  session.eventBus.on("session_start", () => asks.closeDeferred());
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
      // Consecutive-failure count for schema rejections. Attempt 1 followed by
      // a success means the model self-corrected; reaching 3 means it looped
      // and the turn was ended. Grep this to tell the two apart.
      ...(d.invalidArgAttempt === undefined
        ? {}
        : { invalidArgAttempt: String(d.invalidArgAttempt) }),
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
  // empty_response is a hard failure (no output at all): route it through
  // broadcastError so the app renders an error row — the webview does not
  // render bare "truncated" frames.
  session.eventBus.on("truncated", (d) => {
    if (d.reason === "empty_response") {
      broadcastError(
        "error",
        "empty response",
        new Error("The model returned an empty response after retries — try sending again."),
      );
      return;
    }
    broadcast("truncated", d);
  });
  session.eventBus.on("error", (d) => {
    broadcastError("error", "agent error", d.error);
  });
  session.eventBus.on("model_change", (d) => broadcast("model_change", d));
  session.eventBus.on("hook", (d) => broadcast("hook", d));
  session.eventBus.on("diagnostics", (d) => broadcast("diagnostics", d));
  // Fires BEFORE the candidate final answer streams. The webview holds assistant
  // text back while armed, so an injected follow-up supersedes a draft that was never
  // painted instead of deleting one the user already started reading.
  session.eventBus.on("hook_armed", (d) => broadcast("hook_armed", d));
  session.eventBus.on("subagent_state", (d) => broadcast("subagent_state", d));
  session.eventBus.on("compaction_start", (d) => broadcast("compaction_start", d));
  session.eventBus.on("compaction_end", (d) => broadcast("compaction_end", d));
  // Cold-prompt-cache notice: push the fresh TTL anchor + context size whenever
  // a run or compaction settles. Expiry itself is time-based, so the webview
  // also re-reads `cacheExpiry` from /state when the user returns or types.
  for (const ev of ["agent_done", "compaction_end", "model_change"] as const) {
    session.eventBus.on(ev, () => broadcast("cache_expiry", session.getCacheExpiryStatus()));
  }

  // Keep the computer awake while this window's agent works: owned runs and
  // autopilot cycles (RunLifecycle state), Ken replies, and background
  // sub-agents that outlive their parent run. Released on settle (completed,
  // failed or cancelled) and on session dispose.
  let releaseRunAwake: (() => void) | null = null;
  let releaseSubagentAwake: (() => void) | null = null;
  const activeSubagents = new Set<string>();
  session.eventBus.on("subagent_state", (d) => {
    if (d.state === "starting" || d.state === "running") activeSubagents.add(d.agent_id);
    else activeSubagents.delete(d.agent_id);
    if (activeSubagents.size > 0) {
      releaseSubagentAwake ??= keepAwake.acquire("subagent");
    } else {
      releaseSubagentAwake?.();
      releaseSubagentAwake = null;
    }
  });

  let running = false;
  // Closes the window between `/prompt` deciding to start a run and `runAgent`
  // flipping `running` — that stretch awaits, so Node yields inside it. See
  // RunClaim.
  const runClaim = new RunClaim();
  const runLifecycle = new RunLifecycle(
    (runState) => {
      running = runState !== "idle";
      if (running) {
        releaseRunAwake ??= keepAwake.acquire("run");
      } else {
        releaseRunAwake?.();
        releaseRunAwake = null;
      }
      if (runState === "cancelling") broadcast("run_cancelling", { runState });
    },
    // Durable run journal. Fire-and-forget on purpose: an unwritten journal
    // entry is a missed crash hint, while a journal write that throws inside
    // begin()/settle() would break run ownership itself.
    {
      started: (generation) =>
        void session.persistRunStarted(generation).catch((err) => {
          log("WARN", "app-sidecar", "failed to journal run start", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      finished: (generation, outcome) =>
        void session.persistRunFinished(generation, outcome).catch((err) => {
          log("WARN", "app-sidecar", "failed to journal run finish", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    },
  );
  const cancelledRunEndGenerations = new Set<number>();
  let pendingCancelDrain: { generation: number; text: string } | null = null;
  // Bumped by /cancel — a run whose cancel generation changed mid-flight was
  // canceled and earns no XP.
  let cancelGeneration = 0;
  // Autopilot (auto-review) toggle for THIS window's project. Loaded from
  // gg-app.json on boot; flipped via POST /autopilot. When on, POST /prompt runs
  // runAutopilotCycle after the user's turn settles — Ken auto-reviews the work
  // and drives the review→prompt→review loop.
  let autopilot = mode === "code" && (await loadAutopilot(cwd));
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

  // Plan feedback (Ken's or the user's) is revised back in read-only plan
  // mode. exit_plan leaves plan mode, so without this a "revise the plan" run
  // had full write access and could start implementing before any approval.
  async function reenterPlanModeForRevision(): Promise<void> {
    if (session.getPlanMode()) return;
    deactivateApprovedPlan();
    await session.setPlanMode(true);
    broadcast("plan_mode", { active: true });
    log("INFO", "app-sidecar", "plan mode re-entered for revision");
  }

  // Plan generation last handed to the human review box (-1: none yet).
  let offeredPlanGeneration = -1;

  // The plan the human review box should show right now, or null. Only once
  // everything has settled — see shouldOfferPendingPlan.
  function pendingPlanForHuman(
    offeredGeneration: number,
  ): { planPath: string; content: string } | null {
    const offer = shouldOfferPendingPlan({
      planPath: pendingPlanPath,
      generation: planGeneration,
      offeredGeneration,
      running,
      starting: runClaim.active,
      autopilotActive,
      queued: session.getQueuedCount(),
    });
    return offer && pendingPlanPath !== null
      ? { planPath: pendingPlanPath, content: pendingPlanContent }
      : null;
  }

  // Open the Accept / Feedback / Reject box once nothing else will act on the
  // submitted plan. Called at every settle point (turn end, queue drain, task
  // run end). Without it, a plan Ken didn't approve — handed back, review
  // failed, capped, cancelled, or skipped — sat pending with no way to act.
  function offerPendingPlan(): void {
    const plan = pendingPlanForHuman(offeredPlanGeneration);
    if (!plan) return;
    offeredPlanGeneration = planGeneration;
    log("INFO", "app-sidecar", "plan handed to user for review", { planPath: plan.planPath });
    broadcast("plan_review", plan);
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
      transient: true,
      signal: kenAbort.signal,
      // Ken belongs to THIS window, so its window is where an MCP prompt
      // should appear. Passing the bridge also keeps every session in the
      // daemon uniformly interactive, which is what lets them share ONE pooled
      // MCP connection: the pool separates interactive from headless callers,
      // because a connection declares its elicitation capability once, at
      // initialize (see core/mcp/shared-pool.ts).
      onMcpElicit: elicitations.onElicit,
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
      transient: true,
      signal: kenAutoAbort.signal,
      // Same as Ken chat: this reviewer belongs to a window, so route prompts
      // there, and keep the daemon's sessions uniformly interactive so they
      // share one pooled MCP connection.
      onMcpElicit: elicitations.onElicit,
      // Autopilot review rounds routinely span the injected GG Coder run
      // (often >5 min) regardless of the user's global speedProfile pick.
      forceLongCacheRetention: true,
    });
    await ken.initialize();
    // Keep review text/tools silent; report usage only for whole-task accounting.
    ken.eventBus.on("turn_end", (d) => {
      broadcast("autopilot_usage", { outputTokens: d.usage.outputTokens });
    });
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
    // An MCP tool call parked on user input is not cancelled by the signal —
    // the promise lives in the bridge. Release it, or the aborted turn's tool
    // call never returns. Same for a question parked on the user.
    elicitations.cancelAll();
    asks.cancelAll();
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

  function finishOwnedGeneration(
    generation: number,
    emitCancelledFallback: boolean,
    outcome: RunOutcome = "completed",
  ): boolean {
    const cancelled = runLifecycle.isCancellationRequested(generation);
    const settlement = runLifecycle.settle(generation, outcome);
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
  async function runAgent(
    label: string,
    run: () => Promise<void>,
    reviewPending: () => boolean = () => false,
  ): Promise<void> {
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
    broadcast("run_start", {
      text: label,
      runState: runLifecycle.state,
      continued: !ownsGeneration,
    });
    try {
      if (!runLifecycle.isCancellationRequested(generation)) await run();
      runSucceeded = true;
    } catch (err) {
      if (!runLifecycle.isCancellationRequested(generation)) {
        broadcastError("error", "run failed", err);
      }
    } finally {
      const cancelled = runLifecycle.isCancellationRequested(generation);
      const verificationProblem = cancelled ? null : session.getVerificationProblem();
      if (runSucceeded && verificationProblem && ownsGeneration) {
        // Expected control outcome: run_end and the journal already carry Unverified.
        // Do not format it as a crash or persist a misleading error marker.
        log("WARN", "app-sidecar", "verification incomplete", { message: verificationProblem });
      }
      if (
        runSucceeded &&
        !verificationProblem &&
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
      // A run may have opened/closed issues or PRs — refresh fire-and-forget so
      // teardown isn't delayed by the network. Broadcasts itself on change.
      gitHubCountsPoll?.refresh();
      ciPoll.refresh();
      healthPoll?.refresh();
      // Serialize behind any marker/tool-triggered refresh so the terminal
      // progress snapshot uses the live plan file. Once every canonical step
      // is complete, remove the approved plan from future system prompts and
      // clear the widget before run_end paints the idle activity bar.
      if (
        runSucceeded &&
        !cancelled &&
        !verificationProblem &&
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
          log("WARN", "app-sidecar", "completed plan cleanup failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (ownsGeneration) {
        finishOwnedGeneration(
          generation,
          false,
          verificationProblem ? "unverified" : runSucceeded ? "completed" : "failed",
        );
      }
      // A cancelled injected run is still owned by the surrounding autopilot
      // cycle; its outer finalizer emits the one terminal cancelled run_end.
      if (!(cancelled && !ownsGeneration)) {
        if (cancelled) cancelledRunEndGenerations.add(generation);
        broadcast("run_end", {
          ...(cancelled ? { cancelled: true } : {}),
          ...(verificationProblem ? { unverified: true } : {}),
          failed: !cancelled && !runSucceeded,
          // The cycle refuses an unresolved verification gate. Do not advertise
          // a review handoff that will exit before emitting any review events.
          reviewPending:
            !cancelled &&
            runSucceeded &&
            !verificationProblem &&
            (reviewPending() || !ownsGeneration),
          ...describeRunVerification(session.getVerificationEvidence(), verificationProblem),
          turnVerification: describeTurnVerification(
            session.getRunVerificationActivity(),
            verificationProblem,
          ),
          ...(verificationProblem ? { verificationReason: verificationProblem } : {}),
          runState: runLifecycle.state,
        });
      }
      // Autopilot's review loop is driven explicitly from POST /prompt (see
      // runAutopilotCycle), NOT from this shared finally — that keeps injected
      // runs from recursively entering the same review loop.
      broadcast("tasks_list", { tasks: pruneDoneTasksSync(cwd) });
      broadcast("queued", {
        count: session.getQueuedCount(),
        messages: session.listQueuedMessages(),
      });
      broadcast("extras", footerExtras());
    }
  }

  // The prompt fed to the fresh session after a plan is accepted — the SAME
  // string the webview sends on a manual Accept (see PlanReviewModal's accept
  // handler in gg-app/src/App.tsx). Keep the two in lockstep so auto- and
  // manual approval produce identical implementation turns.
  const IMPLEMENT_PLAN_PROMPT =
    "The plan has been approved. Implement it now, following each step in order.";

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

  // ── Task runner (project task list → sessions) ──────────────
  // Mirrors the CLI's task flow: each task runs in its OWN fresh session, with a
  // completion hint instructing the agent to mark the task done via the tasks
  // tool. Run-all advances to the next pending task after each run finishes.
  let taskRunAll = false;

  // Moved to app-sidecar/autopilot-runner.ts
  const { runAutopilotCycle, runStrandedQueue, runTasks } = createAutopilotRunner({
    get autopilotReviewing() {
      return autopilotReviewing;
    },
    set autopilotReviewing(v) {
      autopilotReviewing = v;
    },
    get broadcast() {
      return broadcast;
    },
    get ensureKenAutoSession() {
      return ensureKenAutoSession;
    },
    get cwd() {
      return cwd;
    },
    get gitBranch() {
      return gitBranch;
    },
    set gitBranch(v) {
      gitBranch = v;
    },
    get session() {
      return session;
    },
    set session(v) {
      session = v;
    },
    get injectedAutopilotPrompts() {
      return injectedAutopilotPrompts;
    },
    set injectedAutopilotPrompts(v) {
      injectedAutopilotPrompts = v;
    },
    get loadWorkflowCommandSpecs() {
      return loadWorkflowCommandSpecs;
    },
    get autopilotCancelled() {
      return autopilotCancelled;
    },
    set autopilotCancelled(v) {
      autopilotCancelled = v;
    },
    get broadcastError() {
      return broadcastError;
    },
    get pendingKenAutoModel() {
      return pendingKenAutoModel;
    },
    set pendingKenAutoModel(v) {
      pendingKenAutoModel = v;
    },
    get syncKenAutoModel() {
      return syncKenAutoModel;
    },
    get pendingPlanPath() {
      return pendingPlanPath;
    },
    set pendingPlanPath(v) {
      pendingPlanPath = v;
    },
    get planGeneration() {
      return planGeneration;
    },
    set planGeneration(v) {
      planGeneration = v;
    },
    get pendingPlanContent() {
      return pendingPlanContent;
    },
    set pendingPlanContent(v) {
      pendingPlanContent = v;
    },
    get autopilot() {
      return autopilot;
    },
    set autopilot(v) {
      autopilot = v;
    },
    get runLifecycle() {
      return runLifecycle;
    },
    get abortOwnedWork() {
      return abortOwnedWork;
    },
    get pendingCancelDrain() {
      return pendingCancelDrain;
    },
    set pendingCancelDrain(v) {
      pendingCancelDrain = v;
    },
    get autopilotActive() {
      return autopilotActive;
    },
    set autopilotActive(v) {
      autopilotActive = v;
    },
    get MAX_AUTOPILOT_ROUNDS() {
      return MAX_AUTOPILOT_ROUNDS;
    },
    get activateApprovedPlan() {
      return activateApprovedPlan;
    },
    get clearPendingPlan() {
      return clearPendingPlan;
    },
    get planProgressPayload() {
      return planProgressPayload;
    },
    get IMPLEMENT_PLAN_PROMPT() {
      return IMPLEMENT_PLAN_PROMPT;
    },
    get runAgent() {
      return runAgent;
    },
    get kenAutoSession() {
      return kenAutoSession;
    },
    set kenAutoSession(v) {
      kenAutoSession = v;
    },
    get reenterPlanModeForRevision() {
      return reenterPlanModeForRevision;
    },
    get finishOwnedGeneration() {
      return finishOwnedGeneration;
    },
    get drainingStrandedQueue() {
      return drainingStrandedQueue;
    },
    set drainingStrandedQueue(v) {
      drainingStrandedQueue = v;
    },
    get running() {
      return running;
    },
    set running(v) {
      running = v;
    },
    get offerPendingPlan() {
      return offerPendingPlan;
    },
    get deactivateApprovedPlan() {
      return deactivateApprovedPlan;
    },
    get taskRunAll() {
      return taskRunAll;
    },
    set taskRunAll(v) {
      taskRunAll = v;
    },
  });

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
    providers: (AuthProviderMeta & {
      connected: boolean;
      connectedMethods: AuthMethod[];
      activeMethod?: AuthMethod;
      oauthExhaustedUntil?: number;
      priorityNote?: string;
      methodGuidance: AuthMethodMeta[];
    })[];
  }> {
    const providers = await Promise.all(
      AUTH_PROVIDERS.map(async (p) => {
        const dual = dualAuthProvider(p.value);
        // Which methods hold a credential right now. Dual-auth providers can hold
        // both at once, and the app needs them separately: one "connected" bit
        // cannot express "OAuth signed in, key also on file as backup", nor offer
        // a per-method disconnect.
        const oauthKey = dual?.oauthKey;
        const hasOAuth = oauthKey ? await auth.hasCredentials(oauthKey) : false;
        const apiKeyKeys = p.apiKeyVariants?.map((v) => v.key) ?? [p.value];
        const hasApiKey = p.methods.includes("apikey")
          ? (await Promise.all(apiKeyKeys.map((k) => auth.hasCredentials(k)))).some(Boolean)
          : false;
        const connectedMethods: AuthMethod[] = [];
        // OAuth-only providers (Anthropic/OpenAI/Gemini) store under the provider
        // id itself, so `hasProviderAuth` is what proves their OAuth connection.
        if (
          p.methods.includes("oauth") &&
          (hasOAuth || (!dual && (await auth.hasCredentials(p.value))))
        )
          connectedMethods.push("oauth");
        if (hasApiKey) connectedMethods.push("apikey");

        // Which one a request would actually use, mirroring AuthStorage's
        // resolution: OAuth wins unless its usage window is exhausted AND a key
        // is configured to cover it.
        const exhaustedUntil = oauthKey
          ? ((await auth.getCredentials(oauthKey))?.usageExhaustedUntil ?? 0)
          : 0;
        const oauthSidelined = hasOAuth && Date.now() < exhaustedUntil && hasApiKey;
        const activeMethod = connectedMethods.includes("oauth")
          ? oauthSidelined
            ? ("apikey" as const)
            : ("oauth" as const)
          : connectedMethods[0];

        // `methodDetails` is the server-side lookup table behind
        // `methodGuidance` — shipping both would duplicate every string on the
        // wire for no consumer.
        const { methodDetails: _table, ...wireMeta } = p;
        return {
          ...wireMeta,
          connected: await auth.hasProviderAuth(p.value),
          connectedMethods,
          ...(activeMethod ? { activeMethod } : {}),
          ...(oauthSidelined ? { oauthExhaustedUntil: exhaustedUntil } : {}),
          ...(authPriorityNote(p.value) ? { priorityNote: authPriorityNote(p.value)! } : {}),
          methodGuidance: describeAuthMethods(p.value),
        };
      }),
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

  // Keep the dirty count, GitHub issue/PR counts and CI current while idle
  // (they change outside the agent: editor saves, commits, teammates). Branch/
  // repo state already refreshes after agent runs. The pollers are shared with
  // every other window on the same repo; each window broadcasts only changes.
  const repoKey = path.resolve(cwd);
  const dirtyFilesPoll = repoPolls.dirtyFiles.subscribe(repoKey, (next) => {
    if (next === gitDirtyFileCount) return;
    gitDirtyFileCount = next;
    broadcast("extras", footerExtras());
  });
  // Failed checks publish nothing, so the chips keep their last-known numbers
  // instead of flickering off on a timeout. None when origin isn't GitHub.
  const gitHubCountsPoll = gitHubSlug
    ? repoPolls.gitHubCounts.subscribe(gitHubSlug, (counts) => {
        if (counts.issues === gitHubIssues && counts.prs === gitHubPRs) return;
        gitHubIssues = counts.issues;
        gitHubPRs = counts.prs;
        broadcast("extras", footerExtras());
      })
    : null;
  const ciPoll = repoPolls.gitHubCI.subscribe(repoKey, (next) => {
    if (JSON.stringify(next) === JSON.stringify(gitHubCI)) return;
    gitHubCI = next;
    broadcast("extras", footerExtras());
  });
  // Project Health is a code-workspace signal; chat and motion windows skip the scan.
  const healthPoll =
    mode === "code"
      ? repoPolls.projectHealth.subscribe(repoKey, (next) => {
          if (JSON.stringify(next) === JSON.stringify(projectHealthScan)) return;
          projectHealthScan = next;
          broadcast("extras", footerExtras());
        })
      : null;

  const routeCtx: SessionRouteContext = {
    get session() {
      return session;
    },
    set session(v) {
      session = v;
    },
    mode,
    get chatAgent() {
      return chatAgent;
    },
    set chatAgent(v) {
      chatAgent = v;
    },
    get running() {
      return running;
    },
    set running(v) {
      running = v;
    },
    runLifecycle,
    get autopilot() {
      return autopilot;
    },
    set autopilot(v) {
      autopilot = v;
    },
    kenStatePayload,
    footerExtras,
    progress,
    memoryStore,
    jiwaStore,
    get clientSeq() {
      return clientSeq;
    },
    set clientSeq(v) {
      clientSeq = v;
    },
    clients,
    get autopilotActive() {
      return autopilotActive;
    },
    set autopilotActive(v) {
      autopilotActive = v;
    },
    pendingPlanForHuman,
    paths,
    host,
    cwd,
    asks,
    runClaim,
    broadcast,
    get scheduledRunActive() {
      return scheduledRunActive;
    },
    set scheduledRunActive(v) {
      scheduledRunActive = v;
    },
    loadWorkflowCommandSpecs,
    get autopilotCancelled() {
      return autopilotCancelled;
    },
    set autopilotCancelled(v) {
      autopilotCancelled = v;
    },
    clearPendingPlan,
    runAgent,
    reenterPlanModeForRevision,
    get pendingPlanPath() {
      return pendingPlanPath;
    },
    set pendingPlanPath(v) {
      pendingPlanPath = v;
    },
    runAutopilotCycle,
    runStrandedQueue,
    offerPendingPlan,
    get kenRunning() {
      return kenRunning;
    },
    set kenRunning(v) {
      kenRunning = v;
    },
    ensureKenSession,
    get gitBranch() {
      return gitBranch;
    },
    set gitBranch(v) {
      gitBranch = v;
    },
    get injectedAutopilotPrompts() {
      return injectedAutopilotPrompts;
    },
    set injectedAutopilotPrompts(v) {
      injectedAutopilotPrompts = v;
    },
    broadcastError,
    get pendingKenModel() {
      return pendingKenModel;
    },
    set pendingKenModel(v) {
      pendingKenModel = v;
    },
    syncKenModel,
    get kenAbort() {
      return kenAbort;
    },
    set kenAbort(v) {
      kenAbort = v;
    },
    get kenSession() {
      return kenSession;
    },
    set kenSession(v) {
      kenSession = v;
    },
    runTasks,
    auth,
    get localProbes() {
      return localProbes;
    },
    set localProbes(v) {
      localProbes = v;
    },
    localModelBlocker,
    get kenModelOverride() {
      return kenModelOverride;
    },
    set kenModelOverride(v) {
      kenModelOverride = v;
    },
    syncKenAutoModel,
    get autopilotReviewing() {
      return autopilotReviewing;
    },
    set autopilotReviewing(v) {
      autopilotReviewing = v;
    },
    get taskRunAll() {
      return taskRunAll;
    },
    set taskRunAll(v) {
      taskRunAll = v;
    },
    get kenAutoAbort() {
      return kenAutoAbort;
    },
    set kenAutoAbort(v) {
      kenAutoAbort = v;
    },
    get kenAutoSession() {
      return kenAutoSession;
    },
    set kenAutoSession(v) {
      kenAutoSession = v;
    },
    get pendingCancelDrain() {
      return pendingCancelDrain;
    },
    set pendingCancelDrain(v) {
      pendingCancelDrain = v;
    },
    CANCEL_TIMEOUT_MS,
    deactivateApprovedPlan,
    activateApprovedPlan,
    planProgressPayload,
    authStatusPayload,
    broadcastAll,
    get oauthInFlight() {
      return oauthInFlight;
    },
    set oauthInFlight(v) {
      oauthInFlight = v;
    },
    oauthInFlightProviders,
    authCallbacks,
    get pendingCode() {
      return pendingCode;
    },
    set pendingCode(v) {
      pendingCode = v;
    },
    elicitations,
    localStatePayload,
    scanLocalModels,
    get hfPull() {
      return hf.hfPull;
    },
    set hfPull(v) {
      hf.hfPull = v;
    },
    hfPullPayload,
    hfSearch,
    startHfPull,
    cancelHfPull,
    get serveController() {
      return serveController;
    },
    set serveController(v) {
      serveController = v;
    },
  };

  // OPTIONS/CORS preflight is handled at the daemon level before delegation.
  function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): void {
    if (handleSessionRoutes(routeCtx, req, res, url, method)) return;
    if (handleWorkspaceRoutes(routeCtx, req, res, url, method)) return;
    if (handleHistoryRoutes(routeCtx, req, res, url, method)) return;
    if (handlePromptRoutes(routeCtx, req, res, url, method)) return;
    if (handleTaskRoutes(routeCtx, req, res, url, method)) return;
    if (handleRunControlRoutes(routeCtx, req, res, url, method)) return;
    if (handleAuthRoutes(routeCtx, req, res, url, method)) return;
    if (handleIntegrationRoutes(routeCtx, req, res, url, method)) return;
    if (handleMcpRoutes(routeCtx, req, res, url, method)) return;

    json(res, 404, { error: "not found" });
  }

  async function dispose(): Promise<void> {
    releaseRunAwake?.();
    releaseRunAwake = null;
    releaseSubagentAwake?.();
    releaseSubagentAwake = null;
    elicitations.cancelAll();
    asks.cancelAll();
    tasksPollStopped = true;
    if (tasksPoll) clearTimeout(tasksPoll);
    dirtyFilesPoll.unsubscribe();
    gitHubCountsPoll?.unsubscribe();
    ciPoll.unsubscribe();
    healthPoll?.unsubscribe();
    // Stop the Telegram serve loop + dispose its per-chat sessions.
    if (serveController) await serveController.stop().catch(() => {});
    for (const c of clients) c.res.end();
    kenAbort.abort();
    kenAutoAbort.abort();
    await kenSession?.dispose().catch(() => {});
    await kenAutoSession?.dispose().catch(() => {});
    await session.dispose().catch(() => {});
  }

  function stopBackgroundProcesses(): void {
    session.stopBackgroundProcesses();
    kenSession?.stopBackgroundProcesses();
    kenAutoSession?.stopBackgroundProcesses();
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
    stopBackgroundProcesses,
  };
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`GG_APP_FATAL ${message}\n`);
  process.exit(1);
});
