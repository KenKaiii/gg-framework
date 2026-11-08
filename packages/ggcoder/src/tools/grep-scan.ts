/**
 * The in-process grep engine: one search implementation shared by the main
 * thread and a small pool of worker threads.
 *
 * Why workers: on a warm page cache, a scan is per-file syscall and callback
 * overhead, and every async `fs` call funnels through the main thread's event
 * loop. Workers reading synchronously in parallel halve the scan time and keep
 * the daemon's event loop free while they do it. Measured on macOS, four
 * workers beat both fewer and more (more contend on file-open locks).
 *
 * The three functions marked SELF-CONTAINED are serialized into the worker
 * with `Function.prototype.toString`, so the worker runs the exact code the
 * main thread runs. They may reference only their parameters and globals —
 * no imports, no module constants. The sidecar is one bundled file, so the
 * worker is built from source text rather than loaded from a separate module.
 */
import type fs from "node:fs";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { log } from "../core/logger.js";

export interface ScanTextOptions {
  source: string;
  flags: string;
  /** Reject a file with one regex pass over its whole text first (unsafe with lookaround). */
  prefilter: boolean;
  maxResults: number;
  /** Epoch ms after which the scan stops. */
  expiresAt: number;
  maxLineLength: number;
  /** Check the clock every N lines. */
  checkInterval: number;
  /** Lines checked for a NUL byte before the file is treated as binary. */
  sniffLines: number;
}

export interface ScanTextResult {
  lines: string[];
  /** The deadline passed mid-file; `lines` holds what was found before it. */
  expired: boolean;
}

/**
 * SELF-CONTAINED. Search in-memory file text with the streaming scanner's
 * semantics: same lines, same line numbers, same matches, same truncation.
 */
export function scanText(input: string, relPath: string, o: ScanTextOptions): ScanTextResult {
  let text = input;
  // readline breaks lines on `\r\n`, a lone `\r` and `\n`. Folding the first
  // two into `\n` reproduces its line numbering, and lets a multiline `$` see
  // CRLF line ends in the prefilter below.
  if (text.includes("\r")) text = text.replace(/\r\n?/g, "\n");

  // Reject the whole file in one native regex pass. Sound only when no
  // per-line match can vanish once lines sit side by side: with the `m` flag,
  // `^`/`$` still match at line boundaries and `\b` treats `\n` like the end of
  // input, so a pass over the joined text finds every per-line match (plus,
  // at most, extra ones that cross lines, which the per-line pass discards).
  if (o.prefilter && !new RegExp(o.source, `${o.flags.replace("g", "")}m`).test(text)) {
    return { lines: [], expired: false };
  }

  const regex = new RegExp(o.source, o.flags);
  const lines = text.split("\n");
  // readline emits no empty line after a trailing newline.
  if (lines[lines.length - 1] === "") lines.pop();

  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNum = i + 1;
    if (lineNum % o.checkInterval === 0 && Date.now() >= o.expiresAt) {
      return { lines: found, expired: true };
    }
    // A NUL byte early on means a binary file the extension check missed.
    if (lineNum <= o.sniffLines && line.includes("\0")) break;

    regex.lastIndex = 0;
    if (regex.test(line)) {
      let shown = line;
      if (line.length > o.maxLineLength) {
        // Same cut as gg-ai's sliceHead: never split an astral character.
        const last = line.charCodeAt(o.maxLineLength - 1);
        const end = last >= 0xd800 && last <= 0xdbff ? o.maxLineLength - 1 : o.maxLineLength;
        shown = `${line.slice(0, end)}…`;
      }
      found.push(`${relPath}:${lineNum}:${shown}`);
      if (found.length >= o.maxResults) break;
    }
  }
  return { lines: found, expired: false };
}

/** Cheap "could this file match at all?" check on undecoded bytes. */
export type ByteFilter = (bytes: Buffer) => boolean;

