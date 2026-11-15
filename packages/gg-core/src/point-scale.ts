/** How a vision model writes screen coordinates when asked to point at something. */
export type PointScale = "pixels" | "norm1000";

// Qwen3-VL and the natively multimodal Qwen3.5/3.6 were trained to answer on a 0–1000 grid
// whatever the image size; Qwen2.5-VL used real pixels, so it stays out.
const NORM1000_PATTERN = /qwen3[-_.]?vl|qwen3[._]?[56](?![\d])/i;

/**
 * The coordinate scale a model answers in, from its id. Works on bare ids (`qwen3-vl:8b`),
 * local ids (`local/lmstudio/qwen/qwen3.5-27b`) and OpenRouter ids (`qwen/qwen3-vl-32b-instruct`).
 */
export function pointScale(modelId: string): PointScale {
  return NORM1000_PATTERN.test(modelId) ? "norm1000" : "pixels";
}
