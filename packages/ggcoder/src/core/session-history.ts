import type { Message, MessageProvenance } from "@kleio/ai";
import type { CompactionAnchorRemap } from "./compaction/compactor.js";
import type {
  AutopilotMarkerPayload,
  AppMarkerPayload,
  KenTurnPayload,
} from "./session-manager.js";
import { STEERING_PREFIX, NOTIFICATION_PREFIX } from "./steering.js";
import { matchPromptCommand } from "./prompt-command-expansion.js";
import { AUTOPILOT_INJECTION_PREAMBLE } from "./autopilot-cycle.js";

export type HistoryMessageVisibility = "transcript" | "hidden" | "summary";

const LEGACY_COMPACTION_SUMMARY_PREFIX = "[Previous conversation summary]";
const LEGACY_COMPACTION_ACK =
  "I have the full context from the summary above, including where work left off and the next step.";

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .flatMap((part) => ("text" in part && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

/** Metadata-first transcript visibility with prefix fallback for legacy JSONL. */
export function getHistoryMessageVisibility(message: Message): HistoryMessageVisibility {
  if (message.provenance) return message.provenance.visibility;
  if (message.role === "system") return "hidden";

  const text = messageText(message);
  if (message.role === "user") {
    if (text.startsWith(LEGACY_COMPACTION_SUMMARY_PREFIX)) return "summary";
    if (isNotification(text) || hasAutopilotPreamble(stripSteering(text))) return "hidden";
  }
  if (message.role === "assistant" && text.startsWith(LEGACY_COMPACTION_ACK)) return "hidden";
  return "transcript";
}

export interface HistoryCheckpoint {
  header: { id: string; parentSessionId?: string; retainedMessageCount?: number };
  messages: readonly Message[];
}

function canonicalHistoryValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n").trimEnd();
  if (Array.isArray(value)) return value.map(canonicalHistoryValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalHistoryValue(entry)]),
    );
  }
  return value;
}

/**
 * Rebuild a display transcript from a contiguous checkpoint chain.
 *
 * Compaction writes the retained tail into the child with fresh session-entry
 * ids. The largest ordered suffix/prefix overlap therefore compares normalized
 * message role, content, and provenance rather than persistence ids. A child's
 * summary is omitted only when its direct parent is readable; the oldest loaded
 * checkpoint keeps its summary as the fallback for a broken chain.
 */
export function reconstructCheckpointHistory(checkpoints: readonly HistoryCheckpoint[]): Message[] {
  const transcript: Message[] = [];
  const transcriptKeys: string[] = [];

  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index]!;
    const parent = checkpoints[index - 1];
    const parentAvailable =
      parent !== undefined && checkpoint.header.parentSessionId === parent.header.id;
    const messages = checkpoint.messages.filter((message) => {
      const visibility = getHistoryMessageVisibility(message);
      return visibility !== "hidden" && !(visibility === "summary" && parentAvailable);
    });
    const keys = messages.map((message) =>
      JSON.stringify(
        canonicalHistoryValue({
          role: message.role,
          content: message.content,
          provenance: message.provenance ?? null,
        }),
      ),
    );

    const maximumOverlap = Math.min(
      transcriptKeys.length,
      keys.length,
      checkpoint.header.retainedMessageCount ?? keys.length,
    );
    let overlap = maximumOverlap;
    while (overlap > 0) {
      const transcriptStart = transcriptKeys.length - overlap;
      let matches = true;
      for (let offset = 0; offset < overlap; offset += 1) {
        if (transcriptKeys[transcriptStart + offset] !== keys[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) break;
      overlap -= 1;
    }

    transcript.push(...messages.slice(overlap));
    transcriptKeys.push(...keys.slice(overlap));
  }

  return transcript;
}