/**
 * SELF-CONTAINED. A filter passing only bytes that contain one of `literals`.
 *
 * Literals are ASCII only (see `requiredLiterals`): ASCII bytes never occur
 * inside a multi-byte UTF-8 sequence or its replacement, so "the bytes contain
 * it" and "the decoded text contains it" agree. For case-insensitive search
 * the bytes are viewed as latin1 (a near-free copy): non-Unicode JS case
 * folding never maps a non-ASCII character onto ASCII, so the same holds.
 */
export function makeByteFilter(
  literals: readonly string[] | undefined,
  caseInsensitive: boolean,
): ByteFilter | undefined {
  if (!literals || literals.length === 0) return undefined;
  if (caseInsensitive) {
    const escaped = literals.map((literal) => literal.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&"));
    const anyLiteral = new RegExp(escaped.join("|"), "i");
    return (bytes) => anyLiteral.test(bytes.toString("latin1"));
  }
  return (bytes) => literals.some((literal) => bytes.includes(literal));
}

/**
 * SELF-CONTAINED. Synchronously read a regular file of at most `limit` bytes
 * into `scratch`, refusing symlinks like `readFileBounded`. The returned view
 * aliases `scratch`: use it before the next call. `undefined` means "not
 * readable this way" and sends the file to the main thread's slower path.
 */
export function readSmallFileSync(
  fsModule: typeof fs,
  filePath: string,
  limit: number,
  scratch: Buffer,
): Buffer | undefined {
  const c = fsModule.constants;
  let fd: number | undefined;
  try {
    fd = fsModule.openSync(filePath, c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0));
    const stat = fsModule.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) return undefined;
    // Read to EOF, one byte past the limit, so a file that grew since the
    // stat is caught rather than silently truncated.
    let total = 0;
    for (;;) {
      const room = Math.min(scratch.length, limit + 1) - total;
      if (room <= 0) break;
      const read = fsModule.readSync(fd, scratch, total, room, null);
      if (read === 0) break;
      total += read;
    }
    return total > limit ? undefined : scratch.subarray(0, total);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fsModule.closeSync(fd);
  }
}

// ── Worker pool ─────────────────────────────────────────────

/** One file to scan: absolute path for reading, display path for output. */
export type ScanTarget = readonly [absolutePath: string, relativePath: string];

export interface ScanJob {
  files: readonly ScanTarget[];
  options: ScanTextOptions;
  literals: readonly string[] | undefined;
  caseInsensitive: boolean;
  /** Largest file read whole; larger files come back as `null`. */
  readLimit: number;
  /** Stop the chunk once this many lines are found (see `scanWithWorkers`). */
  stopAfter: number;
}

export interface ScanJobResult {
  /** Per file, in order: matched lines, or `null` for "scan on the main thread". */
  results: Array<string[] | null>;
  expired: boolean;
}

// An eval worker runs as CommonJS unless the process was started with flags
// that make it ESM (workers inherit execArgv, e.g. --input-type=module), where
// `require` does not exist. `process.getBuiltinModule` works in both.
const WORKER_SOURCE = (readLimit: number): string => `"use strict";
const load = typeof require === "function" ? require : (id) => process.getBuiltinModule(id);
const { parentPort } = load("node:worker_threads");
const fs = load("node:fs");
const scanText = ${scanText.toString()};
const makeByteFilter = ${makeByteFilter.toString()};
const readSmallFileSync = ${readSmallFileSync.toString()};
const scratch = Buffer.allocUnsafe(${readLimit + 1});
parentPort.on("message", (job) => {
  const filter = makeByteFilter(job.literals, job.caseInsensitive);
  const results = [];
  let expired = false;
  let found = 0;
  for (const [abs, rel] of job.files) {
    if (Date.now() >= job.options.expiresAt) { expired = true; break; }
    const bytes = readSmallFileSync(fs, abs, job.readLimit, scratch);
    if (bytes === undefined) { results.push(null); continue; }
    if (filter && !filter(bytes)) { results.push([]); continue; }
    const scanned = scanText(bytes.toString("utf8"), rel, job.options);
    results.push(scanned.lines);
    found += scanned.lines.length;
    if (scanned.expired) { expired = true; break; }
    if (found >= job.stopAfter) break;
  }
  parentPort.postMessage({ results, expired });
});`;

