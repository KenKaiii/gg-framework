import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve, join, basename, isAbsolute } from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import {
  createWorktree,
  removeWorktree,
  sanitizeWorktreeName,
  getTrueRepoRoot,
  getDefaultRemoteBranch,
  generateWorktreeName,
} from "../core/worktree.js";
import type { HookRunner } from "../core/hooks.js";

const WorktreeParams = z.object({
  action: z.enum(["create", "remove", "list"]).describe("The worktree action to perform"),
  name: z.string().optional().describe("Name/slug for the worktree (for create action)"),
  path: z.string().optional().describe("Path to the worktree (for remove action)"),
});

export function createWorktreeTool(
  cwd: string,
  hookRunner?: HookRunner,
): AgentTool<typeof WorktreeParams> {
  return {
    name: "worktree",
    description:
      "Manage git worktrees for isolated development. Creates worktrees with proper sanitization and hook integration.",
    parameters: WorktreeParams,
    async execute(args) {
      // For "list" action, use execFile to run git worktree list
      if (args.action === "list") {
        return new Promise((resolve) => {
          execFile("git", ["worktree", "list"], { cwd }, (error, stdout, stderr) => {
            if (error) {
              resolve(`Failed to list worktrees: ${stderr || error.message}`);
            } else {
              resolve(stdout.trim() || "No worktrees found.");
            }
          });
        });
      }

      if (args.action === "create") {
        const repoRoot = await getTrueRepoRoot(cwd);
        if (!repoRoot) {
          return "Not inside a git repository.";
        }

        const rawName = args.name || generateWorktreeName();
        const safeName = sanitizeWorktreeName(rawName);
        const baseBranch = await getDefaultRemoteBranch(repoRoot);

        // Try hooks first
        if (hookRunner) {
          try {
            const hookPath = await hookRunner.runWorktreeCreateHook(safeName);
            if (hookPath) {
              // Validate hook-returned path
              if (isAbsolute(hookPath)) {
                try {
                  await stat(hookPath);
                  return JSON.stringify({
                    path: hookPath,
                    name: safeName,
                    branch: `worktree-${safeName}`,
                    baseBranch,
                  });
                } catch {
                  // Hook path doesn't exist, fall through to built-in creation
                }
              }
            }
          } catch {
            // Hook failed — fall through to built-in creation
          }
        }

        // Fall back to built-in creation
        try {
          const wtPath = await createWorktree({ repoRoot, name: safeName, baseBranch });
          return JSON.stringify({
            path: wtPath,
            name: safeName,
            branch: `worktree-${safeName}`,
            baseBranch,
          });
        } catch (err) {
          return `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      if (args.action === "remove") {
        if (!args.path) {
          return "Path is required for remove action.";
        }
        const repoRoot = await getTrueRepoRoot(cwd);
        if (!repoRoot) {
          return "Not inside a git repository.";
        }

        // Validate path is under .gg/worktrees/
        const resolvedPath = resolve(cwd, args.path);
        const allowedPrefix = join(repoRoot, ".gg", "worktrees") + "/";
        if (!resolvedPath.startsWith(allowedPrefix)) {
          return "Refused: path is not under .gg/worktrees/";
        }

        // Try hooks first
        if (hookRunner) {
          try {
            const hookRan = await hookRunner.runWorktreeRemoveHook(resolvedPath);
            if (hookRan) {
              return "Worktree removed via hook.";
            }
          } catch {
            // Hook failed — fall through to built-in removal
          }
        }

        // Derive branch name from path
        const dirName = basename(resolvedPath);

        try {
          await removeWorktree({
            repoRoot,
            worktreePath: resolvedPath,
            branchName: dirName ? `worktree-${dirName}` : undefined,
          });
          return "Worktree removed.";
        } catch (err) {
          return `Worktree removal may have failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return "Unknown action.";
    },
  };
}
