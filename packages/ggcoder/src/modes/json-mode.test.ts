import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exitAfterFlush, JSON_MODE_FLUSH_TIMEOUT_MS, type ExitHost } from "./json-mode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface FakeHost extends ExitHost {
  exits: number[];
  drain(): void;
  fireTimeout(): void;
}

function fakeHost(writableLength: number): FakeHost {
  const exits: number[] = [];
  let onDrain: (() => void) | undefined;
  let onTimeout: (() => void) | undefined;
  return {
    exits,
    stdout: {
      writableLength,
      once: (_event: "drain", listener: () => void) => {
        onDrain = listener;
        return undefined;
      },
    },
    exit: (code: number) => {
      exits.push(code);
    },
    setTimeout: (handler: () => void, ms: number) => {
      expect(ms).toBe(JSON_MODE_FLUSH_TIMEOUT_MS);
      onTimeout = handler;
      return { unref: () => undefined };
    },
    drain: () => onDrain?.(),
    fireTimeout: () => onTimeout?.(),
  };
}

/**
 * Regression: a JSON-mode child that had finished its work never exited, because
 * the desktop sub-agent worker entry is the app-sidecar bundle whose import-time
 * handles keep the event loop alive. The parent then killed it after its timeout
 * and reported a completed run as "Sub-agent failed (exit null): unknown error".
 */
describe("exitAfterFlush", () => {
  it("exits immediately when stdout has no buffered bytes", () => {
    const host = fakeHost(0);
    exitAfterFlush(0, host);
    expect(host.exits).toEqual([0]);
  });

  it("waits for drain before exiting so the NDJSON tail is not truncated", () => {
    const host = fakeHost(128);
    exitAfterFlush(0, host);
    expect(host.exits).toEqual([]);

    host.drain();
    expect(host.exits).toEqual([0]);
  });

  it("still exits when the pipe never drains", () => {
    const host = fakeHost(128);
    exitAfterFlush(0, host);
    expect(host.exits).toEqual([]);

    // A stalled reader must not resurrect the original hang.
    host.fireTimeout();
    expect(host.exits).toEqual([0]);
  });

  it("propagates a non-zero code", () => {
    const host = fakeHost(0);
    exitAfterFlush(1, host);
    expect(host.exits).toEqual([1]);
  });

  it("does not leave a live timer holding the event loop open", () => {
    const unref = vi.fn();
    const host = fakeHost(128);
    host.setTimeout = () => ({ unref });
    exitAfterFlush(0, host);
    expect(unref).toHaveBeenCalled();
  });
});

describe("runJsonMode tool-output cleanup", () => {
  // Regression: only the TUI and the app swept ~/.gg/tool-output/, so outputs
  // offloaded by headless runs piled up until the next app start (2026-11-04).
  it("sweeps stale offloaded outputs before the session starts, without awaiting it", () => {
    const source = fs.readFileSync(path.join(__dirname, "json-mode.ts"), "utf-8");
    const body = source.slice(source.indexOf("export async function runJsonMode"));
    expect(body).toContain("void cleanupToolOutputs().catch(() => {});");
    expect(body).not.toContain("await cleanupToolOutputs(");
    expect(body.indexOf("cleanupToolOutputs()")).toBeLessThan(body.indexOf("new AgentSession("));
  });
});

describe("runJsonMode termination contract", () => {
  it("ends its success path by exiting rather than just returning", () => {
    // Guards the actual defect: returning from runJsonMode left the process
    // alive under any host that holds import-time handles.
    const source = fs.readFileSync(path.join(__dirname, "json-mode.ts"), "utf-8");
    const body = source.slice(source.indexOf("export async function runJsonMode"));
    expect(body).toContain("exitAfterFlush(0)");

    // The exit must come after dispose()/closeLogger() in the finally block,
    // otherwise the session's own resources leak on every sub-agent call.
    expect(body.indexOf("closeLogger()")).toBeLessThan(body.indexOf("exitAfterFlush(0)"));
  });
});
