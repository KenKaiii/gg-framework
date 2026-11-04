import type { Message } from "../types.js";

/**
 * Wire-safe marker on a user-role message that continues the current turn
 * instead of opening a new one: a runtime status notice ("a worker finished",
 * "a background process exited", post-edit diagnostics).
 *
 * `stream()` sets it from `provenance.kind === "notification"` at the provider
 * boundary, where provenance itself is removed. A symbol key survives the object
 * spreads of the wire passes but never reaches JSON, so no provider sends it.
 */
const CONTINUES_TURN = Symbol("gg.continuesTurn");

type Marked = { [CONTINUES_TURN]?: true };

/** Return a copy of `message` marked as continuing the current turn. */
export function markContinuesTurn<T extends Message>(message: T): T {
  const marked: T & Marked = { ...message };
  marked[CONTINUES_TURN] = true;
  return marked;
}

/** True for a user-role message that continues the current turn (see above). */
export function continuesTurn(message: Message): boolean {
  return (message as Message & Marked)[CONTINUES_TURN] === true;
}

/** A real turn boundary: a user message that isn't a runtime notice. */
export function opensTurn(message: Message): boolean {
  return message.role === "user" && !continuesTurn(message);
}
