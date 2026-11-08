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
import { startThreatFeedSync } from "./core/threat-feed.js";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { environmentSecrets, formatChatError, redactValue } from "@kleio/ai";
import type { AddressInfo } from "node:net";
import { createAppErrorPayload } from "./app-error.js";
import { runSubagentWorkerMode } from "./modes/subagent-worker-mode.js";
import type { Provider, ThinkingLevel } from "@kleio/ai";
import { setStreamDiagnostic } from "@kleio/agent";
import { AgentSession } from "./core/agent-session.js";
import { RunLifecycle } from "./core/run-lifecycle.js";
import { RunClaim } from "./core/run-claim.js";
import { shouldOfferPendingPlan } from "./core/plan-handoff.js";
import {
  createChatAgent,
  createPersonaChatAgent,
  isProjectsFolder,
  parseChatAgentId,
  parseChatPersona,
  switchChatAgent,
  type ChatAgentId,
  type ChatPersona,
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
  findProbedModel,
  isLocalModelId,
  formatLocalModelId,
  parseLocalModelId,
  ollamaServedContext,
  toModelInfo as localModelInfo,
  createDictation,
  type Dictation,
  type LocalEndpoint,
  type LocalEndpointProbe,
} from "@kleio/core";
import {
  listAllEndpoints,
  listCustomEndpoints,
  syncEndpointCredentials,
} from "./core/local-endpoint-store.js";
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
import {
  getModel,
  withoutPaidTier,
  getDefaultThinkingLevel,
  getContextWindow,
  clearRuntimeModels,
  registerRuntimeModels,
} from "./core/model-registry.js";
import { resolveStartOrFallback } from "./core/resolve-start.js";
import { getGitBranch, getGitDirtyFileCount, isGitRepo } from "./utils/git.js";
import { getGitHubOpenCounts } from "./utils/github.js";
import { startGitHubCIPoll, type GitHubCI } from "./utils/github-ci.js";
import { extractPlanSteps } from "./utils/plan-steps.js";
import { getSupportedThinkingLevels, isThinkingLevelSupported } from "./core/thinking-level.js";
import { PROMPT_COMMANDS } from "./core/prompt-commands.js";
import { loadCustomCommands } from "./core/custom-commands.js";
import {
  createRoutineRunner,
  createRoutineStore,
  type Routine,
  type RoutineTarget,
} from "./routines.js";
import { pruneDoneTasksSync } from "./core/tasks-store.js";
import { initLogger, log } from "./core/logger.js";
import { installTerminationHandlers } from "./core/shutdown.js";
import { KeepAwake } from "./core/keep-awake.js";
import { SettingsManager } from "./core/settings-manager.js";
import { stopRadio } from "./core/radio.js";
import { enrichProcessPath } from "./core/shell-path.js";
import { withAppImagePreviews } from "./utils/image.js";
import type { ServeController } from "./modes/serve-mode.js";
import { createElicitationBridge } from "./core/mcp/index.js";
import { askSoftDeadlineMs, createAskUserBridge, deliverLateAnswer } from "./core/ask-user.js";
import { createAskUserTool } from "./tools/ask-user.js";
import { runJsonModeIfRequested } from "./app-sidecar/json-mode.js";
import {
  type SessionContext,
  parseWorkspaceMode,
  type WorkspaceMode,
  type SseClient,
} from "./app-sidecar/session-types.js";
import { createProgressManager, type ProgressManager } from "./app-sidecar/progress-manager.js";
import { daemonJson, daemonReadBody, json } from "./app-sidecar/http.js";
import {
  ModelUnavailableError,
  requireStartModel,
  discoverLocalModelForPin,
  probeLocalModelBlocker,
} from "./app-sidecar/start-model.js";
import {
  loadProjectModelPrefs,
  ALL_PROVIDERS,
  loadAppSettings,
  saveProjectModelPrefs,
  loadAutopilot,
  loadKenModelPref,
} from "./app-sidecar/app-settings.js";
import { KEN_ALLOWED_TOOLS } from "./app-sidecar/ken-context.js";
import { createUsageService } from "./app-sidecar/usage.js";
import { createHfPullManager } from "./app-sidecar/hf-pull-manager.js";
import { createAutopilotRunner } from "./app-sidecar/autopilot-runner.js";
import { handleImagePreviewRoutes } from "./app-sidecar/image-preview-routes.js";
import { handleHistoryImageRoutes } from "./app-sidecar/history-image-routes.js";
import { handleCompleteRoutes } from "./app-sidecar/complete-routes.js";
import { handleStoredSessionRoutes } from "./app-sidecar/stored-session-routes.js";
import { handleFileTextRoutes } from "./app-sidecar/file-text-routes.js";
import { handleBrainRoutes } from "./app-sidecar/brain-routes.js";
import { handleDictationRoutes } from "./app-sidecar/dictation-routes.js";
import { handleRoutineRoutes } from "./app-sidecar/routine-routes.js";
import { handleKeepAwakeRoutes } from "./app-sidecar/keep-awake-routes.js";
import { handleBrainEditRoutes } from "./app-sidecar/brain-edit-routes.js";
import { handleSessionRoutes } from "./app-sidecar/session-routes.js";
import { handleWorkspaceRoutes } from "./app-sidecar/workspace-routes.js";
import { readGitState } from "./app-sidecar/git-target.js";
import { handleProjectFolderRoutes } from "./app-sidecar/project-folder-routes.js";
import { handleHistoryRoutes } from "./app-sidecar/history-routes.js";
import { handlePromptRoutes } from "./app-sidecar/prompt-routes.js";
import { handleTranscribeRoutes } from "./app-sidecar/transcribe-routes.js";
import { handleTaskRoutes } from "./app-sidecar/task-routes.js";
import { handleRunControlRoutes } from "./app-sidecar/run-control-routes.js";
import { handleAuthRoutes } from "./app-sidecar/auth-routes.js";
import { handleIntegrationRoutes } from "./app-sidecar/integration-routes.js";
import { handleMcpRoutes } from "./app-sidecar/mcp-routes.js";
import type { SessionRouteContext, DaemonRouteContext } from "./app-sidecar/route-context.js";

