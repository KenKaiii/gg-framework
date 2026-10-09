import fs from "node:fs/promises";
import type { Provider, MessageProvenance } from "@kenkaiiii/gg-ai";
import type { AgentSession } from "../core/agent-session.js";
import type { RunLifecycle } from "../core/run-lifecycle.js";
import { buildKenAutopilotContext, buildKenAutopilotPlanContext } from "../core/ken-context.js";
import { parseAutopilotVerdict, type AutopilotVerdict } from "../core/autopilot-verdict.js";
import {
  isWorkflowCommandText,
  countAssistantMessages,
  shouldStartAutopilotCycle,
  extractTurnToolCalls,
  isMechanicalOnlyTurn,
  type WorkflowCommandSpec,
} from "../core/autopilot-gate.js";
import { driveAutopilotCycle, frameAutopilotInjection } from "../core/autopilot-cycle.js";
import type { RunOutcome } from "../core/session-manager.js";
import { autopilotMarkerCopySeed } from "../core/session-history.js";
import {
  loadTasksSync,
  pruneDoneTasksSync,
  getNextPendingTask,
  markTaskInProgress,
} from "../core/tasks-store.js";
import { log } from "../core/logger.js";
import { lastAssistantText } from "./ken-context.js";

const AUTOMATION_PROVENANCE: MessageProvenance = {
  source: "runtime",
  kind: "automation",
  visibility: "hidden",
};

/** Closure state of one session that the autopilot / stranded-queue / task runners use. */
export interface AutopilotRunnerContext {
  autopilotReviewing: boolean;
  readonly broadcast: (type: string, data: unknown) => void;
  readonly ensureKenAutoSession: () => Promise<AgentSession>;
  readonly cwd: string;
  gitBranch: string | null;
  session: AgentSession;
  injectedAutopilotPrompts: string[];
  readonly loadWorkflowCommandSpecs: () => Promise<WorkflowCommandSpec[]>;
  autopilotCancelled: boolean;
  readonly broadcastError: (
    type: "error" | "ken_error" | "autopilot_error",
    logLabel: string,
    err: unknown,
  ) => void;
  pendingKenAutoModel: { provider: Provider; model: string } | null;
  readonly syncKenAutoModel: (provider: Provider, model: string) => Promise<void>;
  pendingPlanPath: string | null;
  planGeneration: number;
  pendingPlanContent: string;
  autopilot: boolean;
  readonly runLifecycle: RunLifecycle;
  readonly abortOwnedWork: () => void;
  pendingCancelDrain: { generation: number; text: string } | null;
  autopilotActive: boolean;
  readonly MAX_AUTOPILOT_ROUNDS: number;
  readonly activateApprovedPlan: (planPath: string | undefined) => Promise<number>;
  readonly clearPendingPlan: () => void;
  readonly planProgressPayload: () => { total: number; completed: number[] };
  readonly IMPLEMENT_PLAN_PROMPT: string;
  readonly runAgent: (
    label: string,
    run: () => Promise<void>,
    reviewPending?: () => boolean,
  ) => Promise<void>;
  kenAutoSession: AgentSession | null;
  readonly reenterPlanModeForRevision: () => Promise<void>;
  readonly finishOwnedGeneration: (
    generation: number,
    emitCancelledFallback: boolean,
    outcome?: RunOutcome,
  ) => boolean;
  drainingStrandedQueue: boolean;
  running: boolean;
  readonly offerPendingPlan: () => void;
  readonly deactivateApprovedPlan: () => void;
  taskRunAll: boolean;
}

export interface AutopilotRunnerContextApi {
  runAutopilotReview: (originalRequest: string) => Promise<AutopilotVerdict | null>;
  runAutopilotPlanReview: (originalRequest: string) => Promise<AutopilotVerdict | null>;
  runAutopilotCycle: (originalRequest: string) => Promise<void>;
  runStrandedQueue: () => Promise<void>;
  runTaskById: (taskId: string) => Promise<boolean>;
  runTasks: (startId: string | null, all: boolean) => Promise<void>;
}

