import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import crypto from "node:crypto";
import {
  environmentSecrets,
  redactValue,
  type Message,
  type Provider,
  type Usage,
} from "@kenkaiiii/gg-ai";
import type { AgentTurnTiming } from "@kenkaiiii/gg-agent";
import { log } from "./logger.js";
import { encodeCwd } from "./encode-cwd.js";
import type { CompletedItem } from "../ui/app-items.js";
import {
  archiveColdSession,
  archiveSessionPath,
  cleanupOldSessionTemps,
  COLD_SESSION_AGE_DAYS,
  emptyStorageNormalizationMetrics,
  hydrateSessionEntry,
  isSessionPath,
  normalizeSessionEntryForStorage,
  openSessionReadStream,
  plainSessionPath,
  resolveSessionPath,
  sessionAssetDir,
  thawSessionArchive,
  type StorageNormalizationMetrics,
} from "./session-storage.js";

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
export const TURN_METRIC_CUSTOM_KIND = "turn_metric";

export type TurnMetricCost =
  | { status: "known"; usd: number; source: string; effectiveAt: string }
  | { status: "unavailable"; reason: string };

export interface TurnMetricPayload {
  version: 1;
  turn: number;
  provider: Provider;
  model: string;
  stopReason: string;
  usage: Usage;
  timing: AgentTurnTiming;
  cost: TurnMetricCost;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseTurnMetric(value: unknown): TurnMetricPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as Partial<TurnMetricPayload>;
  const usage = payload.usage as Partial<Usage> | undefined;
  const timing = payload.timing as Partial<AgentTurnTiming> | undefined;
  const cost = payload.cost as Partial<TurnMetricCost> | undefined;
  if (
    payload.version !== 1 ||
    !finiteNumber(payload.turn) ||
    typeof payload.provider !== "string" ||
    typeof payload.model !== "string" ||
    typeof payload.stopReason !== "string" ||
    !usage ||
    !finiteNumber(usage.inputTokens) ||
    !finiteNumber(usage.outputTokens) ||
    !timing ||
    !finiteNumber(timing.startedAt) ||
    !finiteNumber(timing.completedAt) ||
    !finiteNumber(timing.providerDurationMs) ||
    !cost ||
    (cost.status !== "known" && cost.status !== "unavailable")
  ) {
    return undefined;
  }
  if (
    (usage.cacheRead !== undefined && !finiteNumber(usage.cacheRead)) ||
    (usage.cacheWrite !== undefined && !finiteNumber(usage.cacheWrite)) ||
    (timing.firstProviderEventAt !== undefined && !finiteNumber(timing.firstProviderEventAt)) ||
    (timing.ttftMs !== undefined && !finiteNumber(timing.ttftMs)) ||
    (timing.outputTokensPerSecond !== undefined && !finiteNumber(timing.outputTokensPerSecond)) ||
    (cost.status === "known" &&
      (!finiteNumber(cost.usd) ||
        typeof cost.source !== "string" ||
        typeof cost.effectiveAt !== "string")) ||
    (cost.status === "unavailable" && typeof cost.reason !== "string")
  ) {
    return undefined;
  }
  return payload as TurnMetricPayload;
}

interface DisplayItemPayload {
  version: 1;
  item: CompletedItem;
}

/** Custom-entry kind for a Ken Kai (mentor agent) turn. Ken's advisory
 *  conversation is NOT part of the LLM message history (GG Coder never sees it),
 *  but it's persisted alongside the build session so it survives resume. Stored
 *  as a `custom` entry with `parentId: null` so it is NEVER on the message DAG
 *  branch — this keeps it out of `getMessages()` AND avoids racing the build
 *  session's leaf pointer (Ken runs concurrently). `afterMessageCount` is the
 *  number of non-system messages that existed when the turn was recorded, used
 *  to interleave Ken turns back into the transcript chronologically. */
export const KEN_TURN_CUSTOM_KIND = "ken_turn";

