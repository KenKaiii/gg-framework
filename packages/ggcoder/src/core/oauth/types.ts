export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms timestamp
  accountId?: string; // OpenAI chatgpt_account_id from JWT
  baseUrl?: string; // Custom API base URL (e.g. Xiaomi token plan endpoint)
}

export interface OAuthLoginCallbacks {
  onOpenUrl: (url: string) => void;
  onPromptCode: (message: string) => Promise<string>;
  onStatus: (message: string) => void;
}
