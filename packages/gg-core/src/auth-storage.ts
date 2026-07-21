import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
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
 * The credential entry whose baseUrl applies right now. For `moonshot` this
 * mirrors resolveCredentials' preference: the Kimi OAuth entry, sidelined to
 * the Moonshot API key only while its usage window is exhausted and a key is
 * configured. Shared by {@link AuthStorage.getStoredBaseUrl} and
 * {@link readStoredBaseUrlSync} so both paths agree on the active endpoint.
 */
function activeBaseUrlEntry(data: AuthData, provider: string): OAuthCredentials | undefined {
  if (provider === "moonshot") {
    const oauth = data[MOONSHOT_OAUTH_KEY];
    if (oauth) {
      const exhaustedUntil = oauth.usageExhaustedUntil ?? 0;
      if (Date.now() < exhaustedUntil && data["moonshot"]) return data["moonshot"];
      return oauth;
    }
    return data["moonshot"];
  }
  return data[provider];
}

/**
 * Synchronous baseUrl read straight from the auth file, for boot paths that
 * need the active endpoint before an AuthStorage instance exists (e.g. the
 * CLI's sync main()). Missing/corrupt files yield undefined — callers treat
 * that as the provider's public endpoint. Read-only: safe without the file
 * lock (a torn mid-write read just falls back to undefined).
 */
export function readStoredBaseUrlSync(authFile: string, provider: string): string | undefined {
  try {
    const data = JSON.parse(readFileSync(authFile, "utf-8")) as AuthData;
    return activeBaseUrlEntry(data, provider)?.baseUrl;
  } catch {
    return undefined;
  }
}

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

  /**
   * The base URL on the credential that is active right now, if any.
   * Synchronous — call only after load()/resolveCredentials() populated the
   * snapshot. For `moonshot` this is the Kimi For Coding URL whenever the
   * OAuth entry is the one resolveCredentials would serve (i.e. not currently
   * usage-exhausted with an API key configured).
   */
  getStoredBaseUrl(provider: string): string | undefined {
    return activeBaseUrlEntry(this.data, provider)?.baseUrl;
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

  /**
   * Apply one provider-scoped mutation to the latest on-disk snapshot.
   * AuthStorage instances live in every app session/process, so writing this
   * instance's cached snapshot can erase credentials another instance just
   * added. The file lock only serializes writers; the re-read prevents stale
   * full-file overwrites.
   */
  private async mutateLatest(mutator: (data: AuthData) => void): Promise<void> {
    await this.ensureLoaded();
    await withFileLock(this.filePath, async () => {
      const latest = await readAuthData(this.filePath);
      mutator(latest);
      await atomicWriteFile(this.filePath, JSON.stringify(latest, null, 2));
      this.data = latest;
    });
  }

  private async reloadLatest(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      this.data = await readAuthData(this.filePath);
    });
  }

  async getCredentials(provider: string): Promise<OAuthCredentials | undefined> {
    await this.ensureLoaded();
    return this.data[provider];
  }

  async setCredentials(provider: string, creds: OAuthCredentials): Promise<void> {
    await this.mutateLatest((latest) => {
      latest[provider] = creds;
    });
  }

  async clearCredentials(provider: string): Promise<void> {
    await this.mutateLatest((latest) => {
      delete latest[provider];
    });
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
    const until =
      resetsAt !== undefined && resetsAt * 1000 > Date.now()
        ? resetsAt * 1000
        : Date.now() + USAGE_EXHAUSTED_DEFAULT_MS;
    let marked = false;
    await this.mutateLatest((latest) => {
      const creds = latest[storageKey];
      if (!creds) return;
      creds.usageExhaustedUntil = until;
      marked = true;
    });
    if (!marked) return;
    log(
      "WARN",
      "auth",
      `Marked ${storageKey} usage-exhausted until ${new Date(until).toISOString()}`,
    );
  }

  async clearAll(): Promise<void> {
    await this.ensureLoaded();
    await withFileLock(this.filePath, async () => {
      this.data = {};
      await atomicWriteFile(this.filePath, JSON.stringify(this.data, null, 2));
    });
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

    // A failed refresh removes the credential from this session's cache. If
    // the user then re-logs in through another app session, recover that new
    // on-disk credential instead of remaining "not logged in" until restart.
    const directStorageKeys =
      opts?.storageKeys && !(opts.storageKeys.length === 1 && opts.storageKeys[0] === provider)
        ? opts.storageKeys
        : provider === "moonshot"
          ? [MOONSHOT_OAUTH_KEY, "moonshot"]
          : [provider];
    if (!directStorageKeys.some((key) => Boolean(this.data[key]))) {
      await this.reloadLatest();
    }

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
      // Always refresh against the latest complete file. A different app
      // session may have re-logged in this provider or changed another one
      // since this instance loaded its cached snapshot.
      const latest = await readAuthData(this.filePath);
      const latestCreds = latest[provider];
      if (!latestCreds) {
        this.data = latest;
        throw new NotLoggedInError(provider);
      }

      const credentialWasReplaced =
        latestCreds.accessToken !== creds.accessToken ||
        latestCreds.refreshToken !== creds.refreshToken ||
        latestCreds.expiresAt !== creds.expiresAt;
      if (
        credentialWasReplaced ||
        (!opts?.forceRefresh && Date.now() < latestCreds.expiresAt - REFRESH_SKEW_MS)
      ) {
        // Another process refreshed or re-logged in while this session still
        // held the rejected token. Trust that replacement even for a forced
        // refresh; retrying the revoked OLD refresh token would delete the new
        // login that just landed on disk.
        this.data = latest;
        return latestCreds;
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
        refreshed = await refreshFn(latestCreds.refreshToken);
      } catch (err) {
        // Refresh token revoked / expired / invalid → the stored creds are
        // unusable. Delete only this provider from the latest snapshot so a
        // failed refresh can never erase another provider's concurrent login.
        const msg = err instanceof Error ? err.message : String(err);
        const isAuthFailure =
          /\((401|400)\)/.test(msg) ||
          /invalid_grant|invalid_token|invalid.*refresh/i.test(msg) ||
          /unauthorized/i.test(msg);
        if (isAuthFailure) {
          delete latest[provider];
          this.data = latest;
          await atomicWriteFile(this.filePath, JSON.stringify(latest, null, 2));
          throw new NotLoggedInError(provider);
        }
        throw err;
      }
      if (!refreshed.accountId && latestCreds.accountId) {
        refreshed.accountId = latestCreds.accountId;
      }
      if (!refreshed.projectId && latestCreds.projectId) {
        refreshed.projectId = latestCreds.projectId;
      }
      if (!refreshed.baseUrl && latestCreds.baseUrl) {
        refreshed.baseUrl = latestCreds.baseUrl;
      }
      latest[provider] = refreshed;
      this.data = latest;
      // Write atomically (we already hold the file lock).
      await atomicWriteFile(this.filePath, JSON.stringify(latest, null, 2));
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
}

/** Read the latest complete auth snapshot while a caller holds the file lock. */
async function readAuthData(filePath: string): Promise<AuthData> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as AuthData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
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