export interface KenTurnPayload {
  version: 1;
  question: string;
  reply: string;
  afterMessageCount: number;
}

/** Custom-entry kind for an autopilot verdict marker. Mirrors `ken_turn`:
 *  persisted as a `custom` entry with `parentId: null` so it's never on the
 *  message DAG (GG Coder never sees it) but survives resume/compaction and
 *  interleaves back into the transcript via `afterMessageCount`. Covers all
 *  four terminal/near-terminal autopilot markers so a resumed session renders
 *  the exact same Ken bubble the live run showed — never the raw verdict
 *  keyword (e.g. `ALL_CLEAR`) the model actually replied with. */
export const AUTOPILOT_MARKER_CUSTOM_KIND = "autopilot_marker";

export interface AutopilotMarkerPayload {
  version: 1;
  phase: "prompted" | "done" | "human" | "capped" | "plan_approved";
  reason?: string;
  body?: string;
  afterMessageCount: number;
}

/** Custom-entry kind for a generic app transcript marker (plan-mode banner,
 *  task header, error row, user-bubble display hint). Same not-on-the-DAG
 *  treatment as Ken turns / autopilot markers: persisted with `parentId: null`
 *  so the LLM never sees it, anchored by `afterMessageCount` so the host can
 *  interleave it back into the transcript on resume. */
export const APP_MARKER_CUSTOM_KIND = "app_transcript_marker";

export interface AppMarkerPayload {
  version: 1;
  kind: "plan" | "task" | "error" | "user_hint" | "compaction" | "agent_handoff";
  afterMessageCount: number;
  /** Kind-specific display fields (reason/title/headline/kenSent/counts/…). */
  data: Record<string, unknown>;
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
  /** Stable identity shared by checkpoint files created during compaction. */
  conversationId?: string;
  /** Stable display fallback retained when checkpoint messages contain only internal summaries. */
  preview?: string;
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
  /** Timestamp of the most recent message (falls back to creation timestamp). */
  lastActivity: string;
  cwd: string;
  messageCount: number;
}

export interface SessionMaintenanceMetrics extends StorageNormalizationMetrics {
  deletedFiles: number;
  deletedBytes: number;
  archivedFiles: number;
  archivedSourceBytes: number;
  archivedBytes: number;
  bytesSaved: number;
  failures: number;
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

export class SessionManager {
  private static activePathsByRoot = new Map<string, Map<string, number>>();
  private static maintenanceByRoot = new Map<string, Promise<SessionMaintenanceMetrics>>();

  private sessionsDir: string;
  private warnedPersistCodes = new Set<string>();
  /** Called once per error code when session persistence fails (e.g. ENOSPC). */
  onPersistError?: (error: NodeJS.ErrnoException) => void;

  constructor(sessionsDir: string) {
    this.sessionsDir = path.resolve(sessionsDir);
  }

  /**
   * Session persistence must never crash a live session. Disk-full (ENOSPC),
   * permission, or quota errors during transcript writes are reported once
   * per error code and otherwise swallowed — the in-memory session keeps going.
   */
  private handlePersistError(error: unknown, op: string): void {
    const err = error as NodeJS.ErrnoException;
    const code = err?.code ?? "UNKNOWN";
    if (this.warnedPersistCodes.has(code)) return;
    this.warnedPersistCodes.add(code);
    log("WARN", "session", `Session persistence failed (${op}); continuing without saving`, {
      code,
      message: err?.message ?? String(error),
    });
    this.onPersistError?.(err);
  }

  private dirForCwd(cwd: string): string {
    return path.join(this.sessionsDir, encodeCwd(cwd));
  }

