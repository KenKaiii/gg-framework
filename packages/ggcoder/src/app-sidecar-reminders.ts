import { randomUUID } from "node:crypto";
import type http from "node:http";
import {
  AppSidecarJsonBodyError,
  isExactRecord,
  readJsonBody,
  requestPathname,
} from "./app-sidecar-http-json.js";
import { canonicalProjectKey } from "@kenkaiiii/gg-core/project-notes";
import {
  isValidNotesReminderDeliveryPair,
  NOTES_REMINDER_NOTE_MAX_LENGTH,
  type NotesDocumentV3,
  type NotesPhase,
  type NotesReminder,
  type NotesReminderDeliveryChannel,
  type NotesReminderPermission,
  type ProjectNotesReminderDeliveryOutcome,
  type ProjectNotesReminderDeliveryRequest,
  type ProjectNotesRepository,
  type ProjectNotesSnapshot,
} from "./project-notes-repository.js";

export const REMINDER_BACKGROUND_GRACE_MS = 750;
export const REMINDER_LEASE_TTL_MS = 15_000;
export const REMINDER_MAX_TIMER_DELAY_MS = 60_000;
export const REMINDER_REQUEST_BODY_MAX_BYTES = 16 * 1024;
const REMINDER_PHASE_TITLE_MAX_LENGTH = 500;

export interface AppSidecarReminderSession {
  id: string;
  cwd: string;
}

export interface DueReminderOccurrence {
  phase: NotesPhase;
  reminder: NotesReminder;
}

export interface ReservedReminderOccurrence {
  leaseToken: string;
  expiresAt: string;
  phase: Pick<NotesPhase, "id" | "title" | "session">;
  reminder: Pick<NotesReminder, "id" | "occurrenceKey" | "dueAt" | "note">;
}

export type ReminderReserveOutcome =
  | ({ status: "reserved" } & ReservedReminderOccurrence)
  | { status: "deferred"; retryAt: string }
  | { status: "leased" }
  | { status: "none" }
  | { status: "already-delivered" }
  | { status: "missing" }
  | { status: "corrupt" };

export type ReminderClaimOutcome =
  | ProjectNotesReminderDeliveryOutcome
  | { status: "invalid-lease" | "expired-lease" | "wrong-session" };

export type ReminderReleaseOutcome =
  | { status: "released" }
  | { status: "invalid-lease" | "expired-lease" | "wrong-session" };

export interface ReminderClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AppSidecarReminderCoordinatorOptions {
  repository: Pick<ProjectNotesRepository, "load" | "recordReminderDelivery">;
  onReminderDue(projectKey: string): void;
  onCommitted?(snapshot: ProjectNotesSnapshot): void;
  clock?: ReminderClock;
  createToken?: () => string;
  backgroundGraceMs?: number;
  leaseTtlMs?: number;
  maxTimerDelayMs?: number;
  onError?: (error: unknown) => void;
}

interface WatchedProject {
  cwd: string;
  sessionIds: Set<string>;
  snapshot: ProjectNotesSnapshot | null;
  timer: unknown | null;
  backgroundEligibleAt: Map<string, number>;
  signaledOccurrenceKeys: Set<string>;
}

interface ReminderLease {
  token: string;
  sessionId: string;
  projectKey: string;
  cwd: string;
  phaseId: string;
  occurrenceKey: string;
  expiresAt: number;
}

const systemClock: ReminderClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function selectDueReminder(
  document: NotesDocumentV3,
  nowMs: number,
): DueReminderOccurrence | null {
  return (
    document.phases
      .filter((phase) => isEligiblePhase(phase))
      .flatMap((phase) => {
        const reminder = phase.reminder;
        if (
          reminder === null ||
          Date.parse(reminder.dueAt) > nowMs ||
          reminder.lastDelivery?.occurrenceKey === reminder.occurrenceKey
        ) {
          return [];
        }
        return [{ phase, reminder }];
      })
      .sort(compareOccurrences)[0] ?? null
  );
}

