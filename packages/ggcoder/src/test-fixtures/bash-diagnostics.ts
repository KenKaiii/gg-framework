/** Canonical serializable fixture shared by backend and desktop parity tests. */
export const BASH_DIAGNOSTICS_FIXTURE = {
  executionId: "exec-123",
  pid: 4242,
  command:
    "node -e \"for(let i=1;i<=150;i++) console.log('phase13-'+String(i).padStart(3,'0')); setInterval(()=>{},1000)\"",
  cwd: "C:\\project",
  startedAt: 1_785_000_000_000,
  timeoutMs: 120_000,
  reason: "timedOut",
  exitCode: null,
  signal: null,
  elapsedMs: 2_003,
  logPath: "C:\\Users\\dev\\.gg\\foreground\\exec-123.log",
  tail: "Authoritative final output\nlast line\n",
  outputCapped: true,
  totalOutputBytes: 12_000_000,
  retainedOutputBytes: 10_000_000,
  droppedOutputBytes: 2_000_000,
} as const;
