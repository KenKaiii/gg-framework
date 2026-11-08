import fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, createReadStream, type ReadStream } from "node:fs";
import type { Dirent, Stats } from "node:fs";

/**
 * Largest file any tool will pull into memory at once.
 *
 * We run ONE shared Node daemon per app process (see CLAUDE.md), so an
 * unbounded `readFile` is not merely a slow read — it is every open window
 * dying together when a multi-GB artifact lands in the heap. 20 MiB sits far
 * above any source file (`read` itself only ever emits 50 KB of text) while
 * still admitting a large image before the shrink pass.
 */
export const MAX_READ_BYTES = 20 * 1024 * 1024;

/** The file exists but is too large to load; carries the numbers for the message. */
export class FileTooLargeError extends Error {
  constructor(
    readonly filePath: string,
    readonly size: number,
    readonly limit: number,
  ) {
    super(
      `File is ${(size / (1024 * 1024)).toFixed(1)} MB, over the ` +
        `${Math.round(limit / (1024 * 1024))} MB read limit: ${filePath}`,
    );
    this.name = "FileTooLargeError";
  }
}

/** The path resolved to something that is not a regular file (fifo, device, socket). */
export class NotRegularFileError extends Error {
  constructor(readonly filePath: string) {
    super(`Not a regular file: ${filePath}`);
    this.name = "NotRegularFileError";
  }
}

/** A symlink was found where a regular file was required. */
export class SymlinkRefusedError extends Error {
  constructor(readonly filePath: string) {
    super(`Refusing to follow symlink: ${filePath}`);
    this.name = "SymlinkRefusedError";
  }
}

/**
 * Read a whole file, refusing anything over `limit` bytes.
 *
 * Opens ONCE and judges the file from that same handle, so what we checked is
 * what we read. The alternative — `lstat()` the path, then `readFile()` the
 * path — inspects one file and reads whatever occupies the name a moment
 * later, which is exactly how a swapped symlink gets its target read.
 *
 * Three flags, three different holes:
 * - `O_NOFOLLOW` makes the kernel fail with ELOOP if the final component is a
 *   symlink, so the refusal happens atomically at open rather than in a
 *   separate syscall a caller could race.
 * - `O_NONBLOCK` stops the open itself parking forever on a fifo (a named pipe
 *   called `x.png` would otherwise hang the tool call with no timeout); the
 *   non-regular check then rejects it, and regular files ignore the flag.
 * - The size check bounds memory before a single byte is read.
 *
 * Windows defines neither flag (`?? 0` degrades to a plain read) and offers no
 * path-reachable fifo here; `resolvePath` plus the sandbox still contain it.
 */
export async function readFileBounded(
  filePath: string,
  limit: number = MAX_READ_BYTES,
): Promise<Buffer> {
  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  let handle;
  try {
    handle = await fs.open(filePath, flags);
  } catch (err) {
    // ELOOP here means O_NOFOLLOW refused a symlink — report that plainly
    // rather than as a mystery open failure.
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new SymlinkRefusedError(filePath);
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new NotRegularFileError(filePath);
    if (stat.size > limit) throw new FileTooLargeError(filePath, stat.size, limit);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Abstraction over filesystem and process operations.
 * Default implementation uses local Node.js APIs.
 * Replace with SSH/Docker/cloud implementations for remote execution.
 */
export interface ToolOperations {
  /** Read a file's contents as UTF-8 string. */
  readFile(path: string): Promise<string>;

  /** Write content to a file. Creates parent directories if needed. */
  writeFile(path: string, content: string): Promise<void>;

  /** Get file/directory stats. */
  stat(path: string): Promise<Stats>;

  /** Check if a path is a symbolic link. */
  lstat(path: string): Promise<Stats>;

  /** Read directory contents with file type info. */
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;

  /** Create a directory (recursive). */
  mkdir(path: string): Promise<void>;

  /** Create a readable stream for a file. */
  createReadStream(path: string, encoding: BufferEncoding): ReadStream;

  /** Spawn a child process. Returns the ChildProcess handle. */
  spawn(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env?: Record<string, string>;
      detached?: boolean;
      stdio?: Array<"pipe" | "ignore">;
    },
  ): ChildProcess;
}

/**
 * Default local filesystem + process operations.
 * This is what tools use when running on the local machine.
 */
export const localOperations: ToolOperations = {
  // Bounded deliberately: this is the chokepoint every file-reading tool goes
  // through (read, edit), so the cap lives here once
  // rather than in each caller. A remote implementation owns its own bound.
  readFile: async (path) => (await readFileBounded(path)).toString("utf-8"),

  writeFile: async (path, content) => {
    const { dirname } = await import("node:path");
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, content, "utf-8");
  },

  stat: (path) => fs.stat(path),

  lstat: (path) => fs.lstat(path),

  readdir: (path, options) => fs.readdir(path, options) as Promise<Dirent[]>,

  mkdir: (path) => fs.mkdir(path, { recursive: true }).then(() => {}),

  createReadStream: (path, encoding) => createReadStream(path, { encoding }),

  spawn: (command, args, options) =>
    spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: options.detached,
      stdio: options.stdio as Parameters<typeof spawn>[2] extends { stdio: infer S } ? S : never,
    }),
};
