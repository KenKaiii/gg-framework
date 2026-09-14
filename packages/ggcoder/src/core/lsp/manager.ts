import path from "node:path";
import { log } from "../logger.js";
import type { LspClient, LspDiagnostic, LspPosition, LspRequestOutcome } from "./client.js";
import { formatDiagnostics } from "./format.js";
import { recordEditRegression, type EditSource } from "./edit-telemetry.js";
import { lspClientPool, type LspClientPool } from "./pool.js";
import {
  LSP_SERVER_CATALOG,
  findProjectRoot,
  serverForFile,
  type LspServerSpec,
} from "./servers.js";

export interface LspManagerOptions {
  /** Server catalog override — tests inject a fake-server spec here. */
  catalog?: readonly LspServerSpec[];
  /** Hard diagnostics budget once a client has served at least one file. */
  warmBudgetMs?: number;
  /** Hard budget for a client's very first file (spawn + init + indexing). */
  firstBudgetMs?: number;
  /** Grace period for a corrected publish after an empty cold-load result. */
  settleMs?: number;
  /** Maximum number of per-file latest outcomes retained. */
  snapshotLimit?: number;
  /**
   * Client pool backing this manager. Defaults to the daemon-wide singleton so
   * sessions share servers; injectable so tests get isolation.
   */
  pool?: LspClientPool;
}

export type LspOutcomeKind =
  | "diagnostics"
  | "clean"
  | "low_confidence"
  | "timeout"
  | "unsupported"
  | "unavailable"
  | "server_failed";

interface LspOutcomeBase {
  kind: LspOutcomeKind;
  filePath: string;
  updatedAt: number;
}

export type LspDiagnosticOutcome =
  | (LspOutcomeBase & {
      kind: "diagnostics";
      diagnostics: LspDiagnostic[];
      formatted: string;
    })
  | (LspOutcomeBase & {
      kind: Exclude<LspOutcomeKind, "diagnostics">;
    });

/**
 * A navigation answer, or the specific reason there isn't one. Shares its
 * failure vocabulary with `LspDiagnosticOutcome` so both surfaces degrade in
 * the same, legible way.
 */
export type LspNavigationOutcome<T> =
  | { kind: "ok"; filePath: string; serverId: string; value: T }
  | {
      kind: "timeout" | "unsupported" | "unavailable" | "server_failed";
      filePath: string;
      serverId?: string;
      message?: string;
    };

/** Errors only: warnings and hints never counted as breakage, matching format.ts. */
function errorCount(diagnostics: LspDiagnostic[]): number {
  return diagnostics.filter((d) => (d.severity ?? 1) === 1).length;
}

const DEFAULT_WARM_BUDGET_MS = 3000;

const DEFAULT_FIRST_BUDGET_MS = 8000;
/**
 * How long to wait for a corrected publish after a server's FIRST result for a
 * project comes back empty. tsserver ends its project-load progress, publishes
 * an empty set for the open file, and only then type-checks and publishes for
 * real, so that first empty publish means "not analysed yet" rather than
 * "clean". Only paid on a cold client that reported progress, and only when the
 * answer would otherwise have been `clean`.
 */
const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_SNAPSHOT_LIMIT = 100;

interface QueuedDiagnostics {
  next?: { content: string; source?: EditSource; before: number | null };
  work: Promise<void>;
  running: boolean;
  cancelled?: boolean;
  outcome?: LspDiagnosticOutcome;
}

/**
 * Per-session view over the process-wide language-server pool (see pool.ts).
 *
 * The manager owns only session-scoped state — per-file outcome snapshots and
 * which keys have gone warm — while the servers themselves are shared by every
 * session in the process and reclaimed when idle. That split is what stops two
 * windows open on one repo from running two full tsserver stacks.
 */
