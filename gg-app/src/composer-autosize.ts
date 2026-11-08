// Auto-grow the chat textarea to fit its content, up to a CSS max-height after
// which it scrolls — without disturbing the transcript scrolling above it.
//
// Lives outside App.tsx so the scroll-preservation contract below is testable
// (`composer-autosize.test.ts` models the browser's clamp; jsdom has no layout).
//
// Measure with the scrollbar suppressed. `height: auto` collapses the textarea
// to its rows=1 intrinsic height, so any wrapped draft overflows during
// measurement, and `.input::-webkit-scrollbar` is a classic (space-consuming)
// scrollbar in WebKit — verified 8px of content width lost while it shows.
// Suppressing it first means every read below sees the width the text is
// actually laid out at, including the overflow decision itself.
export function autosizeComposer(
  el: HTMLTextAreaElement | null,
  transcript: HTMLElement | null,
  pinned = false,
): void {
  if (!el) return;
  // An emptied draft (every send clears it) snaps back to one line in the same
  // frame, with no height transition and no FLIP. The sent message is added in
  // that same frame: while the field eased down from N lines over 160ms, the
  // transcript viewport grew under the new bubble, so it appeared above where
  // it rests and slid down while its own rise played, overshooting and
  // settling ("pushes up, then corrects").
  const snap = el.value === "";
  // That same `height: auto` collapse hands the composer's pixels back to the
  // transcript for one layout pass. If the transcript's content fits in the
  // briefly-taller viewport, the browser clamps its scrollTop toward 0; the
  // scroll event that follows reads as "the user scrolled up", drops App's
  // stick-to-bottom pin for good, and from then on the growing composer covers
  // the newest messages instead of pushing them up. Any upward move un-pins
  // (transcript-pin.ts), so even one line of lost distance would. Snapshot
  // and restore around the measurement so the collapse stays invisible: both
  // writes land in the same task, so the browser fires at most one scroll
  // event, carrying the restored offset.
  const savedTop = transcript?.scrollTop;
  el.style.overflowY = "hidden";
  // `.input` transitions its height, and reading scrollHeight below forces a
  // synchronous layout — so without care the browser takes the collapsed `auto`
  // height as the transition's start value and animates 1 line → N on EVERY
  // keystroke. Snapshot the real height, restore it, and force ONE more layout
  // so that restored value is what the browser commits as the start; only then
  // write the target. Skipping the second read makes the restore invisible
  // (the browser coalesces both writes) and the animation breaks again.
  //
  // Restore what is ON SCREEN, not the last target: mid-transition (a draft
  // replaced wholesale eases down over 160ms) the two differ, and restoring the
  // target cut the animation short — the box snapped the rest of the way on
  // the next keystroke. The computed height is the live animated value.
  const written = el.style.height;
  const live = getComputedStyle(el).height;
  const before = live && live !== "auto" ? live : written;
  el.style.height = "auto";
  // One line keeps the caret beside the paperclip; past that the field claims
  // the whole row and the circles drop beneath it, moving the text up and left.
  // Decide this BEFORE measuring the height: the class changes the field's
  // WIDTH, so measuring first sizes the box to a width it is about to lose.
  const row = el.closest(".inputrow");
  if (row) {
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 0;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0;
    // The padded height of a single line (scrollHeight includes the field's
    // vertical padding), so an empty draft with one newline counts as exactly
    // two lines rather than tipping over a pixel guess.
    const oneLine = line + pad + 1;
    if (line > 0) {
      const was = row.classList.contains("is-multiline");
      const stack = el.parentElement;
      const first = stack?.getBoundingClientRect();
      // Always answer the SAME question — "does the draft wrap at the ONE-LINE
      // width?" — never "does it wrap at whatever width it has right now". The
      // multiline row is wider (the field takes the whole row, the circles drop
      // beneath), so a draft that only just wrapped fits on one line again the
      // moment it gets there. Asking at the current width therefore flips the
      // answer back, the narrower row wraps it again, and the row oscillates
      // once per keystroke — the up/down bounce when typing to the edge.
      let multiline = el.scrollHeight > oneLine;
      if (was && !multiline) {
        // Fits on one line at the WIDE width; re-ask at the narrow one before
        // giving the row back. Only reached near the boundary, so the extra
        // layout is not on the common typing path.
        row.classList.remove("is-multiline");
        multiline = el.scrollHeight > oneLine;
        row.classList.add("is-multiline");
      }
      if (multiline !== was) {
        // A flex reflow cannot be transitioned — the field teleports up and left
        // the instant it claims the row. FLIP it instead: measure where it was,
        // let the reflow happen, then translate it back to the old position and
        // release, so CSS animates the offset away. The browser only ever paints
        // the smooth path.
        row.classList.toggle("is-multiline", multiline);
        const last = stack?.getBoundingClientRect();
        if (stack && first && last && !snap) {
          const dx = first.left - last.left;
          const dy = first.top - last.top;
          if (dx || dy) {
            stack.style.transition = "none";
            stack.style.transform = `translate(${dx}px, ${dy}px)`;
            // Commit the inverted position before clearing it, or both writes
            // coalesce and nothing animates.
            void stack.offsetHeight;
            stack.style.transition = "";
            stack.style.transform = "";
          }
        }
      }
    }
  }
  // Now that the row layout is settled, measure the content at the width the
  // field will actually keep.
  const max = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
  const content = el.scrollHeight;
  const next = `${Math.min(content, max)}px`;
  if (snap && written !== next) {
    // Land at the new height in this frame: suspend the transition, commit the
    // height with a layout read (or the cleared transition would still apply
    // to it), then hand the transition back for the next keystroke.
    el.style.transition = "none";
    el.style.height = next;
    void el.offsetHeight;
    el.style.transition = "";
  } else {
    if (before !== next) {
      el.style.height = before;
      void el.offsetHeight;
    }
    el.style.height = next;
  }
  // Only past the cap does the scrollbar earn its width. Below it, keeping
  // overflow hidden also avoids a phantom grey scrollbar under CSS zoom > 1,
  // where scrollHeight rounds down to an integer of unzoomed px and leaves the
  // content a hair taller than the height just set.
  if (content > max) el.style.overflowY = "auto";
  if (!transcript || savedTop === undefined) return;
  // Where the transcript belongs now that the composer has its final height.
  // While pinned that is the true bottom, NOT the snapshot: a grown composer
  // eats pixels off the bottom of the viewport, so restoring the old offset
  // leaves the newest line under the fold and hands the correction to the
  // ResizeObserver a frame later — a visible bounce on every keystroke that
  // wraps. Landing at the bottom in the same task makes the growth one motion.
  const target = pinned ? transcript.scrollHeight : savedTop;
  if (transcript.scrollTop !== target) transcript.scrollTop = target;
}
