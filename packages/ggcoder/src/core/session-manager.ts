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
import { getUserSessionPrompt } from "./session-preview.js";
import type { CompletedItem } from "../ui/app-items.js";
import { canonicalProjectKey } from "../project-notes-repository.js";
import {
  ACTIVE_PHASE_CONTEXT_KIND,
  parseActivePhaseContext,
  type ActivePhaseContextV1,
} from "../phase-context.js";
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
  /** Read-only: branch messages that preceded this entry in FILE order. Never
   *  persisted — see {@link RecordedPosition}. */
  recordedAfterMessageCount?: number;
}

/**
 * Read-time position rescue for transcript markers.
 *
 * `afterMessageCount` is authoritative, but historical sessions were rewritten
 * by compaction without rebasing it (markers were re-persisted carrying indices
 * from the much longer pre-compaction transcript). Those anchors then replay far
 * too late or past the end — the "everything bunched at the bottom" symptom.
 *
 * File order gives an independent, always-in-range estimate: the number of
 * branch messages already written when the marker line was appended. It's only
 * consulted when the stored anchor is out of range, so healthy sessions are
 * untouched.
 */
export interface RecordedPosition {
  recordedAfterMessageCount?: number;
}

/** Custom-entry kind for an autopilot verdict marker. Mirrors `ken_turn`:
 *  persisted as a `custom` entry with `parentId: null` so it's never on the
 *  message DAG (GG Coder never sees it) but survives resume/compaction and
 *  interleaves back into the transcript via `afterMessageCount`. Covers all
 *  four terminal/near-terminal autopilot markers so a resumed session renders
 *  the exact same Ken bubble the live run showed — never the raw verdict
 *  keyword (e.g. `ALL_CLEAR`) the model actually replied with. */
export const AUTOPILOT_MARKER_CUSTOM_KIND = "autopilot_marker";

