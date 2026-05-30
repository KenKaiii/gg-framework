import React, { useEffect } from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import { useTranscriptHistory } from "./useTranscriptHistory.js";
import { loadTheme } from "../theme/theme.js";
import type { TerminalHistoryContext } from "../terminal-history.js";
import type { CompletedItem } from "../app-items.js";

const context: TerminalHistoryContext = {
  theme: loadTheme("dark"),
  columns: 80,
  version: "test",
  model: "test-model",
  provider: "anthropic",
  cwd: "/tmp/project",
};

function Harness({ onPrinted }: { onPrinted: (printed: string) => void }) {
  const [history, setHistory] = React.useState<CompletedItem[]>([]);
  const [liveItems, setLiveItems] = React.useState<CompletedItem[]>([
    { kind: "assistant", id: "assistant-live", text: "previous assistant reply" },
  ]);
  const printedRef = React.useRef("");
  const submittedRef = React.useRef(false);
  const { finalizeSubmittedUserItem } = useTranscriptHistory<CompletedItem>({
    terminalHistoryPrinter: {
      print(items, _context, options) {
        for (const item of items) {
          options?.write?.(`${item.kind}:${"text" in item ? item.text : item.id}\n`);
        }
      },
      clear() {},
    },
    terminalHistoryContext: context,
    writeStdout(data) {
      printedRef.current += data;
    },
    sessionPathRef: { current: undefined },
    sessionManagerRef: { current: null },
    history,
    setHistory,
    setLiveItems,
  });

  useEffect(() => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    finalizeSubmittedUserItem(
      { kind: "user", id: "user-next", text: "follow up prompt" },
      liveItems,
    );
    onPrinted(printedRef.current);
  }, [finalizeSubmittedUserItem, liveItems, onPrinted]);

  return null;
}

describe("useTranscriptHistory", () => {
  it("prints deferred final assistant output before the next submitted user prompt", async () => {
    let printed = "";
    const mounted = render(<Harness onPrinted={(value) => (printed = value)} />, {
      patchConsole: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    mounted.unmount();

    expect(printed).toContain("assistant:previous assistant reply\nuser:follow up prompt\n");
  });
});
