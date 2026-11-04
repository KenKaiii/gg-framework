import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { runBackgroundGit } from "./git.js";
import { getGitHubRepoSlug } from "./github.js";

const exec = promisify(execFile);

/** Mirrored by the desktop bridge's GitHubCI type. Never verification evidence. */
export interface GitHubCI {
  key: string;
  url: string;
  total: number;
  completed: number;
  failed: number;
  active: boolean;
  conclusion: "success" | "failure" | "cancelled" | null;
  stale?: boolean;
}

const resultSchema = z.object({
  id: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const runSchema = resultSchema.extend({
  workflow_id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  head_sha: z.string(),
});
const runPagesSchema = z.array(z.object({ workflow_runs: z.array(runSchema) }));
const jobPagesSchema = z.array(z.object({ jobs: z.array(resultSchema) }));
const nonFailures = new Set(["success", "skipped", "neutral", "cancelled"]);
const failed = (result: z.infer<typeof resultSchema>): boolean =>
  result.status === "completed" &&
  (result.conclusion === null || !nonFailures.has(result.conclusion));

async function api(endpoint: string, signal?: AbortSignal): Promise<unknown> {
  const { stdout } = await exec(
    "gh",
    ["api", "--hostname", "github.com", endpoint, "--paginate", "--slurp"],
    { timeout: 10_000, maxBuffer: 2 * 1024 * 1024, signal },
  );
  return JSON.parse(stdout);
}

/** Exact HEAD only, latest run per workflow, latest attempt's jobs, across all pages. */
export async function getGitHubCI(
  slug: string,
  sha: string,
  signal?: AbortSignal,
): Promise<GitHubCI | null> {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(slug) ||
    slug.split("/").some((part) => part === "." || part === "..") ||
    !/^[a-f0-9]{40,64}$/i.test(sha)
  ) {
    throw new Error("Invalid GitHub CI repository or commit");
  }
  const pages = runPagesSchema.parse(
    await api(`repos/${slug}/actions/runs?head_sha=${sha}&per_page=100`, signal),
  );
  const latest = new Map<number, z.infer<typeof runSchema>>();
  for (const run of pages.flatMap((page) => page.workflow_runs)) {
    if (run.head_sha !== sha) continue;
    const previous = latest.get(run.workflow_id);
    if (!previous || run.id > previous.id) latest.set(run.workflow_id, run);
  }
  const runs = [...latest.values()].sort((a, b) => a.id - b.id);
  if (!runs.length) return null;
  // simplification: cap fan-out at 20 workflows; larger repos need a shared request cache.
  if (runs.length > 20) throw new Error("Too many workflows for title-bar polling");
  const jobs: z.infer<typeof resultSchema>[] = [];
  // Sequential requests bound subprocess concurrency even on repositories with many workflows.
  for (const run of runs) {
    const pages = jobPagesSchema.parse(
      await api(
        `repos/${slug}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
        signal,
      ),
    );
    jobs.push(...pages.flatMap((page) => page.jobs));
  }
  const active = runs.some((run) => run.status !== "completed");
  const failedJobs = jobs.filter(failed).length;
  const hasFailure = failedJobs > 0 || runs.some(failed);
  const allPassed = runs.every((run) => run.conclusion === "success");
  const target = runs.find(failed) ?? runs.find((run) => run.status !== "completed") ?? runs[0];
  return {
    key: `${slug}:${sha}:${runs.map((run) => `${run.id}.${run.run_attempt}`).join(",")}`,
    url: `https://github.com/${slug}/actions/runs/${target.id}`,
    total: jobs.length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: failedJobs || (hasFailure ? 1 : 0),
    active,
    conclusion: active ? null : hasFailure ? "failure" : allPassed ? "success" : "cancelled",
  };
}

async function context(cwd: string): Promise<{ slug: string; sha: string } | null> {
  const [slug, head] = await Promise.all([
    getGitHubRepoSlug(cwd),
    runBackgroundGit(["rev-parse", "--verify", "HEAD"], { cwd, timeoutMs: 2000 }).catch(() => null),
  ]);
  return slug && head ? { slug, sha: head.stdout.trim() } : null;
}

/** One in-flight poll per session, slower while idle, stopped with the session. */
export function startGitHubCIPoll(cwd: string, onChange: (ci: GitHubCI | null) => void) {
  const abort = new AbortController();
  let stopped = false;
  let busy = false;
  let timer: NodeJS.Timeout | undefined;
  let last: GitHubCI | null = null;
  let lastContext = "";
  const publish = (next: GitHubCI | null): void => {
    if (stopped) return;
    if (JSON.stringify(next) !== JSON.stringify(last)) {
      last = next;
      onChange(next);
    }
  };
  const refresh = async (): Promise<void> => {
    if (stopped || busy) return;
    busy = true;
    clearTimeout(timer);
    try {
      const current = await context(cwd);
      const key = current ? `${current.slug}:${current.sha}` : "";
      if (key !== lastContext) {
        lastContext = key;
        publish(null);
      }
      if (!current || stopped) return;
      const next = await getGitHubCI(current.slug, current.sha, abort.signal);
      // A checkout/commit during a network request must never paint the previous HEAD green.
      const now = await context(cwd);
      if (now?.sha !== current.sha || now?.slug !== current.slug) {
        publish(null);
        return;
      }
      publish(next);
    } catch {
      // Never turn missing auth, offline, malformed output, or rate limits into a pass.
      if (last) publish({ ...last, stale: true });
    } finally {
      busy = false;
      if (!stopped) {
        timer = setTimeout(() => void refresh(), last?.active && !last.stale ? 15_000 : 60_000);
        timer.unref?.();
      }
    }
  };
  void refresh();
  return {
    refresh,
    stop: (): void => {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
    },
  };
}
