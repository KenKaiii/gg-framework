import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { log } from "../../core/logger.js";
import { detectLanguages, type LanguageId } from "../../core/language-detector.js";
import type { PreparedPixelFix } from "../../core/pixel-fix.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { UseAgentLoopReturn } from "./useAgentLoop.js";
import type { RebuildSystemPromptOptions } from "./useModeState.js";
import type { CompletedItem, TaskItem } from "../app-items.js";
import type { DoneStatus } from "../layout-decisions.js";
import { toErrorItem } from "../error-item.js";

/** Minimal session-store surface the pixel run-all flag mirrors into. */
interface PixelSessionStore {
  runAllPixel?: boolean;
}

interface UsePixelFixFlowOptions {
  agentLoop: UseAgentLoopReturn;
  cwd: string;
  currentProvider: Provider;
  currentModel: string;
  rebuildToolsForCwd?: (cwd: string) => AgentTool[];
  sessionStore?: PixelSessionStore;
  // Refs declared in App (created before useAgentLoop so its callbacks can read them).
  currentPixelFixRef: MutableRefObject<PreparedPixelFix | null>;
  runAllPixelRef: MutableRefObject<boolean>;
  startPixelFixRef: MutableRefObject<(errorId: string) => void>;
  cwdRef: MutableRefObject<string>;
  currentToolsRef: MutableRefObject<AgentTool[]>;
  injectedLanguagesRef: MutableRefObject<Set<LanguageId>>;
  setupHintShownRef: MutableRefObject<boolean>;
  messagesRef: MutableRefObject<Message[]>;
  persistedIndexRef: MutableRefObject<number>;
  sessionManagerRef: MutableRefObject<SessionManager | null>;
  sessionPathRef: MutableRefObject<string | undefined>;
  // Setters / helpers owned by App.
  setDisplayedCwd: Dispatch<SetStateAction<string>>;
  setCurrentTools: Dispatch<SetStateAction<AgentTool[]>>;
  setHistory: Dispatch<SetStateAction<CompletedItem[]>>;
  setLiveItems: Dispatch<SetStateAction<CompletedItem[]>>;
  setLastUserMessage: Dispatch<SetStateAction<string>>;
  setDoneStatus: Dispatch<SetStateAction<DoneStatus | null>>;
  rebuildSystemPrompt: (options?: RebuildSystemPromptOptions) => Promise<string>;
  clearPendingHistory: () => void;
  getId: () => string;
  initialRunAllPixel: boolean;
}

export interface PixelFixFlow {
  startPixelFix: (errorId: string) => void;
  runAllPixel: boolean;
  setRunAllPixel: Dispatch<SetStateAction<boolean>>;
}

/**
 * Owns the in-Ink pixel-fix flow: swapping cwd/tools/system-prompt/banner in
 * lockstep, resetting chat state, kicking off the agent run, and the "fix all"
 * run-all flag. Extracted verbatim from `App.tsx`; see CLAUDE.md for the
 * four-things-in-lockstep contract.
 */
