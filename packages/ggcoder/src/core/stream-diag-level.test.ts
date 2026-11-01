import { describe, expect, it } from "vitest";
import { streamDiagLevel } from "./stream-diag-level.js";

describe("streamDiagLevel", () => {
  it("drops routine step markers unless GG_DEBUG_STREAM=1", () => {
    for (const phase of ["transform_start", "transform_end", "stream_call", "stream_created"]) {
      expect(streamDiagLevel(phase, {}, {})).toBeNull();
      expect(streamDiagLevel(phase, {}, { GG_DEBUG_STREAM: "1" })).toBe("DEBUG");
    }
    expect(streamDiagLevel("first_event", { type: "keepalive" }, {})).toBeNull();
  });
  it("keeps informative phases", () => {
    expect(streamDiagLevel("first_event", { type: "text_delta" }, {})).toBe("INFO");
    expect(streamDiagLevel("idle_timeout_fired", {}, {})).toBe("INFO");
    expect(streamDiagLevel("non_streaming_session", {}, {})).toBe("WARN");
  });
});

describe("describeUserInput", () => {
  it("logs length and hash, never the prompt text", async () => {
    const { describeUserInput } = await import("./logger.js");
    const out = describeUserInput("my secret prompt");
    expect(out).toMatch(/^16 chars sha256=[0-9a-f]{8}$/);
    expect(out).not.toContain("secret");
  });
});
