import fs from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const STALE_TIMEOUT_MS = 10_000; // Lock is stale after 10s
const RETRY_INTERVAL_MS = 50; // Retry every 50ms
const MAX_WAIT_MS = 5_000; // Give up after 5s
// Windows refuses `wx` with one of these, not EEXIST, while a released lock is pending delete.
const PENDING_DELETE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

interface LockInfo {
  pid: number;
  timestamp: number;
}

/**
 * Simple file-based lock with PID tracking and stale detection.
 * Uses atomic file creation (wx flag) to prevent races.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = filePath + ".lock";
  await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath);
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const startTime = Date.now();
  let refusedWithoutLock = 0;

  while (true) {
    try {
      // O_EXCL: fail if file exists — atomic lock acquisition
      const info: LockInfo = { pid: process.pid, timestamp: Date.now() };
      await fs.writeFile(lockPath, JSON.stringify(info), { flag: "wx" });
      return; // Lock acquired
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        if (process.platform !== "win32" || !code || !PENDING_DELETE_CODES.has(code)) throw err;
        // A refusal that persists without a lock file, or past the wait budget, is a real fault.
        const lockPresent = await lockFileExists(lockPath);
        if (!lockPresent && ++refusedWithoutLock > 3) throw err;
        if (Date.now() - startTime > MAX_WAIT_MS) throw err;
        await setTimeout(RETRY_INTERVAL_MS);
        continue;
      }

      // Lock file exists — check if it's stale
      try {
        const content = await fs.readFile(lockPath, "utf-8");
        const info = JSON.parse(content) as LockInfo;

        // Check if the holding process is still alive
        const isProcessAlive = isAlive(info.pid);
        const isStale = Date.now() - info.timestamp > STALE_TIMEOUT_MS;

        if (!isProcessAlive || isStale) {
          // Stale lock — remove and retry
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        // Unreadable: released meanwhile, just created and not yet written (a
        // live holder — deleting it let two writers in), or truly corrupt.
        const stat = await fs.stat(lockPath).catch(() => null);
        if (!stat) continue;
        if (Date.now() - stat.mtimeMs > STALE_TIMEOUT_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      }

      // Lock is held by a live process — wait and retry
      if (Date.now() - startTime > MAX_WAIT_MS) {
        // Timeout — force break the lock (better than deadlocking)
        await fs.unlink(lockPath).catch(() => {});
        continue;
      }

      await setTimeout(RETRY_INTERVAL_MS);
    }
  }
}

async function lockFileExists(lockPath: string): Promise<boolean> {
  try {
    await fs.stat(lockPath);
    return true;
  } catch (err) {
    // A refused stat means the file is still there, mid-delete.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await fs.unlink(lockPath).catch(() => {});
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence without killing
    return true;
  } catch (err) {
    // EPERM = process exists but belongs to a different user — still alive
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    // ESRCH = no such process — it's dead
    return false;
  }
}
