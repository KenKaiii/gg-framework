/**
 * Model-declared wake rules (match / silence) push a steering-path
 * notification the moment they hold — no task_output polling. Real processes,
 * because the watcher works off the on-disk log.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessManager, findFailureLine, stripAnsi } from "./process-manager.js";
import { AgentNotificationQueue, type AgentNotification } from "./agent-notifications.js";

const managers: ProcessManager[] = [];
const tempDirs: string[] = [];

async function bgDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-process-wake-"));
  tempDirs.push(directory);
  return directory;
}

async function manager(queue: AgentNotificationQueue): Promise<ProcessManager> {
  const instance = new ProcessManager({ notifications: queue, bgDir: await bgDir() });
  managers.push(instance);
  return instance;
}

async function waitForNotification(
  queue: AgentNotificationQueue,
  predicate: (entry: AgentNotification) => boolean,
  timeoutMs = 30_000,
): Promise<AgentNotification> {
  const deadline = Date.now() + timeoutMs;
  const seen: AgentNotification[] = [];
  while (Date.now() < deadline) {
    for (const entry of queue.drain()) {
      seen.push(entry);
      if (predicate(entry)) return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out. Saw: ${JSON.stringify(seen)}`);
}

afterEach(async () => {
  for (const instance of managers.splice(0)) instance.shutdownAll();
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("ProcessManager wake rules", () => {
  // 45s, not the suite's 20s: this test's own 30s polling budget throws a
  // diagnostic ("Saw: ...") when the
  // watcher is broken. vitest's bare 20s cap must not fire first on a loaded
  // runner (observed on the macOS CI leg) or that diagnosis is lost.
  it(
    "notifies with the matching line the moment new output matches the pattern",
    { timeout: 45_000 },
    async () => {
      const queue = new AgentNotificationQueue();
      const pm = await manager(queue);

      const started = await pm.start(
        "echo building; sleep 1; echo 'error TS2304: cannot find name'; sleep 60",
        process.cwd(),
        undefined,
        { pattern: /error TS\d+/, silenceMs: 120_000 },
      );

      const entry = await waitForNotification(queue, (e) => e.text.includes("wake pattern"));
      expect(entry.text).toContain(started.id);
      expect(entry.text).toContain("cannot find name");
      expect(entry.text).toContain("Still running");
      expect(entry.terminal).toBe(false);
    },
  );

  it(
    "fires the pattern again on a later match, without replaying the one already read",
    { timeout: 45_000 },
    async () => {
      const queue = new AgentNotificationQueue();
      const pm = await manager(queue);

      // A dev server that breaks, gets fixed, then breaks again: the second
      // break must wake the agent too, not only the first.
      const started = await pm.start(
        "echo 'doomed-1'; sleep 3; echo 'doomed-2'; sleep 60",
        process.cwd(),
        undefined,
        { pattern: /doomed-\d/ },
      );

      expect(await pm.waitForExitOrWake(started.id, 15_000)).toBe("pattern");
      const first = await pm.readOutput(started.id);
      expect(first.output).toContain("doomed-1");
      expect(first.output).not.toContain("doomed-2");

      // Returning before doomed-2 is printed would mean doomed-1 re-fired.
      expect(await pm.waitForExitOrWake(started.id, 15_000)).toBe("pattern");
      expect((await pm.readOutput(started.id)).output).toContain("doomed-2");
      expect(pm.activeWakeWatchers()).toContain(started.id);
    },
  );

  it("notifies when a running task goes silent past silenceMs", { timeout: 45_000 }, async () => {
    const queue = new AgentNotificationQueue();
    const pm = await manager(queue);

    const started = await pm.start("echo started; sleep 60", process.cwd(), undefined, {
      silenceMs: 6_000,
    });

    const entry = await waitForNotification(queue, (e) => e.text.includes("stalled"));
    expect(entry.text).toContain(started.id);
    expect(entry.text).toContain("Last output: started");
    expect(entry.terminal).toBe(false);
  });

  it("watches every task for failures, but fires no rule wake without rules", async () => {
    const queue = new AgentNotificationQueue();
    const pm = await manager(queue);

    const started = await pm.start("echo quiet-start; sleep 60", process.cwd());
    // The built-in failure detector is armed even with no declared rules.
    expect(pm.activeWakeWatchers()).toContain(started.id);

    // Give any (buggy) rule a tick interval to fire.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const drained = queue.drain();
    expect(
      drained.every(
        (entry) =>
          !entry.text.includes("stalled") &&
          !entry.text.includes("wake pattern") &&
          !entry.text.includes("looks like a failure"),
      ),
    ).toBe(true);
  });

  it("drops the wake watcher when the process exits", { timeout: 45_000 }, async () => {
    const queue = new AgentNotificationQueue();
    const pm = await manager(queue);

    await pm.start("echo matched-then-exit", process.cwd(), undefined, {
      pattern: /never-matches/,
    });

    const exit = await waitForNotification(queue, (e) => e.terminal);
    expect(exit.text).toContain("exited");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pm.activeWakeWatchers()).toHaveLength(0);
  });
});

describe("ProcessManager failure wake", () => {
  // Each case reproduces a measured miss: the wait used to sit until the task
  // exited or the wait cap ran out although the failure was already printed.

  it(
    "releases a wait on a failure line while the task keeps running",
    { timeout: 45_000 },
    async () => {
      const queue = new AgentNotificationQueue();
      const pm = await manager(queue);
      // A CI watcher: one job fails at ~1s, the run goes on for a minute.
      const started = await pm.start(
        "echo 'lint: in progress'; sleep 1; echo ' FAIL  src/math.test.ts > adds'; sleep 60",
        process.cwd(),
      );

      const t0 = Date.now();
      expect(await pm.waitForExitOrWake(started.id, 30_000)).toBe("failure");
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect((await pm.readOutput(started.id)).isRunning).toBe(true);

      const entry = await waitForNotification(queue, (e) =>
        e.text.includes("looks like a failure"),
      );
      expect(entry.text).toContain("src/math.test.ts");
      expect(entry.urgent).toBe(true);
      expect(entry.terminal).toBe(false);
    },
  );

  it("sees a failure word split by colour codes", { timeout: 45_000 }, async () => {
    const pm = await manager(new AgentNotificationQueue());
    // FORCE_COLOR test runners: the escape sits inside the word itself.
    const started = await pm.start(
      "sleep 1; printf '\\033[31mFAIL\\033[0mED tests/test_api.py::test_login\\n'; sleep 60",
      process.cwd(),
    );
    expect(await pm.waitForExitOrWake(started.id, 30_000)).toBe("failure");
  });

  it("sees gh run watch's failed-job row mid-run", { timeout: 45_000 }, async () => {
    const pm = await manager(new AgentNotificationQueue());
    // gh run watch reprints the job list each refresh and keeps going until
    // every job finishes; a failed job shows as "X <name> in <time> (ID <n>)".
    const started = await pm.start(
      "echo '* lint (ID 11)'; sleep 1; echo 'X test (windows-latest) in 2m3s (ID 12)'; sleep 60",
      process.cwd(),
    );
    expect(await pm.waitForExitOrWake(started.id, 30_000)).toBe("failure");
  });

  it("does not replay a failure line the agent already read", { timeout: 45_000 }, async () => {
    const pm = await manager(new AgentNotificationQueue());
    // The line matches both the declared pattern and the failure check, so
    // two wakes race the agent's read. Once read, neither may fire again.
    const started = await pm.start(
      "sleep 1; echo 'error: first'; sleep 60",
      process.cwd(),
      undefined,
      { pattern: /error:/ },
    );
    expect(["pattern", "failure"]).toContain(await pm.waitForExitOrWake(started.id, 30_000));
    expect((await pm.readOutput(started.id)).output).toContain("error: first");
    expect(await pm.waitForExitOrWake(started.id, 3_000)).toBe("timeout");
  });

  it("releases a wait when a different task fails", { timeout: 45_000 }, async () => {
    const queue = new AgentNotificationQueue();
    const pm = await manager(queue);
    const waitedOn = await pm.start("sleep 60", process.cwd());
    const other = await pm.start("sleep 1; exit 3", process.cwd());

    const result = await pm.waitForActivity(waitedOn.id, 30_000);
    expect(result.reason).toBe("other");
    expect(result.detail).toContain(other.id);
    expect(result.detail).toContain("exited with code 3");
  });

  it(
    "does not raise an alert for a task that was deliberately stopped",
    { timeout: 45_000 },
    async () => {
      const queue = new AgentNotificationQueue();
      const pm = await manager(queue);
      const started = await pm.start("echo up; sleep 60", process.cwd());
      await pm.stop(started.id);

      const exit = await waitForNotification(queue, (e) => e.terminal);
      expect(exit.id).toBe(started.id);
      expect(exit.urgent).toBe(false);
    },
  );

  it("watches an adopted foreground command for failures", { timeout: 45_000 }, async () => {
    const pm = await manager(new AgentNotificationQueue());
    // A slow foreground command handed to the background by the bash tool
    // declares no wake rules; failure detection must still cover it.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(()=>console.log('FAIL src/slow.test.ts'),1000);setTimeout(()=>{},60000)"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const adopted = pm.adopt(child, "slow foreground test run", Date.now(), Buffer.alloc(0));
    expect(await pm.waitForExitOrWake(adopted.id, 30_000)).toBe("failure");
  });
});

describe("findFailureLine", () => {
  it.each([
    " FAIL  src/a.test.ts > adds",
    "FAILED tests/test_x.py::test_y - assert 1 == 2",
    "--- FAIL: TestFoo (0.00s)",
    " Tests  2 failed | 10 passed (12)",
    "==== 2 failed, 8 passed in 1.20s ====",
    "  3 failing",
    " × adds numbers",
    "  ✘    5 e2e/camera-fx-lifecycle.spec.ts:9:5 › camera FX stops GPU work (0ms)",
    "src/a.ts(3,5): error TS2304: Cannot find name 'x'.",
    "error[E0308]: mismatched types",
    "npm ERR! code ELIFECYCLE",
    " ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  web@1.0.0 test: `vitest run`",
    "Traceback (most recent call last):",
    "thread 'main' panicked at src/main.rs:2:5:",
    "TypeError: Cannot read properties of undefined (reading 'x')",
    "##[error]Process completed with exit code 1.",
    "X test (windows-latest) in 3m2s (ID 123)",
    "\u001b[31mFAIL\u001b[0mED tests/test_api.py::test_login",
  ])("flags %j", (line) => {
    expect(findFailureLine(`setup ok\n${line}\nmore`)).toBe(stripAnsi(line));
  });

  it.each([
    " ✓ src/a.test.ts (3 tests) 12ms",
    " Test Files  4 passed (4)",
    "      Tests  12 passed (12)",
    "  VITE v5.4.0  ready in 300 ms",
    "[info] error handling initialised",
    "src/error-handling.test.ts",
    "Found 0 errors. Watching for file changes.",
    "FAILED: 0",
    "  0 failing",
    "* test (windows-latest) (ID 123)",
    "✓ build in 2m (ID 124)",
  ])("ignores healthy output %j", (line) => {
    expect(findFailureLine(line)).toBeUndefined();
  });
});
