import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { DEFAULT_INGEST_URL } from "@kenkaiiii/gg-pixel";
import { PIXEL_FIX_SYSTEM_PROMPT } from "./pixel-fix-agent.js";
import { tryResolveStack } from "./source-maps.js";

interface StackFrame {
  file: string;
  line: number;
  col: number;
  fn: string;
  in_app: boolean;
}

interface CodeContext {
  file: string;
  error_line: number;
  lines: string[];
}

export interface ErrorRow {
  id: string;
  project_id: string;
  fingerprint: string;
  status: string;
  type: string | null;
  message: string | null;
  stack: string | null;
  code_context: string | null;
  runtime: string | null;
  occurrences: number;
  recurrence_count: number;
  branch: string | null;
}

interface ProjectMapping {
  name: string;
  path: string;
  secret?: string;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface FixOptions {
  ingestUrl?: string;
  homeDir?: string;
  fetchFn?: typeof fetch;
  spawnFn?: SpawnFn;
  ggcoderBin?: string;
  inheritStdio?: boolean;
  maxTurns?: number;
}

export interface FixResult {
  errorId: string;
  projectName: string;
  branch: string;
  outcome: "awaiting_review" | "failed";
  reason: string;
}

export async function fixError(errorId: string, opts: FixOptions = {}): Promise<FixResult> {
  const ingestUrl = (opts.ingestUrl ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  const home = opts.homeDir ?? homedir();

  const owner = await resolveErrorOwner(fetchFn, ingestUrl, errorId, home);
  const { error, project, secret } = owner;

  const baseBranch = `fix/pixel-${error.id}`;
  const branch = await buildRetryBranch(
    baseBranch,
    error.branch,
    opts.spawnFn ?? spawn,
    project.path,
  );
  await patchError(fetchFn, ingestUrl, error.id, { status: "in_progress", branch }, secret);

  const exitCode = await runAgent({
    cwd: project.path,
    prompt: buildAgentPrompt(error, branch, project.path),
    systemPrompt: PIXEL_FIX_SYSTEM_PROMPT,
    spawnFn: opts.spawnFn ?? spawn,
    ggcoderBin: opts.ggcoderBin ?? "ggcoder",
    inheritStdio: opts.inheritStdio ?? true,
    maxTurns: opts.maxTurns ?? 60,
  });

  const observed = await observeOutcome(project.path, branch, opts.spawnFn ?? spawn);

  let outcome: "awaiting_review" | "failed";
  let reason: string;
  if (exitCode !== 0) {
    outcome = "failed";
    reason = `Agent exited with code ${exitCode}`;
  } else if (!observed.branchExists) {
    outcome = "failed";
    reason = `Branch ${branch} was not created`;
  } else if (!observed.hasCommits) {
    outcome = "failed";
    reason = `Branch ${branch} has no new commits`;
  } else {
    outcome = "awaiting_review";
    reason = `Branch ${branch} created with ${observed.commitCount} commit(s) — ready for review`;
  }

  await patchError(fetchFn, ingestUrl, error.id, { status: outcome, branch }, secret);

  return { errorId: error.id, projectName: project.name, branch, outcome, reason };
}

export interface QueueOptions extends FixOptions {
  onProgress?: (msg: string) => void;
}

export async function runQueue(opts: QueueOptions = {}): Promise<{
  fixed: number;
  failed: number;
  total: number;
}> {
  const ingestUrl = (opts.ingestUrl ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  const home = opts.homeDir ?? homedir();
  const log = opts.onProgress ?? ((msg: string) => console.log(msg));

  const projectsPath = join(home, ".gg", "projects.json");
  if (!existsSync(projectsPath)) {
    log(chalk.dim("No projects registered. Run `ggcoder pixel install` first."));
    return { fixed: 0, failed: 0, total: 0 };
  }
  const projects = JSON.parse(readFileSync(projectsPath, "utf8")) as Record<string, ProjectMapping>;

  const queue: Array<{ projectName: string; errorId: string }> = [];
  for (const [projectId, project] of Object.entries(projects)) {
    if (!project.secret) continue; // legacy entry: cannot list, must re-install
    try {
      const res = await fetchFn(`${ingestUrl}/api/projects/${projectId}/errors?status=open`, {
        headers: { authorization: `Bearer ${project.secret}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { errors: Array<{ id: string }> };
      for (const e of body.errors) {
        queue.push({ projectName: project.name, errorId: e.id });
      }
    } catch {
      // skip unreachable project
    }
  }

  if (queue.length === 0) {
    log(chalk.hex("#4ade80")("No open errors. Queue is clean."));
    return { fixed: 0, failed: 0, total: 0 };
  }

  log(chalk.bold(`Fixing ${queue.length} ${queue.length === 1 ? "error" : "errors"}...`));
  log("");

  let fixed = 0;
  let failed = 0;
  for (const item of queue) {
    log(chalk.hex("#a78bfa").bold(`▸ ${item.projectName}`) + chalk.dim(`  ${item.errorId}`));
    try {
      const result = await fixError(item.errorId, opts);
      if (result.outcome === "awaiting_review") {
        log(chalk.hex("#4ade80")(`  ✓ ${result.reason}`));
        fixed++;
      } else {
        log(chalk.hex("#ef4444")(`  ✗ ${result.reason}`));
        failed++;
      }
    } catch (err) {
      log(chalk.hex("#ef4444")(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
      failed++;
    }
    log("");
  }

  return { fixed, failed, total: queue.length };
}

/**
 * In-Ink fix flow: prepares the fix (fetch, mark in_progress, build prompt) so
 * the caller can hand the prompt to its existing agent loop. Pair with
 * `finalizePixelFix` after the agent run completes.
 */
export interface PreparedPixelFix {
  errorId: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  branch: string;
  prompt: string;
}

export interface PrepareOptions extends FixOptions {
  ingestUrl?: string;
  homeDir?: string;
  fetchFn?: typeof fetch;
}

export async function preparePixelFix(
  errorId: string,
  opts: PrepareOptions = {},
): Promise<PreparedPixelFix> {
  const ingestUrl = (opts.ingestUrl ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  const home = opts.homeDir ?? homedir();

  let owner: Awaited<ReturnType<typeof resolveErrorOwner>> | undefined;
  try {
    owner = await resolveErrorOwner(fetchFn, ingestUrl, errorId, home);
    const { error, project, secret } = owner;

    const baseBranch = `fix/pixel-${error.id}`;
    const branch = await buildRetryBranch(
      baseBranch,
      error.branch,
      opts.spawnFn ?? spawn,
      project.path,
    );

    await patchError(fetchFn, ingestUrl, error.id, { status: "in_progress", branch }, secret);

    return {
      errorId: error.id,
      projectId: error.project_id,
      projectName: project.name,
      projectPath: project.path,
      branch,
      prompt: buildAgentPrompt(error, branch, project.path),
    };
  } catch (err) {
    // Rollback: if we resolved the owner and set in_progress, revert to open.
    if (owner) {
      try {
        await patchError(fetchFn, ingestUrl, owner.error.id, { status: "open" }, owner.secret);
      } catch {
        // rollback failed — log and continue; original error is more relevant
      }
    }
    throw err;
  }
}

export interface FinalizeOptions extends PrepareOptions {
  spawnFn?: SpawnFn;
  agentExitedCleanly?: boolean;
}

export async function finalizePixelFix(
  prep: PreparedPixelFix,
  opts: FinalizeOptions = {},
): Promise<{ outcome: "awaiting_review" | "failed"; reason: string }> {
  const ingestUrl = (opts.ingestUrl ?? DEFAULT_INGEST_URL).replace(/\/+$/, "");
  const fetchFn = opts.fetchFn ?? fetch;
  const home = opts.homeDir ?? homedir();
  const observed = await observeOutcome(prep.projectPath, prep.branch, opts.spawnFn ?? spawn);

  let outcome: "awaiting_review" | "failed";
  let reason: string;
  if (opts.agentExitedCleanly === false) {
    outcome = "failed";
    reason = "Agent did not finish cleanly";
  } else if (!observed.branchExists) {
    outcome = "failed";
    reason = `Branch ${prep.branch} was not created`;
  } else if (!observed.hasCommits) {
    outcome = "failed";
    reason = `Branch ${prep.branch} has no new commits`;
  } else {
    outcome = "awaiting_review";
    reason = `Branch ${prep.branch} created with ${observed.commitCount} commit(s) — ready for review`;
  }

  const secret = lookupProjectSecret(home, prep.projectId);
  await patchError(
    fetchFn,
    ingestUrl,
    prep.errorId,
    { status: outcome, branch: prep.branch },
    secret,
  );
  return { outcome, reason };
}

export function buildAgentPrompt(error: ErrorRow, branch: string, projectDir?: string): string {
  let stack = parseStackJson(error.stack);
  // For browser stacks (URLs in the file field), try to resolve via local
  // source maps before showing the agent. Resolved frames point at the
  // user's TS/JS source — much more actionable than `app.min.js:1:48201`.
  if (projectDir && stack.length > 0 && looksLikeMinifiedBrowserStack(stack)) {
    stack = tryResolveStack(stack, projectDir);
  }
  const ctx = parseCodeContext(error.code_context);

  const lines: string[] = [];
  lines.push("An error has been identified in this project. Investigate and fix it.");
  lines.push("");
  lines.push(`Error: ${error.type ?? "Error"} — ${error.message ?? "(no message)"}`);

  const topInApp = stack.find((f) => f.in_app) ?? stack[0];
  if (topInApp) lines.push(`Location: ${topInApp.file}:${topInApp.line}`);

  if (ctx && ctx.lines.length > 0) {
    lines.push("");
    lines.push("Code at site:");
    const startLine = ctx.error_line - Math.floor((ctx.lines.length - 1) / 2);
    ctx.lines.forEach((line, i) => {
      const lineNum = startLine + i;
      const marker = lineNum === ctx.error_line ? ">" : " ";
      lines.push(`  ${marker}${String(lineNum).padStart(4)} | ${line}`);
    });
  }

  if (stack.length > 0) {
    lines.push("");
    lines.push("Stack:");
    for (const f of stack.slice(0, 10)) {
      const lib = f.in_app ? "" : "  (lib)";
      lines.push(`  ${f.fn || "<anon>"}  ${f.file}:${f.line}${lib}`);
    }
  }

  if (error.runtime) lines.push(`\nRuntime: ${error.runtime}`);
  lines.push(`Occurrences: ${error.occurrences}`);
  if (error.recurrence_count > 0) {
    lines.push("");
    lines.push(
      `Recurrence: this is the ${ordinal(error.recurrence_count)} time this fingerprint has appeared after a previous fix was merged. The earlier fix did not hold — investigate why.`,
    );
  }

  lines.push("");
  lines.push("When done:");
  lines.push(`  1. Create branch: ${branch}`);
  lines.push("  2. Commit the fix on that branch");
  lines.push("  3. Run the project's quality checks (only commit if they pass)");
  lines.push("");
  lines.push("Do not merge. Do not push. Do not switch back to main.");

  return lines.join("\n");
}

/**
 * Walks ~/.gg/projects.json trying each project's bearer secret against
 * GET /api/errors/:id until one returns 200. Wrong secrets get 403/404 from
 * the server, so this scan exits as soon as the rightful owner is found.
 *
 * Bounded by the number of registered projects on this machine (typically
 * single digits) so cost is negligible per fix.
 */
async function resolveErrorOwner(
  fetchFn: typeof fetch,
  ingestUrl: string,
  errorId: string,
  home: string,
): Promise<{ error: ErrorRow; project: ProjectMapping; secret: string }> {
  const projectsPath = join(home, ".gg", "projects.json");
  if (!existsSync(projectsPath)) {
    throw new Error(
      `No projects mapping at ${projectsPath} — run \`ggcoder pixel install\` in the project first.`,
    );
  }
  const projects = JSON.parse(readFileSync(projectsPath, "utf8")) as Record<string, ProjectMapping>;
  const ownersWithSecret = Object.entries(projects).filter(([, p]) => Boolean(p.secret));
  if (ownersWithSecret.length === 0) {
    throw new Error(
      "No managed projects on this machine — run `ggcoder pixel install` in the project to refresh management access.",
    );
  }
  for (const [, project] of ownersWithSecret) {
    const res = await fetchFn(`${ingestUrl}/api/errors/${errorId}`, {
      headers: { authorization: `Bearer ${project.secret}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) {
      console.warn(
        chalk.hex("#fbbf24")(
          `⚠ 401 for project ${project.name} — secret may need refresh. Run \`ggcoder pixel install\` to refresh.`,
        ),
      );
      continue;
    }
    if (res.ok) {
      const error = (await res.json()) as ErrorRow;
      return { error, project, secret: project.secret! };
    }
    // 403/404 → not this project; keep scanning.
  }
  throw new Error(
    `Error ${errorId} was not found in any registered project. Ensure the project is installed (\`ggcoder pixel install\`).`,
  );
}

function lookupProjectSecret(home: string, projectId: string): string {
  const projectsPath = join(home, ".gg", "projects.json");
  if (!existsSync(projectsPath)) {
    throw new Error(
      `No projects mapping at ${projectsPath} — run \`ggcoder pixel install\` in the project first.`,
    );
  }
  const projects = JSON.parse(readFileSync(projectsPath, "utf8")) as Record<string, ProjectMapping>;
  const project = projects[projectId];
  if (!project) {
    throw new Error(
      `No local mapping for project ${projectId} in ${projectsPath}. Run \`ggcoder pixel install\` in the project's directory.`,
    );
  }
  if (!project.secret) {
    throw new Error(
      `Project ${projectId} is missing its bearer secret in ${projectsPath} — re-run \`ggcoder pixel install\` to refresh.`,
    );
  }
  return project.secret;
}

async function patchError(
  fetchFn: typeof fetch,
  ingestUrl: string,
  errorId: string,
  body: { status: string; branch?: string },
  secret: string,
): Promise<void> {
  const res = await fetchFn(`${ingestUrl}/api/errors/${errorId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`PATCH /api/errors/${errorId} failed: ${res.status}`);
}

interface AgentRunOptions {
  cwd: string;
  prompt: string;
  systemPrompt: string;
  spawnFn: SpawnFn;
  ggcoderBin: string;
  inheritStdio: boolean;
  maxTurns: number;
}

async function runAgent(opts: AgentRunOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const args = [
      "--json",
      "--max-turns",
      String(opts.maxTurns),
      "--system-prompt",
      opts.systemPrompt,
      opts.prompt,
    ];
    const child = opts.spawnFn(opts.ggcoderBin, args, {
      cwd: opts.cwd,
      stdio: opts.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
    });

    const cleanup = () => {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
    };

    const onSignal = (signal: string) => {
      cleanup();
      reject(new Error(`Received ${signal} — agent killed`));
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      process.removeListener("SIGTERM", sigtermHandler);
      process.removeListener("SIGINT", sigintHandler);
      resolve(code ?? 1);
    };

    const sigtermHandler = () => onSignal("SIGTERM");
    const sigintHandler = () => onSignal("SIGINT");
    process.on("SIGTERM", sigtermHandler);
    process.on("SIGINT", sigintHandler);

    child.on("error", onError);
    child.on("exit", onExit);
  });
}

interface ObservedOutcome {
  branchExists: boolean;
  hasCommits: boolean;
  commitCount: number;
  pushable: boolean;
}

/**
 * Parse the retry attempt number from a branch name like "fix/pixel-abc-retry-3".
 * Returns 0 if no retry suffix is present.
 */
function parseRetryAttempt(branch: string | null): number {
  if (!branch) return 0;
  const m = branch.match(/-retry-(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Build the next branch name for a given base and the error's current branch field.
 * If the current branch has no retry suffix or no such local branch exists, return
 * the base name. Otherwise increment the attempt counter.
 */
function buildRetryBranch(
  baseBranch: string,
  currentBranch: string | null,
  spawnFn: SpawnFn,
  cwd: string,
): Promise<string> {
  const attempt = parseRetryAttempt(currentBranch ?? "");
  if (attempt === 0) return Promise.resolve(baseBranch);
  const candidate = `${baseBranch}-retry-${attempt + 1}`;
  // Check if this branch already exists locally.
  const child = spawnFn("git", ["show-ref", "--verify", `refs/heads/${candidate}`], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    signal: AbortSignal.timeout(10_000),
  });
  return new Promise<{ branch: string; exists: boolean }>((resolve) => {
    child.on("exit", (code) => resolve({ branch: candidate, exists: code === 0 }));
    child.on("error", () => resolve({ branch: candidate, exists: false }));
  }).then(({ exists }) => (exists ? `${baseBranch}-retry-${attempt + 1}` : baseBranch));
}

async function observeOutcome(
  cwd: string,
  branch: string,
  spawnFn: SpawnFn,
): Promise<ObservedOutcome> {
  const exists = await runGit(cwd, ["show-ref", "--verify", `refs/heads/${branch}`], spawnFn);
  if (exists.code !== 0)
    return { branchExists: false, hasCommits: false, commitCount: 0, pushable: false };

  let baseBranch: string | null = null;
  for (const candidate of ["main", "master"]) {
    const r = await runGit(cwd, ["show-ref", "--verify", `refs/heads/${candidate}`], spawnFn);
    if (r.code === 0) {
      baseBranch = candidate;
      break;
    }
  }
  if (!baseBranch)
    return { branchExists: true, hasCommits: false, commitCount: 0, pushable: false };

  const ahead = await runGit(cwd, ["rev-list", "--count", `${baseBranch}..${branch}`], spawnFn);
  const count = ahead.code === 0 ? parseInt(ahead.stdout.trim(), 10) || 0 : 0;

  // Check pushability via ls-remote.
  const pushable = await runGit(cwd, ["ls-remote", "--heads", "origin", branch], spawnFn)
    .then((r) => r.code === 0)
    .catch(() => false);

  return { branchExists: true, hasCommits: count > 0, commitCount: count, pushable };
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[], spawnFn: SpawnFn): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawnFn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(10_000),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", () => resolve({ code: 1, stdout, stderr }));
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function looksLikeMinifiedBrowserStack(stack: StackFrame[]): boolean {
  // Heuristic: any frame whose file is an http(s) URL = browser stack.
  // We try map resolution for these. Native Node paths don't need it.
  return stack.some((f) => /^https?:\/\//.test(f.file));
}

function parseStackJson(raw: string | null): StackFrame[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as StackFrame[];
  } catch {
    // ignore
  }
  return [];
}

function parseCodeContext(raw: string | null): CodeContext | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CodeContext;
  } catch {
    return null;
  }
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
