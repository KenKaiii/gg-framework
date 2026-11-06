import type { AuthStorage } from "../auth-storage.js";
import { log } from "../logger.js";
import type { OAuthLoginCallbacks } from "../oauth/types.js";
import {
  claudeCodeAuthStatus,
  ensureClaudeCodeBinary,
  formatClaudeCodeInstallProgress,
  loginClaudeCode,
  logoutClaudeCode,
  resolveClaudeCodeBinary,
  type ClaudeCodeAuthStatus,
  type ClaudeCodeRunOptions,
  type EnsureClaudeCodeOptions,
} from "./runtime.js";
import { clearClaudeCodeUsage } from "./usage.js";

export type ClaudeCodeSignInOptions = EnsureClaudeCodeOptions & ClaudeCodeRunOptions;

/**
 * "Sign in with Claude": download Claude Code if it is missing, run its browser
 * sign-in, confirm it with `claude auth status`, then record the marker.
 */
export async function signInWithClaudeCode(
  auth: Pick<AuthStorage, "setClaudeCodeLogin">,
  callbacks: OAuthLoginCallbacks,
  opts: ClaudeCodeSignInOptions = {},
): Promise<ClaudeCodeAuthStatus> {
  if (!opts.binary && !resolveClaudeCodeBinary(opts)) {
    callbacks.onStatus("Downloading Claude Code (one time)…");
    await ensureClaudeCodeBinary({
      ...opts,
      onProgress: (progress) => {
        callbacks.onStatus(formatClaudeCodeInstallProgress(progress));
        opts.onProgress?.(progress);
      },
    });
  }
  // GG Coder's own Claude Code login may still be signed in from before.
  let status = await claudeCodeAuthStatus(opts);
  if (!status.loggedIn) {
    callbacks.onStatus("Opening Claude sign-in…");
    await loginClaudeCode(callbacks, opts);
    status = await claudeCodeAuthStatus(opts);
  }
  if (!status.loggedIn) throw new Error("Claude sign-in didn't finish. Try again.");
  await auth.setClaudeCodeLogin();
  return status;
}

/** Sign out of Claude Code and drop the marker. The marker goes even if `claude auth logout` fails. */
export async function signOutOfClaudeCode(
  auth: Pick<AuthStorage, "clearClaudeCodeLogin">,
  opts: ClaudeCodeRunOptions = {},
): Promise<void> {
  await auth.clearClaudeCodeLogin();
  await clearClaudeCodeUsage(opts);
  try {
    await logoutClaudeCode(opts);
  } catch (err) {
    log(
      "WARN",
      "auth",
      `claude auth logout failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
