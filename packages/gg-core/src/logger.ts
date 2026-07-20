import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { environmentSecrets, redactText, redactValue } from "@kenkaiiii/gg-ai";

export type LogLevel = "INFO" | "ERROR" | "WARN" | "DEBUG";

// Cross-session log retention: the log is appended across launches so you can
// grep back through prior sessions. Rotated at MAX_BYTES to keep it bounded; we
// keep one generation (debug.log.1) — enough to survive one rotation's worth of
// scrollback while bounding disk usage.
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

let fd: number | null = null;
let bytesWritten = 0;
let capped = false;
let sessionId = "";
let appName = "app";
let cleanups: (() => void)[] = [];
let exactSecrets: string[] = [];

function rotateIfNeeded(filePath: string): void {
  try {
    const st = fs.statSync(filePath);
    if (st.size < MAX_BYTES) return;
    const rotated = `${filePath}.1`;
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
    bytesWritten = 0;
    return false;
  }
  try {
    bytesWritten = fs.fstatSync(fd).size;
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore cleanup failure
    }
    fd = null;
    bytesWritten = 0;
    return false;
  }
  sessionId = randomBytes(4).toString("hex");
  // Visible separator between sessions when back-reading the log.
  try {
    if (bytesWritten < MAX_BYTES) {
      bytesWritten += fs.writeSync(fd, "\n");
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
  if (bytesWritten + lineBytes > MAX_BYTES) {
    // A noisy production path must not turn one long-lived process into an
    // unbounded SSD writer. Stop file logging for this process at the hard cap;
    // later launches can use any remaining budget and rotate once it is full.
    const capLine = `[${ts}] [sid=${sessionId}] [WARN] [logger] Log cap reached; file logging disabled until restart\n`;
    try {
      if (bytesWritten + Buffer.byteLength(capLine) <= MAX_BYTES) {
        bytesWritten += fs.writeSync(fd, capLine);
      }
      fs.closeSync(fd);
    } catch {
      // Write/close failure still disables logging below.
    }
    fd = null;
    capped = true;
    return;
  }

  try {
    bytesWritten += fs.writeSync(fd, line);
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
  bytesWritten = 0;
  capped = false;
  exactSecrets = [];
  for (const unsub of cleanups) unsub();
  cleanups = [];
}
