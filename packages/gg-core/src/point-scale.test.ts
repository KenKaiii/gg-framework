import { describe, expect, it } from "vitest";
import { pointScale } from "./point-scale.js";

describe("pointScale", () => {
  it.each([
    "qwen3-vl:8b",
    "local/ollama/qwen3-vl:30b-a3b-instruct-q4_K_M",
    "local/lmstudio/qwen/qwen3-vl-32b",
    "qwen/qwen3-vl-235b-a22b-instruct",
    "Qwen/Qwen3-VL-8B-Instruct",
    "local/custom/unsloth/Qwen3_VL-4B-GGUF",
    "qwen3.5:27b",
    "local/ollama/qwen3.5:35b-a3b",
    "qwen/qwen3.5-397b-a17b",
    "local/vllm/Qwen/Qwen3.6-35B-A3B",
    "local/lmstudio/qwen3_5-9b",
    "local/ollama/huihui_ai/qwen3.5-abliterated:9b",
  ])("answers on a 0–1000 grid for %s", (id) => {
    expect(pointScale(id)).toBe("norm1000");
  });

  it.each([
    "claude-opus-5-5",
    "gpt-6.2-sol",
    "gemini-3.8-flash",
    "qwen2.5vl:7b",
    "local/ollama/qwen2.5-vl:32b",
    "qwen3:8b",
    "local/ollama/qwen3:30b-a3b",
    "qwen3-coder:30b",
    "qwen/qwen3-235b-a22b",
    "local/lmstudio/qwen3-32b",
    "local/ollama/gemma3:27b",
    "local/ollama/llama3.2-vision:11b",
  ])("answers in pixels for %s", (id) => {
    expect(pointScale(id)).toBe("pixels");
  });
});
