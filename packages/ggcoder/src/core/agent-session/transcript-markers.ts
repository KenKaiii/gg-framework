import crypto from "node:crypto";
import {
  KEN_TURN_CUSTOM_KIND,
  AUTOPILOT_MARKER_CUSTOM_KIND,
  APP_MARKER_CUSTOM_KIND,
  type CustomEntry,
  type KenTurnPayload,
  type AutopilotMarkerPayload,
  type AppMarkerPayload,
  type SessionEntry,
  type SessionManager,
  type TurnMetricPayload,
} from "../session-manager.js";
import type { CompactionAnchorRemap } from "../compaction/compactor.js";
import { remapAnchorForCompaction, stripRecordedPosition } from "../session-history.js";

type MarkerKind =
  typeof KEN_TURN_CUSTOM_KIND | typeof AUTOPILOT_MARKER_CUSTOM_KIND | typeof APP_MARKER_CUSTOM_KIND;

/**
 * Display-only transcript history recorded against a session file: Ken Kai
 * turns, autopilot verdicts, app markers and per-turn metrics. NEVER part of
 * the LLM message history — persisted as `custom` entries (parentId null, so
 * never on the message DAG) and reloaded on resume so the transcript renders
 * the same rows the live run showed. Persistence is a no-op while the session
 * has no file (transient sessions keep markers in memory only).
 */
export class TranscriptMarkers {
  // Ken Kai (mentor agent) turns. Each carries the non-system message count at
  // record time so the webview can interleave them chronologically.
  private kenTurns: KenTurnPayload[] = [];
  // Autopilot Ken (auto-reviewer) verdict markers (prompted / done / human /
  // capped), so a resumed session shows the identical Ken bubble the live run
  // showed instead of dropping it or replaying a raw verdict.
  private autopilotMarkers: AutopilotMarkerPayload[] = [];
  // Generic app transcript markers (plan-mode banner, task header, error rows,
  // user-bubble display hints).
  private appMarkers: AppMarkerPayload[] = [];
  private turnMetrics: TurnMetricPayload[] = [];

  constructor(
    private readonly getSessionManager: () => SessionManager,
    private readonly getSessionPath: () => string,
  ) {}

  getKenTurns(): KenTurnPayload[] {
    return this.kenTurns;
  }

  getAutopilotMarkers(): AutopilotMarkerPayload[] {
    return this.autopilotMarkers;
  }

  getAppMarkers(): AppMarkerPayload[] {
    return this.appMarkers;
  }

  getTurnMetrics(): TurnMetricPayload[] {
    return this.turnMetrics.map((metric) => ({
      ...metric,
      usage: { ...metric.usage },
      timing: { ...metric.timing },
      cost: { ...metric.cost },
    }));
  }

  /** Summed cost when every recorded turn has a known price, else undefined. */
  knownCostUsd(): number | undefined {
    return this.turnMetrics.length > 0 && this.turnMetrics.every((m) => m.cost.status === "known")
      ? this.turnMetrics.reduce((sum, m) => sum + (m.cost.status === "known" ? m.cost.usd : 0), 0)
      : undefined;
  }

  /** Drop everything — display-only history belongs to the OLD session. */
  clear(): void {
    this.kenTurns = [];
    this.autopilotMarkers = [];
    this.appMarkers = [];
    this.turnMetrics = [];
  }

  /**
   * Restore from a loaded session file. The leaf is passed so each marker also
   * carries its FILE-order position, the fallback used when a legacy anchor is
   * out of range (see RecordedPosition).
   */
  restore(entries: SessionEntry[], leafId: string | null | undefined): void {
    const sessionManager = this.getSessionManager();
    this.kenTurns = sessionManager.getKenTurns(entries, leafId);
    this.autopilotMarkers = sessionManager.getAutopilotMarkers(entries, leafId);
    this.appMarkers = sessionManager.getAppMarkers(entries, leafId);
    this.turnMetrics = sessionManager.getTurnMetrics(entries);
  }