/** Idle workers cost ~7 MB each; release them between bursts of searching. */
const POOL_IDLE_MS = 30_000;
/** Four measured fastest on macOS; more contend on file-open locks. */
const MAX_POOL_SIZE = 4;

export class GrepWorkerPool {
  private readonly idle: Worker[] = [];
  private readonly waiters: Array<(worker: Worker | undefined) => void> = [];
  private readonly all: Worker[];
  private idleTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(size: number, readLimit: number) {
    const source = WORKER_SOURCE(readLimit);
    this.all = Array.from({ length: size }, () => {
      const worker = new Worker(source, { eval: true });
      // An idle pool must never keep the process alive; a busy one is ref'd.
      worker.unref();
      // A crashed worker poisons the pool: callers fall back to the main
      // thread, and the next scan builds a fresh pool.
      // Logged because the fallback is silent otherwise: results stay correct,
      // only slower, so a broken pool would never surface as a failure.
      worker.once("error", (err: unknown) => {
        log("WARN", "grep", "worker failed; scanning on the main thread", {
          message: err instanceof Error ? err.message : String(err),
        });
        this.dispose();
      });
      worker.once("exit", () => this.dispose());
      return worker;
    });
    this.idle.push(...this.all);
    this.armIdleTimer();
  }

  get size(): number {
    return this.all.length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Run one job; rejects if the pool is or becomes unusable. */
  async run(job: ScanJob): Promise<ScanJobResult> {
    const worker = await this.acquire();
    if (!worker) throw new Error("grep worker pool disposed");
    worker.ref();
    try {
      return await new Promise<ScanJobResult>((resolve, reject) => {
        const onMessage = (result: ScanJobResult): void => {
          cleanup();
          resolve(result);
        };
        const onFailure = (): void => {
          cleanup();
          reject(new Error("grep worker failed"));
        };
        const cleanup = (): void => {
          worker.off("message", onMessage);
          worker.off("error", onFailure);
          worker.off("exit", onFailure);
        };
        worker.on("message", onMessage);
        worker.on("error", onFailure);
        worker.on("exit", onFailure);
        worker.postMessage(job);
      });
    } finally {
      worker.unref();
      this.release(worker);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
    for (const worker of this.all) void worker.terminate();
  }

  private acquire(): Promise<Worker | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const worker = this.idle.pop();
    if (worker) return Promise.resolve(worker);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(worker: Worker): void {
    if (this.disposed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(worker);
      return;
    }
    this.idle.push(worker);
    if (this.idle.length === this.all.length) this.armIdleTimer();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), POOL_IDLE_MS);
    this.idleTimer.unref();
  }
}

/**
 * The process-wide pool, created on first use. Like the external-scanner
 * probe in grep.ts this is deliberately module state: workers are a
 * process resource shared by every session in the daemon.
 */
let sharedPool: GrepWorkerPool | undefined;
let workersUnavailable = false;

export function getGrepWorkerPool(readLimit: number): GrepWorkerPool | undefined {
  if (workersUnavailable) return undefined;
  if (sharedPool && !sharedPool.isDisposed) return sharedPool;
  const size = Math.min(MAX_POOL_SIZE, os.availableParallelism() - 1);
  if (size < 1) {
    workersUnavailable = true;
    return undefined;
  }
  try {
    sharedPool = new GrepWorkerPool(size, readLimit);
    return sharedPool;
  } catch (err) {
    // Worker threads unavailable in this runtime: stay on the main thread.
    log("WARN", "grep", "worker threads unavailable; scanning on the main thread", {
      message: err instanceof Error ? err.message : String(err),
    });
    workersUnavailable = true;
    return undefined;
  }
}

/** Test seam: stop the shared pool's workers. */
export function disposeGrepWorkerPool(): void {
  sharedPool?.dispose();
  sharedPool = undefined;
}
