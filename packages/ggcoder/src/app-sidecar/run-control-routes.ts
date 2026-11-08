import type { Provider } from "@kleio/ai";
import {
  ALL_PROVIDERS,
  saveProjectModelPrefs,
  persistModelSelection,
  persistThinkingLevel,
  saveKenModelPref,
} from "./app-settings.js";
import { getAllModels, getModel } from "../core/model-registry.js";
import { findProbedModel, localModelShortName, parseLocalModelId } from "@kleio/core";
import { json, readBody } from "./http.js";
import {
  isThinkingLevelSupported,
  getNextThinkingLevel,
  getSupportedThinkingLevels,
} from "../core/thinking-level.js";
import { log } from "../core/logger.js";
import type { SessionRouteContext } from "./route-context.js";
import type http from "node:http";

export function handleRunControlRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url === "/models") {
    void (async () => {
      const loggedIn: Provider[] = [];
      for (const p of ALL_PROVIDERS) {
        if (await ctx.auth.hasProviderAuth(p)) loggedIn.push(p);
      }
      // Just the names, grouped by provider in registry order — the UI shows
      // a clean multi-column list of model ids. Local models come from the
      // runtime registry (populated by the background scan) and are always
      // listed: their "login" is the endpoint answering a probe.
      const models = getAllModels()
        .filter((m) => m.provider === "local" || loggedIn.includes(m.provider))
        .map((m) => {
          if (m.provider !== "local") {
            // `billing` flags models that change what the user pays (fast modes).
            return {
              id: m.id,
              name: m.name,
              provider: m.provider,
              ...(m.billing ? { billing: m.billing } : {}),
            };
          }
          const probed = findProbedModel(ctx.localProbes, m.id);
          const rawId = parseLocalModelId(m.id)?.rawId;
          return {
            id: m.id,
            // The app groups local models by endpoint, so the name drops the
            // registry's "(Endpoint)" suffix, like every other model's name.
            name: rawId ? localModelShortName(rawId) : m.name,
            provider: m.provider,
            local: true,
            endpoint: probed?.endpoint.label ?? parseLocalModelId(m.id)?.endpointId,
            // A local model that can't call tools can't run the agent — the UI
            // renders it disabled rather than hiding it, so the user learns why.
            supportsTools: probed?.model.supportsTools ?? true,
            contextWindow: m.contextWindow,
            contextWindowKnown: probed?.model.contextWindowKnown ?? false,
            supportsThinking: m.supportsThinking,
          };
        });
      json(res, 200, { models });
    })();
    return true;
  }

  if (method === "POST" && url === "/model") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let modelId: string;
      let confirmPaid: boolean;
      try {
        const body = JSON.parse(raw) as { model?: string; confirmPaid?: unknown };
        modelId = body.model ?? "";
        confirmPaid = body.confirmPaid === true;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const target = getModel(modelId);
      if (!target) {
        json(res, 404, { error: `unknown model: ${modelId}` });
        return;
      }
      // A model that spends real money (Claude fast mode bills usage credits)
      // is never switched to implicitly: the caller must pass the user's
      // explicit confirmation. Fails closed for every client of this route.
      if (target.billing?.paid && !confirmPaid) {
        json(res, 409, {
          error: `${target.name} spends real money: ${target.billing.detail} Confirm before switching.`,
          requiresPaidConfirmation: true,
          billing: target.billing,
        });
        return;
      }
      if (ctx.running) {
        json(res, 409, { error: "cannot switch model while running" });
        return;
      }
      if (target.provider === "local") {
        const problem = await ctx.localModelBlocker(target.id);
        if (problem) {
          json(res, 409, { error: problem });
          return;
        }
      }
      await ctx.session.switchModel(target.provider, target.id, { confirmPaid });
      // Picking an Ollama model loads it, so the footer shows the context Ollama
      // really serves instead of the 4K guess. Never delays the switch.
      if (target.provider === "local") void ctx.learnServedContext(target.id, true).catch(() => {});
      // Ken follows GG Coder's model only while un-pinned; a user-set Ken
      // override survives GG model switches untouched.
      if (!ctx.kenModelOverride) {
        await ctx.syncKenModel(target.provider, target.id);
        await ctx.syncKenAutoModel(target.provider, target.id);
      }
      // Clamp the reasoning level to what the new model supports (mirrors the
      // CLI): keep thinking on at the first supported tier if it was on but
      // the prior level is unsupported here; leave it off if it was off.
      const prevLevel = ctx.session.getThinkingLevel();
      if (prevLevel && !isThinkingLevelSupported(target.provider, target.id, prevLevel)) {
        ctx.session.setThinkingLevel(getNextThinkingLevel(target.provider, target.id, undefined));
      }
      // Persist per-project so THIS window/project restores its own model on
      // restart (not the single global slot every window shares). Keep the
      // global write too as a "last used" fallback for never-opened projects
      // and so the CLI stays in sync.
      await saveProjectModelPrefs(ctx.cwd, {
        provider: target.provider,
        model: target.id,
        thinkingEnabled: !!ctx.session.getThinkingLevel(),
        thinkingLevel: ctx.session.getThinkingLevel() ?? undefined,
      });
      await persistModelSelection(ctx.paths.settingsFile, target.provider, target.id);
      await persistThinkingLevel(ctx.paths.settingsFile, ctx.session.getThinkingLevel());
      const payload = {
        thinkingLevel: ctx.session.getThinkingLevel() ?? null,
        supportedThinkingLevels: getSupportedThinkingLevels(target.provider, target.id),
      };
      // model_change is emitted by switchModel; follow with thinking_change so
      // the footer toggle reflects the new model's supported levels.
      ctx.broadcast("thinking_change", payload);
      // Un-pinned Ken just followed the switch — update his footer chip too.
      // When Ken is pinned, his effective model did not change, so skip the
      // no-op event (keeps footer/event tests from treating a GG switch as a
      // Ken switch).
      if (!ctx.kenModelOverride) ctx.broadcast("ken_model_change", ctx.kenStatePayload());
      // The new model usually has a different context window — push extras so
      // the footer's context meter rescales immediately.
      ctx.broadcast("extras", ctx.footerExtras());
      json(res, 200, { provider: target.provider, model: target.id, ...payload });
    });
    return true;
  }

  // Set or clear Ken's model pin. Body: { model: "<id>" } to pin, or
  // { model: null } / "" to clear (Ken resumes following GG Coder). Applies
  // to BOTH Ken sessions (chat + autopilot reviewer); a switch landing while
  // either is mid-run defers via the pending-model mechanics.
  if (method === "POST" && url === "/ken/model") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let modelId: string | null;
      try {
        const parsed = (JSON.parse(raw) as { model?: string | null }).model;
        modelId = typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      // Same lock as POST /model, for the same reason: this retargets Ken's
      // chat session AND the autopilot reviewer, and `switchModel` on a
      // session mid-turn races the stream it is already consuming. The
      // footer picker is disabled to match; this is the enforcement.
      if (ctx.running || ctx.kenRunning || ctx.autopilotReviewing) {
        json(res, 409, { error: "cannot switch Ken's model while running" });
        return;
      }
      if (modelId === null) {
        // Clear the pin → follow GG Coder again, syncing both sessions back.
        ctx.kenModelOverride = null;
        await saveKenModelPref(ctx.cwd, null);
        const st = ctx.session.getState();
        await ctx.syncKenModel(st.provider, st.model);
        await ctx.syncKenAutoModel(st.provider, st.model);
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
        // Ken and the autopilot reviewer run unwatched in the background, so
        // they never run on a model that spends real money.
        if (target.billing?.paid) {
          json(res, 400, {
            error: `${target.name} spends real money, so it's only for your main chat. Pick another model for Ken.`,
          });
          return;
        }
        ctx.kenModelOverride = { provider: target.provider, model: target.id };
        await saveKenModelPref(ctx.cwd, ctx.kenModelOverride);
        await ctx.syncKenModel(target.provider, target.id);
        await ctx.syncKenAutoModel(target.provider, target.id);
        log("INFO", "app-sidecar", "ken model pinned", {
          provider: target.provider,
          model: target.id,
        });
      }
      const payload = ctx.kenStatePayload();
      ctx.broadcast("ken_model_change", payload);
      json(res, 200, payload);
    });
    return true;
  }

  // Pending queued steering, for the composer's cancel affordance.
  if (method === "GET" && url === "/queued") {
    json(res, 200, { queued: ctx.session.listQueuedMessages() });
    return true;
  }

  // Cancel one pending queued message by id.
  if (method === "POST" && url === "/queued/cancel") {
    void readBody(req, res).then((raw) => {
      if (raw === null) return;
      let id: string;
      try {
        id = (JSON.parse(raw) as { id?: string }).id ?? "";
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (!id.trim()) {
        json(res, 400, { error: "missing queued message id" });
        return;
      }
      // `false` means it already drained into the run between render and
      // click. That is a race, not an error, so report it as a normal result
      // and let the client reconcile through the ordered event stream.
      const cancelled = ctx.session.cancelQueuedMessage(id);
      const queued = ctx.session.listQueuedMessages();
      ctx.broadcast("queued", {
        count: queued.length,
        messages: queued,
        ...(cancelled ? { cancelledId: id } : {}),
      });
      json(res, 200, { cancelled, queued });
    });
    return true;
  }

  if (method === "POST" && url === "/kill") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
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
      const message = await ctx.session.killBackgroundProcess(id);
      // Push the updated task list right away rather than waiting for the poll.
      ctx.broadcast("tasks", { tasks: ctx.session.listBackgroundProcesses() });
      json(res, 200, { message });
    });
    return true;
  }

  // Import a Claude Code / Codex / Cursor transcript into a resumable GG
  // Coder session. The importer never throws — it returns a typed failure so
  // the app can show the reason verbatim.
  if (method === "POST" && url === "/import-transcript") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let body: { path?: string; cwd?: string };
      try {
        body = JSON.parse(raw) as { path?: string; cwd?: string };
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const filePath = body.path?.trim();
      if (!filePath) {
        json(res, 400, { error: "missing transcript path" });
        return;
      }
      const result = await ctx.session.importForeignTranscript(filePath, {
        ...(body.cwd ? { cwd: body.cwd } : {}),
      });
      json(res, result.ok ? 200 : 400, result);
    });
    return true;
  }

  if (method === "POST" && url === "/thinking") {
    // The in-flight request already carries its reasoning config, so a
    // mid-run cycle cannot affect the turn the user is watching — it just
    // persists a level the footer then reports for a run that never used it.
    // Locked like POST /model; the footer button is disabled to match.
    if (ctx.running) {
      json(res, 409, { error: "cannot change reasoning level while running" });
      return true;
    }
    const st = ctx.session.getState();
    const next = getNextThinkingLevel(st.provider, st.model, ctx.session.getThinkingLevel());
    ctx.session.setThinkingLevel(next);
    // Persist per-project so THIS window restores its thinking state on
    // restart; keep the global write as a fallback (mirrors the CLI).
    void saveProjectModelPrefs(ctx.cwd, {
      provider: st.provider,
      model: st.model,
      thinkingEnabled: !!next,
      thinkingLevel: next ?? undefined,
    }).then(() => persistThinkingLevel(ctx.paths.settingsFile, next));
    const payload = {
      thinkingLevel: next ?? null,
      supportedThinkingLevels: getSupportedThinkingLevels(st.provider, st.model),
    };
    ctx.broadcast("thinking_change", payload);
    json(res, 200, payload);
    return true;
  }

  if (method === "POST" && url === "/prewarm") {
    // Best-effort Anthropic cache prewarm on the composer's first keystroke.
    // Fire-and-forget: AgentSession.prewarm() applies its own gating (provider,
    // setting, history size, TTL, in-flight) and swallows request errors.
    if (!ctx.running) {
      void ctx.session.prewarm().catch((err: unknown) => {
        log("WARN", "app-sidecar", "prewarm failed", { err: String(err) });
      });
    }
    json(res, 202, { accepted: !ctx.running });
    return true;
  }

  if (method === "POST" && url === "/cancel") {
    void (async () => {
      // Even between task runs, cancellation stops the sweep. Active provider
      // ownership invokes the full abort hook exactly once through lifecycle.
      ctx.taskRunAll = false;
      ctx.autopilotCancelled = true;
      if (!ctx.runLifecycle.running) {
        ctx.kenAutoAbort.abort();
        ctx.kenAutoAbort = new AbortController();
        ctx.kenAutoSession?.setSignal(ctx.kenAutoAbort.signal);
      }

      const generation = ctx.runLifecycle.generation;
      if (!ctx.pendingCancelDrain || ctx.pendingCancelDrain.generation !== generation) {
        ctx.pendingCancelDrain = { generation, text: ctx.session.drainQueue() };
        ctx.broadcast("queued", { count: 0, messages: [] });
      }
      const result = await ctx.runLifecycle.cancel(ctx.CANCEL_TIMEOUT_MS);
      const drained = ctx.pendingCancelDrain.text;
      if (result.status === "failed") {
        ctx.broadcast("cancel_failed", {
          error: "cancel_failed",
          reason: result.reason,
          runState: ctx.runLifecycle.state,
        });
        json(res, 504, {
          error: "cancel_failed",
          reason: result.reason,
          runState: ctx.runLifecycle.state,
          drained,
        });
        return;
      }
      json(res, 200, {
        cancelled: result.status === "cancelled",
        runState: ctx.runLifecycle.state,
        drained,
      });
    })().catch((error) => {
      ctx.broadcast("cancel_failed", { error: "cancel_failed", runState: ctx.runLifecycle.state });
      json(res, 500, {
        error: "cancel_failed",
        message: error instanceof Error ? error.message : String(error),
        runState: ctx.runLifecycle.state,
      });
    });
    return true;
  }

  if (method === "POST" && url === "/new-session") {
    if (ctx.running) {
      json(res, 409, { error: "cannot start a new session while running" });
      return true;
    }
    void ctx.session
      .newSession()
      .then(async () => {
        if (ctx.mode === "chat") {
          await ctx.session.persistAppMarker("agent_handoff", { chatAgent: ctx.chatAgent });
        }
        ctx.deactivateApprovedPlan();
        ctx.injectedAutopilotPrompts = [];
        ctx.clearPendingPlan();
        ctx.broadcast("session_reset", {});
        json(res, 200, { ok: true });
      })
      .catch((err) => {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    return true;
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
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let planPath: string | undefined;
      try {
        planPath = (JSON.parse(raw) as { planPath?: string }).planPath || undefined;
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (ctx.running || ctx.runClaim.active) {
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
      ctx.clearPendingPlan();
      ctx.autopilotCancelled = true;
      ctx.kenAutoAbort.abort();
      ctx.kenAutoAbort = new AbortController();
      ctx.kenAutoSession?.setSignal(ctx.kenAutoAbort.signal);
      if (ctx.autopilotReviewing) {
        ctx.autopilotReviewing = false;
        ctx.broadcast("autopilot_ignored", {});
      }
      try {
        await ctx.session.newSession(true);
        ctx.injectedAutopilotPrompts = [];
        const planTotal = await ctx.activateApprovedPlan(planPath);
        ctx.broadcast("session_reset", { planTotal });
        ctx.broadcast("plan_progress", ctx.planProgressPayload());
        json(res, 200, { ok: true, planTotal });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    return true;
  }

  return false;
}
