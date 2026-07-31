import type { PromptSegment } from "./agent";
import type { HookKind } from "./useAgentEvents";
import type { SubAgentLine } from "./SubAgentFeed";

export type Item =
  | {
      kind: "user";
      id: number;
      text: string;
      command?: boolean;
      label?: string;
      images?: string[];
      files?: string[];
      enhancements?: PromptSegment[];
      queued?: boolean;
      ken?: boolean;
      kenSent?: boolean;
    }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "ken"; id: number; text: string }
  | { kind: "info"; id: number; text: string }
  | {
      kind: "error";
      id: number;
      text?: string;
      headline?: string;
      message?: string;
      guidance?: string;
      recoveryId?: string;
      action?: { label: string; run: () => Promise<void> };
    }
  | { kind: "hook"; id: number; hook: HookKind }
  | { kind: "images"; id: number; images: TranscriptImage[]; caption?: string }
  | { kind: "generating_image"; id: number; prompt: string }
  | { kind: "plan"; id: number; reason: string }
  | { kind: "task"; id: number; title: string }
  | { kind: "subagent_group"; id: number; agents: SubAgentLine[]; aborted?: boolean }
  | {
      kind: "compaction";
      id: number;
      status: "running" | "done" | "sync-failed";
      originalCount?: number;
      newCount?: number;
      message?: string;
      guidance?: string;
    }
  | {
      kind: "autopilot";
      id: number;
      phase: "prompted" | "done" | "human" | "capped" | "plan_approved";
      reason?: string;
      body?: string;
      copySeed?: string;
    };

export interface TranscriptImage {
  src: string;
  path?: string;
}