  async create(
    cwd: string,
    provider: Provider,
    model: string,
    options?: { conversationId?: string; preview?: string },
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

    const normalizedPreview = options?.preview?.replace(/\s+/g, " ").trim().slice(0, 80);
    const safePreview = normalizedPreview
      ? String(redactValue(normalizedPreview, { secrets: environmentSecrets(process.env) }))
      : undefined;
    const header: SessionHeader = {
      type: "session",
      version: 2,
      id,
      conversationId: options?.conversationId ?? id,
      ...(safePreview ? { preview: safePreview } : {}),
      timestamp,
      cwd,
      provider,
      model,
      leafId: null,
    };

    await fs.appendFile(filePath, JSON.stringify(header) + "\n", "utf-8");
    return { id, path: filePath, header };
  }

  registerActivePath(sessionPath: string): void {
    const root = this.sessionsDir;
    const active = SessionManager.activePathsByRoot.get(root) ?? new Map<string, number>();
    const basePath = path.resolve(plainSessionPath(sessionPath));
    active.set(basePath, (active.get(basePath) ?? 0) + 1);
    SessionManager.activePathsByRoot.set(root, active);
  }

  unregisterActivePath(sessionPath: string): void {
    const active = SessionManager.activePathsByRoot.get(this.sessionsDir);
    if (!active) return;
    const basePath = path.resolve(plainSessionPath(sessionPath));
    const registrations = active.get(basePath) ?? 0;
    if (registrations <= 1) active.delete(basePath);
    else active.set(basePath, registrations - 1);
    if (active.size === 0) SessionManager.activePathsByRoot.delete(this.sessionsDir);
  }

  private protectedSessionBases(keepPaths: string[] = []): Set<string> {
    return new Set([
      ...(SessionManager.activePathsByRoot.get(this.sessionsDir)?.keys() ?? []),
      ...keepPaths.map((sessionPath) => path.resolve(plainSessionPath(sessionPath))),
    ]);
  }

  async load(sessionPath: string): Promise<{
    header: SessionHeader;
    entries: SessionEntry[];
    path: string;
  }> {
    // Resuming is a write operation, so transparently thaw a gzip archive and
    // return the effective plain path every future append must use.
    const effectivePath = await thawSessionArchive(sessionPath);
    const { stream } = await openSessionReadStream(effectivePath);
    let header: SessionHeader | null = null;
    const entries: SessionEntry[] = [];
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as SessionLine;
        if (parsed.type === "session") {
          if ((parsed as SessionHeader).version === 2) {
            header = parsed as SessionHeader;
          } else {
            const v1 = parsed as SessionHeaderV1;
            header = {
              type: "session",
              version: 2,
              id: v1.id,
              conversationId: v1.id,
              timestamp: v1.timestamp,
              cwd: v1.cwd,
              provider: v1.provider,
              model: v1.model,
              leafId: null,
            };
          }
          continue;
        }

        const entry = parsed as SessionEntry;
        if (entry.type === "message" && !entry.id) {
          (entry as MessageEntry).id = crypto.randomUUID();
          (entry as MessageEntry).parentId = null;
        }
        entries.push(await hydrateSessionEntry(entry, effectivePath));
      } catch {
        // Skip malformed JSON lines — cold migration preserves their raw bytes
        // so a future recovery tool still has a chance to repair them.
      }
    }

