export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms timestamp
  accountId?: string; // OpenAI chatgpt_account_id from JWT
  source?: string; // Where credentials came from: "Claude Code", "Codex CLI", or "direct"
}

import type { Provider } from "@kenkaiiii/gg-ai";

export interface ProviderStatus {
  provider: Provider;
  connected: boolean;
  source?: string;
}

export interface OAuthLoginCallbacks {
  onOpenUrl: (url: string) => void;
  onPromptCode: (message: string) => Promise<string>;
  onStatus: (message: string) => void;
}
