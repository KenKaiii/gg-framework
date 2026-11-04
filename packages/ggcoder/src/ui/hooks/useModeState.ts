import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Message, Provider, ThinkingLevel } from "@kleio/ai";
import type { AgentTool } from "@kleio/agent";
import { buildSystemPrompt } from "../../system-prompt.js";
import type { LanguageId } from "../../core/language-detector.js";
import type { Skill } from "../../core/skills.js";
import { applyAsyncSubagentPolicy } from "../../core/subagent-policy.js";

/** Options accepted by {@link useModeState.rebuildSystemPrompt}. */
export interface RebuildSystemPromptOptions {
  cwd?: string;
  approvedPlanPath?: string;
  clearApprovedPlan?: boolean;
  activeLanguages?: Set<LanguageId>;
  tools?: AgentTool[];
  skills?: Skill[];
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
  modelRef: MutableRefObject<string>;
  thinkingLevelRef: MutableRefObject<ThinkingLevel | undefined>;
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
  modelRef,
  thinkingLevelRef,
  approvedPlanPathRef,
  injectedLanguagesRef,
  messagesRef,
}: UseModeStateOptions): ModeState {
  const [planMode, setPlanMode] = useState(initialPlanMode);
  const planModeStateRef = useRef(planMode);
  const provider = providerRef.current;
  const model = modelRef.current;
  const thinkingLevel = thinkingLevelRef.current;

  // Changing effort does not need a disk-backed prompt rebuild. Replace just
  // the policy suffix so toggles, model switches, and restored UI state cannot
  // leave delegation instructions from the previous mode in the live prompt.
  useEffect(() => {
    const system = messagesRef.current[0];
    if (system?.role !== "system") return;
    messagesRef.current[0] = {
      ...system,
      content: applyAsyncSubagentPolicy(
        system.content,
        provider,
        model,
        thinkingLevel,
        currentToolsRef.current.map((tool) => tool.name),
      ),
    };
  }, [provider, model, thinkingLevel, currentToolsRef, messagesRef]);

  useEffect(() => {
    planModeStateRef.current = planMode;
    if (planModeRef) planModeRef.current = planMode;
  }, [planMode, planModeRef]);

  const rebuildSystemPrompt = useCallback(
    async (options?: RebuildSystemPromptOptions): Promise<string> => {
      const approvedPlanPath = options?.clearApprovedPlan
        ? undefined
        : (options?.approvedPlanPath ?? approvedPlanPathRef.current);
      const toolNames = (options?.tools ?? currentToolsRef.current).map((tool) => tool.name);
      return applyAsyncSubagentPolicy(
        await buildSystemPrompt(
          options?.cwd ?? cwdRef.current,
          options?.skills ?? skills,
          options?.planMode ?? planModeStateRef.current,
          approvedPlanPath,
          toolNames,
          options?.activeLanguages ?? injectedLanguagesRef.current,
          providerRef.current,
        ),
        providerRef.current,
        modelRef.current,
        thinkingLevelRef.current,
        toolNames,
      );
    },
    [
      skills,
      approvedPlanPathRef,
      cwdRef,
      currentToolsRef,
      providerRef,
      modelRef,
      thinkingLevelRef,
      injectedLanguagesRef,
    ],
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
