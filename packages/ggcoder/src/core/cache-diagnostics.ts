import { createHash } from "node:crypto";
import {
  opensTurn,
  type CacheRetention,
  type Message,
  type PreparedContext,
  type Usage,
} from "@kenkaiiii/gg-ai";
import { resolveCacheTtl, type CacheTouch } from "./cache-expiry.js";

/** Digests never leave this instance. Canonical object keys avoid spurious edits on resume. */
function digest(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
  return createHash("sha256")
    .update(json ?? "null")
    .digest("hex");
}

interface RequestSnapshot {
  messages: string[];
  settings: string;
  route: string;
  at: number;
  imagesDropped: number;
  usage?: Usage;
  /** TTL identity of this request, for cold-cache detection. Null = no known TTL. */
  touch: Omit<CacheTouch, "at"> | null;
}

/** Route fields the session passes as `route`; read structurally, never digested. */
function routeField(route: unknown, key: "baseUrl" | "accountId"): string | undefined {
  if (!route || typeof route !== "object") return undefined;
  const value = (route as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

export interface CacheRequestObservation {
  provider: string;
  model: string;
  at: number;
  cacheRetention: CacheRetention;
  /** Request-shaping settings only; digested in memory, never logged. */
  settings: unknown;
  /** Route/account identity, digested in memory. Never pass credentials. */
  route: unknown;
}

type HistoryEdit = "tool_prune" | "compaction";

export interface CacheContextReport {
  stage: "prepared_context";
  request: number;
  changes: string[];
  messageCount: number;
  previousMessageCount: number;
  /** Logical-message prefix, NOT a provider token offset or exact HTTP-body comparison. */
  unchangedMessages: number;
  imagesBefore: number;
  imagesAfter: number;
  imagesDropped: number;
  pruneFreedTokensEstimate: number;
  sincePreviousRequestMs: number | null;
  requestedTtlExceeded: boolean;
  /** Gap exceeded the 5-min TTL that the growing tool-loop tail is written at
   *  (even under "long" retention, until the run counts as long), so the tail
   *  past the last 1-h breakpoint was possibly re-written. */
  tailTtlExceeded: boolean;
  /** Possible signed-thinking prefix mismatch; not a server-confirmed rejection. */
  thinkingPrefixRiskBlocks: number;
  /** Existing Anthropic encoding removes these signed blocks from settled turns. */
  settledThinkingBlocks: number;
  fingerprintMs: number;
}

export interface CacheUsageReport extends CacheContextReport {
  promptTokens: number;
  cacheRead: number;
  cacheWrite: number;
  comparison: "first_request" | "compaction" | "route_changed" | "cache_unreported" | "comparable";
  /** Upper-bound proxy for repeated input not read from cache, not proven avoidable waste. */
  reprocessedPromptTokensEstimate: number | null;
  costStatus: "unavailable";
  ttftMs: number | null;
  providerDurationMs: number;
}

function signedThinkingCount(message: Message): number {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return 0;
  return message.content.filter(
    (part) =>
      (part.type === "thinking" && Boolean(part.signature?.trim())) ||
      (part.type === "raw" &&
        (part.data.type === "redacted_thinking" ||
          (part.data.type === "thinking" && typeof part.data.signature === "string"))),
  ).length;
}

function promptTokens(usage: Usage): number {
  return usage.inputTokens + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** One per session. Retains only one completed snapshot and one in-flight snapshot, no payloads.
 * Failed/retried attempts never replace the last successful usage baseline. */
export class CacheDiagnostics {
  private completed: RequestSnapshot | undefined;
  private pending: { snapshot: RequestSnapshot; report: CacheContextReport } | undefined;
  private edits = new Set<HistoryEdit>();
  private freedTokens = 0;
  private requests = 0;
  private reportedCache = false;
  private lastTouch: CacheTouch | null = null;

  /** Last successful cache-using request (real turn or prewarm), or null. */
  lastCacheTouch(): CacheTouch | null {
    return this.lastTouch;
  }

  /** Record a successful cache-using request that bypassed prepare/complete (prewarm). */
  noteCacheTouch(touch: CacheTouch): void {
    this.lastTouch = { ...touch };
  }

  reset(): void {
    this.lastTouch = null;
    this.completed = undefined;
    this.pending = undefined;
    this.edits.clear();
    this.freedTokens = 0;
    this.requests = 0;
    this.reportedCache = false;
  }

  discardAttempt(): void {
    this.pending = undefined;
  }

  noteEdit(edit: HistoryEdit, freedTokens = 0): void {
    this.edits.add(edit);
    this.freedTokens += Math.max(0, freedTokens);
  }

  prepare(context: PreparedContext, input: CacheRequestObservation): CacheContextReport {
    const started = performance.now();
    const previous = this.completed;
    const snapshot: RequestSnapshot = {
      messages: context.messages.map((message) =>
        digest({ role: message.role, content: message.content }),
      ),
      settings: digest({
        tools: context.tools,
        settings: input.settings,
        cacheRetention: input.cacheRetention,
      }),
      route: digest({ provider: input.provider, model: input.model, route: input.route }),
      imagesDropped: context.imagesBefore - context.imagesAfter,
      at: input.at,
      touch: (() => {
        const policy = resolveCacheTtl({
          provider: input.provider,
          model: input.model,
          cacheRetention: input.cacheRetention,
          baseUrl: routeField(input.route, "baseUrl"),
          accountId: routeField(input.route, "accountId"),
        });
        return policy ? { provider: input.provider, model: input.model, policy } : null;
      })(),
    };
    let unchanged = 0;
    if (previous) {
      while (
        unchanged < previous.messages.length &&
        unchanged < snapshot.messages.length &&
        previous.messages[unchanged] === snapshot.messages[unchanged]
      )
        unchanged++;
    }
    const changes: string[] = [...this.edits];
    if (previous?.route !== undefined && previous.route !== snapshot.route)
      changes.push("route_or_model");
    const settingsChanged = previous !== undefined && previous.settings !== snapshot.settings;
    if (settingsChanged) changes.push("request_settings");
    const historyChanged = previous !== undefined && unchanged < previous.messages.length;
    if (historyChanged) changes.push("history");
    if (snapshot.imagesDropped !== (previous?.imagesDropped ?? 0)) changes.push("image_budget");

    // The input is already clamped. On resume there is no previous snapshot, but removal of
    // earlier images can still invalidate signed reasoning from the saved conversation.
    let firstEdit = context.firstImageDropMessage ?? Number.POSITIVE_INFINITY;
    if (historyChanged) firstEdit = Math.min(firstEdit, unchanged);
    if (settingsChanged) firstEdit = -1;
    let lastUser = -1;
    context.messages.forEach((message, index) => {
      if (opensTurn(message)) lastUser = index;
    });
    let thinkingPrefixRiskBlocks = 0;
    let settledThinkingBlocks = 0;
    if (input.provider === "anthropic") {
      context.messages.forEach((message, index) => {
        const count = signedThinkingCount(message);
        if (index >= firstEdit) thinkingPrefixRiskBlocks += count;
        if (index < lastUser) settledThinkingBlocks += count;
      });
    }
    const sincePreviousRequestMs = previous ? Math.max(0, input.at - previous.at) : null;
    const report: CacheContextReport = {
      stage: "prepared_context",
      request: ++this.requests,
      changes: changes.sort(),
      messageCount: snapshot.messages.length,
      previousMessageCount: previous?.messages.length ?? 0,
      unchangedMessages: unchanged,
      imagesBefore: context.imagesBefore,
      imagesAfter: context.imagesAfter,
      imagesDropped: snapshot.imagesDropped,
      pruneFreedTokensEstimate: this.freedTokens,
      sincePreviousRequestMs,
      requestedTtlExceeded:
        input.cacheRetention !== "none" &&
        sincePreviousRequestMs !== null &&
        sincePreviousRequestMs > (input.cacheRetention === "long" ? 3_600_000 : 300_000),
      tailTtlExceeded:
        input.cacheRetention !== "none" &&
        sincePreviousRequestMs !== null &&
        sincePreviousRequestMs > 300_000,
      thinkingPrefixRiskBlocks,
      settledThinkingBlocks,
      fingerprintMs: Math.round((performance.now() - started) * 100) / 100,
    };
    this.pending = { snapshot, report };
    return report;
  }

  complete(
    usage: Usage,
    timing: { ttftMs?: number; providerDurationMs: number },
  ): CacheUsageReport | undefined {
    if (!this.pending) return undefined;
    const { snapshot, report } = this.pending;
    const previous = this.completed;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const routeChanged = previous !== undefined && previous.route !== snapshot.route;
    const hasCache = cacheRead + cacheWrite > 0 || (!routeChanged && this.reportedCache);
    const comparison = !previous?.usage
      ? "first_request"
      : this.edits.has("compaction")
        ? "compaction"
        : routeChanged
          ? "route_changed"
          : !hasCache
            ? "cache_unreported"
            : "comparable";
    const reprocessed =
      comparison === "comparable" && previous?.usage
        ? Math.max(0, Math.min(promptTokens(previous.usage), promptTokens(usage)) - cacheRead)
        : null;
    this.completed = { ...snapshot, usage: { ...usage } };
    // The provider refreshes the cached prefix when the request is processed, so
    // the TTL clock restarts at the request's start time.
    this.lastTouch = snapshot.touch ? { ...snapshot.touch, at: snapshot.at } : null;
    this.pending = undefined;
    this.edits.clear();
    this.freedTokens = 0;
    this.reportedCache = hasCache;
    return {
      ...report,
      promptTokens: promptTokens(usage),
      cacheRead,
      cacheWrite,
      comparison,
      reprocessedPromptTokensEstimate: reprocessed,
      // GG's turn metrics currently have no authoritative effective-dated pricing. Do not
      // turn a cache-write count (which includes new content) into fabricated dollar waste.
      costStatus: "unavailable",
      ttftMs: timing.ttftMs ?? null,
      providerDurationMs: timing.providerDurationMs,
    };
  }
}
