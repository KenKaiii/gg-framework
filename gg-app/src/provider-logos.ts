/**
 * Provider id → bundled logo asset. Keys match `AuthProviderMeta.value` in
 * ggcoder's `core/auth-providers.ts` (the sidecar's /auth/status payload).
 *
 * Marks are official brand assets, normalized for the dark theme: monochrome
 * marks (OpenAI, xAI, Kimi) render in off-white, Anthropic in brand clay, the
 * rest keep their brand color. Sakana's red fish is a PNG crop of its site
 * logo (no official SVG exists).
 */
import anthropic from "./assets/providers/anthropic.svg";
import openai from "./assets/providers/openai.svg";
import gemini from "./assets/providers/gemini.svg";
import xai from "./assets/providers/xai.svg";
import moonshot from "./assets/providers/moonshot.svg";
import glm from "./assets/providers/glm.svg";
import minimax from "./assets/providers/minimax.svg";
import xiaomi from "./assets/providers/xiaomi.svg";
import deepseek from "./assets/providers/deepseek.svg";
import sakana from "./assets/providers/sakana.png";
import openrouter from "./assets/providers/openrouter.svg";

export const PROVIDER_LOGOS: Record<string, string> = {
  anthropic,
  openai,
  gemini,
  xai,
  moonshot,
  glm,
  minimax,
  xiaomi,
  deepseek,
  sakana,
  openrouter,
};

export function providerLogo(value: string): string | undefined {
  return PROVIDER_LOGOS[value];
}
