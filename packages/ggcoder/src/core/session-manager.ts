import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Message, Provider } from "@kenkaiiii/gg-ai";

// ── Entry Types ────────────────────────────────────────────

interface BaseEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends BaseEntry {
  type: "message";
  message: Message;
}

export interface ModelChangeEntry extends BaseEntry {
  type: "model_change";
  provider: Provider;
  model: string;
}

export interface ThinkingLevelChangeEntry extends BaseEntry {
  type: "thinking_level_change";
  level: string;
}

export interface CompactionEntry extends BaseEntry {
  type: "compaction";
  originalCount: number;
  newCount: number;
  summary: string;
}

export interface LabelEntry extends BaseEntry {
  type: "label";
  label: string;
}

export interface CustomEntry extends BaseEntry {
  type: "custom";
  kind: string;
  data: unknown;
}

export type SessionEntry =
  | MessageEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CompactionEntry
  | LabelEntry
  | CustomEntry;

// ── Session Header ─────────────────────────────────────────

export interface SessionHeader {
  type: "session";
  version: 2;
  id: string;
  timestamp: string;
  cwd: string;
  provider: Provider;
  model: string;
  leafId: string | null;
}

// v1 compat
interface SessionHeaderV1 {
  type: "session";
  version: 1;
  id: string;
  timestamp: string;
  cwd: string;
  provider: Provider;
  model: string;
}

type SessionLine = SessionHeader | SessionHeaderV1 | SessionEntry;

// ── Session Info ───────────────────────────────────────────

export interface SessionInfo {
  id: string;
  path: string;
  timestamp: string;
  cwd: string;
  messageCount: number;
}

// ── Session Manager ────────────────────────────────────────

function encodeCwd(cwd: string): string {
  return cwd.replace(/[\\/]/g, "_").replace(/:/g, "").replace(/^_/, "");
}

