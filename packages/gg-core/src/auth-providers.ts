// Single source of truth for the providers the login UI offers and how each
// authenticates. Mirrors the CLI's `ggcoder login` provider list (ggcoder ui/login.tsx)
// so the desktop app and the terminal stay in lockstep. The app fetches this
// (plus live connection status) from the sidecar's /auth/status endpoint.

import {
  GEMINI_API_KEY,
  GEMINI_API_KEY_BASE_URL,
  KIMI_CODE_KEY,
  XIAOMI_CREDITS_KEY,
  dualAuthProvider,
} from "./auth-storage.js";
import { isHiddenProvider } from "./hidden-providers.js";

export type AuthMethod = "oauth" | "apikey";

/**
 * One API-key option for a provider that takes two kinds of key: a plan key
 * (the user's subscription) and a pay-per-token key. Each variant stores under
 * its own auth.json key so a user can hold both at once; the model registry
 * picks which one a model resolves via `getAuthStorageKeys()`.
 */
export interface ApiKeyVariant {
  /** Storage key in auth.json (distinct from `value` when multiple variants exist). */
  key: string;
  /** Display label, e.g. "Token Plan" or "API Credits". */
  label: string;
  /** `plan` bills the user's subscription; `payg` bills per token. */
  kind: "plan" | "payg";
  /** What the user spends with this key, e.g. "Uses your Kimi Code plan." */
  billing: string;
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
   * When a provider takes both a plan key and a pay-per-token key, the choices
   * to present (in order). The first variant is the default.
   */
  apiKeyVariants?: ApiKeyVariant[];
  /** What each method means for this provider (billing, when to pick it). */
  methodDetails: Partial<Record<AuthMethod, AuthMethodMeta>>;
}

/**
 * What one auth method means for a provider, so both UIs can answer "which do I
 * pick?" without hardcoding provider knowledge in a component.
 */
export interface AuthMethodMeta {
  method: AuthMethod;
  /** Button/row label, e.g. "Continue with ChatGPT". */
  label: string;
  /** What the user spends on this method. */
  billing: string;
  /** When to choose it. */
  when: string;
  /** Prerequisite the user must already have, if any. */
  requires?: string;
}

function apiKeyDetails(
  label: string,
  billing: string,
  when = "",
): Partial<Record<AuthMethod, AuthMethodMeta>> {
  return { apikey: { method: "apikey", label, billing, when } };
}

/**
 * Every provider a user can connect, in login-screen order. Each one connects
 * only in a way its owner allows: `oauth` is a real sign-in (Claude, ChatGPT),
 * and a plan that works with a pasted key is an `apikey` variant marked `plan`.
 * `description` lists that provider's models and feeds both the CLI login
 * screen and the app's provider list, so `auth-providers.test.ts` pins each one
 * to the model registry. Mirrored in gg-app/src-tauri/src/auth.rs.
 */
