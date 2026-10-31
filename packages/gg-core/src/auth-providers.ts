// Single source of truth for the providers the login UI offers and how each
// authenticates. Mirrors the CLI's `ggcoder login` provider list (ggcoder ui/login.tsx)
// so the desktop app and the terminal stay in lockstep. The app fetches this
// (plus live connection status) from the sidecar's /auth/status endpoint.

import {
  GEMINI_API_KEY,
  GEMINI_API_KEY_BASE_URL,
  XIAOMI_CREDITS_KEY,
  dualAuthProvider,
} from "./auth-storage.js";
import { isHiddenProvider } from "./hidden-providers.js";

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
   * When true, the API-key form offers an optional base-URL override so the
   * provider can be pointed at a compatible gateway/proxy instead of the
   * vendor's own endpoint. Leaving it empty keeps `apiKeyBaseUrl` (or the
   * transport default in gg-ai); the override is stored only when typed.
   */
  allowCustomBaseUrl?: boolean;
  /**
   * When a provider's API-key auth splits across multiple endpoints, the
   * choices to present (in order). The first variant is the default. Absent
   * for every provider with a single API-key credential.
   */
  apiKeyVariants?: ApiKeyVariant[];
  /**
   * Per-method guidance overrides. Only providers whose methods differ in
   * billing/entitlement (the dual-auth ones) need these; everything else is
   * described generically by {@link describeAuthMethods}.
   */
  methodDetails?: Partial<Record<AuthMethod, AuthMethodMeta>>;
}

/**
 * What one auth method means for a provider, so both UIs can answer "which do I
 * pick?" without hardcoding provider knowledge in a component.
 */
export interface AuthMethodMeta {
  method: AuthMethod;
  /** Button/row label, e.g. "Sign in with Grok (SuperGrok / X Premium)". */
  label: string;
  /** What the user spends on this method. */
  billing: string;
  /** When to choose it. */
  when: string;
  /** Prerequisite the user must already have, if any. */
  requires?: string;
}

/**
 * Every provider a user can connect, in login-screen order. `description`
 * lists that provider's models and feeds both the CLI login screen and the
 * app's provider list, so `auth-providers.test.ts` pins each one to the model
 * registry — a registry change that isn't reflected here fails the suite.
 * Hidden providers (see `hidden-providers.ts`) keep their row here but are
 * left out of the exported list.
 */
