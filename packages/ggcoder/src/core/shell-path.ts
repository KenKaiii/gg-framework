import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./logger.js";

/**
 * Resolve a usable PATH for shelling out to developer tools.
 *
 * GUI apps launched from Finder/Dock (the packaged desktop app) inherit a
 * minimal PATH — on macOS just `/usr/bin:/bin:/usr/sbin:/sbin` — which omits
 * Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`), Cargo (`~/.cargo/bin`),
 * version managers (nvm/asdf/pyenv), and most toolchains. A coding agent that
 * can't find `node`, `npm`, `git`, `python3`, `rg`, `cargo`, … is useless, so
 * we enrich the process PATH once at sidecar startup.
 *
 * Strategy (union, de-duped, order-preserving):
 *   1. The user's real login-shell PATH (captures nvm/asdf/pyenv/custom dirs).
 *   2. The current process PATH (whatever we were launched with).
 *   3. Well-known install dirs that exist on disk (fallback when 1 fails).
 *
 * No-op on Windows, where GUI apps inherit a usable PATH and there's no
 * equivalent login-shell concept.
 */

/** Well-known bin dirs a GUI PATH commonly omits, by platform. */
function wellKnownBinDirs(): readonly string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/opt/local/bin", // MacPorts
      "/opt/local/sbin",
      path.join(home, ".local", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, "go", "bin"),
      path.join(home, ".deno", "bin"),
      path.join(home, ".bun", "bin"),
    ];
  }
  if (process.platform === "linux") {
    return [
      "/usr/local/bin",
      "/usr/local/sbin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/snap/bin",
      path.join(home, ".local", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, "go", "bin"),
      path.join(home, ".deno", "bin"),
      path.join(home, ".bun", "bin"),
    ];
  }
  return [];
}

const DELIMITER = "_GG_SHELL_ENV_DELIMITER_";

/**
 * Ask the user's login shell for its PATH. Best-effort: resolves to null on any
 * error/timeout so the caller falls back to the well-known dirs. Mirrors the
 * approach used by `shell-env`/`fix-path` (delimited echo, detached to dodge a
 * zsh hang, oh-my-zsh auto-update disabled).
 */
function loginShellPath(): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(
        shell,
        ["-ilc", `echo -n "${DELIMITER}"; printf "%s" "$PATH"; echo -n "${DELIMITER}"; exit`],
        {
          // zsh can hang on stdin without detaching; matches shell-env's fix.
          detached: true,
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
        },
      );
      let out = "";
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf-8");
      });
      child.once("error", () => finish(null));
      child.once("close", () => {
        const start = out.indexOf(DELIMITER);
        const end = out.lastIndexOf(DELIMITER);
        if (start === -1 || end === -1 || end <= start) {
          finish(null);
          return;
        }
        const value = out.slice(start + DELIMITER.length, end).trim();
        finish(value || null);
      });
      // Hard cap: some shells (slow rc files) can stall; don't block startup.
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        finish(null);
      }, 5000);
      timer.unref();
    } catch {
      finish(null);
    }
  });
}

let cached: string | undefined;

/**
 * Compute the enriched PATH (login shell ∪ current ∪ existing well-known dirs).
 * Cached after first call. Order is preserved and duplicates removed.
 */
export async function resolveEnrichedPath(
  currentPath: string = process.env.PATH ?? "",
): Promise<string> {
  if (cached !== undefined) return cached;

  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string): void => {
    const d = dir.trim();
    if (d && !seen.has(d)) {
      seen.add(d);
      parts.push(d);
    }
  };

  const login = await loginShellPath();
  if (login) for (const d of login.split(path.delimiter)) add(d);
  for (const d of currentPath.split(path.delimiter)) add(d);
  // Only append fallback dirs that actually exist, so PATH stays clean.
  for (const d of wellKnownBinDirs()) if (existsSync(d)) add(d);

  cached = parts.join(path.delimiter);
  return cached;
}

/** How many directories `after` has that `before` did not. */
export function countAddedPathDirs(before: string, after: string): number {
  const dirs = (value: string) =>
    new Set(
      value
        .split(path.delimiter)
        .map((dir) => dir.trim())
        .filter(Boolean),
    );
  const had = dirs(before);
  return [...dirs(after)].filter((dir) => !had.has(dir)).length;
}

/**
 * Enrich `process.env.PATH` in place so every later spawn/execFile (the bash
 * tool, background tasks, LSP servers, git helpers) inherits a working PATH.
 * Idempotent and safe to call once at startup. No-op on Windows.
 */
export async function enrichProcessPath(): Promise<void> {
  if (process.platform === "win32") return;
  const before = process.env.PATH ?? "";
  const enriched = await resolveEnrichedPath(before);
  if (enriched && enriched !== before) {
    process.env.PATH = enriched;
    log("INFO", "shell-path", "enriched PATH for tools", {
      addedDirs: countAddedPathDirs(before, enriched),
    });
  }
}
