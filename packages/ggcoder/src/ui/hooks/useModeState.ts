import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { buildSystemPrompt } from "../../system-prompt.js";
import type { LanguageId } from "../../core/language-detector.js";
import type { Skill } from "../../core/skills.js";

/** Options accepted by {@link useModeState.rebuildSystemPrompt}. */
export interface RebuildSystemPromptOptions {
  cwd?: string;
  approvedPlanPath?: string;
  clearApprovedPlan?: boolean;
  activeLanguages?: Set<LanguageId>;
  tools?: AgentTool[];
  planMode?: boolean;
}

/** Minimal session-store surface the mode state mirrors into for remount survival. */
interface ModeSessionStore {
  planMode?: boolean;
}

interface UseModeStateOptions {
  initialPlanMode: boolean;
  skills: Skill[] | undefined;
  planModeRef?: { current: boolean };
  sessionStore?: ModeSessionStore;
  // External refs the system prompt is rebuilt from (owned by App).
  cwdRef: MutableRefObject<string>;
  currentToolsRef: MutableRefObject<AgentTool[]>;
  // Active provider, consulted so the prompt identity tracks the current model.
  providerRef: MutableRefObject<Provider>;
  approvedPlanPathRef: MutableRefObject<string | undefined>;
  injectedLanguagesRef: MutableRefObject<Set<LanguageId>>;
  messagesRef: MutableRefObject<Message[]>;
}

export interface ModeState {
  planMode: boolean;
  planModeStateRef: MutableRefObject<boolean>;
  rebuildSystemPrompt: (options?: RebuildSystemPromptOptions) => Promise<string>;
  replaceSystemPrompt: (options?: RebuildSystemPromptOptions) => Promise<string>;
  setPlanModeAndPrompt: (nextMode: boolean) => Promise<void>;
}

/**
 * Owns the `planMode` runtime state and the system-prompt rebuild cluster
 * (`rebuildSystemPrompt`, `replaceSystemPrompt`, `setPlanModeAndPrompt`).
 * Extracted from `App.tsx` as a self-contained controller.
 */
export function useModeState({
  initialPlanMode,
  skills,
  planModeRef,
  sessionStore,
  cwdRef,
  currentToolsRef,
  providerRef,
  approvedPlanPathRef,
  injectedLanguagesRef,
  messagesRef,
}: UseModeStateOptions): ModeState {
  const [planMode, setPlanMode] = useState(initialPlanMode);
  const planModeStateRef = useRef(planMode);

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
        providerRef.current,
      );
    },
    [skills, approvedPlanPathRef, cwdRef, currentToolsRef, providerRef, injectedLanguagesRef],
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

  return {
    planMode,
    planModeStateRef,
    rebuildSystemPrompt,
    replaceSystemPrompt,
    setPlanModeAndPrompt,
  };
}
