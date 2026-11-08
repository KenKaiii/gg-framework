/**
 * Make GG's background git slow on demand: put a `git` first on PATH that
 * answers `rev-parse` (the repo check) only after `delaySeconds` and runs the
 * real git for everything else. Returns the shim's folder so the caller can
 * remove it. POSIX only: on Windows GG resolves git.exe itself.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";

export async function slowRevParseGit(delaySeconds: number): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "gg-slow-git-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shim = path.join(dir, "git");
  await writeFile(
    shim,
    `#!/bin/sh\ncase " $* " in *" rev-parse "*) sleep ${delaySeconds} ;; esac\nexec "${realGit}" "$@"\n`,
  );
  await chmod(shim, 0o755);
  vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH ?? ""}`);
  return dir;
}