/** Replay every non-system message and flush anchor work after each one. */
export async function replayMessagesInOrder(
  messages: readonly Message[],
  visitMessage: (message: Message, count: number) => void | Promise<void>,
  afterMessage: (count: number) => void | Promise<void>,
): Promise<void> {
  let count = 0;
  for (const message of messages) {
    if (message.role === "system") continue;
    count += 1;
    try {
      await visitMessage(message, count);
    } finally {
      await afterMessage(count);
    }
  }
}
/**
 * Move a transcript anchor (`afterMessageCount`) from the pre-compaction
 * message list onto the compacted one.
 *
 * Compaction folds the leading `summarizedCount` non-system messages into a
 * `prefixCount`-message summary block and keeps the rest verbatim. Anchors
 * inside the collapsed region land right after the summary (their surrounding
 * conversation no longer exists); anchors in the retained tail shift by the
 * difference. Without this, re-persisted markers keep indices from a much
 * longer transcript — they then replay far too late, or past the end, which is
 * what bunches old Ken bubbles and error rows at the bottom on resume.
 */
export function remapAnchorForCompaction(anchor: number, remap: CompactionAnchorRemap): number {
  const moved =
    anchor <= remap.summarizedCount
      ? Math.min(anchor, remap.prefixCount)
      : anchor - remap.summarizedCount + remap.prefixCount;
  // The retained tail can be shorter than the collapse implies (tool-pairing
  // repair, trailing-assistant pop), so clamp to the real end of the new list.
  return Math.min(moved, remap.newNonSystemCount);
}

/**
 * Drop the read-only file-order position before writing a marker back to disk.
 * It describes where a marker sat in the file it was READ from, so persisting
 * it into a rewritten file would bake in a position that no longer applies —
 * the next load recomputes it anyway.
 */
export function stripRecordedPosition<T extends { recordedAfterMessageCount?: number }>(
  payload: T,
): Omit<T, "recordedAfterMessageCount"> {
  const { recordedAfterMessageCount: _ignored, ...rest } = payload;
  return rest;
}

export interface HistoryAutopilotMarker extends AutopilotMarkerPayload {
  /** Stable seed derived from persisted marker data for deterministic UI copy. */
  copySeed: string;
}

function markerKey(marker: AutopilotMarkerPayload): string {
  return JSON.stringify({
    phase: marker.phase,
    afterMessageCount: marker.afterMessageCount,
    reason: marker.reason ?? null,
    body: marker.body ?? null,
  });
}

export function autopilotMarkerCopySeed(marker: AutopilotMarkerPayload): string {
  return `${marker.phase}\0${marker.afterMessageCount}\0${marker.reason ?? ""}\0${marker.body ?? ""}`;
}

/**
 * Resolve the replay position for one persisted marker.
 *
 * A marker's anchor counts messages that were ALREADY on disk when it was
 * recorded, and markers are appended after those messages — so a correctly
 * written marker can never sit at a file position lower than its own anchor.
 * File order is therefore a hard ceiling, and an anchor above it is provably
 * stale. Two historical paths produced exactly that:
 *
 *  - compaction re-persisted markers into the continuation file while they
 *    still carried indices from the much longer pre-compaction transcript;
 *  - older sessions anchored against the in-memory message list, which runs
 *    ahead of the file whenever a run fails before its messages are flushed.
 *
 * Both make markers replay far too late — bunched at the bottom of a reopened
 * session, or dropped entirely when the anchor overshoots the end. Clamping to
 * the file position fixes both. The clamp only ever moves an anchor DOWN;
 * markers written before their messages landed (fire-and-forget persistence)
 * legitimately sit below their file position and are left alone.
 *
 * `ceilingOffset` covers markers deliberately anchored ahead of the file — the
 * user_hint that attaches to the user message a prompt is about to push.
 * Returns null when even the clamped anchor falls outside the transcript.
 */
function resolveAnchor(
  marker: { afterMessageCount: number; recordedAfterMessageCount?: number },
  maxAfterMessageCount: number,
  ceilingOffset = 0,
): number | null {
  const ceiling =
    marker.recordedAfterMessageCount === undefined
      ? Number.POSITIVE_INFINITY
      : marker.recordedAfterMessageCount + ceilingOffset;
  const anchor = Math.min(marker.afterMessageCount, ceiling);
  return anchor <= maxAfterMessageCount ? anchor : null;
}

