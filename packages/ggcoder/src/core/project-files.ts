import { runBackgroundGit } from "../utils/git.js";

/** Most files the prompt's Environment section lists, shallowest first. */
export const PROJECT_FILES_SHOWN = 60;

export interface ProjectFileList {
  /** Every listed file in the work tree under `cwd`. */
  total: number;
  /** The shallowest {@link PROJECT_FILES_SHOWN}, in a stable order. */
  shown: readonly string[];
}

// Large monorepos list in well under a second; past this the line is skipped.
const LIST_TIMEOUT_MS = 5_000;

/**
 * Files under `cwd` (tracked, plus untracked but not ignored), shallowest
 * first, so the model can read the right files in its first call instead of
 * listing them. `null` outside a git work tree, when git fails or times out,
 * or when nothing is listed.
 */
export async function listProjectFiles(
  cwd: string,
  signal?: AbortSignal,
): Promise<ProjectFileList | null> {
  let stdout: string;
  try {
    ({ stdout } = await runBackgroundGit(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, signal, timeoutMs: LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    return null;
  }
  const files = [
    ...new Set(
      stdout
        .split("\0")
        // GG's own state isn't project code; control characters would break the line.
        // eslint-disable-next-line no-control-regex
        .filter((f) => f && !f.startsWith(".gg/") && !/[\u0000-\u001f]/.test(f)),
    ),
  ].sort(byDepthThenPath);
  if (files.length === 0) return null;
  return { total: files.length, shown: files.slice(0, PROJECT_FILES_SHOWN) };
}

function byDepthThenPath(a: string, b: string): number {
  const depth = a.split("/").length - b.split("/").length;
  if (depth !== 0) return depth;
  return a < b ? -1 : a > b ? 1 : 0;
}