const ALL_AUTH_PROVIDERS: AuthProviderMeta[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    description: "Claude Fable 5.1, Opus 5.5, Opus 5.5 Fast, Sonnet 5.5, Haiku 5.5",
    methods: ["oauth"],
  },
  {
    value: "openai",
    label: "OpenAI",
    description:
      "GPT-6 Astra, GPT-6 Astra Fast, GPT-6.1 Sol, GPT-6.1 Sol Fast, GPT-6 Luna, GPT-6 Luna Fast",
    methods: ["oauth"],
  },
  {
    value: "gemini",
    label: "Gemini",
    description: "Gemini 3.8 Flash, 3.5 Flash Lite, 3.1 Flash Lite, 3.5 Flash, 3.1 Pro (Preview)",
    methods: ["oauth", "apikey"],
    apiKeyLabel: "Gemini",
    apiKeyBaseUrl: GEMINI_API_KEY_BASE_URL,
    // Stored under its own key so it never overwrites the `gemini` OAuth login.
    apiKeyVariants: [
      { key: GEMINI_API_KEY, label: "Google AI Studio", baseUrl: GEMINI_API_KEY_BASE_URL },
    ],
    methodDetails: {
      oauth: {
        method: "oauth",
        label: "Sign in with Google",
        billing: "Gemini Code Assist Standard or Enterprise licence.",
        when: "Personal Google accounts are no longer served here (Google ended it on June 18, 2026).",
      },
      apikey: {
        method: "apikey",
        label: "Gemini API key",
        billing: "Pay-per-token from a Google AI Studio key.",
        when: "Used first whenever it is set.",
      },
    },
  },
  {
    value: "xai",
    label: "xAI (Grok)",
    description: "Grok 4.7 · OAuth or API key",
    methods: ["oauth", "apikey"],
    apiKeyLabel: "xAI",
    methodDetails: {
      oauth: {
        method: "oauth",
        label: "Sign in with Grok",
        billing: "Included with SuperGrok or X Premium.",
        when: "",
      },
      apikey: {
        method: "apikey",
        label: "xAI API key",
        billing: "Pay-per-token on console.x.ai credits.",
        when: "",
      },
    },
  },
  {
    value: "moonshot",
    label: "Moonshot",
    description:
      "Kimi K3, K2.8 Preview (Kimi sign-in), K2.7 Code, K2.7 Code HighSpeed · OAuth or API key",
    methods: ["oauth", "apikey"],
    apiKeyLabel: "Moonshot",
    methodDetails: {
      oauth: {
        method: "oauth",
        label: "Sign in with Kimi",
        billing: "Included with a Kimi For Coding plan.",
        when: "",
      },
      apikey: {
        method: "apikey",
        label: "Moonshot API key",
        billing: "Pay-per-token on Moonshot credits.",
        when: "",
      },
    },
  },
  {
    value: "glm",
    label: "Z.AI (GLM)",
    description: "GLM-5.3, GLM-5.3-Flash",
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
    description:
      "MiMo-V2.6-Pro, MiMo-V2.6-Flash, MiMo-V2.6-Pro-UltraSpeed · Token Plan or API Credits",
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
    description: "DeepSeek V4 Pro, V4.1 Flash",
    methods: ["apikey"],
    apiKeyLabel: "DeepSeek",
  },
  {
    value: "sakana",
    label: "Sakana (Fugu)",
    description: "Fugu, Fugu Max, Fugu Ultra",
    methods: ["apikey"],
    apiKeyLabel: "Sakana",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "Qwen3.8 Max · multi-provider gateway",
    methods: ["apikey"],
    apiKeyLabel: "OpenRouter",
    apiKeyBaseUrl: "https://openrouter.ai/api/v1",
    allowCustomBaseUrl: true,
  },
  {
    value: "huggingface",
    label: "Hugging Face",
    description: "Kimi K2.7 Code, DeepSeek V4.1 Flash, GPT-OSS 120B",
    methods: ["apikey"],
    apiKeyLabel: "Hugging Face",
  },
];

/** Every provider a user can connect right now, in login-screen order. */
export const AUTH_PROVIDERS: AuthProviderMeta[] = ALL_AUTH_PROVIDERS.filter(
  (p) => !isHiddenProvider(p.value),
);

export function getAuthProvider(value: string): AuthProviderMeta | undefined {
  return AUTH_PROVIDERS.find((p) => p.value === value);
}

/**
 * Per-method guidance for a provider, in resolution order. Providers with a
 * single method get a generic description; the dual-auth ones (Kimi, Grok) carry
 * explicit `methodDetails` because the choice changes what the user is billed.
 */
export function describeAuthMethods(provider: string): AuthMethodMeta[] {
  const meta = getAuthProvider(provider);
  if (!meta) return [];
  return meta.methods.map((method) => {
    const override = meta.methodDetails?.[method];
    // Copy rather than hand back the table entry itself: callers serialize this
    // alongside the provider meta, and a shared reference appearing twice in one
    // payload trips the sidecar's cycle-safe JSON encoder ([CIRCULAR]).
    if (override) return { ...override };
    return method === "oauth"
      ? {
          method,
          label: `Sign in with ${meta.label}`,
          billing: "Uses your existing plan with this provider.",
          when: "",
        }
      : {
          method,
          label: `${meta.apiKeyLabel ?? meta.label} API key`,
          billing: "Pay-per-token on this provider's API credits.",
          when: "",
        };
  });
}

/**
 * How the runtime picks between two connected methods, phrased for the UI. Only
 * dual-auth providers have a choice to explain; everything else returns
 * undefined so callers can omit the note entirely.
 *
 * Keep this wording in sync with AuthStorage's actual resolution order in
 * gg-core (`DUAL_AUTH_PROVIDERS`) — it is the user-facing description of it.
 */
export function authPriorityNote(provider: string): string | undefined {
  // Gemini resolves the other way round (model registry `authStorageKeys`):
  // Code Assist OAuth refuses personal accounts, so a key the user added wins.
  if (provider === "gemini") {
    return "Uses the Gemini API key first when one is set; otherwise the Google sign-in.";
  }
  const dual = dualAuthProvider(provider);
  if (!dual) return undefined;
  return `Uses ${dual.oauthLabel} first; the ${dual.apiKeyLabel} takes over when it runs out, then switches back.`;
}
