import type http from "node:http";
import type { CheckoutRecord } from "../core/checkout-record.js";
import { log } from "../core/logger.js";
import { checkoutRoot } from "../core/shared-checkout-guard.js";
import {
  BranchSwitchError,
  listBranches,
  switchBranch,
  worktreeMoveNote,
  type BranchRow,
} from "./git-branches.js";
import { json, readBody } from "./http.js";
import {
  WorktreeRemoveError,
  listWorktrees,
  removeWorktree,
  resolveSetupCommand,
} from "./worktrees.js";

/** What the branch routes need from their window session. */
export interface BranchRouteContext {
  /** The folder this window reads git state from. */
  gitDir: () => string;
  /** A run, worker or autopilot turn is in progress. */
  isBusy: () => boolean;
  /** Goal windows cannot move into a worktree: their folder is the goal's. */
  canMove: () => boolean;
  /** This window's conversation file, so a moved window resumes it. */
  sessionPath: () => string | null;
  /** Who else uses the checkout rooted at `root`, or null. */
  sharedWith: (root: string) => Promise<string | null>;
  worktreesRoot: string;
  /** The branch changed in place: update the footer and tell the agent. */
  onSwitched: (branch: string, previous: string | null) => void;
  /** Tell the agent, once it resumes in `sessionPath`, where it moved. */
  queueMoveNote: (sessionPath: string, note: string) => void;
  /** Remember the conversation's branch so resuming it reopens that branch. */
  recordCheckout: (record: CheckoutRecord) => Promise<void>;
  /** A worktree was just made: run its setup once a window opens in it. */
  queueSetup: (worktreePath: string) => Promise<void>;
  /** How many windows (this one included) work in the checkout rooted at `root`. */
  windowsIn: (root: string) => Promise<number>;
  /** Whether another window on the checkout rooted at `root` is working. */
  othersBusyIn: (root: string) => Promise<boolean>;
}

export interface BranchesResponse {
  current: string | null;
  branches: BranchRow[];
  /** Other windows using this checkout; picking a branch then opens a worktree. */
  sharedWith: string | null;
  /** Why switching is unavailable right now, or null. */
  locked: string | null;
  /** The command a new worktree runs first, or null. */
  setup: string | null;
}

const BUSY = "Switching branches waits until the agent finishes.";

function lockReason(ctx: BranchRouteContext, shared: string | null): string | null {
  if (ctx.isBusy()) return BUSY;
  if (shared && !ctx.canMove()) {
    return `${shared} also use this folder. Switch branches from a project window instead.`;
  }
  return null;
}