function hasDeliveredDueReminder(document: NotesDocumentV3, nowMs: number): boolean {
  return document.phases.some((phase) => {
    const reminder = phase.reminder;
    return (
      isEligiblePhase(phase) &&
      reminder !== null &&
      Date.parse(reminder.dueAt) <= nowMs &&
      reminder.lastDelivery?.occurrenceKey === reminder.occurrenceKey
    );
  });
}

function isEligiblePhase(phase: NotesPhase): boolean {
  return phase.archivedAt === null && phase.status !== "done" && phase.status !== "cancelled";
}

function compareOccurrences(left: DueReminderOccurrence, right: DueReminderOccurrence): number {
  return (
    Date.parse(left.reminder.dueAt) - Date.parse(right.reminder.dueAt) ||
    left.phase.order - right.phase.order ||
    left.reminder.occurrenceKey.localeCompare(right.reminder.occurrenceKey)
  );
}

export class AppSidecarReminderCoordinator {
  private readonly repository: AppSidecarReminderCoordinatorOptions["repository"];
  private readonly onReminderDue: (projectKey: string) => void;
  private readonly onCommitted: ((snapshot: ProjectNotesSnapshot) => void) | undefined;
  private readonly clock: ReminderClock;
  private readonly createToken: () => string;
  private readonly backgroundGraceMs: number;
  private readonly leaseTtlMs: number;
  private readonly maxTimerDelayMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly projects = new Map<string, WatchedProject>();
  private readonly sessions = new Map<string, string>();
  private readonly leases = new Map<string, ReminderLease>();
  private disposed = false;

  constructor(options: AppSidecarReminderCoordinatorOptions) {
    this.repository = options.repository;
    this.onReminderDue = options.onReminderDue;
    this.onCommitted = options.onCommitted;
    this.clock = options.clock ?? systemClock;
    this.createToken = options.createToken ?? randomUUID;
    this.backgroundGraceMs = options.backgroundGraceMs ?? REMINDER_BACKGROUND_GRACE_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? REMINDER_LEASE_TTL_MS;
    this.maxTimerDelayMs = options.maxTimerDelayMs ?? REMINDER_MAX_TIMER_DELAY_MS;
    this.onError = options.onError;
  }

  async watchSession(session: AppSidecarReminderSession): Promise<void> {
    if (this.disposed) return;
    this.unwatchSession(session.id);
    const projectKey = canonicalProjectKey(session.cwd);
    this.sessions.set(session.id, projectKey);
    let project = this.projects.get(projectKey);
    const firstSession = project === undefined;
    if (!project) {
      project = {
        cwd: session.cwd,
        sessionIds: new Set(),
        snapshot: null,
        timer: null,
        backgroundEligibleAt: new Map(),
        signaledOccurrenceKeys: new Set(),
      };
      this.projects.set(projectKey, project);
    }
    project.sessionIds.add(session.id);
    if (!firstSession) return;

    try {
      const loaded = await this.repository.load(session.cwd);
      if (this.disposed || !this.projects.has(projectKey)) return;
      if (loaded.status === "ok") {
        project.snapshot = loaded.snapshot;
        this.schedule(projectKey, project);
      }
    } catch (error) {
      this.onError?.(error);
    }
  }

  unwatchSession(sessionId: string): void {
    const projectKey = this.sessions.get(sessionId);
    if (!projectKey) return;
    this.sessions.delete(sessionId);
    const project = this.projects.get(projectKey);
    if (!project) return;
    project.sessionIds.delete(sessionId);
    for (const [token, lease] of this.leases) {
      if (lease.sessionId === sessionId) this.leases.delete(token);
    }
    if (project.sessionIds.size > 0) return;
    if (project.timer !== null) this.clock.clearTimeout(project.timer);
    for (const [token, lease] of this.leases) {
      if (lease.projectKey === projectKey) this.leases.delete(token);
    }
    this.projects.delete(projectKey);
  }

  observeSnapshot(snapshot: ProjectNotesSnapshot): void {
    const project = this.projects.get(snapshot.projectKey);
    if (!project || this.disposed) return;
    project.snapshot = snapshot;
    this.pruneOccurrenceState(project, snapshot.document);
    this.schedule(snapshot.projectKey, project);
  }

