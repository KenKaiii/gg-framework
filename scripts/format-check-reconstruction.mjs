#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";

const base = "adacff0230a704d33a8cfaea8265f83cee5f95dd";
const supported = /\.(?:cjs|css|html|js|json|jsx|md|mjs|mts|ts|tsx|yaml|yml)$/i;
const tracked = execFileSync("git", ["diff", "--name-only", `${base}..HEAD`], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter((file) => file && supported.test(file));
const dirty = execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter((file) => file && supported.test(file));
const files = [...new Set([...tracked, ...dirty, "scripts/format-check-reconstruction.mjs"])];
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error("npm_execpath is unavailable");
for (let index = 0; index < files.length; index += 40) {
  const result = spawnSync(
    process.execPath,
    [pnpmCli, "exec", "prettier", "--check", ...files.slice(index, index + 40)],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