    if (!header) {
      throw new Error(`Invalid session file: no header found in ${sessionPath}`);
    }
    return { header, entries, path: effectivePath };
  }

  private async readSessionInfo(
    candidatePath: string,
  ): Promise<(SessionInfo & { conversationId: string }) | null> {
    try {
      const resolvedPath = await resolveSessionPath(candidatePath);
      const { stream } = await openSessionReadStream(resolvedPath);
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let first: SessionLine | null = null;
      let messageCount = 0;
      let lastActivity: string | null = null;
      for await (const line of rl) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as SessionLine;
          if (!first) {
            if (parsed.type !== "session") break;
            first = parsed;
          } else if (parsed.type === "message") {
            messageCount += 1;
            if (parsed.timestamp) lastActivity = parsed.timestamp;
          }
        } catch {
          // Skip malformed lines while retaining readable entries around them.
        }
      }
      if (!first || first.type !== "session") return null;
      return {
        id: first.id,
        conversationId:
          (first as SessionHeader).version === 2
            ? ((first as SessionHeader).conversationId ?? first.id)
            : first.id,
        path: resolvedPath,
        timestamp: first.timestamp,
        lastActivity: lastActivity ?? first.timestamp,
        cwd: first.cwd,
        messageCount,
      };
    } catch {
      return null;
    }
  }

  private async sessionCandidates(directory: string): Promise<string[]> {
    let files: string[];
    try {
      files = await fs.readdir(directory);
    } catch {
      return [];
    }
    return files.filter(isSessionPath).map((file) => path.join(directory, file));
  }

  async list(cwd: string): Promise<SessionInfo[]> {
    const candidates = await this.sessionCandidates(this.dirForCwd(cwd));
    const summaries = await Promise.all(candidates.map((file) => this.readSessionInfo(file)));
    const byConversation = new Map<string, SessionInfo>();
    const seenResolvedPaths = new Set<string>();
    for (const summary of summaries) {
      if (!summary || seenResolvedPaths.has(summary.path)) continue;
      seenResolvedPaths.add(summary.path);
      const current = byConversation.get(summary.conversationId);
      if (!current || summary.lastActivity > current.lastActivity) {
        const { conversationId: _conversationId, ...info } = summary;
        byConversation.set(summary.conversationId, info);
      }
    }
    return [...byConversation.values()].sort((a, b) =>
      b.lastActivity.localeCompare(a.lastActivity),
    );
  }

  async getMostRecent(cwd: string): Promise<string | null> {
    const sessions = await this.list(cwd);
    return sessions.find((session) => session.messageCount > 0)?.path ?? null;
  }

  async findById(cwd: string, sessionId: string): Promise<string | null> {
    const candidates = await this.sessionCandidates(this.dirForCwd(cwd));
    for (const candidate of candidates) {
      const summary = await this.readSessionInfo(candidate);
      if (summary?.id === sessionId || summary?.conversationId === sessionId) return summary.path;
    }
    return null;
  }

  private async storageDirectories(): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.sessionsDir, entry.name));
  }

  private async logicalSessionBases(directory: string): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    const bases = new Set<string>();
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && isSessionPath(entry.name)) {
        bases.add(path.resolve(plainSessionPath(entryPath)));
      } else if (entry.isDirectory() && entry.name.endsWith(".jsonl.assets")) {
        bases.add(path.resolve(entryPath.slice(0, -".assets".length)));
      }
    }
    return [...bases];
  }

  private async removeStoragePath(
    targetPath: string,
  ): Promise<{ deletedFiles: number; deletedBytes: number }> {
    let stat;
    try {
      stat = await fs.lstat(targetPath);
    } catch {
      return { deletedFiles: 0, deletedBytes: 0 };
    }
    if (stat.isDirectory()) {
      const result = { deletedFiles: 0, deletedBytes: 0 };
      for (const name of await fs.readdir(targetPath)) {
        const removed = await this.removeStoragePath(path.join(targetPath, name));
        result.deletedFiles += removed.deletedFiles;
        result.deletedBytes += removed.deletedBytes;
      }
      await fs.rmdir(targetPath).catch(() => {});
      return result;
    }
    await fs.unlink(targetPath);
    return { deletedFiles: 1, deletedBytes: stat.size };
  }

  async pruneOldSessions(options: {
    maxAgeDays: number;
    keepPaths?: string[];
  }): Promise<{ deletedFiles: number; freedBytes: number }> {
    const result = { deletedFiles: 0, freedBytes: 0 };
    if (options.maxAgeDays <= 0) return result;
    const cutoffMs = Date.now() - options.maxAgeDays * 86_400_000;
    for (const directory of await this.storageDirectories()) {
      for (const basePath of await this.logicalSessionBases(directory)) {
        if (this.protectedSessionBases(options.keepPaths).has(basePath)) continue;
        try {
          const resolved = await resolveSessionPath(basePath);
          const stat = await fs.stat(resolved);
          if (stat.mtimeMs >= cutoffMs) continue;
          for (const target of [
            basePath,
            archiveSessionPath(basePath),
            sessionAssetDir(basePath),
          ]) {
            const removed = await this.removeStoragePath(target);
            result.deletedFiles += removed.deletedFiles;
            result.freedBytes += removed.deletedBytes;
          }
        } catch {
          // A raced, corrupt, or inaccessible logical group is skipped safely.
        }
      }
      await fs.rmdir(directory).catch(() => {});
    }
    return result;
  }

  async runMaintenance(options: {
    retentionDays: number;
    keepPaths?: string[];
    now?: number;
  }): Promise<SessionMaintenanceMetrics> {
    const existing = SessionManager.maintenanceByRoot.get(this.sessionsDir);
    if (existing) return existing;

    const maintenance = this.runMaintenanceUnsafe(options).finally(() => {
      SessionManager.maintenanceByRoot.delete(this.sessionsDir);
    });
    SessionManager.maintenanceByRoot.set(this.sessionsDir, maintenance);
    return maintenance;
  }

  private async runMaintenanceUnsafe(options: {
    retentionDays: number;
    keepPaths?: string[];
    now?: number;
  }): Promise<SessionMaintenanceMetrics> {
    const metrics: SessionMaintenanceMetrics = {
      deletedFiles: 0,
      deletedBytes: 0,
      archivedFiles: 0,
      archivedSourceBytes: 0,
      archivedBytes: 0,
      bytesSaved: 0,
      failures: 0,
      ...emptyStorageNormalizationMetrics(),
    };
    const pruned = await this.pruneOldSessions({
      maxAgeDays: options.retentionDays,
      keepPaths: options.keepPaths,
    });
    metrics.deletedFiles = pruned.deletedFiles;
    metrics.deletedBytes = pruned.freedBytes;

    const now = options.now ?? Date.now();
    const coldCutoff = now - COLD_SESSION_AGE_DAYS * 86_400_000;
    for (const directory of await this.storageDirectories()) {
      const tempCleanup = await cleanupOldSessionTemps(directory, now - 86_400_000);
      metrics.deletedFiles += tempCleanup.deletedFiles;
      metrics.deletedBytes += tempCleanup.freedBytes;
      for (const basePath of await this.logicalSessionBases(directory)) {
        if (this.protectedSessionBases(options.keepPaths).has(basePath)) continue;
        try {
          const resolved = await resolveSessionPath(basePath);
          const stat = await fs.stat(resolved);
          if (stat.mtimeMs >= coldCutoff || resolved.endsWith(".jsonl.gz")) continue;
          const archived = await archiveColdSession(resolved);
          if (!archived.archived) continue;
          metrics.archivedFiles += 1;
          metrics.archivedSourceBytes += archived.sourceBytes;
          metrics.archivedBytes += archived.archiveBytes;
          metrics.bytesSaved += archived.bytesSaved;
          metrics.truncatedToolTexts += archived.truncatedToolTexts;
          metrics.externalizedMedia += archived.externalizedMedia;
          metrics.omittedPathMedia += archived.omittedPathMedia;
          metrics.removedDisplayItems += archived.removedDisplayItems;
        } catch (error) {
          metrics.failures += 1;
          log("WARN", "session", "Cold session maintenance failed", {
            path: basePath,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return metrics;
  }

  async appendEntry(sessionPath: string, entry: SessionEntry): Promise<void> {
    try {
      // Persist a sanitized, bounded clone. The live conversation remains
      // untouched so the current turn keeps full tool output and media.
      const safeEntry = redactValue(entry, { secrets: environmentSecrets(process.env) });
      const writablePath = await thawSessionArchive(sessionPath);
      const normalized = await normalizeSessionEntryForStorage(safeEntry, writablePath);
      if (normalized === null) return;
      await fs.appendFile(writablePath, `${JSON.stringify(normalized)}\n`, "utf-8");
    } catch (error) {
      this.handlePersistError(error, "appendEntry");
    }
  }

  async appendTurnMetric(sessionPath: string, payload: TurnMetricPayload): Promise<void> {
    const entry: CustomEntry = {
      type: "custom",
      kind: TURN_METRIC_CUSTOM_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    await this.appendEntry(sessionPath, entry);
  }

  async updateLeaf(sessionPath: string, leafId: string): Promise<void> {
    try {
      const writablePath = await thawSessionArchive(sessionPath);
      await this.updateLeafUnsafe(writablePath, leafId);
    } catch (error) {
      this.handlePersistError(error, "updateLeaf");
    }
  }

  private async updateLeafUnsafe(sessionPath: string, leafId: string): Promise<void> {
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

  /** Read all persisted Ken turns in file order. Returns them regardless of
   *  branch (Ken turns are not chained into the DAG), validated + normalized. */
  getKenTurns(entries: SessionEntry[]): KenTurnPayload[] {
    return entries.flatMap((entry): KenTurnPayload[] => {
      if (entry.type !== "custom" || entry.kind !== KEN_TURN_CUSTOM_KIND) return [];
      const p = entry.data as Partial<KenTurnPayload> | undefined;
      if (p?.version === 1 && typeof p.question === "string" && typeof p.reply === "string") {
        return [
          {
            version: 1,
            question: p.question,
            reply: p.reply,
            afterMessageCount: typeof p.afterMessageCount === "number" ? p.afterMessageCount : 0,
          },
        ];
      }
      return [];
    });
  }

  /** Read all persisted app transcript markers in file order, validated +
   *  normalized (same not-on-the-DAG treatment as Ken turns). */
  getAppMarkers(entries: SessionEntry[]): AppMarkerPayload[] {
    return entries.flatMap((entry): AppMarkerPayload[] => {
      if (entry.type !== "custom" || entry.kind !== APP_MARKER_CUSTOM_KIND) return [];
      const p = entry.data as Partial<AppMarkerPayload> | undefined;
      const kind = p?.kind;
      if (
        p?.version === 1 &&
        (kind === "plan" ||
          kind === "task" ||
          kind === "error" ||
          kind === "user_hint" ||
          kind === "compaction" ||
          kind === "agent_handoff")
      ) {
        return [
          {
            version: 1,
            kind,
            afterMessageCount: typeof p.afterMessageCount === "number" ? p.afterMessageCount : 0,
            data: typeof p.data === "object" && p.data !== null ? p.data : {},
          },
        ];
      }
      return [];
    });
  }

  /** Read validated per-turn usage and timing records in file order. */
  getTurnMetrics(entries: SessionEntry[]): TurnMetricPayload[] {
    return entries.flatMap((entry): TurnMetricPayload[] => {
      if (entry.type !== "custom" || entry.kind !== TURN_METRIC_CUSTOM_KIND) return [];
      const metric = parseTurnMetric(entry.data);
      return metric ? [metric] : [];
    });
  }

  /** Read all persisted autopilot markers in file order, validated + normalized
   *  (same not-on-the-DAG treatment as Ken turns). */
  getAutopilotMarkers(entries: SessionEntry[]): AutopilotMarkerPayload[] {
    return entries.flatMap((entry): AutopilotMarkerPayload[] => {
      if (entry.type !== "custom" || entry.kind !== AUTOPILOT_MARKER_CUSTOM_KIND) return [];
      const p = entry.data as Partial<AutopilotMarkerPayload> | undefined;
      const phase = p?.phase;
      if (
        p?.version === 1 &&
        (phase === "prompted" ||
          phase === "done" ||
          phase === "human" ||
          phase === "capped" ||
          phase === "plan_approved")
      ) {
        return [
          {
            version: 1,
            phase,
            ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
            ...(typeof p.body === "string" ? { body: p.body } : {}),
            afterMessageCount: typeof p.afterMessageCount === "number" ? p.afterMessageCount : 0,
          },
        ];
      }
      return [];
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
