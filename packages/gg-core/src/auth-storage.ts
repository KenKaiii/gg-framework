import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { getAppPaths } from "./paths.js";
import type { OAuthCredentials } from "./oauth/types.js";
import {
  CLAUDE_CODE_AUTH_KEY,
  CLAUDE_CODE_AUTH_MARKER,
  isClaudeCodeAuthMarker,
  isLegacyClaudeOAuth,
} from "./claude-code/runtime.js";
import { refreshChatGPTToken } from "./oauth/openai.js";
import { withFileLock } from "./file-lock.js";
import { log } from "./logger.js";
import { isHiddenProvider } from "./hidden-providers.js";
import { LOCAL_NO_API_KEY } from "@kenkaiiii/gg-ai";
import { detectMiniMaxBaseUrl } from "./minimax-region.js";
import { detectXiaomiTokenPlanBaseUrl } from "./xiaomi-region.js";
import { KIMI_CODE_DEFAULT_BASE_URL, detectKimiCodeBaseUrl } from "./kimi-region.js";

type AuthData = Record<string, OAuthCredentials>;

/**
 * Storage key for the ChatGPT plan sign-in (Continue with ChatGPT). Kept
 * distinct from the `openai` entry, which holds an OpenAI API key, so a user can
 * hold both: the plan serves first and the key covers while its usage is out.
 */
export const OPENAI_CHATGPT_KEY = "openai-chatgpt";

/**
 * Storage key for a Kimi Code plan key (Kimi Code Console), served by
 * `api.kimi.com/coding/v1` or `api.kimi.ai/coding/v1`. Kept distinct from the
 * `moonshot` entry, which holds a pay-per-token Moonshot platform key.
 */
export const KIMI_CODE_KEY = "kimi-code";

/**
 * A sign-in GG Coder no longer uses, because it posed as another vendor's app
 * (Codex CLI, Kimi Code CLI, Grok CLI, Gemini CLI) or its token stopped
 * working. The entry is never served; the user is asked once to reconnect.
 */
export interface RetiredSignIn {
  /** Logical provider the credential belonged to. */
  provider: string;
  /** auth.json key holding the retired credential. */
  storageKey: string;
  /** What to tell the user, without CLI/app-specific instructions. */
  message: string;
}

export const RETIRED_SIGN_INS: readonly RetiredSignIn[] = [
  {
    provider: "anthropic",
    storageKey: "anthropic",
    message:
      "Your old Claude sign-in no longer works. Sign in with Claude again to keep using your subscription.",
  },
  {
    provider: "openai",
    storageKey: "openai",
    message:
      "Your old ChatGPT sign-in no longer works. Continue with ChatGPT again, or add an OpenAI API key.",
  },
  {
    provider: "moonshot",
    storageKey: "moonshot-oauth",
    message:
      "Kimi sign-in was removed. Paste a Kimi Code plan key from the Kimi Code Console, or a Moonshot API key.",
  },
  {
    provider: "xai",
    storageKey: "xai-oauth",
    message:
      "Grok sign-in was removed: xAI offers SuperGrok and X Premium usage only in apps it partners with. Add an xAI API key instead.",
  },
  {
    provider: "gemini",
    storageKey: "gemini",
    message: "Google sign-in was removed. Add a Gemini API key from Google AI Studio instead.",
  },
];

/** True when `value`, stored under `retired.storageKey`, is that retired sign-in. */
function isRetiredEntry(retired: RetiredSignIn, value: OAuthCredentials | undefined): boolean {
  if (!value) return false;
  switch (retired.storageKey) {
    case "anthropic":
      return isLegacyClaudeOAuth(value);
    // These slots now hold API keys; only a refreshable sign-in token is retired.
    case "openai":
    case "gemini":
      return Boolean(value.refreshToken) || Boolean(value.accountId) || Boolean(value.projectId);
    default:
      return true;
  }
}

function isRetiredStorageKey(data: AuthData, storageKey: string): boolean {
  return RETIRED_SIGN_INS.some(
    (r) => r.storageKey === storageKey && isRetiredEntry(r, data[storageKey]),
  );
}

/** The usable credential stored under `storageKey`; a retired sign-in reads as absent. */
function usableEntry(data: AuthData, storageKey: string): OAuthCredentials | undefined {
  return isRetiredStorageKey(data, storageKey) ? undefined : data[storageKey];
}

/** Logical provider for a storage key (`kimi-code` → `moonshot`). */
export function storageKeyProvider(storageKey: string): string {
  if (storageKey === OPENAI_CHATGPT_KEY) return "openai";
  if (storageKey === KIMI_CODE_KEY) return "moonshot";
  if (storageKey === XIAOMI_CREDITS_KEY) return "xiaomi";
  if (storageKey === GEMINI_API_KEY) return "gemini";
  return storageKey;
}

/**
 * API-key storage keys for a provider whose keys split into a plan key and a
 * pay-per-token key, plan first. Single-key providers yield just their own key.
 */
