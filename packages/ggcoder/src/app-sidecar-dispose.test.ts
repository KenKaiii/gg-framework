import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Closing a window or switching project sends `DELETE /session/:id`, which
 * disposes that window's per-session closure. If dispose does not abort the
 * window's own run, the agent loop keeps streaming from the provider (spending
 * tokens) and running tools on a half-torn-down session, and a run-all sweep or
 * autopilot can start its next turn. An `ollama pull` the window started would
 * also keep downloading gigabytes.
 *
 * The per-session state lives in a closure with no seam to inject a session,
 * so this pins the order in the source: the abort happens before anything is
 * torn down.
 */
const SIDECAR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "app-sidecar.ts");

function disposeBody(source: string): string {
  const start = source.indexOf("async function dispose(): Promise<void> {");
  expect(start, "dispose() not found").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("unbalanced dispose()");
}

describe("session dispose stops the window's work", () => {
  it("aborts the run and cancels a model pull before tearing down", async () => {
    const body = disposeBody(await fs.readFile(SIDECAR, "utf8"));
    const abort = body.indexOf("abortOwnedWork()");
    const pull = body.indexOf("cancelHfPull()");
    const teardown = body.indexOf("session.dispose()");
    expect(abort, "dispose must call abortOwnedWork()").toBeGreaterThan(-1);
    expect(pull, "dispose must call cancelHfPull()").toBeGreaterThan(-1);
    expect(abort).toBeLessThan(teardown);
    expect(pull).toBeLessThan(teardown);
  });
});
