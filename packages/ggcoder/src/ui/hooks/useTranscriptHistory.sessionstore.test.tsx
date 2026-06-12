// Regression: queueFlush must mirror flushed rows into sessionStore.history
// SYNCHRONOUSLY (not just in the deferred fold-in effects).
//
// The patched ink's bottom-pinned idle repaint (slash menu closing) can fire
// on the very commit that finalizes a submit — deferred assistant rows + the
// user prompt are flushed while the menu close shrinks the frame. The repaint
// backfills the screen from sessionStore.history; when those rows were only
// in the pending-flush queue, the repaint redrew a stale screen and the
// just-finalized assistant message visibly vanished into blank space.
import React, { useRef, useState } from "react";
import { render, useStdout } from "ink";
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import type { CompletedItem } from "../app-items.js";
import type { SessionStore } from "../render.js";
import { loadTheme } from "../theme/theme.js";
import { createTerminalHistoryPrinter } from "../terminal-history.js";
import type { TerminalHistoryContext } from "../terminal-history.js";
import { useTranscriptHistory, type UseTranscriptHistoryResult } from "./useTranscriptHistory.js";

const terminalContext: TerminalHistoryContext = {
  theme: loadTheme("dark"),
  columns: 80,
  version: "sim",
  model: "sim-model",
  provider: "anthropic",
  cwd: "/tmp/sim-project",
};

function Driver({
  sessionStore,
  apiRef,
}: {
  sessionStore: SessionStore;
  apiRef: { current: UseTranscriptHistoryResult<CompletedItem> | null };
}): null {
  const { write: writeStdout } = useStdout();
  const [history, setHistory] = useState<CompletedItem[]>(sessionStore.history);
  const [, setLiveItems] = useState<CompletedItem[]>([]);
  const printerRef = useRef<ReturnType<typeof createTerminalHistoryPrinter> | null>(null);
  printerRef.current ??= createTerminalHistoryPrinter();
  apiRef.current = useTranscriptHistory({
    terminalHistoryPrinter: printerRef.current,
    terminalHistoryContext: terminalContext,
    writeStdout,
    sessionPathRef: { current: undefined },
    sessionManagerRef: { current: null },
    sessionStore,
    history,
    setHistory,
    setLiveItems,
  });
  return null;
}

describe("queueFlush sessionStore.history mirror", () => {
  it("appends flushed rows to sessionStore.history synchronously", async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    (stdout as { isTTY: boolean }).isTTY = false;
    (stdout as { columns: number }).columns = 80;
    (stdout as { rows: number }).rows = 24;
    const sessionStore = {
      messages: [],
      history: [{ kind: "banner", id: "banner" }] as CompletedItem[],
      liveItems: [],
      planSteps: [],
      sessionTitleGenerated: false,
    } as unknown as SessionStore;
    const apiRef: { current: UseTranscriptHistoryResult<CompletedItem> | null } = {
      current: null,
    };

    const mounted = render(<Driver sessionStore={sessionStore} apiRef={apiRef} />, {
      stdout,
      patchConsole: false,
    });

    // Simulate submit finalization: a deferred assistant row + the user
    // prompt flushed together. The mirror must land BEFORE any effect runs —
    // assert immediately after the synchronous call.
    apiRef.current!.queueFlush([
      { kind: "assistant", id: "a1", text: "previous answer" } as CompletedItem,
      { kind: "user", id: "u1", text: "/commit" } as CompletedItem,
    ]);
    const ids = sessionStore.history.map((item) => item.id);
    expect(ids, "flushed rows mirrored synchronously").toEqual(
      expect.arrayContaining(["banner", "a1", "u1"]),
    );

    // Re-queuing the same ids must not duplicate them.
    apiRef.current!.queueFlush([{ kind: "user", id: "u1", text: "/commit" } as CompletedItem]);
    const count = sessionStore.history.filter((item) => item.id === "u1").length;
    expect(count, "no duplicate mirror entries").toBe(1);

    mounted.unmount();
  });
});