export function apiKeyStorageKeys(provider: string): string[] {
  if (provider === "moonshot") return [KIMI_CODE_KEY, "moonshot"];
  if (provider === "xiaomi") return ["xiaomi", XIAOMI_CREDITS_KEY];
  if (provider === "gemini") return [GEMINI_API_KEY];
  return [provider];
}

/**
 * A provider that can hold two credentials at once: a refreshable plan sign-in
 * and a static API key. One policy governs all of them — see
 * {@link DUAL_AUTH_PROVIDERS} — so adding a provider here is enough to give it
 * OAuth-first resolution, usage-exhaustion fallback, per-method logout and the
 * matching UI affordances.
 */
export interface DualAuthProvider {
  /** Logical provider id, which is also the API-key storage key. */
  provider: string;
  /** Storage key holding the OAuth credential. */
  oauthKey: string;
  /** Human label for the OAuth credential (log/UI wording). */
  oauthLabel: string;
  /** Human label for the API-key credential (log/UI wording). */
  apiKeyLabel: string;
  /** What the user should do to restore OAuth after it went invalid. */
  restoreHint: string;
}

/**
 * Providers offering subscription OAuth *and* an API key. The resolution policy
 * is identical for every entry:
 *
 *  1. OAuth wins whenever it is configured — it is the cheaper, subscription
 *     credential, and the one the user opted into most recently.
 *  2. If OAuth's usage window is exhausted (marked by the agent loop when the
 *     subscription endpoint rejects with a usage/quota stop) the API key serves
 *     until the mark lapses — but only when a key is actually configured, so
 *     OAuth-only users still see the real usage-limit error and its reset time.
 *  3. If OAuth's refresh token is dead, fall back to the API key and log loudly:
 *     it is a billing switch (subscription → metered), not a detail.
 */
const DUAL_AUTH_PROVIDERS: readonly DualAuthProvider[] = [
  {
    provider: "openai",
    oauthKey: OPENAI_CHATGPT_KEY,
    oauthLabel: "ChatGPT plan",
    apiKeyLabel: "OpenAI API key",
    restoreHint:
      'Run "ggcoder login" and choose Continue with ChatGPT to use your ChatGPT plan again.',
  },
];

/** Dual-auth policy for a logical provider, or undefined if it has just one method. */
export function dualAuthProvider(provider: string): DualAuthProvider | undefined {
  return DUAL_AUTH_PROVIDERS.find((entry) => entry.provider === provider);
}

/** Dual-auth policy keyed by the OAuth storage key (the reverse lookup). */
export function dualAuthProviderByOAuthKey(storageKey: string): DualAuthProvider | undefined {
  return DUAL_AUTH_PROVIDERS.find((entry) => entry.oauthKey === storageKey);
}

/** The OAuth storage key for a dual-auth provider, if it has one. */
export function oauthStorageKey(provider: string): string | undefined {
  return dualAuthProvider(provider)?.oauthKey;
}

/**
 * Both storage keys a dual-auth provider may hold, in resolution order
 * (OAuth first). Single-method providers yield just their own key.
 */
export function providerStorageKeys(provider: string): string[] {
  const dual = dualAuthProvider(provider);
  return dual ? [dual.oauthKey, dual.provider] : [provider];
}

/**
 * Storage key for the Xiaomi API Credits credential (`https://api.xiaomimimo.com/v1`).
 * Kept distinct from the `xiaomi` Token Plan entry (`token-plan-sgp.xiaomimimo.com`)
 * so a user can configure BOTH — `mimo-v2.6-pro-ultraspeed` is API Credits-only,
 * while `mimo-v2.6-pro`/`mimo-v2.6-flash` prefer the Token Plan but fall back to API
 * Credits when only that's configured. Which key(s) a model tries, and in what
 * order, is decided per-model via `getAuthStorageKeys()` in model-registry.ts.
 */
export const XIAOMI_CREDITS_KEY = "xiaomi-credits";

/**
 * Storage key for a Gemini API key (Google AI Studio, billed per token), served
 * by the public Gemini API at {@link GEMINI_API_KEY_BASE_URL}. Kept distinct from
 * the `gemini` entry, which held the retired Google sign-in.
 */
export const GEMINI_API_KEY = "gemini-api";

/** Public Gemini API (AI Studio key). The transport routes on this base URL. */
export const GEMINI_API_KEY_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Prefix for local-endpoint credentials (`local:ollama`, `local:lmstudio`, …).
 * One entry per endpoint, each carrying that endpoint's `baseUrl`, so the
 * existing `resolveCredentials({ storageKeys })` override resolves a local model
 * with no new code path. Kept in sync with `localAuthStorageKey()` in
 * local-models.ts.
 */
export const LOCAL_AUTH_KEY_PREFIX = "local:";

/** A century — local endpoints have no token lifetime, so never expire them. */
const LOCAL_CREDENTIAL_LIFETIME_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/**
 * The credential entry whose baseUrl applies right now. For a dual-auth provider
 * this mirrors resolveCredentials' preference: the OAuth entry, sidelined to the
 * API key only while its usage window is exhausted and a key is configured.
 * Shared by {@link AuthStorage.getStoredBaseUrl} and {@link readStoredBaseUrlSync}
 * so both paths agree on the active endpoint.
 */
