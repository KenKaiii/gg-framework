/**
 * Take the keyboard back from an element that isn't on screen. A goal's
 * Workers view hides the chat (display: none) without moving focus, and
 * WebKit lets a hidden textarea keep it: typed keys go into a box nobody can
 * see, and macOS draws its caret marker over the farm where the box was.
 */
export function dropHiddenFocus(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el !== document.body && el.getClientRects().length === 0) {
    el.blur();
  }
}
