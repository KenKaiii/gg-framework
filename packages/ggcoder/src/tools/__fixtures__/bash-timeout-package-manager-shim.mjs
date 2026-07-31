import { spawn } from "node:child_process";
import fs from "node:fs";

const [evidenceFile, launcherFixture, workerFixture] = process.argv.slice(2);
if (!evidenceFile || !launcherFixture || !workerFixture) {
  throw new Error("Evidence file, launcher fixture, and worker fixture are required");
}

const evidence = { role: "package-manager-shim", pid: process.pid, ppid: process.ppid };
fs.appendFileSync(evidenceFile, `${JSON.stringify(evidence)}\n`);
console.log(`FIXTURE_ROLE=package-manager-shim PID=${process.pid} PPID=${process.ppid}`);

const launcher = spawn(process.execPath, [launcherFixture, evidenceFile, workerFixture], {
  stdio: ["ignore", "inherit", "inherit"],
});
launcher.once("error", (error) => {
  console.error(error);
  process.exit(1);
});
launcher.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
