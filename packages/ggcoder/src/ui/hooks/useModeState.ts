import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Message } from "@kenkaiiii/gg-ai";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { buildSystemPrompt } from "../../system-prompt.js";
import type { GoalMode } from "../../core/runtime-mode.js";
import type { LanguageId } from "../../core/language-detector.js";
import type { Skill } from "../../core/skills.js";

/** Options accepted by {@link useModeState.rebuildSystemPrompt}. */
export interface RebuildSystemPromptOptions {
  cwd?: string;
  approvedPlanPath?: string;
  clearApprovedPlan?: boolean;
  activeLanguages?: Set<LanguageId>;
  tools?: AgentTool[];
  goalMode?: GoalMode;
  planMode?: boolean;
}

/** Minimal session-store surface the mode state mirrors into for remount survival. */
interface ModeSessionStore {
  goalMode?: GoalMode;
  planMode?: boolean;
}

interface UseModeStateOptions {
  initialGoalMode: GoalMode;
  initialPlanMode: boolean;
  skills: Skill[] | undefined;
  goalModeRef?: { current: GoalMode };
  planModeRef?: { current: boolean };
  sessionStore?: ModeSessionStore;
  // External refs the system prompt is rebuilt from (owned by App).
  cwdRef: MutableRefObject<string>;
  currentToolsRef: MutableRefObject<AgentTool[]>;
  approvedPlanPathRef: MutableRefObject<string | undefined>;
  injectedLanguagesRef: MutableRefObject<Set<LanguageId>>;
  messagesRef: MutableRefObject<Message[]>;
  // Goal-orchestration refs consulted before clearing goal mode when idle.
  runningGoalIdsRef: MutableRefObject<Set<string>>;
  activeVerifierRunIdsRef: MutableRefObject<Set<string>>;
  queuedGoalSyntheticEventsRef: MutableRefObject<number>;
}

export interface ModeState {
  goalMode: GoalMode;
  planMode: boolean;
  goalModeStateRef: MutableRefObject<GoalMode>;
  planModeStateRef: MutableRefObject<boolean>;
  rebuildSystemPrompt: (options?: RebuildSystemPromptOptions) => Promise<string>;
  replaceSystemPrompt: (options?: RebuildSystemPromptOptions) => Promise<string>;
  setGoalModeAndPrompt: (
    nextMode: GoalMode,
    options?: Omit<RebuildSystemPromptOptions, "goalMode">,
  ) => Promise<void>;
  setPlanModeAndPrompt: (nextMode: boolean) => Promise<void>;
  clearGoalModeIfIdle: () => void;
}

/**
 * Owns the `goalMode`/`planMode` runtime state and the system-prompt rebuild
 * cluster (`rebuildSystemPrompt`, `replaceSystemPrompt`, `setGoalModeAndPrompt`,
 * `setPlanModeAndPrompt`, `clearGoalModeIfIdle`). Extracted from `App.tsx` as a
 * self-contained controller; behavior is identical to the previous inline code.
 */
export function useModeState({
  initialGoalMode,
  initialPlanMode,
  skills,
  goalModeRef,
  planModeRef,
  sessionStore,
  cwdRef,
  currentToolsRef,
  approvedPlanPathRef,
  injectedLanguagesRef,
  messagesRef,
  runningGoalIdsRef,
  activeVerifierRunIdsRef,
  queuedGoalSyntheticEventsRef,
}: UseModeStateOptions): ModeState {
  const [goalMode, setGoalMode] = useState<GoalMode>(initialGoalMode);
  const [planMode, setPlanMode] = useState(initialPlanMode);
  const goalModeStateRef = useRef<GoalMode>(goalMode);
  const planModeStateRef = useRef(planMode);

  // Keep runtime mode refs in sync with React state.
  useEffect(() => {
    goalModeStateRef.current = goalMode;
    if (goalModeRef) goalModeRef.current = goalMode;
  }, [goalMode, goalModeRef]);

  useEffect(() => {
    planModeStateRef.current = planMode;
    if (planModeRef) planModeRef.current = planMode;
  }, [planMode, planModeRef]);

  const rebuildSystemPrompt = useCallback(
    async (options?: RebuildSystemPromptOptions): Promise<string> => {
      const approvedPlanPath = options?.clearApprovedPlan
        ? undefined
        : (options?.approvedPlanPath ?? approvedPlanPathRef.current);
      return buildSystemPrompt(
        options?.cwd ?? cwdRef.current,
        skills,
        options?.planMode ?? planModeStateRef.current,
        approvedPlanPath,
        (options?.tools ?? currentToolsRef.current).map((tool) => tool.name),
        options?.activeLanguages ?? injectedLanguagesRef.current,
        options?.goalMode ?? goalModeStateRef.current,
      );
    },
    [skills, approvedPlanPathRef, cwdRef, currentToolsRef, injectedLanguagesRef],
  );

  const replaceSystemPrompt = useCallback(
    async (options?: RebuildSystemPromptOptions): Promise<string> => {
      const newPrompt = await rebuildSystemPrompt(options);
      if (messagesRef.current[0]?.role === "system") {
        messagesRef.current[0] = { role: "system" as const, content: newPrompt };
      }
      return newPrompt;
    },
    [rebuildSystemPrompt, messagesRef],
  );

  const setGoalModeAndPrompt = useCallback(
    async (
      nextMode: GoalMode,
      options?: Omit<RebuildSystemPromptOptions, "goalMode">,
    ): Promise<void> => {
      goalModeStateRef.current = nextMode;
      if (goalModeRef) goalModeRef.current = nextMode;
      if (sessionStore) sessionStore.goalMode = nextMode;
      setGoalMode(nextMode);
      await replaceSystemPrompt({ ...options, goalMode: nextMode });
    },
    [goalModeRef, sessionStore, replaceSystemPrompt],
  );

  const setPlanModeAndPrompt = useCallback(
    async (nextMode: boolean): Promise<void> => {
      planModeStateRef.current = nextMode;
      if (planModeRef) planModeRef.current = nextMode;
      if (sessionStore) sessionStore.planMode = nextMode;
      setPlanMode(nextMode);
      await replaceSystemPrompt({ planMode: nextMode });
    },
    [planModeRef, sessionStore, replaceSystemPrompt],
  );

  const clearGoalModeIfIdle = useCallback((): void => {
    setTimeout(() => {
      if (goalModeStateRef.current === "off") return;
      if (runningGoalIdsRef.current.size > 0) return;
      if (activeVerifierRunIdsRef.current.size > 0) return;
      if (queuedGoalSyntheticEventsRef.current > 0) return;
      void setGoalModeAndPrompt("off");
    }, 0);
  }, [
    setGoalModeAndPrompt,
    runningGoalIdsRef,
    activeVerifierRunIdsRef,
    queuedGoalSyntheticEventsRef,
  ]);

  return {
    goalMode,
    planMode,
    goalModeStateRef,
    planModeStateRef,
    rebuildSystemPrompt,
    replaceSystemPrompt,
    setGoalModeAndPrompt,
    setPlanModeAndPrompt,
    clearGoalModeIfIdle,
  };
}
