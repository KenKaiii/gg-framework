import fs from "node:fs/promises";
import crypto from "node:crypto";
import { getAppPaths } from "./paths.js";
import type { OAuthCredentials } from "./oauth/types.js";
import { refreshAnthropicToken } from "./oauth/anthropic.js";
import { refreshOpenAIToken } from "./oauth/openai.js";
import { refreshGeminiToken } from "./oauth/gemini.js";
import { refreshKimiToken } from "./oauth/kimi.js";
import { withFileLock } from "./file-lock.js";
import { log } from "./logger.js";

type AuthData = Record<string, OAuthCredentials>;

/**
 * Storage key for Kimi Code OAuth credentials. Kept distinct from the
 * `moonshot` API-key entry so a user can configure BOTH and we always
 * prefer OAuth for the logical `moonshot` provider.
 */
export const MOONSHOT_OAUTH_KEY = "moonshot-oauth";

/**
 * Storage key for the Xiaomi API Credits credential (`https://api.xiaomimimo.com/v1`).
 * Kept distinct from the `xiaomi` Token Plan entry (`token-plan-sgp.xiaomimimo.com`)
 * so a user can configure BOTH — `mimo-v2.5-pro-ultraspeed` is API Credits-only,
 * while `mimo-v2.5-pro`/`mimo-v2.5` prefer the Token Plan but fall back to API
 * Credits when only that's configured. Which key(s) a model tries, and in what
 * order, is decided per-model via `getAuthStorageKeys()` in model-registry.ts.
 */
export const XIAOMI_CREDITS_KEY = "xiaomi-credits";

/**
 * Refresh refreshable OAuth tokens this long BEFORE their hard expiry. Renewing
 * proactively keeps the credential (and its refresh token) alive across
 * sessions instead of waiting until a request fails with 401 — which, for
 * providers like Kimi, is otherwise misread as a dead credential and triggers a
 * silent fall back to a static API key.
 */
const REFRESH_SKEW_MS = 60_000;

/**
 * How long a usage-exhausted mark holds when the provider gave no reset time.
 * Short on purpose: after it lapses we try the preferred (OAuth) credential
 * again — if the window is still out, the caller re-marks and falls back again,
 * costing one rejected request per window instead of sticking to the fallback
 * key forever.
 */
const USAGE_EXHAUSTED_DEFAULT_MS = 15 * 60 * 1000;

/** Providers whose credentials are static API keys (no refresh mechanism). */
const STATIC_API_KEY_PROVIDERS = new Set([
  "glm",
  "moonshot",
  "xiaomi",
  "minimax",
  "deepseek",
  "openrouter",
  "sakana",
  "xai",
]);

export class AuthStorage {
  private data: AuthData = {};
  private filePath: string;
  private loaded = false;
  /** Per-provider lock to serialize concurrent refresh calls. */
  private refreshLocks = new Map<string, Promise<OAuthCredentials>>();

  constructor(filePath?: string) {
    this.filePath = filePath ?? getAppPaths().authFile;
  }

  /** Path to the on-disk auth file. Useful for status output. */
  get path(): string {
    return this.filePath;
  }

  /** List provider keys with stored credentials. */
  async listProviders(): Promise<string[]> {
    await this.ensureLoaded();
    return Object.keys(this.data);
  }

  /** True if credentials exist for `provider`. */
  async hasCredentials(provider: string): Promise<boolean> {
    await this.ensureLoaded();
    return Boolean(this.data[provider]);
  }

  /**
   * First key in `keys` (in order) that has stored credentials, or `undefined`
   * if none do. Mirrors the first-match logic `resolveCredentials({ storageKeys })`
   * uses internally — callers that need to know WHICH credential will actually
   * be used (e.g. to clear the right one after a 401) call this directly
   * instead of re-deriving the same order.
   */
  async pickStorageKey(keys: string[]): Promise<string | undefined> {
    await this.ensureLoaded();
    return keys.find((key) => Boolean(this.data[key]));
  }