const ALL_AUTH_PROVIDERS: AuthProviderMeta[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    description: "Claude Fable 5.1, Opus 5.5, Opus 5.5 Fast, Sonnet 5.5, Haiku 5.5",
    methods: ["oauth", "apikey"],
    apiKeyLabel: "Anthropic",
    methodDetails: {
      oauth: {
        method: "oauth",
        label: "Sign in with Claude",
        billing: "Uses your Claude Pro or Max plan.",
        when: "Runs through Anthropic's Claude Code, which GG Coder downloads once (about 140 MB) the first time you pick this.",
        requires: "A Claude Pro or Max subscription.",
      },
      apikey: {
        method: "apikey",
        label: "Anthropic API key",
        billing: "Pay-per-token from an Anthropic Console key.",
        when: "No subscription needed. Used only while you are not signed in with Claude.",
      },
    },
  },
  {
    value: "openai",
    label: "OpenAI",
    description:
      "GPT-6 Astra, GPT-6 Astra Fast, GPT-6.1 Sol, GPT-6.1 Sol Fast, GPT-6.1 Terra, GPT-6.1 Terra Fast, GPT-6 Luna, GPT-6 Luna Fast",
    methods: ["oauth", "apikey"],
    apiKeyLabel: "OpenAI",
    methodDetails: {
      oauth: {
        method: "oauth",
        label: "Continue with ChatGPT",
        billing: "Uses your ChatGPT plan.",
        when: "Signs in through OpenAI. Manage what GG Coder may use at chatgpt.com/settings/usage.",
        requires: "A ChatGPT plan.",
      },
      apikey: {
        method: "apikey",
        label: "OpenAI API key",
        billing: "Pay-per-token from an OpenAI Platform key.",
        when: "No subscription needed. Covers you while your ChatGPT plan's usage is out.",
      },
    },
  },
  {
    value: "gemini",
    label: "Gemini",
    description: "Gemini 3.8 Flash, 3.5 Flash Lite, 3.1 Flash Lite, 3.5 Flash, 3.1 Pro (Preview)",
    methods: ["apikey"],
    apiKeyLabel: "Gemini",
    apiKeyBaseUrl: GEMINI_API_KEY_BASE_URL,
    // Stored under its own key: `gemini` held the retired Google sign-in.
    apiKeyVariants: [
      {
        key: GEMINI_API_KEY,
        label: "Google AI Studio",
        kind: "payg",
        billing: "Pay-per-token from a Google AI Studio key.",
        baseUrl: GEMINI_API_KEY_BASE_URL,
      },
    ],
    methodDetails: apiKeyDetails("Gemini API key", "Pay-per-token from a Google AI Studio key."),
  },
  {
    value: "xai",
    label: "xAI (Grok)",
    description: "Grok 4.7",
    methods: ["apikey"],
    apiKeyLabel: "xAI",
    methodDetails: apiKeyDetails(
      "xAI API key",
      "Pay-per-token from console.x.ai credits.",
      "SuperGrok and X Premium usage is only offered in apps xAI partners with.",
    ),
  },
  {
    value: "moonshot",
    label: "Kimi (Moonshot)",
    description: "Kimi K3, K2.8 Preview (Kimi Code plan), K2.7 Code, K2.7 Code HighSpeed",
    methods: ["apikey"],
    apiKeyLabel: "Kimi",
    apiKeyVariants: [
      {
        key: KIMI_CODE_KEY,
        label: "Kimi Code plan",
        kind: "plan",
        billing: "Uses your Kimi Code plan. Create the key in the Kimi Code Console.",
      },
      {
        key: "moonshot",
        label: "Moonshot API",
        kind: "payg",
        billing: "Pay-per-token from platform.moonshot.ai.",
      },
    ],
    methodDetails: apiKeyDetails(
      "Kimi API key",
      "A Kimi Code plan key uses your plan; a Moonshot key is pay-per-token.",
    ),
  },
  {
    value: "glm",
    label: "Z.AI (GLM)",
    description: "GLM-5.3, GLM-5.3-Flash",
    methods: ["apikey"],
    apiKeyLabel: "Z.AI",
    methodDetails: apiKeyDetails(
      "Z.AI API key",
      "Pay-per-token from your Z.AI account balance.",
      "GLM Coding Plan quota can't be used here: Z.AI limits the plan to the tools it lists.",
    ),
  },
  {
    value: "minimax",
    label: "MiniMax",
    description: "MiniMax M3.1 Flash, M3",
    methods: ["apikey"],
    apiKeyLabel: "MiniMax",
    methodDetails: apiKeyDetails(
      "MiniMax API key",
      "An M Plan key uses your plan; a pay-as-you-go key is pay-per-token.",
      "The key you paste decides which one is billed.",
    ),
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
        kind: "plan",
        billing: "Uses your MiMo Token Plan.",
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      },
      {
        key: XIAOMI_CREDITS_KEY,
        label: "API Credits",
        kind: "payg",
        billing: "Pay-per-token from MiMo API Credits. Required for UltraSpeed.",
        baseUrl: "https://api.xiaomimimo.com/v1",
      },
    ],
    methodDetails: apiKeyDetails(
      "Xiaomi MiMo API key",
      "A Token Plan key uses your plan; an API Credits key is pay-per-token.",
    ),
  },
  {
    value: "deepseek",
    label: "DeepSeek",
    description: "DeepSeek V4 Pro, V4.1 Flash",
    methods: ["apikey"],
    apiKeyLabel: "DeepSeek",
    methodDetails: apiKeyDetails("DeepSeek API key", "Pay-per-token from platform.deepseek.com."),
  },
  {
    value: "sakana",
    label: "Sakana (Fugu)",
    description: "Fugu, Fugu Max, Fugu Ultra",
    methods: ["apikey"],
    apiKeyLabel: "Sakana",
    methodDetails: apiKeyDetails("Sakana API key", "Pay-per-token from your Sakana API account."),
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    description: "Qwen3.8 Max · multi-provider gateway",
    methods: ["apikey"],
    apiKeyLabel: "OpenRouter",
    methodDetails: apiKeyDetails("OpenRouter API key", "Pay-per-token from OpenRouter credits."),
  },
  {
    value: "huggingface",
    label: "Hugging Face",
    description: "Kimi K2.7 Code, DeepSeek V4.1 Flash, GPT-OSS 120B",
    methods: ["apikey"],
    apiKeyLabel: "Hugging Face",
    methodDetails: apiKeyDetails(
      "Hugging Face token",
      "Pay-per-token from Hugging Face Inference Providers credits.",
    ),
  },
  {
    // Via Hermes Agent's subscription proxy — the Portal issues no keys.
    value: "nous",
    label: "Hermes Nous Portal",
    description: "GLM 5.3, DeepSeek V4.1 Flash · every model on your Nous Portal plan",
    methods: ["oauth"],
    methodDetails: {
      oauth: {
        method: "oauth",
        label: "Sign in with Hermes",
        billing: "Uses your Nous Portal subscription.",
        when: "Runs through Hermes Agent's subscription proxy, which GG Coder starts for you. Hermes keeps the Portal sign-in.",
        requires: "Hermes Agent installed, and a Nous Portal subscription.",
      },
    },
  },
];