/**
 * Normalize persisted autopilot markers for transcript replay.
 *
 * Stale anchors are pulled back to where the marker was actually written (see
 * {@link resolveAnchor}); anything still outside the restored transcript is
 * dropped rather than replayed at EOF, which is what bunched old Ken all-clear
 * bubbles at the bottom. Exact duplicate payloads from old rewrite/re-persist
 * paths are deduped.
 */
export function normalizeAutopilotMarkersForHistory(
  markers: readonly AutopilotMarkerPayload[],
  maxAfterMessageCount: number,
): HistoryAutopilotMarker[] {
  const seen = new Set<string>();
  const normalized: HistoryAutopilotMarker[] = [];

  for (const marker of markers) {
    const anchor = resolveAnchor(marker, maxAfterMessageCount);
    if (anchor === null) continue;
    const key = markerKey(marker);
    if (seen.has(key)) continue;
    seen.add(key);
    // The copy seed stays tied to the PERSISTED anchor so the all-clear wording
    // a resumed session shows matches the one the live run broadcast.
    normalized.push({
      ...marker,
      afterMessageCount: anchor,
      copySeed: autopilotMarkerCopySeed(marker),
    });
  }

  return normalized;
}

/**
 * Normalize persisted app transcript markers for replay: drop markers whose
 * anchor points beyond the restored message list (stale after compaction) and
 * dedupe exact payloads (old rewrite paths could re-append). Mirrors
 * {@link normalizeAutopilotMarkersForHistory}.
 */
