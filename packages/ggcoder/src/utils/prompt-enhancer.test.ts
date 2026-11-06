import type { Message } from "@kenkaiiii/gg-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  stream,
  StreamResult,
  type StopReason,
  type StreamEvent,
  type StreamResponse,
} from "@kenkaiiii/gg-ai";
import { ENHANCER_SYSTEM_PROMPT, enhancePrompt, parseEnhanced } from "./prompt-enhancer.js";

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  stream: vi.fn(),
}));

const examples = Array.from(
  ENHANCER_SYSTEM_PROMPT.matchAll(/<input>([\s\S]*?)<\/input>\s*<output>([\s\S]*?)<\/output>/g),
  ([, input, output]) => ({ input, output }),
);

function respond(content: string, stopReason: StopReason = "end_turn"): void {
  vi.mocked(stream).mockReturnValue(
    new StreamResult(
      (async function* (): AsyncGenerator<StreamEvent, StreamResponse> {
        yield { type: "text_delta", text: content };
        return {
          message: { role: "assistant", content },
          stopReason,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      })(),
    ),
  );
}

describe("enhancer examples", () => {
  it("includes five varied input/output pairs", () => {
    expect(examples).toHaveLength(5);
  });

  it.each(examples)("keeps the marker contract for $input", ({ input, output }) => {
    const result = parseEnhanced(output);
    expect(result.enhanced).not.toMatch(/[⟦⟧¦]/);
    expect(result.segments.map((segment) => segment.text).join("")).toBe(result.enhanced);
    for (const segment of result.segments) {
      if (segment.kind === "term") expect(input).toContain(segment.original);
    }
  });

  it("preserves headings, bullets, and concrete constraints in detailed output", () => {
    const output = examples[3].output;
    expect(parseEnhanced(output)).toEqual({
      enhanced: output,
      segments: [{ kind: "text", text: output }],
    });
    for (const detail of [
      "src/reports.ts",
      "admins only",
      "id and total",
      "no new dependencies",
      "JSON export unchanged",
      "only the headers",
      "two decimal places",
    ]) {
      expect(output).toContain(detail);
    }
  });
});

describe("enhancePrompt", () => {
  const options = { provider: "anthropic" as const, model: "claude-sonnet-5", maxTokens: 128000 };

  beforeEach(() => vi.mocked(stream).mockReset());

  it("sends the draft separately from instructions and retains vocabulary segments", async () => {
    respond(examples[1].output);
    const result = await enhancePrompt({ ...options, prompt: examples[1].input, stack: "React" });
    expect(vi.mocked(stream).mock.calls[0][0]).toMatchObject({
      ...options,
      messages: [
        { role: "system", content: expect.stringContaining(ENHANCER_SYSTEM_PROMPT) },
        { role: "user", content: examples[1].input },
      ],
    });
    expect(result.enhanced).toBe("In Search.tsx, debounce search requests by 300ms.");
    expect(result.segments).toContainEqual({
      kind: "term",
      text: "debounce",
      original: "wait until I stop typing",
      note: "Wait for a pause before sending the request",
    });
  });

  it.each([
    [10, 128000],
    [2000, 16384],
    [10000, 2048],
  ])(
    "uses the session's %i-character draft allowance of %i tokens unchanged",
    async (length, maxTokens) => {
      respond("Keep the draft details.");
      await enhancePrompt({ ...options, maxTokens, prompt: "x".repeat(length) });
      expect(vi.mocked(stream).mock.calls[0][0].maxTokens).toBe(maxTokens);
    },
  );

  it("preserves the active model's reasoning budget and provider context", async () => {
    respond("Fix the bug.");
    const active = {
      provider: "anthropic" as const,
      model: "claude-fable-5-1",
      maxTokens: 128000,
      thinking: "high" as const,
      projectId: "account-project",
      baseUrl: "https://provider.example/v1",
      accountId: "account-id",
      signal: new AbortController().signal,
    };
    await enhancePrompt({ ...active, prompt: "fix bug" });
    expect(vi.mocked(stream).mock.calls[0][0]).toMatchObject(active);
    expect(vi.mocked(stream).mock.calls[0][0]).not.toHaveProperty("temperature");
  });

  it("uses `complete` instead of stream() when given one", async () => {
    const complete = vi.fn(async (_messages: Message[]) => ({
      message: { role: "assistant" as const, content: examples[1].output },
      stopReason: "end_turn" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const result = await enhancePrompt({ ...options, prompt: examples[1].input, complete });
    expect(vi.mocked(stream)).not.toHaveBeenCalled();
    expect(complete.mock.calls[0]![0]).toEqual([
      { role: "system", content: expect.stringContaining(ENHANCER_SYSTEM_PROMPT) },
      { role: "user", content: examples[1].input },
    ]);
    expect(result.enhanced).toBe("In Search.tsx, debounce search requests by 300ms.");
  });

  it("rejects empty output instead of returning an empty replacement", async () => {
    respond("   ");
    await expect(enhancePrompt({ ...options, prompt: "fix bug" })).rejects.toThrow(
      "returned no text",
    );
  });

  it("rejects truncated output instead of returning a partial replacement", async () => {
    respond("Add CSV export, but", "max_tokens");
    await expect(enhancePrompt({ ...options, prompt: examples[3].input })).rejects.toThrow(
      "Prompt enhancement was cut short",
    );
  });
});
