/**
 * What an empty transcript says about the agent while it isn't ready: only
 * trouble getting it going (connecting, a failed start). A run in progress
 * ("thinking…", cancelling) says nothing there: the activity bar already
 * shows it, and a goal's first reply runs before anything is in the chat.
 */
export function emptyTranscriptStatus(status: string): string | null {
  return /^(connecting|agent failed)/.test(status) ? status : null;
}
