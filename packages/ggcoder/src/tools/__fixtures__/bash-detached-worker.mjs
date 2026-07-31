import fs from "node:fs";

const [evidenceFile, readinessFile] = process.argv.slice(2);
if (!evidenceFile || !readinessFile) {
  throw new Error("Expected evidence and readiness file paths");
}

fs.appendFileSync(
  evidenceFile,
  `${JSON.stringify({ role: "detached-worker", pid: process.pid, ppid: process.ppid })}\n`,
);
fs.writeFileSync(readinessFile, String(process.pid));

process.on("SIGTERM", () => {
  fs.appendFileSync(
    evidenceFile,
    `${JSON.stringify({ role: "detached-worker-term-ignored", pid: process.pid, ppid: process.ppid })}\n`,
  );
});

setInterval(() => {}, 1_000);