export interface AutopilotMarkerPayload extends RecordedPosition {
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

export interface AppMarkerPayload extends RecordedPosition {
  version: 1;
  kind:
    | "plan"
    | "task"
    | "error"
    | "user_hint"
    | "compaction"
    | "agent_handoff"
    /** Mid-session model/provider change; `data` carries { from, to, provider }. */
    | "model_switch"
    /** Transcript imported from another agent; `data` carries
     *  { source, sourcePath, messageCount, dropped }. Import is lossy, so this
     *  marker is the record of what the imported thread is missing. */
    | "import"
    /** A run that opened the journal and never closed it — the process died
     *  mid-run. `data` carries { generation, startedAt }. Surfaced so the user
     *  can review what the run's tools already changed; never auto-resumed. */
    | "interrupted_run";
  afterMessageCount: number;
  /** Kind-specific display fields (reason/title/headline/kenSent/counts/…). */
  data: Record<string, unknown>;
}

/**
 * Run journal — a matched pair of custom entries bracketing every provider run.
 *
 * Same not-on-the-DAG treatment as Ken turns (`parentId: null`): the model never
 * sees them, and they can't race the message branch's leaf pointer. A
 * `run_started` with no matching `run_finished` is the on-disk signature of a
 * run that died mid-flight — the host surfaces it on load instead of silently
 * resuming work whose tools already half-mutated the repo.
 *
 * `generation` is the `RunLifecycle` generation, so the pairing inherits that
 * class's generation-safety: a stale run cannot close a newer one's journal.
 */
export const RUN_STARTED_CUSTOM_KIND = "run_started";
export const RUN_FINISHED_CUSTOM_KIND = "run_finished";

export type RunOutcome = "completed" | "failed" | "aborted";

export interface RunStartedPayload {
  version: 1;
  generation: number;
  startedAt: string;
  /** Non-system message count when the run began, for locating it in the transcript. */
  afterMessageCount: number;
}

export interface RunFinishedPayload {
  version: 1;
  generation: number;
  outcome: RunOutcome;
}

/** One run as reconstructed from the journal. `outcome` is undefined if unfinished. */
export interface RunJournalEntry {
  generation: number;
  startedAt: string;
  afterMessageCount: number;
  outcome?: RunOutcome;
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
  /** Monotonic physical checkpoint number; legacy and ordinary sessions are 0. */
  generation?: number;
  /** Physical checkpoint compacted to create this file. */
  parentSessionId?: string;
  /** SHA-256 of the non-system source messages compacted into this checkpoint. */
  sourceFingerprint?: string;
  /** Visible retained-tail size at checkpoint creation; later appends are outside this boundary. */
  retainedMessageCount?: number;
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
  /**
   * First user-authored prompt, for use as a human title.
   *
   * Filled during the single pass `list()` already makes over each file, so a
   * caller that needs titles — a session browser, a phone — does not have to
   * reopen all of them. Undefined when the session has no user prompt of its
   * own (empty, or only compaction/autopilot injections).
   */
  preview?: string;
}

/**
 * Everything a session browser needs, at a fraction of the cost of {@link SessionInfo}.
 *
 * {@link SessionManager.list} parses every line of every session file to count
 * messages — ~450 MB of JSON (some gzipped) on a well-used machine, several
 * seconds per call. A summary reads only the header and the first user prompt,
 * and takes `lastActivity` from the file's mtime (session files are
 * append-only, so mtime IS the last activity). That is the difference between
 * a phone waiting seconds for its session list and not noticing the wait.
 *
 * The trade: no exact `messageCount`, only `hasMessages`. Callers that need
 * counts keep using {@link SessionManager.list}.
 */
export interface SessionSummary {
  id: string;
  path: string;
  timestamp: string;
  /** File mtime — the last append, i.e. the last activity. */
  lastActivity: string;
  cwd: string;
  hasMessages: boolean;
  /** Same sourcing rules as {@link SessionInfo.preview}. */
  preview?: string;
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

export interface CompactionAttemptState {
  fingerprint: string;
  policyKey: string;
  outcome: "success" | "failed" | "noop";
  checkpointId?: string;
  updatedAt: string;
  expiresAt?: string;
}

interface CompactionLeaseOwner {
  token: string;
  pid: number;
  createdAt: string;
}

const COMPACTION_COORDINATION_DIR = ".compaction-coordination";
const CORRUPT_LEASE_STALE_MS = 60_000;
const LEASE_POLL_MS = 50;

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

export class RequiredSessionPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RequiredSessionPersistenceError";
  }
}

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

  private coordinationKey(conversationId: string): string {
    return crypto.createHash("sha256").update(conversationId).digest("hex");
  }

  private coordinationRoot(): string {
    return path.join(this.sessionsDir, COMPACTION_COORDINATION_DIR);
  }

  private async leaseOwner(lockPath: string): Promise<CompactionLeaseOwner | null> {
    try {
      const parsed = JSON.parse(
        await fs.readFile(path.join(lockPath, "owner.json"), "utf-8"),
      ) as Partial<CompactionLeaseOwner>;
      return typeof parsed.token === "string" &&
        typeof parsed.pid === "number" &&
        typeof parsed.createdAt === "string"
        ? (parsed as CompactionLeaseOwner)
        : null;
    } catch {
      return null;
    }
  }

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async waitForLease(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(finish, LEASE_POLL_MS);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer.unref?.();
    });
  }

  /** Serialize compaction work across processes for one logical conversation. */
  async withCompactionLease<T>(
    conversationId: string,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const root = this.coordinationRoot();
    await fs.mkdir(root, { recursive: true });
    const lockPath = path.join(root, `${this.coordinationKey(conversationId)}.lock`);
    const token = crypto.randomUUID();

    while (true) {
      try {
        await fs.mkdir(lockPath);
        const owner: CompactionLeaseOwner = {
          token,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        };
        await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner), "utf-8");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = await this.leaseOwner(lockPath);
        const stat = await fs.stat(lockPath).catch(() => null);
        const corruptAndOld =
          !owner && stat !== null && Date.now() - stat.mtimeMs > CORRUPT_LEASE_STALE_MS;
        const deadOwner = owner !== null && !this.processIsAlive(owner.pid);
        if (deadOwner || corruptAndOld) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
        await this.waitForLease(signal);
      }
    }

    try {
      return await work();
    } finally {
      const owner = await this.leaseOwner(lockPath);
      if (owner?.token === token) await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  async readCompactionAttemptState(conversationId: string): Promise<CompactionAttemptState | null> {
    const statePath = path.join(
      this.coordinationRoot(),
      `${this.coordinationKey(conversationId)}.state.json`,
    );
    try {
      const state = JSON.parse(await fs.readFile(statePath, "utf-8")) as CompactionAttemptState;
      return typeof state.fingerprint === "string" &&
        typeof state.policyKey === "string" &&
        ["success", "failed", "noop"].includes(state.outcome) &&
        typeof state.updatedAt === "string"
        ? state
        : null;
    } catch {
      return null;
    }
  }

  async writeCompactionAttemptState(
    conversationId: string,
    state: CompactionAttemptState,
  ): Promise<void> {
    const root = this.coordinationRoot();
    await fs.mkdir(root, { recursive: true });
    const statePath = path.join(root, `${this.coordinationKey(conversationId)}.state.json`);
    const temporaryPath = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(state), "utf-8");
    await fs.rename(temporaryPath, statePath);
  }

  /**
   * Best-effort transcript persistence reports disk-full (ENOSPC), permission,
   * and quota errors once per code while allowing the live session to continue.
   * Required phase metadata uses the same reporting hook but rejects its caller.
   */
  private handlePersistError(error: unknown, op: string, required = false): void {
    const err = error as NodeJS.ErrnoException;
    const code = err?.code ?? "UNKNOWN";
    if (this.warnedPersistCodes.has(code)) return;
    this.warnedPersistCodes.add(code);
    log(
      required ? "ERROR" : "WARN",
      "session",
      required
        ? `Required session persistence failed (${op})`
        : `Session persistence failed (${op}); continuing without saving`,
      {
        code,
        message: err?.message ?? String(error),
      },
    );
    this.onPersistError?.(err);
  }

  private dirForCwd(cwd: string): string {
    return path.join(this.sessionsDir, encodeCwd(cwd));
  }

  async create(
    cwd: string,
    provider: Provider,
    model: string,
    options?: {
      conversationId?: string;
      preview?: string;
      generation?: number;
      parentSessionId?: string;
      sourceFingerprint?: string;
      retainedMessageCount?: number;
    },
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
      generation: options?.generation ?? 0,
      ...(options?.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options?.sourceFingerprint ? { sourceFingerprint: options.sourceFingerprint } : {}),
      ...(typeof options?.retainedMessageCount === "number"
        ? { retainedMessageCount: options.retainedMessageCount }
        : {}),
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

  async load(
    sessionPath: string,
    expected?: { projectKey?: string },
  ): Promise<{
    header: SessionHeader;
    entries: SessionEntry[];
    path: string;
  }> {
    // Resuming is a write operation, so transparently thaw a gzip archive and
    // return the effective plain path every future append must use.
    const canonicalPath = (await this.resolveCanonicalSession(sessionPath)) ?? sessionPath;
    const effectivePath = await thawSessionArchive(canonicalPath);
    const loaded = await this.loadPhysicalCheckpoint(effectivePath);
    const storedProjectKey = canonicalProjectKey(loaded.header.cwd);
    if (expected?.projectKey !== undefined && storedProjectKey !== expected.projectKey) {
      throw new Error(
        `Cannot resume a session from another project (requested "${expected.projectKey}", session belongs to "${storedProjectKey}").`,
      );
    }
    return loaded;
  }

  /**
   * Load the contiguous checkpoint ancestry ending at the canonical newest file.
   *
   * The returned order is oldest → newest. A missing, corrupt, cyclic, or
   * cross-conversation parent stops traversal at the oldest readable checkpoint,
   * allowing display callers to retain that checkpoint's compaction summary as a
   * fallback. Parent archives are read in place rather than thawed because this
   * API is for history reconstruction, not resuming writes.
   */
  async loadCheckpointChain(
    sessionPath: string,
  ): Promise<Array<{ header: SessionHeader; entries: SessionEntry[]; path: string }>> {
    const requestedSummary = await this.readSessionSummary(sessionPath);
    // A resumed session can compact under a different cwd than its parent (for
    // example, a remote ACP client reconnecting from another workspace). The
    // physical ancestry is therefore machine-wide, not confined to the newest
    // checkpoint's encoded-cwd directory.
    const directories = await this.storageDirectories();
    const candidates = (
      await Promise.all(directories.map((directory) => this.sessionCandidates(directory)))
    ).flat();
    const summaries = (
      await Promise.all(candidates.map((candidate) => this.readSessionSummary(candidate)))
    ).filter(
      (summary): summary is SessionSummary & { conversationId: string; generation: number } =>
        summary !== null,
    );
    const requestedIdentity =
      requestedSummary?.conversationId ??
      summaries.find((summary) => summary.id === sessionPath)?.conversationId;
    const newestSummary = requestedIdentity
      ? summaries
          .filter((summary) => summary.conversationId === requestedIdentity)
          .sort((left, right) => SessionManager.compareCheckpoints(right, left))[0]
      : undefined;
    const newestPath = newestSummary?.path ?? sessionPath;
    // Resuming the newest checkpoint is a write operation, so thaw only that
    // generation. Historical parents stay archived and read-only.
    const newest = await this.loadPhysicalCheckpoint(await thawSessionArchive(newestPath));
    const newestConversationId = newest.header.conversationId ?? newest.header.id;
    const byPhysicalId = new Map(summaries.map((summary) => [summary.id, summary.path]));
    const newestResolvedPath = path.resolve(newest.path);
    const visited = new Set<string>([newest.header.id]);
    const chain = [newest];
    let current = newest;

    while (current.header.parentSessionId) {
      const parentId = current.header.parentSessionId;
      if (visited.has(parentId)) break;
      const parentPath = byPhysicalId.get(parentId);
      if (!parentPath || path.resolve(parentPath) === newestResolvedPath) break;

      try {
        const parent = await this.loadPhysicalCheckpoint(parentPath, true);
        if ((parent.header.conversationId ?? parent.header.id) !== newestConversationId) break;
        visited.add(parentId);
        chain.unshift(parent);
        current = parent;
      } catch {
        break;
      }
    }

    return chain;
  }

  private async loadPhysicalCheckpoint(
    sessionPath: string,
    rejectMalformedLines = false,
  ): Promise<{
    header: SessionHeader;
    entries: SessionEntry[];
    path: string;
  }> {
    const effectivePath = await resolveSessionPath(sessionPath);
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
              generation: 0,
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
        entries.push(entry);
      } catch (error) {
        if (rejectMalformedLines) throw error;
        // Skip malformed JSON lines — cold migration preserves their raw bytes
        // so a future recovery tool still has a chance to repair them.
      }
    }

    if (!header) {
      throw new Error(`Invalid session file: no header found in ${sessionPath}`);
    }
    const hydratedEntries: SessionEntry[] = [];
    for (const entry of entries) {
      try {
        hydratedEntries.push(await hydrateSessionEntry(entry, effectivePath));
      } catch (error) {
        if (rejectMalformedLines) throw error;
        // Preserve readable entries around structurally malformed records.
      }
    }
    return { header, entries: hydratedEntries, path: effectivePath };
  }

  private async readSessionInfo(
    candidatePath: string,
  ): Promise<(SessionInfo & { conversationId: string; generation: number }) | null> {
    try {
      const resolvedPath = await resolveSessionPath(candidatePath);
      const { stream } = await openSessionReadStream(resolvedPath);
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let first: SessionLine | null = null;
      let messageCount = 0;
      let lastActivity: string | null = null;
      let preview: string | undefined;
      for await (const line of rl) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as SessionLine;
          if (!first) {
            if (parsed.type !== "session") break;
            first = parsed;
            // v2 headers usually carry the preview already; when they do,
            // nothing below has to look for one.
            preview = (parsed as SessionHeader).preview?.trim() || undefined;
          } else if (parsed.type === "message") {
            messageCount += 1;
            if (parsed.timestamp) lastActivity = parsed.timestamp;
            // Recover a title for the sessions whose header predates `preview`.
            // Free here: this pass already reads every line. `getUserSessionPrompt`
            // rejects compaction summaries and autopilot/status injections, so a
            // session is titled by what its user actually asked.
            if (!preview && parsed.message?.role === "user") {
              preview =
                getUserSessionPrompt(parsed.message.content, parsed.message.provenance)
                  ?.replace(/\s+/g, " ")
                  .trim() || undefined;
            }
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
        generation:
          (first as SessionHeader).version === 2 ? ((first as SessionHeader).generation ?? 0) : 0,
        path: resolvedPath,
        timestamp: first.timestamp,
        lastActivity: lastActivity ?? first.timestamp,
        cwd: first.cwd,
        messageCount,
        ...(preview ? { preview: preview.slice(0, 100) } : {}),
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

  /**
   * Read just enough of a session file to summarize it.
   *
   * Stops at the first user prompt (or the first message, when the header
   * already carries a preview) instead of parsing the whole transcript — this
   * is what makes listing every session on the machine cheap. Files whose
   * first user message is far down (long tool runs before the user speaks)
   * are capped rather than allowed to stall the list.
   */
  private async readSessionSummary(
    candidatePath: string,
  ): Promise<(SessionSummary & { conversationId: string; generation: number }) | null> {
    try {
      const resolvedPath = await resolveSessionPath(candidatePath);
      const { stream } = await openSessionReadStream(resolvedPath);
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      let first: SessionLine | null = null;
      let preview: string | undefined;
      let hasMessages = false;
      let lines = 0;
      const MAX_SCAN_LINES = 500;
      try {
        for await (const line of rl) {
          if (!line) continue;
          if (++lines > MAX_SCAN_LINES) break;
          try {
            const parsed = JSON.parse(line) as SessionLine;
            if (!first) {
              if (parsed.type !== "session") break;
              first = parsed;
              preview = (parsed as SessionHeader).preview?.trim() || undefined;
            } else if (parsed.type === "message") {
              hasMessages = true;
              // Header preview + any message: done. Otherwise keep scanning for
              // the first user-authored prompt to title by.
              if (preview) break;
              if (parsed.message?.role === "user") {
                preview =
                  getUserSessionPrompt(parsed.message.content, parsed.message.provenance)
                    ?.replace(/\s+/g, " ")
                    .trim() || undefined;
                if (preview) break;
              }
            }
          } catch {
            // Skip malformed lines while retaining readable entries around them.
          }
        }
      } finally {
        rl.close();
        stream.destroy();
      }
      if (!first || first.type !== "session") return null;
      const stat = await fs.stat(resolvedPath);
      return {
        id: first.id,
        conversationId:
          (first as SessionHeader).version === 2
            ? ((first as SessionHeader).conversationId ?? first.id)
            : first.id,
        generation:
          (first as SessionHeader).version === 2 ? ((first as SessionHeader).generation ?? 0) : 0,
        path: resolvedPath,
        timestamp: first.timestamp,
        lastActivity: stat.mtime.toISOString(),
        cwd: first.cwd,
        hasMessages,
        ...(preview ? { preview: preview.slice(0, 100) } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Keep the newest file per conversation and sort newest first.
   *
   * A conversation can span several files (compaction forks a fresh one), so
   * without this collapse a resumed thread appears once per checkpoint.
   */
  private static dedupeByConversation<
    T extends {
      path: string;
      lastActivity: string;
      timestamp: string;
    },
  >(summaries: ((T & { conversationId: string; generation: number }) | null)[]): T[] {
    const byConversation = new Map<string, T & { conversationId: string; generation: number }>();
    const seenResolvedPaths = new Set<string>();
    for (const summary of summaries) {
      if (!summary || seenResolvedPaths.has(summary.path)) continue;
      seenResolvedPaths.add(summary.path);
      const current = byConversation.get(summary.conversationId);
      if (!current || SessionManager.compareCheckpoints(summary, current) > 0) {
        byConversation.set(summary.conversationId, summary);
      }
    }
    return [...byConversation.values()]
      .sort(
        (a, b) =>
          b.lastActivity.localeCompare(a.lastActivity) ||
          b.timestamp.localeCompare(a.timestamp) ||
          b.path.localeCompare(a.path),
      )
      .map(
        ({ conversationId: _conversationId, generation: _generation, ...info }) =>
          info as unknown as T,
      );
  }

  private static compareCheckpoints(
    left: { generation?: number; lastActivity: string; timestamp: string; path: string },
    right: { generation?: number; lastActivity: string; timestamp: string; path: string },
  ): number {
    return (
      (left.generation ?? 0) - (right.generation ?? 0) ||
      left.lastActivity.localeCompare(right.lastActivity) ||
      left.timestamp.localeCompare(right.timestamp) ||
      left.path.localeCompare(right.path)
    );
  }

  async list(cwd: string): Promise<SessionInfo[]> {
    return this.summarize(await this.sessionCandidates(this.dirForCwd(cwd)));
  }

  /**
   * One project's sessions, newest first, using the early-exit summary read.
   *
   * For callers that render a list rather than exact message counts — on a
   * project with hundreds of sessions this is the difference between instant
   * and a noticeable stall.
   */
  async listSummaries(cwd: string): Promise<SessionSummary[]> {
    const candidates = await this.sessionCandidates(this.dirForCwd(cwd));
    const summaries = await Promise.all(candidates.map((file) => this.readSessionSummary(file)));
    return SessionManager.dedupeByConversation(summaries);
  }

  /**
   * Every session on this machine, across every project, newest first.
   *
   * A remote client is not browsing one checkout the way the TUI is — it is
   * asking "what have I been working on?", and the answer spans projects. Each
   * entry carries its own `cwd`, so the caller can group by project. Uses the
   * early-exit summary read, because "every session on the machine" is exactly
   * where a full parse of each file becomes a multi-second stall.
   */
  async listAllSummaries(): Promise<SessionSummary[]> {
    const directories = await this.storageDirectories();
    const candidates = await Promise.all(
      directories.map((directory) => this.sessionCandidates(directory)),
    );
    const summaries = await Promise.all(
      candidates.flat().map((file) => this.readSessionSummary(file)),
    );
    return SessionManager.dedupeByConversation(summaries);
  }

  /**
   * Summarize session files, keeping the newest file per conversation.
   *
   * A conversation can span several files (compaction forks a fresh one), so
   * without this collapse a resumed thread appears once per checkpoint.
   */
  private async summarize(candidates: string[]): Promise<SessionInfo[]> {
    const summaries = await Promise.all(candidates.map((file) => this.readSessionInfo(file)));
    return SessionManager.dedupeByConversation(summaries);
  }

  async getMostRecent(cwd: string): Promise<string | null> {
    const sessions = await this.list(cwd);
    return sessions.find((session) => session.messageCount > 0)?.path ?? null;
  }

  /** Resolve an id, conversation id, or stale physical path to the newest checkpoint. */
  async resolveCanonicalSession(requested: string, cwd?: string): Promise<string | null> {
    const looksLikePath =
      path.isAbsolute(requested) || requested.includes(path.sep) || isSessionPath(requested);
    let candidates: string[];
    let requestedSummary: (SessionSummary & { conversationId: string; generation: number }) | null =
      null;

    if (looksLikePath) {
      requestedSummary = await this.readSessionSummary(requested);
      if (!requestedSummary) return null;
      candidates = await this.sessionCandidates(path.dirname(requestedSummary.path));
    } else if (cwd) {
      candidates = await this.sessionCandidates(this.dirForCwd(cwd));
    } else {
      const directories = await this.storageDirectories();
      candidates = (
        await Promise.all(directories.map((dir) => this.sessionCandidates(dir)))
      ).flat();
    }

    const summaries = (
      await Promise.all(candidates.map((candidate) => this.readSessionSummary(candidate)))
    ).filter(
      (summary): summary is SessionSummary & { conversationId: string; generation: number } =>
        summary !== null,
    );
    if (requestedSummary && !summaries.some((summary) => summary.path === requestedSummary?.path)) {
      summaries.push(requestedSummary);
    }

    const identityMatches = requestedSummary
      ? [requestedSummary]
      : summaries.filter(
          (summary) => summary.id === requested || summary.conversationId === requested,
        );
    if (identityMatches.length === 0) return null;
    const requestedIdentity = identityMatches.sort((a, b) =>
      SessionManager.compareCheckpoints(b, a),
    )[0]!.conversationId;
    const checkpoints = summaries.filter((summary) => summary.conversationId === requestedIdentity);
    return (
      checkpoints.sort((a, b) => SessionManager.compareCheckpoints(b, a))[0]?.path ??
      identityMatches[0]!.path
    );
  }

  async findById(cwd: string, sessionId: string): Promise<string | null> {
    return this.resolveCanonicalSession(sessionId, cwd);
  }

  /** Locate and canonicalize a session identity across every project directory. */
  async findAnyById(sessionId: string, cwd?: string): Promise<string | null> {
    if (cwd) {
      const local = await this.resolveCanonicalSession(sessionId, cwd);
      if (local) return local;
    }
    return this.resolveCanonicalSession(sessionId);
  }

  private async storageDirectories(): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
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

  private async appendEntryUnsafe(sessionPath: string, entry: SessionEntry): Promise<boolean> {
    // Persist a sanitized, bounded clone. The live conversation remains
    // untouched so the current turn keeps full tool output and media.
    const safeEntry = redactValue(entry, { secrets: environmentSecrets(process.env) });
    const writablePath = await thawSessionArchive(sessionPath);
    const normalized = await normalizeSessionEntryForStorage(safeEntry, writablePath);
    if (normalized === null) return false;
    await fs.appendFile(writablePath, `${JSON.stringify(normalized)}\n`, "utf-8");
    return true;
  }

  async appendEntry(sessionPath: string, entry: SessionEntry): Promise<void> {
    try {
      await this.appendEntryUnsafe(sessionPath, entry);
    } catch (error) {
      this.handlePersistError(error, "appendEntry");
    }
  }

  async appendRequiredEntry(sessionPath: string, entry: SessionEntry): Promise<void> {
    if (entry.type !== "custom" || entry.kind !== ACTIVE_PHASE_CONTEXT_KIND) {
      throw new Error("Only active phase context metadata may use required session persistence.");
    }
    try {
      const appended = await this.appendEntryUnsafe(sessionPath, entry);
      if (!appended) throw new Error("Required active phase context metadata was omitted.");
    } catch (error) {
      this.handlePersistError(error, "appendRequiredEntry", true);
      throw new RequiredSessionPersistenceError(
        "Failed to persist required active phase context.",
        { cause: error },
      );
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

  /** Open the run journal for one `RunLifecycle` generation. */
  async appendRunStarted(sessionPath: string, payload: RunStartedPayload): Promise<void> {
    await this.appendEntry(sessionPath, {
      type: "custom",
      kind: RUN_STARTED_CUSTOM_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    });
  }

  /** Close the run journal for one generation. Its absence marks a crashed run. */
  async appendRunFinished(sessionPath: string, payload: RunFinishedPayload): Promise<void> {
    await this.appendEntry(sessionPath, {
      type: "custom",
      kind: RUN_FINISHED_CUSTOM_KIND,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    });
  }

  /**
   * Reconstruct the run journal in file order, pairing each `run_started` with
   * the `run_finished` carrying the same generation.
   *
   * Generations are NOT unique across a session file. `RunLifecycle` counts
   * from zero per instance, and a resumed session builds a fresh one — so the
   * first run after every app restart is generation 1 again. Pairing therefore
   * tracks only the runs still OPEN: a `run_finished` closes its generation and
   * releases the number, and a later `run_started` reusing it opens a new run.
   *
   * Without that release, a crash in a resumed session was invisible: the
   * reused `run_started` looked like a duplicate and was dropped, which is
   * exactly the case this journal exists to catch.
   *
   * A repeat `run_started` for a generation that is still open IS ignored, so a
   * truncated or replayed log reports one unfinished run — never a phantom pile.
   */
  getRunJournal(entries: SessionEntry[]): RunJournalEntry[] {
    const runs: RunJournalEntry[] = [];
    const openByGeneration = new Map<number, RunJournalEntry>();
    for (const entry of entries) {
      if (entry.type !== "custom") continue;
      if (entry.kind === RUN_STARTED_CUSTOM_KIND) {
        const p = entry.data as Partial<RunStartedPayload> | undefined;
        if (p?.version !== 1 || typeof p.generation !== "number") continue;
        if (openByGeneration.has(p.generation)) continue;
        const run: RunJournalEntry = {
          generation: p.generation,
          startedAt: typeof p.startedAt === "string" ? p.startedAt : entry.timestamp,
          afterMessageCount: typeof p.afterMessageCount === "number" ? p.afterMessageCount : 0,
        };
        openByGeneration.set(p.generation, run);
        runs.push(run);
        continue;
      }
      if (entry.kind === RUN_FINISHED_CUSTOM_KIND) {
        const p = entry.data as Partial<RunFinishedPayload> | undefined;
        if (p?.version !== 1 || typeof p.generation !== "number") continue;
        const run = openByGeneration.get(p.generation);
        if (!run || !p.outcome) continue;
        run.outcome = p.outcome;
        // Closed — the number is free for the next app run to reuse.
        openByGeneration.delete(p.generation);
      }
    }
    return runs;
  }

  /** Runs that opened the journal but never closed it — i.e. crashed mid-flight. */
  getUnfinishedRuns(entries: SessionEntry[]): RunJournalEntry[] {
    return this.getRunJournal(entries).filter((run) => run.outcome === undefined);
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

  /**
   * Walk entries in file order, tracking how many branch messages have been
   * written so far, and hand each custom entry that count.
   */
  private mapCustomEntriesInFileOrder<T>(
    entries: SessionEntry[],
    leafId: string | null | undefined,
    project: (entry: SessionEntry & { type: "custom" }, recordedAfterMessageCount: number) => T[],
  ): T[] {
    const onBranch = leafId
      ? new Set(this.getBranch(entries, leafId).map((entry) => entry.id))
      : new Set(entries.map((entry) => entry.id));
    const output: T[] = [];
    let messagesSoFar = 0;
    for (const entry of entries) {
      if (entry.type === "message") {
        if (onBranch.has(entry.id) && entry.message.role !== "system") messagesSoFar += 1;
        continue;
      }
      if (entry.type !== "custom") continue;
      output.push(...project(entry, messagesSoFar));
    }
    return output;
  }

  /** Return the last valid durable active-phase record. */
  getActivePhaseContext(
    entries: SessionEntry[],
    expected?: { projectKey?: string; phaseId?: string },
  ): ActivePhaseContextV1 | undefined {
    let activeContext: ActivePhaseContextV1 | undefined;
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.kind !== ACTIVE_PHASE_CONTEXT_KIND) continue;
      const parsed = parseActivePhaseContext(entry.data, expected);
      if (parsed) activeContext = parsed;
      else {
        log("WARN", "session", "Ignoring malformed active phase context metadata", {
          entryId: entry.id,
        });
      }
    }
    return activeContext;
  }

  /** Read all persisted Ken turns in file order. Returns them regardless of
   *  branch (Ken turns are not chained into the DAG), validated + normalized. */
  getKenTurns(entries: SessionEntry[], leafId?: string | null): KenTurnPayload[] {
    return this.mapCustomEntriesInFileOrder<KenTurnPayload>(
      entries,
      leafId,
      (entry, recordedAfterMessageCount) => {
        if (entry.kind !== KEN_TURN_CUSTOM_KIND) return [];
        const p = entry.data as Partial<KenTurnPayload> | undefined;
        if (p?.version === 1 && typeof p.question === "string" && typeof p.reply === "string") {
          return [
            {
              version: 1,
              question: p.question,
              reply: p.reply,
              afterMessageCount: typeof p.afterMessageCount === "number" ? p.afterMessageCount : 0,
              recordedAfterMessageCount,
            },
          ];
        }
        return [];
      },
    );
  }

  /** Read all persisted app transcript markers in file order, validated +
   *  normalized (same not-on-the-DAG treatment as Ken turns). */
  getAppMarkers(entries: SessionEntry[], leafId?: string | null): AppMarkerPayload[] {
    return this.mapCustomEntriesInFileOrder<AppMarkerPayload>(
      entries,
      leafId,
      (entry, recordedAfterMessageCount) => {
        if (entry.kind !== APP_MARKER_CUSTOM_KIND) return [];
        const p = entry.data as Partial<AppMarkerPayload> | undefined;
        const kind = p?.kind;
        if (
          p?.version === 1 &&
          (kind === "plan" ||
            kind === "task" ||
            kind === "error" ||
            kind === "user_hint" ||
            kind === "compaction" ||
            kind === "agent_handoff" ||
            kind === "model_switch" ||
            kind === "import" ||
            kind === "interrupted_run")
        ) {
          return [
            {
              version: 1,
              kind,
              afterMessageCount: typeof p.afterMessageCount === "number" ? p.afterMessageCount : 0,
              data: typeof p.data === "object" && p.data !== null ? p.data : {},
              recordedAfterMessageCount,
            },
          ];
        }
        return [];
      },
    );
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
  getAutopilotMarkers(entries: SessionEntry[], leafId?: string | null): AutopilotMarkerPayload[] {
    return this.mapCustomEntriesInFileOrder<AutopilotMarkerPayload>(
      entries,
      leafId,
      (entry, recordedAfterMessageCount) => {
        if (entry.kind !== AUTOPILOT_MARKER_CUSTOM_KIND) return [];
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
              recordedAfterMessageCount,
            },
          ];
        }
        return [];
      },
    );
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
