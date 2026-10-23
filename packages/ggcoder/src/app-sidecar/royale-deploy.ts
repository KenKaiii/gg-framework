// ── GG Royale "shipped it" detector ─────────────────────────────────────
// Pure: given one run's transcript slice, decide whether a deploy (or a
// package publish) command ran in the shell and succeeded. Only "a deploy
// happened" ever leaves the machine: never the command, its output, the
// site, or any path.

import type { MessageLike } from "./royale-bug.js";

const SHELL_TOOLS = new Set(["bash", "shell"]);

/**
 * Commands that put something live. Each is matched within one command of a
 * pipeline or chain (no `;`, `|` or `&` in between), so "vercel env ls; echo
 * deploy" doesn't count.
 */
const DEPLOY_RES: readonly RegExp[] = [
  /\bvercel\b[^;&|\n]*(\bdeploy\b|--prod\b)/i,
  /\bnetlify\b[^;&|\n]*\bdeploy\b/i,
  /\bwrangler\b[^;&|\n]*\b(deploy|publish)\b/i,
  /\bfly(ctl)?\b[^;&|\n]*\bdeploy\b/i,
  /\bfirebase\b[^;&|\n]*\bdeploy\b/i,
  /\brailway\b[^;&|\n]*\b(up|deploy)\b/i,
  /\bgcloud\b[^;&|\n]*\b(app|run|functions)\b[^;&|\n]*\bdeploy\b/i,
  /\b(sls|serverless|cdk|amplify)\b[^;&|\n]*\b(deploy|publish)\b/i,
  /\bgit\s+push\s+(heroku|dokku)\b/i,
  /\bsurge\b(\s|$)/i,
  // A project's own deploy script, and publishing a package.
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?deploy\b/i,
  /\b(npm|pnpm|yarn|bun)\s+publish\b/i,
];

/** Rehearsals that don't ship anything. */
const DRY_RE = /--dry-run\b|--dryrun\b|\bdry-run\b/i;

/** Whether a shell command (one tool call's text) deploys or publishes. */
export function isDeployCommand(command: string): boolean {
  if (DRY_RE.test(command)) return false;
  return DEPLOY_RES.some((re) => re.test(command));
}

/** Bash results begin "Exit code: N" (or TIMEOUT…). Unknown → null. */
function exitOk(result: string, isError: boolean | undefined): boolean | null {
  const m = /^Exit code: (\S+)/.exec(result);
  if (m) return m[1] === "0";
  return isError === true ? false : null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: unknown) =>
      typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string"
        ? (c as { text: string }).text
        : "",
    )
    .join("\n");
}

/** True when the run's shell ran a deploy (or publish) that exited 0. */
export function detectDeploy(messages: ReadonlyArray<MessageLike>): boolean {
  const deploys = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const part of m.content) {
      if (m.role === "assistant" && part.type === "tool_call" && part.id && part.name) {
        const cmd = part.args?.command;
        if (SHELL_TOOLS.has(part.name) && typeof cmd === "string" && isDeployCommand(cmd)) {
          deploys.add(part.id);
        }
      } else if (m.role === "tool" && part.type === "tool_result" && part.toolCallId) {
        if (!deploys.has(part.toolCallId)) continue;
        if (exitOk(textOf(part.content), part.isError) === true) return true;
      }
    }
  }
  return false;
}
