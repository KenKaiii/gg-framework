import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

function onPath(name: string): boolean {
  const win = process.platform === "win32";
  const exts = win ? (process.env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        accessSync(file, win ? constants.F_OK : constants.X_OK);
        if (statSync(file).isFile()) return true;
      } catch {
        // Not here; try the next folder.
      }
    }
  }
  return false;
}

/**
 * True when a test that shells out to these system tools should skip because
 * one is not installed, with a note saying which. CI installs them, so there a
 * missing tool always fails the test instead of skipping it.
 */
export function missingSystemTools(file: string, ...names: string[]): boolean {
  // vitest.config.ts forces CI=false in workers, so detect GitHub Actions directly.
  if (process.env.GITHUB_ACTIONS === "true") return false;
  const missing = names.filter((name) => !onPath(name));
  if (missing.length === 0) return false;
  console.warn(`Skipping parts of ${file}: ${missing.join(", ")} not found on PATH.`);
  return true;
}
