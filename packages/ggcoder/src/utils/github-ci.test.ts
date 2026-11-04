import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { exec, repo } = vi.hoisted(() => ({ exec: vi.fn(), repo: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: exec }),
}));
vi.mock("./github.js", () => ({ getGitHubRepoSlug: repo }));
// Background git goes through the hardened runner; route it to the same mock.
vi.mock("./git.js", () => ({
  runBackgroundGit: (args: string[], options: unknown) => exec("git", args, options),
}));
import { getGitHubCI, startGitHubCIPoll } from "./github-ci.js";

const sha = "a".repeat(40);
const run = (
  id = 10,
  workflow_id = 1,
  status = "in_progress",
  conclusion: string | null = null,
) => ({
  id,
  workflow_id,
  status,
  conclusion,
  run_attempt: 1,
  head_sha: sha,
});
const job = (id: number, status = "completed", conclusion: string | null = "success") => ({
  id,
  status,
  conclusion,
});
let runs: ReturnType<typeof run>[];
let jobs: ReturnType<typeof job>[];
let head: string;
let stops: (() => void)[];

beforeEach(() => {
  vi.useFakeTimers();
  stops = [];
  head = sha;
  runs = [run()];
  jobs = [job(1), job(2, "in_progress", null)];
  repo.mockResolvedValue("owner/repo");
  exec.mockImplementation(async (file: string, args: string[]) => ({
    stdout:
      file === "git"
        ? head
        : JSON.stringify(args[3].includes("/jobs?") ? [{ jobs }] : [{ workflow_runs: runs }]),
  }));
});
afterEach(() => {
  for (const stop of stops) stop();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("getGitHubCI", () => {
  it("counts jobs for the exact commit and constructs a trusted GitHub link", async () => {
    expect(await getGitHubCI("owner/repo", sha)).toMatchObject({
      key: `owner/repo:${sha}:10.1`,
      url: "https://github.com/owner/repo/actions/runs/10",
      active: true,
      total: 2,
      completed: 1,
      failed: 0,
      conclusion: null,
    });
    expect(exec.mock.calls[0][1]).toEqual([
      "api",
      "--hostname",
      "github.com",
      `repos/owner/repo/actions/runs?head_sha=${sha}&per_page=100`,
      "--paginate",
      "--slurp",
    ]);
  });

  it("selects the newest run per workflow and counts all job pages for its attempt", async () => {
    runs = [
      run(9, 1, "completed", "failure"),
      { ...run(10), run_attempt: 2 },
      run(11, 2),
      { ...run(12, 3), head_sha: "b".repeat(40) },
    ];
    exec.mockImplementation(async (_file: string, args: string[]) => ({
      stdout: JSON.stringify(
        args[3].includes("/jobs?")
          ? [{ jobs: [job(1)] }, { jobs: [job(2)] }]
          : [{ workflow_runs: runs }],
      ),
    }));
    const ci = await getGitHubCI("owner/repo", sha);
    expect(ci).toMatchObject({ total: 4, completed: 4, failed: 0, active: true });
    expect(ci?.key).toBe(`owner/repo:${sha}:10.2,11.1`);
    expect(exec.mock.calls.map((call) => call[1][3])).toContain(
      "repos/owner/repo/actions/runs/10/attempts/2/jobs?per_page=100",
    );
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("does not report all-clear while a workflow remains active", async () => {
    runs = [run(10, 1, "completed", "success"), run(11, 2)];
    jobs = [job(1)];
    expect(await getGitHubCI("owner/repo", sha)).toMatchObject({ active: true, conclusion: null });
  });

  it("reports passing only when every workflow succeeded", async () => {
    runs = [run(10, 1, "completed", "success")];
    jobs = [job(1), job(2, "completed", "skipped")];
    expect(await getGitHubCI("owner/repo", sha)).toMatchObject({
      active: false,
      conclusion: "success",
      completed: 2,
    });
  });

  it.each(["failure", "timed_out", "action_required", "startup_failure", null])(
    "reports unsuccessful conclusion %s",
    async (conclusion) => {
      runs = [run(10, 1, "completed", conclusion)];
      jobs = [];
      expect(await getGitHubCI("owner/repo", sha)).toMatchObject({
        active: false,
        conclusion: "failure",
        failed: 1,
      });
    },
  );

  it("reports a job failure before the whole workflow finishes", async () => {
    jobs = [job(1, "completed", "failure"), job(2, "in_progress", null)];
    expect(await getGitHubCI("owner/repo", sha)).toMatchObject({
      active: true,
      failed: 1,
      conclusion: null,
    });
  });

  it("does not call cancellation a pass", async () => {
    runs = [run(10, 1, "completed", "cancelled")];
    jobs = [];
    expect(await getGitHubCI("owner/repo", sha)).toMatchObject({
      active: false,
      conclusion: "cancelled",
    });
  });

  it("returns no indicator for no workflows and rejects malformed or unavailable evidence", async () => {
    runs = [];
    expect(await getGitHubCI("owner/repo", sha)).toBeNull();
    exec.mockResolvedValue({ stdout: "{}" });
    await expect(getGitHubCI("owner/repo", sha)).rejects.toThrow();
    exec.mockRejectedValue(new Error("offline"));
    await expect(getGitHubCI("owner/repo", sha)).rejects.toThrow("offline");
  });

  it("rejects invalid repository and commit input before invoking gh", async () => {
    await expect(getGitHubCI("owner/repo?redirect=elsewhere", sha)).rejects.toThrow();
    await expect(getGitHubCI("owner/repo", "--help")).rejects.toThrow();
    await expect(getGitHubCI("../repo", sha)).rejects.toThrow();
    await expect(getGitHubCI("owner/..", sha)).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("CI polling lifecycle", () => {
  it("polls active runs every 15 seconds, completed runs every minute, and stops cleanly", async () => {
    const changed = vi.fn();
    const poll = startGitHubCIPoll("/project", changed);
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toHaveBeenCalledTimes(1);
    exec.mockClear();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(exec).not.toHaveBeenCalled();
    runs = [run(10, 1, "completed", "success")];
    jobs = [job(1)];
    await vi.advanceTimersByTimeAsync(1);
    expect(changed.mock.lastCall?.[0].conclusion).toBe("success");
    exec.mockClear();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(exec).not.toHaveBeenCalled();
    poll.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exec).not.toHaveBeenCalled();
  });

  it("clears old commit state and marks network failures stale instead of passing", async () => {
    const changed = vi.fn();
    const poll = startGitHubCIPoll("/project", changed);
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    exec.mockImplementation(async (file: string) => {
      if (file === "git") return { stdout: head };
      throw new Error("rate limited");
    });
    await poll.refresh();
    expect(changed.mock.lastCall?.[0].stale).toBe(true);
    head = "b".repeat(40);
    await poll.refresh();
    expect(changed.mock.lastCall?.[0]).toBeNull();
  });

  it("discards results if HEAD changes while a network request is in flight", async () => {
    exec.mockImplementation(async (file: string, args: string[]) => {
      if (file === "git") return { stdout: head };
      if (args[3].includes("/jobs?")) {
        head = "b".repeat(40);
        return { stdout: JSON.stringify([{ jobs }]) };
      }
      return { stdout: JSON.stringify([{ workflow_runs: runs }]) };
    });
    const changed = vi.fn();
    const poll = startGitHubCIPoll("/project", changed);
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not overlap polls and aborts in-flight requests when stopped", async () => {
    let signal: AbortSignal | undefined;
    exec.mockImplementation((file: string, _args: string[], options: { signal?: AbortSignal }) => {
      if (file === "git") return Promise.resolve({ stdout: head });
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const changed = vi.fn();
    const poll = startGitHubCIPoll("/project", changed);
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    const calls = exec.mock.calls.length;
    await poll.refresh();
    expect(exec).toHaveBeenCalledTimes(calls);
    expect(signal?.aborted).toBe(false);
    poll.stop();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(exec).toHaveBeenCalledTimes(calls);
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not query GitHub for non-GitHub projects", async () => {
    repo.mockResolvedValue(null);
    const poll = startGitHubCIPoll("/project", vi.fn());
    stops.push(poll.stop);
    await vi.advanceTimersByTimeAsync(0);
    expect(exec.mock.calls.every((call) => call[0] === "git")).toBe(true);
  });
});
