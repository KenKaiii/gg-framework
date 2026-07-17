import { describe, it, expect, beforeAll } from "vitest";
import {
  estimateTokens,
  estimateMessageTokens,
  estimateConversationTokens,
  setEstimatorModel,
  calibrateEstimator,
  calibrateEstimatorFromUsage,
  getCalibratedRatio,
  measureConversationChars,
} from "./token-estimator.js";
import type { Message, Usage } from "@kenkaiiii/gg-ai";

// Use a known model so the chars-per-token ratio is deterministic in tests.
// "claude-sonnet-5" → ratio = 3.2
beforeAll(() => {
  setEstimatorModel("claude-sonnet-5");
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates using model-specific ratio", () => {
    // claude ratio = 3.2
    expect(estimateTokens("abc")).toBe(1); // ceil(3/3.2) = 1
    expect(estimateTokens("abcdefgh")).toBe(3); // ceil(8/3.2) = 3
    expect(estimateTokens("a".repeat(32))).toBe(10); // ceil(32/3.2) = 10
  });

  it("handles long text", () => {
    const text = "a".repeat(1000);
    expect(estimateTokens(text)).toBe(313); // ceil(1000/3.2) = 313
  });
});

describe("estimateMessageTokens", () => {
  it("estimates string content message", () => {
    const msg: Message = { role: "user", content: "Hello world" };
    const tokens = estimateMessageTokens(msg);
    // ceil(11/3.2) = 4 + 4 overhead = 8
    expect(tokens).toBe(8);
  });

  it("includes per-message overhead", () => {
    const msg: Message = { role: "user", content: "" };
    // 0 content + 4 overhead
    expect(estimateMessageTokens(msg)).toBe(4);
  });

  it("estimates text content parts", () => {
    const msg: Message = {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    };
    const tokens = estimateMessageTokens(msg);
    // ceil(5/3.2) = 2 + 4 overhead = 6
    expect(tokens).toBe(6);
  });

  it("estimates tool call parts", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "tc1",
          name: "read_file",
          args: { path: "/foo/bar.ts" },
        },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // name "read_file" = ceil(9/3.2) = 3
    // args JSON '{"path":"/foo/bar.ts"}' = ceil(21/3.2) = 7
    // + 4 overhead = 14
    expect(tokens).toBe(14);
  });

  it("estimates tool result parts", () => {
    const msg: Message = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: "tc1",
          content: "file contents here",
        },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // "file contents here" = ceil(18/3.2) = 6 + 4 overhead = 10
    expect(tokens).toBe(10);
  });

  it("sums multiple content parts", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Here is the result:" },
        { type: "text", text: "Done" },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // ceil(19/3.2) = 6 + ceil(4/3.2) = 2 + 4 overhead = 12
    expect(tokens).toBe(12);
  });
});

describe("estimateConversationTokens", () => {
  it("returns 0 for empty array", () => {
    expect(estimateConversationTokens([])).toBe(0);
  });

  it("sums all message estimates", () => {
    const messages: Message[] = [
      { role: "system", content: "You are helpful." }, // ceil(16/3.2)=5 + 4 = 9
      { role: "user", content: "Hi" }, // ceil(2/3.2)=1 + 4 = 5
    ];
    expect(estimateConversationTokens(messages)).toBe(14);
  });

  it("handles a full conversation with tool calls", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "read foo" },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "read", args: { p: "foo" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "bar" }],
      },
      { role: "assistant", content: "The file contains: bar" },
    ];
    const total = estimateConversationTokens(messages);
    expect(total).toBeGreaterThan(0);
    // Each message has at least 4 overhead tokens
    expect(total).toBeGreaterThanOrEqual(5 * 4);
  });
});

describe("setEstimatorModel", () => {
  it("uses different ratios for different model families", () => {
    const text = "a".repeat(100);

    setEstimatorModel("claude-opus-4-8");
    const claudeTokens = estimateTokens(text); // 100/3.2 = 32

    setEstimatorModel("gpt-4.1");
    const gptTokens = estimateTokens(text); // 100/3.7 = 28

    setEstimatorModel("glm-5.1");
    const glmTokens = estimateTokens(text); // 100/2.5 = 40

    // GLM should estimate MORE tokens (smaller chars/token ratio = more tokens per char)
    expect(glmTokens).toBeGreaterThan(claudeTokens);
    expect(claudeTokens).toBeGreaterThan(gptTokens);

    // Reset for other tests
    setEstimatorModel("claude-sonnet-5");
  });
});

