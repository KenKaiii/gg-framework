import { useLayoutEffect, useMemo } from "react";
import { Markdown } from "./Markdown";
import { displayStreamingMarkdown } from "./streaming-markdown";
import { useSmoothText } from "./useSmoothText";

/**
 * Assistant prose while it streams: the text is revealed at a steady rate
 * (rather than in whatever bursts the network delivered) and each new word
 * fades in as it lands.
 *
 * `onGrow` re-pins the transcript to the bottom. The reveal adds height
 * BETWEEN item updates, which the transcript's `items`-keyed scroll effect
 * cannot see, so without this the tail of a reply drifts under the fold.
 */
export function StreamingMarkdown({
  text,
  streaming = false,
  onGrow,
}: {
  text: string;
  /** The reply is still arriving (live-text.ts), from its first chunk on. */
  streaming?: boolean;
  onGrow?: () => void;
}): React.ReactElement {
  const { text: revealed, animating } = useSmoothText(text, streaming);
  useLayoutEffect(() => {
    onGrow?.();
  }, [revealed, onGrow]);
  // While it is still arriving (or still being revealed), close the unfinished
  // markdown at its tail so `**He` shows as bold "He", not asterisks that snap
  // into bold a beat later (streaming-markdown.ts). `streaming` covers the
  // first chunk and pauses mid-reply, which `animating` alone misses. Settled
  // text renders exactly as written.
  const unfinished = streaming || animating;
  const shown = useMemo(
    () => (unfinished ? displayStreamingMarkdown(revealed) : revealed),
    [unfinished, revealed],
  );
  // Word spans stay on for the whole reply, not just while text is moving. A
  // real model pauses mid-sentence (network, rate limits, thinking); `animating`
  // goes false after 0.7s of quiet, which stripped the spans off the words on
  // screen, and the next chunk put them back, so every visible word faded in a
  // second time. That was the flicker. They come off once, when it finishes.
  return <Markdown animate={unfinished}>{shown}</Markdown>;
}