function activeBaseUrlEntry(data: AuthData, provider: string): OAuthCredentials | undefined {
  const dual = dualAuthProvider(provider);
  if (dual) {
    const oauth = data[dual.oauthKey];
    const apiKey = usableEntry(data, dual.provider);
    if (oauth) {
      const exhaustedUntil = oauth.usageExhaustedUntil ?? 0;
      if (Date.now() < exhaustedUntil && apiKey) return apiKey;
      return oauth;
    }
    return apiKey;
  }
  const key = apiKeyStorageKeys(provider).find((k) => usableEntry(data, k));
  const entry = key ? data[key] : undefined;
  // A Kimi Code key not yet probed still goes to the plan endpoint.
  if (key === KIMI_CODE_KEY && entry && !entry.baseUrl) {
    return { ...entry, baseUrl: KIMI_CODE_DEFAULT_BASE_URL };
  }
  return entry;
}

// Shared across AuthStorage instances (one per app window). An inconclusive
// answer (offline) is retried after a while instead of on every request.
const MINIMAX_REGION_RETRY_MS = 5 * 60 * 1000;
const miniMaxRegionProbes = new Map<string, { at: number; result: Promise<string | undefined> }>();

function cachedMiniMaxRegion(apiKey: string): Promise<string | undefined> {
  const cached = miniMaxRegionProbes.get(apiKey);
  if (cached && Date.now() - cached.at < MINIMAX_REGION_RETRY_MS) return cached.result;
  const result = detectMiniMaxBaseUrl(apiKey).catch(() => undefined);
  miniMaxRegionProbes.set(apiKey, { at: Date.now(), result });
  return result;
}

const kimiRegionProbes = new Map<string, { at: number; result: Promise<string | undefined> }>();