export class LspManager {
  private readonly catalog: readonly LspServerSpec[];
  private readonly warmBudgetMs: number;
  private readonly firstBudgetMs: number;
  private readonly settleMs: number;
  private readonly snapshotLimit: number;
  private readonly pool: LspClientPool;
  /**
   * Keys that have completed a diagnostics pass, mapped to the pool generation
   * that served it.
   *
   * Storing the generation rather than a bare flag is what keeps "warm" honest
   * across idle reclamation: once the pool retires a server, the replacement is
   * genuinely cold again, and treating it as warm would give it the 3s budget
   * instead of 8s AND skip the cold-load settle guard — turning tsserver's
   * premature empty publish into a reported "clean", which is a false all-clear.
   */
  private readonly warmKeys = new Map<string, number>();
  private readonly latestOutcomes = new Map<string, LspDiagnosticOutcome>();
  private readonly diagnosticRequests = new Map<string, object>();
  private readonly queuedDiagnostics = new Map<string, QueuedDiagnostics>();
  private diagnosticsOverflow = false;
  private shutDown = false;

  constructor(
    private readonly cwd: string,
    options?: LspManagerOptions,
  ) {
    this.catalog = options?.catalog ?? LSP_SERVER_CATALOG;
    this.warmBudgetMs = options?.warmBudgetMs ?? DEFAULT_WARM_BUDGET_MS;
    this.firstBudgetMs = options?.firstBudgetMs ?? DEFAULT_FIRST_BUDGET_MS;
    this.settleMs = Math.max(0, options?.settleMs ?? DEFAULT_SETTLE_MS);
    this.snapshotLimit = Math.max(1, options?.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT);
    this.pool = options?.pool ?? lspClientPool;
  }

  /** Schedule without holding the edit response; coalesce superseded writes per file. */
  queueDiagnosticsAfterWrite(filePath: string, content: string, source?: EditSource): string {
    if (this.shutDown) return "\nDiagnostics unavailable; this change is not verified.";
    const file = path.resolve(this.cwd, filePath);
    if (!serverForFile(file, this.catalog)) return "";
    const before = this.errorBaseline(file);
    this.latestOutcomes.delete(file);
    this.diagnosticRequests.delete(file);
    const existing = this.queuedDiagnostics.get(file);
    if (!existing && this.queuedDiagnostics.size >= this.snapshotLimit) {
      this.diagnosticsOverflow = true;
      return "\nDiagnostics queue full; this change is not verified. Run the project checks.";
    }
    const next = { content, source, before };
    if (existing?.running) {
      existing.cancelled = false;
      existing.next = next;
    } else {
      const job: QueuedDiagnostics = { next, work: Promise.resolve(), running: true };
      this.queuedDiagnostics.set(file, job);
      // Starting on the microtask queue coalesces writes in the same tool batch.
      job.work = Promise.resolve().then(async () => {
        try {
          while (job.next && this.queuedDiagnostics.get(file) === job && !this.shutDown) {
            const request = job.next;
            job.next = undefined;
            const outcome = await this.diagnosticsAfterWriteDetailed(file, request.content);
            if (
              job.next ||
              job.cancelled ||
              this.queuedDiagnostics.get(file) !== job ||
              this.shutDown
            )
              continue;
            job.outcome =
              outcome.kind === "diagnostics"
                ? {
                    ...outcome,
                    formatted:
                      outcome.formatted +
                      this.attribute(
                        file,
                        request.before,
                        errorCount(outcome.diagnostics),
                        request.source,
                      ),
                  }
                : outcome;
          }
        } catch (error) {
          log("WARN", "lsp", "Queued diagnostics failed", { error: String(error) });
          job.outcome = this.outcome("server_failed", file);
        } finally {
          job.running = false;
          if (job.cancelled && this.queuedDiagnostics.get(file) === job)
            this.queuedDiagnostics.delete(file);
        }
      });
    }
    return "\nDiagnostics queued; results will arrive before completion. This is not verification.";
  }

  /** Includes completed evidence not yet delivered to the agent. */
  hasQueuedDiagnostics(): boolean {
    return (
      [...this.queuedDiagnostics.values()].some((job) => !job.cancelled) || this.diagnosticsOverflow
    );
  }

