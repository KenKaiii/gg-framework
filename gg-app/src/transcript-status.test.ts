import { describe, expect, it } from "vitest";
import { emptyTranscriptStatus } from "./transcript-status";

describe("emptyTranscriptStatus", () => {
  it("shows only connection trouble in an empty chat, never a run's own state", () => {
    // Regression: a goal's first reply ran with nothing in the chat yet, and
    // "✻ thinking…" sat in its top-left corner.
    expect(emptyTranscriptStatus("thinking\u2026")).toBeNull();
    expect(emptyTranscriptStatus("cancelling...")).toBeNull();
    expect(emptyTranscriptStatus("cancelled")).toBeNull();
    expect(emptyTranscriptStatus("connecting to agent\u2026")).toBe("connecting to agent\u2026");
    expect(emptyTranscriptStatus("agent failed to start: boom")).toBe(
      "agent failed to start: boom",
    );
  });
});
