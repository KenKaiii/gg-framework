import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

// ── Hardened runner for GG's own (background) git calls ─────────────────────
//
// GitSpawn: a repository's own `.git/config` (or an `include.path` it pulls
// in) can name programs that git runs during perfectly ordinary read-only
// commands — `core.fsmonitor` on any index refresh, a `post-index-change` hook
// when `git status` rewrites the index, `filter.<driver>.clean/process` (with
// `.gitattributes`) when status re-hashes a stat-dirty file, `textconv` /
// external diff drivers in `git show`, `gpg.program` via `log.showSignature`,
// credential/ssh/askpass helpers, pagers and editors. GG runs git on its own
// (project open, CI chip, XP, verification snapshots, the destructive-git
// guard), so merely opening a malicious repo must not execute anything.
//
// Every background git call goes through {@link runBackgroundGit}, which
// prepends `-c` overrides (command-line config beats every config file) and
// blanks the per-driver filter/merge commands discovered by a safe
// `git config` probe. Prior art: gptme b65f699d (`git_inspect_cmd`) and
// MoonshotAI/kimi-code#3964 (`hardenedGitConfigArgs`). The agent's own `bash`
// tool is out of scope — those are explicit, user-visible commands.

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

/** `-c` overrides that disable every repo-config execution sink GG's calls can reach. */
export const GIT_HARDENING_CONFIG_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
  "-c",
  "core.pager=cat",
  "-c",
  "core.editor=:",
  "-c",
  "core.askPass=",
  // Plain OpenSSH: keeps any (rare) lazy fetch working without the repo's command.
  "-c",
  "core.sshCommand=ssh",
  // An empty value resets the helper list, dropping repo-configured helpers.
  "-c",
  "credential.helper=",
  // Background calls never need the network. A partial clone would otherwise
  // lazy-fetch missing blobs (e.g. in `git show`) through the repo's own
  // `remote.<name>.uploadpack` / ext:: URL; GIT_NO_LAZY_FETCH backs this up.
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "gpg.program=",
  "-c",
  "log.showSignature=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "merge.verifySignatures=false",
  "-c",
  "submodule.recurse=false",
];

/**
 * Inserted right after the subcommand of diff-producing commands: external
 * diff drivers (`diff.external`, `diff.<driver>.command`) and `textconv`
 * filters are repo-configured programs. `-c diff.external=` is NOT used — an
 * empty value makes `git diff` die with "cannot run".
 */
export const GIT_NO_EXTERNAL_DIFF_ARGS: readonly string[] = ["--no-ext-diff", "--no-textconv"];

const DIFF_FAMILY = new Set(["diff", "show", "log"]);

/**
 * Inserted after `status`: inspecting a submodule's work tree spawns a nested
 * `git status` inside it, which honours the submodule's OWN filter drivers
 * (its config was never probed). `dirty` still reports moved submodule
 * commits but never enters the submodule work tree. Skipped when the caller
 * passes its own `--ignore-submodules`.
 */
export const GIT_STATUS_SUBMODULE_ARGS: readonly string[] = ["--ignore-submodules=dirty"];

/**
 * Subcommands that never hash or check out work-tree content, so no
 * clean/smudge/process filter can run — the per-driver probe is skipped.
 */
const NO_FILTER_SUBCOMMANDS = new Set(["rev-parse", "remote", "rev-list", "patch-id", "show"]);

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Build `-c` overrides that blank every filter / merge driver named in the
 * NUL-separated output of `git config -z --name-only --get-regexp`. Returns
 * null when a driver name contains `=` — `-c` splits at the first `=`, so the
 * override could not be expressed and the caller must refuse to run.
 */
export function buildDriverOverrides(outputs: readonly string[]): string[] | null {
  const filters = new Set<string>();
  const merges = new Set<string>();
  for (const output of outputs) {
    for (const name of output.split(/[\0\n]/)) {
      const filter = /^filter\.(.+)\.(?:clean|smudge|process|required)$/is.exec(name)?.[1];
      const merge = /^merge\.(.+)\.driver$/is.exec(name)?.[1];
      const driver = filter ?? merge;
      if (driver === undefined) continue;
      if (driver.includes("=")) return null;
      (filter !== undefined ? filters : merges).add(driver);
    }
  }
  const args: string[] = [];
  for (const driver of filters) {
    args.push(
      "-c",
      `filter.${driver}.clean=`,
      "-c",
      `filter.${driver}.smudge=`,
      "-c",
      `filter.${driver}.process=`,
      // A blanked `required` filter would otherwise make status die.
      "-c",
      `filter.${driver}.required=false`,
    );
  }
  for (const driver of merges) args.push("-c", `merge.${driver}.driver=`);
  return args;
}

let cachedGitBinary: string | undefined;

/**
 * The git executable. On Windows, libuv's PATH search tries the child's cwd
 * first, so a `git.exe` planted at a repo root would run instead of git —
 * resolve an absolute path from PATH once instead.
 */
export function resolveGitBinary(): string {
  if (cachedGitBinary !== undefined) return cachedGitBinary;
  cachedGitBinary = "git";
  if (process.platform === "win32") {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      const clean = dir.trim().replace(/^"|"$/g, "");
      if (!clean || !path.isAbsolute(clean)) continue;
      const candidate = path.join(clean, "git.exe");
      try {
        if (statSync(candidate).isFile()) {
          cachedGitBinary = candidate;
          break;
        }
      } catch {
        // not here
      }
    }
  }
  return cachedGitBinary;
}