export function createAutopilotRunner(ctx: AutopilotRunnerContext): AutopilotRunnerContextApi {
  // ── Autopilot orchestration ─────────────────────────────────
  // One review = prompt the kenAuto session with the review digest, read its
  // final assistant text, parse a verdict. Returns null on failure (surfaced as
  // an autopilot_error frame) so the cycle stops rather than looping blind.
  // `originalRequest` is the user prompt that started the turn under review —
  // pinned in the digest so it can't scroll out during multi-round cycles.
  async function runAutopilotReview(originalRequest: string): Promise<AutopilotVerdict | null> {
    ctx.autopilotReviewing = true;
    ctx.broadcast("autopilot_review_start", {});
    try {
      const ken = await ctx.ensureKenAutoSession();
      const digest = buildKenAutopilotContext({
        cwd: ctx.cwd,
        gitBranch: ctx.gitBranch,
        messages: ctx.session.getMessages(),
        verificationEvidence: ctx.session.getVerificationEvidence(),
        verificationProblem: ctx.session.getVerificationProblem(),
        originalRequest,
        injectedPrompts: [...ctx.injectedAutopilotPrompts],
        workflowCommands: await ctx.loadWorkflowCommandSpecs(),
      });
      await ken.prompt(digest);
      return parseAutopilotVerdict(lastAssistantText(ken.getMessages()));
    } catch (err) {
      if (!ctx.autopilotCancelled)
        ctx.broadcastError("autopilot_error", "autopilot review failed", err);
      return null;
    } finally {
      ctx.autopilotReviewing = false;
      // Apply any model switch that landed mid-review.
      const pending = ctx.pendingKenAutoModel;
      ctx.pendingKenAutoModel = null;
      if (pending) await ctx.syncKenAutoModel(pending.provider, pending.model);
    }
  }

  // One PLAN review: like runAutopilotReview but the digest carries the
  // submitted plan's markdown (`## Plan under review`) and the plan-review
  // instruction — Ken judges the plan itself, not finished work. Returns null
  // on failure; a failure caused by the user's own action racing the review
  // (cancel or a manual Accept/Reject that bumped planGeneration) stays
  // SILENT — no autopilot_error — because the user's decision already won.
  async function runAutopilotPlanReview(originalRequest: string): Promise<AutopilotVerdict | null> {
    const planPath = ctx.pendingPlanPath;
    if (planPath === null) return null;
    const genAtStart = ctx.planGeneration;
    ctx.autopilotReviewing = true;
    ctx.broadcast("autopilot_review_start", {});
    try {
      const ken = await ctx.ensureKenAutoSession();
      // Re-read the plan file (the run may have revised it in place); fall
      // back to the content captured at exit_plan time.
      const planContent = await fs.readFile(planPath, "utf-8").catch(() => ctx.pendingPlanContent);
      const digest = buildKenAutopilotPlanContext({
        cwd: ctx.cwd,
        gitBranch: ctx.gitBranch,
        messages: ctx.session.getMessages(),
        verificationEvidence: ctx.session.getVerificationEvidence(),
        verificationProblem: ctx.session.getVerificationProblem(),
        originalRequest,
        injectedPrompts: [...ctx.injectedAutopilotPrompts],
        workflowCommands: await ctx.loadWorkflowCommandSpecs(),
        planContent,
      });
      await ken.prompt(digest);
      if (ctx.autopilotCancelled || ctx.planGeneration !== genAtStart) return null;
      return parseAutopilotVerdict(lastAssistantText(ken.getMessages()));
    } catch (err) {
      // User action mid-review (manual Accept aborts the kenAuto run): drop
      // the review silently — the user's decision supersedes Ken's.
      if (ctx.autopilotCancelled || ctx.planGeneration !== genAtStart) return null;
      ctx.broadcastError("autopilot_error", "autopilot plan review failed", err);
      return null;
    } finally {
      ctx.autopilotReviewing = false;
      // Apply any model switch that landed mid-review.
      const pending = ctx.pendingKenAutoModel;
      ctx.pendingKenAutoModel = null;
      if (pending) await ctx.syncKenAutoModel(pending.provider, pending.model);
    }
  }

  // Drive the review→prompt→review loop for one finished user turn. Only ever
  // called after shouldStartAutopilotCycle approves the turn (POST /prompt or
  // the stranded-queue drain) — never from the task runner, resume, /ken, or
  // error paths, so there's no recursion and no guard tangle. The loop's
  // control flow lives in driveAutopilotCycle (core/autopilot-cycle.ts) so
  // every exit path is unit-tested; this only wires the real dependencies.
  async function runAutopilotCycle(originalRequest: string): Promise<void> {
    if (!ctx.autopilot || ctx.autopilotCancelled) return;
    // Unchecked work enters the cycle too: driveAutopilotCycle asks for the
    // checks once before Ken reviews, and hands back only if still unchecked.
    const generation = ctx.runLifecycle.begin(ctx.abortOwnedWork).generation;
    ctx.pendingCancelDrain = null;
    ctx.autopilotActive = true;
    // Generation captured by the last plan review; acceptPlan re-checks it so
    // a user Accept/Reject landing mid-review always wins.
    let planGenAtReview = -1;
    try {
      await driveAutopilotCycle({
        // A plan-pending cycle needs extra rounds: approve+implement and the
        // post-implement work review each consume one, so +2 keeps a real fix
        // round available.
        maxRounds:
          ctx.pendingPlanPath !== null ? ctx.MAX_AUTOPILOT_ROUNDS + 2 : ctx.MAX_AUTOPILOT_ROUNDS,
        isCancelled: () => ctx.autopilotCancelled,
        verificationProblem: () => ctx.session.getVerificationProblem(),
        // An injected run entering plan mode WITHOUT submitting (enter_plan,
        // no exit_plan) halts the cycle — Ken never prompts into a read-only
        // plan-mode session. A submitted plan takes the planPending branch.
        isPlanMode: () => ctx.session.getPlanMode(),
        planPending: () => ctx.pendingPlanPath !== null,
        reviewPlan: async () => {
          planGenAtReview = ctx.planGeneration;
          return runAutopilotPlanReview(originalRequest);
        },
        // Auto-accept: the inlined POST /plan/accept body. Returns false when
        // the plan generation moved since the review (user acted) — the cycle
        // exits silently and the user's action stands.
        acceptPlan: async (reason) => {
          if (ctx.pendingPlanPath === null || ctx.planGeneration !== planGenAtReview) return false;
          const planPath = ctx.pendingPlanPath;
          let planTotal: number;
          try {
            await ctx.session.newSession(true);
            ctx.injectedAutopilotPrompts = [];
            planTotal = await ctx.activateApprovedPlan(planPath);
          } catch (err) {
            ctx.broadcastError("autopilot_error", "autopilot plan accept failed", err);
            return false;
          }
          ctx.clearPendingPlan();
          // Keep the approval marker ahead of the reset, then seed the reset
          // with the sidecar's canonical count from the actual plan file.
          ctx.broadcast("autopilot_plan_accepted", reason ? { reason } : {});
          ctx.broadcast("session_reset", { planTotal });
          ctx.broadcast("plan_progress", ctx.planProgressPayload());
          // Persisted into the NEW session so a resume shows the marker.
          void ctx.session.persistAutopilotMarker("plan_approved", { reason });
          return true;
        },
        runImplement: () => {
          // Autopilot-injected run: frame it so GG Coder knows no human is
          // watching the implementation. Record the framed string so Ken's
          // digest labels it as injected, not as the user's ask. The run_start
          // label stays the clean prompt.
          const framed = frameAutopilotInjection(ctx.IMPLEMENT_PLAN_PROMPT);
          ctx.injectedAutopilotPrompts.push(framed);
          return ctx.runAgent(ctx.IMPLEMENT_PLAN_PROMPT, () =>
            ctx.session.prompt(framed, AUTOMATION_PROVENANCE),
          );
        },
        // Lean context per user turn: wipe prior review history so each new
        // turn starts cheap, while within this cycle the few review messages
        // persist so Ken remembers what he already asked GG Coder to fix.
        resetReviewer: async () => {
          await ctx.kenAutoSession?.newSession().catch(() => {});
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
          ctx.clearPendingPlan();
          // Record the FRAMED string (what actually lands in the build session,
          // see runPrompt) so Ken's digest matches and labels it as injected.
          // The webview marker + persisted body stay the CLEAN prompt so the UI
          // shows Ken's actual instruction, not the autopilot preamble.
          ctx.injectedAutopilotPrompts.push(frameAutopilotInjection(body));
          ctx.broadcast("autopilot_prompted", { round, body });
          void ctx.session.persistAutopilotMarker("prompted", { body });
        },
        // Autopilot-injected run: GG Coder receives the framed prompt (no human
        // is watching this turn) while run_start keeps the clean label.
        runPrompt: (body, opts) =>
          ctx.runAgent(body, async () => {
            if (opts?.planRevision) await ctx.reenterPlanModeForRevision();
            await ctx.session.prompt(frameAutopilotInjection(body), AUTOMATION_PROVENANCE);
          }),
        emit: (event) => {
          // Persist the terminal verdict marker so a resumed session renders the
          // same Ken bubble the live run showed instead of dropping it or
          // falling back to the raw verdict text (e.g. ALL_CLEAR).
          if (event.type === "autopilot_done") {
            // Broadcast the SAME copySeed the persisted marker will produce on
            // resume, so the live all-clear wording matches the resumed one.
            // Must use the PERSISTED count — that's what persistAutopilotMarker
            // anchors against, and it trails the in-memory list after a run
            // whose messages never made it to disk.
            const seed = autopilotMarkerCopySeed({
              version: 1,
              phase: "done",
              afterMessageCount: ctx.session.getPersistedTranscriptCount(),
              ...event.data,
            });
            ctx.broadcast(event.type, { ...event.data, copySeed: seed });
            void ctx.session.persistAutopilotMarker("done", event.data);
            return;
          }
          ctx.broadcast(event.type, event.data);
          if (event.type === "autopilot_human") {
            void ctx.session.persistAutopilotMarker("human", { reason: event.data.reason });
          } else if (event.type === "autopilot_capped") {
            void ctx.session.persistAutopilotMarker("capped");
          }
          // autopilot_ignored renders nothing live, so nothing is persisted either.
        },
      });
    } finally {
      ctx.autopilotActive = false;
      ctx.finishOwnedGeneration(
        generation,
        true,
        ctx.session.getVerificationProblem() ? "unverified" : "completed",
      );
      queueMicrotask(() => void runStrandedQueue());
    }
  }
  async function runStrandedQueue(): Promise<void> {
    if (ctx.drainingStrandedQueue) return;
    ctx.drainingStrandedQueue = true;
    try {
      for (;;) {
        if (ctx.running || ctx.autopilotActive) return;
        const next = ctx.session.takeNextQueuedMessage();
        if (!next) return;
        ctx.broadcast("queued", {
          count: ctx.session.getQueuedCount(),
          messages: ctx.session.listQueuedMessages(),
        });
        if (!next.text.trim() && next.attachments.length === 0) continue;
        // A queued message draining as a fresh turn supersedes any pending
        // plan and clears a stale Stop, exactly like a direct POST /prompt
        // turn — otherwise an earlier Stop silently disables Ken for this turn.
        ctx.clearPendingPlan();
        ctx.autopilotCancelled = false;
        const workflowCommand =
          next.attachments.length === 0 &&
          isWorkflowCommandText(next.text, await ctx.loadWorkflowCommandSpecs());
        const assistantsBefore = countAssistantMessages(ctx.session.getMessages());
        const messagesBefore = ctx.session.getMessages().length;
        await ctx.runAgent(
          next.text,
          async () => {
            if (next.attachments.length > 0) {
              await ctx.session.promptWithAttachments(next.text, next.attachments);
            } else {
              await ctx.session.prompt(next.text);
            }
          },
          () => ctx.autopilot,
        );
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
          log("INFO", "app-sidecar", "autopilot cycle starting (queued turn)", {
            kind: decision.kind,
          });
          await runAutopilotCycle(next.text);
        } else {
          ctx.broadcast("autopilot_ignored", { reason: decision.reason });
          log("INFO", "app-sidecar", "autopilot skipped (queued turn)", {
            reason: decision.reason,
          });
        }
      }
    } finally {
      ctx.drainingStrandedQueue = false;
      ctx.offerPendingPlan();
    }
  }

  async function runTaskById(taskId: string): Promise<boolean> {
    const task = loadTasksSync(ctx.cwd).find((t) => t.id === taskId || t.id.startsWith(taskId));
    if (!task) return false;
    // Fresh session per task so one task's context never bleeds into the next.
    await ctx.session.newSession();
    ctx.deactivateApprovedPlan();
    ctx.injectedAutopilotPrompts = [];
    ctx.clearPendingPlan();
    ctx.broadcast("session_reset", {});
    markTaskInProgress(ctx.cwd, task.id);
    ctx.broadcast("tasks_list", { tasks: loadTasksSync(ctx.cwd) });
    ctx.broadcast("task_start", { id: task.id, title: task.title });
    // Persist the task header so a resumed task session shows what ran.
    void ctx.session.persistAppMarker("task", { title: task.title }).catch(() => {});
    const shortId = task.id.slice(0, 8);
    const completionHint =
      `\n\n---\nWhen you have fully completed this task, call the tasks tool to mark it done:\n` +
      `tasks({ action: "done", id: "${shortId}" })`;
    await ctx.runAgent(task.title, () =>
      ctx.session.prompt(task.prompt + completionHint, AUTOMATION_PROVENANCE),
    );
    // The agent typically marks the task done via the tasks tool during the run;
    // prune completed tasks and push the refreshed list so the modal drops them.
    ctx.broadcast("tasks_list", { tasks: pruneDoneTasksSync(ctx.cwd) });
    return true;
  }

  async function runTasks(startId: string | null, all: boolean): Promise<void> {
    ctx.taskRunAll = all;
    let currentId: string | null = startId ?? getNextPendingTask(ctx.cwd)?.id ?? null;
    while (currentId) {
      const ran = await runTaskById(currentId);
      if (!ran || !ctx.taskRunAll) break;
      const next = getNextPendingTask(ctx.cwd);
      currentId = next ? next.id : null;
      // Brief pause between tasks (mirrors the CLI cadence).
      if (currentId) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    ctx.taskRunAll = false;
    ctx.broadcast("tasks_run_done", {});
    // Task runs never start an autopilot cycle; a plan a task submitted goes
    // straight to the user.
    ctx.offerPendingPlan();
  }

  return {
    runAutopilotReview,
    runAutopilotPlanReview,
    runAutopilotCycle,
    runStrandedQueue,
    runTaskById,
    runTasks,
  };
}
