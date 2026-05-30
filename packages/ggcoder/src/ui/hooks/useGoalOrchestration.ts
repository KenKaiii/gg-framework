import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Message, Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { log } from "../../core/logger.js";
import {
  appendGoalDecision,
  appendGoalEvidence,
  formatGoalBlockingPrerequisites,
  goalHasBlockingPrerequisites,
  loadGoalRuns,
  reconcileActiveGoalRuns,
  recordGoalSubstantiveWorker,
  setGoalIntegrationState,
  updateGoalTask,
  upsertGoalRun,
  type GoalRun,
} from "../../core/goal-store.js";
import {
  APPLY_INTEGRATION_TO_MAIN_TASK_TITLE,
  FINAL_COMPLETION_AUDIT_TASK_TITLE,
  canCompleteGoalRun,
  decideGoalNextAction,
} from "../../core/goal-controller.js";
import {
  confirmAndCommitMainIntegration,
  discardStagedIntegration,
  finalizeStagedIntegration,
  stageGoalIntegration,
  type GoalStagedContext,
} from "../../core/goal-integration.js";
import { runGoalPrerequisiteChecks } from "../../core/goal-prerequisites.js";
import { runGoalVerifierCommand } from "../../core/goal-verifier.js";
import {
  checkGoalWorktreeIntegration,
  isGoalWorktreeDirtyError,
  removeGoalRunWorktrees,
} from "../../core/goal-worktree.js";
import {
  listGoalWorkers,
  startGoalWorker,
  stopGoalWorker,
  subscribeGoalWorkerCompletions,
  type GoalWorkerCompletion,
} from "../../core/goal-worker.js";
import type { SessionManager } from "../../core/session-manager.js";
import { parseGoalSyntheticEvent } from "../goal-events.js";
import {
  completedItemsWithDurableGoalTerminalProgress,
  formatGoalTerminalProgress,
  formatGoalWorkerFinishedTitle,
  getGoalContinuationChoiceKey,
  goalTerminalProgressId,
  routeGoalSyntheticEvent,
  summarizeGoalCompletion,
} from "../goal-progress.js";
import {
  buildGoalTaskPromptWithReferences,
  buildGoalUserPauseRun,
  goalRunNeedsExplicitContinuationAfterWorker,
  goalTaskProgress,
  shouldKeepGoalRunTrackedAfterDecision,
  shouldRunGoalTaskInMainCheckout,
} from "../goal-run-helpers.js";
import { toErrorItem } from "../error-item.js";
import type { CompletedItem, GoalProgressDraft, TaskItem } from "../app-items.js";
import type { DoneStatus } from "../layout-decisions.js";
import type { GoalStatusEntry } from "../components/GoalStatusBar.js";
import type { UseAgentLoopReturn } from "./useAgentLoop.js";

/** Subset of App's resetUI used by the task launcher. */
type ResetUI = (options?: {
  messages?: Message[];
  wipeSession?: boolean;
  history?: CompletedItem[];
  sessionPath?: string;
  pendingAction?: {
    prompt: string;
    infoText?: string;
    planEvent?: { event: "approved" | "rejected" | "dismissed"; detail?: string };
  };
}) => void;

/** Minimal session-store surface the orchestration touches. */
interface GoalSessionStore {
  overlay?: "model" | "goal" | "skills" | "plan" | "theme" | "pixel" | null;
}

interface UseGoalOrchestrationOptions {
  cwd: string;
  resetUI?: ResetUI;
  sessionStore?: GoalSessionStore;
  currentProvider: Provider;
  currentModel: string;
  thinkingLevel: ThinkingLevel | undefined;
  agentLoop: UseAgentLoopReturn;
  appendGoalProgress: (item: GoalProgressDraft) => void;
  goalNumberForRun: (runId: string) => number;
  clearGoalStatusEntry: (runId: string) => void;
  upsertGoalStatusEntry: (entry: GoalStatusEntry) => void;
  setGoalModeAndPrompt: (nextMode: "off" | "planner" | "setup" | "coordinator") => Promise<void>;
  clearGoalModeIfIdle: () => void;
  // Refs shared with App (declared before useAgentLoop so its callbacks can read them).
  agentRunningRef: MutableRefObject<boolean>;
  runningGoalIdsRef: MutableRefObject<Set<string>>;
  activeVerifierRunIdsRef: MutableRefObject<Set<string>>;
  queuedGoalSyntheticEventsRef: MutableRefObject<number>;
  goalContinuationFlightsRef: MutableRefObject<Set<string>>;
  goalContinuationRecentChoicesRef: MutableRefObject<Map<string, number>>;
  startGoalRunRef: MutableRefObject<(run: GoalRun) => void>;
  startTaskRef: MutableRefObject<(title: string, prompt: string, taskId: string) => void>;
  messagesRef: MutableRefObject<Message[]>;
  persistedIndexRef: MutableRefObject<number>;
  sessionManagerRef: MutableRefObject<SessionManager | null>;
  sessionPathRef: MutableRefObject<string | undefined>;
  cwdRef: MutableRefObject<string>;
  setLiveItems: Dispatch<SetStateAction<CompletedItem[]>>;
  setHistory: Dispatch<SetStateAction<CompletedItem[]>>;
  setLastUserMessage: Dispatch<SetStateAction<string>>;
  setDoneStatus: Dispatch<SetStateAction<DoneStatus | null>>;
  getId: () => string;
  clearPendingHistory: () => void;
}

