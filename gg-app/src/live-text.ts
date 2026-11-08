import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

/**
 * Text of the replies streaming right now, held OUTSIDE the transcript's
 * `items` state while they grow.
 *
 * Writing every flushed chunk into `items` re-rendered the whole App (header,
 * composer, transcript list) ten times a second for as long as a reply
 * streamed, to change one row. Here only the streaming row subscribes, so a
 * chunk re-renders that row and nothing else. When the stream ends, the final
 * text is written into `items` once and the entry is released.
 *
 * The row keeps pacing and dissolving words exactly as before
 * (`useSmoothText` + the word fade in Markdown.tsx); this only changes how the
 * text reaches it.
 */
export interface LiveTextStore {
  get(id: number): string | undefined;
  /** Start an entry for a row that was just added to `items` with `text`. */
  begin(id: number, text: string): void;
  /** Grow an entry and notify its row. Ignored for an id that isn't live. */
  append(id: number, chunk: string): void;
  /**
   * Drop an entry WITHOUT notifying. Call it right after writing the final
   * text into `items`: the row re-renders for that change and reads the same
   * text from its item, so there is nothing to flash.
   */
  release(id: number): void;
  subscribe(id: number, listener: () => void): () => void;
}

export function createLiveTextStore(): LiveTextStore {
  const text = new Map<number, string>();
  const listeners = new Map<number, Set<() => void>>();
  return {
    get: (id) => text.get(id),
    begin(id, initial) {
      text.set(id, initial);
    },
    append(id, chunk) {
      const current = text.get(id);
      if (current === undefined || chunk === "") return;
      text.set(id, current + chunk);
      for (const listener of listeners.get(id) ?? []) listener();
    },
    release(id) {
      text.delete(id);
    },
    subscribe(id, listener) {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(id);
      };
    },
  };
}

export const LiveTextContext = createContext<LiveTextStore | null>(null);

/**
 * A transcript row's current text: the live entry while it streams, otherwise
 * the text stored on its item. Without a provider (tests, other screens) it is
 * just `stored`. `streaming` is true while the reply is still arriving, from
 * its very first chunk; it is the signal for showing an unfinished tail
 * (streaming-markdown.ts).
 */
export function useLiveText(id: number, stored: string): { text: string; streaming: boolean } {
  const store = useContext(LiveTextContext);
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(id, listener) : () => undefined),
    [store, id],
  );
  const live = useSyncExternalStore(subscribe, () => store?.get(id));
  return { text: live ?? stored, streaming: live !== undefined };
}
