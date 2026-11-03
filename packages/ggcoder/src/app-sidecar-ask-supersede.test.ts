import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createAskUserBridge, type AskUserPrompt } from "./core/ask-user.js";
import { createAskUserTool } from "./tools/ask-user.js";

/**
 * A prompt typed while a question is on screen is the user's answer: they chose
 * to say something else instead of clicking. `POST /prompt` therefore has to
 * release the parked `ask_user` call BEFORE it decides what to do with the
 * text.
 *
 * Order is the whole bug. Steering only drains between tool calls, so a prompt
 * queued while the tool is still parked waits on a tool that is itself waiting
 * on the user — the turn sits frozen until the ten-minute ask timeout fires,
 * and the user's message lands ten minutes late.
 *
 * The route lives inside app-sidecar's single `main()` closure with no seam to
 * inject a bridge into, so this covers it from both sides: the release itself
 * is exercised for real against a real parked tool call, and the route's source
 * is checked for where that release sits relative to the queue.
 */
const APP_SIDECAR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "app-sidecar/prompt-routes.ts",
);

/** The brace-balanced body of a route handler, keyed by its `url ===` guard. */
function routeBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `route not found: ${marker}`).toBeGreaterThan(-1);
  let depth = 0;
  let end = source.indexOf("{", start);
  for (let i = end; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return source.slice(start, end + 1);
}

describe("a typed prompt supersedes a parked question", () => {
  it("releases the blocked tool call with the answer-is-coming result", async () => {
    const broadcast = vi.fn<(prompt: AskUserPrompt) => void>();
    const asks = createAskUserBridge({ broadcast, timeoutMs: 600_000 });
    const tool = createAskUserTool(asks.park);
    const parked = tool.execute(
      { questions: [{ id: "store", question: "Which store for sessions?", kind: "confirm" }] },
      { signal: new AbortController().signal, toolCallId: "t1", onUpdate: () => {} } as never,
    ) as Promise<string>;
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalled());
    expect(asks.pendingCount).toBe(1);

    // Exactly what POST /prompt does with a non-empty prompt body.
    asks.cancelAll({ action: "cancel", superseded: true });

    // The turn is free immediately — no ten-minute timeout, no cancelled run.
    expect(asks.pendingCount).toBe(0);
    const text = await parked;
    expect(text).toContain("sent their own message instead");
    expect(text).not.toContain("stop and wait");
  });

  it("releases it before the prompt can queue as steering", async () => {
    const block = routeBlock(
      await fs.readFile(APP_SIDECAR, "utf8"),
      'if (method === "POST" && url === "/prompt") {',
    );
    const released = block.indexOf("superseded: true");
    const queued = block.indexOf("session.queueMessage(");
    const started = block.indexOf("runClaim.claim()");

    expect(released).toBeGreaterThan(-1);
    expect(queued).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(-1);
    // Both dispositions of a prompt — queued as steering mid-run, or claiming a
    // fresh run — must happen with the question already released.
    expect(released).toBeLessThan(queued);
    expect(released).toBeLessThan(started);
    // …but only for a prompt that actually exists: an empty body is rejected
    // above, and must not kill a live question on its way out.
    expect(block.indexOf('error: "empty prompt"')).toBeLessThan(released);
  });
});
