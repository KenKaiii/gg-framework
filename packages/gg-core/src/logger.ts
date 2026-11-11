import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { environmentSecrets, redactText, redactValue } from "@kenkaiiii/gg-ai";

export type LogLevel = "INFO" | "ERROR" | "WARN" | "DEBUG";

// Cross-session log retention: the log is appended across launches so you can
// grep back through prior sessions. Rotated at MAX_BYTES to keep it bounded; we
// keep three generations (debug.log.1 newest … .3 oldest). One generation held
// under a day of a busy app daemon, too little to review a week's incident.
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ROTATED_GENERATIONS = 3;

/**
 * Rotate when fewer than this many bytes remain, instead of only at/over the cap.
 *
 * A process that hits the cap mid-run stops writing at whatever size it reached,
 * which can be a hair UNDER MAX_BYTES. Rotating only at `size >= MAX_BYTES` then
 * wedges the log permanently: every later launch reopens the same near-full file,
 * has no room for a single line, and disables its own logging immediately — so the
 * file can never grow enough to qualify for rotation. That silently cost the app
 * sidecar ~2 weeks of diagnostics (the file sat 4 bytes short of the cap, gaining
 * one newline per launch). Requiring real headroom guarantees forward progress.
 */
const MIN_HEADROOM_BYTES = 64 * 1024; // 64 KB

let fd: number | null = null;
let logPath: string | null = null;
/** Current size of the open log file, including earlier launches' lines. Drives rotation. */
let fileBytes = 0;
/**
 * Bytes THIS process has written. Drives the hard per-process cap. Kept apart
 * from `fileBytes` because the file is shared across launches: a long-lived
 * daemon that started next to a nearly full file used to inherit that size as
 * its own budget, hit the cap within minutes, and log nothing for days.
 */
let processBytes = 0;
/** Set when a mid-run rotation could not shrink the file; stop retrying it per line. */
let rotationFailed = false;
let capped = false;
let sessionId = "";
let appName = "app";
let cleanups: (() => void)[] = [];
let exactSecrets: string[] = [];

function rotateIfNeeded(filePath: string, force = false): void {
  try {
    const st = fs.statSync(filePath);
    if (!force && st.size <= MAX_BYTES - MIN_HEADROOM_BYTES) return;
    const rotated = `${filePath}.1`;
    // Age the older generations first: .2 → .3, then .1 → .2. A step that fails
    // (no such generation, or a Windows sharing violation) is skipped.
    for (let generation = ROTATED_GENERATIONS - 1; generation >= 1; generation--) {
      const older = `${filePath}.${generation + 1}`;
      try {
        fs.unlinkSync(older);
      } catch {
        // Nothing that old yet
      }
      try {
        fs.renameSync(`${filePath}.${generation}`, older);
      } catch {
        // No such generation
      }
    }
    // Replace prior rotation (fs.renameSync overwrites on POSIX; on Windows it
    // fails if dest exists, so unlink first defensively).
    try {
      fs.unlinkSync(rotated);
    } catch {
      // No prior rotation
    }
    fs.renameSync(filePath, rotated);
  } catch {
    // Log file doesn't exist yet or stat failed — nothing to rotate
  }
}

/**
 * The shared file filled up while this process still has write budget: move it
 * to `.1` and continue in a fresh file. Returns false if logging had to stop.
 */
function rotateOpenLog(): boolean {
  if (fd === null || logPath === null) return false;
  const sizeBefore = fileBytes;
  try {
    fs.closeSync(fd);
  } catch {
    // Closing a descriptor we are about to replace; nothing to recover.
  }
  fd = null;
  rotateIfNeeded(logPath, true);
  try {
    fd = fs.openSync(logPath, "a");
    fileBytes = fs.fstatSync(fd).size;
  } catch {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore cleanup failure
      }
    }
    fd = null;
    capped = true;
    return false;
  }
  // Rename can fail (e.g. Windows sharing violations); the per-process cap still
  // bounds writes, so keep logging into the same file instead of retrying a
  // rename on every line.
  if (fileBytes >= sizeBefore) rotationFailed = true;
  return true;
}

/**
 * Open the debug log in append mode, tagging this process with a session id and
 * remembering `name` for the shutdown line. Idempotent — re-calling while open
 * is a no-op. Returns true only when it *newly* opened the file (so callers can
 * write a one-time startup line); returns false if already open or if the file
 * could not be opened.
 */
