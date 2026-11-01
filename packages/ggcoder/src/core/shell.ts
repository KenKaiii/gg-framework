import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Cross-platform shell resolution for the bash tool + background process
 * manager.
 *
 * The agent writes shell commands assuming POSIX `bash` semantics (`&&`, pipes,
 * `ls`, `grep`, `$(...)`, single-quoting, …). On macOS/Linux that's just
 * `bash`. On Windows there are three cases, and getting this wrong is the root
 * of the "files not mounted / different environment" class of bugs:
 *
 *   1. Git Bash (Git for Windows) — a REAL POSIX bash that operates on the
 *      native Windows filesystem. `D:\proj` is reachable as `/d/proj` AND the
 *      spawned process honors the Windows `cwd`. This is what we want, so we
 *      detect and prefer it.
 *
 *   2. WSL bash (`C:\Windows\System32\bash.exe`) — the Windows Subsystem for
 *      Linux launcher. It runs commands inside a SEPARATE Linux distro whose
 *      filesystem is not the project tree (`D:\proj` ≈ `/mnt/d/proj`, and a
 *      raw `D:\proj` cwd lands you somewhere else entirely). Commands appear to
 *      run "in a different project / sandbox". We deliberately SKIP it.
 *
 *   3. No bash at all — bare `spawn("bash", …)` fails with `spawn bash ENOENT`,
 *      so every shell command the agent runs errors out. We fall back to
 *      `cmd.exe` so commands can at least run (with different semantics, which
 *      the agent is told about).
 *
 * The resolver is pure: filesystem + env + platform are injected so it can be
 * unit-tested for every OS from any host.
 */
export interface ShellResolution {
  /** Executable to spawn (never goes through a shell wrapper itself). */
  file: string;
  /** Args that run the given command string as one shell command. */
  args: string[];
  /** True when `file` is a cmd.exe fallback (non-POSIX semantics). */
  isCmdFallback: boolean;
}

export interface ResolveShellOpts {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injected for testability; defaults to fs.existsSync. */
  exists?: (p: string) => boolean;
  /** Settings `bashPath`: `auto` (default, `bash` from PATH), `system`
   *  (/bin/bash on macOS — ~2ms spawn vs ~11ms for Homebrew bash 5), or an
   *  explicit path. Ignored on Windows; a missing path falls back to auto. */
  bashPath?: string;
}

/** The bash executable for a non-Windows platform under a `bashPath` setting. */
function posixBash(
  platform: NodeJS.Platform,
  bashPath: string | undefined,
  exists: (p: string) => boolean,
): string {
  const choice = bashPath?.trim();
  if (!choice || choice === "auto") return "bash";
  if (choice === "system") {
    return platform === "darwin" && exists("/bin/bash") ? "/bin/bash" : "bash";
  }
  return exists(choice) ? choice : "bash";
}

/**
 * Fixed Git-Bash install locations to probe on Windows, in priority order.
 * These cover the official Git for Windows installer (system + per-user) plus
 * the common 32-bit path. We NEVER include `System32\bash.exe` (WSL).
 */
function gitBashFixedCandidates(env: NodeJS.ProcessEnv): string[] {
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA;
  const candidates = [
    path.win32.join(programFiles, "Git", "bin", "bash.exe"),
    path.win32.join(programFilesX86, "Git", "bin", "bash.exe"),
  ];
  if (localAppData) {
    candidates.push(path.win32.join(localAppData, "Programs", "Git", "bin", "bash.exe"));
  }
  return candidates;
}

/**
 * Derive Git Bash from `git.exe` on PATH: Git for Windows ships `git.exe` under
 * `<root>\cmd` (and `<root>\bin`), with `bash.exe` at `<root>\bin\bash.exe`.
 */
function gitBashFromPath(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  const rawPath = env.PATH ?? env.Path ?? "";
  if (!rawPath) return null;
  // Windows PATH is always ';'-separated. (Don't use path.delimiter — it
  // reflects the HOST OS, which breaks when this win32-only branch is exercised
  // in cross-platform tests on a POSIX host.)
  for (const dir of rawPath.split(";")) {
    if (!dir) continue;
    const gitExe = path.win32.join(dir, "git.exe");
    if (!exists(gitExe)) continue;
    // <root>\cmd\git.exe or <root>\bin\git.exe → <root>\bin\bash.exe
    const gitRoot = path.win32.dirname(path.win32.dirname(gitExe));
    const bash = path.win32.join(gitRoot, "bin", "bash.exe");
    if (exists(bash)) return bash;
  }
  return null;
}

/** Locate a usable Git Bash on Windows, or null if none is installed. */
function findGitBash(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  for (const candidate of gitBashFixedCandidates(env)) {
    if (exists(candidate)) return candidate;
  }
  return gitBashFromPath(env, exists);
}

/**
 * Resolve the shell executable + args to run a single command string.
 *
 * `GG_BASH` env override always wins (point it at any POSIX bash, e.g. a custom
 * Git Bash or msys2 install). Otherwise: non-Windows → `bash`; Windows → Git
 * Bash if found, else `cmd.exe`.
 */
export function resolveShell(command: string, opts: ResolveShellOpts = {}): ShellResolution {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;

  // Explicit override (power users / tests): treat as a POSIX bash.
  const override = env.GG_BASH?.trim();
  if (override) {
    return { file: override, args: ["-o", "pipefail", "-c", command], isCmdFallback: false };
  }

  if (platform !== "win32") {
    // pipefail: a pipeline exits with the failing stage's status, never the
    // limiter's. Without it `tests | tail -20` reports tail's 0 and a red
    // suite reads green — both to the agent and to the verification gate.
    return {
      file: posixBash(platform, opts.bashPath, exists),
      args: ["-o", "pipefail", "-c", command],
      isCmdFallback: false,
    };
  }

  const gitBash = findGitBash(env, exists);
  if (gitBash) {
    return { file: gitBash, args: ["-o", "pipefail", "-c", command], isCmdFallback: false };
  }

  // Last resort: cmd.exe. `/d` skips AutoRun, `/s` + `/c` runs the rest as a
  // single command verbatim (correct quoting for an arbitrary command string).
  const comspec = env.ComSpec ?? env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe";
  return { file: comspec, args: ["/d", "/s", "/c", command], isCmdFallback: true };
}
