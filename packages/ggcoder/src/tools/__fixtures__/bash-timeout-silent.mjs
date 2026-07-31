import fs from "node:fs";

const evidenceFile = process.argv[2];
if (!evidenceFile) throw new Error("Evidence-file path is required");

const evidence = { role: "silent", pid: process.pid, ppid: process.ppid };
fs.appendFileSync(evidenceFile, `${JSON.stringify(evidence)}\n`);
setInterval(() => {}, 60_000);
