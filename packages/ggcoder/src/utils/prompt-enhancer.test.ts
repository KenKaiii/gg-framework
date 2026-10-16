import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  stream,
  StreamResult,
  type StopReason,
  type StreamEvent,
  type StreamResponse,
} from "@kenkaiiii/gg-ai";
import {
  ENHANCER_SYSTEM_PROMPT,
  enhancePrompt,
  parseEnhanced,
  stackHint,
} from "./prompt-enhancer.js";

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
  it("includes nine varied input/output pairs", () => {
    expect(examples).toHaveLength(9);
  });

  function example(match: string): { input: string; output: string } {
    const found = examples.find(({ input }) => input.includes(match));
    if (!found) throw new Error(`missing example: ${match}`);
    return found;
  }

  it("is field-agnostic: one general method, examples framed as illustrations", () => {
    const instructions = ENHANCER_SYSTEM_PROMPT.split("<examples>")[0] ?? "";
    expect(instructions).toContain("This works for any field.");
    expect(instructions).toContain(
      "What would an experienced practitioner in this field call this?",
    );
    expect(ENHANCER_SYSTEM_PROMPT).toContain(
      "These examples illustrate the method. They are not a list of supported fields or terms",
    );
    // No per-field vocabulary lists outside the examples.
    for (const term of ["J-cut", "Bevel", "padding", "empty state", "debounce"]) {
      expect(instructions.toLowerCase()).not.toContain(term.toLowerCase());
    }
    // Terminology is the main job, not an optional extra.
    expect(instructions).toContain("Your main job is terminology");
    expect(instructions).not.toMatch(/often 0/);
  });

  it.each([
    ["cards are squished", ["responsive", "padding", "empty state"], "Don't change the colours."],
    ["cut to her face", ["J-cut", "Colour-match"], "Don't touch the music."],
    ["edges of the table less sharp", ["Bevel"], "Keep the polygon count low."],
  ])("translates the %s example into field terms and keeps its limits", (match, terms, limit) => {
    const result = parseEnhanced(example(match).output);
    for (const text of terms) {
      expect(result.segments).toContainEqual(expect.objectContaining({ kind: "term", text }));
    }
    expect(result.enhanced).toContain(limit);
  });

  it("names the described behavior without inventing a mechanism", () => {
    const persist = parseEnhanced(example("remember the theme").output);
    expect(persist.segments).toContainEqual(
      expect.objectContaining({ kind: "term", text: "Persist" }),
    );
    expect(persist.enhanced).toContain("after closing and reopening the app");
    expect(persist.enhanced).not.toMatch(/localStorage|database|file/);
    const realtime = parseEnhanced(example("show up right away").output);
    expect(realtime.enhanced).toBe("Make updates appear in real time.");
    expect(realtime.enhanced).not.toMatch(/WebSocket|polling|optimistic/i);
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
    expect(result.enhanced).toBe(
      "In Search.tsx, debounce search requests: send the request after typing has stopped for 300ms.",
    );
    expect(result.segments).toContainEqual({
      kind: "term",
      text: "debounce",
      original: "wait until I stop typing",
      note: "Wait for a pause before sending the request",
    });
  });

  it("scopes the stack hint to code so other fields ignore it", async () => {
    const video = examples.find(({ input }) => input.includes("cut to her face"));
    if (!video) throw new Error("missing video example");
    respond(video.output);
    const result = await enhancePrompt({ ...options, prompt: video.input, stack: " React " });
    const system = vi.mocked(stream).mock.calls[0]?.[0].messages[0]?.content;
    expect(system).toBe(`${ENHANCER_SYSTEM_PROMPT}\n\n${stackHint("React")}`);
    expect(system).toContain("Use this only for parts of the draft about this project's code");
    expect(system).toContain("Ignore it for any other field");
    expect(result.segments).toContainEqual(
      expect.objectContaining({ kind: "term", text: "J-cut" }),
    );
    expect(result.enhanced).not.toMatch(/React|component/i);
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
      userAgent: "claude-cli/test",
      baseUrl: "https://provider.example/v1",
      accountId: "account-id",
      signal: new AbortController().signal,
    };
    await enhancePrompt({ ...active, prompt: "fix bug" });
    expect(vi.mocked(stream).mock.calls[0][0]).toMatchObject(active);
    expect(vi.mocked(stream).mock.calls[0][0]).not.toHaveProperty("temperature");
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