export interface GoalOrchestration {
  runGoalSyntheticEvent: (eventText: string) => void;
  continueGoalRun: (runId: string) => void;
  handleGoalWorkerComplete: (run: GoalRun, completion: GoalWorkerCompletion) => void;
  startGoalRun: (run: GoalRun) => void;
  verifyGoalRun: (run: GoalRun, staging?: GoalStagedContext) => Promise<void>;
  pauseGoalRun: (run: GoalRun) => void;
  startTask: (title: string, prompt: string, taskId: string) => void;
}

/**
 * Owns the entire Goal orchestration lifecycle — synthetic-event routing,
 * continuation, worker-completion handling, the worker-completion subscription,
 * starting runs/tasks/workers, verifier execution, and pausing. Extracted
 * verbatim from `App.tsx`; the mutual recursion between these callbacks is
 * preserved via `startGoalRunRef`/`startTaskRef`.
 */
export function useGoalOrchestration({
  cwd,
  resetUI,
  sessionStore,
  currentProvider,
  currentModel,
  thinkingLevel,
  agentLoop,
  appendGoalProgress,
  goalNumberForRun,
  clearGoalStatusEntry,
  upsertGoalStatusEntry,
  setGoalModeAndPrompt,
  clearGoalModeIfIdle,
  agentRunningRef,
  runningGoalIdsRef,
  activeVerifierRunIdsRef,
  queuedGoalSyntheticEventsRef,
  goalContinuationFlightsRef,
  goalContinuationRecentChoicesRef,
  startGoalRunRef,
  startTaskRef,
  messagesRef,
  persistedIndexRef,
  sessionManagerRef,
  sessionPathRef,
  cwdRef,
  setLiveItems,
  setHistory,
  setLastUserMessage,
  setDoneStatus,
  getId,
  clearPendingHistory,
}: UseGoalOrchestrationOptions): GoalOrchestration {
  const runGoalSyntheticEvent = useCallback(
    (eventText: string) => {
      const eventInfo = parseGoalSyntheticEvent(eventText);
      const detail =
        eventInfo?.kind === "worker"
          ? `Inspecting worker result${eventInfo.task ? ` for ${eventInfo.task}` : ""}.`
          : `Inspecting verifier result${eventInfo?.status ? ` (${eventInfo.status})` : ""}.`;
      const route = routeGoalSyntheticEvent({
        agentRunning: agentRunningRef.current,
        queuedSyntheticEvents: queuedGoalSyntheticEventsRef.current,
      });
      if (route.action === "queue") {
        queuedGoalSyntheticEventsRef.current = route.nextQueuedSyntheticEvents;
        void setGoalModeAndPrompt(route.nextGoalMode);
        appendGoalProgress({
          kind: "goal_progress",
          phase: "orchestrator_reviewing",
          title: "Goal update queued for orchestrator",
          detail: `${detail} It will report back after the current turn.`,
          workerId: eventInfo?.worker,
          status: eventInfo?.status,
        });
        agentLoop.queueMessage(eventText);
        return;
      }
      appendGoalProgress({
        kind: "goal_progress",
        phase: "orchestrator_reviewing",
        title: "Orchestrator reviewing Goal update",
        detail,
        workerId: eventInfo?.worker,
        status: eventInfo?.status,
      });
      setLastUserMessage("");
      setDoneStatus(null);
      void (async () => {
        await setGoalModeAndPrompt("coordinator");
        await agentLoop.run(eventText);
      })().catch((err: unknown) => {
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
        clearGoalModeIfIdle();
      });
    },
    [agentLoop, appendGoalProgress, clearGoalModeIfIdle, setGoalModeAndPrompt],
  );

  const continueGoalRun = useCallback(
    (runId: string) => {
      if (goalContinuationFlightsRef.current.has(runId)) return;
      goalContinuationFlightsRef.current.add(runId);
      void (async () => {
        const latestRun = await reconcileActiveGoalRuns(cwd, {
          isWorkerActive: (workerId) =>
            listGoalWorkers(cwd).some(
              (worker) => worker.id === workerId && worker.status === "running",
            ),
        }).then(({ runs }) => runs.find((item) => item.id === runId) ?? null);
        if (!latestRun) {
          runningGoalIdsRef.current.delete(runId);
          clearGoalStatusEntry(runId);
          clearGoalModeIfIdle();
          return;
        }
        const decision = decideGoalNextAction(latestRun);
        if (!shouldKeepGoalRunTrackedAfterDecision(decision)) {
          runningGoalIdsRef.current.delete(runId);
          clearGoalModeIfIdle();
        }
        if (decision.kind === "wait") return;
        const choiceKey = getGoalContinuationChoiceKey({ runId: latestRun.id, decision });
        const now = Date.now();
        const recentChoiceAt = goalContinuationRecentChoicesRef.current.get(choiceKey);
        if (recentChoiceAt !== undefined && now - recentChoiceAt < 5000) return;
        goalContinuationRecentChoicesRef.current.set(choiceKey, now);
        if (goalContinuationRecentChoicesRef.current.size > 100) {
          for (const [key, startedAt] of goalContinuationRecentChoicesRef.current) {
            if (now - startedAt > 60_000) goalContinuationRecentChoicesRef.current.delete(key);
          }
        }
        if (decision.kind === "terminal" || decision.kind === "blocked") {
          const status = decision.kind === "terminal" ? decision.status : "blocked";
          let runWithDiagnosis = latestRun;
          if (decision.kind === "terminal" && status === "failed") {
            runWithDiagnosis =
              (await appendGoalEvidence(cwd, latestRun.id, {
                kind: "summary",
                label: "Goal failure diagnosis",
                content: decision.reason,
              })) ?? latestRun;
          }
          const nextRun = {
            ...runWithDiagnosis,
            status,
            continueRequestedAt: undefined,
            blockers:
              decision.kind === "blocked" || status === "failed"
                ? Array.from(new Set([...runWithDiagnosis.blockers, decision.reason]))
                : runWithDiagnosis.blockers,
          } as GoalRun;
          await upsertGoalRun(cwd, nextRun);
          await appendGoalDecision(cwd, latestRun.id, {
            kind: "continuation_stopped",
            reason: decision.reason,
            content: `terminal=${status}`,
          });
          const terminalProgress = formatGoalTerminalProgress(nextRun);
          if (terminalProgress) {
            const item = { ...terminalProgress, id: goalTerminalProgressId(nextRun) };
            setLiveItems((prev) =>
              completedItemsWithDurableGoalTerminalProgress([...prev, item], [nextRun]),
            );
          }
          runningGoalIdsRef.current.delete(runId);
          clearGoalStatusEntry(runId);
          clearGoalModeIfIdle();
          return;
        }
        let runForNextAction = latestRun;
        if (
          latestRun.continueRequestedAt &&
          !listGoalWorkers(cwd).some((worker) => worker.status === "running") &&
          activeVerifierRunIdsRef.current.size === 0
        ) {
          await appendGoalDecision(cwd, latestRun.id, {
            kind: "continuation_consumed",
            reason: `Continuation request consumed by ${decision.kind}.`,
          });
          runForNextAction = await upsertGoalRun(cwd, {
            ...latestRun,
            continueRequestedAt: undefined,
          });
        }
        appendGoalProgress({
          kind: "goal_progress",
          phase: "continuing",
          title: `Choosing next Goal step: ${latestRun.title}`,
          detail:
            "Latest result is recorded; starting the next worker task or verifier automatically.",
          status: latestRun.status,
        });
        upsertGoalStatusEntry({
          runId: latestRun.id,
          label: latestRun.title,
          phase: "orchestrating",
          startedAt: Date.now(),
          detail: "choosing next step",
        });
        startGoalRunRef.current(runForNextAction);
      })()
        .catch((err: unknown) => {
          runningGoalIdsRef.current.delete(runId);
          clearGoalStatusEntry(runId);
          log("ERROR", "goal", err instanceof Error ? err.message : String(err));
          setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
        })
        .finally(() => {
          goalContinuationFlightsRef.current.delete(runId);
          clearGoalModeIfIdle();
        });
    },
    [appendGoalProgress, clearGoalModeIfIdle, clearGoalStatusEntry, cwd, upsertGoalStatusEntry],
  );

  const handleGoalWorkerComplete = useCallback(
    (run: GoalRun, completion: GoalWorkerCompletion) => {
      const taskTitle =
        run.tasks.find((task) => task.id === completion.worker.goalTaskId)?.title ??
        completion.worker.goalTaskId;
      appendGoalProgress({
        kind: "goal_progress",
        phase: "worker_finished",
        title: formatGoalWorkerFinishedTitle(taskTitle, completion.status),
        detail: summarizeGoalCompletion(completion.summary),
        workerId: completion.worker.id,
        status: completion.status,
      });
      const taskProgress = goalTaskProgress(
        run,
        run.tasks.find((task) => task.id === completion.worker.goalTaskId),
      );
      upsertGoalStatusEntry({
        runId: run.id,
        label: run.title,
        phase: completion.status === "done" ? "reviewing" : "failed",
        startedAt: Date.now(),
        detail: completion.status === "done" ? "reviewing result" : "task failed",
        workerId: completion.worker.id,
        goalNumber: goalNumberForRun(run.id),
        ...taskProgress,
      });
      void (async () => {
        // Deterministic integration gate: if an apply-integration worker just
        // finished, confirm via git that main actually contains the changes,
        // commit anything left uncommitted, and record canonical applied/
        // committed evidence ourselves — never trust the worker to emit exact
        // evidence labels. This must happen before the continuation re-decides.
        const completedTask = run.tasks.find((task) => task.id === completion.worker.goalTaskId);
        if (
          completion.status === "done" &&
          completedTask?.title === APPLY_INTEGRATION_TO_MAIN_TASK_TITLE
        ) {
          const baseRef = run.tasks
            .map((task) => task.candidate?.baseRef)
            .find((value): value is string => !!value);
          if (baseRef) {
            try {
              const confirmed = await confirmAndCommitMainIntegration({
                projectPath: completion.worker.projectPath,
                baseRef,
                message: `goal(${run.id}): commit integrated changes`,
              });
              if (confirmed.applied) {
                await setGoalIntegrationState(completion.worker.projectPath, run.id, {
                  status: confirmed.committed ? "committed" : "applied",
                  baseRef,
                  ...(confirmed.sha ? { headSha: confirmed.sha } : {}),
                  files: confirmed.files,
                  updatedAt: new Date().toISOString(),
                });
                await appendGoalEvidence(completion.worker.projectPath, run.id, {
                  kind: "summary",
                  label: "Integrated worktree applied to main",
                  content: `Deterministically confirmed main contains the integrated changes; commit=${confirmed.sha ?? ""}; files=${confirmed.files.join(", ")}`,
                });
                await appendGoalEvidence(completion.worker.projectPath, run.id, {
                  kind: "summary",
                  label: "Integrated Goal changes committed",
                  content: `Deterministic integration commit=${confirmed.sha ?? ""}.`,
                });
              }
            } catch (err) {
              log(
                "ERROR",
                "goal",
                `Integration finalize failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
        // Stamp the substantive-worker clock for any worker that is neither the
        // final read-only audit nor an integration task, so verifier/audit
        // staleness is driven by typed state instead of evidence-label scans.
        const completedTitle = completedTask?.title;
        if (
          completedTitle &&
          completedTitle !== FINAL_COMPLETION_AUDIT_TASK_TITLE &&
          !shouldRunGoalTaskInMainCheckout(completedTitle)
        ) {
          await recordGoalSubstantiveWorker(
            completion.worker.projectPath,
            run.id,
            new Date().toISOString(),
          );
        }
        if (
          listGoalWorkers(completion.worker.projectPath).some(
            (worker) => worker.status === "running",
          )
        )
          return;
        if (activeVerifierRunIdsRef.current.size > 0) return;
        const runs = await loadGoalRuns(completion.worker.projectPath);
        const queued = runs.find((item) => goalRunNeedsExplicitContinuationAfterWorker(item));
        if (queued) setTimeout(() => continueGoalRun(queued.id), 750);
      })().catch((err: unknown) =>
        log("ERROR", "goal", err instanceof Error ? err.message : String(err)),
      );
    },
    [appendGoalProgress, continueGoalRun, goalNumberForRun, upsertGoalStatusEntry],
  );

  useEffect(() => {
    return subscribeGoalWorkerCompletions((completion) => {
      void (async () => {
        const latestRun =
          (await loadGoalRuns(completion.worker.projectPath)).find(
            (item) => item.id === completion.worker.goalRunId,
          ) ?? null;
        if (!latestRun) {
          log("WARN", "goal", `Worker completion for unknown Goal ${completion.worker.goalRunId}`);
          return;
        }
        runningGoalIdsRef.current.add(latestRun.id);
        handleGoalWorkerComplete(latestRun, completion);
      })().catch((err: unknown) => {
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
      });
    }, cwd);
  }, [handleGoalWorkerComplete, cwd]);

  const startGoalRun = useCallback(
    (run: GoalRun) => {
      runningGoalIdsRef.current.add(run.id);
      upsertGoalStatusEntry({
        runId: run.id,
        label: run.title,
        phase: "orchestrating",
        startedAt: Date.now(),
        detail: "choosing next step",
        goalNumber: goalNumberForRun(run.id),
      });
      void (async () => {
        await setGoalModeAndPrompt("coordinator");
        const currentRun = (await loadGoalRuns(cwd)).find((item) => item.id === run.id) ?? run;
        const prereqCheck = await runGoalPrerequisiteChecks(cwd, currentRun);
        const checkedRun =
          prereqCheck.checkedCount > 0
            ? await upsertGoalRun(cwd, {
                ...prereqCheck.run,
                status: goalHasBlockingPrerequisites(prereqCheck.run) ? "blocked" : "ready",
              })
            : currentRun;
        if (goalHasBlockingPrerequisites(checkedRun)) {
          const detail = formatGoalBlockingPrerequisites(checkedRun);
          await upsertGoalRun(cwd, {
            ...checkedRun,
            status: "blocked",
            blockers: Array.from(new Set([...checkedRun.blockers, detail])),
          });
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal blocked: ${checkedRun.title}`,
            detail,
            status: "blocked",
          });
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          clearGoalModeIfIdle();
          return;
        }

        const decision = decideGoalNextAction(checkedRun);
        await appendGoalDecision(cwd, checkedRun.id, decision);
        if (!shouldKeepGoalRunTrackedAfterDecision(decision)) {
          runningGoalIdsRef.current.delete(checkedRun.id);
        }
        if (decision.kind === "terminal") {
          let terminalRun = checkedRun;
          if (decision.status === "failed") {
            const runWithDiagnosis =
              (await appendGoalEvidence(cwd, checkedRun.id, {
                kind: "summary",
                label: "Goal failure diagnosis",
                content: decision.reason,
              })) ?? checkedRun;
            terminalRun = await upsertGoalRun(cwd, {
              ...runWithDiagnosis,
              status: "failed",
              activeWorkerId: undefined,
              continueRequestedAt: undefined,
              blockers: Array.from(new Set([...runWithDiagnosis.blockers, decision.reason])),
            });
          }
          const terminalProgress = formatGoalTerminalProgress(terminalRun);
          if (terminalProgress) {
            const item = { ...terminalProgress, id: goalTerminalProgressId(terminalRun) };
            setLiveItems((prev) =>
              completedItemsWithDurableGoalTerminalProgress([...prev, item], [terminalRun]),
            );
          }
          runningGoalIdsRef.current.delete(terminalRun.id);
          clearGoalStatusEntry(terminalRun.id);
          clearGoalModeIfIdle();
          return;
        }
        if (decision.kind === "wait") {
          appendGoalProgress({
            kind: "goal_progress",
            phase: "worker_started",
            title: decision.workerId
              ? `Goal working: ${checkedRun.title}`
              : `Goal needs orchestration: ${checkedRun.title}`,
            detail: decision.workerId
              ? decision.reason
              : `${decision.reason} Asking the orchestrator to unblock or revise the Goal plan.`,
            workerId: decision.workerId,
          });
          upsertGoalStatusEntry({
            runId: checkedRun.id,
            label: checkedRun.title,
            phase: decision.workerId ? "worker" : "orchestrating",
            startedAt: Date.now(),
            detail: decision.reason,
            workerId: decision.workerId,
            goalNumber: goalNumberForRun(checkedRun.id),
          });
          if (!decision.workerId) {
            const eventText =
              `Goal continuation is waiting with no active worker for Goal ${checkedRun.id} (${checkedRun.title}).\n` +
              `Reason: ${decision.reason}\n\n` +
              `Inspect the durable Goal state with the goals tool, resolve blocked dependencies by creating or updating concrete worker tasks, and then continue the Goal. If no local/free action can proceed, record an explicit blocker with exact user instructions. Do not stop after only explaining the state.`;
            setLastUserMessage("");
            setDoneStatus(null);
            await agentLoop.run(eventText);
          }
          return;
        }
        if (decision.kind === "complete") {
          await upsertGoalRun(cwd, { ...checkedRun, status: "passed" });
          try {
            const cleanup = await removeGoalRunWorktrees(cwd, checkedRun);
            if (cleanup.removedPaths.length > 0) {
              await appendGoalEvidence(cwd, checkedRun.id, {
                kind: "summary",
                label: "Goal worktrees cleaned up",
                content: `Removed ${cleanup.removedPaths.length} worktree(s) and ${cleanup.removedBranches.length} branch(es) after the Goal passed.`,
              });
            }
          } catch (cleanupErr) {
            log(
              "WARN",
              "goal",
              `Worktree cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
            );
          }
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal passed: ${checkedRun.title}`,
            detail: decision.reason,
            status: "passed",
          });
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          clearGoalModeIfIdle();
          return;
        }
        if (decision.kind === "run_verifier") {
          await verifyGoalRun(checkedRun);
          return;
        }
        if (decision.kind === "create_task") {
          if (decision.title === APPLY_INTEGRATION_TO_MAIN_TASK_TITLE) {
            // Stage the deterministic integration on a throwaway branch, verify it
            // there, and only fast-forward main on pass — main never holds
            // unverified changes. Ambiguous cases fall through to the LLM apply task.
            const staged = await stageGoalIntegration({ projectPath: cwd, run: checkedRun });
            if (staged.status === "staged") {
              const stagedRun =
                (await appendGoalEvidence(cwd, checkedRun.id, {
                  kind: "summary",
                  label: "Integration staged",
                  content: `Staged ${staged.integratedTaskIds.length} candidate(s) on ${staged.stagingBranch} for verify-before-fast-forward; files=${staged.changedFiles.join(", ")}.`,
                  path: staged.stagingPath,
                })) ?? checkedRun;
              await verifyGoalRun(stagedRun, {
                stagingBranch: staged.stagingBranch,
                stagingPath: staged.stagingPath,
                mainBase: staged.mainBase,
                integratedTaskIds: staged.integratedTaskIds,
                changedFiles: staged.changedFiles,
              });
              return;
            }
            if (staged.status === "fallback") {
              await appendGoalDecision(cwd, checkedRun.id, {
                kind: "staged_integration_fallback",
                reason: staged.reason,
              });
            }
          }
          const latestRunBeforeCreate =
            (await loadGoalRuns(cwd)).find((item) => item.id === checkedRun.id) ?? checkedRun;
          const existingSameTitleTask = latestRunBeforeCreate.tasks.find(
            (item) => item.title === decision.title,
          );
          if (existingSameTitleTask) {
            const runWithExistingTask = await upsertGoalRun(cwd, {
              ...latestRunBeforeCreate,
              status: "ready",
            });
            appendGoalProgress({
              kind: "goal_progress",
              phase: "continuing",
              title: `Goal task already exists: ${decision.title}`,
              detail: "Reusing the existing Goal task instead of creating a duplicate.",
              status: "ready",
            });
            startGoalRunRef.current(runWithExistingTask);
            return;
          }
          await updateGoalTask(cwd, checkedRun.id, `auto-${Date.now()}`, {
            title: decision.title,
            prompt: decision.prompt,
            status: "pending",
          });
          const latestRun =
            (await loadGoalRuns(cwd)).find((item) => item.id === checkedRun.id) ?? checkedRun;
          const runWithTask = await upsertGoalRun(cwd, { ...latestRun, status: "ready" });
          appendGoalProgress({
            kind: "goal_progress",
            phase: "continuing",
            title: `Goal task created: ${decision.title}`,
            detail: "Starting the new Goal task now.",
            status: "ready",
          });
          startGoalRunRef.current(runWithTask);
          return;
        }
        if (decision.kind === "blocked") {
          await upsertGoalRun(cwd, {
            ...checkedRun,
            status: "blocked",
            blockers: [...checkedRun.blockers, decision.reason],
          });
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal blocked: ${checkedRun.title}`,
            detail: decision.reason,
            status: "blocked",
          });
          runningGoalIdsRef.current.delete(checkedRun.id);
          clearGoalStatusEntry(checkedRun.id);
          clearGoalModeIfIdle();
          return;
        }
        const runWithAttempt =
          (await updateGoalTask(cwd, checkedRun.id, decision.task.id, {
            attempts: decision.attempts,
          })) ?? checkedRun;
        const worker = await startGoalWorker({
          cwd,
          provider: currentProvider,
          model: currentModel,
          thinkingLevel,
          goalRunId: checkedRun.id,
          goalTaskId: decision.task.id,
          taskTitle: decision.task.title,
          prompt: buildGoalTaskPromptWithReferences(checkedRun, decision.task.prompt),
          isolateWorktree: shouldRunGoalTaskInMainCheckout(decision.task.title) ? false : undefined,
        });
        const latestRun =
          (await loadGoalRuns(cwd)).find((item) => item.id === checkedRun.id) ?? runWithAttempt;
        await upsertGoalRun(cwd, {
          ...latestRun,
          status: "running",
          activeWorkerId: worker.id,
          continueRequestedAt: undefined,
          tasks: latestRun.tasks.map((item) =>
            item.id === decision.task.id
              ? { ...item, status: "running", workerId: worker.id, attempts: decision.attempts }
              : item,
          ),
        });
        appendGoalProgress({
          kind: "goal_progress",
          phase: "worker_started",
          title: `Worker started: ${decision.task.title}`,
          detail: "Task is running in the background.",
          workerId: worker.id,
          status: worker.status,
        });
        upsertGoalStatusEntry({
          runId: checkedRun.id,
          label: checkedRun.title,
          phase: "worker",
          startedAt: Date.now(),
          detail: "background worker running",
          workerId: worker.id,
          goalNumber: goalNumberForRun(checkedRun.id),
          ...goalTaskProgress(checkedRun, decision.task),
        });
      })().catch(async (err: unknown) => {
        clearGoalStatusEntry(run.id);
        clearGoalModeIfIdle();
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        if (isGoalWorktreeDirtyError(err)) {
          const latestRun = (await loadGoalRuns(cwd)).find((item) => item.id === run.id) ?? run;
          const reason = `Goal worker startup could not establish a clean working tree even after an auto-checkpoint commit: ${err.message}`;
          const runWithEvidence =
            (await appendGoalEvidence(cwd, latestRun.id, {
              kind: "summary",
              label: "Goal failure diagnosis",
              content: reason,
            })) ?? latestRun;
          const failedRun = await upsertGoalRun(cwd, {
            ...runWithEvidence,
            status: "failed",
            activeWorkerId: undefined,
            continueRequestedAt: undefined,
            blockers: Array.from(new Set([...runWithEvidence.blockers, reason])),
          });
          runningGoalIdsRef.current.delete(failedRun.id);
          appendGoalProgress({
            kind: "goal_progress",
            phase: "terminal",
            title: `Goal failed: ${failedRun.title}`,
            detail: reason,
            status: "failed",
          });
          return;
        }
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
      });
    },
    [
      cwd,
      currentProvider,
      currentModel,
      thinkingLevel,
      agentLoop,
      appendGoalProgress,
      clearGoalModeIfIdle,
      clearGoalStatusEntry,
      goalNumberForRun,
      setGoalModeAndPrompt,
      upsertGoalStatusEntry,
    ],
  );

  const verifyGoalRun = useCallback(
    async (run: GoalRun, staging?: GoalStagedContext) => {
      await setGoalModeAndPrompt("coordinator");
      if (!run.verifier?.command) {
        await appendGoalEvidence(cwd, run.id, {
          kind: "summary",
          label: "Missing verifier",
          content: "No verifier command is configured.",
        });
        await upsertGoalRun(cwd, {
          ...run,
          status: "blocked",
          blockers: [...run.blockers, "No verifier command configured."],
        });
        appendGoalProgress({
          kind: "goal_progress",
          phase: "terminal",
          title: `Goal blocked: ${run.title}`,
          detail: "No verifier command is configured.",
          status: "blocked",
        });
        runningGoalIdsRef.current.delete(run.id);
        clearGoalStatusEntry(run.id);
        clearGoalModeIfIdle();
        return;
      }

      const integration = await checkGoalWorktreeIntegration(cwd, run);
      if (!integration.ok) {
        const runWithEvidence =
          (await appendGoalEvidence(cwd, run.id, {
            kind: "summary",
            label: "Goal worktree integration required",
            content: integration.summary,
          })) ?? run;
        await upsertGoalRun(cwd, {
          ...runWithEvidence,
          status: "blocked",
          blockers: Array.from(new Set([...runWithEvidence.blockers, integration.summary])),
        });
        appendGoalProgress({
          kind: "goal_progress",
          phase: "terminal",
          title: `Goal blocked before verifier: ${run.title}`,
          detail: integration.summary,
          status: "blocked",
        });
        runningGoalIdsRef.current.delete(run.id);
        clearGoalStatusEntry(run.id);
        clearGoalModeIfIdle();
        return;
      }

      activeVerifierRunIdsRef.current.add(run.id);
      await upsertGoalRun(cwd, {
        ...run,
        status: "verifying",
        continueRequestedAt: undefined,
      });
      appendGoalProgress({
        kind: "goal_progress",
        phase: "verifier_started",
        title: `Verifier started: ${run.title}`,
        detail: run.verifier.command,
        status: "verifying",
      });
      const startedAt = Date.now();
      const verifierTimeoutMs = Number(process.env.GG_GOAL_VERIFIER_TIMEOUT_MS ?? 10 * 60 * 1000);
      upsertGoalStatusEntry({
        runId: run.id,
        label: run.title,
        phase: "verifier",
        startedAt,
        detail: run.verifier.command,
        goalNumber: goalNumberForRun(run.id),
      });
      void runGoalVerifierCommand({
        cwd: staging?.stagingPath ?? run.verifier.cwd ?? cwd,
        runId: run.id,
        command: run.verifier.command,
        timeoutMs: verifierTimeoutMs,
        now: () => startedAt,
      })
        .then(async ({ verification, failureClass, durationMs }) => {
          activeVerifierRunIdsRef.current.delete(run.id);
          const status = verification.status;
          const summary = verification.summary;
          const outputPath = verification.outputPath;
          // Verify-then-fast-forward: only advance main once the staged
          // integration verifies green; on failure main is left untouched.
          if (staging) {
            if (status === "pass") {
              try {
                const ff = await finalizeStagedIntegration({ projectPath: cwd, staging });
                await setGoalIntegrationState(cwd, run.id, {
                  status: "committed",
                  headSha: ff.commitSha,
                  baseRef: staging.mainBase,
                  files: staging.changedFiles,
                  updatedAt: new Date().toISOString(),
                });
                await appendGoalEvidence(cwd, run.id, {
                  kind: "summary",
                  label: "Integrated worktree applied to main",
                  content: `Verified staged integration fast-forwarded to main. tasks=${staging.integratedTaskIds.join(", ")}; files=${staging.changedFiles.join(", ")}; commit=${ff.commitSha}`,
                });
                await appendGoalEvidence(cwd, run.id, {
                  kind: "summary",
                  label: "Integrated Goal changes committed",
                  content: `Fast-forwarded ${staging.changedFiles.length} file(s) to main; commit=${ff.commitSha}.`,
                });
              } catch (ffErr) {
                await discardStagedIntegration({ projectPath: cwd, staging });
                await appendGoalEvidence(cwd, run.id, {
                  kind: "summary",
                  label: "Integration fast-forward failed",
                  content: `Staged integration verified but main could not fast-forward; will retry or apply. ${ffErr instanceof Error ? ffErr.message : String(ffErr)}`,
                });
              }
            } else {
              await discardStagedIntegration({ projectPath: cwd, staging });
              await appendGoalEvidence(cwd, run.id, {
                kind: "summary",
                label: "Staged integration discarded",
                content:
                  "Verifier failed on the staged integration; discarded the staging branch and left main unchanged.",
              });
            }
          }
          const latestRun = (await loadGoalRuns(cwd)).find((item) => item.id === run.id) ?? run;
          const runWithVerifier: GoalRun = {
            ...latestRun,
            verifier: {
              ...latestRun.verifier,
              description: latestRun.verifier?.description ?? "Goal verifier",
              command: run.verifier?.command,
              ...(!staging && run.verifier?.cwd ? { cwd: run.verifier.cwd } : {}),
              lastResult: verification,
            },
            ...(status === "pass"
              ? {
                  completionAudit: {
                    status: "unknown" as const,
                    summary: "Final completion audit pending for latest verifier result.",
                    checkedAt: verification.checkedAt,
                    verifierCheckedAt: verification.checkedAt,
                    ...(verification.outputPath ? { outputPath: verification.outputPath } : {}),
                  },
                }
              : {}),
          };
          const completionCheck = canCompleteGoalRun(runWithVerifier);
          await upsertGoalRun(cwd, {
            ...runWithVerifier,
            continueRequestedAt: latestRun.continueRequestedAt,
            status: status === "pass" && completionCheck.ok ? "passed" : "ready",
          });
          await appendGoalEvidence(cwd, run.id, {
            kind: "command",
            label: `Verifier ${status}`,
            content: `${failureClass}: ${summary}`.slice(0, 4000),
            path: outputPath,
          });
          await appendGoalDecision(cwd, run.id, {
            kind: `verifier_${status}`,
            reason: `${failureClass}: verifier exited with code ${verification.exitCode ?? 1}.`,
            content: `outputPath=${outputPath ?? ""}; cwd=${run.verifier?.cwd ?? cwd}; durationMs=${durationMs}`,
          });
          appendGoalProgress({
            kind: "goal_progress",
            phase: "verifier_finished",
            title: `Verifier ${status}: ${run.title}`,
            detail: summarizeGoalCompletion(summary),
            status,
          });
          upsertGoalStatusEntry({
            runId: run.id,
            label: run.title,
            phase: status === "pass" ? "reviewing" : "failed",
            startedAt: Date.now(),
            detail: status === "pass" ? "reviewing verifier evidence" : "verifier failed",
            goalNumber: goalNumberForRun(run.id),
          });
          const continuationRun = (await loadGoalRuns(cwd)).find((item) => item.id === run.id);
          if (continuationRun?.continueRequestedAt || status === "fail" || status === "pass") {
            setTimeout(() => continueGoalRun(run.id), 500);
          }
        })
        .catch((err: unknown) => {
          activeVerifierRunIdsRef.current.delete(run.id);
          clearGoalStatusEntry(run.id);
          clearGoalModeIfIdle();
          log("ERROR", "goal", err instanceof Error ? err.message : String(err));
          setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal verifier")]);
        });
    },
    [
      cwd,
      appendGoalProgress,
      clearGoalModeIfIdle,
      clearGoalStatusEntry,
      goalNumberForRun,
      setGoalModeAndPrompt,
      upsertGoalStatusEntry,
    ],
  );

  const pauseGoalRun = useCallback(
    (run: GoalRun) => {
      void (async () => {
        runningGoalIdsRef.current.delete(run.id);
        if (run.activeWorkerId) await stopGoalWorker(run.activeWorkerId);
        const latestRun = (await loadGoalRuns(cwd)).find((item) => item.id === run.id) ?? run;
        await upsertGoalRun(cwd, buildGoalUserPauseRun(latestRun));
        appendGoalProgress({
          kind: "goal_progress",
          phase: "terminal",
          title: `Goal paused: ${run.title}`,
          detail: "Auto-continuation stopped until resumed.",
          status: "paused",
        });
        clearGoalStatusEntry(run.id);
        clearGoalModeIfIdle();
      })().catch((err: unknown) => {
        log("ERROR", "goal", err instanceof Error ? err.message : String(err));
        setLiveItems((prev) => [...prev, toErrorItem(err, getId(), "Goal")]);
      });
    },
    [appendGoalProgress, clearGoalModeIfIdle, clearGoalStatusEntry, cwd],
  );

  const startTask = useCallback(
    (title: string, prompt: string, taskId: string) => {
      const taskCwd = cwdRef.current;
      const shortId = taskId.slice(0, 8);
      const completionHint =
        `\n\n---\nWhen you have fully completed this task, call the tasks tool to mark it done:\n` +
        `tasks({ action: "done", id: "${shortId}" })`;
      const fullPrompt = prompt + completionHint;

      if (resetUI && sessionStore) {
        const sysMsg = messagesRef.current[0];
        const newMessages: Message[] =
          sysMsg && sysMsg.role === "system" ? [sysMsg] : messagesRef.current.slice(0, 1);
        const taskItem: TaskItem = { kind: "task", title, id: getId() };
        const sm = sessionManagerRef.current;

        void (async () => {
          let newSessionPath: string | undefined;
          if (sm) {
            try {
              const session = await sm.create(taskCwd, currentProvider, currentModel);
              newSessionPath = session.path;
              log("INFO", "tasks", "New session for task", { path: session.path });
            } catch {
              // Session creation is best-effort.
            }
          }
          if (sessionStore) sessionStore.overlay = null;
          resetUI?.({
            wipeSession: true,
            messages: newMessages,
            history: [{ kind: "banner", id: "banner" }, taskItem],
            sessionPath: newSessionPath,
            pendingAction: { prompt: fullPrompt },
          });
        })();
        return;
      }

      clearPendingHistory();
      setHistory([{ kind: "banner", id: "banner" }]);
      setLiveItems([]);
      messagesRef.current = messagesRef.current.slice(0, 1);
      agentLoop.reset();
      persistedIndexRef.current = messagesRef.current.length;
      const sm = sessionManagerRef.current;
      if (sm) {
        void sm.create(taskCwd, currentProvider, currentModel).then((session) => {
          sessionPathRef.current = session.path;
          log("INFO", "tasks", "New session for task", { path: session.path });
        });
      }
      const taskItem: TaskItem = { kind: "task", title, id: getId() };
      setLastUserMessage(title);
      setDoneStatus(null);
      setLiveItems([taskItem]);
      void agentLoop.run(fullPrompt).catch((err: unknown) => {
        setLiveItems((prev) => [...prev, toErrorItem(err, getId())]);
      });
    },
    [agentLoop, currentModel, currentProvider, resetUI, sessionStore],
  );

  // Keep refs in sync for access from stale closures (onDone).
  startTaskRef.current = startTask;
  startGoalRunRef.current = startGoalRun;

  return {
    runGoalSyntheticEvent,
    continueGoalRun,
    handleGoalWorkerComplete,
    startGoalRun,
    verifyGoalRun,
    pauseGoalRun,
    startTask,
  };
}
