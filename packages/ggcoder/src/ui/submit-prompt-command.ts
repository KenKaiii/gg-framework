import type React from "react";
import type { ImageAttachment } from "../utils/image.js";
import { getModel } from "../core/model-registry.js";
import { PROMPT_COMMANDS } from "../core/prompt-commands.js";
import type { CustomCommand } from "../core/custom-commands.js";
import { log } from "../core/logger.js";
import { buildUserContentWithAttachments, routePromptCommandInput } from "./prompt-routing.js";
import type { CompletedItem, UserItem } from "./app-items.js";
import type { UserContent } from "./hooks/useAgentLoop.js";
import { toErrorItem } from "./error-item.js";

interface PromptCommandSubmitOptions {
  trimmed: string;
  inputImages: ImageAttachment[];
  currentModel: string;
  customCommands: CustomCommand[];
  setLastUserMessage: (message: string) => void;
  setDoneStatus: (status: { verb: string; durationMs: number; toolsUsed: string[] } | null) => void;
  finalizeSubmittedUserItem: (item: UserItem) => void;
  runAgent: (content: UserContent) => Promise<void>;
  setLiveItems: React.Dispatch<React.SetStateAction<CompletedItem[]>>;
  getId: () => string;
  reloadCustomCommands: () => void;
}

export async function submitPromptCommand({
  trimmed,
  inputImages,
  currentModel,
  customCommands,
  setLastUserMessage,
  setDoneStatus,
  finalizeSubmittedUserItem,
  runAgent,
  setLiveItems,
  getId,
  reloadCustomCommands,
}: PromptCommandSubmitOptions): Promise<boolean> {
  const promptCommandRoute = routePromptCommandInput(trimmed, PROMPT_COMMANDS, customCommands);
  if (!promptCommandRoute) return false;

  const { cmdName, cmdArgs, fullPrompt } = promptCommandRoute;
  log("INFO", "command", `Prompt command: /${cmdName}${cmdArgs ? ` (args: ${cmdArgs})` : ""}`);

  const hasImages = inputImages.length > 0;

  const modelInfo = getModel(currentModel);
  const modelSupportsImages = modelInfo?.supportsImages ?? true;
  const userContent = buildUserContentWithAttachments(fullPrompt, inputImages, modelSupportsImages);

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
    await runAgent(userContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", "error", msg);
    const isAbort = msg.includes("aborted") || msg.includes("abort");
    setLiveItems((prev) => [
      ...prev,
      isAbort
        ? { kind: "stopped", text: "Request was stopped.", id: getId() }
        : toErrorItem(err, getId()),
    ]);
  }

  reloadCustomCommands();
  return true;
}