  /**
   * True if the user has any usable auth for the logical provider. For
   * `moonshot` this is satisfied by either the Kimi OAuth credential or the
   * Moonshot API key.
   */
  async hasProviderAuth(provider: string): Promise<boolean> {
    await this.ensureLoaded();
    if (provider === "moonshot") {
      return Boolean(this.data[MOONSHOT_OAUTH_KEY] || this.data["moonshot"]);
    }
    if (provider === "xiaomi") {
      return Boolean(this.data["xiaomi"] || this.data[XIAOMI_CREDITS_KEY]);
    }
    return Boolean(this.data[provider]);
  }

  /**
   * True if the active credential for `provider` is a static API key with no
   * refresh mechanism. For `moonshot` this is only true when the Kimi OAuth
   * credential is absent (a present OAuth credential is refreshable).
   */
  async isStaticApiKey(provider: string): Promise<boolean> {
    await this.ensureLoaded();
    if (provider === "moonshot" && this.data[MOONSHOT_OAUTH_KEY]) {
      // A usage-exhausted OAuth credential with an API key configured means
      // the API key is what actually resolves right now — treat it as the
      // static key it is (so a 401 clears the key instead of pointlessly
      // force-refreshing the sidelined OAuth token).
      const exhaustedUntil = this.data[MOONSHOT_OAUTH_KEY].usageExhaustedUntil ?? 0;
      const apiKeyActive = Date.now() < exhaustedUntil && Boolean(this.data["moonshot"]);
      if (!apiKeyActive) return false;
    }
    return STATIC_API_KEY_PROVIDERS.has(provider);
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

  /**
   * Mark the credential stored under `storageKey` as usage-exhausted until
   * `resetsAt` (unix SECONDS, from the provider's rate-limit response) or a
   * 15-minute default when no reset time is known. While the mark is in the
   * future, `resolveCredentials("moonshot")` serves the Moonshot API key
   * instead of the Kimi OAuth credential (when both are configured) — OAuth
   * stays the preferred credential and is retried automatically once the mark
   * lapses. Persisted to auth.json so a restart (or another gg-app window)
   * doesn't burn a request rediscovering the same exhausted window. No-op if
   * nothing is stored under `storageKey`.
   */
  async markUsageExhausted(storageKey: string, resetsAt?: number): Promise<void> {
    await this.ensureLoaded();
    const creds = this.data[storageKey];
    if (!creds) return;
    const until =
      resetsAt !== undefined && resetsAt * 1000 > Date.now()
        ? resetsAt * 1000
        : Date.now() + USAGE_EXHAUSTED_DEFAULT_MS;
    creds.usageExhaustedUntil = until;
    await this.save();
    log(
      "WARN",
      "auth",
      `Marked ${storageKey} usage-exhausted until ${new Date(until).toISOString()}`,
    );
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
    opts?: { forceRefresh?: boolean; storageKeys?: string[] },
  ): Promise<OAuthCredentials> {
    await this.ensureLoaded();

    // Explicit ordered storage-key override (e.g. Xiaomi: prefer the Token
    // Plan credential, fall back to API Credits if only that's configured).
    // Bypasses the provider-name resolution below entirely when given —
    // these are always static API keys with no refresh mechanism, so a
    // direct first-match lookup is correct. A single-entry list equal to
    // `[provider]` falls through to normal resolution below.
    if (opts?.storageKeys && !(opts.storageKeys.length === 1 && opts.storageKeys[0] === provider)) {
      for (const key of opts.storageKeys) {
        const creds = this.data[key];
        if (creds) return creds;
      }
      throw new NotLoggedInError(provider);
    }

    // Prefer Kimi OAuth over the Moonshot API key for the logical `moonshot`
    // provider. When an OAuth credential exists, resolve (and refresh) that
    // instead — this is the "default to OAuth first" rule.
    if (provider === "moonshot" && this.data[MOONSHOT_OAUTH_KEY]) {
      // OAuth plan usage window exhausted (marked by the agent loop when the
      // managed endpoint rejected with a usage/quota stop). Serve the API key
      // while the window recovers — but ONLY when one is configured; with no
      // API key the OAuth credential still resolves so the real usage-limit
      // error (with its reset time) surfaces to the user instead of a
      // misleading "not logged in".
      const exhaustedUntil = this.data[MOONSHOT_OAUTH_KEY].usageExhaustedUntil ?? 0;
      if (Date.now() < exhaustedUntil && this.data["moonshot"]) {
        log(
          "WARN",
          "auth",
          "Kimi OAuth usage window is exhausted — using the Moonshot API key until " +
            `${new Date(exhaustedUntil).toISOString()} (OAuth resumes automatically).`,
        );
        return this.data["moonshot"];
      }
      try {
        // Do NOT forward `storageKeys` here: the caller's keys (e.g.
        // AgentSession's ["moonshot"]) no longer match the recursive
        // provider ("moonshot-oauth"), so forwarding them tripped the
        // storage-key override branch — silently returning the raw API key
        // when both credentials existed (misattributed "usage is out"
        // errors) and throwing NotLoggedInError for OAuth-only users.
        return await this.resolveCredentials(MOONSHOT_OAUTH_KEY, {
          ...(opts?.forceRefresh ? { forceRefresh: true } : {}),
        });
      } catch (err) {
        // OAuth refresh token is dead and was wiped. Fall back to the
        // Moonshot API key if the user also configured one. This is a billing
        // switch (OAuth → paid API key), so make it loud in the debug log
        // rather than silent — the user expects OAuth to stay active and
        // should know a re-login is needed to restore it.
        if (err instanceof NotLoggedInError && this.data["moonshot"]) {
          log(
            "WARN",
            "auth",
            "Kimi OAuth credential is no longer valid — falling back to the Moonshot API key. " +
              'Run "ggcoder login" and choose Kimi OAuth to restore OAuth auth.',
          );
          return this.data["moonshot"];
        }
        throw err;
      }
    }

    const creds = this.data[provider];
    if (!creds) {
      throw new NotLoggedInError(provider);
    }

    // Static API-key providers have no refresh mechanism. The Kimi OAuth key
    // (MOONSHOT_OAUTH_KEY) is intentionally excluded — it refreshes below.
    if (STATIC_API_KEY_PROVIDERS.has(provider)) {
      return creds;
    }

    // Return if not expired (with a safety skew) and not force-refreshing
    if (!opts?.forceRefresh && Date.now() < creds.expiresAt - REFRESH_SKEW_MS) {
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
        if (
          freshCreds &&
          !opts?.forceRefresh &&
          Date.now() < freshCreds.expiresAt - REFRESH_SKEW_MS
        ) {
          // Another process already refreshed — use their token
          this.data[provider] = freshCreds;
          return freshCreds;
        }
      } catch {
        // Fall through to refresh
      }

      const refreshFn =
        provider === "anthropic"
          ? refreshAnthropicToken
          : provider === "gemini"
            ? refreshGeminiToken
            : provider === MOONSHOT_OAUTH_KEY
              ? refreshKimiToken
              : refreshOpenAIToken;
      let refreshed: OAuthCredentials;
      try {
        refreshed = await refreshFn(creds.refreshToken);
      } catch (err) {
        // Refresh token revoked / expired / invalid → the stored creds are
        // unusable. Wipe them so the next launch surfaces a clean
        // NotLoggedInError instead of hitting the same dead refresh path
        // every time. The user must re-login.
        const msg = err instanceof Error ? err.message : String(err);
        const isAuthFailure =
          /\((401|400)\)/.test(msg) ||
          /invalid_grant|invalid_token|invalid.*refresh/i.test(msg) ||
          /unauthorized/i.test(msg);
        if (isAuthFailure) {
          delete this.data[provider];
          await atomicWriteFile(this.filePath, JSON.stringify(this.data, null, 2));
          throw new NotLoggedInError(provider);
        }
        throw err;
      }
      if (!refreshed.accountId && creds.accountId) {
        refreshed.accountId = creds.accountId;
      }
      if (!refreshed.projectId && creds.projectId) {
        refreshed.projectId = creds.projectId;
      }
      if (!refreshed.baseUrl && creds.baseUrl) {
        refreshed.baseUrl = creds.baseUrl;
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
