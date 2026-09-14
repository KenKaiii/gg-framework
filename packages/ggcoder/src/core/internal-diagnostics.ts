/**
 * Internal-only session diagnostics — NOT a public feature.
 *
 * Enabled only when the internal flag is set (env `GG_INTERNAL=1` or
 * `~/.gg/internal.json` containing `{"diagnostics": true}`). When disabled,
 * nothing is recorded, no tool is registered, and `/diagnose` does not exist,
 * so the public tool list and prompt stay byte-identical.
 *
 * What it captures per session (counters and timings only — never prompt
 * text, file contents, or credentials):
 *   - per-turn usage + timing (reuses TurnMetricPayload, already persisted)
 *   - per-tool call/error/duration stats and clustered error digests
 *   - identical-call repeats (same tool + same args ≥ 3×)
 *   - truncation/continuation events, model switches, compactions
 *
 * Consumers: the `session_stats` tool (live, agent-facing) and the
 * `/diagnose` slash command (cross-session aggregate, agent-facing).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getAppPaths } from "../config.js";
import type { EventBus } from "./event-bus.js";
import type { SlashCommand } from "./slash-commands.js";

let enabledCache: boolean | undefined;

/** Internal mode gate. Env wins; otherwise `~/.gg/internal.json` must set
 * `diagnostics: true`. Result is cached for the process lifetime. */
