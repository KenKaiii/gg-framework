import { spawn } from "node:child_process";
import fs from "node:fs";

const [evidenceFile, workerFixture] = process.argv.slice(2);
if (!evidenceFile || !workerFixture) {
  throw new Error("Evidence file and worker fixture are required");
}

const posixMode = process.env.GG_BASH_TIMEOUT_POSIX_MODE;
function record(role) {
  const evidence = { role, pid: process.pid, ppid: process.ppid };
  fs.appendFileSync(evidenceFile, `${JSON.stringify(evidence)}\n`);
}

record("launcher");
console.log(`FIXTURE_ROLE=launcher PID=${process.pid} PPID=${process.ppid}`);

if (posixMode === "cooperative" || posixMode === "ignore") {
  process.on("SIGTERM", () => {
    record("launcher-term");
    console.log(`FIXTURE_SIGNAL=SIGTERM PID=${process.pid} MODE=${posixMode}`);
  });
}

const worker = spawn(process.execPath, [workerFixture, evidenceFile], {
  stdio: ["ignore", "inherit", "inherit"],
});
worker.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
worker.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