  /** Wait only at the completion boundary, or return immediately on cancellation. */
  async flushDiagnostics(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.shutDown) return;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([
        Promise.all(
          [...this.queuedDiagnostics.values()]
            .filter((job) => !job.cancelled)
            .map((job) => job.work),
        ),
        aborted,
      ]);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Deliver completed, latest-write evidence once; silence is never a clean verdict. */
  drainDiagnostics(includeUnverified = true, options: { deferUnverified?: boolean } = {}): string {
    const results: string[] = [];
    for (const [file, job] of this.queuedDiagnostics) {
      if (job.running || job.cancelled || !job.outcome) continue;
      const outcome = job.outcome;
      // Keep unavailable results for one completion summary. Actual diagnostics
      // remain immediate, and successful independent verification can clear the
      // queued notice without relabelling the underlying timeout as clean.
      if (
        includeUnverified &&
        options.deferUnverified &&
        !(outcome.kind === "diagnostics" && outcome.formatted) &&
        outcome.kind !== "clean" &&
        outcome.kind !== "unsupported"
      )
        continue;
      this.queuedDiagnostics.delete(file);
      if (outcome.kind === "diagnostics" && outcome.formatted) results.push(outcome.formatted);
      else if (includeUnverified && outcome.kind !== "clean" && outcome.kind !== "unsupported") {
        results.push(
          `${path.relative(this.cwd, file)}: diagnostics ${outcome.kind}; not verified. Run the project checks; do not infer success from silence.`,
        );
      }
    }
    if (this.diagnosticsOverflow && !(includeUnverified && options.deferUnverified)) {
      if (includeUnverified)
        results.push(
          "Diagnostics capacity was exceeded; some changes are not verified. Run the project checks.",
        );
      this.diagnosticsOverflow = false;
    }
    return results.length
      ? `Post-edit diagnostics for the latest queued changes:\n${results.join("\n")}\nAddress reported errors before completion. These diagnostics do not replace the project's verification checks.`
      : "";
  }

  /** Forget a cancelled run's deliveries; bounded in-flight work may still warm its server. */
  clearPendingDiagnostics(): void {
    for (const [file, job] of this.queuedDiagnostics) {
      this.diagnosticRequests.delete(file);
      this.latestOutcomes.delete(file);
      job.next = undefined;
      job.outcome = undefined;
      job.cancelled = true;
      // Keep an in-flight predecessor until it settles: push-only servers can
      // send unversioned replies, so a new run must not race the cancelled one.
      if (!job.running) this.queuedDiagnostics.delete(file);
    }
    this.diagnosticsOverflow = false;
  }

  /**
   * Compatibility surface used by synchronous diagnostic callers. Diagnostics remain visible;
   * every clean/degraded outcome remains the exact historical empty string.
   *
   * When a baseline is available, the diagnostics are labelled as caused by
   * this edit or as pre-existing. Without that label the two are
   * indistinguishable in the output, so the model cannot tell "you just broke
   * this" from "this file was already failing" — and neither can we.
   */
  async diagnosticsAfterWrite(
    filePath: string,
    content: string,
    source?: EditSource,
  ): Promise<string> {
    // Read before collecting: the collect below overwrites this entry, and the
    // value standing here now is the state as of the previous edit.
    const before = this.errorBaseline(filePath);
    const outcome = await this.diagnosticsAfterWriteDetailed(filePath, content);
    if (outcome.kind !== "diagnostics") return "";
    return (
      outcome.formatted +
      this.attribute(outcome.filePath, before, errorCount(outcome.diagnostics), source)
    );
  }

  /**
   * How many errors this file had at the end of the last collect, or null when
   * nothing is known about it yet.
   *
   * Deliberately cache-only: re-running a full collect against the pre-edit
   * content would double every edit's LSP cost to answer a question that is
   * usually already answered. Degraded outcomes (timeout, server_failed) stay
   * null rather than being read as "clean", which would invent regressions.
   *
   * simplification: the cached count describes the file as of OUR last write,
   * so an edit made outside the session in between is attributed to this edit.
   * Upgrade path: stamp the outcome with the file's mtime and drop the baseline
   * when it no longer matches.
   */
  private errorBaseline(filePath: string): number | null {
    const outcome = this.getLatestOutcome(filePath);
    if (!outcome) return null;
    if (outcome.kind === "clean") return 0;
    if (outcome.kind === "diagnostics") return errorCount(outcome.diagnostics);
    return null;
  }

  /** Label the diagnostics against the baseline; empty when nothing is known. */
  private attribute(
    filePath: string,
    before: number | null,
    after: number,
    source?: EditSource,
  ): string {
    if (before === null || after === 0) return "";
    const introduced = after - before;
    if (introduced <= 0) {
      return `\n(already present before this change, not caused by it)`;
    }
    recordEditRegression({ filePath, before, after, source });
    return `\n(this change introduced ${introduced} error${introduced === 1 ? "" : "s"} that ${introduced === 1 ? "was" : "were"} not present before it)`;
  }

