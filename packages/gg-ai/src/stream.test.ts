import { describe, expect, it } from "vitest";
import { localWireModelId, openCodeWireModelId, stream } from "./stream.js";
import { GGAIError } from "./errors.js";
import { providerRegistry } from "./provider-registry.js";
import { continuesTurn } from "./utils/turn-continuation.js";
import type { StreamOptions } from "./types.js";
import {
  reasoningFieldKey,
  rememberReasoningField,
  resetReasoningFieldCache,
} from "./providers/reasoning-field.js";

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

  it.each([
    ["local", null],
    ["sk-gateway", "Bearer sk-gateway"],
  ])("sends key %s as Authorization %s", async (apiKey, expected) => {
    let authorization: string | null | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response("{}", { status: 401 });
    };
    const result = stream({
      provider: "local",
      model: "local/custom-gw/free-model",
      messages: [{ role: "user", content: "hi" }],
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey,
      fetch,
    });
    await expect(result).rejects.toThrow();
    expect(authorization).toBe(expected);
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

describe("OpenCode providers", () => {
  async function capture(
    provider: "opencode" | "opencode-go",
    extra: Partial<StreamOptions> = {},
  ): Promise<{ url: string; headers: Headers; body: Record<string, unknown> }> {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      seen = {
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return new Response("{}", { status: 401 });
    };
    const result = stream({
      provider,
      model: `${provider}/kimi-k3`,
      messages: [{ role: "user", content: "hi" }],
      apiKey: "oc_sk_test",
      fetch,
      ...extra,
    });
    await expect(result).rejects.toThrow();
    return seen!;
  }

  it("strips the plan prefix so the gateway sees its own model id", () => {
    expect(openCodeWireModelId("opencode-go/kimi-k3")).toBe("kimi-k3");
    expect(openCodeWireModelId("opencode/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(openCodeWireModelId("kimi-k3")).toBe("kimi-k3");
  });

  it.each([
    ["opencode-go", "https://opencode.ai/inference/go/openai/v1/chat/completions"],
    ["opencode", "https://opencode.ai/inference/openai/v1/chat/completions"],
  ] as const)("sends %s to its plan's endpoint as GG Coder, with the session", async (p, url) => {
    const seen = await capture(p, { transportSessionId: "3f0c6a1e-9d2b-4c55-8a51-0b7d2f1e6a90" });
    expect(seen.url).toBe(url);
    expect(seen.body.model).toBe("kimi-k3");
    expect(seen.headers.get("authorization")).toBe("Bearer oc_sk_test");
    expect(seen.headers.get("user-agent")).toMatch(/^ggcoder/);
    expect(seen.headers.get("x-opencode-session")).toBe("3f0c6a1e-9d2b-4c55-8a51-0b7d2f1e6a90");
  });

  // Go answers HTTP 400 to any request without the header, so summaries and
  // other calls made outside a conversation must still carry one.
  it("falls back to one stable session id when the caller has none", async () => {
    const first = await capture("opencode-go");
    const second = await capture("opencode-go", { transportSessionId: "bad\nvalue" });
    const fallback = first.headers.get("x-opencode-session");
    expect(fallback).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(second.headers.get("x-opencode-session")).toBe(fallback);
  });
});

describe("OpenCode request shape", () => {
  async function body(extra: Partial<StreamOptions>): Promise<Record<string, unknown>> {
    let seen: Record<string, unknown> | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      seen = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("{}", { status: 401 });
    };
    const result = stream({
      provider: "opencode-go",
      model: "opencode-go/kimi-k3",
      messages: [{ role: "user", content: "hi" }],
      apiKey: "oc_sk_test",
      fetch,
      ...extra,
    });
    await expect(result).rejects.toThrow();
    return seen!;
  }

  // The gateway silently ignores max_completion_tokens, leaving output uncapped.
  it("caps output with max_tokens, the only name the gateway reads", async () => {
    const sent = await body({ maxTokens: 4096 });
    expect(sent.max_tokens).toBe(4096);
    expect(sent).not.toHaveProperty("max_completion_tokens");
  });

  // Kimi on OpenCode answers 400 "reasoning_content is missing in assistant
  // tool call message" when earlier thinking comes back under another name.
  it("returns earlier thinking as reasoning_content even after a `reasoning` stream", async () => {
    rememberReasoningField(
      reasoningFieldKey("opencode-go", "https://opencode.ai/inference/go/openai/v1", "kimi-k3"),
      "reasoning",
    );
    try {
      const sent = await body({
        messages: [
          { role: "user", content: "read it" },
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "I should read the file" },
              { type: "tool_call", id: "call_1", name: "read", args: { path: "a.ts" } },
            ],
          },
          {
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "call_1", content: "ok" }],
          },
        ],
      });
      const assistant = (sent.messages as Record<string, unknown>[])[1]!;
      expect(assistant.reasoning_content).toBe("I should read the file");
      expect(assistant).not.toHaveProperty("reasoning");
    } finally {
      resetReasoningFieldCache();
    }
  });
});
