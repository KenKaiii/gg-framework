/** User setting for an OpenAI request-shape option: `auto` (fast) or forced on/off. */
export type CodexShapeSetting = "auto" | "on" | "off";

/**
 * `auto` picks the fast shape on every OpenAI model: no strict tool schemas.
 * Strict schemas make every call carry each optional field as null; without
 * them requests finished ~0.6–1s sooner on gpt-6-astra, gpt-6.1-sol and
 * gpt-6-luna. `on` restores strict schemas.
 */
function resolve(setting: CodexShapeSetting, applies: boolean): boolean | undefined {
  if (!applies) return undefined;
  return setting === "on";
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
