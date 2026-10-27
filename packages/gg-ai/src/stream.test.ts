import { describe, expect, it } from "vitest";
import { localWireModelId, stream } from "./stream.js";
import { GGAIError } from "./errors.js";
import { providerRegistry } from "./provider-registry.js";
import { continuesTurn } from "./utils/turn-continuation.js";
import { isCacheAnchor } from "./utils/cache-anchor.js";
import type { MessageProvenanceKind, StreamOptions } from "./types.js";

describe("localWireModelId", () => {
  it("strips the endpoint routing prefix so the server sees its own id", () => {
    expect(localWireModelId("local/ollama/qwen3-coder:30b")).toBe("qwen3-coder:30b");
    // Raw ids can contain slashes (vLLM serves HF repo ids).
    expect(localWireModelId("local/vllm/Qwen/Qwen3-32B")).toBe("Qwen/Qwen3-32B");
  });

  it("leaves non-local ids untouched", () => {
    expect(localWireModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(localWireModelId("qwen/qwen3.8-max")).toBe("qwen/qwen3.8-max");
  });
});

describe("local provider", () => {
  it("refuses to stream without an endpoint instead of guessing a port", () => {
    expect(() =>
      stream({
        provider: "local",
        model: "local/ollama/qwen3-coder:30b",
        messages: [{ role: "user", content: "hi" }],
        apiKey: "local",
      }),
    ).toThrow(GGAIError);
  });
});

describe("provider wire boundary", () => {
  it("strips provenance without cloning unrelated messages", () => {
    let captured: StreamOptions | undefined;
    const sentinel = new Error("captured");
    providerRegistry.register("wire-capture", {
      stream: (options) => {
        captured = options;
        throw sentinel;
      },
    });

    const plain = { role: "system" as const, content: "system" };
    const tagged = {
      role: "user" as const,
      content: "hello",
      provenance: {
        source: "human" as const,
        kind: "prompt" as const,
        visibility: "transcript" as const,
      },
    };

    try {
      expect(() =>
        stream({
          provider: "wire-capture" as StreamOptions["provider"],
          model: "test",
          messages: [plain, tagged],
        }),
      ).toThrow(sentinel);
      expect(captured?.messages[0]).toBe(plain);
      expect(captured?.messages[1]).toEqual({ role: "user", content: "hello" });
      expect(captured?.messages[1]).not.toHaveProperty("provenance");
      expect(tagged.provenance.source).toBe("human");
    } finally {
      providerRegistry.unregister("wire-capture");
    }
  });

  it("marks mid-run messages as continuing the turn, invisibly on the wire", () => {
    let captured: StreamOptions | undefined;
    const sentinel = new Error("captured");
    providerRegistry.register("wire-capture", {
      stream: (options) => {
        captured = options;
        throw sentinel;
      },
    });
    const meta = (kind: MessageProvenanceKind) => ({
      source: "runtime" as const,
      kind,
      visibility: "hidden" as const,
    });
    const midRun: MessageProvenanceKind[] = [
      "steering",
      "completion_gate",
      "continuation",
      "review_follow_up",
    ];
    const opening: MessageProvenanceKind[] = ["prompt", "automation", "compaction_summary"];

    try {
      expect(() =>
        stream({
          provider: "wire-capture" as StreamOptions["provider"],
          model: "test",
          messages: [
            { role: "user", content: "notice", provenance: meta("notification") },
            ...midRun.map((kind) => ({
              role: "user" as const,
              content: kind,
              provenance: meta(kind),
            })),
            ...opening.map((kind) => ({
              role: "user" as const,
              content: kind,
              provenance: meta(kind),
            })),
          ],
        }),
      ).toThrow(sentinel);
      const [notice, ...rest] = captured?.messages ?? [];
      if (!notice || rest.length !== midRun.length + opening.length) {
        throw new Error("messages not captured");
      }
      expect(continuesTurn(notice)).toBe(true);
      // Steering and runtime nudges keep the run's thinking (and its cache).
      expect(rest.slice(0, midRun.length).map(continuesTurn)).toEqual(midRun.map(() => true));
      // A prompt, an automation or a compaction summary still opens a new turn.
      expect(rest.slice(midRun.length).map(continuesTurn)).toEqual(opening.map(() => false));
      expect(JSON.stringify(notice)).toBe('{"role":"user","content":"notice"}');
    } finally {
      providerRegistry.unregister("wire-capture");
    }
  });

  it("carries a cache-anchor hint to the provider as an invisible marker", () => {
    let captured: StreamOptions | undefined;
    const sentinel = new Error("captured");
    providerRegistry.register("wire-capture", {
      stream: (options) => {
        captured = options;
        throw sentinel;
      },
    });

    try {
      expect(() =>
        stream({
          provider: "wire-capture" as StreamOptions["provider"],
          model: "test",
          messages: [
            { role: "user", content: "go", cacheAnchor: true },
            {
              role: "assistant",
              content: [{ type: "tool_call", id: "call_1", name: "bash", args: {} }],
              cacheAnchor: true,
            },
            {
              role: "tool",
              content: [{ type: "tool_result", toolCallId: "call_1", content: "ok" }],
              cacheAnchor: true,
            },
          ],
        }),
      ).toThrow(sentinel);
      const [user, assistant, tool] = captured?.messages ?? [];
      if (!user || !assistant || !tool) throw new Error("messages not captured");
      expect([user, assistant, tool].map(isCacheAnchor)).toEqual([true, false, true]);
      expect(JSON.stringify(user)).toBe('{"role":"user","content":"go"}');
      expect(JSON.stringify(assistant)).not.toContain("cacheAnchor");
    } finally {
      providerRegistry.unregister("wire-capture");
    }
  });

  it("scrubs lone surrogates so the provider body stays valid JSON", () => {
    let captured: StreamOptions | undefined;
    const sentinel = new Error("captured");
    providerRegistry.register("wire-capture", {
      stream: (options) => {
        captured = options;
        throw sentinel;
      },
    });

    try {
      expect(() =>
        stream({
          provider: "wire-capture" as StreamOptions["provider"],
          model: "test",
          messages: [
            { role: "user", content: "read a file \uD83D" },
            {
              role: "tool",
              content: [{ type: "tool_result", toolCallId: "1", content: "\uDE00 output" }],
            },
          ],
        }),
      ).toThrow(sentinel);
      // Assert on the raw strings: well-formed `JSON.stringify` escapes a lone
      // surrogate to ASCII `\ud83d`, so checking the serialized body would pass
      // even if the scrub never ran.
      const user = captured?.messages[0];
      const tool = captured?.messages[1] as { content: { content: string }[] } | undefined;
      expect(user?.content).toBe("read a file \uFFFD");
      expect(tool?.content[0]?.content).toBe("\uFFFD output");
    } finally {
      providerRegistry.unregister("wire-capture");
    }
  });

  it("drops a malformed tool call and its result before provider dispatch", () => {
    let captured: StreamOptions | undefined;
    const sentinel = new Error("captured");
    providerRegistry.register("wire-capture", {
      stream: (options) => {
        captured = options;
        throw sentinel;
      },
    });

    try {
      expect(() =>
        stream({
          provider: "wire-capture" as StreamOptions["provider"],
          model: "test",
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: [
                { type: "text", text: "calling" },
                { type: "tool_call", id: "bad", name: 'bash {"cmd":"ls"}', args: {} },
                { type: "tool_call", id: "ok", name: "read", args: {} },
              ],
            },
            {
              role: "tool",
              content: [
                { type: "tool_result", toolCallId: "bad", content: "x" },
                { type: "tool_result", toolCallId: "ok", content: "y" },
              ],
            },
          ],
        }),
      ).toThrow(sentinel);
      expect(captured?.messages).toEqual([
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_call", id: "ok", name: "read", args: {} },
          ],
        },
        { role: "tool", content: [{ type: "tool_result", toolCallId: "ok", content: "y" }] },
      ]);
    } finally {
      providerRegistry.unregister("wire-capture");
    }
  });
});