export function isInternalDiagnosticsEnabled(): boolean {
  if (enabledCache !== undefined) return enabledCache;
  const env = process.env.GG_INTERNAL;
  if (env && ["1", "true", "yes"].includes(env.toLowerCase())) {
    enabledCache = true;
    return true;
  }
  try {
    const file = path.join(getAppPaths().agentDir, "internal.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { diagnostics?: unknown };
    enabledCache = parsed?.diagnostics === true;
  } catch {
    enabledCache = false;
  }
  return enabledCache;
}

/** Test seam: reset the cached flag after mutating env/file state. */
export function resetInternalDiagnosticsCacheForTests(): void {
  enabledCache = undefined;
}

export function diagnosticsSessionsDir(): string {
  return (
    process.env.GG_DIAGNOSTICS_DIR ?? path.join(getAppPaths().agentDir, "diagnostics", "sessions")
  );
}

// ── Record shape ───────────────────────────────────────────

export interface TurnDiagnostics {
  turn: number;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  ttftMs?: number;
  providerDurationMs: number;
}

export interface ToolDiagnostics {
  calls: number;
  errors: number;
  /** Non-zero exits, empty greps, tool-rejection strings — failures the tools
   * report as ordinary result text (isError stays false). */
  softErrors: number;
  totalMs: number;
  maxMs: number;
  invalidArgAttempts: number;
  truncatedResults: number;
}

export interface ErrorCluster {
  digest: string;
  count: number;
  sample: string;
}

export interface RepeatEntry {
  tool: string;
  argsDigest: string;
  count: number;
}

export interface SessionDiagnosticsRecord {
  version: 1;
  sessionId: string;
  cwd: string;
  provider: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  modelSwitches: { at: number; provider: string; model: string }[];
  turns: TurnDiagnostics[];
  toolStats: Record<string, ToolDiagnostics>;
  errorClusters: ErrorCluster[];
  repeats: RepeatEntry[];
  truncations: { reason: string; continued: boolean }[];
  compactions: { originalCount: number; newCount: number }[];
  totals: {
    turns: number;
    toolCalls: number;
    toolErrors: number;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

/** The subset of TurnMetricPayload the recorder consumes — kept structural so
 * agent-session can pass its full payload without an import cycle. */
export interface TurnMetricLike {
  turn: number;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number };
  timing: { providerDurationMs: number; ttftMs?: number };
}

// ── Recorder ───────────────────────────────────────────────

const REPEAT_THRESHOLD = 3;
const MAX_ERROR_CLUSTERS = 8;
const MAX_REPEATED_KEYS = 16;
const MAX_TURNS_KEPT = 500;

function argsDigest(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const json = JSON.stringify(args);
  return json.length > 80 ? `${createHash("sha1").update(json).digest("hex").slice(0, 12)}…` : json;
}

/** True when a tool "succeeded" but its result text says it failed: bash
 * prefixes non-zero exits with "Exit code: N", and most tools prefix
 * rejections/refusals with "Error:". Empty-grep "no matches" is a legitimate
 * answer, not a failure, so it stays clean. */
function isSoftFailure(result: string): boolean {
  return /^Exit code: [1-9]/m.test(result) || /^Error:/m.test(result);
}

/** Collapse an error result into a stable digest: first line, digits and
 * quoted paths normalized, so 50 identical failures cluster into one row. */
function errorDigest(result: string): string {
  const firstLine = result.split("\n").find((l) => l.trim().length > 0) ?? "";
  return firstLine
    .replace(/\d+/g, "N")
    .replace(/"[^"]+"/g, '"…"')
    .replace(/'[^']+'/g, "'…'")
    .slice(0, 120);
}

export class SessionDiagnosticsRecorder {
  private record: SessionDiagnosticsRecord;
  private pendingCalls = new Map<string, { name: string; argsKey: string }>();
  private repeatCounts = new Map<string, { tool: string; argsDigest: string; count: number }>();
  private clusterCounts = new Map<string, { count: number; sample: string }>();
  private unsubscribers: (() => void)[] = [];
  private fallbackSessionId?: string;

  private getSessionId: () => string;

  constructor(opts: {
    /** Lazy on purpose: hosts assign the session id at first prompt, AFTER
     * initialize() creates this recorder. A string snapshot would name the
     * record file `.json` (empty id). */
    sessionId: string | (() => string);
    cwd: string;
    provider: string;
    model: string;
    dir?: string;
  }) {
    this.getSessionId = () =>
      typeof opts.sessionId === "function" ? opts.sessionId() : opts.sessionId;
    this.record = {
      version: 1,
      sessionId: this.getSessionId(),
      cwd: opts.cwd,
      provider: opts.provider,
      model: opts.model,
      startedAt: Date.now(),
      modelSwitches: [],
      turns: [],
      toolStats: {},
      errorClusters: [],
      repeats: [],
      truncations: [],
      compactions: [],
      totals: {
        turns: 0,
        toolCalls: 0,
        toolErrors: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    };
    this.dir = opts.dir;
  }

  private dir?: string;

  /** Subscribe to the session bus. Safe to call once per session. */
  attach(bus: EventBus): void {
    this.unsubscribers.push(
      bus.on("tool_call_start", ({ toolCallId, name, args }) => {
        this.pendingCalls.set(toolCallId, { name, argsKey: argsDigest(args) });
      }),
    );
    this.unsubscribers.push(
      bus.on("tool_call_end", ({ toolCallId, result, isError, durationMs, invalidArgAttempt }) => {
        const pending = this.pendingCalls.get(toolCallId);
        this.pendingCalls.delete(toolCallId);
        const name = pending?.name ?? "unknown";
        const stat = (this.record.toolStats[name] ??= {
          calls: 0,
          errors: 0,
          softErrors: 0,
          totalMs: 0,
          maxMs: 0,
          invalidArgAttempts: 0,
          truncatedResults: 0,
        });
        stat.calls += 1;
        stat.totalMs += durationMs;
        stat.maxMs = Math.max(stat.maxMs, durationMs);
        if (invalidArgAttempt) stat.invalidArgAttempts += 1;
        if (/Full output saved to|\[truncated/i.test(result)) stat.truncatedResults += 1;
        this.record.totals.toolCalls += 1;
        const failed = isError || isSoftFailure(result);
        if (isError) stat.errors += 1;
        else if (failed) stat.softErrors += 1;
        if (failed) {
          this.record.totals.toolErrors += 1;
          const digest = errorDigest(result);
          const cluster = this.clusterCounts.get(digest) ?? {
            count: 0,
            sample: result.slice(0, 200),
          };
          cluster.count += 1;
          this.clusterCounts.set(digest, cluster);
        }
        if (pending) {
          const key = `${name}::${pending.argsKey}`;
          const entry = this.repeatCounts.get(key) ?? {
            tool: name,
            argsDigest: pending.argsKey,
            count: 0,
          };
          entry.count += 1;
          this.repeatCounts.set(key, entry);
        }
      }),
    );
    this.unsubscribers.push(
      bus.on("model_change", ({ provider, model }) => {
        if (model !== this.record.model || provider !== this.record.provider) {
          this.record.modelSwitches.push({ at: Date.now(), provider, model });
          this.record.provider = provider;
          this.record.model = model;
        }
      }),
    );
    this.unsubscribers.push(
      bus.on("truncated", ({ reason, continued }) => {
        this.record.truncations.push({ reason, continued });
      }),
    );
    this.unsubscribers.push(
      bus.on("compaction_end", ({ compacted, originalCount, newCount }) => {
        if (compacted) this.record.compactions.push({ originalCount, newCount });
      }),
    );
  }

  /** Called from AgentSession.persistTurnMetric — the authoritative per-turn
   * usage/timing source. Also the incremental flush point. */
  recordTurnMetric(metric: TurnMetricLike): void {
    this.record.totals.turns += 1;
    this.record.totals.inputTokens += metric.usage.inputTokens;
    this.record.totals.outputTokens += metric.usage.outputTokens;
    this.record.totals.cacheRead += metric.usage.cacheRead ?? 0;
    this.record.totals.cacheWrite += metric.usage.cacheWrite ?? 0;
    this.record.turns.push({
      turn: metric.turn,
      stopReason: metric.stopReason,
      inputTokens: metric.usage.inputTokens,
      outputTokens: metric.usage.outputTokens,
      cacheRead: metric.usage.cacheRead,
      cacheWrite: metric.usage.cacheWrite,
      ttftMs: metric.timing.ttftMs,
      providerDurationMs: metric.timing.providerDurationMs,
    });
    if (this.record.turns.length > MAX_TURNS_KEPT)
      this.record.turns.splice(0, this.record.turns.length - MAX_TURNS_KEPT);
    void this.flush();
  }

  private materializeDerived(): void {
    this.record.errorClusters = [...this.clusterCounts.entries()]
      .map(([digest, { count, sample }]) => ({ digest, count, sample }))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_ERROR_CLUSTERS);
    this.record.repeats = [...this.repeatCounts.values()]
      .filter((e) => e.count >= REPEAT_THRESHOLD)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_REPEATED_KEYS);
  }

  private filePath(): string {
    return path.join(this.dir ?? diagnosticsSessionsDir(), `${this.record.sessionId}.json`);
  }

  /** Best-effort incremental write — a diagnostics write failure must never
   * affect the session. Synchronous ON PURPOSE: the record is a few KB written
   * once per turn (negligible next to the network call it follows), and a sync
   * write cannot be lost when a headless host exits immediately after the
   * final turn_end — an async fire-and-forget flush racing process exit was
   * silently dropping the whole session's record. */
  flush(): Promise<void> {
    try {
      this.materializeDerived();
      this.record.sessionId = this.getSessionId();
      // Transient hosts (json sub-agent mode) never assign a session id —
      // fall back to a stable generated one so the record still lands under a
      // real filename instead of `.json`.
      if (!this.record.sessionId) {
        this.fallbackSessionId ??= randomUUID();
        this.record.sessionId = this.fallbackSessionId;
      }
      const file = this.filePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.record), "utf8");
    } catch {
      // Swallow: internal diagnostics are strictly best-effort.
    }
    return Promise.resolve();
  }

  async finalize(): Promise<void> {
    this.record.endedAt = Date.now();
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    await this.flush();
  }

  getRecord(): Readonly<SessionDiagnosticsRecord> {
    return this.record;
  }

  // Test accessors — fresh derived state, independent of flush timing.
  snapshotForTests(): SessionDiagnosticsRecord {
    this.materializeDerived();
    return JSON.parse(JSON.stringify(this.record)) as SessionDiagnosticsRecord;
  }
  repeatsForTests(): RepeatEntry[] {
    this.materializeDerived();
    return [...this.record.repeats];
  }
  errorClustersForTests(): ErrorCluster[] {
    this.materializeDerived();
    return [...this.record.errorClusters];
  }

  /** Compact agent-readable summary of THIS session (for session_stats). */
  summary(): string {
    return summarizeRecord(this.record);
  }
}

