import { describe, expect, it } from "vitest";
import { isPhaseStartResult, isPhaseStartSession } from "./phase-start-protocol.js";

const session = { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" };

describe("phase-start protocol", () => {
  it.each([session, { sessionId: "session-1", sessionPath: null }])(
    "accepts a canonical session link: %o",
    (value) => {
      expect(isPhaseStartSession(value)).toBe(true);
      expect(
        isPhaseStartResult({
          status: "accepted",
          operationId: "operation-1",
          session: value,
          packageTokenCount: 0,
        }),
      ).toBe(true);
    },
  );

  it.each([
    { sessionId: "", sessionPath: "/sessions/one.jsonl" },
    { sessionId: "   ", sessionPath: "/sessions/one.jsonl" },
    { sessionId: "session-1", sessionPath: "" },
    { sessionId: "session-1", sessionPath: " \t " },
    { ...session, extra: true },
  ])("rejects a malformed session link: %o", (value) => {
    expect(isPhaseStartSession(value)).toBe(false);
    expect(
      isPhaseStartResult({
        status: "accepted",
        operationId: "operation-1",
        session: value,
        packageTokenCount: 0,
      }),
    ).toBe(false);
  });
});
