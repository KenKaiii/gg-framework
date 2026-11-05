/**
 * How the AI Providers page groups providers: by where the lab is based, with
 * gateways (many labs' models behind one key) on their own. Keys match
 * `AuthProviderMeta.value`. A provider missing here lands in "Other" rather
 * than disappearing, so a new provider shows up before this table learns it.
 */
export type ProviderGroupId = "us" | "cn" | "jp" | "gw" | "other";

export interface ProviderGroupMeta {
  readonly id: ProviderGroupId;
  readonly name: string;
  /** Wide windows put the groups in two banks either side of the brain. */
  readonly bank: "left" | "right";
}

export const PROVIDER_GROUPS: readonly ProviderGroupMeta[] = [
  { id: "us", name: "United States", bank: "left" },
  { id: "cn", name: "China", bank: "right" },
  { id: "jp", name: "Japan", bank: "left" },
  { id: "gw", name: "Gateways", bank: "left" },
  { id: "other", name: "Other", bank: "left" },
];

const COUNTRY: Record<string, ProviderGroupId> = {
  anthropic: "us",
  openai: "us",
  gemini: "us",
  xai: "us",
  moonshot: "cn",
  glm: "cn",
  minimax: "cn",
  xiaomi: "cn",
  deepseek: "cn",
  sakana: "jp",
  openrouter: "gw",
  huggingface: "gw",
};

export function providerGroupOf(value: string): ProviderGroupId {
  return COUNTRY[value] ?? "other";
}

/** The non-empty groups in display order, each keeping the providers' own order. */
export function groupProviders<T extends { value: string }>(
  providers: readonly T[],
): { group: ProviderGroupMeta; providers: T[] }[] {
  return PROVIDER_GROUPS.map((group) => ({
    group,
    providers: providers.filter((p) => providerGroupOf(p.value) === group.id),
  })).filter((g) => g.providers.length > 0);
}

/**
 * The brain's upgrade step (0..5) for `connected` of `total`: denser, brighter,
 * ringed and faster at each step; the top step only once every provider is in.
 */
export function brainTier(connected: number, total: number): number {
  if (total > 0 && connected >= total) return 5;
  if (connected >= 7) return 4;
  if (connected >= 4) return 3;
  if (connected >= 2) return 2;
  return connected >= 1 ? 1 : 0;
}
