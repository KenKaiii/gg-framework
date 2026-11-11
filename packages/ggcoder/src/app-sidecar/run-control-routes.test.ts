import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { RunClaim } from "../core/run-claim.js";
import type { SessionRouteContext } from "./route-context.js";
import { handleRunControlRoutes, resolveThinkingRequest } from "./run-control-routes.js";

// Claude Sonnet 5.5 cycles low → medium → high → xhigh → off.
const PROVIDER = "anthropic";
const MODEL = "claude-sonnet-5-5";

describe("resolveThinkingRequest", () => {
  it("cycles to the next level when the body is empty", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "medium", "")).toEqual({
      ok: true,
      level: "high",
    });
  });

  it("jumps straight to a requested level", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "low", '{"level":"xhigh"}')).toEqual({
      ok: true,
      level: "xhigh",
    });
  });

  it("turns thinking off for a null level", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "high", '{"level":null}')).toEqual({
      ok: true,
      level: undefined,
    });
  });

  it("refuses a level the model doesn't support", () => {
    const result = resolveThinkingRequest(PROVIDER, "claude-sonnet-5", "low", '{"level":"xhigh"}');
    expect(result.ok).toBe(false);
  });

  it("refuses malformed JSON", () => {
    expect(resolveThinkingRequest(PROVIDER, MODEL, "low", "{nope").ok).toBe(false);
  });
});

describe("POST /new-session", () => {
  it("refuses while a run is starting, not only once it is running", () => {
    const newSession = vi.fn(async () => {});
    const runClaim = new RunClaim();
    runClaim.claim();
    const ctx = { running: false, autopilotActive: false, runClaim, session: { newSession } };
    let status = 0;
    const res = {
      writeHead(code: number) {
        status = code;
        return this;
      },
      end: vi.fn(),
    };

    handleRunControlRoutes(
      ctx as unknown as SessionRouteContext,
      {} as http.IncomingMessage,
      res as unknown as http.ServerResponse,
      "/new-session",
      "POST",
    );

    expect(status).toBe(409);
    expect(newSession).not.toHaveBeenCalled();
  });
});