  async reserve(
    session: AppSidecarReminderSession,
    focused: boolean,
  ): Promise<ReminderReserveOutcome> {
    const projectKey = canonicalProjectKey(session.cwd);
    const project = this.projects.get(projectKey);
    if (!project || !project.sessionIds.has(session.id)) return { status: "none" };
    const now = this.clock.now();
    this.pruneExpiredLeases(now);

    const loaded = await this.repository.load(session.cwd);
    if (loaded.status === "missing") return { status: "missing" };
    if (loaded.status === "corrupt") return { status: "corrupt" };
    project.snapshot = loaded.snapshot;
    const occurrence = selectDueReminder(loaded.snapshot.document, now);
    if (!occurrence) {
      this.schedule(projectKey, project);
      return hasDeliveredDueReminder(loaded.snapshot.document, now)
        ? { status: "already-delivered" }
        : { status: "none" };
    }

    if (this.leaseFor(projectKey, occurrence.reminder.occurrenceKey)) {
      return { status: "leased" };
    }

    if (!focused) {
      const graceKey = occurrence.reminder.occurrenceKey;
      let eligibleAt = project.backgroundEligibleAt.get(graceKey);
      if (eligibleAt === undefined) {
        eligibleAt = now + this.backgroundGraceMs;
        project.backgroundEligibleAt.set(graceKey, eligibleAt);
      }
      if (now < eligibleAt) {
        return { status: "deferred", retryAt: new Date(eligibleAt).toISOString() };
      }
    }

    project.backgroundEligibleAt.delete(occurrence.reminder.occurrenceKey);
    const token = this.createToken();
    const expiresAt = now + this.leaseTtlMs;
    this.leases.set(token, {
      token,
      sessionId: session.id,
      projectKey,
      cwd: session.cwd,
      phaseId: occurrence.phase.id,
      occurrenceKey: occurrence.reminder.occurrenceKey,
      expiresAt,
    });
    this.scheduleAt(projectKey, project, expiresAt);
    return {
      status: "reserved",
      leaseToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      phase: {
        id: occurrence.phase.id,
        title: occurrence.phase.title.slice(0, REMINDER_PHASE_TITLE_MAX_LENGTH),
        session: occurrence.phase.session ? { ...occurrence.phase.session } : null,
      },
      reminder: {
        id: occurrence.reminder.id,
        occurrenceKey: occurrence.reminder.occurrenceKey,
        dueAt: occurrence.reminder.dueAt,
        note: occurrence.reminder.note.slice(0, NOTES_REMINDER_NOTE_MAX_LENGTH),
      },
    };
  }

  async claim(
    session: AppSidecarReminderSession,
    leaseToken: string,
    delivery: Pick<ProjectNotesReminderDeliveryRequest, "channel" | "permission">,
  ): Promise<ReminderClaimOutcome> {
    const lease = this.validateLease(session, leaseToken);
    if ("status" in lease) return lease;
    const request: ProjectNotesReminderDeliveryRequest = {
      phaseId: lease.phaseId,
      occurrenceKey: lease.occurrenceKey,
      attemptedAt: new Date(this.clock.now()).toISOString(),
      channel: delivery.channel,
      permission: delivery.permission,
    };
    try {
      const outcome = await this.repository.recordReminderDelivery(lease.cwd, request);
      if (outcome.status === "ok") {
        this.leases.delete(lease.token);
        if (this.onCommitted) this.onCommitted(outcome.snapshot);
        else this.observeSnapshot(outcome.snapshot);
      } else if (outcome.status !== "corrupt" && outcome.status !== "missing") {
        this.leases.delete(lease.token);
        const project = this.projects.get(lease.projectKey);
        if (project) this.schedule(lease.projectKey, project);
      }
      return outcome;
    } catch (error) {
      this.leases.delete(lease.token);
      const project = this.projects.get(lease.projectKey);
      if (project) this.schedule(lease.projectKey, project);
      throw error;
    }
  }