/**
 * What a model needs when it runs only on some of its provider's keys (Kimi
 * K2.8 Preview on a Kimi Code plan key, MiMo UltraSpeed on API Credits), named
 * by the variants' labels. Undefined for a model any of the provider's keys runs.
 */
export function requiredKeyLabel(provider: string, storageKeys: string[]): string | undefined {
  const variants = ALL_AUTH_PROVIDERS.find((p) => p.value === provider)?.apiKeyVariants ?? [];
  const needed = variants.filter((v) => storageKeys.includes(v.key));
  if (needed.length === 0 || needed.length === variants.length) return undefined;
  const names = needed.map((v) => v.label).join(" or ");
  return `Needs ${/^[aeiou]/i.test(names) ? "an" : "a"} ${names} key`;
}

/** Every provider a user can connect right now, in login-screen order. */
export const AUTH_PROVIDERS: AuthProviderMeta[] = ALL_AUTH_PROVIDERS.filter(
  (p) => !isHiddenProvider(p.value),
);

export function getAuthProvider(value: string): AuthProviderMeta | undefined {
  return AUTH_PROVIDERS.find((p) => p.value === value);
}

/**
 * Per-method guidance for a provider, in resolution order. Every provider
 * carries `methodDetails`; the generic fallback only covers a missing entry.
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
  if (provider === "anthropic") {
    return "Uses Sign in with Claude while you are signed in; otherwise the Anthropic API key.";
  }
  const dual = dualAuthProvider(provider);
  if (dual) {
    return `Uses your ${dual.oauthLabel} first; the ${dual.apiKeyLabel} takes over while its usage is out, then switches back.`;
  }
  const variants = getAuthProvider(provider)?.apiKeyVariants;
  const plan = variants?.find((v) => v.kind === "plan");
  const payg = variants?.find((v) => v.kind === "payg");
  if (plan && payg) {
    return `Uses the ${plan.label} key first when both are set; the ${payg.label} key covers models the plan doesn't include.`;
  }
  return undefined;
}
