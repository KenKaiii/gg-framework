import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { AgentSession } from "../core/agent-session.js";
import { createGeneralChatAgent, GENERAL_CHAT_SYSTEM_PROMPT } from "./general.js";
import { createResearchChatAgent, RESEARCH_CHAT_SYSTEM_PROMPT } from "./research.js";
import { createTherapistChatAgent, THERAPIST_CHAT_SYSTEM_PROMPT } from "./therapist.js";
import {
  buildChatAgentSystemPrompt,
  chatAgentSessionsDir,
  type ChatAgentOptions,
} from "./shared.js";
import { parseChatAgentId, type ChatAgentId } from "./types.js";

export { CHAT_AGENT_IDS, parseChatAgentId, type ChatAgentId } from "./types.js";
export { CHAT_FOLDER_NAME, chatAgentSessionsDir, chatWorkspaceDir } from "./shared.js";

export const CHAT_AGENT_LABELS: Record<ChatAgentId, string> = {
  general: "General Agent",
  therapist: "Therapist Agent",
  research: "Research Agent",
};

const CHAT_AGENT_PROMPTS: Record<ChatAgentId, string> = {
  general: GENERAL_CHAT_SYSTEM_PROMPT,
  therapist: THERAPIST_CHAT_SYSTEM_PROMPT,
  research: RESEARCH_CHAT_SYSTEM_PROMPT,
};

const delegationParameters = z.object({
  agent: z.enum(["general", "therapist", "research"]).describe("Agent to hand off to"),
});

interface ChatAgentController {
  current: ChatAgentId;
  switchTo: (agentId: ChatAgentId, notify: boolean) => Promise<boolean>;
}

const chatAgentControllers = new WeakMap<AgentSession, ChatAgentController>();

function createDelegationTool(
  getController: () => ChatAgentController,
): AgentTool<typeof delegationParameters> {
  return {
    name: "delegate_to_agent",
    description:
      "Hand the entire ongoing conversation to a different active agent. Therapist handles emotional support, reflection, coping, relationships, and wellbeing. Research handles evidence, sources, current information, comparisons, and deep analysis. General handles broad conversation that no longer needs a specialist. This is a persistent handoff, not a one-off subtask.",
    parameters: delegationParameters,
    executionMode: "sequential",
    async execute({ agent }) {
      const controller = getController();
      if (agent === controller.current) {
        return `Already running as ${CHAT_AGENT_LABELS[controller.current]}; continue directly.`;
      }
      await controller.switchTo(agent, true);
      return `Handoff complete. ${CHAT_AGENT_LABELS[agent]} is now the active agent for this conversation. Continue from the full conversation history in that role.`;
    },
  };
}

/** Switch an existing chat session without resetting its conversation history. */
export async function switchChatAgent(
  session: AgentSession,
  agentId: ChatAgentId,
  notify = true,
): Promise<boolean> {
  const controller = chatAgentControllers.get(session);
  if (!controller) throw new Error("Session is not a chat agent");
  return controller.switchTo(agentId, notify);
}

export function createChatAgent(
  agentId: ChatAgentId,
  options: ChatAgentOptions,
  delegationEnabled = true,
): AgentSession {
  let session!: AgentSession;
  const sessionOptions = delegationEnabled
    ? {
        ...options,
        additionalTools: [
          ...(options.additionalTools ?? []),
          createDelegationTool(() => controller),
        ],
      }
    : {
        ...options,
        additionalTools: (options.additionalTools ?? []).filter(
          (tool) => tool.name !== "delegate_to_agent",
        ),
      };

  switch (agentId) {
    case "therapist":
      session = createTherapistChatAgent(sessionOptions);
      break;
    case "research":
      session = createResearchChatAgent(sessionOptions);
      break;
    case "general":
      session = createGeneralChatAgent(sessionOptions);
      break;
  }

  const controller: ChatAgentController = {
    current: agentId,
    async switchTo(nextAgent, notify) {
      if (nextAgent === controller.current) return false;
      controller.current = nextAgent;
      session.setCustomSystemPrompt(
        buildChatAgentSystemPrompt(
          nextAgent,
          CHAT_AGENT_PROMPTS[nextAgent],
          options.cwd,
          delegationEnabled,
        ),
        `ggchat:${nextAgent}`,
      );
      if (notify) await options.onAgentChange?.(nextAgent);
      return true;
    },
  };
  chatAgentControllers.set(session, controller);
  return session;
}

export function sessionsDirForChatAgent(coderSessionsDir: string, value: unknown): string {
  return chatAgentSessionsDir(coderSessionsDir, parseChatAgentId(value));
}
