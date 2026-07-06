/**
 * Per-call spawn (what tools/bash.ts does today) vs a persistent shell session
 * (what oh-my-pi's embedded "brush" bash gives them) — local measurement, no
 * LLM calls needed.
 *
 * Strategy A — SPAWN (current): every command is `spawn("bash", ["-c", cmd])`,
 *   a fresh process with fresh env/cwd. Cost = fork/exec + shell startup per call.
 *
 * Strategy B — PERSISTENT: one long-lived `bash` process; commands are written
 *   to stdin and delimited with a sentinel echo. Cost ≈ pipe round-trip.
 *   Bonus property (qualitative): cd / env / shell state survive across calls.
 *
 * We run the same command list through both and report total + per-call wall
 * time. Commands are trivial on purpose — we are measuring HARNESS overhead,
 * not the commands themselves.
 *
 * Usage:
 *   npx tsx src/core/bash-spawn-benchmark.ts
 *
 * Env overrides:
 *   GG_BASH_BENCH_N  (commands per strategy, default 30)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const COMMANDS = ["echo hello", "pwd", "ls / > /dev/null", "printf '%s' done", "true"];

function buildCommandList(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(COMMANDS[i % COMMANDS.length]!);
  return out;
}

// ── Strategy A: fresh spawn per call (mirrors tools/bash.ts) ──

function runSpawned(cmd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn("bash", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", () => resolve(performance.now() - start));
  });
}

// ── Strategy B: one persistent bash, sentinel-delimited ──

class PersistentShell {
  private child = spawn("bash", ["--norc", "--noprofile"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  private buffer = "";
  private waiter: { sentinel: string; resolve: () => void } | null = null;

  constructor() {
    this.child.stdout.on("data", (d: Buffer) => {
      this.buffer += d.toString();
      if (this.waiter && this.buffer.includes(this.waiter.sentinel)) {
        const w = this.waiter;
        this.waiter = null;
        this.buffer = "";
        w.resolve();
      }
    });
    this.child.stderr.on("data", () => {});
  }

  run(cmd: string): Promise<number> {
    const start = performance.now();
    const sentinel = `__GG_DONE_${randomUUID()}__`;
    return new Promise((resolve) => {
      this.waiter = { sentinel, resolve: () => resolve(performance.now() - start) };
      this.child.stdin.write(`${cmd}\necho ${sentinel}\n`);
    });
  }

  /** Prove state persistence: cd + env var survive across run() calls. */
  async statePersists(): Promise<boolean> {
    await this.run("cd /tmp && export GG_BENCH_STATE=alive");
    const sentinel = `__GG_STATE_${randomUUID()}__`;
    const out = await new Promise<string>((resolve) => {
      let acc = "";
      const onData = (d: Buffer): void => {
        acc += d.toString();
        if (acc.includes(sentinel)) {
          this.child.stdout.off("data", onData);
          resolve(acc);
        }
      };
      this.child.stdout.on("data", onData);
      this.child.stdin.write(`pwd; echo "$GG_BENCH_STATE"; echo ${sentinel}\n`);
    });
    return out.includes("/tmp") && out.includes("alive");
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

// ── Stats ──

function stats(samples: number[]): { total: number; mean: number; p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((s, x) => s + x, 0);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { total, mean: total / samples.length, p50: at(0.5), p95: at(0.95) };
}

function fmt(s: { total: number; mean: number; p50: number; p95: number }): string {
  return (
    `total ${s.total.toFixed(0)}ms | mean ${s.mean.toFixed(1)}ms | ` +
    `p50 ${s.p50.toFixed(1)}ms | p95 ${s.p95.toFixed(1)}ms`
  );
}

async function main(): Promise<void> {
  const n = Math.max(5, parseInt(process.env.GG_BASH_BENCH_N ?? "30", 10));
  const cmds = buildCommandList(n);

  console.log(`\n🐚 Bash harness overhead — ${n} commands per strategy\n`);

  // Warm both paths once so first-touch costs don't skew either side.
  await runSpawned("true");
  const shell = new PersistentShell();
  await shell.run("true");

  const spawnTimes: number[] = [];
  for (const c of cmds) spawnTimes.push(await runSpawned(c));

  const persistTimes: number[] = [];
  for (const c of cmds) persistTimes.push(await shell.run(c));

  const persists = await shell.statePersists();
  shell.close();

  const a = stats(spawnTimes);
  const b = stats(persistTimes);

  console.log(`SPAWN-PER-CALL (current):  ${fmt(a)}`);
  console.log(`PERSISTENT SHELL (theirs): ${fmt(b)}`);
  const saved = a.mean - b.mean;
  console.log(
    `\nPer-call overhead saved: ${saved.toFixed(1)}ms ` +
      `(${((saved / a.mean) * 100).toFixed(0)}% of mean call cost)`,
  );
  console.log(`State persistence across calls (cd/env): ${persists ? "YES" : "NO"}`);
  console.log(
    `\nVerdict: persistent shell wins if per-call saving is meaningful at agent scale ` +
      `(a long session runs hundreds of bash calls) AND state persistence is a UX win.\n`,
  );
}

const isDirectRun =
  process.argv[1]?.endsWith("bash-spawn-benchmark.ts") ||
  process.argv[1]?.endsWith("bash-spawn-benchmark.js");

if (isDirectRun) {
  main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
