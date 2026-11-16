import { describe, expect, it } from "vitest";
import { takeFrames } from "./events";

describe("frame event stream", () => {
  it("splits complete frames and keeps the unfinished rest", () => {
    const { events, rest } = takeFrames(
      `retry: 1000\n\ndata: {"type":"ready"}\n\n: ping\n\ndata: bad\n\ndata: {"type":"run_st`,
    );
    expect(events).toEqual([{ type: "ready" }]);
    expect(rest).toBe(`data: {"type":"run_st`);
  });
});
