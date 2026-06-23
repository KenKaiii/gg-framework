// Single source of truth for the providers the login UI offers and how each
// authenticates. Mirrors the CLI's `ggcoder login` provider list (ui/login.tsx)
// so the desktop app and the terminal stay in lockstep. The app fetches this
// (plus live connection status) from the sidecar's /auth/status endpoint.

export type AuthMethod = "oauth" | "apikey";

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
}

export const AUTH_PROVIDERS: AuthProviderMeta[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    description: "Claude Opus 4.8, Sonnet 4.6, Haiku 4.5",
    methods: ["oauth"],
  },
  {
    value: "openai",
    label: "OpenAI",
    description: "GPT-5.5, GPT-5.5 Pro, GPT-5.4, GPT-5.3 Codex",
    methods: ["oauth"],
  },
  {
    value: "gemini",
    label: "Gemini",
    description: "Gemini 3.1 Flash Lite Preview",
    methods: ["oauth"],
  },
  {
    value: "moonshot",
    label: "Moonshot",
    description: "Kimi K2.7 · OAuth or API key",
    methods: ["oauth", "apikey"],
    apiKeyLabel: "Moonshot",
  },
  {
    value: "glm",
    label: "Z.AI (GLM)",
    description: "GLM-5.1, GLM-4.7, GLM-4.7 Flash",
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
    description: "MiMo-V2-Pro",
    methods: ["apikey"],
    apiKeyLabel: "Xiaomi MiMo",
    apiKeyBaseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
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
    description: "Qwen3.6-Plus, multi-provider gateway",
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