export function usePixelFixFlow({
  agentLoop,
  cwd,
  currentProvider,
  currentModel,
  rebuildToolsForCwd,
  sessionStore,
  currentPixelFixRef,
  runAllPixelRef,
  startPixelFixRef,
  cwdRef,
  currentToolsRef,
  injectedLanguagesRef,
  setupHintShownRef,
  messagesRef,
  persistedIndexRef,
  sessionManagerRef,
  sessionPathRef,
  setDisplayedCwd,
  setCurrentTools,
  setHistory,
  setLiveItems,
  setLastUserMessage,
  setDoneStatus,
  rebuildSystemPrompt,
  clearPendingHistory,
  getId,
  initialRunAllPixel,
}: UsePixelFixFlowOptions): PixelFixFlow {
  const [runAllPixel, setRunAllPixel] = useState(initialRunAllPixel);

  const startPixelFix = useCallback(
    (errorId: string) => {
      void (async () => {
        try {
          const { preparePixelFix } = await import("../../core/pixel-fix.js");
          const prep = await preparePixelFix(errorId);
          currentPixelFixRef.current = prep;

          // Move the agent into the error's project root. Four things must
          // change in lockstep, otherwise the agent (or the chrome around
          // it) shows the wrong project:
          //   1. process.cwd  — for any code reading it directly
          //   2. cwd-bound tools (read/write/bash/grep/…) — baked at creation
          //   3. the system prompt's "Working directory: …" line — the only
          //      place the model itself learns where it is
          //   4. displayedCwd state — Banner + Footer read this for display
          try {
            process.chdir(prep.projectPath);
          } catch (err) {
            log("WARN", "pixel", `chdir failed: ${(err as Error).message}`);
          }
          cwdRef.current = prep.projectPath;
          setDisplayedCwd(prep.projectPath);
          let toolsForPixelFix = currentToolsRef.current;
          if (rebuildToolsForCwd) {
            toolsForPixelFix = rebuildToolsForCwd(prep.projectPath);
            currentToolsRef.current = toolsForPixelFix;
            setCurrentTools(toolsForPixelFix);
          }
          // Pixel-fix swaps the project root — reset injected packs so the
          // new project re-detects from scratch on the next tool call. Also
          // reset the setup-hint flag so the new project's first badge re-
          // surfaces the tip (different project, may need the reminder).
          injectedLanguagesRef.current = new Set();
          setupHintShownRef.current = false;
          const detectedForPixelFix = detectLanguages(prep.projectPath);
          injectedLanguagesRef.current = detectedForPixelFix;
          const newSystemPrompt = await rebuildSystemPrompt({
            cwd: prep.projectPath,
            clearApprovedPlan: true,
            activeLanguages: detectedForPixelFix,
            tools: toolsForPixelFix,
          });

          // Now that the cwd swap is committed, reset chat. Do not clear the
          // terminal here; terminal clear sequences can erase saved scrollback.
          clearPendingHistory();
          setHistory([{ kind: "banner", id: "banner" }]);
          setLiveItems([]);
          messagesRef.current = messagesRef.current.slice(0, 1);
          agentLoop.reset();
          persistedIndexRef.current = messagesRef.current.length;
          const sm = sessionManagerRef.current;
          if (sm) {
            void sm.create(prep.projectPath, currentProvider, currentModel).then((s) => {
              sessionPathRef.current = s.path;
              log("INFO", "pixel", "New session for pixel fix", { path: s.path });
            });
          }

          if (messagesRef.current[0]?.role === "system") {
            messagesRef.current[0] = { role: "system", content: newSystemPrompt };
          } else {
            messagesRef.current.unshift({ role: "system", content: newSystemPrompt });
          }

          const title = `Fix ${errorId.slice(0, 12)}… in ${prep.projectName}`;
          const taskItem: TaskItem = { kind: "task", title, id: getId() };
          setLastUserMessage(title);
          setDoneStatus(null);
          setLiveItems([taskItem]);

          await agentLoop.run(prep.prompt);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("ERROR", "pixel", msg);
          currentPixelFixRef.current = null;
          setRunAllPixel(false);
          setLiveItems((prev) => [...prev, toErrorItem(err, getId())]);
        }
      })();
    },
    [cwd, agentLoop, currentProvider, currentModel],
  );
  startPixelFixRef.current = startPixelFix;

  // Seed from sessionStore so "Fix All" chaining survives a deferred
  // resetUI() if it fires between pixel fixes (e.g. user toggled a pane).
  useEffect(() => {
    runAllPixelRef.current = runAllPixel;
    if (sessionStore) sessionStore.runAllPixel = runAllPixel;
  }, [runAllPixel, sessionStore, runAllPixelRef]);

  return { startPixelFix, runAllPixel, setRunAllPixel };
}
