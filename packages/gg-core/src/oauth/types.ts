export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms timestamp
  /** Original token lifetime in seconds (the provider's `expires_in`). Used to
   *  scale the proactive-refresh threshold: short-lived tokens (e.g. Kimi's
   *  15-min access token) must refresh well before expiry, not 60s prior. */
  expiresIn?: number;
  /** ChatGPT plan: the validated ID-token subject. Its presence routes OpenAI to the plan transport. */
  accountId?: string;
  /** Retired Gemini Code Assist project ID; only read to recognise an old sign-in. */
  projectId?: string;
  baseUrl?: string; // Custom API base URL (e.g. Xiaomi token plan endpoint)
  /** ChatGPT plan: the client ID OpenAI issued at first sign-in (never `dynamic_agent_client`). */
  clientId?: string;
  /** ChatGPT plan: the last validated ID token, sent back as `id_token_hint`. */
  idToken?: string;
  /** ChatGPT plan: scopes the token response granted. */
  scopes?: string[];
  /** ms timestamp until which this credential's usage window is exhausted.
   *  Set by AuthStorage.markUsageExhausted() when the provider rejects with a
   *  usage/quota stop; while in the future, resolution may skip this credential
   *  in favor of a configured fallback (e.g. ChatGPT plan → OpenAI API key). */
  usageExhaustedUntil?: number;
}

export interface OAuthLoginCallbacks {
  onOpenUrl: (url: string) => void;
  /**
   * Collect a pasted authorization code or callback URL.
   *
   * `signal` aborts when the code already arrived another way (the local
   * callback listener won the race) and the prompt should be torn down.
   * Implementations may ignore it — an abandoned promise is simply never
   * awaited — but a terminal prompt should honour it so the line does not
   * linger after login already succeeded.
   */
  onPromptCode: (message: string, signal?: AbortSignal) => Promise<string>;
  onStatus: (message: string) => void;
}
