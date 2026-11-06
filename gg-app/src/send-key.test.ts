import { describe, expect, it } from "vitest";
import { sendKeyAction } from "./send-key";

const idle = { shellMode: false, running: false, kenRunning: false, autopilotReviewing: false };

describe("sendKeyAction", () => {
  it("sends when nothing is running", () => {
    expect(sendKeyAction(idle)).toBe("send");
  });

  it("stops GG's run and Ken's autopilot review through the run's cancel", () => {
    expect(sendKeyAction({ ...idle, running: true })).toBe("stop-run");
    expect(sendKeyAction({ ...idle, autopilotReviewing: true })).toBe("stop-run");
  });

  it("stops a manual @Ken reply", () => {
    expect(sendKeyAction({ ...idle, kenRunning: true })).toBe("stop-ken");
  });

  it("runs a shell command mid-run instead of stopping", () => {
    expect(sendKeyAction({ ...idle, shellMode: true, running: true })).toBe("send");
  });
});
