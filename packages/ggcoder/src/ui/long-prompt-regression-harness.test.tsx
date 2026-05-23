import React from "react";
import { Box, Static, Text, render } from "ink";
import { describe, expect, it } from "vitest";
import { UserMessage } from "./components/UserMessage.js";
import {
  getScrollStabilizationDecision,
  getStaticHistoryKey,
  hasParagraphBreakLiveUserMessage,
  isTallLiveUserMessage,
} from "./App.js";

type HarnessItem =
  | { kind: "banner"; id: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string };

function renderHarnessItem(item: HarnessItem) {
  if (item.kind === "banner") return <Text>GG CODER BANNER</Text>;
  if (item.kind === "user") return <UserMessage text={item.text} />;
  return <Text>{item.text}</Text>;
}

function LongPromptHarness({
  history,
  liveItems,
  resizeKey,
  staticRenderProbe,
}: {
  history: HarnessItem[];
  liveItems: HarnessItem[];
  resizeKey: number;
  staticRenderProbe?: (item: HarnessItem) => void;
}) {
  const hasTallLiveUserMessage = liveItems.some(
    (item) => item.kind === "user" && isTallLiveUserMessage(item.text, 24),
  );
  const hasParagraphBreakUserMessage = liveItems.some(
    (item) => item.kind === "user" && hasParagraphBreakLiveUserMessage(item.text),
  );
  const scrollStabilizationDecision = getScrollStabilizationDecision({
    isUserScrolled: false,
    hasNewOutput: liveItems.length > 0,
    hasTallLiveUserMessage,
    hasParagraphBreakLiveUserMessage: hasParagraphBreakUserMessage,
  });
  const staticHistoryKey = scrollStabilizationDecision.preserveStatic
    ? getStaticHistoryKey({ resizeKey: 0 })
    : getStaticHistoryKey({ resizeKey });

  return (
    <Box flexDirection="column" width={80}>
      <Static key={staticHistoryKey} items={history}>
        {(item) => {
          staticRenderProbe?.(item);
          return <Box key={item.id}>{renderHarnessItem(item)}</Box>;
        }}
      </Static>
      <Box flexDirection="column">
        {liveItems.map((item) => (
          <Box key={item.id}>{renderHarnessItem(item)}</Box>
        ))}
      </Box>
    </Box>
  );
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g"), "");
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function splitDebugFrames(output: string): string[] {
  return stripAnsi(output)
    .split(/\n\s*\n/)
    .map((frame) => frame.trim())
    .filter(Boolean);
}

const tallPrompt = Array.from(
  { length: 18 },
  (_, i) => `LONG_PROMPT_LINE_${String(i + 1).padStart(2, "0")}`,
).join("\n");
const paragraphBreakPrompt = "This\n\nIs\n\nA\n\nTest...";

describe("long prompt regression harness", () => {
  it("reproduces paragraph-break prompt scrollback instability before assistant output", () => {
    expect(isTallLiveUserMessage(paragraphBreakPrompt, 24)).toBe(false);
    expect(hasParagraphBreakLiveUserMessage(paragraphBreakPrompt)).toBe(true);

    const history: HarnessItem[] = [{ kind: "banner", id: "banner" }];
    const liveSubmittedPrompt: HarnessItem = {
      kind: "user",
      id: "submitted-paragraph-breaks",
      text: paragraphBreakPrompt,
    };
    let output = "";
    const staticRenders: string[] = [];
    const stdout = {
      columns: 80,
      rows: 24,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;
    const { rerender, unmount } = render(
      <LongPromptHarness
        history={history}
        liveItems={[liveSubmittedPrompt]}
        resizeKey={0}
        staticRenderProbe={(item) => staticRenders.push(item.id)}
      />,
      { stdout, columns: 80, rows: 24, debug: true },
    );

    // Model immediate post-submit terminal churn before any assistant output: a resize/remount
    // during a short paragraph-break live prompt must not replay Static or collapse blank lines.
    rerender(
      <LongPromptHarness
        history={history}
        liveItems={[liveSubmittedPrompt]}
        resizeKey={1}
        staticRenderProbe={(item) => staticRenders.push(item.id)}
      />,
    );

    const frames = splitDebugFrames(output);
    const scrollback = stripAnsi(output);
    const lastFullScreenFrame =
      [...frames].reverse().find((frame) => frame.includes("GG CODER BANNER")) ?? "";
    const lastPromptFrame = [...frames].reverse().find((frame) => frame.includes("❯ This")) ?? "";

    expect(staticRenders).toEqual(["banner"]);
    expect(count(lastFullScreenFrame, "GG CODER BANNER")).toBe(1);
    expect(count(lastPromptFrame, "❯ This")).toBe(1);
    expect(scrollback).toMatch(/❯ This\n\s*\n\s*Is\n\s*\n\s*A\n\s*\n\s*Test\.\.\./);
    expect(frames.filter((frame) => count(frame, "GG CODER BANNER") > 1)).toEqual([]);
    unmount();
  });

  it("captures a tall submitted prompt through live updates/remount/resize without clipping or duplication", () => {
    expect(isTallLiveUserMessage(tallPrompt, 24)).toBe(true);

    const history: HarnessItem[] = [{ kind: "banner", id: "banner" }];
    const liveSubmittedPrompt: HarnessItem = { kind: "user", id: "submitted", text: tallPrompt };
    let output = "";
    const stdout = {
      columns: 80,
      rows: 24,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;
    const instance = render(
      <LongPromptHarness history={history} liveItems={[liveSubmittedPrompt]} resizeKey={0} />,
      { stdout, columns: 80, rows: 24, debug: true },
    );
    const { rerender, unmount } = instance;

    rerender(
      <LongPromptHarness
        history={history}
        liveItems={[
          liveSubmittedPrompt,
          { kind: "assistant", id: "agent-1", text: "agent live update 1" },
        ]}
        resizeKey={0}
      />,
    );
    rerender(
      <LongPromptHarness
        history={history}
        liveItems={[
          liveSubmittedPrompt,
          { kind: "assistant", id: "agent-2", text: "agent live update 2 after remount" },
        ]}
        resizeKey={1}
      />,
    );

    const frames = stripAnsi(output).split("GG CODER BANNER");
    const frame = `GG CODER BANNER${frames.at(-1) ?? ""}`;
    expect(count(frame, "GG CODER BANNER")).toBe(1);
    expect(count(frame, "❯ LONG_PROMPT_LINE_01")).toBe(1);
    expect(count(frame, "LONG_PROMPT_LINE_02")).toBe(1);
    expect(count(frame, "LONG_PROMPT_LINE_18")).toBe(1);
    expect(frame).toContain("agent live update 2 after remount");
    unmount();
  });

  it("observes duplicate scrollback frames when a tall prompt is followed by live output and Static remounts", () => {
    const history: HarnessItem[] = [{ kind: "banner", id: "banner" }];
    const liveSubmittedPrompt: HarnessItem = { kind: "user", id: "submitted", text: tallPrompt };
    let output = "";
    const stdout = {
      columns: 80,
      rows: 24,
      write(chunk: string) {
        output += chunk;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;
    const { rerender, unmount } = render(
      <LongPromptHarness history={history} liveItems={[liveSubmittedPrompt]} resizeKey={0} />,
      { stdout, columns: 80, rows: 24, debug: true },
    );

    rerender(
      <LongPromptHarness
        history={history}
        liveItems={[
          liveSubmittedPrompt,
          { kind: "assistant", id: "agent-1", text: "agent live update before resize" },
        ]}
        resizeKey={0}
      />,
    );
    rerender(
      <LongPromptHarness
        history={history}
        liveItems={[
          liveSubmittedPrompt,
          { kind: "assistant", id: "agent-2", text: "agent live update after resize" },
        ]}
        resizeKey={1}
      />,
    );

    const frames = splitDebugFrames(output);
    const lastFrame = frames.at(-1) ?? "";
    const lastFullScreenFrame =
      [...frames].reverse().find((frame) => frame.includes("GG CODER BANNER")) ?? "";
    expect(count(lastFullScreenFrame, "GG CODER BANNER")).toBe(1);
    expect(count(lastFullScreenFrame, "❯ LONG_PROMPT_LINE_01")).toBe(1);
    expect(count(lastFullScreenFrame, "LONG_PROMPT_LINE_18")).toBe(1);
    expect(count(lastFrame, "❯ LONG_PROMPT_LINE_01")).toBeLessThanOrEqual(1);
    expect(frames.filter((frame) => count(frame, "GG CODER BANNER") > 1)).toEqual([]);
    unmount();
  });

  it("keeps Static history keyed stable when tall-message/user-scroll stabilization is active", () => {
    const tallDecision = getScrollStabilizationDecision({
      isUserScrolled: false,
      hasNewOutput: true,
      hasTallLiveUserMessage: true,
    });
    const scrolledDecision = getScrollStabilizationDecision({
      isUserScrolled: true,
      hasNewOutput: true,
      hasTallLiveUserMessage: false,
    });

    const paragraphBreakDecision = getScrollStabilizationDecision({
      isUserScrolled: false,
      hasNewOutput: true,
      hasTallLiveUserMessage: false,
      hasParagraphBreakLiveUserMessage: true,
    });

    expect(tallDecision).toEqual({ preserveStatic: true, autoFollow: false });
    expect(scrolledDecision).toEqual({ preserveStatic: true, autoFollow: false });
    expect(paragraphBreakDecision).toEqual({ preserveStatic: true, autoFollow: true });
    expect(getStaticHistoryKey({ resizeKey: 7 })).toBe(getStaticHistoryKey({ resizeKey: 7 }));
  });

  it("does not replay Static history while live tall-prompt output changes without resize", () => {
    const staticRenders: string[] = [];
    const history: HarnessItem[] = [
      { kind: "banner", id: "banner" },
      { kind: "assistant", id: "history-1", text: "already flushed history" },
    ];
    const liveSubmittedPrompt: HarnessItem = { kind: "user", id: "submitted", text: tallPrompt };
    const stdout = {
      columns: 80,
      rows: 24,
      write() {
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;
    const { rerender, unmount } = render(
      <LongPromptHarness
        history={history}
        liveItems={[liveSubmittedPrompt]}
        resizeKey={5}
        staticRenderProbe={(item) => staticRenders.push(item.id)}
      />,
      { stdout, columns: 80, rows: 24, debug: true },
    );
    expect(staticRenders).toEqual(["banner", "history-1"]);

    rerender(
      <LongPromptHarness
        history={history}
        liveItems={[
          liveSubmittedPrompt,
          { kind: "assistant", id: "agent", text: "new live output" },
        ]}
        resizeKey={5}
        staticRenderProbe={(item) => staticRenders.push(item.id)}
      />,
    );

    expect(staticRenders).toEqual(["banner", "history-1"]);
    unmount();
  });
});
