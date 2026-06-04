import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type LogLevel = "INFO" | "ERROR" | "WARN" | "DEBUG";

// Cross-session log retention: the log is appended across launches so you can
// grep back through prior sessions. Rotated at MAX_BYTES to keep it bounded; we
// keep one generation (debug.log.1) — enough to survive one rotation's worth of
// scrollback while bounding disk usage.
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

let fd: number | null = null;
let sessionId = "";
let appName = "app";
let cleanups: (() => void)[] = [];

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
  if (fd !== null) return false;
  appName = name;
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
    return false;
  }
  sessionId = randomBytes(4).toString("hex");
  // Visible separator between sessions when back-reading the log.
  try {
    fs.writeSync(fd, "\n");
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
  let line = `[${ts}] [sid=${sessionId}] [${level}] [${category}] ${message}`;
  if (data) {
    const pairs = Object.entries(data)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    if (pairs) line += ` ${pairs}`;
  }
  line += "\n";
  try {
    fs.writeSync(fd, line);
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
  if (fd === null) return;
  if (opts?.shutdownLine !== false) log("INFO", "shutdown", `${appName} shutting down`);
  try {
    fs.closeSync(fd);
  } catch {
    // Ignore close errors
  }
  fd = null;
  for (const unsub of cleanups) unsub();
  cleanups = [];
}
