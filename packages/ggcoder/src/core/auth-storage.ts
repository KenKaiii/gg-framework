import fs from "node:fs/promises";
import os from "node:os";
import { getAppPaths } from "../config.js";
import type { OAuthCredentials } from "./oauth/types.js";
import { refreshAnthropicToken } from "./oauth/anthropic.js";
import { refreshOpenAIToken } from "./oauth/openai.js";

type AuthData = Record<string, OAuthCredentials>;

export class AuthStorage {
  private data: AuthData = {};
  private filePath: string;
  private loaded = false;
  /** Per-provider lock to serialize concurrent refresh calls. */
  private refreshLocks = new Map<string, Promise<OAuthCredentials>>();

  constructor(filePath?: string) {
    this.filePath = filePath ?? getAppPaths().authFile;
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      this.data = JSON.parse(content) as AuthData;
    } catch {
      this.data = {};
    }
    this.loaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async getCredentials(provider: string): Promise<OAuthCredentials | undefined> {
    await this.ensureLoaded();
    return this.data[provider];
  }

  async setCredentials(provider: string, creds: OAuthCredentials): Promise<void> {
    await this.ensureLoaded();
    this.data[provider] = creds;
    await this.save();
  }

  async clearCredentials(provider: string): Promise<void> {
    await this.ensureLoaded();
    delete this.data[provider];
    await this.save();
  }

  async clearAll(): Promise<void> {
    this.data = {};
    await this.save();
  }

  /**
   * Returns valid credentials, auto-refreshing if expired.
   * If `forceRefresh` is true, refreshes even if the token hasn't expired
   * (useful when the provider rejects a token with 401 before its stored expiry).
   * Throws if not logged in.
   */
  async resolveCredentials(
    provider: string,
    opts?: { forceRefresh?: boolean },
  ): Promise<OAuthCredentials> {
    await this.ensureLoaded();
    let creds = this.data[provider];
    if (!creds) {
      // Auto-discover credentials from other CLI tools on the machine
      // (e.g. Claude Code stores OAuth tokens in ~/.claude/, Codex CLI in ~/.codex/)
      creds = await this.discoverCredentials(provider);
      if (!creds) {
        throw new NotLoggedInError(provider);
      }
      this.data[provider] = creds;
      await this.save();
    }

    // GLM and Moonshot use static API keys — no refresh needed
    if (provider === "glm" || provider === "moonshot") {
      return creds;
    }

    // Return if not expired and not force-refreshing
    if (!opts?.forceRefresh && Date.now() < creds.expiresAt) {
      return creds;
    }

    // Serialize concurrent refresh calls per provider to avoid races
    const existing = this.refreshLocks.get(provider);
    if (existing) return existing;

    const refreshPromise = (async () => {
      const refreshFn = provider === "anthropic" ? refreshAnthropicToken : refreshOpenAIToken;
      const refreshed = await refreshFn(creds.refreshToken);
      if (!refreshed.accountId && creds.accountId) {
        refreshed.accountId = creds.accountId;
      }
      this.data[provider] = refreshed;
      await this.save();
      return refreshed;
    })();

    this.refreshLocks.set(provider, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      this.refreshLocks.delete(provider);
    }
  }

  /**
   * Returns a valid access token, auto-refreshing if expired.
   * Throws if not logged in.
   */
  async resolveToken(provider: string): Promise<string> {
    const creds = await this.resolveCredentials(provider);
    return creds.accessToken;
  }

  /**
   * Try to find existing credentials from other CLI tools already installed
   * on the machine. This avoids forcing users to re-authenticate when they
   * already have valid sessions from Claude Code or Codex CLI.
   */
  private async discoverCredentials(provider: string): Promise<OAuthCredentials | null> {
    const home = os.homedir();

    if (provider === "anthropic") {
      // Claude Code stores OAuth credentials at ~/.claude/.credentials.json
      try {
        const raw = await fs.readFile(`${home}/.claude/.credentials.json`, "utf-8");
        const data = JSON.parse(raw);
        const oauth = data?.claudeAiOauth;
        if (oauth?.accessToken) {
          return {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken ?? "",
            expiresAt: Date.now() + 3600_000, // Re-check in 1 hour
          };
        }
      } catch {
        // No Claude Code credentials found
      }
    }

    if (provider === "openai") {
      // Codex CLI stores OAuth credentials at ~/.codex/auth.json
      try {
        const raw = await fs.readFile(`${home}/.codex/auth.json`, "utf-8");
        const data = JSON.parse(raw);
        const token = data?.tokens?.access_token;
        if (token) {
          return {
            accessToken: token,
            refreshToken: data.tokens.refresh_token ?? "",
            expiresAt: Date.now() + 3600_000,
            accountId: data.tokens.account_id,
          };
        }
      } catch {
        // No Codex credentials found
      }
    }

    return null;
  }

  private async save(): Promise<void> {
    const content = JSON.stringify(this.data, null, 2);
    await fs.writeFile(this.filePath, content, { encoding: "utf-8", mode: 0o600 });
  }
}

export class NotLoggedInError extends Error {
  provider: string;
  constructor(provider: string) {
    super(`Not logged in to ${provider}. Run "ggcoder login" to authenticate.`);
    this.name = "NotLoggedInError";
    this.provider = provider;
  }
}
