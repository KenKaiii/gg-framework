import fs from "node:fs/promises";
import crypto from "node:crypto";
import { getAppPaths } from "../config.js";
import type { OAuthCredentials } from "./oauth/types.js";
import { refreshAnthropicToken } from "./oauth/anthropic.js";
import { refreshOpenAIToken } from "./oauth/openai.js";
import { withFileLock } from "./file-lock.js";
import { log } from "./logger.js";

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
    await withFileLock(this.filePath, async () => {
      try {
        const content = await fs.readFile(this.filePath, "utf-8");
        this.data = JSON.parse(content) as AuthData;
        log("INFO", "auth", `Loaded credentials from ${this.filePath}`, {
          providers: Object.keys(this.data).join(",") || "(none)",
        });
      } catch (err) {
        this.data = {};
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          log("INFO", "auth", `No auth file found at ${this.filePath} (first run)`);
        } else {
          log(
            "ERROR",
            "auth",
            `Failed to load auth file: ${err instanceof Error ? err.message : String(err)}`,
            { path: this.filePath, code: code ?? "unknown" },
          );
        }
      }
    });
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
    const creds = this.data[provider];
    if (!creds) {
      throw new NotLoggedInError(provider);
    }

    // GLM and Moonshot use static API keys — no refresh needed
    if (
      provider === "glm" ||
      provider === "moonshot" ||
      provider === "xiaomi" ||
      provider === "minimax"
    ) {
      return creds;
    }

    // Return if not expired and not force-refreshing
    if (!opts?.forceRefresh && Date.now() < creds.expiresAt) {
      return creds;
    }

    // Serialize concurrent refresh calls per provider to avoid races
    const existing = this.refreshLocks.get(provider);
    if (existing) return existing;

    const refreshPromise = withFileLock(this.filePath, async () => {
      // Re-read from disk in case another process refreshed while we waited for the lock
      try {
        const content = await fs.readFile(this.filePath, "utf-8");
        const freshData = JSON.parse(content) as AuthData;
        const freshCreds = freshData[provider];
        if (freshCreds && !opts?.forceRefresh && Date.now() < freshCreds.expiresAt) {
          // Another process already refreshed — use their token
          this.data[provider] = freshCreds;
          return freshCreds;
        }
      } catch {
        // Fall through to refresh
      }

      const refreshFn = provider === "anthropic" ? refreshAnthropicToken : refreshOpenAIToken;
      const refreshed = await refreshFn(creds.refreshToken);
      if (!refreshed.accountId && creds.accountId) {
        refreshed.accountId = creds.accountId;
      }
      this.data[provider] = refreshed;
      // Write atomically (we already hold the file lock)
      await atomicWriteFile(this.filePath, JSON.stringify(this.data, null, 2));
      return refreshed;
    });

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

  private async save(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      await atomicWriteFile(this.filePath, JSON.stringify(this.data, null, 2));
    });
  }
}

/**
 * Atomic file write using temp file + rename pattern.
 * Prevents partial/corrupt data if the process crashes mid-write.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
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