export class SessionManager {
  private sessionsDir: string;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
  }

  private dirForCwd(cwd: string): string {
    return path.join(this.sessionsDir, encodeCwd(cwd));
  }

  async create(
    cwd: string,
    provider: Provider,
    model: string,
  ): Promise<{
    id: string;
    path: string;
    header: SessionHeader;
  }> {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const dir = this.dirForCwd(cwd);
    await fs.mkdir(dir, { recursive: true });

    const fileName = `${timestamp.replace(/[:.]/g, "-")}_${id.slice(0, 8)}.jsonl`;
    const filePath = path.join(dir, fileName);

    const header: SessionHeader = {
      type: "session",
      version: 2,
      id,
      timestamp,
      cwd,
      provider,
      model,
      leafId: null,
    };

    await fs.appendFile(filePath, JSON.stringify(header) + "\n", "utf-8");
    return { id, path: filePath, header };
  }

  async load(sessionPath: string): Promise<{
    header: SessionHeader;
    entries: SessionEntry[];
  }> {
    const content = await fs.readFile(sessionPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    let header: SessionHeader | null = null;
    const entries: SessionEntry[] = [];

    for (const line of lines) {
      const parsed = JSON.parse(line) as SessionLine;
      if (parsed.type === "session") {
        if ((parsed as SessionHeader).version === 2) {
          header = parsed as SessionHeader;
        } else {
          // Upgrade v1 to v2
          const v1 = parsed as SessionHeaderV1;
          header = {
            type: "session",
            version: 2,
            id: v1.id,
            timestamp: v1.timestamp,
            cwd: v1.cwd,
            provider: v1.provider,
            model: v1.model,
            leafId: null,
          };
        }
      } else if (parsed.type === "message") {
        // v1 compat: entries without id/parentId
        const entry = parsed as SessionEntry;
        if (!entry.id) {
          (entry as MessageEntry).id = crypto.randomUUID();
          (entry as MessageEntry).parentId = null;
        }
        entries.push(entry);
      } else {
        entries.push(parsed as SessionEntry);
      }
    }

    if (!header) {
      throw new Error(`Invalid session file: no header found in ${sessionPath}`);
    }

    // Guard: verify the session's working directory still exists on disk.
    // This prevents crashes when resuming sessions whose worktree was deleted.
    if (!existsSync(header.cwd)) {
      throw new Error(
        `Worktree directory no longer exists: ${header.cwd}\n` +
          `The working directory for this session has been removed. ` +
          `You may need to start a new session or recreate the worktree.`,
      );
    }

    return { header, entries };
  }

  async list(cwd: string): Promise<SessionInfo[]> {
    const dir = this.dirForCwd(cwd);

    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }

    const sessions: SessionInfo[] = [];

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, file);

      try {
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        if (lines.length === 0) continue;

        const first = JSON.parse(lines[0]) as SessionLine;
        if (first.type !== "session") continue;

        const messageCount = lines.filter((l) => {
          try {
            return (JSON.parse(l) as SessionLine).type === "message";
          } catch {
            return false;
          }
        }).length;

        sessions.push({
          id: first.id,
          path: filePath,
          timestamp: first.timestamp,
          cwd: first.cwd,
          messageCount,
        });
      } catch {
        // Skip corrupt files
      }
    }

    sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return sessions;
  }

  async getMostRecent(cwd: string): Promise<string | null> {
    const sessions = await this.list(cwd);
    const withMessages = sessions.find((s) => s.messageCount > 0);
    return withMessages?.path ?? null;
  }

  async appendEntry(sessionPath: string, entry: SessionEntry): Promise<void> {
    await fs.appendFile(sessionPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  async updateLeaf(sessionPath: string, leafId: string): Promise<void> {
    const content = await fs.readFile(sessionPath, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length === 0) return;

    const header = JSON.parse(lines[0]) as SessionLine;
    if (header.type === "session") {
      (header as SessionHeader).leafId = leafId;
      lines[0] = JSON.stringify(header);
      await fs.writeFile(sessionPath, lines.join("\n") + "\n", "utf-8");
    }
  }

  getMessages(entries: SessionEntry[]): Message[] {
    const messages = entries
      .filter((e): e is MessageEntry => e.type === "message")
      .map((e) => e.message)
      .filter((m) => m.role !== "system");

    // Repair orphaned tool_use blocks that lack matching tool_result messages.
    // This can happen when a session is interrupted mid-tool-execution.
    return SessionManager.repairToolPairs(messages);
  }

  /**
   * Ensure every assistant message with tool_use blocks is followed by a tool
   * message containing matching tool_result entries. Inserts synthetic
   * tool_result messages where needed to prevent Anthropic API 400 errors.
   */
  static repairToolPairs(messages: Message[]): Message[] {
    const repaired: Message[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      repaired.push(msg);

      if (msg.role !== "assistant") continue;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const toolUseIds = content
        .filter((p) => p.type === "tool_call")
        .map((p) => (p as { type: "tool_call"; id: string }).id);
      if (toolUseIds.length === 0) continue;

      // Check if the next message is a tool message with matching results
      const next = messages[i + 1];
      if (next?.role === "tool" && Array.isArray(next.content)) {
        const existingIds = new Set(next.content.map((r: { toolCallId: string }) => r.toolCallId));
        const missing = toolUseIds.filter((id) => !existingIds.has(id));
        if (missing.length > 0) {
          // Patch the existing tool message with missing results
          for (const id of missing) {
            (
              next.content as {
                type: string;
                toolCallId: string;
                content: string;
                isError: boolean;
              }[]
            ).push({
              type: "tool_result",
              toolCallId: id,
              content: "Tool execution was interrupted.",
              isError: true,
            });
          }
        }
      } else {
        // No tool message follows — insert a synthetic one
        repaired.push({
          role: "tool" as const,
          content: toolUseIds.map((id) => ({
            type: "tool_result" as const,
            toolCallId: id,
            content: "Tool execution was interrupted.",
            isError: true,
          })),
        });
      }
    }

    return repaired;
  }

  getBranch(entries: SessionEntry[], leafId: string | null): SessionEntry[] {
    if (!leafId) return entries;

    const byId = new Map(entries.map((e) => [e.id, e]));
    const branch: SessionEntry[] = [];
    let current = leafId;

    while (current) {
      const entry = byId.get(current);
      if (!entry) break;
      branch.push(entry);
      current = entry.parentId!;
    }

    return branch.reverse();
  }
}
