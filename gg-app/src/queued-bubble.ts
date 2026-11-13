import type { QueuedMessage } from "./agent";
import type { Item } from "./transcript-item";

/**
 * The sidecar queue entry behind each queued bubble, for cancelling it from the
 * bubble. Bubbles carry no queue id, so they are matched the way queue events
 * clear them (useAgentEvents): by text, in order, so the n-th queued bubble
 * with a text is the n-th queue entry with that text. An entry already handed
 * to the agent can't be cancelled and gets no id.
 */
export function queueIdsForBubbles(
  items: readonly Item[],
  queue: readonly QueuedMessage[],
): ReadonlyMap<number, string> {
  const ids = new Map<number, string>();
  if (queue.length === 0) return ids;
  const byText = new Map<string, QueuedMessage[]>();
  for (const message of queue) {
    const same = byText.get(message.text);
    if (same) same.push(message);
    else byText.set(message.text, [message]);
  }
  const seen = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "user" || !item.queued) continue;
    const index = seen.get(item.text) ?? 0;
    seen.set(item.text, index + 1);
    const message = byText.get(item.text)?.[index];
    if (message && !message.delivering) ids.set(item.id, message.id);
  }
  return ids;
}
