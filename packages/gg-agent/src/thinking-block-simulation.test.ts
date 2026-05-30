/**
 * End-to-end simulation of the fatal Anthropic error from the bug report:
 *
 *   "messages.3.content.257: `thinking` or `redacted_thinking` blocks in the
 *    latest assistant message cannot be modified. These blocks must remain as
 *    they were in the original response."
 *
 * Rather than asserting on internal shapes, this drives the REAL agent loop and
 * the REAL `toAnthropicMessages` transform against a fake "Anthropic endpoint"
 * that enforces Anthropic's documented thinking-block rules — including a
 * simulated cryptographic signature check (a signature the server never issued
 * is rejected, exactly like the live API). A poisoned, restored session is fed
 * in; the simulation reports whether the request the framework actually builds
 * is accepted, and whether the loop self-heals when the latest turn is corrupt.
 *
 * Negative/positive controls prove the validator genuinely detects the bug, so
 * a PASS here is meaningful and not a vacuous no-op.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { agentLoop } from "./agent-loop.js";
import type { AgentEvent, AgentResult, AgentTool } from "./types.js";
import type { Message } from "@kenkaiiii/gg-ai";

// Mock only `stream`; everything else (incl. toAnthropicMessages) stays real.
vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const mod = await importOriginal<typeof import("@kenkaiiii/gg-ai")>();
  return { ...mod, stream: vi.fn() };
});

import { stream, toAnthropicMessages } from "@kenkaiiii/gg-ai";
const mockStream = vi.mocked(stream);
const emptyParams = z.object({});

// ── Simulated Anthropic validation ─────────────────────────
// Mirrors the live API: thinking blocks are validated by signature in EVERY
// assistant message that survives into the request (the real error referenced
// messages.3, i.e. a non-last turn). A signature the server never issued —
// truncated/partial from an aborted stream, or otherwise corrupt — is rejected
// with the exact production error string. Empty text blocks are rejected too.

interface WireBlock {
  type?: string;
  text?: string;
  signature?: string;
  data?: string;
}
interface WireMessage {
  role: string;
  content: unknown;
}

function validateAnthropicRequest(
  messages: readonly WireMessage[],
  issuedSignatures: ReadonlySet<string>,
): void {
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    (m.content as WireBlock[]).forEach((blk, b) => {
      if (blk.type === "text" && (blk.text ?? "") === "") {
        throw new Error(`messages.${i}.content.${b}: text content blocks must be non-empty`);
      }
      if (m.role !== "assistant") return;
      if (blk.type === "thinking") {
        if (!blk.signature || !issuedSignatures.has(blk.signature)) {
          throw new Error(
            `messages.${i}.content.${b}: \`thinking\` or \`redacted_thinking\` blocks in the ` +
              `latest assistant message cannot be modified. These blocks must remain as they ` +
              `were in the original response.`,
          );
        }
      }
      if (blk.type === "redacted_thinking" && !blk.data) {
        throw new Error(
          `messages.${i}.content.${b}: \`redacted_thinking\` block must keep its data.`,
        );
      }
    });
  });
}

// ── Mock stream wiring ─────────────────────────────────────

function mockOkResult(text: string) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { type: "text_delta" as const, text };
    },
    response: Promise.resolve({
      message: { role: "assistant" as const, content: [{ type: "text" as const, text }] },
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 10 },
    }),
  };
}

function mockErrorResult(error: Error) {
  const p = Promise.reject(error);
  p.catch(() => {});
  return {
    [Symbol.asyncIterator]: async function* () {
      yield* [];
      throw error;
    },
    response: p,
  };
}

interface FakeEndpoint {
  requests: WireMessage[][];
}

/**
 * Install a fake Anthropic endpoint as the mocked `stream`. On every call it
 * runs the real transform on the messages the framework built, records the wire
 * request, validates it, and either rejects with the production error string or
 * returns a successful turn.
 */
function installFakeAnthropic(issuedSignatures: ReadonlySet<string>): FakeEndpoint {
  const endpoint: FakeEndpoint = { requests: [] };
  mockStream.mockImplementation((opts) => {
    const { messages: wire } = toAnthropicMessages(opts.messages as Message[]);
    endpoint.requests.push(wire as unknown as WireMessage[]);
    try {
      validateAnthropicRequest(wire as unknown as WireMessage[], issuedSignatures);
    } catch (err) {
      return mockErrorResult(err as Error) as unknown as ReturnType<typeof stream>;
    }
    return mockOkResult("ok") as unknown as ReturnType<typeof stream>;
  });
  return endpoint;
}

// ── Realistic poisoned session builder ─────────────────────

const noopTool: AgentTool<typeof emptyParams> = {
  name: "noop",
  description: "A no-op tool.",
  parameters: emptyParams,
  execute: async () => "ok",
};

const CORRUPT_SIGNATURE = "sig-truncated-from-aborted-stream";

/**
 * Build a restored multi-turn session mirroring the transcript: interleaved
 * thinking + tool calls across many assistant turns. One turn carries a corrupt
 * signature (as if its stream was interrupted mid-`signature_delta` and the
 * partial value was persisted).
 *
 * `corruptAt: "early"`  → corruption on a NON-last assistant turn (the
 *                          messages.3-style symptom). The transform must strip
 *                          thinking from older turns, so the first request is
 *                          already clean.
 * `corruptAt: "latest"` → corruption on the LAST assistant turn. The transform
 *                          can't detect a structurally-valid-looking but
 *                          cryptographically-invalid signature, so the first
 *                          request is rejected and the loop's recovery must
 *                          strip thinking and retry.
 */
