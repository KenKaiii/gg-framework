// When the app puts the cursor in the chat box by itself: as a chat opens,
// and back again when the window gains focus or is clicked, so switching
// between project windows lands it there without a second click.

import { isPhone } from "./platform";

/**
 * Whether a chat box that just appeared takes the cursor. Not on iPhone, where
 * the keyboard would come up over the chat being opened (iOS raises it when
 * the app was just brought back, e.g. by tapping a notification): there it
 * comes up when the person taps the box, as in Messages.
 */
export function focusesComposerOnOpen(doc: Document): boolean {
  return !isPhone(doc);
}

/**
 * Whether a window focus or click should move the cursor into the chat box.
 * Not while the person is selecting text or has focused something else on
 * purpose: a menu button, another field, or a dialog (every dialog renders
 * inside `.modal-backdrop`, and owns the keyboard while open). Nor while a
 * workspace view that hides the chat box is open (`[data-hides-composer]`,
 * the project checklist).
 *
 * Never on iPhone: there the cursor raises the on-screen keyboard over what
 * the person opened the app to read, a tap is how they stop a scroll, and the
 * chat box may be hidden under an agent or group page.
 */
export function refocusesComposer(doc: Document, input: HTMLElement | null): boolean {
  if (isPhone(doc)) return false;
  const active = doc.activeElement;
  if (active && active !== doc.body && active.tagName === "BUTTON") return false;
  if (doc.getSelection()?.toString()) return false;
  if (doc.querySelector(".modal-backdrop, [data-hides-composer]")) return false;
  const typingElsewhere =
    active instanceof HTMLElement &&
    active !== input &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
  return !typingElsewhere;
}
