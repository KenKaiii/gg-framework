// Single source of truth for the providers the login UI offers and how each
// authenticates. Mirrors the CLI's `ggcoder login` provider list (ui/login.tsx)
// so the desktop app and the terminal stay in lockstep. The app fetches this
// (plus live connection status) from the sidecar's /auth/status endpoint.

import { XIAOMI_CREDITS_KEY } from "@kenkaiiii/gg-core";

export type AuthMethod = "oauth" | "apikey";

/**
 * One API-key option for a provider that splits auth across multiple distinct
 * endpoints/credentials (currently only Xiaomi: Token Plan vs. API Credits).
 * Each variant stores under its own auth.json key so a user can hold both at
 * once — the model registry picks which one a given model resolves via
 * `getAuthStorageKeys()`.
 */
export interface ApiKeyVariant {
  /** Storage key in auth.json (distinct from `value` when multiple variants exist). */
  key: string;
  /** Display label, e.g. "Token Plan" or "API Credits". */
  label: string;
  /** Base URL stored alongside this variant's credential. */
  baseUrl?: string;
}

export interface AuthProviderMeta {
  /** Stable provider id (matches the gg-ai Provider union, plus storage keys). */
  value: string;
  /** Display name shown in the login list. */
  label: string;
  /** One-line model summary. */
  description: string;
  /** Supported auth methods, in preferred order (oauth first when both). */
  methods: AuthMethod[];
  /** Friendly label for the API key field (e.g. "Z.AI"). */
  apiKeyLabel?: string;
  /** Fixed base URL stored alongside an API key (e.g. Xiaomi's token plan). */
  apiKeyBaseUrl?: string;
  /**
   * When a provider's API-key auth splits across multiple endpoints, the
   * choices to present (in order). The first variant is the default. Absent
   * for every provider with a single API-key credential.
   */
  apiKeyVariants?: ApiKeyVariant[];
}

export const AUTH_PROVIDERS: AuthProviderMeta[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    description: "Claude Fable 5, Opus 4.8, Sonnet 5, Haiku 4.5",
    methods: ["oauth"],
  },
  {
    value: "openai",
    label: "OpenAI",
    description: "GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5",
    methods: ["oauth"],
  },
  {
    value: "gemini",
    label: "Gemini",
    description: "Gemini 3.1 Flash Lite, Gemini 3.5 Flash, Gemini 3.1 Pro (Preview)",
    methods: ["oauth"],
  },
  {
    value: "moonshot",
    label: "Moonshot",
    description: "Kimi K3, K2.7 Code · OAuth or API key",
    methods: ["oauth", "apikey"],
    apiKeyLabel: "Moonshot",
  },
  {
    value: "glm",
    label: "Z.AI (GLM)",
    description: "GLM-5.2, GLM-5.1, GLM-4.7, GLM-4.7 Flash",
    methods: ["apikey"],
    apiKeyLabel: "Z.AI",
  },
  {
    value: "minimax",
    label: "MiniMax",
    description: "MiniMax M3",
    methods: ["apikey"],
    apiKeyLabel: "MiniMax",
  },
  {
    value: "xiaomi",
    label: "Xiaomi (MiMo)",
    description: "MiMo-V2.5-Pro, MiMo-V2.5-Pro-UltraSpeed, MiMo-V2.5 · Token Plan or API Credits",
    methods: ["apikey"],
    apiKeyLabel: "Xiaomi MiMo",
    apiKeyBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    apiKeyVariants: [
      {
        key: "xiaomi",
        label: "Token Plan",
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      },
      {
        key: XIAOMI_CREDITS_KEY,
        label: "API Credits (required for UltraSpeed)",
        baseUrl: "https://api.xiaomimimo.com/v1",
      },
    ],
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek V4 Pro, V4 Flash",
    methods: ["apikey"],
    apiKeyLabel: "DeepSeek",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "Multi-provider gateway",
    methods: ["apikey"],
    apiKeyLabel: "OpenRouter",
  },
  {
    value: "sakana",
    label: "Sakana (Fugu)",
    description: "Fugu, Fugu Ultra",
    methods: ["apikey"],
    apiKeyLabel: "Sakana",
  },
];

export function getAuthProvider(value: string): AuthProviderMeta | undefined {
  return AUTH_PROVIDERS.find((p) => p.value === value);
}