export interface BackgroundGitOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Written to stdin, which is then closed. */
  input?: string;
  signal?: AbortSignal;
  /** Extra environment on top of `process.env` and the hardening env. */
  env?: Readonly<Record<string, string>>;
  /**
   * Repo-selecting global options (`--git-dir=…`, `--work-tree=…`) placed
   * before the subcommand — and before `config` in the driver probe, so it
   * inspects the same repository.
   */
  globalArgs?: readonly string[];
}

export interface BackgroundGitResult {
  stdout: string;
  stderr: string;
}

/**
 * Rejection of {@link runBackgroundGit}, shaped like a promisified execFile
 * error: `code` is git's exit status (number) or a spawn errno (string).
 */
export class BackgroundGitError extends Error {
  readonly code: number | string | null;
  readonly killed: boolean;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    message: string,
    details: { code: number | string | null; killed: boolean; stdout: string; stderr: string },
  ) {
    super(message);
    this.name = "BackgroundGitError";
    this.code = details.code;
    this.killed = details.killed;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
  }
}

function spawnGit(
  args: readonly string[],
  options: BackgroundGitOptions,
): Promise<BackgroundGitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      resolveGitBinary(),
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 2_000,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        signal: options.signal,
        windowsHide: true,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_NO_LAZY_FETCH: "1",
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const code: unknown = error.code;
        reject(
          new BackgroundGitError(error.message, {
            code: typeof code === "number" || typeof code === "string" ? code : null,
            killed: error.killed === true,
            stdout,
            stderr,
          }),
        );
      },
    );
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // git exited before reading all input; the exit callback reports it.
      });
      child.stdin.end(options.input);
    }
  });
}

/** Repo-local filter/merge driver overrides, or null when they cannot be expressed. */
async function probeDriverOverrides(options: BackgroundGitOptions): Promise<string[] | null> {
  const outputs = await Promise.all(
    ["--local", "--worktree"].map(async (scope) => {
      try {
        const { stdout } = await spawnGit(
          [
            ...GIT_HARDENING_CONFIG_ARGS,
            ...(options.globalArgs ?? []),
            "config",
            scope,
            "--includes",
            "-z",
            "--name-only",
            "--get-regexp",
            "^(filter|merge)\\.",
          ],
          {
            cwd: options.cwd,
            timeoutMs: PROBE_TIMEOUT_MS,
            signal: options.signal,
            env: options.env,
          },
        );
        return stdout;
      } catch (error) {
        // Exit 1 = no matching keys; 128/129 = not a repo / old git without
        // --worktree. Spawn failures and timeouts fail closed.
        if (error instanceof BackgroundGitError && typeof error.code === "number" && !error.killed)
          return "";
        throw error;
      }
    }),
  );
  return buildDriverOverrides(outputs);
}

/**
 * Full argv for a hardened background git call (minus the binary). Exposed
 * for tests; callers use {@link runBackgroundGit}.
 */
export async function hardenedGitArgs(
  args: readonly string[],
  options: BackgroundGitOptions,
): Promise<string[]> {
  const [subcommand, ...rest] = args;
  let drivers: string[] = [];
  if (subcommand === undefined || !NO_FILTER_SUBCOMMANDS.has(subcommand)) {
    const probed = await probeDriverOverrides(options);
    if (probed === null) {
      throw new BackgroundGitError(
        "git config names a filter/merge driver that cannot be disabled",
        {
          code: null,
          killed: false,
          stdout: "",
          stderr: "",
        },
      );
    }
    drivers = probed;
  }
  let command = [...args];
  if (subcommand !== undefined && DIFF_FAMILY.has(subcommand)) {
    command = [subcommand, ...GIT_NO_EXTERNAL_DIFF_ARGS, ...rest];
  } else if (
    subcommand === "status" &&
    !rest
      .slice(0, rest.includes("--") ? rest.indexOf("--") : rest.length)
      .some((arg) => arg.startsWith("--ignore-submodules"))
  ) {
    command = [subcommand, ...GIT_STATUS_SUBMODULE_ARGS, ...rest];
  }
  return [...GIT_HARDENING_CONFIG_ARGS, ...drivers, ...(options.globalArgs ?? []), ...command];
}

/**
 * Run git for GG's own background purposes with repo-config execution sinks
 * disabled. Resolves `{stdout, stderr}` on exit 0; rejects with
 * {@link BackgroundGitError} otherwise. Output is identical to plain git.
 */
export async function runBackgroundGit(
  args: readonly string[],
  options: BackgroundGitOptions,
): Promise<BackgroundGitResult> {
  return spawnGit(await hardenedGitArgs(args, options), options);
}

// ── Background helpers ──────────────────────────────────────────────────────

export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runBackgroundGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Count staged, modified, deleted, renamed, and untracked files. */
export async function getGitDirtyFileCount(cwd: string): Promise<number> {
  const { stdout } = await runBackgroundGit(["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
  });
  return stdout.split(/\r?\n/).filter(Boolean).length;
}

/**
 * Whether `cwd` is inside a git work tree. Distinct from getGitBranch, which
 * returns null both for non-repos AND for freshly-init'd repos with no commits
 * (rev-parse HEAD fails before the first commit).
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runBackgroundGit(["rev-parse", "--is-inside-work-tree"], { cwd });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}