describe("calibrateEstimator", () => {
  function resetCalibration(): void {
    // Model change resets calibration; restore the test model afterwards.
    setEstimatorModel("calibration-reset-sentinel");
    setEstimatorModel("claude-sonnet-5");
  }

  it("starts with no calibrated ratio", () => {
    resetCalibration();
    expect(getCalibratedRatio()).toBeNull();
  });

  it("blends the first observation into the model-family prior", () => {
    resetCalibration();
    calibrateEstimator(350, 100); // prior 3.2 + 0.3*(observed 3.5 - 3.2) = 3.29
    expect(getCalibratedRatio()).toBeCloseTo(3.29, 10);
  });

  it("blends subsequent observations with EMA alpha 0.3", () => {
    resetCalibration();
    calibrateEstimator(350, 100); // ratio = 3.29
    calibrateEstimator(250, 100); // observed 2.5 → 3.29 + 0.3*(2.5-3.29) = 3.053
    expect(getCalibratedRatio()).toBeCloseTo(3.053, 10);
  });

  it("clamps observations to [2.0, 5.0] before blending", () => {
    resetCalibration();
    calibrateEstimator(100, 1000); // observed 0.1 → clamp 2.0; blend from 3.2 → 2.84
    expect(getCalibratedRatio()).toBeCloseTo(2.84, 10);

    resetCalibration();
    calibrateEstimator(10_000, 100); // observed 100 → clamp 5.0; blend from 3.2 → 3.74
    expect(getCalibratedRatio()).toBeCloseTo(3.74, 10);
  });

  it("ignores invalid observations", () => {
    resetCalibration();
    calibrateEstimator(0, 100);
    calibrateEstimator(100, 0);
    calibrateEstimator(-5, 100);
    calibrateEstimator(Number.NaN, 100);
    calibrateEstimator(100, Number.POSITIVE_INFINITY);
    expect(getCalibratedRatio()).toBeNull();
  });

  it("calibrated ratio overrides the model-family ratio in estimateTokens", () => {
    resetCalibration();
    const text = "a".repeat(100);
    expect(estimateTokens(text)).toBe(32); // claude family ratio 3.2
    calibrateEstimator(400, 100); // blended ratio = 3.2 + 0.3*(4.0-3.2) = 3.44
    expect(estimateTokens(text)).toBe(30); // ceil(100/3.44)
  });

  it("model change resets calibration; same model keeps it", () => {
    resetCalibration();
    calibrateEstimator(400, 100);
    expect(getCalibratedRatio()).toBeCloseTo(3.44, 10);

    setEstimatorModel("claude-sonnet-5"); // same model — keep calibration
    expect(getCalibratedRatio()).toBeCloseTo(3.44, 10);

    setEstimatorModel("gpt-4.1"); // different model — reset
    expect(getCalibratedRatio()).toBeNull();
    setEstimatorModel("claude-sonnet-5");
  });
});

describe("measureConversationChars", () => {
  it("counts chars across string, text, tool_call, and tool_result content", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" }, // 3
      { role: "user", content: "hello" }, // 5
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi" }, // 2
          { type: "tool_call", id: "t1", name: "read", args: { p: "x" } }, // 4 + 9 ({"p":"x"})
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "result" }], // 6
      },
    ];
    const { chars, hasMedia } = measureConversationChars(messages);
    expect(chars).toBe(3 + 5 + 2 + 4 + 9 + 6);
    expect(hasMedia).toBe(false);
  });

  it("handles tool args whose toJSON returns undefined", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "t1",
            name: "read",
            args: { toJSON: () => undefined },
          },
        ],
      },
    ];
    expect(measureConversationChars(messages)).toEqual({ chars: 4, hasMedia: false });
  });

  it("flags image and video parts as media", () => {
    const withImage: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mediaType: "image/png", data: "aaaa" },
        ],
      },
    ];
    expect(measureConversationChars(withImage).hasMedia).toBe(true);

    const withVideoResult: Message[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "t1",
            content: [{ type: "video", mediaType: "video/mp4", data: "bbbb" }],
          },
        ],
      },
    ];
    expect(measureConversationChars(withVideoResult).hasMedia).toBe(true);
  });
});

describe("calibrateEstimatorFromUsage", () => {
  function resetCalibration(): void {
    setEstimatorModel("calibration-reset-sentinel");
    setEstimatorModel("claude-sonnet-5");
  }

  it("calibrates from total input usage tokens (uncached + cache)", () => {
    resetCalibration();
    const history: Message[] = [{ role: "user", content: "a".repeat(240) }];
    const usage: Usage = { inputTokens: 40, outputTokens: 20, cacheRead: 30, cacheWrite: 10 };
    calibrateEstimatorFromUsage(history, usage); // observed 3.0, blended from 3.2 → 3.14
    expect(getCalibratedRatio()).toBeCloseTo(3.14, 10);
  });

  it("skips calibration when history contains media", () => {
    resetCalibration();
    const history: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "a".repeat(300) },
          { type: "image", mediaType: "image/png", data: "zzzz" },
        ],
      },
    ];
    calibrateEstimatorFromUsage(history, { inputTokens: 100, outputTokens: 0 });
    expect(getCalibratedRatio()).toBeNull();
  });
});