export function handleBranchRoutes(
  ctx: BranchRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string,
): boolean {
  if (method === "GET" && url === "/git/branches") {
    void (async () => {
      try {
        const dir = ctx.gitDir();
        const root = await checkoutRoot(dir);
        const shared = root ? await ctx.sharedWith(root) : null;
        const list = await listBranches(dir);
        const setup = root ? await resolveSetupCommand(root) : null;
        const body: BranchesResponse = {
          ...list,
          sharedWith: shared,
          locked: lockReason(ctx, shared),
          setup: setup?.command ?? null,
        };
        json(res, 200, body);
      } catch (error) {
        log("WARN", "app-sidecar", "branch list failed", { error: String(error) });
        json(res, 500, { error: "Couldn't read this project's branches." });
      }
    })();
    return true;
  }

  if (method === "POST" && url === "/git/branch") {
    void (async () => {
      const raw = await readBody(req, res);
      if (raw === null) return;
      let body: { branch?: unknown; create?: unknown; placement?: unknown } = {};
      try {
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        /* handled below */
      }
      if (typeof body.branch !== "string" || !body.branch.trim()) {
        json(res, 400, { error: "Pick a branch." });
        return;
      }
      try {
        const dir = ctx.gitDir();
        const root = await checkoutRoot(dir);
        if (!root) {
          json(res, 400, { error: "This folder isn't a git repository." });
          return;
        }
        const shared = await ctx.sharedWith(root);
        const locked = lockReason(ctx, shared);
        if (locked) {
          json(res, 409, { error: locked });
          return;
        }
        // Switching a shared folder moves the other windows too: never under
        // an agent that is working there (its files would change mid-run).
        if (shared && body.placement === "here" && (await ctx.othersBusyIn(root))) {
          json(res, 409, {
            error:
              "Another window's agent is working in this folder. Wait for it to finish, or open the branch in its own worktree.",
          });
          return;
        }
        const outcome = await switchBranch({
          dir,
          branch: body.branch,
          create: body.create === true,
          // Shared folder: its own worktree unless the user chose to move them all.
          isolate: shared !== null && body.placement !== "here",
          worktreesRoot: ctx.worktreesRoot,
        });
        if (outcome.kind === "moved") {
          if (!ctx.canMove()) {
            json(res, 409, {
              error: `“${outcome.branch}” is open in ${outcome.path}. Open that folder in a project window.`,
            });
            return;
          }
          await ctx.recordCheckout({ branch: outcome.branch, cwd: outcome.path });
          if (outcome.created) await ctx.queueSetup(outcome.path);
          const sessionPath = ctx.sessionPath();
          if (sessionPath) ctx.queueMoveNote(sessionPath, worktreeMoveNote(root, outcome));
          log("INFO", "app-sidecar", "window moving to a worktree", {
            branch: outcome.branch,
            path: outcome.path,
            created: String(outcome.created),
          });
          json(res, 200, {
            kind: "moved",
            branch: outcome.branch,
            path: outcome.path,
            sessionPath,
          });
          return;
        }
        if (outcome.kind === "switched") {
          await ctx.recordCheckout({ branch: outcome.branch, cwd: root });
          ctx.onSwitched(outcome.branch, outcome.previous);
        }
        json(res, 200, { kind: outcome.kind, branch: outcome.branch });
      } catch (error) {
        if (error instanceof BranchSwitchError) {
          json(res, 409, { error: error.message });
          return;
        }
        log("WARN", "app-sidecar", "branch switch failed", { error: String(error) });
        json(res, 500, { error: "Couldn't switch branches." });
      }
    })();
    return true;
  }
  if (method === "GET" && url.startsWith("/git/worktrees")) {
    void (async () => {
      const target = new URL(url, "http://local").searchParams.get("cwd") || ctx.gitDir();
      try {
        const list = await listWorktrees(target, ctx.worktreesRoot);
        json(res, 200, list ?? { mainPath: null, mainBranch: null, worktrees: [] });
      } catch (error) {
        log("WARN", "app-sidecar", "worktree list failed", { error: String(error) });
        json(res, 500, { error: "Couldn't list this project's worktrees." });
      }
    })();
    return true;
  }

  if (method === "POST" && url === "/git/worktrees/remove") {
    void (async () => {
      const raw = await readBody(req, res);
      if (raw === null) return;
      let body: { cwd?: unknown; path?: unknown; force?: unknown } = {};
      try {
        body = raw ? (JSON.parse(raw) as typeof body) : {};
      } catch {
        /* handled below */
      }
      if (typeof body.path !== "string" || !body.path) {
        json(res, 400, { error: "Pick a worktree." });
        return;
      }
      try {
        const root = await checkoutRoot(body.path);
        await removeWorktree({
          dir: typeof body.cwd === "string" && body.cwd ? body.cwd : ctx.gitDir(),
          target: body.path,
          managedRoot: ctx.worktreesRoot,
          force: body.force === true,
          openWindows: root ? await ctx.windowsIn(root) : 0,
        });
        log("INFO", "app-sidecar", "worktree removed", { path: body.path });
        json(res, 200, { ok: true });
      } catch (error) {
        if (error instanceof WorktreeRemoveError) {
          json(res, 409, { error: error.message, dirty: error.dirty });
          return;
        }
        log("WARN", "app-sidecar", "worktree remove failed", { error: String(error) });
        json(res, 500, { error: "Couldn't remove that worktree." });
      }
    })();
    return true;
  }
  return false;
}
