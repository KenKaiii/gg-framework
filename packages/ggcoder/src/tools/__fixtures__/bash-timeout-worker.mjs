import fs from "node:fs";

const evidenceFile = process.argv[2];
if (!evidenceFile) throw new Error("Evidence-file path is required");

const evidence = { role: "worker", pid: process.pid, ppid: process.ppid };
fs.appendFileSync(evidenceFile, `${JSON.stringify(evidence)}\n`);
console.log(`FIXTURE_ROLE=worker PID=${process.pid} PPID=${process.ppid}`);
setInterval(() => {}, 60_000);
