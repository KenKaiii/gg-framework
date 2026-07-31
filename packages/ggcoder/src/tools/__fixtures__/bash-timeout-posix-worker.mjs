import fs from "node:fs";

const evidenceFile = process.argv[2];
const mode = process.env.GG_BASH_TIMEOUT_POSIX_MODE;
if (!evidenceFile) throw new Error("Evidence-file path is required");
if (mode !== "cooperative" && mode !== "ignore") {
  throw new Error("GG_BASH_TIMEOUT_POSIX_MODE must be cooperative or ignore");
}

function record(role) {
  fs.appendFileSync(
    evidenceFile,
    `${JSON.stringify({ role, pid: process.pid, ppid: process.ppid, mode })}\n`,
  );
}

record("worker");
console.log(`FIXTURE_ROLE=worker PID=${process.pid} PPID=${process.ppid} MODE=${mode}`);

process.on("SIGTERM", () => {
  record("worker-term");
  console.log(`FIXTURE_SIGNAL=SIGTERM PID=${process.pid} MODE=${mode}`);
  if (mode === "cooperative") process.exit(0);
});

setInterval(() => {}, 60_000);
