import { json, readBody } from "./http.js";
import { PROMPT_COMMANDS } from "../core/prompt-commands.js";
import { type AppAttachment, prepareAttachments } from "./attachments.js";
import {
  isWorkflowCommandText,
  countAssistantMessages,
  shouldStartAutopilotCycle,
  isMechanicalOnlyTurn,
  extractTurnToolCalls,
} from "../core/autopilot-gate.js";
import { log } from "../core/logger.js";
import { buildKenContext, lastAssistantText } from "./ken-context.js";
import { saveAutopilot } from "./app-settings.js";
import type { SessionRouteContext } from "./route-context.js";
import type http from "node:http";

export function handlePromptRoutes(
  ctx: SessionRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url === "/commands") {
    if (ctx.mode !== "code") {
      json(res, 200, { commands: [] });
      return true;
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
      // Desktop-safe registry actions belong in the same picker as workflows.
      // Most registry commands have dedicated app controls or TUI-only flows;
      // multi-root management has no other affordance, so expose only these.
      const workspaceActions = [
        {
          name: "add-dir",
          aliases: ["adddir"],
          description: "Add another project folder to this workspace",
          source: "built-in" as const,
        },
        {
          name: "remove-dir",
          aliases: ["removedir"],
          description: "Remove an added project folder from this workspace",
          source: "built-in" as const,
        },
      ];
      const custom = (await ctx.session.loadCustomCommands())
        // A custom command can't shadow a built-in name or app action.
        .filter(
          (c) =>
            !PROMPT_COMMANDS.some((b) => b.name === c.name) &&
            !workspaceActions.some((action) => action.name === c.name),
        )
        .map((c) => ({
          name: c.name,
          aliases: [] as string[],
          description: c.description,
          source: "custom" as const,
        }));
      json(res, 200, { commands: [...workspaceActions, ...builtins, ...custom] });
    })();
    return true;
  }

  if (method === "POST" && url === "/prompt") {
    // Per-request: only the prompt that actually claimed the start may release
    // it. A bare release would let an early-returning request (bad JSON, or a
    // prompt that queued) clear a claim another request is still holding.
    let claimedStart = false;
    void readBody(req, res)
      .then(async (raw) => {
        if (raw === null) return;
        let text: string;
        let attachments: AppAttachment[];
        let meta:
          | {
              kenSent?: boolean;
              enhancements?: unknown[];
              scheduled?: boolean;
              planRevision?: boolean;
            }
          | undefined;
        try {
          const body = JSON.parse(raw) as {
            text?: string;
            attachments?: AppAttachment[];
            meta?: {
              kenSent?: boolean;
              enhancements?: unknown[];
              scheduled?: boolean;
              planRevision?: boolean;
            };
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
        // Before the run checks below, so the run claim stays synchronous with them.
        if (meta?.scheduled !== true) await ctx.startGoalFromMessage(text);
        // A typed prompt supersedes any question parked on the user: they
        // answered with a message of their own. Release the blocked tool call
        // NOW — otherwise it waits out its ten-minute timeout while this very
        // message sits behind it as steering that only drains once the tool
        // returns, so the turn looks frozen. The webview closes the band on
        // send; a racing /ask POST just 409s.
        ctx.asks.cancelAll({ action: "cancel", superseded: true });
        if (
          ctx.runLifecycle.running &&
          ctx.runLifecycle.isCancellationRequested(ctx.runLifecycle.generation)
        ) {
          json(res, 409, {
            error: ctx.runLifecycle.state === "cancelling" ? "run_cancelling" : "cancel_failed",
            runState: ctx.runLifecycle.state,
          });
          return;
        }
        // `runClaim` covers the gap before `runAgent` flips `running`: a
        // prompt arriving in that window must queue, not start a second run.
        if (ctx.running || ctx.runClaim.active || ctx.autopilotActive) {
          // Queue prompts as mid-run steering (mirrors the CLI). Also queue while
          // an autopilot cycle is active but between injected runs (build idle,
          // Ken reviewing) so the message never starts a run that collides with
          // an injected one on the same session. Attachments are persisted to
          // .gg/uploads first so the queued media rides the same native-block
          // path as a non-queued attachment prompt when it drains.
          const prepared =
            attachments.length > 0 ? await prepareAttachments(ctx.cwd, attachments) : [];
          const count = ctx.session.queueMessage(text, prepared);
          ctx.broadcast("queued", { count, messages: ctx.session.listQueuedMessages() });
          json(res, 202, { queued: true, count });
          return;
        }
        // Claim the run NOW, synchronously. Everything below this line may
        // yield, and `running` does not flip until runAgent begins.
        claimedStart = ctx.runClaim.claim();
        // A scheduled prompt has nobody watching: short ask deadline.
        ctx.scheduledRunActive = meta?.scheduled === true;
        json(res, 202, { accepted: true });
        // Gate inputs captured around the run: whether this turn is a workflow
        // slash command (attachment prompts skip slash expansion entirely), and
        // how many assistant messages the run actually adds. Computed even when
        // autopilot is currently off — the toggle can flip ON mid-run, and the
        // gate reads the post-run value.
        const workflowCommand =
          attachments.length === 0 &&
          isWorkflowCommandText(text, await ctx.loadWorkflowCommandSpecs());
        // Does this input actually expand into a persisted user message? Asked
        // of the session itself, because only it knows whether the command
        // resolves here (name/alias casing, custom `.gg/commands`, non-coder
        // agents that don't expand at all). A looser guess would anchor the
        // hint at +1 with no message to land on — decorating an unrelated
        // later bubble with the wrong `/name`.
        const expandsToTemplate =
          attachments.length === 0 && (await ctx.session.willExpandPromptTemplate(text));
        // Webview display hint for this prompt's user bubble (kenSent shimmer
        // label / enhancer highlight segments / the `/name` a command was typed
        // as). Anchored +1 so it attaches to the user message the prompt below
        // is about to push. Queued prompts skip this (their position in the run
        // is unpredictable).
        //
        // Recording the invocation matters because the agent persists the
        // EXPANDED template as the user message. Resume used to recover
        // `/name` by matching that body against the current templates, which
        // silently fails the moment a template is edited or reworded — the
        // reopened session then rendered the raw multi-KB prompt instead of
        // the command chip.
        if (
          expandsToTemplate ||
          (meta && (meta.kenSent === true || Array.isArray(meta.enhancements)))
        ) {
          void ctx.session
            .persistAppMarker(
              "user_hint",
              {
                ...(expandsToTemplate ? { command: text.trim() } : {}),
                ...(meta?.kenSent === true ? { kenSent: true } : {}),
                ...(Array.isArray(meta?.enhancements) ? { enhancements: meta.enhancements } : {}),
              },
              1,
            )
            .catch(() => {});
        }
        // Fresh user turn: clear any cancel flag left from a prior cycle so this
        // turn's autopilot review can run.
        ctx.autopilotCancelled = false;
        // A typed message while a plan modal/review is pending (reject,
        // feedback, anything) supersedes the pending plan — the bump also
        // invalidates any in-flight Ken plan review.
        ctx.clearPendingPlan();
        const assistantsBefore = countAssistantMessages(ctx.session.getMessages());
        const messagesBefore = ctx.session.getMessages().length;
        await ctx.runAgent(
          text,
          async () => {
            // The review box's Feedback: revise read-only, like Ken's feedback.
            if (meta?.planRevision === true) await ctx.reenterPlanModeForRevision();
            if (attachments.length > 0) {
              // Persist each attachment under .gg/uploads so files are inspectable
              // by the agent's tools, then prompt with the media as native blocks.
              const prepared = await prepareAttachments(ctx.cwd, attachments);
              await ctx.session.promptWithAttachments(text, prepared);
            } else {
              // Pass the raw text straight through. AgentSession.prompt() is the
              // single source of truth for slash-command expansion (built-in +
              // `.gg/commands/*.md` custom), so the agent gets the right body
              // while the webview keeps showing the short `/name`.
              await ctx.session.prompt(text);
            }
          },
          () => ctx.autopilot,
        );
        // After the user's run settles, kick off Ken's auto-review loop — but
        // only when the turn is actually reviewable (shouldStartAutopilotCycle):
        // workflow commands (/compare, /expand, …) end with reports or
        // A/B/C choices reserved for the USER; registry commands (/help) and
        // failed runs add no assistant work to judge; a turn that ended in plan
        // mode has a pending Accept/Reject modal Ken must not preempt. This is
        // the ONLY entry point into the cycle besides the stranded-queue drain —
        // it drives any follow-up GG Coder runs itself, so the shared runAgent
        // finally never recurses.
        const decision = shouldStartAutopilotCycle({
          enabled: ctx.autopilot,
          cancelled: ctx.autopilotCancelled,
          planMode: ctx.session.getPlanMode(),
          // A submitted plan (exit_plan fired) routes into the PLAN review
          // branch — the cycle reviews the plan itself instead of skipping.
          planPending: ctx.pendingPlanPath !== null,
          workflowCommand,
          assistantMessagesAdded:
            countAssistantMessages(ctx.session.getMessages()) - assistantsBefore,
          // Skip the review API call outright for turns that only started a
          // background process (dev server/watcher), ran a read-only lookup, or
          // committed/pushed — Ken's autopilot contract already IGNOREs these,
          // so there's no reason to pay for that verdict.
          mechanicalOnly: isMechanicalOnlyTurn(
            extractTurnToolCalls(ctx.session.getMessages(), messagesBefore),
          ),
        });
        if (decision.start) {
          log("INFO", "app-sidecar", "autopilot cycle starting", { kind: decision.kind });
          await ctx.runAutopilotCycle(text);
        } else {
          ctx.broadcast("autopilot_ignored", { reason: decision.reason });
          log("INFO", "app-sidecar", "autopilot skipped", { reason: decision.reason });
        }
        // A prompt sent while Ken was reviewing (build idle) queued but had no
        // run to steer into — run it now as a fresh turn so it never strands.
        await ctx.runStrandedQueue();
      })
      .finally(() => {
        if (claimedStart) {
          ctx.scheduledRunActive = false;
          ctx.runClaim.release();
          // The claim held the plan back until the turn fully settled.
          ctx.offerPendingPlan();
        }
      });
    return true;
  }

  // Ken Kai (mentor): an independent read-only advisory run on the kenSession.
  // Runs concurrently with a build run — its events are ken_-prefixed so the
  // webview keeps the bubbles separate. The context digest is assembled fresh
  // from the BUILD session's transcript each turn (one-way mirror).
  if (method === "POST" && url === "/ken/prompt") {
    if (ctx.mode !== "code") {
      json(res, 404, {
        error: `Ken is not available in GG ${ctx.mode === "chat" ? "Chat" : "Motion"}.`,
      });
      return true;
    }
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
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
      if (ctx.kenRunning) {
        json(res, 409, { error: "Ken is already thinking — wait for his reply." });
        return;
      }
      json(res, 202, { accepted: true });
      ctx.kenRunning = true;
      const releaseKenAwake = ctx.keepAwake.acquire("ken");
      ctx.broadcast("ken_run_start", { text });
      try {
        const ken = await ctx.ensureKenSession();
        const digest = await buildKenContext(
          ctx.session,
          ctx.cwd,
          ctx.gitBranch,
          text,
          await ctx.loadWorkflowCommandSpecs(),
          ctx.injectedAutopilotPrompts,
        );
        await ken.prompt(digest);
        // Record the turn against the BUILD session so it persists + survives
        // resume (advisory custom entry, never an LLM message). Reply is Ken's
        // last assistant message; skip persistence if he produced nothing.
        const reply = lastAssistantText(ken.getMessages());
        if (reply.trim()) await ctx.session.persistKenTurn(text, reply);
      } catch (err) {
        ctx.broadcastError("ken_error", "ken run failed", err);
      } finally {
        releaseKenAwake();
        ctx.kenRunning = false;
        ctx.broadcast("ken_run_end", {});
        const pending = ctx.pendingKenModel;
        ctx.pendingKenModel = null;
        if (pending) await ctx.syncKenModel(pending.provider, pending.model);
      }
    });
    return true;
  }

  if (method === "POST" && url === "/ken/cancel") {
    ctx.kenAbort.abort();
    ctx.kenAbort = new AbortController();
    ctx.kenSession?.setSignal(ctx.kenAbort.signal);
    ctx.kenRunning = false;
    ctx.broadcast("ken_run_end", { cancelled: true });
    json(res, 200, { cancelled: true });
    return true;
  }

  if (method === "POST" && url === "/autopilot") {
    if (ctx.mode !== "code") {
      json(res, 404, {
        error: `Autopilot is not available in GG ${ctx.mode === "chat" ? "Chat" : "Motion"}.`,
      });
      return true;
    }
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
      let enabled: boolean;
      try {
        enabled = Boolean((JSON.parse(raw) as { enabled?: boolean }).enabled);
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      ctx.autopilot = enabled;
      await saveAutopilot(ctx.cwd, enabled);
      log("INFO", "app-sidecar", "autopilot toggled", { enabled: String(enabled) });
      ctx.broadcast("autopilot", { autopilot: enabled });
      json(res, 200, { autopilot: enabled });
    });
    return true;
  }

  if (method === "POST" && url === "/enhance") {
    void readBody(req, res).then(async (raw) => {
      if (raw === null) return;
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
        const result = await ctx.session.enhancePrompt(text);
        json(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("ERROR", "app-sidecar", "enhance failed", { message });
        json(res, 500, { error: message });
      }
    });
    return true;
  }

  return false;
}