  /** Collect diagnostics with explicit confidence/failure evidence. */
  async diagnosticsAfterWriteDetailed(
    filePath: string,
    content: string,
  ): Promise<LspDiagnosticOutcome> {
    const normalizedFilePath = path.resolve(this.cwd, filePath);
    if (this.shutDown) return this.outcome("unavailable", normalizedFilePath);
    const request = {};
    this.diagnosticRequests.delete(normalizedFilePath);
    this.diagnosticRequests.set(normalizedFilePath, request);
    while (this.diagnosticRequests.size > this.snapshotLimit) {
      const oldest = this.diagnosticRequests.keys().next().value;
      if (oldest !== undefined) this.diagnosticRequests.delete(oldest);
    }
    const record = (outcome: LspDiagnosticOutcome): LspDiagnosticOutcome =>
      !this.shutDown && this.diagnosticRequests.get(normalizedFilePath) === request
        ? this.record(outcome)
        : outcome;

    try {
      const spec = serverForFile(normalizedFilePath, this.catalog);
      if (!spec) return record(this.outcome("unsupported", normalizedFilePath));
      const root = findProjectRoot(normalizedFilePath, spec.rootMarkers, this.cwd);
      const key = `${spec.id}\u0000${root}`;
      const budgetMs = this.isWarm(key, spec, root) ? this.warmBudgetMs : this.firstBudgetMs;
      const work = this.collect(key, spec, root, normalizedFilePath, content, budgetMs);

      // Leave slow initialization/indexing alive to warm the next edit. Record
      // its eventual evidence too, but report this call honestly as timed out.
      const outcome = await withBudget(work, budgetMs, () =>
        this.outcome("timeout", normalizedFilePath),
      );
      if (outcome.kind === "timeout") {
        void work.then(record).catch(() => {});
      }
      return record(outcome);
    } catch (error) {
      log("WARN", "lsp", `diagnostics failed for ${normalizedFilePath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return record(this.outcome("server_failed", normalizedFilePath));
    }
  }

  /** Latest bounded evidence for one normalized absolute/relative file path. */
  getLatestOutcome(filePath: string): LspDiagnosticOutcome | undefined {
    return this.latestOutcomes.get(path.resolve(this.cwd, filePath));
  }

  /**
   * Has this session already completed a pass against the server that is live
   * NOW? False once the pool has rebuilt it, because the replacement is cold.
   */
  private isWarm(key: string, spec: LspServerSpec, root: string): boolean {
    const warmedGeneration = this.warmKeys.get(key);
    return (
      warmedGeneration !== undefined && warmedGeneration === this.pool.generationFor(spec, root)
    );
  }

  /**
   * Retained stderr of a language server this session is using, for failure
   * reporting when a server accepts a document and then never answers.
   */
  serverStderrTail(): Promise<string> {
    return this.pool.stderrTail(this);
  }

  /** Newest retained per-file evidence snapshots. */
  getLatestOutcomes(): LspDiagnosticOutcome[] {
    return [...this.latestOutcomes.values()].reverse();
  }

  /**
   * Release this session's claim on every server it used. Safe in process exit
   * handlers.
   *
   * This drops REFERENCES, not processes: a server another session still holds
   * keeps running, and one left with no holders is shut down immediately. The
   * name is kept because every caller wires it into an exit path.
   */
  shutdownAll(): void {
    this.shutDown = true;
    this.clearPendingDiagnostics();
    this.queuedDiagnostics.clear();
    this.diagnosticRequests.clear();
    this.pool.release(this);
    this.warmKeys.clear();
  }

  private outcome(
    kind: Exclude<LspOutcomeKind, "diagnostics">,
    filePath: string,
  ): LspDiagnosticOutcome {
    return { kind, filePath, updatedAt: Date.now() };
  }

  private record(outcome: LspDiagnosticOutcome): LspDiagnosticOutcome {
    this.latestOutcomes.delete(outcome.filePath);
    this.latestOutcomes.set(outcome.filePath, outcome);
    while (this.latestOutcomes.size > this.snapshotLimit) {
      const oldest = this.latestOutcomes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.latestOutcomes.delete(oldest);
    }
    return outcome;
  }

  private async collect(
    key: string,
    spec: LspServerSpec,
    root: string,
    filePath: string,
    content: string,
    budgetMs: number,
  ): Promise<LspDiagnosticOutcome> {
    // The caller races this whole function against `budgetMs`, so every wait in
    // here has to fit inside the same deadline or a good answer arrives after
    // the caller has already given up and reported a timeout.
    const deadline = Date.now() + budgetMs;
    const resolution = await this.pool.retain(spec, root, this);
    if (this.shutDown) return this.outcome("unavailable", filePath);
    if (Date.now() >= deadline) return this.outcome("timeout", filePath);
    if (resolution.status !== "ready") return this.outcome(resolution.status, filePath);
    const { client } = resolution;
    if (!client.isAlive) {
      this.pool.markDead(spec, root);
      log("WARN", "lsp", `${spec.id} server died`, { root });
      return this.outcome("server_failed", filePath);
    }

    // Hold the entry open for the whole pass: a first-file load can take
    // seconds, and the idle sweep must not reclaim a server that is mid-answer.
    const endCall = this.pool.beginCall(spec, root);
    try {
      return await client.withDocumentDiagnostics(filePath, async () => {
        if (this.shutDown) return this.outcome("unavailable", filePath);
        if (Date.now() >= deadline) return this.outcome("timeout", filePath);
        return this.collectFrom(client, key, spec, root, filePath, content, budgetMs, deadline);
      });
    } finally {
      endCall();
    }
  }

  /** The diagnostics exchange itself, against an initialized live client. */
  private async collectFrom(
    client: LspClient,
    key: string,
    spec: LspServerSpec,
    root: string,
    filePath: string,
    content: string,
    budgetMs: number,
    deadline: number,
  ): Promise<LspDiagnosticOutcome> {
    // Sampled BEFORE the collect: a cold client is the one that has to load the
    // project, and therefore the only one that can answer prematurely.
    const wasCold = !this.isWarm(key, spec, root);
    const uri = client.syncDocument(filePath, content);
    const version = client.documentVersion(uri);
    let diagnostics = await client.collectDiagnostics(uri, Math.max(1, deadline - Date.now()));
    // Record WHICH build of the server went warm, so a later reclamation of it
    // is detectable rather than silently inherited as warm.
    this.warmKeys.set(key, this.pool.generationFor(spec, root));
    if (!client.isAlive) {
      this.pool.markDead(spec, root);
      return this.outcome("server_failed", filePath);
    }
    if (diagnostics === null) {
      // A timeout carries no other evidence and is indistinguishable from
      // "clean" in the tool output. Log the server's own stderr alongside it —
      // usually the only thing that explains why a server accepted the document
      // and then never reported on it.
      log("WARN", "lsp", `${spec.id} diagnostics timed out`, {
        file: filePath,
        budgetMs,
        stderr: client.stderrTail() || "(none)",
      });
      return this.outcome("timeout", filePath);
    }

    // An empty FIRST answer from a server that was loading the project is not a
    // verdict yet: tsserver ends its load progress and publishes an empty set
    // before it type-checks, so this used to report a broken file as clean and
    // inline diagnostics silently did nothing on the first edit in a project.
    // Give it a bounded moment to correct itself. A follow-up that is ALSO empty
    // changes nothing, so a genuinely clean file still lands on `clean`.
    if (diagnostics.length === 0 && wasCold && client.hasReportedProgress && client.isAlive) {
      const settleMs = Math.min(this.settleMs, deadline - Date.now());
      if (settleMs > 0) {
        const corrected = await client.awaitNextPublish(uri, settleMs);
        if (corrected !== null && corrected.length > 0) diagnostics = corrected;
      }
    }

    if (client.documentVersion(uri) !== version) return this.outcome("timeout", filePath);
    if (diagnostics.length > 0) {
      const relPath = path.relative(this.cwd, filePath);
      return {
        kind: "diagnostics",
        filePath,
        updatedAt: Date.now(),
        diagnostics,
        formatted: formatDiagnostics(relPath, diagnostics),
      };
    }
    return this.outcome(
      client.hasActiveProgress || client.hasUncertainDiagnostics(uri) ? "low_confidence" : "clean",
      filePath,
    );
  }

  // ── Navigation ───────────────────────────────────────────────

  /** Where the symbol under `position` is defined. */
  definition(filePath: string, content: string, position: LspPosition) {
    return this.navigate(filePath, content, (client, uri, budgetMs) =>
      client.definition(uri, position, budgetMs),
    );
  }

  /** Every reference to the symbol under `position`. */
  references(filePath: string, content: string, position: LspPosition) {
    return this.navigate(filePath, content, (client, uri, budgetMs) =>
      client.references(uri, position, budgetMs),
    );
  }

  /** Symbol outline for one document. */
  documentSymbols(filePath: string, content: string) {
    return this.navigate(filePath, content, (client, uri, budgetMs) =>
      client.documentSymbols(uri, budgetMs),
    );
  }

  /** Type/signature summary under `position`. */
  hover(filePath: string, content: string, position: LspPosition) {
    return this.navigate(filePath, content, (client, uri, budgetMs) =>
      client.hover(uri, position, budgetMs),
    );
  }

  /**
   * Shared navigation path: resolve a server, sync the document, run one
   * request inside the same warm/first budget split diagnostics use.
   *
   * The outcome kinds match `LspDiagnosticOutcome`'s degraded kinds exactly
   * (`timeout` / `unsupported` / `unavailable` / `server_failed`), because a
   * navigation tool that answers "no results" when the truth is "no server"
   * teaches the model that the symbol does not exist.
   */
  private async navigate<T>(
    filePath: string,
    content: string,
    run: (client: LspClient, uri: string, budgetMs: number) => Promise<LspRequestOutcome<T>>,
  ): Promise<LspNavigationOutcome<T>> {
    const normalizedFilePath = path.resolve(this.cwd, filePath);
    if (this.shutDown) return { kind: "unavailable", filePath: normalizedFilePath };

    try {
      const spec = serverForFile(normalizedFilePath, this.catalog);
      if (!spec) return { kind: "unsupported", filePath: normalizedFilePath };
      const root = findProjectRoot(normalizedFilePath, spec.rootMarkers, this.cwd);
      const key = `${spec.id}\u0000${root}`;
      const budgetMs = this.isWarm(key, spec, root) ? this.warmBudgetMs : this.firstBudgetMs;

      const resolution = await this.pool.retain(spec, root, this);
      if (resolution.status !== "ready") {
        return { kind: resolution.status, filePath: normalizedFilePath, serverId: spec.id };
      }
      const { client } = resolution;
      if (!client.isAlive) {
        this.pool.markDead(spec, root);
        return { kind: "server_failed", filePath: normalizedFilePath, serverId: spec.id };
      }

      // Hold the entry open for the whole request, exactly as diagnostics do:
      // the idle sweep must not reclaim a server mid-answer.
      const endCall = this.pool.beginCall(spec, root);
      try {
        const uri = client.syncDocument(normalizedFilePath, content);
        const outcome = await withBudget(run(client, uri, budgetMs), budgetMs, () => ({
          status: "timeout" as const,
        }));
        this.warmKeys.set(key, this.pool.generationFor(spec, root));
        if (outcome.status === "ok") {
          return {
            kind: "ok",
            filePath: normalizedFilePath,
            serverId: spec.id,
            value: outcome.value,
          };
        }
        if (outcome.status === "unsupported") {
          return { kind: "unsupported", filePath: normalizedFilePath, serverId: spec.id };
        }
        if (outcome.status === "timeout") {
          log("WARN", "lsp", `${spec.id} navigation timed out`, {
            file: normalizedFilePath,
            budgetMs,
            stderr: client.stderrTail() || "(none)",
          });
          return { kind: "timeout", filePath: normalizedFilePath, serverId: spec.id };
        }
        return {
          kind: "server_failed",
          filePath: normalizedFilePath,
          serverId: spec.id,
          message: outcome.message,
        };
      } finally {
        endCall();
      }
    } catch (error) {
      log("WARN", "lsp", `navigation failed for ${normalizedFilePath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return { kind: "server_failed", filePath: normalizedFilePath };
    }
  }
}

/** Race work against a hard budget while allowing it to settle in background. */

function withBudget<T>(work: Promise<T>, budgetMs: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), budgetMs);
    timer.unref();
    work
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(onTimeout());
      });
  });
}
