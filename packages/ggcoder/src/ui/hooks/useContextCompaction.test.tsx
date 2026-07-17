import React, { useEffect, useRef, useState } from "react";
import { render } from "ink";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, Provider, Usage } from "@kenkaiiii/gg-ai";
import type * as CompactorModule from "../../core/compaction/compactor.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import type { CompletedItem } from "../app-items.js";
import { useContextCompaction } from "./useContextCompaction.js";

const compactMock = vi.hoisted(() => vi.fn());

vi.mock("../../core/compaction/compactor.js", async () => {
  const actual = await vi.importActual<typeof CompactorModule>(
    "../../core/compaction/compactor.js",
  );
  return { ...actual, compact: compactMock };
});

const usage: Usage = {
  inputTokens: 145_000,
  cacheRead: 2_000,
  cacheWrite: 1_000,
  outputTokens: 11_000,
};
const pendingMessage: Message = {
  role: "tool",
  content: [
    {
      type: "tool_result",
      toolCallId: "t1",
      content: "pending tool output ".repeat(200),
    },
  ],
};

function Harness({
  provider,
  reuseRecordedUsage = false,
  onTransformed,
}: {
  provider: Provider;
  reuseRecordedUsage?: boolean;
  onTransformed: (messages: Message[]) => void;
}) {
  const messagesRef = useRef<Message[]>([
    { role: "system", content: "sys" },
    { role: "user", content: "run tool" },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "t1", name: "read", args: {} }],
    },
    pendingMessage,
  ]);
  const settingsRef = useRef({
    get(key: string) {
      if (key === "autoCompact") return true;
      if (key === "compactThreshold") return 0.8;
      return undefined;
    },
  } as unknown as SettingsManager);
  const approvedPlanPathRef = useRef<string | undefined>(undefined);
  const [, setLiveItems] = useState<CompletedItem[]>([]);
  const startedRef = useRef(false);
  const { transformContext, recordProviderUsage } = useContextCompaction({
    currentModel: "test-model",
    currentProvider: provider,
    contextWindowOptions: { provider },
    activeApiKey: "test-key",
    activeAccountId: undefined,
    activeProjectId: undefined,
    activeBaseUrl: undefined,
    setLiveItems,
    getId: () => "compact-1",
    approvedPlanPathRef,
    settingsRef,
    messagesRef,
    persistCompactedSession: async () => {},
  });

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (reuseRecordedUsage) {
      recordProviderUsage(usage, messagesRef.current.slice(0, -1));
      void transformContext(messagesRef.current, { pendingMessages: [] }).then(onTransformed);
      return;
    }
    void transformContext(messagesRef.current, {
      usage,
      pendingMessages: [pendingMessage],
    }).then(onTransformed);
  }, [onTransformed, recordProviderUsage, reuseRecordedUsage, transformContext]);

  return null;
}

describe("useContextCompaction", () => {
  beforeEach(() => {
    compactMock.mockReset();
    compactMock.mockResolvedValue({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "[compacted]" },
      ],
      result: {
        compacted: true,
        originalCount: 4,
        newCount: 2,
        tokensBeforeEstimate: 161_000,
        tokensAfterEstimate: 2_000,
      },
    });
  });

  it.each(["anthropic", "openai"] as const)(
    "counts cache, output, and pending messages for %s",
    async (provider) => {
      let transformed: Message[] | undefined;
      const mounted = render(
        <Harness provider={provider} onTransformed={(messages) => (transformed = messages)} />,
        { patchConsole: false },
      );

      await vi.waitFor(() => expect(transformed).toBeDefined());
      mounted.unmount();

      expect(compactMock).toHaveBeenCalledTimes(1);
      expect(transformed).toEqual([
        { role: "system", content: "sys" },
        { role: "user", content: "[compacted]" },
      ]);
    },
  );

  it("reuses authoritative usage for the first context check of the next run", async () => {
    let transformed: Message[] | undefined;
    const mounted = render(
      <Harness
        provider="openai"
        reuseRecordedUsage
        onTransformed={(messages) => (transformed = messages)}
      />,
      { patchConsole: false },
    );

    await vi.waitFor(() => expect(transformed).toBeDefined());
    mounted.unmount();

    expect(compactMock).toHaveBeenCalledTimes(1);
    expect(transformed).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "[compacted]" },
    ]);
  });
});
