/**
 * Optional, opt-in `CommandRewriter` (see `./bash.ts`) that routes bash
 * commands through [rtk](https://github.com/rtk-ai/rtk) before they run.
 * rtk rewrites common CLI invocations (`git status`, `ps aux`, `find`, ...)
 * into token-cheaper equivalents that produce the same information in less
 * output.
 *
 * Off by default and only enabled by `GG_RTK_REWRITE=1` — whether this ships
 * as a default-on feature (and where the toggle should live: env var, CLI
 * flag, or the persisted settings file alongside `allowOutsideWorkspaceWrites`)
 * is a product decision this file does not make. What it proves is that the
 * `rewriteCommand` hook shape added to `createBashTool`/`createTools` has a
 * real, working consumer: this is a genuine external-process integration,
 * not a stub.
 *
 * Fully async (`spawn`, never `spawnSync`) — for a documented, plausible
 * reason, not a style preference. ggcoder-derived hosts (e.g. GG Coder.app)
 * commonly run every open session/window in ONE Node process. `spawnSync`
 * would block that one shared event loop for every session at once, not
 * just the session that ran the bash command; that includes a *different*
 * session's own startup handshake, which is a plausible cause of unrelated
 * "sidecar did not start in time" failures. Async avoids that class of bug
 * entirely — see the exported `createRtkRewriter` and the tests for the
 * regression this guards against.
 */
import { spawn } from "node:child_process";
import type { CommandRewriter } from "./bash.js";

const PROBE_TIMEOUT_MS = 300;
const REWRITE_TIMEOUT_MS = 300;

interface RunResult {
  status: number | null;
  stdout: string;
}

/**
 * Runs a child process without ever blocking the event loop. Resolves to the
 * exit status and captured stdout on a clean exit, or `null` on spawn
 * failure or timeout — every caller treats `null` exactly like "no rewrite,
 * use the original command".
 */
function runAsync(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<RunResult | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: RunResult | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      // Explicit env (not the default process.env inherit) so the injectable
      // `env` this module accepts actually governs where the child looks for
      // the rtk binary too, not just the enable check -- otherwise a test (or
      // a future caller) that overrides PATH to test the fail-open path would
      // silently spawn the REAL system rtk instead.
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], env });
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.(); // never keep the process alive just for this watchdog

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      finish({ status, stdout });
    });
  });
}

/**
 * Builds an rtk-backed `CommandRewriter`, or `undefined` when rtk rewriting
 * is not enabled. Call once per process; the returned rewriter caches
 * whether the `rtk` binary is runnable so repeat calls after the first are a
 * boolean check, not a repeat probe.
 *
 * @param env Injectable for tests; defaults to `process.env`.
 */
export function createRtkRewriter(
  env: NodeJS.ProcessEnv = process.env,
): CommandRewriter | undefined {
  if (env.GG_RTK_REWRITE !== "1") return undefined;

  let available: boolean | null = null;
  let probing: Promise<boolean> | null = null;

  async function probe(): Promise<boolean> {
    if (available !== null) return available;
    if (probing) return probing;
    probing = runAsync("rtk", ["--version"], PROBE_TIMEOUT_MS, env).then((res) => {
      available = res !== null && res.status === 0;
      probing = null;
      return available;
    });
    return probing;
  }

  return async (command: string): Promise<string | undefined> => {
    const ok = available === null ? await probe() : available;
    if (!ok) return undefined;

    const res = await runAsync("rtk", ["rewrite", command], REWRITE_TIMEOUT_MS, env);
    if (!res) return undefined;

    // rtk's own exit-code contract (`rtk rewrite --help`,
    // src/hooks/rewrite_cmd.rs upstream): 0 = auto-allow rewrite, 1 = no
    // rewrite (empty stdout), 2 = deny rule matched (empty stdout), 3 =
    // rewrite found but no explicit allow rule — STILL VALID STDOUT, not a
    // failure. Checking status===0 only would silently drop most real-world
    // rewrites (`git status` happens to have an allow rule and exits 0;
    // `ps`/`find`/most others exit 3 and would look unsupported when
    // they're not) — the same bug independently filed and fixed against
    // rtk's own Cursor and OpenClaw integrations (rtk-ai/rtk#1112, #2200,
    // #2372, #2719).
    const rewritten = res.status === 0 || res.status === 3;
    const out = res.stdout.trim();
    return rewritten && out ? out : undefined;
  };
}