function cachedKimiRegion(apiKey: string): Promise<string | undefined> {
  const cached = kimiRegionProbes.get(apiKey);
  if (cached && Date.now() - cached.at < MINIMAX_REGION_RETRY_MS) return cached.result;
  const result = detectKimiCodeBaseUrl(apiKey).catch(() => undefined);
  kimiRegionProbes.set(apiKey, { at: Date.now(), result });
  return result;
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
 * Proactive-refresh threshold: refresh when the token is within
 * `max(MIN_REFRESH_THRESHOLD_MS, lifetime * REFRESH_THRESHOLD_RATIO)` of expiry.
 * A flat skew rides short-lived tokens to the boundary and 401s; scaling by
 * lifetime refreshes a 1-hour ChatGPT token at its halfway point.
 */
const MIN_REFRESH_THRESHOLD_MS = 300_000;
const REFRESH_THRESHOLD_RATIO = 0.5;

function refreshThresholdMs(creds: OAuthCredentials): number {
  const lifetimeMs = (creds.expiresIn ?? 0) * 1000;
  return Math.max(MIN_REFRESH_THRESHOLD_MS, lifetimeMs * REFRESH_THRESHOLD_RATIO);
}

/**
 * How long a usage-exhausted mark holds when the provider gave no reset time.
 * Short on purpose: after it lapses we try the preferred (OAuth) credential
 * again — if the window is still out, the caller re-marks and falls back again,
 * costing one rejected request per window instead of sticking to the fallback
 * key forever.
 */
const USAGE_EXHAUSTED_DEFAULT_MS = 15 * 60 * 1000;

/**
 * Storage keys whose credential refreshes. Everything else is a static API key:
 * Claude subscriptions run through Claude Code, and every other plan is a key.
 */
const REFRESHABLE_STORAGE_KEYS = new Set([OPENAI_CHATGPT_KEY]);

export class AuthStorage {
  private data: AuthData = {};
  private filePath: string;
  private loaded = false;
  /**
   * inode+mtime+size of the cached file (`size: -1` = no file). The inode
   * detects atomic replacements with equal size within one filesystem clock tick.
   * auth.json is shared: the desktop app writes API keys and disconnects
   * NATIVELY (so they work with no daemon running), and every window/process has
   * its own AuthStorage. A load-once cache therefore goes stale — the sidecar
   * would keep listing models for a provider just disconnected, and hide the
   * ones just connected, until the daemon restarted.
   */
  private snapshotMtimeMs = 0;
  private snapshotSize = -1;
  private snapshotIno = 0;
  /** Per-provider lock to serialize concurrent refresh calls. */
  private refreshLocks = new Map<string, Promise<OAuthCredentials>>();

  private readonly detectMiniMaxRegion: (apiKey: string) => Promise<string | undefined>;
  private readonly detectXiaomiCluster: (apiKey: string) => Promise<string | undefined>;
  private readonly detectKimiRegion: (apiKey: string) => Promise<string | undefined>;

  constructor(
    filePath?: string,
    options?: {
      detectMiniMaxBaseUrl?: (apiKey: string) => Promise<string | undefined>;
      detectXiaomiTokenPlanBaseUrl?: (apiKey: string) => Promise<string | undefined>;
      detectKimiCodeBaseUrl?: (apiKey: string) => Promise<string | undefined>;
    },
  ) {
    this.filePath = filePath ?? getAppPaths().authFile;
    this.detectMiniMaxRegion = options?.detectMiniMaxBaseUrl ?? cachedMiniMaxRegion;
    this.detectXiaomiCluster =
      options?.detectXiaomiTokenPlanBaseUrl ?? detectXiaomiTokenPlanBaseUrl;
    this.detectKimiRegion = options?.detectKimiCodeBaseUrl ?? cachedKimiRegion;
  }

  /** Path to the on-disk auth file. Useful for status output. */
  get path(): string {
    return this.filePath;
  }

  /** List provider keys with stored credentials. */
  async listProviders(): Promise<string[]> {
    await this.ensureFresh();
    return Object.keys(this.data);
  }

  /** True if credentials exist for `provider`. */
  async hasCredentials(provider: string): Promise<boolean> {
    await this.ensureFresh();
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
    await this.ensureFresh();
    return keys.find((key) => Boolean(this.data[key]));
  }

  /**
   * True if the user has any usable auth for the logical provider: the plan
   * sign-in or any of its API keys. A retired sign-in doesn't count.
   */
  async hasProviderAuth(provider: string): Promise<boolean> {
    // A hidden provider counts as not connected, so pickers and startup skip
    // it even when old credentials are still on disk.
    if (isHiddenProvider(provider)) return false;
    await this.ensureFresh();
    const dual = dualAuthProvider(provider);
    if (dual) {
      return Boolean(this.data[dual.oauthKey] || usableEntry(this.data, dual.provider));
    }
    if (provider === "anthropic") {
      return (
        (Boolean(this.data.anthropic) && !isLegacyClaudeOAuth(this.data.anthropic)) ||
        isClaudeCodeAuthMarker(this.data[CLAUDE_CODE_AUTH_KEY])
      );
    }
    // `local` has no single credential — any configured endpoint counts.
    if (provider === "local") {
      return Object.keys(this.data).some((key) => key.startsWith(LOCAL_AUTH_KEY_PREFIX));
    }
    return apiKeyStorageKeys(provider).some((key) => Boolean(usableEntry(this.data, key)));
  }

  /** True if any of `provider`'s API keys is stored. A retired sign-in in a key slot doesn't count. */
  async hasApiKey(provider: string): Promise<boolean> {
    await this.ensureFresh();
    if (provider === "anthropic" && isLegacyClaudeOAuth(this.data.anthropic)) return false;
    return apiKeyStorageKeys(provider).some((key) => Boolean(usableEntry(this.data, key)));
  }

  /**
   * `provider`'s first stored API key, never its plan sign-in. For calls that
   * only an API key may make (OpenAI's Images API isn't on the ChatGPT plan).
   */
  async resolveApiKey(provider: string): Promise<OAuthCredentials> {
    await this.ensureFresh();
    for (const key of apiKeyStorageKeys(provider)) {
      const creds = usableEntry(this.data, key);
      if (creds && !(provider === "anthropic" && isLegacyClaudeOAuth(creds))) return creds;
    }
    throw new NotLoggedInError(provider);
  }

  /** True when the user signed in with Claude through Claude Code (marker only, no token). */
  async hasClaudeCodeLogin(): Promise<boolean> {
    await this.ensureFresh();
    return isClaudeCodeAuthMarker(this.data[CLAUDE_CODE_AUTH_KEY]);
  }

  /** Record a Claude Code sign-in. Claude Code keeps the token; auth.json gets only the marker. */
  async setClaudeCodeLogin(): Promise<void> {
    await this.mutateLatest((latest) => {
      latest[CLAUDE_CODE_AUTH_KEY] = { ...CLAUDE_CODE_AUTH_MARKER } as unknown as OAuthCredentials;
      if (isLegacyClaudeOAuth(latest.anthropic)) delete latest.anthropic;
    });
  }

  /** Retired sign-ins still on disk, so the UI can ask the user to reconnect. */
  async legacySignIns(): Promise<RetiredSignIn[]> {
    await this.ensureFresh();
    return RETIRED_SIGN_INS.filter((r) => isRetiredEntry(r, this.data[r.storageKey]));
  }

  /**
   * Remove `provider`'s retired sign-in, if any. True when one was removed, so
   * the caller can tell the user once to reconnect.
   */
  async takeLegacySignIn(provider: string): Promise<boolean> {
    const retired = RETIRED_SIGN_INS.find((r) => r.provider === provider);
    if (!retired) return false;
    await this.ensureFresh();
    if (!isRetiredEntry(retired, this.data[retired.storageKey])) return false;
    let removed = false;
    await this.mutateLatest((latest) => {
      if (!isRetiredEntry(retired, latest[retired.storageKey])) return;
      delete latest[retired.storageKey];
      removed = true;
    });
    return removed;
  }

  async clearClaudeCodeLogin(): Promise<void> {
    await this.clearCredentials(CLAUDE_CODE_AUTH_KEY);
  }

  /** Endpoint ids that currently have a `local:<id>` credential stored. */
  async listLocalEndpointIds(): Promise<string[]> {
    await this.ensureLoaded();
    return Object.keys(this.data)
      .filter((key) => key.startsWith(LOCAL_AUTH_KEY_PREFIX))
      .map((key) => key.slice(LOCAL_AUTH_KEY_PREFIX.length));
  }

  /**
   * Write (or refresh) the credential for one local endpoint. The `baseUrl` is
   * what `effectiveBaseUrl` later picks up, and `accessToken` is the endpoint's
   * key — a placeholder for the servers that ignore it.
   */
  async setLocalEndpoint(endpointId: string, baseUrl: string, apiKey?: string): Promise<void> {
    await this.setCredentials(`${LOCAL_AUTH_KEY_PREFIX}${endpointId}`, {
      accessToken: apiKey && apiKey.length > 0 ? apiKey : LOCAL_NO_API_KEY,
      refreshToken: "",
      expiresAt: Date.now() + LOCAL_CREDENTIAL_LIFETIME_MS,
      baseUrl,
    });
  }

  /** Remove one local endpoint's credential. No-op when it isn't stored. */
  async removeLocalEndpoint(endpointId: string): Promise<void> {
    await this.clearCredentials(`${LOCAL_AUTH_KEY_PREFIX}${endpointId}`);
  }

  /**
   * True if the active credential for `provider` is a static API key with no
   * refresh mechanism. For a dual-auth provider this is only true when its OAuth
   * credential is absent or sidelined (a live OAuth credential is refreshable).
   */
  async isStaticApiKey(provider: string): Promise<boolean> {
    await this.ensureFresh();
    const dual = dualAuthProvider(provider);
    const oauthCreds = dual ? this.data[dual.oauthKey] : undefined;
    if (dual && oauthCreds) {
      // A usage-exhausted plan sign-in with an API key configured means the
      // API key is what actually resolves right now — treat it as the static
      // key it is (so a 401 clears the key instead of pointlessly
      // force-refreshing the sidelined token).
      const exhaustedUntil = oauthCreds.usageExhaustedUntil ?? 0;
      const apiKeyActive =
        Date.now() < exhaustedUntil && Boolean(usableEntry(this.data, dual.provider));
      if (!apiKeyActive) return false;
    }
    return !REFRESHABLE_STORAGE_KEYS.has(provider);
  }

  /**
   * The base URL on the credential that is active right now, if any.
   * Synchronous — call only after load()/resolveCredentials() populated the
   * snapshot. For a dual-auth provider this is the plan endpoint whenever the
   * sign-in is the one resolveCredentials would serve (i.e. not currently
   * usage-exhausted with an API key configured); for a plan/pay-per-token key
   * split it is the plan key's endpoint when one is stored.
   */
  getStoredBaseUrl(provider: string): string | undefined {
    return activeBaseUrlEntry(this.data, provider)?.baseUrl;
  }

  async load(): Promise<void> {
    // A reload (the file changed under us) is routine — log it once at first
    // load so ~/.gg/debug.log doesn't fill with identical lines on every read.
    const first = !this.loaded;
    await withFileLock(this.filePath, async () => {
      try {
        const content = await fs.readFile(this.filePath, "utf-8");
        this.data = JSON.parse(content) as AuthData;
        if (first) {
          log("INFO", "auth", `Loaded credentials from ${this.filePath}`, {
            providers: Object.keys(this.data).join(",") || "(none)",
          });
        }
      } catch (err) {
        this.data = {};
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          if (first) log("INFO", "auth", `No auth file found at ${this.filePath} (first run)`);
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
    await this.rememberSnapshot();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /**
   * Like {@link ensureLoaded}, but re-reads when the file changed since this
   * snapshot — a cheap stat, not a re-parse. Used by the "what is connected?"
   * readers, which must reflect writes made by another window, the CLI, or the
   * desktop app's native (daemon-free) API-key and disconnect paths.
   *
   * Deliberately NOT used by {@link resolveCredentials}: that path compares the
   * caller's snapshot against the latest file to detect a concurrent re-login,
   * and silently refreshing this instance's view first would destroy the
   * evidence that the token it just had rejected has already been replaced.
   */
  private async ensureFresh(): Promise<void> {
    if (!this.loaded) {
      await this.load();
      return;
    }
    let changed: boolean;
    try {
      const stat = await fs.stat(this.filePath);
      changed =
        stat.ino !== this.snapshotIno ||
        stat.mtimeMs !== this.snapshotMtimeMs ||
        stat.size !== this.snapshotSize;
    } catch {
      // File is gone (logged out everywhere) — reload only if we still hold one.
      changed = this.snapshotSize !== -1;
    }
    if (changed) await this.load();
  }

  /**
   * Record the file identity behind the current snapshot, so {@link ensureLoaded}
   * can tell "someone else wrote" from "this is our own write".
   */
  private async rememberSnapshot(): Promise<void> {
    try {
      const stat = await fs.stat(this.filePath);
      this.snapshotMtimeMs = stat.mtimeMs;
      this.snapshotSize = stat.size;
      this.snapshotIno = stat.ino;
    } catch {
      this.snapshotMtimeMs = 0;
      this.snapshotSize = -1;
      this.snapshotIno = 0;
    }
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
    await this.rememberSnapshot();
  }

  private async reloadLatest(): Promise<void> {
    await withFileLock(this.filePath, async () => {
      this.data = await readAuthData(this.filePath);
    });
    await this.rememberSnapshot();
  }

  async getCredentials(provider: string): Promise<OAuthCredentials | undefined> {
    await this.ensureFresh();
    return this.data[provider];
  }

  /**
   * A MiniMax key saved without an endpoint (every key, until its first use)
   * gets the endpoint of the region that issued it, saved so the check runs
   * once. Without this a Mainland China key went to the Global API, got a 401,
   * and was deleted as invalid.
   */
  private async withMiniMaxRegion(creds: OAuthCredentials): Promise<OAuthCredentials> {
    const baseUrl = await this.detectMiniMaxRegion(creds.accessToken);
    if (!baseUrl) return creds;
    log("INFO", "auth", `MiniMax key belongs to ${baseUrl} — saved for future requests`);
    await this.mutateLatest((latest) => {
      const current = latest["minimax"];
      // Only annotate the key that was probed; a key replaced meanwhile is re-checked.
      if (current?.accessToken === creds.accessToken && !current.baseUrl) {
        current.baseUrl = baseUrl;
      }
    });
    return { ...creds, baseUrl };
  }

  /**
   * A Kimi Code key saved without an endpoint gets the host that issued it
   * (`api.kimi.com` or `api.kimi.ai`), saved so the check runs once.
   */
  private async withKimiRegion(creds: OAuthCredentials): Promise<OAuthCredentials> {
    const baseUrl = await this.detectKimiRegion(creds.accessToken);
    if (!baseUrl) return { ...creds, baseUrl: KIMI_CODE_DEFAULT_BASE_URL };
    log("INFO", "auth", `Kimi Code key belongs to ${baseUrl} — saved for future requests`);
    await this.mutateLatest((latest) => {
      const current = latest[KIMI_CODE_KEY];
      if (current?.accessToken === creds.accessToken && !current.baseUrl) {
        current.baseUrl = baseUrl;
      }
    });
    return { ...creds, baseUrl };
  }

  /**
   * Store `creds` under `storageKey`. Connecting a provider again also removes
   * its retired sign-in, which is what the reconnect notice asked for.
   */
  async setCredentials(storageKey: string, creds: OAuthCredentials): Promise<void> {
    const provider = storageKeyProvider(storageKey);
    await this.mutateLatest((latest) => {
      for (const retired of RETIRED_SIGN_INS) {
        if (retired.provider !== provider || retired.storageKey === storageKey) continue;
        if (isRetiredEntry(retired, latest[retired.storageKey])) delete latest[retired.storageKey];
      }
      latest[storageKey] = creds;
    });
  }

  /**
   * After a 401, move a regional key to the cluster that issued it instead of
   * treating it as invalid. Only the Xiaomi Token Plan is regional: every key
   * used to go to Singapore, so Europe and China keys were rejected and deleted.
   * Returns the new base URL, or undefined when no other cluster accepts the key.
   */
  async relocateRegionalApiKey(storageKeys: string[]): Promise<string | undefined> {
    const key = await this.pickStorageKey(storageKeys);
    const creds = key === "xiaomi" ? this.data[key] : undefined;
    if (!creds) return undefined;
    const baseUrl = await this.detectXiaomiCluster(creds.accessToken);
    if (!baseUrl || baseUrl === creds.baseUrl) return undefined;
    await this.mutateLatest((latest) => {
      const current = latest["xiaomi"];
      if (current?.accessToken === creds.accessToken) current.baseUrl = baseUrl;
    });
    log("INFO", "auth", `Xiaomi Token Plan key belongs to ${baseUrl} — saved for future requests`);
    return baseUrl;
  }

  // Keeps local-endpoint keys: they're the user's own config, and a 401 there is often a busy gateway.
  async clearRejectedApiKey(storageKey: string): Promise<boolean> {
    if (storageKey.startsWith(LOCAL_AUTH_KEY_PREFIX)) return false;
    await this.clearCredentials(storageKey);
    return true;
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
   * future, `resolveCredentials("openai")` serves the OpenAI API key instead of
   * the ChatGPT plan sign-in (when both are configured) — the plan stays the
   * preferred credential and is retried automatically once the mark
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
   *
   * If `forceRefresh` is true, refreshes even if the token hasn't expired
   * (useful when the provider rejects a token with 401 before its stored
   * expiry). Callers recovering from a rejection should also pass
   * `rejectedToken` — see the stampede guard below.
   *
   * Throws if not logged in.
   */
  async resolveCredentials(
    provider: string,
    opts?: {
      forceRefresh?: boolean;
      storageKeys?: string[];
      /**
       * The access token the provider just rejected. Refreshing an OAuth grant
       * invalidates the previous access token, so N processes sharing auth.json
       * (app windows, CLI sessions, the usage poller) can otherwise revoke each
       * other in a loop: each one force-refreshes on 401, and every refresh kills
       * the token the others still hold. Naming the rejected token lets the
       * refresh path tell "this credential is genuinely dead" from "someone else
       * already rotated it" and simply adopt the newer on-disk credential.
       */
      rejectedToken?: string;
    },
  ): Promise<OAuthCredentials> {
    // Pick up a rotation performed by another process before serving a cached
    // token. Long-lived processes (the desktop sidecar runs for days) would
    // otherwise keep handing out an access token that a sibling's refresh
    // already invalidated — the "it logged me out again" failure.
    //
    // Skipped for a forced refresh on purpose: that path compares the caller's
    // snapshot against the latest file to detect a concurrent re-login, and
    // refreshing this instance's view first would destroy that evidence.
    if (opts?.forceRefresh) {
      await this.ensureLoaded();
    } else {
      await this.ensureFresh();
    }

    // A failed refresh removes the credential from this session's cache. If
    // the user then re-logs in through another app session, recover that new
    // on-disk credential instead of remaining "not logged in" until restart.
    const directStorageKeys =
      opts?.storageKeys && !(opts.storageKeys.length === 1 && opts.storageKeys[0] === provider)
        ? opts.storageKeys
        : providerStorageKeys(provider);
    if (
      !directStorageKeys.some((key) => Boolean(usableEntry(this.data, key))) &&
      !(provider === "anthropic" && this.data[CLAUDE_CODE_AUTH_KEY])
    ) {
      await this.reloadLatest();
    }

    // Explicit ordered storage-key override (e.g. Kimi: prefer the Kimi Code
    // plan key, fall back to the Moonshot key if only that's configured).
    // Bypasses the provider-name resolution below entirely when given. A
    // single-entry list equal to `[provider]` falls through to normal
    // resolution below.
    if (opts?.storageKeys && !(opts.storageKeys.length === 1 && opts.storageKeys[0] === provider)) {
      for (const key of opts.storageKeys) {
        const creds = usableEntry(this.data, key);
        if (!creds) continue;
        // A plan sign-in storage key must still refresh, so resolve it as its
        // own provider instead of returning a possibly expired token.
        if (key !== provider && dualAuthProviderByOAuthKey(key)) {
          return await this.resolveCredentials(key, {
            ...(opts.forceRefresh ? { forceRefresh: true } : {}),
            ...(opts.rejectedToken !== undefined ? { rejectedToken: opts.rejectedToken } : {}),
          });
        }
        // The provider's own key in an ordered list resolves through the normal
        // path, so a dual-auth provider still prefers its plan sign-in.
        if (key === provider) {
          return await this.resolveCredentials(provider, {
            ...(opts.forceRefresh ? { forceRefresh: true } : {}),
            ...(opts.rejectedToken !== undefined ? { rejectedToken: opts.rejectedToken } : {}),
          });
        }
        if (key === KIMI_CODE_KEY && !creds.baseUrl) return await this.withKimiRegion(creds);
        return creds;
      }
      throw new NotLoggedInError(provider);
    }

    // Signed in with Claude through Claude Code: there is no token to hand
    // out (Claude Code holds it). Callers on that route never use this one.
    if (
      provider === "anthropic" &&
      (!this.data.anthropic || isLegacyClaudeOAuth(this.data.anthropic))
    ) {
      if (isClaudeCodeAuthMarker(this.data[CLAUDE_CODE_AUTH_KEY])) {
        return { accessToken: "", refreshToken: "", expiresAt: Number.MAX_SAFE_INTEGER };
      }
      // The old GG Claude sign-in token can't be used or refreshed any more.
      if (this.data.anthropic) throw new NotLoggedInError(provider);
    }

    // Prefer the plan sign-in over the API key for a dual-auth provider
    // (OpenAI). When a sign-in exists, resolve (and refresh) that instead.
    const dual = dualAuthProvider(provider);
    const dualOAuthCreds = dual ? this.data[dual.oauthKey] : undefined;
    const dualApiKey = dual ? usableEntry(this.data, dual.provider) : undefined;
    if (dual && dualOAuthCreds) {
      // OAuth plan usage window exhausted (marked by the agent loop when the
      // subscription endpoint rejected with a usage/quota stop). Serve the API
      // key while the window recovers — but ONLY when one is configured; with no
      // API key the OAuth credential still resolves so the real usage-limit
      // error (with its reset time) surfaces to the user instead of a
      // misleading "not logged in".
      const exhaustedUntil = dualOAuthCreds.usageExhaustedUntil ?? 0;
      if (Date.now() < exhaustedUntil && dualApiKey) {
        log(
          "WARN",
          "auth",
          `${dual.oauthLabel} usage window is exhausted — using the ${dual.apiKeyLabel} until ` +
            `${new Date(exhaustedUntil).toISOString()} (OAuth resumes automatically).`,
        );
        return dualApiKey;
      }
      try {
        // Do NOT forward `storageKeys` here: the caller's keys (e.g.
        // AgentSession's ["openai"]) don't match the recursive provider
        // ("openai-chatgpt"), so forwarding them would trip the storage-key
        // override branch and silently return the raw API key.
        return await this.resolveCredentials(dual.oauthKey, {
          ...(opts?.forceRefresh ? { forceRefresh: true } : {}),
          ...(opts?.rejectedToken !== undefined ? { rejectedToken: opts.rejectedToken } : {}),
        });
      } catch (err) {
        // OAuth refresh token is dead and was wiped. Fall back to the API key if
        // the user also configured one. This is a billing switch (subscription →
        // metered key), so make it loud in the debug log rather than silent —
        // the user expects OAuth to stay active and should know a re-login is
        // needed to restore it.
        if (err instanceof NotLoggedInError && dualApiKey) {
          log(
            "WARN",
            "auth",
            `${dual.oauthLabel} credential is no longer valid — falling back to the ` +
              `${dual.apiKeyLabel}. ${dual.restoreHint}`,
          );
          return dualApiKey;
        }
        throw err;
      }
    }

    // A retired sign-in (old Codex token in the `openai` key slot, …) is never
    // served — above all never as an API key.
    const creds = usableEntry(this.data, provider);
    if (!creds) {
      throw new NotLoggedInError(provider);
    }

    // Static API keys have no refresh mechanism; only the ChatGPT plan
    // sign-in refreshes below.
    if (!REFRESHABLE_STORAGE_KEYS.has(provider)) {
      if (provider === "minimax" && !creds.baseUrl) return await this.withMiniMaxRegion(creds);
      if (provider === KIMI_CODE_KEY && !creds.baseUrl) return await this.withKimiRegion(creds);
      return creds;
    }

    // Return if not expired (with a safety skew) and not force-refreshing
    if (!opts?.forceRefresh && Date.now() < creds.expiresAt - refreshThresholdMs(creds)) {
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
      // The caller named the token the provider rejected, and disk now holds a
      // different one: a sibling process already rotated this grant. Minting
      // another token here would invalidate the one that sibling is using and
      // keep the mutual-revocation loop going.
      const rotatedBySibling =
        opts?.rejectedToken !== undefined && latestCreds.accessToken !== opts.rejectedToken;
      if (
        credentialWasReplaced ||
        rotatedBySibling ||
        (!opts?.forceRefresh &&
          Date.now() < latestCreds.expiresAt - refreshThresholdMs(latestCreds))
      ) {
        // Another process refreshed or re-logged in while this session still
        // held the rejected token. Trust that replacement even for a forced
        // refresh; retrying the revoked OLD refresh token would delete the new
        // login that just landed on disk.
        if (rotatedBySibling && !credentialWasReplaced) {
          log(
            "INFO",
            "auth",
            `${provider} token was rotated by another gg process — adopting it instead of refreshing again`,
          );
        }
        this.data = latest;
        return latestCreds;
      }

      let refreshed: OAuthCredentials;
      try {
        refreshed = await refreshChatGPTToken(latestCreds);
      } catch (err) {
        // Refresh token revoked / expired / invalid → the stored creds are
        // unusable. Delete only this provider from the latest snapshot so a
        // failed refresh can never erase another provider's concurrent login.
        const msg = err instanceof Error ? err.message : String(err);
        const isAuthFailure =
          /\((401|400)\)/.test(msg) ||
          /invalid_grant|invalid_token|invalid.*refresh|token_expired|refresh_token_(?:expired|invalidated|reused)/i.test(
            msg,
          ) ||
          /unauthorized/i.test(msg);
        if (isAuthFailure) {
          // Re-read before deleting. The refresh ran over the network while
          // the file lock can be broken by a waiter (5s wait vs 30s request);
          // a sibling may have refreshed with this grant or re-logged in
          // meanwhile, so the rejection only proves OUR token is dead.
          // Writing the pre-request snapshot back would erase their fresh
          // login and sign every window out.
          const current = await readAuthData(this.filePath);
          const currentCreds = current[provider];
          if (currentCreds && currentCreds.refreshToken !== latestCreds.refreshToken) {
            log(
              "WARN",
              "auth",
              `${provider} token refresh was rejected, but another gg process already saved a newer credential — adopting it instead of signing out`,
            );
            this.data = current;
            return currentCreds;
          }
          delete current[provider];
          this.data = current;
          await atomicWriteFile(this.filePath, JSON.stringify(current, null, 2));
          throw new NotLoggedInError(provider);
        }
        throw err;
      }
      // The refresh response carries tokens only; keep the identity and
      // routing fields saved at sign-in.
      refreshed = {
        ...pick(latestCreds, ["accountId", "baseUrl", "clientId", "idToken", "scopes"]),
        ...refreshed,
      };
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
      // The refresh path rewrites auth.json and updates `this.data` in step, so
      // re-stamp the snapshot: otherwise the next ensureFresh() sees its own
      // write as a foreign change and re-reads the file on every resolve.
      await this.rememberSnapshot();
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

function pick<T extends object, K extends keyof T>(value: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
  return out;
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