// ── Summaries + aggregation ─────────────────────────────────

function pct(part: number, whole: number): string {
  return whole > 0 ? `${((100 * part) / whole).toFixed(0)}%` : "—";
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function summarizeRecord(r: SessionDiagnosticsRecord): string {
  const lines: string[] = [];
  const t = r.totals;
  const promptTotal = t.inputTokens + t.cacheRead;
  lines.push(
    `Session ${r.sessionId} (${r.provider}/${r.model}) — ${t.turns} turns, ${t.toolCalls} tool calls (${t.toolErrors} errors).`,
  );
  lines.push(
    `Tokens: ${t.inputTokens + t.cacheRead} prompt (${t.cacheRead} cached, ${pct(t.cacheRead, promptTotal)} reuse), ${t.outputTokens} output.`,
  );
  if (r.modelSwitches.length) {
    lines.push(
      `Model switches: ${r.modelSwitches.length} (each likely rebuilds the cached prefix).`,
    );
  }
  const ttfts = r.turns.map((x) => x.ttftMs).filter((x): x is number => typeof x === "number");
  if (ttfts.length) {
    const sorted = [...ttfts].sort((a, b) => a - b);
    lines.push(
      `TTFT median ${fmtMs(sorted[Math.floor(sorted.length / 2)])}, worst ${fmtMs(sorted[sorted.length - 1])}.`,
    );
  }
  const toolLines = Object.entries(r.toolStats)
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .slice(0, 6)
    .map(([name, s]) => {
      const failed = s.errors + (s.softErrors ?? 0);
      const err = failed > 0 ? `, ${failed} failed (${pct(failed, s.calls)})` : "";
      const bad = failed > 0 && failed / s.calls >= 0.25 ? " ⚠" : "";
      return `- ${name}: ${s.calls} calls, ${fmtMs(s.totalMs)} total, ${fmtMs(s.maxMs)} max${err}${bad}`;
    });
  if (toolLines.length) lines.push("Tools (by total time):", ...toolLines);
  if (r.repeats.length) {
    lines.push(
      `Repeated identical calls: ${r.repeats.map((x) => `${x.tool}×${x.count}`).join(", ")} — usually a stuck pattern.`,
    );
  }
  for (const c of r.errorClusters.slice(0, 3)) {
    lines.push(`Top error (${c.count}×): ${c.digest}`);
  }
  if (r.truncations.length) {
    const continued = r.truncations.filter((x) => x.continued).length;
    lines.push(`Output cut off ${r.truncations.length}× (${continued} auto-continued).`);
  }
  if (r.compactions.length) {
    lines.push(
      `Compactions: ${r.compactions.length}× (${r.compactions
        .map((c) => `${c.originalCount}→${c.newCount} msgs`)
        .join(", ")}).`,
    );
  }
  return lines.join("\n");
}

export interface DiagnosticsAggregate {
  sessionCount: number;
  report: string;
}

/** Read the newest N session records and produce a ranked, agent-readable
 * findings report. Findings are ordered by cost × frequency, most urgent
 * first; "what works" is included so regressions are visible. */
export function aggregateRecentDiagnostics(limit = 20, dir?: string): DiagnosticsAggregate {
  const root = dir ?? diagnosticsSessionsDir();
  let files: string[];
  try {
    files = fs
      .readdirSync(root)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(root, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, limit);
  } catch {
    return { sessionCount: 0, report: "No session diagnostics found (is internal mode enabled?)." };
  }
  const records: SessionDiagnosticsRecord[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as SessionDiagnosticsRecord;
      if (parsed?.version === 1) records.push(parsed);
    } catch {
      // Skip corrupt files — diagnostics must never hard-fail.
    }
  }
  if (!records.length) {
    return { sessionCount: 0, report: "No valid session diagnostics records found." };
  }

  const findings: string[] = [];
  const toolAgg = new Map<
    string,
    { calls: number; errors: number; maxMs: number; totalMs: number }
  >();
  const clusterAgg = new Map<string, number>();
  const repeatAgg = new Map<string, number>();
  let input = 0;
  let cacheRead = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let truncations = 0;
  let compactions = 0;
  let modelSwitches = 0;
  const ttfts: number[] = [];

  for (const r of records) {
    input += r.totals.inputTokens;
    cacheRead += r.totals.cacheRead;
    toolCalls += r.totals.toolCalls;
    toolErrors += r.totals.toolErrors;
    truncations += r.truncations.length;
    compactions += r.compactions.length;
    modelSwitches += r.modelSwitches.length;
    for (const x of r.turns) if (typeof x.ttftMs === "number") ttfts.push(x.ttftMs);
    for (const [name, s] of Object.entries(r.toolStats)) {
      const agg = toolAgg.get(name) ?? { calls: 0, errors: 0, maxMs: 0, totalMs: 0 };
      agg.calls += s.calls;
      agg.errors += s.errors + (s.softErrors ?? 0);
      agg.maxMs = Math.max(agg.maxMs, s.maxMs);
      agg.totalMs += s.totalMs;
      toolAgg.set(name, agg);
    }
    for (const c of r.errorClusters)
      clusterAgg.set(c.digest, (clusterAgg.get(c.digest) ?? 0) + c.count);
    for (const rep of r.repeats) {
      const key = `${rep.tool}::${rep.argsDigest}`;
      repeatAgg.set(key, (repeatAgg.get(key) ?? 0) + rep.count);
    }
  }

  const promptTotal = input + cacheRead;
  findings.push(
    `${records.length} sessions — ${toolCalls} tool calls, ${toolErrors} errors (${pct(toolErrors, toolCalls)}), cache reuse ${pct(cacheRead, promptTotal)} across ${(promptTotal / 1000).toFixed(0)}k prompt tokens.`,
  );

  // 1. Error clusters — reliability, ranked by count.
  const clusters = [...clusterAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (clusters.length) {
    findings.push(
      "CHECK OUT — recurring errors:",
      ...clusters.map(([digest, n]) => `- ${n}× ${digest}`),
    );
  }

  // 2. High-failure-rate tools.
  const flaky = [...toolAgg.entries()]
    .filter(([, s]) => s.calls >= 5 && s.errors / s.calls >= 0.25)
    .sort((a, b) => b[1].errors / b[1].calls - a[1].errors / a[1].calls);
  if (flaky.length) {
    findings.push(
      "CHECK OUT — tools failing ≥25% of calls:",
      ...flaky.map(([name, s]) => `- ${name}: ${s.errors}/${s.calls} (${pct(s.errors, s.calls)})`),
    );
  }

  // 3. Slow tools — worst-case duration.
  const slow = [...toolAgg.entries()]
    .filter(([, s]) => s.maxMs >= 30_000)
    .sort((a, b) => b[1].maxMs - a[1].maxMs);
  if (slow.length) {
    findings.push(
      "SPEED — tools with ≥30s worst-case calls:",
      ...slow.map(([name, s]) => `- ${name}: max ${fmtMs(s.maxMs)}, total ${fmtMs(s.totalMs)}`),
    );
  }

  // 4. Repeats — wasted turns.
  const repeats = [...repeatAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (repeats.length) {
    findings.push(
      "WASTE — identical calls repeated ≥3× (stuck patterns):",
      ...repeats.map(([key]) => `- ${key.replace("::", " ")}`),
    );
  }

  // 5. Cache + compaction pressure.
  if (modelSwitches > 0) {
    findings.push(
      `COST — ${modelSwitches} mid-session model switch(es): each one can rebuild the cached prefix and re-bill the whole context.`,
    );
  }
  if (compactions > 0) findings.push(`COST — ${compactions} compaction(s) across these sessions.`);
  if (truncations > 0)
    findings.push(`RELIABILITY — output cut off ${truncations}× (output-token limits).`);

  if (ttfts.length) {
    const sorted = [...ttfts].sort((a, b) => a - b);
    findings.push(
      `SPEED — TTFT median ${fmtMs(sorted[Math.floor(sorted.length / 2)])}, p95 ${fmtMs(sorted[Math.floor(sorted.length * 0.95)])} over ${ttfts.length} turns.`,
    );
  }

  // What's working — the counterfactual baseline.
  const healthy = [...toolAgg.entries()].filter(([, s]) => s.calls >= 5 && s.errors === 0);
  if (healthy.length) {
    findings.push(`WORKING — zero-error tools (≥5 calls): ${healthy.map(([n]) => n).join(", ")}.`);
  }

  return { sessionCount: records.length, report: findings.join("\n") };
}

// ── /diagnose slash command ────────────────────────────────

/** Internal-only command; registered exclusively when the internal flag is on. */
export function createDiagnoseCommand(): SlashCommand {
  return {
    name: "diagnose",
    aliases: ["diag"],
    description: "Internal: aggregate recent session diagnostics into ranked findings",
    usage: "/diagnose [sessions]",
    execute(args) {
      const parsed = Number.parseInt(args.trim(), 10);
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20;
      return aggregateRecentDiagnostics(limit).report;
    },
  };
}
