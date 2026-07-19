import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureSidecarError,
  flushSidecarErrors,
  wrapSidecarHandler,
  type SidecarErrorContext,
} from "./sidecar-error-reporter.js";

interface ReporterStub {
  captureError: ReturnType<typeof vi.fn<(error: unknown, context?: SidecarErrorContext) => string>>;
  wrap: ReturnType<
    typeof vi.fn<
      <A extends unknown[], R>(
        fn: (...args: A) => R,
        context?: SidecarErrorContext,
      ) => (...args: A) => R
    >
  >;
  flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

const trackedGlobal = globalThis as typeof globalThis & { __GG_ERROR_MOM__?: ReporterStub };
const originalArgv = [...process.argv];

afterEach(() => {
  delete trackedGlobal.__GG_ERROR_MOM__;
  process.argv.splice(0, process.argv.length, ...originalArgv);
});

function installReporter(): ReporterStub {
  const reporter: ReporterStub = {
    captureError: vi.fn(() => "event-1"),
    wrap: vi.fn((fn) => fn),
    flush: vi.fn(async () => {}),
  };
  trackedGlobal.__GG_ERROR_MOM__ = reporter;
  return reporter;
}

describe("sidecar error reporter bridge", () => {
  it("adds process and caller tags to captured worker errors", () => {
    const reporter = installReporter();
    process.argv.push("--subagent-worker");
    const error = new Error("provider failed");

    captureSidecarError(error, "subagent-worker.turn", { provider: "anthropic" });

    expect(reporter.captureError).toHaveBeenCalledWith(error, {
      culprit: "subagent-worker.turn",
      tags: { process: "subagent-worker", provider: "anthropic" },
    });
  });

  it("wraps framework handlers and flushes through the installed SDK", async () => {
    const reporter = installReporter();
    const handler = vi.fn(() => "ok");

    expect(wrapSidecarHandler(handler, "app-sidecar.http")()).toBe("ok");
    await flushSidecarErrors();

    expect(reporter.wrap).toHaveBeenCalledWith(handler, {
      culprit: "app-sidecar.http",
      tags: { process: "app-sidecar" },
    });
    expect(reporter.flush).toHaveBeenCalledOnce();
  });
});
