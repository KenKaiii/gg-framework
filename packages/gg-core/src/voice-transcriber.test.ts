import { describe, it, expect } from "vitest";
import { resample, downmixToMono, decodeOggOpus } from "./voice-transcriber.js";

// ── resample ────────────────────────────────────────────────

describe("resample", () => {
  it("returns the same array when rates match", () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    const result = resample(input, 16000, 16000);
    expect(result).toBe(input); // same reference
  });

  it("downsamples 48kHz → 16kHz (3:1 ratio)", () => {
    // 9 samples at 48kHz → 3 samples at 16kHz
    const input = new Float32Array([0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const result = resample(input, 48000, 16000);
    expect(result.length).toBe(3);
    expect(result[0]).toBeCloseTo(0.0, 5);
    expect(result[1]).toBeCloseTo(0.3, 5);
    expect(result[2]).toBeCloseTo(0.6, 5);
  });

  it("upsamples 16kHz → 48kHz (1:3 ratio)", () => {
    const input = new Float32Array([0.0, 0.6, 1.2]);
    const result = resample(input, 16000, 48000);
    expect(result.length).toBe(9);
    expect(result[0]).toBeCloseTo(0.0, 5);
    expect(result[1]).toBeCloseTo(0.2, 1);
    expect(result[2]).toBeCloseTo(0.4, 1);
    expect(result[3]).toBeCloseTo(0.6, 1);
  });

  it("handles single sample", () => {
    const input = new Float32Array([0.5]);
    const result = resample(input, 48000, 16000);
    expect(result.length).toBeLessThanOrEqual(1);
  });

  it("handles empty array", () => {
    const input = new Float32Array([]);
    const result = resample(input, 48000, 16000);
    expect(result.length).toBe(0);
  });

  it("preserves signal energy approximately", () => {
    const numSamples = 4800; // 100ms at 48kHz
    const freq = 440;
    const input = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      input[i] = Math.sin((2 * Math.PI * freq * i) / 48000);
    }

    const output = resample(input, 48000, 16000);
    expect(output.length).toBe(1600);

    const rmsIn = Math.sqrt(input.reduce((sum, v) => sum + v * v, 0) / input.length);
    const rmsOut = Math.sqrt(output.reduce((sum, v) => sum + v * v, 0) / output.length);
    expect(rmsOut).toBeCloseTo(rmsIn, 1);
  });
});

// ── downmixToMono ───────────────────────────────────────────

describe("downmixToMono", () => {
  it("returns empty array for no channels", () => {
    const result = downmixToMono([]);
    expect(result.length).toBe(0);
  });

  it("returns the channel directly for mono input", () => {
    const mono = new Float32Array([0.1, 0.2, 0.3]);
    const result = downmixToMono([mono]);
    expect(result).toBe(mono); // same reference
  });

  it("averages two channels for stereo input", () => {
    const left = new Float32Array([0.0, 0.4, 0.8]);
    const right = new Float32Array([1.0, 0.6, 0.2]);
    const result = downmixToMono([left, right]);
    expect(result.length).toBe(3);
    expect(result[0]).toBeCloseTo(0.5, 5);
    expect(result[1]).toBeCloseTo(0.5, 5);
    expect(result[2]).toBeCloseTo(0.5, 5);
  });

  it("handles multi-channel (5.1 surround)", () => {
    const channels = Array.from({ length: 6 }, () => new Float32Array([0.6]));
    const result = downmixToMono(channels);
    expect(result.length).toBe(1);
    expect(result[0]).toBeCloseTo(0.6, 5);
  });
});

// ── decodeOggOpus ───────────────────────────────────────────

describe("decodeOggOpus", () => {
  it("rejects invalid data", async () => {
    const garbage = new Uint8Array([0, 1, 2, 3, 4, 5]);
    await expect(decodeOggOpus(garbage)).rejects.toThrow();
  });
});

// Integration tests for transcribeVoice require network access and ~75MB model download.
// Run the standalone e2e test instead: node test-voice.mjs