  release(session: AppSidecarReminderSession, leaseToken: string): ReminderReleaseOutcome {
    const lease = this.validateLease(session, leaseToken);
    if ("status" in lease) return lease;
    this.leases.delete(lease.token);
    const project = this.projects.get(lease.projectKey);
    if (project) this.schedule(lease.projectKey, project);
    return { status: "released" };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const project of this.projects.values()) {
      if (project.timer !== null) this.clock.clearTimeout(project.timer);
    }
    this.projects.clear();
    this.sessions.clear();
    this.leases.clear();
  }

  private validateLease(
    session: AppSidecarReminderSession,
    leaseToken: string,
  ): ReminderLease | { status: "invalid-lease" | "expired-lease" | "wrong-session" } {
    const lease = this.leases.get(leaseToken);
    if (!lease) return { status: "invalid-lease" };
    if (lease.expiresAt <= this.clock.now()) {
      this.leases.delete(leaseToken);
      return { status: "expired-lease" };
    }
    if (lease.sessionId !== session.id || lease.projectKey !== canonicalProjectKey(session.cwd)) {
      return { status: "wrong-session" };
    }
    return lease;
  }

  private leaseFor(projectKey: string, occurrenceKey: string): ReminderLease | undefined {
    const now = this.clock.now();
    return [...this.leases.values()].find(
      (lease) =>
        lease.projectKey === projectKey &&
        lease.occurrenceKey === occurrenceKey &&
        lease.expiresAt > now,
    );
  }

  private pruneExpiredLeases(now: number): void {
    for (const [token, lease] of this.leases) {
      if (lease.expiresAt + this.leaseTtlMs <= now) this.leases.delete(token);
    }
  }

  private pruneOccurrenceState(project: WatchedProject, document: NotesDocumentV3): void {
    const currentKeys = new Set(
      document.phases.flatMap((phase) => (phase.reminder ? [phase.reminder.occurrenceKey] : [])),
    );
    for (const key of project.backgroundEligibleAt.keys()) {
      if (!currentKeys.has(key)) project.backgroundEligibleAt.delete(key);
    }
    for (const key of project.signaledOccurrenceKeys) {
      const stillUndelivered = document.phases.some(
        (phase) =>
          phase.reminder?.occurrenceKey === key &&
          phase.reminder.lastDelivery?.occurrenceKey !== key,
      );
      if (!stillUndelivered) project.signaledOccurrenceKeys.delete(key);
    }
  }

  private schedule(projectKey: string, project: WatchedProject): void {
    if (project.timer !== null) this.clock.clearTimeout(project.timer);
    project.timer = null;
    if (!project.snapshot || project.sessionIds.size === 0 || this.disposed) return;
    const now = this.clock.now();
    this.pruneExpiredLeases(now);
    const nextDue = nextUndeliveredDueAt(project.snapshot.document, project.signaledOccurrenceKeys);
    const nextLeaseExpiry = [...this.leases.values()]
      .filter((lease) => lease.projectKey === projectKey && lease.expiresAt > now)
      .reduce((earliest, lease) => Math.min(earliest, lease.expiresAt), Number.POSITIVE_INFINITY);
    const nextGrace = [...project.backgroundEligibleAt.values()]
      .filter((value) => value > now)
      .reduce((earliest, value) => Math.min(earliest, value), Number.POSITIVE_INFINITY);
    const target = Math.min(nextDue, nextLeaseExpiry, nextGrace, now + this.maxTimerDelayMs);
    if (!Number.isFinite(target)) return;
    this.scheduleAt(projectKey, project, target);
  }

  private scheduleAt(projectKey: string, project: WatchedProject, targetMs: number): void {
    if (project.timer !== null) this.clock.clearTimeout(project.timer);
    const delay = Math.max(0, Math.min(targetMs - this.clock.now(), this.maxTimerDelayMs));
    project.timer = this.clock.setTimeout(() => {
      project.timer = null;
      void this.wake(projectKey).catch((error) => this.onError?.(error));
    }, delay);
  }

  private async wake(projectKey: string): Promise<void> {
    const project = this.projects.get(projectKey);
    if (!project || project.sessionIds.size === 0 || this.disposed) return;
    this.pruneExpiredLeases(this.clock.now());
    const loaded = await this.repository.load(project.cwd);
    if (loaded.status !== "ok") {
      this.schedule(projectKey, project);
      return;
    }
    project.snapshot = loaded.snapshot;
    const occurrence = selectDueReminder(loaded.snapshot.document, this.clock.now());
    if (occurrence && !project.signaledOccurrenceKeys.has(occurrence.reminder.occurrenceKey)) {
      project.signaledOccurrenceKeys.add(occurrence.reminder.occurrenceKey);
      this.onReminderDue(projectKey);
    }
    this.schedule(projectKey, project);
  }
}

