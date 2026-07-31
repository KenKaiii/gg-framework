import { describe, expect, it, vi } from "vitest";
import { handlePhaseStartRoute } from "./app-sidecar-phase-route.js";

describe("phase-start HTTP route", () => {
  it("returns the typed invalid-phase-id failure for malformed percent encoding", () => {
    const respond = vi.fn();
    const start = vi.fn();

    expect(
      handlePhaseStartRoute({
        method: "POST",
        url: "/phases/%E0%A4%A/start",
        host: "127.0.0.1",
        respond,
        start,
      }),
    ).toBe(true);
    expect(respond).toHaveBeenCalledExactlyOnceWith(400, {
      status: "failed",
      code: "invalid-phase-id",
      operationId: null,
      message: "The phase identifier is malformed.",
    });
    expect(start).not.toHaveBeenCalled();
  });
});
