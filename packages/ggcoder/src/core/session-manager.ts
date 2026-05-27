import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import crypto from "node:crypto";
import type { Message, Provider } from "@kenkaiiii/gg-ai";
import type { CompletedItem } from "../ui/app-items.js";

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

export const DISPLAY_ITEM_CUSTOM_KIND = "display_item";

interface DisplayItemPayload {
  version: 1;
  item: CompletedItem;
}

export type SessionEntry =
  | MessageEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CompactionEntry
  | LabelEntry
  | CustomEntry;

function isCompletedItemLike(value: unknown): value is CompletedItem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

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

// ── Branch Info ───────────────────────────────────────────

export interface BranchInfo {
  /** The entry ID where this branch diverges from its parent branch */
  branchPointId: string;
  /** The leaf (tip) entry ID of this branch */
  leafId: string;
  /** Number of entries in this branch after the branch point */
  entryCount: number;
  /** Timestamp of the first entry in the branch */
  timestamp: string;
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
    // Stream the JSONL file line-by-line instead of loading the entire
    // file into memory. For large sessions (100MB+) this avoids holding
    // the raw string, the split array, and the parsed objects all at once.
    let header: SessionHeader | null = null;
    const entries: SessionEntry[] = [];

    const rl = createInterface({
      input: createReadStream(sessionPath, { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;
      try {
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
      } catch {
        // Skip malformed JSON lines — a corrupt line shouldn't crash the session
      }
    }

    if (!header) {
      throw new Error(`Invalid session file: no header found in ${sessionPath}`);
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
        // Stream line-by-line to avoid loading entire file for listing
        const rl = createInterface({
          input: createReadStream(filePath, { encoding: "utf-8" }),
          crlfDelay: Infinity,
        });

        let first: SessionLine | null = null;
        let messageCount = 0;

        for await (const line of rl) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as SessionLine;
            if (!first) {
              if (parsed.type !== "session") break;
              first = parsed;
            } else if (parsed.type === "message") {
              messageCount++;
            }
          } catch {
            // Skip malformed lines
          }
        }

        if (!first || first.type !== "session") continue;

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

  async findById(cwd: string, sessionId: string): Promise<string | null> {
    const sessions = await this.list(cwd);
    return sessions.find((session) => session.id === sessionId)?.path ?? null;
  }

  async appendEntry(sessionPath: string, entry: SessionEntry): Promise<void> {
    await fs.appendFile(sessionPath, JSON.stringify(entry) + "\n", "utf-8");
  }

  async updateLeaf(sessionPath: string, leafId: string): Promise<void> {
    // Read only the first line (the header) instead of loading the entire file.
    // For large session files (100MB+), this avoids a full file read+write.
    const fd = await fs.open(sessionPath, "r+");
    try {
      // Read enough bytes to cover the header line (typically <500 bytes)
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fd.read(buf, 0, 4096, 0);
      const chunk = buf.toString("utf-8", 0, bytesRead);
      const newlineIdx = chunk.indexOf("\n");
      if (newlineIdx === -1) return;

      const headerLine = chunk.slice(0, newlineIdx);
      const header = JSON.parse(headerLine) as SessionLine;
      if (header.type !== "session") return;

      (header as SessionHeader).leafId = leafId;
      const newHeaderLine = JSON.stringify(header);

      if (newHeaderLine.length === headerLine.length) {
        // Same length — overwrite in place (fast path)
        await fd.write(newHeaderLine, 0, "utf-8");
      } else {
        // Different length — must rewrite the file (rare: only on first leafId set)
        await fd.close();
        const content = await fs.readFile(sessionPath, "utf-8");
        const firstNewline = content.indexOf("\n");
        await fs.writeFile(sessionPath, newHeaderLine + content.slice(firstNewline), "utf-8");
        return;
      }
    } finally {
      // fd.close() may have already been called in the else branch above,
      // but calling it again on a closed handle is a no-op in Node >= 20.
      await fd.close().catch(() => {});
    }
  }

  /**
   * Get messages for the current branch. If leafId is set, walks the
   * DAG from leaf to root. Otherwise returns all entries linearly.
   */
  getMessages(entries: SessionEntry[], leafId?: string | null): Message[] {
    const branch = leafId ? this.getBranch(entries, leafId) : entries;
    const messages = branch
      .filter((e): e is MessageEntry => e.type === "message")
      .map((e) => e.message)
      .filter((m) => m.role !== "system");

    // Repair orphaned tool_use blocks that lack matching tool_result messages.
    // This can happen when a session is interrupted mid-tool-execution.
    return SessionManager.repairToolPairs(messages);
  }

  getDisplayItems(entries: SessionEntry[], _leafId?: string | null): CompletedItem[] {
    return entries.flatMap((entry): CompletedItem[] => {
      if (entry.type !== "custom" || entry.kind !== DISPLAY_ITEM_CUSTOM_KIND) return [];
      const payload = entry.data as Partial<DisplayItemPayload> | undefined;
      const item = payload?.version === 1 ? payload.item : undefined;
      return isCompletedItemLike(item) ? [item] : [];
    });
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

  /**
   * Build a lookup Map from entry id → entry. Reusable across multiple
   * getBranch / listBranches calls on the same entry set.
   */
  private buildIndex(entries: SessionEntry[]): Map<string, SessionEntry> {
    return new Map(entries.map((e) => [e.id, e]));
  }

  /**
   * Walk the DAG from a leaf entry back to the root, returning entries
   * in chronological order (root → leaf). This is the "branch" — the
   * path through the conversation tree that leads to the given leaf.
   *
   * Accepts an optional pre-built index to avoid redundant Map allocations
   * when called in a loop.
   */
  getBranch(
    entries: SessionEntry[],
    leafId: string | null,
    byId?: Map<string, SessionEntry>,
  ): SessionEntry[] {
    if (!leafId) return entries;

    const index = byId ?? this.buildIndex(entries);
    const branch: SessionEntry[] = [];
    let current = leafId;

    while (current) {
      const entry = index.get(current);
      if (!entry) break;
      branch.push(entry);
      current = entry.parentId!;
    }

    return branch.reverse();
  }

  /**
   * List all branches (leaf nodes) in a session's entry DAG.
   * A leaf is any entry whose id is not referenced as a parentId by any other entry.
   */
  listBranches(entries: SessionEntry[]): BranchInfo[] {
    if (entries.length === 0) return [];

    // Build shared index once — reused by every getBranch call below
    const byId = this.buildIndex(entries);

    // Find all ids that are referenced as parentId
    const parentIds = new Set(entries.map((e) => e.parentId).filter(Boolean));

    // Leaves = entries whose id is NOT in parentIds
    const leaves = entries.filter((e) => !parentIds.has(e.id));

    // Build childCount once — was previously rebuilt per-leaf (O(n²))
    const childCount = new Map<string | null, number>();
    for (const e of entries) {
      childCount.set(e.parentId, (childCount.get(e.parentId) ?? 0) + 1);
    }

    return leaves.map((leaf) => {
      const branch = this.getBranch(entries, leaf.id, byId);

      let branchPointId = branch[0]?.id ?? leaf.id;
      for (const e of branch) {
        if ((childCount.get(e.parentId) ?? 0) > 1) {
          branchPointId = e.id;
          break;
        }
      }

      return {
        branchPointId,
        leafId: leaf.id,
        entryCount: branch.length,
        timestamp: branch[0]?.timestamp ?? leaf.timestamp,
      };
    });
  }
}