export function normalizeAppMarkersForHistory(
  markers: readonly AppMarkerPayload[],
  maxAfterMessageCount: number,
): AppMarkerPayload[] {
  const seen = new Set<string>();
  const normalized: AppMarkerPayload[] = [];
  for (const marker of markers) {
    // user_hint is anchored +1 on purpose so it decorates the user row a prompt
    // is about to add; everything else must not exceed its file position.
    const anchor = resolveAnchor(marker, maxAfterMessageCount, marker.kind === "user_hint" ? 1 : 0);
    if (anchor === null) continue;
    const key = JSON.stringify({
      kind: marker.kind,
      afterMessageCount: marker.afterMessageCount,
      data: marker.data,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(
      anchor === marker.afterMessageCount ? marker : { ...marker, afterMessageCount: anchor },
    );
  }
  return normalized;
}

/**
 * Normalize persisted Ken turns for replay. Unlike autopilot/app markers, Ken
 * turns carry real conversation — an out-of-range anchor (stale after
 * compaction) is CLAMPED to the last message instead of dropped, so the
 * exchange still renders (at the end, in order) rather than vanishing. Exact
 * duplicate payloads (old rewrite/re-persist paths) are deduped.
 */
export function normalizeKenTurnsForHistory(
  turns: readonly KenTurnPayload[],
  maxAfterMessageCount: number,
): KenTurnPayload[] {
  const seen = new Set<string>();
  const normalized: KenTurnPayload[] = [];
  for (const turn of turns) {
    const key = JSON.stringify({ q: turn.question, r: turn.reply, a: turn.afterMessageCount });
    if (seen.has(key)) continue;
    seen.add(key);
    // File order first, EOF clamp only as a last resort — clamping is exactly
    // what stacked resumed Ken exchanges at the bottom of the transcript.
    const anchor = resolveAnchor(turn, maxAfterMessageCount) ?? maxAfterMessageCount;
    normalized.push(
      anchor === turn.afterMessageCount ? turn : { ...turn, afterMessageCount: anchor },
    );
  }
  return normalized;
}

// ── User-row reconstruction ────────────────────────────────────────
// The persisted user message is what the MODEL saw — steering wrapper, saved-
// path notes, attached-files block. The live bubble showed only the typed
// text, so resume must strip the machine framing back out.

/** Separator AgentSession.buildAttachmentParts uses before the file-notes
 *  block appended to a user message's leading text part. */
const ATTACHED_FILES_HEADER = "Attached files (inspect with your tools):";

/** Attachment-note text parts injected alongside the typed text. These never
 *  appeared in the live user bubble. */
const ATTACHMENT_NOTE_PATTERNS = [
  /^\[Image saved at .+\]$/s,
  /^The user attached a video at .+/s,
  /^\[User attached a video file .+\]$/s,
];

export interface RestoredUserRow {
  /** The typed text as the live bubble showed it. */
  text: string;
  /** Attached image data URLs. */
  images: string[];
  /** True when the message carried a video the model could NOT watch natively
   *  (live showed an info row after the bubble). */
  videoWarning: boolean;
  /** True when autopilot injected this turn (the message carried the
   *  situational-awareness preamble). No human typed it, and the live
   *  transcript showed NO user bubble for it — only the Ken-tinted autopilot
   *  marker. Resume must skip the row, or the injected body renders twice:
   *  once styled as Ken's marker, once raw as a user message. */
  autopilotInjected: boolean;
  /** True when this "user" message is a pushed background-work status update
   *  (a spawned child finished, a background process logged or exited) rather
   *  than anything a human sent.
   *
   *  The live transcript shows NO bubble for these — the loop yields
   *  `steering_message`, which no host renders. They are persisted only because
   *  they are real context the model saw. Resume must skip them too, or a
   *  reopened session is full of machine-facing status lines the user never saw
   *  while working. */
  notification: boolean;
}

function stripSteering(text: string): string {
  return text.startsWith(STEERING_PREFIX) ? text.slice(STEERING_PREFIX.length) : text;
}

/** Whether a persisted user message is a pushed background-status update.
 *  `buildNotificationSteeringText` adds this prefix and nothing else does. */
function isNotification(text: string): boolean {
  return text.startsWith(NOTIFICATION_PREFIX);
}

/** Strip the autopilot situational-awareness preamble that the sidecar prepends
 *  to every autopilot-injected build-session run (see frameAutopilotInjection).
 *  The live transcript shows the clean body via the autopilot "prompted" marker;
 *  on resume the raw session message must render the same clean instruction, not
 *  the machine-facing preamble. */
function stripAutopilotPreamble(text: string): string {
  return hasAutopilotPreamble(text)
    ? text.slice(AUTOPILOT_INJECTION_PREAMBLE.length).trimStart()
    : text;
}

/** Whether a persisted user message was injected by autopilot rather than typed
 *  by a human. frameAutopilotInjection adds this preamble to every injected
 *  build run, and nothing else produces it. */
function hasAutopilotPreamble(text: string): boolean {
  return text.startsWith(AUTOPILOT_INJECTION_PREAMBLE);
}

function stripAttachedFilesBlock(text: string): string {
  if (text.startsWith(ATTACHED_FILES_HEADER)) return "";
  const idx = text.indexOf(`\n\n${ATTACHED_FILES_HEADER}`);
  return idx === -1 ? text : text.slice(0, idx);
}

/** Rebuild the live user bubble from a persisted user message's content. */
export function restoreUserRow(
  content: Message["content"],
  provenance?: MessageProvenance,
): RestoredUserRow {
  if (typeof content === "string") {
    const unsteered = stripSteering(content);
    const legacy = !provenance;
    return {
      text: stripAttachedFilesBlock(legacy ? stripAutopilotPreamble(unsteered) : unsteered).trim(),
      images: [],
      videoWarning: false,
      autopilotInjected:
        provenance?.kind === "automation" || (legacy && hasAutopilotPreamble(unsteered)),
      notification: provenance?.kind === "notification" || (legacy && isNotification(content)),
    };
  }
  const images: string[] = [];
  const textParts: string[] = [];
  let videoWarning = false;
  let autopilotInjected = provenance?.kind === "automation";
  let notification = provenance?.kind === "notification";
  const legacy = !provenance;
  for (const c of content) {
    if (c.type === "image") {
      images.push(`data:${c.mediaType};base64,${c.data}`);
      continue;
    }
    if (c.type !== "text" || typeof c.text !== "string") continue;
    if (legacy && isNotification(c.text)) notification = true;
    const unsteered = stripSteering(c.text);
    if (legacy && hasAutopilotPreamble(unsteered)) autopilotInjected = true;
    const stripped = legacy ? stripAutopilotPreamble(unsteered) : unsteered;
    if (stripped.startsWith("[User attached a video file")) videoWarning = true;
    if (ATTACHMENT_NOTE_PATTERNS.some((re) => re.test(stripped))) continue;
    const cleaned = stripAttachedFilesBlock(stripped);
    if (cleaned.trim()) textParts.push(cleaned);
  }
  return {
    text: textParts.join("\n\n").trim(),
    images,
    videoWarning,
    autopilotInjected,
    notification,
  };
}

// ── Slash-command reconstruction ──────────────────────────────
// A `/name` command is expanded before it reaches the model, so the persisted
// user message is the FULL template body — not the short chip the user saw.

/**
 * Reverse a prompt-template command's expansion by matching the restored body
 * against the known templates.
 *
 * Best-effort only: it works while a template is byte-identical to the one that
 * produced the message, and templates drift (edited `.gg/commands/*.md`,
 * reworded built-ins, app-vs-CLI phrasing). Prefer the invocation recorded at
 * send time — see {@link resolveRestoredCommand}. Returns null when the text
 * isn't a known command body (an ordinary user message).
 */
export function detectPromptCommand(
  text: string,
  candidates: ReadonlyArray<{ name: string; prompt: string }>,
): string | null {
  const match = matchPromptCommand(text, candidates);
  if (!match) return null;
  return `/${match.command.name}${match.args ? ` ${match.args}` : ""}`;
}

/**
 * The `/name [args]` chip a restored user row should show, or null for an
 * ordinary message.
 *
 * The invocation persisted with the prompt wins: it's exactly what the user
 * typed and survives any later template edit. Sessions recorded before that was
 * persisted fall back to matching the expanded body, which is why an edited
 * command used to resume as its raw multi-KB template.
 */
export function resolveRestoredCommand(
  persistedCommand: string | null | undefined,
  text: string,
  candidates: ReadonlyArray<{ name: string; prompt: string }>,
): string | null {
  if (typeof persistedCommand === "string" && persistedCommand.trim()) {
    return persistedCommand.trim();
  }
  return detectPromptCommand(text, candidates);
}

/**
 * Recover the on-disk paths of tool-produced images from the tool result's
 * text block. Live SSE carries them in `details.imagePreviews`, but that is
 * never persisted — on resume this text is the only source, and without a
 * path a restored image isn't clickable. Formats (paths may contain spaces):
 *   read:           "Read image file <path> [<mediaType>]..."
 *   screenshot:     "Captured <url> → <path> [<mediaType>] (...)"
 *   generate_image: "Generated image → <path>"
 *                   "Generated N images → <path>, <path>" (first = primary;
 *                   only the primary's pixels are persisted)
 */
export function extractToolImagePaths(text: string): string[] {
  const read = /^Read image file (.+?) \[[^\]\s]+\]/.exec(text);
  if (read?.[1]) return [read[1]];
  const captured = /^Captured .* → (.+?) \[[^\]\s]+\]/.exec(text);
  if (captured?.[1]) return [captured[1]];
  const trimmed = text.trim();
  const single = /^Generated image → (.+)$/.exec(trimmed);
  if (single?.[1]) return [single[1]];
  const multiple = /^Generated \d+ images → (.+)$/.exec(trimmed);
  if (multiple?.[1]) return multiple[1].split(", ").filter((p) => p.length > 0);
  return [];
}

/**
 * Split a persisted assistant message into per-bubble texts. Live streaming
 * ends the assistant bubble at every server_tool_call (see useAgentEvents'
 * server_tool_call case), so pre- and post-tool text render as separate rows.
 * Persisted content keeps that structure as separate text blocks — emit one
 * text per block instead of gluing them into a single row on resume.
 */
export function restoreAssistantTexts(content: Message["content"]): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  return content.flatMap((c) =>
    c.type === "text" && typeof c.text === "string" && c.text.trim() ? [c.text] : [],
  );
}