export function openLog(filePath: string, name: string): boolean {
  if (fd !== null || capped) return false;
  appName = name;
  exactSecrets = environmentSecrets(process.env);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  } catch {
    // Directory may already exist or be uncreatable — fall through to open
  }
  rotateIfNeeded(filePath);
  try {
    fd = fs.openSync(filePath, "a");
  } catch {
    // Can't open log file — silently disable logging
    fd = null;
    fileBytes = 0;
    return false;
  }
  try {
    fileBytes = fs.fstatSync(fd).size;
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore cleanup failure
    }
    fd = null;
    fileBytes = 0;
    return false;
  }
  logPath = filePath;
  processBytes = 0;
  rotationFailed = false;
  sessionId = randomBytes(4).toString("hex");
  // Visible separator between sessions when back-reading the log.
  try {
    if (fileBytes < MAX_BYTES) {
      const written = fs.writeSync(fd, "\n");
      fileBytes += written;
      processBytes += written;
    }
  } catch {
    // Write failed — proceed without the separator
  }
  return true;
}

/** Session identifier included on every log line as `sid=<id>`. */
export function getSessionId(): string {
  return sessionId;
}

/** True if the logger has an open file descriptor. */
export function isLoggerOpen(): boolean {
  return fd !== null;
}

/** Write a timestamped log line. No-op if the logger is not open. */
export function log(
  level: LogLevel,
  category: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (fd === null) return;
  const ts = new Date().toISOString();
  const safeMessage = redactText(message, { secrets: exactSecrets });
  let line = `[${ts}] [sid=${sessionId}] [${level}] [${category}] ${safeMessage}`;
  if (data) {
    const safeData = redactValue(data, { secrets: exactSecrets });
    const pairs = Object.entries(safeData)
      .map(([k, v]) => {
        if (typeof v === "string") return `${k}=${v}`;
        if (typeof v === "bigint") return `${k}=${String(v)}`;
        return `${k}=${JSON.stringify(v)}`;
      })
      .join(" ");
    if (pairs) line += ` ${pairs}`;
  }
  line += "\n";

  const lineBytes = Buffer.byteLength(line);
  if (processBytes + lineBytes > MAX_BYTES) {
    // A noisy production path must not turn one long-lived process into an
    // unbounded SSD writer. Stop file logging for this process once IT has
    // written MAX_BYTES; later launches get a fresh budget.
    const capLine = `[${ts}] [sid=${sessionId}] [WARN] [logger] Log cap reached; file logging disabled until restart\n`;
    try {
      if (fileBytes + Buffer.byteLength(capLine) <= MAX_BYTES) {
        fileBytes += fs.writeSync(fd, capLine);
      }
      fs.closeSync(fd);
    } catch {
      // Write/close failure still disables logging below.
    }
    fd = null;
    capped = true;
    return;
  }

  // The shared file is full but this process still has budget: rotate and
  // keep logging rather than going dark for the rest of a long-lived run.
  if (fileBytes + lineBytes > MAX_BYTES && !rotationFailed && !rotateOpenLog()) return;
  if (fd === null) return;

  try {
    const written = fs.writeSync(fd, line);
    fileBytes += written;
    processBytes += written;
  } catch {
    // Write failed — don't crash
  }
}

/**
 * Register a cleanup callback (e.g. an EventBus unsubscriber) to run when the
 * logger closes. Lets app-side bridges hook into the shared lifecycle without
 * the core needing to know about app types.
 */
export function registerLogCleanup(fn: () => void): void {
  cleanups.push(fn);
}

/**
 * Write a shutdown line (unless suppressed), close the file descriptor, and run
 * any registered cleanups.
 */
export function closeLogger(opts?: { shutdownLine?: boolean }): void {
  if (fd !== null) {
    if (opts?.shutdownLine !== false) log("INFO", "shutdown", `${appName} shutting down`);
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      // Ignore close errors
    }
  }
  fd = null;
  logPath = null;
  fileBytes = 0;
  processBytes = 0;
  rotationFailed = false;
  capped = false;
  exactSecrets = [];
  for (const unsub of cleanups) unsub();
  cleanups = [];
}
