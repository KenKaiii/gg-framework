import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PersistentShell, buildRestoreScript, parseStateSnapshot } from "./persistent-shell.js";
import { listDescendantPids } from "../utils/process.js";

const isWindows = os.platform() === "win32";
const d = describe.skipIf(isWindows);

d("PersistentShell", () => {
  let shell: PersistentShell | null = null;
  const dirs: string[] = [];

  afterEach(() => {
    shell?.kill();
    shell = null;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function make(): PersistentShell {
    shell = new PersistentShell(os.tmpdir(), { ...process.env, TERM: "dumb" }, 1024 * 1024);
    return shell;
  }

  const signal = () => new AbortController().signal;

  it("runs a command and returns output + exit code", async () => {
    const sh = make();
    const res = await sh.run("echo hello", 10_000, signal());
    expect(res.exitCode).toBe(0);
    expect(res.output).toBe("hello");
  });

  it("propagates non-zero exit codes", async () => {
    const sh = make();
    const res = await sh.run("exit 3", 10_000, signal());
    expect(res.exitCode).toBe(3);
  });

  it("persists cd and env vars across calls — the point of the feature", async () => {
    const sh = make();
    await sh.run("cd / && export GG_PSH_TEST=alive", 10_000, signal());
    const res = await sh.run('pwd; echo "$GG_PSH_TEST"', 10_000, signal());
    expect(res.output).toBe("/\nalive");
  });

  it("stdin-reading commands don't eat the sentinel or hang", async () => {
    const sh = make();
    const res = await sh.run("cat", 5_000, signal());
    expect(res.exitCode).toBe(0);
    // Session still healthy afterwards.
    const next = await sh.run("echo ok", 5_000, signal());
    expect(next.output).toBe("ok");
  });

  /** A real dir with a space, so restore quoting is exercised too. */
  function makeDir(): string {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gg psh ")));
    dirs.push(dir);
    return dir;
  }

  function shellPid(sh: PersistentShell): number | null {
    return (sh as unknown as { shellPid: number | null }).shellPid;
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("timeout stops only the command: the same shell keeps cwd + exported env", async () => {
    const sh = make();
    const dir = makeDir();
    const counter = path.join(dir, "count");
    await sh.run(`cd ${JSON.stringify(dir)} && export X=1`, 10_000, signal());
    const pidBefore = shellPid(sh);

    const started = Date.now();
    const timedOut = await sh.run("echo hit >> count; sleep 30; echo late >> count", 300, signal());
    expect(timedOut.exitCode).toBe("TIMEOUT");
    expect(timedOut.shellKept).toBe(true);
    expect(sh.takeRestartNote()).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);

    const res = await sh.run('pwd -P; echo "X=$X"', 10_000, signal());
    expect(res.output).toBe(`${dir}\nX=1`);
    expect(sh.takeRestartNote()).toBeUndefined();
    expect(shellPid(sh)).toBe(pidBefore);
    // Ran exactly once; the rest of the command list was skipped, not resumed.
    expect(readFileSync(counter, "utf-8")).toBe("hit\n");
  });

  it("abort stops only the command and keeps the shell", async () => {
    const sh = make();
    await sh.run("export GG_PSH_ABORT=kept", 10_000, signal());
    const controller = new AbortController();
    const pending = sh.run("sleep 30", 60_000, controller.signal);
    setTimeout(() => controller.abort(), 200);
    const res = await pending;
    expect(res.exitCode).toBe(1);
    expect(res.shellKept).toBe(true);
    const after = await sh.run('echo "$GG_PSH_ABORT"', 10_000, signal());
    expect(after.output).toBe("kept");
    expect(sh.takeRestartNote()).toBeUndefined();
  });

  it("kills background children of a timed-out command", async () => {
    const sh = make();
    const dir = makeDir();
    const pidFile = path.join(dir, "bg.pid");
    const res = await sh.run(
      `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; (sleep 60; echo nested) & sleep 30`,
      400,
      signal(),
    );
    expect(res.exitCode).toBe("TIMEOUT");
    const bgPid = Number(readFileSync(pidFile, "utf-8"));
    expect(bgPid).toBeGreaterThan(0);
    for (let i = 0; i < 50 && alive(bgPid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(bgPid)).toBe(false);
    // No descendants of the shell survive at all. They were all signalled, but
    // the run settles on the sentinel, so a loaded Linux runner can still show
    // the nested subshell mid-exit; wait for that the same way as for bgPid.
    const pid = shellPid(sh)!;
    for (let i = 0; i < 50 && listDescendantPids(pid).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(listDescendantPids(pid)).toEqual([]);
  });

  it("a builtin busy loop that ignores the interrupt falls back to a restart with state restored", async () => {
    const sh = make();
    const dir = makeDir();
    await sh.run(`cd ${JSON.stringify(dir)} && export X=1`, 10_000, signal());
    // The command disarms the interrupt trap, so only killing the shell stops it.
    const res = await sh.run("trap '' USR1; while :; do :; done", 300, signal());
    expect(res.exitCode).toBe("TIMEOUT");
    expect(res.shellKept).toBe(false);
    expect(sh.takeRestartNote()).toContain("was restarted");
    const after = await sh.run('pwd -P; echo "X=$X"', 10_000, signal());
    expect(after.output).toBe(`${dir}\nX=1`);
  }, 20_000);

  it.each([
    ["exit 3", 3, "exited with code 3"],
    ["kill -9 $$", 137, "killed by SIGKILL"],
  ])(
    "`%s` restarts the shell with cwd + exported env restored and says so",
    async (cmd, code, how) => {
      const sh = make();
      const dir = makeDir();
      await sh.run(
        `cd ${JSON.stringify(dir)} && export X=1 && export GG_PSH_Q="it's \\"quoted\\" \\$HOME"`,
        10_000,
        signal(),
      );
      const pidBefore = shellPid(sh);

      const res = await sh.run(`echo hit >> count; ${cmd}`, 10_000, signal());
      expect(res.exitCode).toBe(code);
      expect(sh.takeRestartNote()).toBe(
        `[Shell ${how}, so it was restarted; restored working directory ${dir} and exported environment variables. ` +
          "Shell functions, aliases, unexported variables and background jobs are gone. The command was not re-run.]",
      );

      const after = await sh.run('pwd -P; echo "X=$X"; echo "$GG_PSH_Q"', 10_000, signal());
      expect(after.output).toBe(`${dir}\nX=1\nit's "quoted" $HOME`);
      expect(sh.takeRestartNote()).toBeUndefined();
      expect(shellPid(sh)).not.toBe(pidBefore);
      // Never re-run.
      expect(readFileSync(path.join(dir, "count"), "utf-8")).toBe("hit\n");
    },
  );

  it("a shell killed between calls is restarted before the next command, with state", async () => {
    const sh = make();
    const dir = makeDir();
    await sh.run(`cd ${JSON.stringify(dir)} && export X=1`, 10_000, signal());
    const pid = shellPid(sh)!;
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));

    const res = await sh.run('pwd -P; echo "X=$X"', 10_000, signal());
    expect(res.exitCode).toBe(0);
    expect(res.output).toBe(`${dir}\nX=1`);
    const note = sh.takeRestartNote();
    expect(note).toContain("had killed by SIGKILL since the last command");
    expect(note).toContain(`restored working directory ${dir}`);
    expect(note).toContain("This command ran in the new shell.");
  });

  it("restores to the session start dir when the saved cwd was deleted", async () => {
    const sh = make();
    const dir = makeDir();
    await sh.run(`cd ${JSON.stringify(dir)} && export X=1`, 10_000, signal());
    rmSync(dir, { recursive: true, force: true });
    expect((await sh.run("exit 1", 10_000, signal())).exitCode).toBe(1);
    expect(sh.takeRestartNote()).toContain("no longer exists");
    const after = await sh.run('echo "X=$X"', 10_000, signal());
    expect(after.output).toBe("X=1");
  });

  it("an explicit kill() mid-command does not restart the shell", async () => {
    const sh = make();
    const pending = sh.run("sleep 30", 60_000, signal());
    await new Promise((r) => setTimeout(r, 200));
    sh.kill();
    await pending;
    expect(sh.takeRestartNote()).toBeUndefined();
    expect((sh as unknown as { child: unknown }).child).toBeNull();
  });

  it("over-cap output still finds the sentinel — no hang, session survives", async () => {
    shell = new PersistentShell(os.tmpdir(), { ...process.env, TERM: "dumb" }, 512);
    const sh = shell;
    await sh.run("export GG_PSH_CAP=kept", 10_000, signal());
    // ~40KB of output, way past the 512-byte cap.
    const res = await sh.run('yes x | head -n 20000; echo "end"', 10_000, signal());
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("[Output capped at 512 bytes]");
    // Session state survived — the command completed instead of timing out.
    const after = await sh.run('echo "$GG_PSH_CAP"', 10_000, signal());
    expect(after.output).toBe("kept");
  });

  it("does not leak error listeners across many runs", async () => {
    const sh = make();
    for (let i = 0; i < 15; i++) {
      await sh.run("true", 10_000, signal());
    }
    // Access the internal child to count listeners — the leak showed up as
    // MaxListenersExceededWarning after ~10 calls before the fix.
    const child = (sh as unknown as { child: { listenerCount(e: string): number } }).child;
    expect(child.listenerCount("error")).toBeLessThanOrEqual(1);
    expect(child.listenerCount("exit")).toBeLessThanOrEqual(1);
  });

  it("rejects a concurrent call while busy instead of interleaving", async () => {
    const sh = make();
    const slow = sh.run("sleep 0.5; echo done", 10_000, signal());
    const busy = await sh.run("echo nope", 10_000, signal());
    expect(busy.exitCode).toBe(1);
    expect(busy.output).toContain("busy");
    const done = await slow;
    expect(done.output).toBe("done");
  });
});

// Pure — runs on every OS, Windows included.
describe("state snapshot", () => {
  it("splits cwd from export -p and drops shell-owned variables", () => {
    const text =
      "/a dir\n" +
      'declare -x OLDPWD="/x"\ndeclare -x PWD="/a dir"\ndeclare -x SHLVL="1"\n' +
      'declare -x X="1"\ndeclare -x Y="multi\nline"\n';
    const snap = parseStateSnapshot(text)!;
    expect(snap.cwd).toBe("/a dir");
    expect(snap.env).not.toMatch(/PWD|SHLVL/);
    expect(snap.env).toContain('declare -x X="1"');
    expect(snap.env).toContain('declare -x Y="multi\nline"');
  });

  it("handles bash 3.2-style output and empty input", () => {
    expect(parseStateSnapshot("")).toBeNull();
    expect(parseStateSnapshot("/only\n")).toEqual({ cwd: "/only", env: "" });
  });

  it("builds a restore script that quotes the cwd and reports where it landed", () => {
    const script = buildRestoreScript({ cwd: "/it's here", env: 'declare -x X="1"' });
    expect(script).toContain(`builtin cd -- '/it'\\''s here'`);
    expect(script.trim().endsWith("builtin pwd -P")).toBe(true);
  });
});