/** App-wide idle-sleep guard: every window's runs share one OS assertion. The
 *  `keepAwake` setting is applied at daemon start and live via /keep-awake. */
const keepAwake = new KeepAwake();

/** Limit for re-reading git state in the background when git missed the usual 2 s. */
const SLOW_GIT_READ_TIMEOUT_MS = 15_000;

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

  // Daily malicious-package feed (OSV MAL-, npm + PyPI): deferred, background,
  // fail-silent; at most one sync a day (core/threat-feed.ts).
  startThreatFeedSync();

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

  // Dictation (`POST /transcribe`, and `/dictation` for Settings → Setup): one
  // Whisper for the daemon, so windows and devices share the model instead of
  // each loading it. It is downloaded and loaded by Setup or the first clip.
  const dictation = createDictation({ cacheDir: path.join(paths.agentDir, "models") });

  // Routines (`/schedule`): daemon-owned so they fire with no window open.
  // Each runs in its own session, created on first fire through the same
  // `createSession` a window uses, and prompted over loopback `POST /prompt`
  // so it goes through the full run-claim / autopilot / queue pipeline rather
  // than a private side door. Every change fans out as a `routines` frame.
  const routineStore = createRoutineStore({
    file: path.join(paths.agentDir, "routines.json"),
    log: (line) => log("WARN", "app-sidecar", line),
  });
  await routineStore.load();
  const routinesPayload = (): { routines: Routine[] } => ({ routines: routineStore.list() });
  const routineRunner = createRoutineRunner({
    store: routineStore,
    log: (line) => log("INFO", "app-sidecar", line),
    onChange: () => broadcastAll("routines", routinesPayload()),
    createTarget: async (routine): Promise<RoutineTarget> => {
      const id = randomUUID();
      const ctx = await createSession(
        {
          auth,
          paths,
          progress,
          memoryStore,
          jiwaStore,
          broadcastAll,
          oauthInFlightProviders,
          dictation,
        },
        {
          id,
          mode: routine.mode,
          chatAgent: parseChatAgentId(routine.chatAgent),
          cwd: routine.cwd,
        },
      );
      sessions.set(id, ctx);
      log("INFO", "app-sidecar", "routine session created", {
        id,
        routine: routine.id,
        cwd: routine.cwd,
      });
      return {
        sessionId: id,
        queuedPrompts: () => ctx.session.listQueuedMessages().map((m) => m.text),
        prompt: async (text) => {
          const addr = server.address() as AddressInfo;
          const res = await fetch(`http://127.0.0.1:${addr.port}/prompt`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-gg-token": authToken,
              "x-gg-session": id,
            },
            // `scheduled`: nobody is watching this run, so ask_user gets the short deadline.
            body: JSON.stringify({ text, attachments: [], meta: { scheduled: true } }),
          });
          const body = (await res.json().catch(() => ({}))) as { queued?: boolean; error?: string };
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          return body.queued ? "queued" : "sent";
        },
        dispose: async () => {
          if (sessions.get(id) === ctx) {
            sessions.delete(id);
            await ctx.dispose().catch(() => {});
            log("INFO", "app-sidecar", "routine session disposed", { id, routine: routine.id });
          }
        },
      };
    },
  });

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
  // The Brain tools as voice Kleio gets them (GET /brain, POST /brain/tool):
  // the very tools text chat runs, so both share one memory and one Jiwa.
  const brainTools = [...buildMemoryTools(memoryStore), ...buildJiwaTools(jiwaStore)];

  // XP/rank progress — loaded once per daemon; awards fan out to every window.
  // Each frame is tagged `origin: true` only for the session that earned the
  // XP, so that window alone plays sounds/chips while the rest just re-render.
  const progress = await createProgressManager(paths.agentDir, (snapshot, originId) => {
    for (const ctx of sessions.values())
      ctx.broadcast("progress", { ...snapshot, origin: ctx.id === originId });
  });

  const { subscriptionUsage } = createUsageService(auth);

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

  const daemonCtx: DaemonRouteContext = {
    auth,
    sessions,
    paths,
    host,
    memoryStore,
    jiwaStore,
    brainTools,
    dictation,
    routinesPayload,
    routineRunner,
    routineStore,
    broadcastAll,
    keepAwake,
  };

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
        let body: {
          mode?: unknown;
          chatAgent?: unknown;
          cwd?: unknown;
          sessionPath?: unknown;
          persona?: unknown;
          model?: unknown;
        } = {};
        try {
          body = raw ? (JSON.parse(raw) as typeof body) : {};
        } catch {
          /* empty/invalid body → defaults below */
        }
        const mode = parseWorkspaceMode(body.mode);
        const chatAgent = parseChatAgentId(body.chatAgent);
        let persona: ChatPersona | undefined;
        if (body.persona !== undefined) {
          if (mode !== "chat") {
            daemonJson(res, 400, { error: 'persona requires mode "chat"' });
            return;
          }
          const parsed = parseChatPersona(body.persona);
          if ("error" in parsed) {
            daemonJson(res, 400, { error: parsed.error });
            return;
          }
          persona = parsed;
        }
        if (body.model !== undefined && (typeof body.model !== "string" || !body.model)) {
          daemonJson(res, 400, { error: "model must be a non-empty string" });
          return;
        }
        const requestedModel = body.model;
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
              dictation,
            },
            {
              id,
              mode,
              chatAgent,
              cwd: sessionCwd,
              sessionPath,
              persona,
              model: requestedModel,
            },
          );
          sessions.set(id, ctx);
          log("INFO", "app-sidecar", "session created", {
            id,
            mode,
            chatAgent,
            cwd: sessionCwd,
            ...(persona ? { persona: persona.name } : {}),
            ...(requestedModel ? { model: requestedModel } : {}),
          });
          daemonJson(res, 200, { sessionId: id });
        } catch (err) {
          if (err instanceof ModelUnavailableError) {
            log("WARN", "app-sidecar", "session create refused: model unavailable", {
              model: err.modelId,
              reason: err.reason,
            });
            daemonJson(res, 409, { error: err.message });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          log("ERROR", "app-sidecar", "session create failed", { message });
          daemonJson(res, 500, { error: message });
        }
      });
      return;
    }

    if (handleCompleteRoutes(daemonCtx, req, res, url, method)) return;

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

    if (handleStoredSessionRoutes(daemonCtx, req, res, url, method)) return;

    if (handleFileTextRoutes(daemonCtx, req, res, url, method)) return;

    if (handleImagePreviewRoutes(daemonCtx, req, res, url, method)) return;

    if (handleKeepAwakeRoutes(daemonCtx, req, res, url, method)) return;

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

    if (handleBrainRoutes(daemonCtx, req, res, url, method)) return;

    if (handleDictationRoutes(daemonCtx, req, res, url, method)) return;

    if (handleRoutineRoutes(daemonCtx, req, res, url, method)) return;

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
    // Routines fire over loopback to this very server, so only tick once it
    // is accepting connections.
    routineRunner.start();
    if (routineStore.list().length > 0)
      log("INFO", "app-sidecar", "routines resumed", { count: String(routineStore.list().length) });
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
      // Routine sessions are in `sessions` too; stop the ticker first so no
      // fire lands on a session mid-dispose.
      void routineRunner.stop({ dispose: false });
      // Radio playback is app-wide (one stream across all windows), so it stops
      // at the daemon level, not per session.
      stopRadio();
      // Drop the idle-sleep assertion first: session teardown may hang.
      keepAwake.dispose();
      // A speech model download stops; its `.part` stays, to pick up from.
      dictation.dispose();
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
    /** Daemon-wide Whisper for `/transcribe`. */
    dictation: Dictation;
  },
  opts: {
    id: string;
    mode: WorkspaceMode;
    chatAgent: ChatAgentId;
    cwd: string;
    sessionPath?: string;
    /** Chat-only helper persona; never persisted, re-sent by the host on resume. */
    persona?: ChatPersona;
    /** Start on this model (fail closed: throws ModelUnavailableError, never falls back). */
    model?: string;
  },
): Promise<SessionContext> {
  const {
    auth,
    progress,
    memoryStore,
    jiwaStore,
    broadcastAll,
    oauthInFlightProviders,
    dictation,
  } = deps;
  const paths = deps.paths;
  const mode = opts.mode;
  // Persona transcripts live under General so sessionPath resume keeps working.
  let chatAgent: ChatAgentId = opts.persona ? "general" : opts.chatAgent;
  const cwd = opts.cwd;
  // Motion's workspace is a dedicated folder the app names inside the projects
  // root; create it on first use so a fresh install can start a video at once.
  if (mode === "motion") await fs.mkdir(cwd, { recursive: true });
  // Base host for parsing request-URL query params (value is irrelevant to
  // parsing); the daemon owns the real listen host.
  const host = "127.0.0.1";

  const saved = loadSavedSettings(paths.settingsFile, { localModels: true });
  // Native login/logout and other live sessions share auth.json. Refresh the
  // daemon-level snapshot before choosing this session's provider so a project
  // never boots against credentials that were just replaced or disconnected.
  await auth.load();
  // Per-project model/thinking prefs win over the shared global settings.json:
  // each window (one project cwd) restores its own selection instead of every
  // window reading the same single global slot that the last writer clobbered
  // (the old bug — switching models in one window reset every other window).
  const projectPrefs = await loadProjectModelPrefs(cwd);
  let preferred: Provider = projectPrefs?.provider ?? saved.provider ?? "anthropic";
  let savedModel = projectPrefs?.model ?? saved.model;
  // Local models only exist once discovery has registered them, and the
  // per-session scan below runs after the model is chosen. For a project pinned
  // to one (e.g. a Tinfoil proxy), discover first — bounded, never fatal — so
  // the pin can win instead of the session falling back to a cloud provider.
  if (opts.model) {
    // An explicit model fails closed: unknown/blocked → ModelUnavailableError
    // (409), never a silent fallback to a cloud provider.
    const target = await requireStartModel(auth, opts.model);
    preferred = target.provider;
    savedModel = target.id;
  } else if (preferred === "local" && savedModel && !getModel(savedModel)) {
    await discoverLocalModelForPin(savedModel);
    if (!getModel(savedModel)) {
      log("WARN", "app-sidecar", "pinned local model unavailable; using a fallback provider", {
        model: savedModel,
        cwd,
      });
    }
  }
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
  if (opts.model && (!loggedIn || model !== opts.model)) {
    throw new ModelUnavailableError(opts.model, `resolved to ${provider}/${model} instead`);
  }
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
        .replaceAll(
          /Run ["'`]?(?:kleio-coder|ggcoder) login["'`]?/gi,
          "Use the Login to AI Providers button",
        )
        // Any remaining bare mention.
        .replaceAll(/(?:kleio-coder|ggcoder) login/gi, "the Login to AI Providers button")
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
   * Guidance for a connection or auth failure against the ACTIVE local endpoint, or
   * undefined when that isn't the situation (so the generic wording stands).
   * "Disable your VPN / allow us through the firewall" is useless advice for a
   * server running on this machine — name what the user has to restart.
   */
  function localEndpointGuidance(
    source: string | undefined,
    reason: string | undefined,
  ): string | undefined {
    if (source !== "network" && reason !== "auth") return undefined;
    const state = session.getState();
    if (state.provider !== "local") return undefined;
    const parsed = parseLocalModelId(state.model);
    const probe = localProbes.find((p) => p.endpoint.id === parsed?.endpointId);
    if (!probe) return undefined;
    // Custom endpoints live in the Local models tile, not the provider sign-in tiles.
    if (reason === "auth") {
      return (
        `${probe.endpoint.label} rejected the request at ${probe.endpoint.baseUrl}. ` +
        "Check its key under Local models in AI Providers settings."
      );
    }
    return (
      `${probe.endpoint.label} stopped responding at ${probe.endpoint.baseUrl}. ` +
      "Start it again and retry, or pick another model."
    );
  }

  // Turn any thrown value into the same clear headline/message/guidance shape
  // the TUI shows (see gg-ai's formatChatError) instead of a bare `err.message`, log
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
    const guidance = localEndpointGuidance(f.source, f.reason) ?? desktopGuidance(f.guidance);
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
    // Every settle path (answer, late answer, dismiss, cancel, close) tells
    // every client, so a band answered on one device closes on the others.
    // The soft deadline is not a settle: the question stays answerable.
    onSettle: (id) => broadcast("ask_user_done", { id }),
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
    // Image previews go to the app as WebP, which reach the phone a tenth the size.
    toolDetails: withAppImagePreviews,
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
    // A chat in a projects folder (Chats, and chats the Kleio host starts)
    // keeps its files in one folder there, or each would look like a project.
    const settings = await loadAppSettings();
    const chatOptions = {
      ...baseSessionOptions,
      sessionsDir: paths.sessionsDir,
      projectsFolder: isProjectsFolder(cwd, [
        settings.projectsRoot,
        ...(settings.projectRoots ?? []),
      ]),
      additionalTools: [
        askUserTool,
        ...buildMemoryTools(memoryStore),
        ...buildJiwaTools(jiwaStore),
      ],
      getSystemPromptTail: () =>
        `${memoryStore.renderForPrompt()}\n\n${jiwaStore.renderForPrompt()}`,
    };
    // A persona runs on General's transcript namespace with no handoff tool.
    session = opts.persona
      ? createPersonaChatAgent(opts.persona, chatOptions)
      : createChatAgent(chatAgent, {
          ...chatOptions,
          onAgentChange: async (nextAgent) => {
            chatAgent = nextAgent;
            broadcast("chat_agent_change", { chatAgent: nextAgent });
            await session
              .persistAppMarker("agent_handoff", { chatAgent: nextAgent })
              .catch((error) => {
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
  // Persona sessions never hand off, so a resumed transcript's handoff marker
  // (from a pre-persona life) must not swap the persona's prompt out.
  if (mode === "chat" && !opts.persona) {
    const restoredAgent = [...session.getAppMarkers()]
      .reverse()
      .find((marker) => marker.kind === "agent_handoff")?.data.chatAgent;
    if (typeof restoredAgent === "string") {
      chatAgent = parseChatAgentId(restoredAgent);
      await switchChatAgent(session, chatAgent, false);
    }
  }
  // Pin an explicitly requested model for THIS project only (gg-app.json); never
  // the global ~/.gg/settings.json. Saved only once the session actually exists.
  if (opts.model) {
    await saveProjectModelPrefs(cwd, {
      provider,
      model,
      thinkingEnabled: !!session.getThinkingLevel(),
      thinkingLevel: session.getThinkingLevel() ?? undefined,
    }).catch((error) => {
      log("WARN", "app-sidecar", "project model pin persist failed", {
        model,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  log("INFO", "app-sidecar", "session ready", { provider, model, mode, chatAgent, cwd });

  // ── Local models (Ollama, plus user-added custom endpoints) ──
  // Probing endpoints must never delay readiness, so this runs in the
  // background (same shape as backgroundMcpConnect) and pushes a models_change
  // frame when it lands.
  let localProbes: LocalEndpointProbe[] = [];

  // Context Ollama served each model with, learned when it was last loaded
  // ("<endpointId>/<rawId>"). A model Ollama has since unloaded keeps its size.
  const servedContexts = new Map<string, number>();

  function withServedContexts(probe: LocalEndpointProbe): LocalEndpointProbe {
    if (probe.endpoint.kind !== "ollama") return probe;
    return {
      ...probe,
      models: probe.models.map((m) => {
        const served = servedContexts.get(`${m.endpointId}/${m.rawId}`);
        return served === undefined || m.contextWindowKnown
          ? m
          : { ...m, contextWindow: served, contextWindowKnown: true };
      }),
    };
  }

  /**
   * Learn the context an Ollama model really runs with and use it everywhere.
   * `load` (on an explicit pick) loads the model first; after a run it's
   * already loaded and `/api/ps` alone answers.
   */
  async function learnServedContext(modelId: string, load: boolean): Promise<void> {
    const parsed = parseLocalModelId(modelId);
    const probe = localProbes.find((p) => p.endpoint.id === parsed?.endpointId);
    if (!parsed || !probe || probe.endpoint.kind !== "ollama") return;
    const served = await ollamaServedContext(probe.endpoint, parsed.rawId, { load });
    if (served === undefined) return;
    const known = probe.models.find((m) => m.rawId === parsed.rawId);
    if (known?.contextWindowKnown && known.contextWindow === served) return;
    servedContexts.set(`${parsed.endpointId}/${parsed.rawId}`, served);
    localProbes = localProbes.map((p) =>
      p.endpoint.id !== parsed.endpointId
        ? p
        : {
            ...p,
            models: p.models.map((m) =>
              m.rawId === parsed.rawId
                ? { ...m, contextWindow: served, contextWindowKnown: true }
                : m,
            ),
          },
    );
    const updated = findProbedModel(localProbes, modelId);
    if (updated) registerRuntimeModels([localModelInfo(updated.model, updated.endpoint)]);
    log("INFO", "app-sidecar", "learned served context", {
      model: modelId,
      contextWindow: String(served),
    });
    broadcast("extras", footerExtras());
    broadcast("models_change", { local: localStatePayload() });
  }

  async function scanLocalModels(force: boolean): Promise<LocalEndpointProbe[]> {
    const endpoints = await listAllEndpoints();
    const discovered = await discoverLocalModels(endpoints, { force });
    const probes = discovered.probes.map(withServedContexts);
    const models = probes.flatMap((probe) =>
      probe.models.map((model) => localModelInfo(model, probe.endpoint)),
    );
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

  // ── Hugging Face → Ollama pulls (the "Add from Hugging Face" modal) ──
  // One pull at a time: multi-GB downloads, one progress surface. State lives
  // here (not in the webview) so a closed modal or app restart mid-pull keeps
  // streaming; the terminal state is kept until the next pull so reopening the
  // modal shows how the last one ended.

  const hf = createHfPullManager({
    paths,
    broadcast,
    scanLocalModels,
    broadcastAll,
    localStatePayload,
  });
  const { hfPullPayload, hfSearch, startHfPull, cancelHfPull } = hf;

  /**
   * Why `modelId` can't be selected right now, or `undefined` when it can.
   * Two real footguns get a clear answer instead of a mid-run provider error:
   * a model with no tool calling (can't drive the agent at all), and a server
   * that has since been shut down.
   */
  async function localModelBlocker(modelId: string): Promise<string | undefined> {
    const { problem, probe } = await probeLocalModelBlocker(modelId, withServedContexts);
    // Keep the cached view honest: this probe is fresher than the last scan.
    if (probe) {
      localProbes = localProbes.map((p) => (p.endpoint.id === probe.endpoint.id ? probe : p));
    }
    return problem;
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
  const initialGit = await readGitState(cwd);
  let gitBranch: string | null = initialGit.branch;
  let gitIsRepo: boolean = initialGit.isRepo;
  let gitDirtyFileCount = initialGit.dirtyFileCount;
  // Open issue/PR counts for the origin repo's GitHub slug, via the `gh` CLI's
  // auth. null = unknown (gh missing/unauthed, non-GitHub origin) → chips hidden.
  const gitHubSlug: string | null = initialGit.gitHubSlug;
  let gitHubIssues: number | null = null;
  let gitHubPRs: number | null = null;
  let gitHubCI: GitHubCI | null = null;
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
      tasks: session.listBackgroundProcesses(),
      // Roots added with /add-dir — the header shows a badge when non-empty.
      additionalRoots: session.getAdditionalRoots(),
    };
  }

  // Startup resolves the model before discovery runs, so a saved local model
  // isn't registered yet and boot falls back. Switch to it once the scan finds it,
  // unless the user has already picked something else or a run has started.
  async function restoreSavedLocalModel(): Promise<void> {
    if (preferred !== "local" || !savedModel || parseLocalModelId(savedModel) === undefined) return;
    const stillBootModel = (): boolean => !running && session.getState().model === model;
    if (savedModel === model || !stillBootModel() || !getModel(savedModel)) return;
    const blocker = await localModelBlocker(savedModel);
    if (blocker) {
      log("WARN", "app-sidecar", "saved local model not restored", { model: savedModel, blocker });
      return;
    }
    if (!stillBootModel()) return;
    await session.switchModel("local", savedModel);
    log("INFO", "app-sidecar", "restored saved local model", { model: savedModel });
  }

  const initialLocalScan = scanLocalModels(false)
    .then(async () => {
      await restoreSavedLocalModel();
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
  // A run that starts before the scan would run on the fallback model; a goal's
  // kickoff fires as its window opens and lost that race (#133). Never rejects.
  let savedLocalModelPending: Promise<void> | null =
    preferred === "local" &&
    savedModel !== undefined &&
    savedModel !== model &&
    isLocalModelId(savedModel)
      ? initialLocalScan
      : null;
  void initialLocalScan.finally(() => {
    savedLocalModelPending = null;
  });

  // Refresh the GitHub counts and broadcast only on change. Transient failures
  // keep the last-known numbers so the chips don't flicker off on a timeout.
  async function refreshGitHubCounts(): Promise<void> {
    if (!gitHubSlug) return;
    const counts = await getGitHubOpenCounts(gitHubSlug);
    if (!counts) return;
    if (counts.issues !== gitHubIssues || counts.prs !== gitHubPRs) {
      gitHubIssues = counts.issues;
      gitHubPRs = counts.prs;
      broadcast("extras", footerExtras());
    }
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
  session.eventBus.on("security_notice", (d) => broadcast("security_notice", d));
  session.eventBus.on("security_block", (d) => broadcast("security_block", d));
  // Fires BEFORE the candidate final answer streams. The webview holds assistant
  // text back while armed, so an Ideal review supersedes a draft that was never
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
  // Ken never follows the chat onto a paid tier: he runs in the background, unwatched.
  function kenCurrentModel(): { provider: Provider; model: string } {
    if (kenModelOverride) return kenModelOverride;
    const st = session.getState();
    return { provider: st.provider, model: withoutPaidTier(st.model) };
  }

  /** Footer payload: Ken's effective model + whether it's a pin. Merged into
   *  /state, the SSE ready frame, and every ken_model_change broadcast. */
  function kenStatePayload(): ReturnType<typeof effectiveKenModel> {
    const st = session.getState();
    return effectiveKenModel(kenModelOverride, {
      provider: st.provider,
      model: withoutPaidTier(st.model),
    });
  }

  async function syncKenModel(provider: Provider, requested: string): Promise<void> {
    const model = withoutPaidTier(requested);
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

  async function syncKenAutoModel(provider: Provider, requested: string): Promise<void> {
    // The autopilot reviewer runs every turn, unwatched: never on a paid tier.
    const model = withoutPaidTier(requested);
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
    // Ken is already the independent autopilot reviewer; recursively running
    // his own Ideal self-review adds latency and can corrupt the verdict shape.
    ken.setIdealReviewSuppressed(true);
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
    // Only at boot: afterwards runAgent stays synchronous up to its first await.
    if (savedLocalModelPending) await savedLocalModelPending;
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
      // A plain reply has no real end (the user keeps building), so checks are
      // left to the commit and unchecked edits are not "Unverified". Only an
      // Autopilot cycle, which does end, reports unchecked work. A check that
      // ran and failed still shows as failed (from the evidence).
      const verificationProblem =
        cancelled || !autopilotActive ? null : session.getVerificationProblem();
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
      void refreshGitHubCounts();
      void ciPoll.refresh();
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
        // The run loaded the model, so Ollama can now say what size it served.
        const runModel = session.getState().model;
        if (session.getState().provider === "local") {
          void learnServedContext(runModel, false).catch(() => {});
        }
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

  const { runAutopilotCycle, runStrandedQueue, runTasks } = createAutopilotRunner({
    get autopilotReviewing() {
      return autopilotReviewing;
    },
    set autopilotReviewing(v) {
      autopilotReviewing = v;
    },
    broadcast,
    ensureKenAutoSession,
    cwd,
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
    loadWorkflowCommandSpecs,
    get autopilotCancelled() {
      return autopilotCancelled;
    },
    set autopilotCancelled(v) {
      autopilotCancelled = v;
    },
    broadcastError,
    get pendingKenAutoModel() {
      return pendingKenAutoModel;
    },
    set pendingKenAutoModel(v) {
      pendingKenAutoModel = v;
    },
    syncKenAutoModel,
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
    runLifecycle,
    abortOwnedWork,
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
    MAX_AUTOPILOT_ROUNDS,
    activateApprovedPlan,
    clearPendingPlan,
    planProgressPayload,
    IMPLEMENT_PLAN_PROMPT,
    runAgent,
    get kenAutoSession() {
      return kenAutoSession;
    },
    set kenAutoSession(v) {
      kenAutoSession = v;
    },
    finishOwnedGeneration,
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
    deactivateApprovedPlan,
    offerPendingPlan,
    reenterPlanModeForRevision,
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
    localConnected: boolean;
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
        // Gemini resolves the API key first (model registry authStorageKeys).
        const keyFirst = p.value === "gemini" && hasApiKey;
        const activeMethod = keyFirst
          ? ("apikey" as const)
          : connectedMethods.includes("oauth")
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
    // Local endpoints have no tile here, but they are a usable model source. An
    // auto-detected server's credential outlives it, so it counts only while it
    // answered the last scan with a model; a user-added endpoint always counts.
    const localConnected =
      (await listCustomEndpoints()).length > 0 ||
      localProbes.some((probe) => probe.reachable && probe.models.length > 0);
    return { providers, localConnected };
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
  // Git missed its 2 s limit at startup (a busy machine): the titlebar would
  // show "not a repo" until the next run. Read again in the background with
  // more time; window creation doesn't wait for it.
  if (!initialGit.settled) {
    readGitState(cwd, { timeoutMs: SLOW_GIT_READ_TIMEOUT_MS })
      .then((state) => {
        if (gitPollStopped) return;
        gitBranch = state.branch;
        gitIsRepo = state.isRepo;
        gitDirtyFileCount = state.dirtyFileCount;
        broadcast("extras", footerExtras());
      })
      .catch((err: unknown) => {
        log("WARN", "app-sidecar", "slow git re-read failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // GitHub issue/PR counts change outside the app (web UI, teammates), so poll
  // on a slow cadence. Network-bound, so keep it well under the search API's
  // rate budget (2 calls per tick). No-op when the origin isn't a GitHub repo.
  let gitHubPoll: NodeJS.Timeout | undefined;
  let gitHubPollStopped = false;
  const scheduleGitHubPoll = (delay: number): void => {
    if (gitHubPollStopped) return;
    gitHubPoll = setTimeout(() => {
      void refreshGitHubCounts().finally(() => scheduleGitHubPoll(60_000));
    }, delay);
    gitHubPoll.unref?.();
  };
  scheduleGitHubPoll(2000);
  const ciPoll = startGitHubCIPoll(cwd, (next) => {
    gitHubCI = next;
    broadcast("extras", footerExtras());
  });

  // OPTIONS/CORS preflight is handled at the daemon level before delegation.
  // This chat's tool images by ref (historyImageRef), as the last
  // `GET /history?images=refs` listed them, for `GET /history-images`. Each is
  // the session's own copy. Replaced at each such /history, or when asked for
  // one it hasn't listed.
  let historyImages = new Map<string, { data: string; mediaType: string }>();

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
    asks,
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
    paths,
    host,
    cwd,
    get historyImages() {
      return historyImages;
    },
    set historyImages(v) {
      historyImages = v;
    },
    runClaim,
    broadcast,
    loadWorkflowCommandSpecs,
    get autopilotCancelled() {
      return autopilotCancelled;
    },
    set autopilotCancelled(v) {
      autopilotCancelled = v;
    },
    clearPendingPlan,
    runAgent,
    get pendingPlanPath() {
      return pendingPlanPath;
    },
    set pendingPlanPath(v) {
      pendingPlanPath = v;
    },
    runAutopilotCycle,
    runStrandedQueue,
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
    dictation,
    runTasks,
    auth,
    get localProbes() {
      return localProbes;
    },
    set localProbes(v) {
      localProbes = v;
    },
    localModelBlocker,
    learnServedContext,
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
    get scheduledRunActive() {
      return scheduledRunActive;
    },
    set scheduledRunActive(v) {
      scheduledRunActive = v;
    },
    keepAwake,
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
    offerPendingPlan,
    reenterPlanModeForRevision,
    pendingPlanForHuman,
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

  function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): void {
    if (handleSessionRoutes(routeCtx, req, res, url, method)) return;
    if (handleBrainEditRoutes(routeCtx, req, res, url, method)) return;
    if (handleWorkspaceRoutes(routeCtx, req, res, url, method)) return;
    if (handleProjectFolderRoutes(routeCtx, req, res, url, method)) return;
    if (handleHistoryImageRoutes(routeCtx, req, res, url, method)) return;
    if (handleHistoryRoutes(routeCtx, req, res, url, method)) return;
    if (handlePromptRoutes(routeCtx, req, res, url, method)) return;
    if (handleTranscribeRoutes(routeCtx, req, res, url, method)) return;
    if (handleTaskRoutes(routeCtx, req, res, url, method)) return;
    if (handleRunControlRoutes(routeCtx, req, res, url, method)) return;
    if (handleAuthRoutes(routeCtx, req, res, url, method)) return;
    if (handleIntegrationRoutes(routeCtx, req, res, url, method)) return;
    if (handleMcpRoutes(routeCtx, req, res, url, method)) return;

    json(res, 404, { error: "not found" });
  }

  async function dispose(): Promise<void> {
    // A window closed (or switched project) mid-run: stop the run itself, any
    // run-all sweep or autopilot turn, and a model download this window
    // started. Otherwise they keep streaming tokens and running tools on a
    // session that is being torn down.
    abortOwnedWork();
    cancelHfPull();
    releaseRunAwake?.();
    releaseRunAwake = null;
    releaseSubagentAwake?.();
    releaseSubagentAwake = null;
    elicitations.cancelAll();
    asks.cancelAll();
    tasksPollStopped = true;
    if (tasksPoll) clearTimeout(tasksPoll);
    gitPollStopped = true;
    if (gitPoll) clearTimeout(gitPoll);
    gitHubPollStopped = true;
    if (gitHubPoll) clearTimeout(gitHubPoll);
    ciPoll.stop();
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
