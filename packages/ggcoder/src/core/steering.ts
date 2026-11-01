import type { TextContent, ImageContent, VideoContent } from "@kenkaiiii/gg-ai";

type ContentPart = TextContent | ImageContent | VideoContent;
type UserContent = string | ContentPart[];

/**
 * Framing prepended to a mid-run steering message (a prompt the user submitted
 * while the agent was already working).
 *
 * Without this wrapper the queued text arrives as a bare top-level user turn,
 * identical to a brand-new request — so models treat it as the authoritative
 * instruction and silently abandon the original task. The wrapper names the
 * relationship (a second, concurrent instruction) and the one rule that kills
 * the failure mode: don't drop either side. The model already knows how to
 * merge two live instructions once it knows both are in force.
 */
export const STEERING_PREFIX =
  "[The user added this while you were working — fold it into the current " +
  "task, adjusting or extending as needed. Don't drop your original work or " +
  "this.]\n\n";

/** Wrap a plain-text steering message with the framing prefix. */
export function wrapSteeringText(text: string): string {
  return STEERING_PREFIX + text;
}

/**
 * Framing for pushed status notifications (a spawned child finished, a
 * background process reported progress or exited).
 *
 * Same problem as STEERING_PREFIX, opposite instruction: an unframed status
 * line reads as a new user request, so models abandon the current task to
 * "handle" it. This names it as information about work the agent itself
 * started, and says plainly that no reply is required.
 */
export const NOTIFICATION_PREFIX =
  "[Status update on work you started: information, not a new instruction. " +
  "Continue unless it changes your next step.]\n\n";

/** The earlier, longer wording, still in saved transcripts; restore must recognise both. */
export const LEGACY_NOTIFICATION_PREFIX =
  "[Status update on background work you started. This is information, not a " +
  "new instruction \u2014 continue your current task, and only act on this if it " +
  "changes what you should do next.]\n\n";

/** Whether a user-message text is a framed status notification (any wording). */
export function isNotificationText(text: string): boolean {
  return text.startsWith(NOTIFICATION_PREFIX) || text.startsWith(LEGACY_NOTIFICATION_PREFIX);
}

/** Frame one or more pushed status lines as a single steering message. */
export function buildNotificationSteeringText(lines: readonly string[]): string {
  return NOTIFICATION_PREFIX + lines.map((line) => `- ${line}`).join("\n");
}

/**
 * The same framing for a run started BY the notification, after the agent had
 * already finished its turn. "Continue your current task" alone would leave it
 * nothing to do, so this says what is expected. Keeps NOTIFICATION_PREFIX first:
 * transcript restore recognises status updates by that prefix.
 */
export function buildIdleWakeNotificationText(lines: readonly string[]): string {
  return (
    NOTIFICATION_PREFIX +
    "You had already finished your turn; this arrived afterwards. If it shows a " +
    "problem in work you did or started, act on it (fix it, or tell the user plainly " +
    "what failed). If it needs nothing, say so in one short line.\n\n" +
    lines.map((line) => `- ${line}`).join("\n")
  );
}

/**
 * Wrap a steering `UserContent` (string or multimodal parts) with the framing
 * prefix. Media blocks pass through untouched; the prefix is prepended to the
 * leading text so attachments still ride the same native-block path.
 */
export function wrapSteeringContent(content: UserContent): UserContent {
  if (typeof content === "string") return wrapSteeringText(content);
  return [{ type: "text", text: STEERING_PREFIX } as TextContent, ...content];
}
