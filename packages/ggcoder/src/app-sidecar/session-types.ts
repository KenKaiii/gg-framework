import type http from "node:http";
import type { AgentSession } from "../core/agent-session.js";
import type { ChatAgentId } from "../chat-agents/index.js";
import type { ChildProcess } from "node:child_process";
import type { PullPhase } from "../hf-pull.js";

export interface SseClient {
  id: number;
  res: http.ServerResponse;
}

export type WorkspaceMode = "code" | "chat" | "motion";

/** Unknown or missing modes fall back to the coding agent. */
export function parseWorkspaceMode(value: unknown): WorkspaceMode {
  return value === "chat" || value === "motion" ? value : "code";
}

export interface SessionContext {
  id: string;
  mode: WorkspaceMode;
  chatAgent: ChatAgentId;
  cwd: string;
  sessionPath?: string;
  session: AgentSession;
  clients: Set<SseClient>;
  broadcast: (type: string, data: unknown) => void;
  /** Handle one HTTP request for this session. Owns its own 404 fallthrough. */
  handle: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ) => void;
  dispose: () => Promise<void>;
  /** Synchronously stop this context's background commands (all its sessions). */
  stopBackgroundProcesses: () => void;
  /** Working right now: a run in progress, or a worker still on a task. */
  isBusy: () => boolean;
  /**
   * The folder this window reads git state from (a Goal window: its project
   * folder, not the goal folder). Absent for contexts without git state.
   */
  gitDir?: () => string;
}

export interface HfPullState {
  repo: string;
  model: string;
  tag: string | null;
  file: string;
  sizeBytes: number;
  phase: PullPhase;
  percent: number;
  detail?: string;
  error?: string;
  child: ChildProcess | null;
}