function buildSession(corruptAt: "early" | "latest" | "none"): {
  messages: Message[];
  issued: Set<string>;
} {
  const issued = new Set<string>();
  let counter = 0;
  const sig = (corrupt: boolean): string => {
    if (corrupt) return CORRUPT_SIGNATURE; // deliberately NOT added to `issued`
    const s = `sig-issued-${counter++}`;
    issued.add(s);
    return s;
  };

  const messages: Message[] = [
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "Refactor goal-store.ts and goal-controller.ts." },
  ];

  const TURNS = 8;
  for (let t = 0; t < TURNS; t++) {
    const isLast = t === TURNS - 1;
    const corrupt = (corruptAt === "early" && t === 1) || (corruptAt === "latest" && isLast);

    if (isLast) {
      // Final turn ends with text + no tool call so the conversation is a
      // complete assistant turn being resumed ("continue").
      messages.push({
        role: "assistant",
        content: [
          { type: "thinking", text: `final reasoning turn ${t}`, signature: sig(corrupt) },
          { type: "text", text: `Here is the plan for turn ${t}.` },
        ],
      });
    } else {
      const id = `call_${t}`;
      messages.push({
        role: "assistant",
        content: [
          { type: "thinking", text: `reasoning turn ${t}`, signature: sig(corrupt) },
          { type: "text", text: `Editing files (turn ${t})…` },
          { type: "tool_call", id, name: "noop", args: { turn: t } },
        ],
      });
      messages.push({
        role: "tool",
        content: [{ type: "tool_result", toolCallId: id, content: `done ${t}` }],
      });
    }
  }
  return { messages, issued };
}

async function runLoop(
  messages: Message[],
): Promise<{ events: AgentEvent[]; result: AgentResult }> {
  const gen = agentLoop(messages, {
    provider: "anthropic",
    model: "claude-sim",
    tools: [noopTool],
  });
  const events: AgentEvent[] = [];
  let result: AgentResult | undefined;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      result = next.value as AgentResult;
      break;
    }
    events.push(next.value);
  }
  return { events, result: result! };
}

beforeEach(() => {
  mockStream.mockReset();
});

describe("thinking-block bug simulation (Anthropic 'cannot be modified')", () => {
  // ── Controls: prove the validator actually catches the bug ──

  it("CONTROL: the simulated endpoint rejects a request that keeps a corrupt-signature thinking block", () => {
    const issued = new Set<string>(["sig-good"]);
    const poisoned: WireMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", signature: CORRUPT_SIGNATURE },
          { type: "tool_use", id: "c1", name: "noop", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "more", signature: "sig-good" }],
      },
    ];
    expect(() => validateAnthropicRequest(poisoned, issued)).toThrow(/cannot be modified/);
  });

  it("CONTROL: the simulated endpoint accepts a clean request", () => {
    const issued = new Set<string>(["sig-good"]);
    const clean: WireMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "c1", name: "noop", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "fresh", signature: "sig-good" }],
      },
    ];
    expect(() => validateAnthropicRequest(clean, issued)).not.toThrow();
  });

  // ── The actual fix, end to end ──

  it("does NOT happen: a corrupt thinking block on an OLDER turn is stripped, first request is accepted", async () => {
    const { messages, issued } = buildSession("early");
    const endpoint = installFakeAnthropic(issued);

    const { events } = await runLoop(messages);

    // The framework's first request was already valid — no retry needed.
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);

    // Mechanism: every non-latest assistant turn was stripped of thinking, so
    // the corrupt block never reached the endpoint.
    const wire = endpoint.requests[0]!;
    const assistantTurns = wire.filter((m) => m.role === "assistant");
    const olderTurns = assistantTurns.slice(0, -1);
    for (const turn of olderTurns) {
      const types = (turn.content as WireBlock[]).map((b) => b.type);
      expect(types).not.toContain("thinking");
      expect(types).not.toContain("redacted_thinking");
    }
    // tool_use survived on the older turns.
    expect(
      olderTurns.some((t) => (t.content as WireBlock[]).some((b) => b.type === "tool_use")),
    ).toBe(true);
  });

  it("self-heals: a corrupt thinking block on the LATEST turn is rejected once, then the loop strips+retries to success", async () => {
    const { messages, issued } = buildSession("latest");
    const endpoint = installFakeAnthropic(issued);

    const { events } = await runLoop(messages);

    // First request rejected (corrupt latest-turn signature the transform can't
    // detect); recovery strips thinking and the second request is accepted.
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);

    // The retry carried no thinking blocks at all.
    const retryWire = endpoint.requests[1]!;
    for (const m of retryWire.filter((x) => x.role === "assistant")) {
      const types = (m.content as WireBlock[]).map((b) => b.type);
      expect(types).not.toContain("thinking");
      expect(types).not.toContain("redacted_thinking");
    }
    // Reasoning text was preserved (downgraded to text), not silently lost.
    const preservedText = retryWire
      .filter((x) => x.role === "assistant")
      .flatMap((x) => x.content as WireBlock[])
      .some((b) => b.type === "text" && (b.text ?? "").includes("final reasoning turn"));
    expect(preservedText).toBe(true);
  });

  it("a fully clean restored session passes on the first request", async () => {
    const { messages, issued } = buildSession("none");
    installFakeAnthropic(issued);

    const { events } = await runLoop(messages);

    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);
  });
});