function nextUndeliveredDueAt(
  document: NotesDocumentV3,
  excludedOccurrenceKeys: ReadonlySet<string>,
): number {
  return document.phases.reduce((earliest, phase) => {
    const reminder = phase.reminder;
    if (
      !isEligiblePhase(phase) ||
      reminder === null ||
      excludedOccurrenceKeys.has(reminder.occurrenceKey) ||
      reminder.lastDelivery?.occurrenceKey === reminder.occurrenceKey
    ) {
      return earliest;
    }
    return Math.min(earliest, Date.parse(reminder.dueAt));
  }, Number.POSITIVE_INFINITY);
}

export interface AppSidecarReminderHandler {
  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: AppSidecarReminderSession,
    requestUrl: string,
    method: string,
  ): boolean;
}

export function createAppSidecarReminderHandler(
  coordinator: AppSidecarReminderCoordinator,
  onError?: (error: unknown) => void,
): AppSidecarReminderHandler {
  return {
    handle(req, res, session, requestUrl, method) {
      const pathname = requestPathname(requestUrl);
      if (
        pathname !== "/reminders/reserve" &&
        pathname !== "/reminders/claim" &&
        pathname !== "/reminders/release"
      ) {
        return false;
      }
      if (method !== "POST") {
        sendJson(res, 405, { status: "invalid", reason: "method-not-allowed" });
        return true;
      }
      void readJsonBody(req, REMINDER_REQUEST_BODY_MAX_BYTES)
        .then(async (body) => {
          if (pathname === "/reminders/reserve" && isReserveBody(body)) {
            sendJson(res, 200, await coordinator.reserve(session, body.focused));
            return;
          }
          if (pathname === "/reminders/claim" && isClaimBody(body)) {
            sendJson(
              res,
              200,
              await coordinator.claim(session, body.leaseToken, {
                channel: body.channel,
                permission: body.permission,
              }),
            );
            return;
          }
          if (pathname === "/reminders/release" && isReleaseBody(body)) {
            sendJson(res, 200, coordinator.release(session, body.leaseToken));
            return;
          }
          sendJson(res, 400, {
            status: "invalid",
            error: { path: "$", message: "invalid request body" },
          });
        })
        .catch((error) => {
          onError?.(error);
          const tooLarge = error instanceof AppSidecarJsonBodyError && error.kind === "too-large";
          const malformed = error instanceof AppSidecarJsonBodyError && error.kind === "malformed";
          sendJson(res, tooLarge ? 413 : malformed ? 400 : 500, {
            status: tooLarge || malformed ? "invalid" : "error",
            error:
              tooLarge || malformed
                ? {
                    path: "$",
                    message: tooLarge
                      ? `reminder request body exceeds ${REMINDER_REQUEST_BODY_MAX_BYTES} bytes`
                      : "malformed JSON request body",
                  }
                : undefined,
            message: tooLarge || malformed ? undefined : "reminder request failed",
          });
        });
      return true;
    },
  };
}

function isReserveBody(value: unknown): value is { focused: boolean } {
  return isExactRecord(value, ["focused"]) && typeof value.focused === "boolean";
}

function isClaimBody(value: unknown): value is {
  leaseToken: string;
  channel: NotesReminderDeliveryChannel;
  permission: NotesReminderPermission;
} {
  return (
    isExactRecord(value, ["leaseToken", "channel", "permission"]) &&
    isBoundedString(value.leaseToken, 1, 256) &&
    isValidNotesReminderDeliveryPair(value.channel, value.permission)
  );
}

function isReleaseBody(value: unknown): value is { leaseToken: string } {
  return isExactRecord(value, ["leaseToken"]) && isBoundedString(value.leaseToken, 1, 256);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
