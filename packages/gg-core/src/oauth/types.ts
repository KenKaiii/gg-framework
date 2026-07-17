export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms timestamp
  accountId?: string; // OpenAI chatgpt_account_id from JWT
  projectId?: string; // Google Cloud/Code Assist project ID for Gemini OAuth
  baseUrl?: string; // Custom API base URL (e.g. Xiaomi token plan endpoint)
  /** ms timestamp until which this credential's usage window is exhausted.
   *  Set by AuthStorage.markUsageExhausted() when the provider rejects with a
   *  usage/quota stop; while in the future, resolution may skip this credential
   *  in favor of a configured fallback (e.g. Kimi OAuth → Moonshot API key). */
  usageExhaustedUntil?: number;
}

export interface OAuthLoginCallbacks {
  onOpenUrl: (url: string) => void;
  onPromptCode: (message: string) => Promise<string>;
  onStatus: (message: string) => void;
}
