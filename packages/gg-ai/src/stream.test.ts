import { describe, expect, it } from "vitest";
import { localWireModelId, stream } from "./stream.js";
import { GGAIError } from "./errors.js";
import { providerRegistry } from "./provider-registry.js";
import { continuesTurn } from "./utils/turn-continuation.js";
import type { StreamOptions } from "./types.js";

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

  it("marks a runtime notice as continuing the turn, invisibly on the wire", () => {
    let captured: StreamOptions | undefined;
    const sentinel = new Error("captured");
    providerRegistry.register("wire-capture", {
      stream: (options) => {
        captured = options;
        throw sentinel;
      },
    });
    const meta = (kind: "notification" | "steering") => ({
      source: "runtime" as const,
      kind,
      visibility: "hidden" as const,
    });

    try {
      expect(() =>
        stream({
          provider: "wire-capture" as StreamOptions["provider"],
          model: "test",
          messages: [
            { role: "user", content: "notice", provenance: meta("notification") },
            { role: "user", content: "steer", provenance: meta("steering") },
          ],
        }),
      ).toThrow(sentinel);
      const [notice, steer] = captured?.messages ?? [];
      if (!notice || !steer) throw new Error("messages not captured");
      expect(continuesTurn(notice)).toBe(true);
      expect(continuesTurn(steer)).toBe(false);
      expect(JSON.stringify(notice)).toBe('{"role":"user","content":"notice"}');
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
