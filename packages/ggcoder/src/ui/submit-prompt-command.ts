import type React from "react";
import type { Message } from "@kenkaiiii/gg-ai";
import type { ImageAttachment } from "../utils/image.js";
import { getModel } from "../core/model-registry.js";
import { PROMPT_COMMANDS } from "../core/prompt-commands.js";
import type { CustomCommand } from "../core/custom-commands.js";
import type { GoalMode } from "../core/runtime-mode.js";
import { buildGoalReferenceContext } from "../core/goal-references.js";
import type { GoalReference } from "../core/goal-store.js";
import { log } from "../core/logger.js";
import {
  buildUserContentWithAttachments,
  isGoalPromptCommandName,
  routePromptCommandInput,
  runGoalPromptSetupSequence,
} from "./prompt-routing.js";
import { getGoalSetupPaneTransitionAfterRun } from "./layout-decisions.js";
import type { CompletedItem, UserItem } from "./app-items.js";
import type { UserContent } from "./hooks/useAgentLoop.js";
import { toErrorItem } from "./error-item.js";

interface PromptCommandSubmitOptions {
  trimmed: string;
  inputImages: ImageAttachment[];
  cwd: string;
  currentModel: string;
  customCommands: CustomCommand[];
  messagesRef: React.MutableRefObject<Message[]>;
  goalSetupPanePendingRef: React.MutableRefObject<boolean>;
  goalModeStateRef: React.MutableRefObject<GoalMode>;
  goalAutoExpandRef: React.MutableRefObject<boolean>;
  setActiveGoalReferences: (references: readonly GoalReference[] | undefined) => void;
  setLastUserMessage: (message: string) => void;
  setDoneStatus: (status: { verb: string; durationMs: number; toolsUsed: string[] } | null) => void;
  finalizeSubmittedUserItem: (item: UserItem) => void;
  setGoalModeAndPrompt: (mode: GoalMode) => Promise<void>;
  runAgent: (content: UserContent) => Promise<void>;
  appendGoalAgentTransition: (text: string) => void;
  setLiveItems: React.Dispatch<React.SetStateAction<CompletedItem[]>>;
  getId: () => string;
  setGoalAutoExpand: (value: boolean) => void;
  setPlanAutoExpand: (value: boolean) => void;
  closeTaskPicker: () => void;
  openGoalPicker: () => void;
  reloadCustomCommands: () => void;
}

export async function submitPromptCommand({
  trimmed,
  inputImages,
  cwd,
  currentModel,
  customCommands,
  messagesRef,
  goalSetupPanePendingRef,
  goalModeStateRef,
  goalAutoExpandRef,
  setActiveGoalReferences,
  setLastUserMessage,
  setDoneStatus,
  finalizeSubmittedUserItem,
  setGoalModeAndPrompt,
  runAgent,
  appendGoalAgentTransition,
  setLiveItems,
  getId,
  setGoalAutoExpand,
  setPlanAutoExpand,
  closeTaskPicker,
  openGoalPicker,
  reloadCustomCommands,
}: PromptCommandSubmitOptions): Promise<boolean> {
  const promptCommandRoute = routePromptCommandInput(trimmed, PROMPT_COMMANDS, customCommands);
  if (!promptCommandRoute) return false;

  const { cmdName, cmdArgs, fullPrompt } = promptCommandRoute;
  log("INFO", "command", `Prompt command: /${cmdName}${cmdArgs ? ` (args: ${cmdArgs})` : ""}`);

  const hasImages = inputImages.length > 0;
  const isGoalSetupCommand = isGoalPromptCommandName(cmdName);
  let promptForAgent = fullPrompt;
  if (isGoalSetupCommand) {
    const referenceContext = await buildGoalReferenceContext({
      cwd,
      originalGoalPrompt: fullPrompt,
      attachments: inputImages,
    });
    setActiveGoalReferences(referenceContext.references);
    promptForAgent = referenceContext.promptSection
      ? `${fullPrompt}\n\n${referenceContext.promptSection}`
      : fullPrompt;
  }

  const modelInfo = getModel(currentModel);
  const modelSupportsImages = modelInfo?.supportsImages ?? true;
  const userContent = buildUserContentWithAttachments(
    promptForAgent,
    inputImages,
    modelSupportsImages,
  );

  const userItem: UserItem = {
    kind: "user",
    text: trimmed,
    imageCount: hasImages ? inputImages.length : undefined,
    id: getId(),
  };
  setLastUserMessage(trimmed);
  setDoneStatus(null);
  finalizeSubmittedUserItem(userItem);

  try {
    if (isGoalSetupCommand) {
      goalSetupPanePendingRef.current = true;
      await runGoalPromptSetupSequence({
        userContent,
        fullPrompt: promptForAgent,
        messagesRef,
        setGoalModeAndPrompt,
        runAgent,
        onStage: appendGoalAgentTransition,
      });
    } else {
      await runAgent(userContent);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", "error", msg);
    const isAbort = msg.includes("aborted") || msg.includes("abort");
    if (isGoalSetupCommand) goalSetupPanePendingRef.current = false;
    setLiveItems((prev) => [
      ...prev,
      isAbort
        ? { kind: "stopped", text: "Request was stopped.", id: getId() }
        : toErrorItem(err, getId()),
    ]);
  } finally {
    if (isGoalSetupCommand) {
      setActiveGoalReferences(undefined);
      const paneTransition = getGoalSetupPaneTransitionAfterRun({
        isGoalSetupCommand,
        setupPanePending: goalSetupPanePendingRef.current,
      });
      goalSetupPanePendingRef.current = false;
      if (goalModeStateRef.current !== "off") {
        await setGoalModeAndPrompt("off");
      }
      if (paneTransition) {
        goalAutoExpandRef.current = false;
        setGoalAutoExpand(false);
        setPlanAutoExpand(false);
        closeTaskPicker();
        openGoalPicker();
      }
    }
  }

  reloadCustomCommands();
  return true;
}
