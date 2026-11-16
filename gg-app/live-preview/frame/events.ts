// The preview session's events, streamed from the frame server. fetch (not
// EventSource) so the request carries the header that proves it's the frame.
import type { SidecarEvent } from "../../src/agent";
import { LIVE_HEADER } from "./shims/invoke";

/** Split an SSE buffer into complete `data:` payloads and the unfinished rest. */
export function takeFrames(buf: string): { events: SidecarEvent[]; rest: string } {
  const events: SidecarEvent[] = [];
  let rest = buf;
  let i: number;
  while ((i = rest.indexOf("\n\n")) >= 0) {
    const frame = rest.slice(0, i);
    rest = rest.slice(i + 2);
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(line.slice(6)) as SidecarEvent);
      } catch {
        /* a malformed frame is skipped, not fatal */
      }
    }
  }
  return { events, rest };
}

/**
 * Follow the event stream, reconnecting after a drop. Each connection starts
 * with `ready` and replays the session so far, so `onConnect` resets the view first.
 */
export function streamEvents(
  onEvent: (e: SidecarEvent) => void,
  onConnect: () => void,
  fetchImpl: typeof fetch = fetch,
): () => void {
  let stopped = false;
  let abort = new AbortController();
  const run = async (): Promise<void> => {
    while (!stopped) {
      abort = new AbortController();
      try {
        const res = await fetchImpl("/api/events", {
          headers: { [LIVE_HEADER]: "1" },
          signal: abort.signal,
          credentials: "omit",
        });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        onConnect();
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const { events, rest } = takeFrames(buf + dec.decode(value, { stream: true }));
          buf = rest;
          for (const e of events) onEvent(e);
        }
      } catch {
        /* dropped: retry below */
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 1000));
    }
  };
  void run();
  return () => {
    stopped = true;
    abort.abort();
  };
}