  /**
   * Rebase every transcript anchor (Ken turns, autopilot verdicts, app markers)
   * onto a freshly compacted message list.
   */
  remapAnchors(remap: CompactionAnchorRemap | undefined): void {
    if (!remap) return;
    const move = <T extends { afterMessageCount: number }>(payload: T): T => ({
      ...payload,
      afterMessageCount: remapAnchorForCompaction(payload.afterMessageCount, remap),
    });
    this.kenTurns = this.kenTurns.map(move);
    this.autopilotMarkers = this.autopilotMarkers.map(move);
    this.appMarkers = this.appMarkers.map(move);
  }

  async recordKenTurn(question: string, reply: string, afterMessageCount: number): Promise<void> {
    const payload: KenTurnPayload = { version: 1, question, reply, afterMessageCount };
    this.kenTurns.push(payload);
    await this.append(KEN_TURN_CUSTOM_KIND, payload);
  }

  async recordAutopilotMarker(
    phase: AutopilotMarkerPayload["phase"],
    extra: { reason?: string; body?: string } | undefined,
    afterMessageCount: number,
  ): Promise<void> {
    const payload: AutopilotMarkerPayload = {
      version: 1,
      phase,
      afterMessageCount,
      ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra?.body !== undefined ? { body: extra.body } : {}),
    };
    this.autopilotMarkers.push(payload);
    await this.append(AUTOPILOT_MARKER_CUSTOM_KIND, payload);
  }

  async recordAppMarker(
    kind: AppMarkerPayload["kind"],
    data: Record<string, unknown>,
    afterMessageCount: number,
  ): Promise<void> {
    const payload: AppMarkerPayload = { version: 1, kind, afterMessageCount, data };
    this.appMarkers.push(payload);
    await this.append(APP_MARKER_CUSTOM_KIND, payload);
  }

  /** Keep a turn metric in memory; {@link persistTurnMetric} writes it. */
  addTurnMetric(payload: TurnMetricPayload): void {
    this.turnMetrics.push(payload);
  }

  async persistTurnMetric(payload: TurnMetricPayload): Promise<void> {
    const sessionPath = this.getSessionPath();
    if (sessionPath) await this.getSessionManager().appendTurnMetric(sessionPath, payload);
  }

  /**
   * Re-append everything to the current session file. Called after a
   * continuation/compaction file is created so display-only history isn't lost
   * when the session is rewritten (those rewrites only re-persist messages).
   * Each marker keeps its original `afterMessageCount` anchor.
   */
  async rePersistAll(): Promise<void> {
    await this.rePersistTurnMetrics();
    await this.rePersist(KEN_TURN_CUSTOM_KIND, this.kenTurns);
    await this.rePersist(AUTOPILOT_MARKER_CUSTOM_KIND, this.autopilotMarkers);
    await this.rePersist(APP_MARKER_CUSTOM_KIND, this.appMarkers);
  }

  private async rePersistTurnMetrics(): Promise<void> {
    if (!this.getSessionPath()) return;
    for (const metric of this.turnMetrics) {
      await this.getSessionManager().appendTurnMetric(this.getSessionPath(), metric);
    }
  }

  private async rePersist(
    kind: MarkerKind,
    payloads: readonly (KenTurnPayload | AutopilotMarkerPayload | AppMarkerPayload)[],
  ): Promise<void> {
    if (!this.getSessionPath()) return;
    for (const payload of payloads) {
      const entry: CustomEntry = {
        type: "custom",
        kind,
        id: crypto.randomUUID(),
        parentId: null,
        timestamp: new Date().toISOString(),
        data: stripRecordedPosition(payload),
      };
      await this.getSessionManager().appendEntry(this.getSessionPath(), entry);
    }
  }

  private async append(
    kind: MarkerKind,
    payload: KenTurnPayload | AutopilotMarkerPayload | AppMarkerPayload,
  ): Promise<void> {
    const sessionPath = this.getSessionPath();
    if (!sessionPath) return;
    const entry: CustomEntry = {
      type: "custom",
      kind,
      id: crypto.randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: payload,
    };
    await this.getSessionManager().appendEntry(sessionPath, entry);
  }
}
