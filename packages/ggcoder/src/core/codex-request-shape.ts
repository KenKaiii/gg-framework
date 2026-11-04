import { usesResponsesLite } from "@kleio/ai";

/** User setting for an OpenAI request-shape option: `auto` (fast) or forced on/off. */
export type CodexShapeSetting = "auto" | "on" | "off";

/**
 * `auto` picks the fast shape on every OpenAI model: no Responses-Lite and no
 * strict tool schemas (measured in a head-to-head against the pi agent).
 * - Lite caps a response at one tool call. Without it, gpt-6-astra,
 *   gpt-6.1-sol and gpt-6-luna each put 3 independent reads in one response
 *   instead of 1, and the Astra h2h suite finished 8% faster, no lost passes.
 * - Strict schemas make every call carry each optional field as null; without
 *   them requests finished ~0.6–1s sooner on all three models.
 * `on` restores the previous (Codex CLI) behaviour.
 */
function resolve(setting: CodexShapeSetting, applies: boolean): boolean | undefined {
  if (!applies) return undefined;
  return setting === "on";
}

/**
 * The `responsesLite` stream option for this route, or undefined where the
 * model never uses lite (the provider ignores it there).
 */
export function resolveResponsesLite(
  setting: CodexShapeSetting,
  provider: string,
  model: string,
): boolean | undefined {
  return resolve(setting, provider === "openai" && usesResponsesLite(model));
}

/**
 * The `strictTools` stream option for this route, or undefined off OpenAI
 * (other providers never send strict schemas).
 */
export function resolveStrictTools(
  setting: CodexShapeSetting,
  provider: string,
): boolean | undefined {
  return resolve(setting, provider === "openai");
}
