import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuthStorage,
  GEMINI_API_KEY,
  GEMINI_API_KEY_BASE_URL,
  MOONSHOT_OAUTH_KEY,
  NotLoggedInError,
  XAI_OAUTH_KEY,
  XIAOMI_CREDITS_KEY,
  dualAuthProvider,
  providerStorageKeys,
  readStoredBaseUrlSync,
} from "./auth-storage.js";
import { isHiddenProvider } from "./hidden-providers.js";

const refreshOpenAIToken = vi.hoisted(() => vi.fn());
vi.mock("./oauth/openai.js", () => ({ refreshOpenAIToken }));
const refreshGeminiToken = vi.hoisted(() => vi.fn());
vi.mock("./oauth/gemini.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshGeminiToken,
}));
const refreshKimiToken = vi.hoisted(() => vi.fn());
vi.mock("./oauth/kimi.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refreshKimiToken,
}));

async function tempAuthFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-core-auth-storage-test-"));
  return path.join(dir, "auth.json");
}

const tmpFiles: string[] = [];

afterEach(async () => {
  refreshOpenAIToken.mockReset();
  while (tmpFiles.length > 0) {
    const f = tmpFiles.pop()!;
    await fs.rm(path.dirname(f), { recursive: true, force: true }).catch(() => {});
  }
});

async function makeStorage(): Promise<AuthStorage> {
  const filePath = await tempAuthFile();
  tmpFiles.push(filePath);
  return new AuthStorage(filePath);
}

function oauthCreds(accessToken: string, refreshToken = `${accessToken}-refresh`) {
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 1_000_000,
  };
}

describe("AuthStorage — shared-file concurrency", () => {
  it("preserves provider logins written by stale storage instances", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const firstSession = new AuthStorage(filePath);
    const secondSession = new AuthStorage(filePath);
    await Promise.all([firstSession.load(), secondSession.load()]);

    await firstSession.setCredentials("anthropic", oauthCreds("anthropic-token"));
    await secondSession.setCredentials("openai", oauthCreds("openai-token"));

    const reloaded = new AuthStorage(filePath);
    expect(await reloaded.listProviders()).toEqual(["anthropic", "openai"]);
  });

  it("deletes only the requested provider from the latest snapshot", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const staleSession = new AuthStorage(filePath);
    await staleSession.setCredentials("anthropic", oauthCreds("anthropic-token"));
    await staleSession.setCredentials("openai", oauthCreds("openai-token"));

    const otherSession = new AuthStorage(filePath);
    await otherSession.setCredentials("gemini", oauthCreds("gemini-token"));
    await staleSession.clearCredentials("anthropic");

    const reloaded = new AuthStorage(filePath);
    expect(await reloaded.listProviders()).toEqual(["openai", "gemini"]);
  });

  it("uses a concurrent re-login instead of refreshing and deleting the rejected old token", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const runningSession = new AuthStorage(filePath);
    await runningSession.setCredentials("openai", oauthCreds("old-token", "revoked-refresh"));

    const loginSession = new AuthStorage(filePath);
    await loginSession.setCredentials("openai", oauthCreds("new-token", "new-refresh"));

    const resolved = await runningSession.resolveCredentials("openai", { forceRefresh: true });
    expect(resolved.accessToken).toBe("new-token");
    expect(refreshOpenAIToken).not.toHaveBeenCalled();
    expect((await new AuthStorage(filePath).getCredentials("openai"))?.accessToken).toBe(
      "new-token",
    );
  });

  it("recovers a re-login after this session already removed its expired credential", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const runningSession = new AuthStorage(filePath);
    await runningSession.setCredentials("anthropic", oauthCreds("expired-token"));
    await runningSession.clearCredentials("anthropic");

    const loginSession = new AuthStorage(filePath);
    await loginSession.setCredentials("anthropic", oauthCreds("relogged-token"));

    expect((await runningSession.resolveCredentials("anthropic")).accessToken).toBe(
      "relogged-token",
    );
  });

  it("sees a credential another writer added, without waiting for a restart", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const daemon = new AuthStorage(filePath);
    // The daemon answers "what is connected?" from a cached snapshot. Prime it
    // while logged out — the state a user is in right before connecting.
    expect(await daemon.hasProviderAuth("xai")).toBe(false);

    // The desktop app writes API keys and disconnects NATIVELY (they must work
    // with no daemon running), so the daemon never sees the mutation go by. A
    // load-once cache left it listing stale models until the app restarted.
    await new AuthStorage(filePath).setCredentials("xai", oauthCreds("key"));
    expect(await daemon.hasProviderAuth("xai")).toBe(true);
    expect(await daemon.listProviders()).toContain("xai");

    // And the reverse: a disconnect elsewhere must stop reporting it connected.
    await new AuthStorage(filePath).clearCredentials("xai");
    expect(await daemon.hasProviderAuth("xai")).toBe(false);
  });

  it("serves a sibling process's rotated token instead of a stale cached one", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    // A long-lived process (the desktop sidecar runs for days) caches the
    // credential it resolved at startup.
    const sidecar = new AuthStorage(filePath);
    await sidecar.setCredentials("openai", oauthCreds("token-a"));
    expect((await sidecar.resolveCredentials("openai")).accessToken).toBe("token-a");

    // Any sibling (another window, a CLI session) refreshing the grant
    // invalidates token-a server-side. Serving it from cache is what surfaced
    // as a random mid-session authentication_error.
    await new AuthStorage(filePath).setCredentials("openai", oauthCreds("token-b"));

    expect((await sidecar.resolveCredentials("openai")).accessToken).toBe("token-b");
    expect(refreshOpenAIToken).not.toHaveBeenCalled();
  });

  it("detects a rotated token when replacement size and mtime match the cached file", async () => {
    const sidecar = await makeStorage();
    const timestamp = new Date("2026-01-01T00:00:00Z");
    await sidecar.setCredentials("openai", oauthCreds("token-a"));
    await fs.utimes(sidecar.path, timestamp, timestamp);
    await sidecar.load();
    const before = await fs.stat(sidecar.path);
    expect((await sidecar.resolveCredentials("openai")).accessToken).toBe("token-a");

    await new AuthStorage(sidecar.path).setCredentials("openai", oauthCreds("token-b"));
    await fs.utimes(sidecar.path, timestamp, timestamp);
    const after = await fs.stat(sidecar.path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).not.toBe(before.ino);

    expect((await sidecar.resolveCredentials("openai")).accessToken).toBe("token-b");
    expect(refreshOpenAIToken).not.toHaveBeenCalled();
  });

  it("adopts a sibling's token on 401 instead of minting one that revokes theirs", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const sessionA = new AuthStorage(filePath);
    await sessionA.setCredentials("openai", oauthCreds("token-a"));
    await sessionA.resolveCredentials("openai");

    // Sibling rotates the grant; sessionA's in-flight request 401s as a result.
    await new AuthStorage(filePath).setCredentials("openai", oauthCreds("token-b"));

    const recovered = await sessionA.resolveCredentials("openai", {
      forceRefresh: true,
      rejectedToken: "token-a",
    });

    // Refreshing here would mint token-c and revoke token-b — breaking the
    // sibling and starting a mutual-revocation cascade across processes.
    expect(recovered.accessToken).toBe("token-b");
    expect(refreshOpenAIToken).not.toHaveBeenCalled();
  });

  it("still refreshes when the rejected token is the one on disk", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const session = new AuthStorage(filePath);
    await session.setCredentials("openai", oauthCreds("token-a"));
    refreshOpenAIToken.mockResolvedValue({
      accessToken: "token-fresh",
      refreshToken: "refresh-fresh",
      expiresAt: Date.now() + 1_000_000,
    });

    // Nobody else rotated it, so this credential is genuinely dead and a real
    // refresh is the only recovery.
    const refreshed = await session.resolveCredentials("openai", {
      forceRefresh: true,
      rejectedToken: "token-a",
    });

    expect(refreshed.accessToken).toBe("token-fresh");
    expect(refreshOpenAIToken).toHaveBeenCalledTimes(1);
  });

  it("keeps a sibling's newer login when its own refresh is rejected mid-request", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const session = new AuthStorage(filePath);
    await session.setCredentials("openai", oauthCreds("token-a"));
    await session.setCredentials("anthropic", oauthCreds("anthropic-token"));

    // While this refresh is in flight, a sibling (which broke the file lock)
    // refreshes the same grant and saves token-b; ours is then rejected as reused.
    refreshOpenAIToken.mockImplementation(async () => {
      const disk = JSON.parse(await fs.readFile(filePath, "utf-8"));
      disk.openai = oauthCreds("token-b");
      await fs.writeFile(filePath, JSON.stringify(disk));
      throw new Error("OpenAI token refresh failed (400): invalid_grant");
    });

    const recovered = await session.resolveCredentials("openai", { forceRefresh: true });

    // Deleting from the pre-request snapshot used to wipe token-b from disk and
    // sign every window out ("Not logged in"), forcing a manual re-login.
    expect(recovered.accessToken).toBe("token-b");
    const onDisk = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(onDisk.openai.accessToken).toBe("token-b");
    expect(onDisk.anthropic.accessToken).toBe("anthropic-token");
  });

  it("still signs out when the rejected refresh token is the one on disk", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const session = new AuthStorage(filePath);
    await session.setCredentials("openai", oauthCreds("token-a"));
    await session.setCredentials("anthropic", oauthCreds("anthropic-token"));
    refreshOpenAIToken.mockRejectedValue(
      new Error("OpenAI token refresh failed (400): invalid_grant"),
    );

    await expect(session.resolveCredentials("openai", { forceRefresh: true })).rejects.toThrow(
      NotLoggedInError,
    );
    const onDisk = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(onDisk.openai).toBeUndefined();
    expect(onDisk.anthropic.accessToken).toBe("anthropic-token");
  });
});

describe("AuthStorage — proactive refresh threshold (kimi-code parity)", () => {
  // A short-lived token (15-min lifetime, like Kimi) must refresh at its
  // halfway point, not 60s before expiry. Ported from MoonshotAI/kimi-code's
  // defaultRefreshThreshold = max(300s, expiresIn * 0.5).
  it("refreshes a 15-min token once it is within the lifetime-scaled threshold", async () => {
    const storage = await makeStorage();
    // 6 min left on a 15-min token → inside the 7.5-min threshold → refresh.
    await storage.setCredentials("openai", {
      ...oauthCreds("live-15m"),
      expiresAt: Date.now() + 6 * 60_000,
      expiresIn: 15 * 60,
    });
    refreshOpenAIToken.mockResolvedValue({
      ...oauthCreds("refreshed-15m"),
      expiresAt: Date.now() + 15 * 60_000,
      expiresIn: 15 * 60,
    });

    const resolved = await storage.resolveCredentials("openai");
    expect(refreshOpenAIToken).toHaveBeenCalledOnce();
    expect(resolved.accessToken).toBe("refreshed-15m");
  });

  it("does not refresh a 15-min token still outside the threshold", async () => {
    const storage = await makeStorage();
    // 9 min left on a 15-min token → outside the 7.5-min threshold → keep.
    await storage.setCredentials("openai", {
      ...oauthCreds("live-9m"),
      expiresAt: Date.now() + 9 * 60_000,
      expiresIn: 15 * 60,
    });

    const resolved = await storage.resolveCredentials("openai");
    expect(refreshOpenAIToken).not.toHaveBeenCalled();
    expect(resolved.accessToken).toBe("live-9m");
  });

  it("falls back to the 5-min floor when lifetime is unknown", async () => {
    const storage = await makeStorage();
    // No expiresIn (legacy credential): threshold floors at 300s. 4 min left
    // → inside the floor → refresh.
    await storage.setCredentials("openai", {
      ...oauthCreds("legacy-live"),
      expiresAt: Date.now() + 4 * 60_000,
    });
    refreshOpenAIToken.mockResolvedValue({
      ...oauthCreds("legacy-refreshed"),
      expiresAt: Date.now() + 60 * 60_000,
    });

    const resolved = await storage.resolveCredentials("openai");
    expect(refreshOpenAIToken).toHaveBeenCalledOnce();
    expect(resolved.accessToken).toBe("legacy-refreshed");
  });
});

describe("AuthStorage — Xiaomi dual credential (Token Plan vs. API Credits)", () => {
  it("hasProviderAuth is satisfied by either the Token Plan or the Credits key", async () => {
    const storage = await makeStorage();
    expect(await storage.hasProviderAuth("xiaomi")).toBe(false);

    await storage.setCredentials("xiaomi", {
      accessToken: "tp-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    });
    expect(await storage.hasProviderAuth("xiaomi")).toBe(true);

    const credsOnly = await makeStorage();
    await credsOnly.setCredentials(XIAOMI_CREDITS_KEY, {
      accessToken: "credits-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
      baseUrl: "https://api.xiaomimimo.com/v1",
    });
    expect(await credsOnly.hasProviderAuth("xiaomi")).toBe(true);
  });

  it("resolveCredentials with explicit storageKeys reads the first match directly, bypassing the provider id", async () => {
    const storage = await makeStorage();
    await storage.setCredentials(XIAOMI_CREDITS_KEY, {
      accessToken: "credits-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
      baseUrl: "https://api.xiaomimimo.com/v1",
    });

    // No plain "xiaomi" credential exists — a storageKeys-less resolve fails...
    await expect(storage.resolveCredentials("xiaomi")).rejects.toThrow(NotLoggedInError);

    // ...but resolving with the ordered storage keys succeeds and returns the
    // Credits credential untouched (no refresh attempted — static API key).
    const creds = await storage.resolveCredentials("xiaomi", {
      storageKeys: [XIAOMI_CREDITS_KEY],
    });
    expect(creds.accessToken).toBe("credits-key");
    expect(creds.baseUrl).toBe("https://api.xiaomimimo.com/v1");
  });

  it("refreshes an expired OAuth credential reached through storageKeys (Kimi K2.8 Preview)", async () => {
    const storage = await makeStorage();
    await storage.setCredentials(MOONSHOT_OAUTH_KEY, {
      accessToken: "stale",
      refreshToken: "kimi-refresh",
      expiresAt: Date.now() - 1_000,
      baseUrl: "https://api.kimi.com/coding/v1",
    });
    refreshKimiToken.mockResolvedValueOnce({
      accessToken: "fresh",
      refreshToken: "kimi-refresh-2",
      expiresAt: Date.now() + 1_000_000,
      baseUrl: "https://api.kimi.com/coding/v1",
    });

    const creds = await storage.resolveCredentials("moonshot", {
      storageKeys: [MOONSHOT_OAUTH_KEY],
    });

    expect(refreshKimiToken).toHaveBeenCalledTimes(1);
    expect(creds.accessToken).toBe("fresh");
  });

  it("uses a Gemini API key first, and still refreshes the Google sign-in when it is the only one", async () => {
    const keys = [GEMINI_API_KEY, "gemini"];
    const both = await makeStorage();
    await both.setCredentials("gemini", oauthCreds("oauth-token"));
    await both.setCredentials(GEMINI_API_KEY, {
      accessToken: "aistudio-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
      baseUrl: GEMINI_API_KEY_BASE_URL,
    });
    const picked = await both.resolveCredentials("gemini", { storageKeys: keys });
    // The key carries the public API base URL — the transport routes on it.
    expect(picked).toMatchObject({ accessToken: "aistudio-key", baseUrl: GEMINI_API_KEY_BASE_URL });
    // Credentials still resolve while Gemini is hidden; it just isn't "connected".
    expect(await both.hasProviderAuth("gemini")).toBe(!isHiddenProvider("gemini"));

    // OAuth only, and expired: reached through the list, it must still refresh.
    const oauthOnly = await makeStorage();
    await oauthOnly.setCredentials("gemini", {
      accessToken: "stale",
      refreshToken: "g-refresh",
      expiresAt: Date.now() - 1_000,
    });
    refreshGeminiToken.mockResolvedValueOnce({
      accessToken: "fresh",
      refreshToken: "g-refresh-2",
      expiresAt: Date.now() + 1_000_000,
    });
    const refreshed = await oauthOnly.resolveCredentials("gemini", { storageKeys: keys });
    expect(refreshGeminiToken).toHaveBeenCalledTimes(1);
    expect(refreshed.accessToken).toBe("fresh");

    // API key only satisfies hasProviderAuth too.
    const keyOnly = await makeStorage();
    await keyOnly.setCredentials(GEMINI_API_KEY, oauthCreds("k", ""));
    expect(await keyOnly.hasProviderAuth("gemini")).toBe(!isHiddenProvider("gemini"));
  });

  it("reports a hidden provider as not connected even with credentials on disk", async () => {
    // Pickers and startup filter on hasProviderAuth, so this is what keeps a
    // hidden provider (Gemini, for now) out of them for users with old logins.
    expect(isHiddenProvider("gemini")).toBe(true);
    const storage = await makeStorage();
    await storage.setCredentials("gemini", oauthCreds("oauth-token"));
    await storage.setCredentials(GEMINI_API_KEY, oauthCreds("k", ""));
    expect(await storage.hasProviderAuth("gemini")).toBe(false);
    // Other providers are unaffected.
    await storage.setCredentials("anthropic", oauthCreds("a"));
    expect(await storage.hasProviderAuth("anthropic")).toBe(true);
  });

  it("resolveCredentials prefers the first storageKey, falling back to the next when only that's configured", async () => {
    // Mirrors mimo-v2.6-pro: prefer Token Plan ("xiaomi"), fall back to
    // API Credits when only that's configured.
    const tokenPlanOnly = await makeStorage();
    await tokenPlanOnly.setCredentials("xiaomi", {
      accessToken: "tp-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    });
    expect(
      (
        await tokenPlanOnly.resolveCredentials("xiaomi", {
          storageKeys: ["xiaomi", XIAOMI_CREDITS_KEY],
        })
      ).accessToken,
    ).toBe("tp-key");

    const creditsOnly = await makeStorage();
    await creditsOnly.setCredentials(XIAOMI_CREDITS_KEY, {
      accessToken: "credits-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
      baseUrl: "https://api.xiaomimimo.com/v1",
    });
    expect(
      (
        await creditsOnly.resolveCredentials("xiaomi", {
          storageKeys: ["xiaomi", XIAOMI_CREDITS_KEY],
        })
      ).accessToken,
    ).toBe("credits-key");

    const both = await makeStorage();
    await both.setCredentials("xiaomi", {
      accessToken: "tp-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    });
    await both.setCredentials(XIAOMI_CREDITS_KEY, {
      accessToken: "credits-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
      baseUrl: "https://api.xiaomimimo.com/v1",
    });
    // Both configured — the FIRST preference (Token Plan) wins.
    expect(
      (await both.resolveCredentials("xiaomi", { storageKeys: ["xiaomi", XIAOMI_CREDITS_KEY] }))
        .accessToken,
    ).toBe("tp-key");
  });

  it("resolveCredentials throws NotLoggedInError when none of the requested storageKeys are configured", async () => {
    const storage = await makeStorage();
    await expect(
      storage.resolveCredentials("xiaomi", { storageKeys: [XIAOMI_CREDITS_KEY] }),
    ).rejects.toThrow(NotLoggedInError);
    await expect(
      storage.resolveCredentials("xiaomi", { storageKeys: ["xiaomi", XIAOMI_CREDITS_KEY] }),
    ).rejects.toThrow(NotLoggedInError);
  });

  it("storageKeys of exactly [provider] falls through to normal provider resolution", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("xiaomi", {
      accessToken: "tp-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    });
    const creds = await storage.resolveCredentials("xiaomi", { storageKeys: ["xiaomi"] });
    expect(creds.accessToken).toBe("tp-key");
  });

  it("pickStorageKey returns the first key with stored credentials, or undefined", async () => {
    const storage = await makeStorage();
    expect(await storage.pickStorageKey(["xiaomi", XIAOMI_CREDITS_KEY])).toBeUndefined();

    await storage.setCredentials(XIAOMI_CREDITS_KEY, {
      accessToken: "credits-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
    });
    expect(await storage.pickStorageKey(["xiaomi", XIAOMI_CREDITS_KEY])).toBe(XIAOMI_CREDITS_KEY);

    await storage.setCredentials("xiaomi", {
      accessToken: "tp-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
    });
    // Order matters — "xiaomi" is listed first.
    expect(await storage.pickStorageKey(["xiaomi", XIAOMI_CREDITS_KEY])).toBe("xiaomi");
  });
});

describe("AuthStorage — Moonshot dual credential (Kimi OAuth vs. API key)", () => {
  const oauthCreds = () => ({
    accessToken: "kimi-oauth-token",
    refreshToken: "kimi-refresh",
    expiresAt: Date.now() + 1_000_000,
    baseUrl: "https://api.kimi.com/coding/v1",
  });
  const apiKeyCreds = () => ({
    accessToken: "moonshot-api-key",
    refreshToken: "",
    expiresAt: Date.now() + 1_000_000,
  });

  it("prefers the Kimi OAuth credential when both are configured", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("moonshot", apiKeyCreds());
    await storage.setCredentials(MOONSHOT_OAUTH_KEY, oauthCreds());
    const creds = await storage.resolveCredentials("moonshot", { storageKeys: ["moonshot"] });
    expect(creds.accessToken).toBe("kimi-oauth-token");
    expect(await storage.isStaticApiKey("moonshot")).toBe(false);
  });

  it("falls back to the API key while the OAuth credential is marked usage-exhausted", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("moonshot", apiKeyCreds());
    await storage.setCredentials(MOONSHOT_OAUTH_KEY, oauthCreds());

    await storage.markUsageExhausted(MOONSHOT_OAUTH_KEY);
    const creds = await storage.resolveCredentials("moonshot", { storageKeys: ["moonshot"] });
    expect(creds.accessToken).toBe("moonshot-api-key");
    // The API key is the active credential now — a 401 should clear it, not
    // force-refresh the sidelined OAuth token.
    expect(await storage.isStaticApiKey("moonshot")).toBe(true);
  });

  it("honors a provider-stated reset time (unix seconds) for the exhaustion mark", async () => {
    const storage = await makeStorage();
    await storage.setCredentials(MOONSHOT_OAUTH_KEY, oauthCreds());
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    await storage.markUsageExhausted(MOONSHOT_OAUTH_KEY, resetsAt);
    const stored = await storage.getCredentials(MOONSHOT_OAUTH_KEY);
    expect(stored?.usageExhaustedUntil).toBe(resetsAt * 1000);
  });

  it("reports the active endpoint's baseUrl for endpoint-aware defaults", async () => {
    const storage = await makeStorage();
    // OAuth present → the managed Kimi For Coding endpoint.
    await storage.setCredentials(MOONSHOT_OAUTH_KEY, oauthCreds());
    expect(storage.getStoredBaseUrl("moonshot")).toBe("https://api.kimi.com/coding/v1");
    // The sync file read agrees (boot paths use it before AuthStorage exists).
    expect(readStoredBaseUrlSync(storage.path, "moonshot")).toBe("https://api.kimi.com/coding/v1");

    // API-key-only → no stored baseUrl (the public Moonshot API is the default).
    const keyOnly = await makeStorage();
    await keyOnly.setCredentials("moonshot", apiKeyCreds());
    expect(keyOnly.getStoredBaseUrl("moonshot")).toBeUndefined();

    // Usage-exhausted OAuth + API key configured → the key is active (public API).
    await storage.setCredentials("moonshot", apiKeyCreds());
    await storage.markUsageExhausted(MOONSHOT_OAUTH_KEY);
    expect(storage.getStoredBaseUrl("moonshot")).toBeUndefined();

    // Other providers read their own entry; unknown providers yield undefined.
    expect(storage.getStoredBaseUrl("anthropic")).toBeUndefined();
    expect(
      readStoredBaseUrlSync(path.join(os.tmpdir(), "does-not-exist.json"), "moonshot"),
    ).toBeUndefined();
  });

  it("resumes OAuth once the exhaustion mark lapses", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("moonshot", apiKeyCreds());
    const oauth = oauthCreds();
    await storage.setCredentials(MOONSHOT_OAUTH_KEY, {
      ...oauth,
      usageExhaustedUntil: Date.now() - 1_000, // already lapsed
    });
    const creds = await storage.resolveCredentials("moonshot", { storageKeys: ["moonshot"] });
    expect(creds.accessToken).toBe("kimi-oauth-token");
  });

  it("still resolves OAuth when exhausted but no API key exists (real error must surface)", async () => {
    const storage = await makeStorage();
    await storage.setCredentials(MOONSHOT_OAUTH_KEY, oauthCreds());
    await storage.markUsageExhausted(MOONSHOT_OAUTH_KEY);
    const creds = await storage.resolveCredentials("moonshot", { storageKeys: ["moonshot"] });
    expect(creds.accessToken).toBe("kimi-oauth-token");
  });

  it("markUsageExhausted is a no-op when nothing is stored under the key", async () => {
    const storage = await makeStorage();
    await storage.markUsageExhausted(MOONSHOT_OAUTH_KEY);
    expect(await storage.getCredentials(MOONSHOT_OAUTH_KEY)).toBeUndefined();
  });

  it("treats the xAI API key as a static credential when no OAuth login exists", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("xai", {
      accessToken: "xai-api-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
    });
    expect(await storage.isStaticApiKey("xai")).toBe(true);
    const creds = await storage.resolveCredentials("xai");
    expect(creds.accessToken).toBe("xai-api-key");
  });

  it("treats the Hugging Face token as a static, never-refreshed API key", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("huggingface", {
      accessToken: "hf-token",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
    });
    expect(await storage.isStaticApiKey("huggingface")).toBe(true);
    const creds = await storage.resolveCredentials("huggingface");
    expect(creds.accessToken).toBe("hf-token");
  });

  it("persists the exhaustion mark so a new process (or another app window) sees it", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const storage = new AuthStorage(filePath);
    await storage.setCredentials("moonshot", apiKeyCreds());
    await storage.setCredentials(MOONSHOT_OAUTH_KEY, oauthCreds());
    await storage.markUsageExhausted(MOONSHOT_OAUTH_KEY);

    const secondProcess = new AuthStorage(filePath);
    const creds = await secondProcess.resolveCredentials("moonshot", {
      storageKeys: ["moonshot"],
    });
    expect(creds.accessToken).toBe("moonshot-api-key");
  });
});

// Grok rides the same dual-auth policy as Kimi. These assert the POLICY is
// generic (table-driven) rather than a Moonshot special case — the exact bug the
// hardcoded provider checks would have reintroduced for every new provider.
describe("AuthStorage — xAI dual credential (Grok OAuth vs. API key)", () => {
  const oauthCreds = () => ({
    accessToken: "grok-oauth-token",
    refreshToken: "grok-refresh",
    expiresAt: Date.now() + 1_000_000,
    baseUrl: "https://cli-chat-proxy.grok.com/v1",
  });
  const apiKeyCreds = () => ({
    accessToken: "xai-api-key",
    refreshToken: "",
    expiresAt: Date.now() + 1_000_000,
  });

  it("prefers the Grok OAuth credential when both are configured", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("xai", apiKeyCreds());
    await storage.setCredentials(XAI_OAUTH_KEY, oauthCreds());
    // AgentSession passes storageKeys: ["xai"] — which must NOT shortcut past the
    // OAuth preference (the bug that once served the raw API key for Moonshot).
    const creds = await storage.resolveCredentials("xai", { storageKeys: ["xai"] });
    expect(creds.accessToken).toBe("grok-oauth-token");
    expect(creds.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(await storage.isStaticApiKey("xai")).toBe(false);
  });

  it("falls back to the API key while the OAuth credential is usage-exhausted", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("xai", apiKeyCreds());
    await storage.setCredentials(XAI_OAUTH_KEY, oauthCreds());

    await storage.markUsageExhausted(XAI_OAUTH_KEY);
    const creds = await storage.resolveCredentials("xai", { storageKeys: ["xai"] });
    expect(creds.accessToken).toBe("xai-api-key");
    // The key is active now, so its endpoint (public api.x.ai default) applies and
    // a 401 should clear it instead of force-refreshing the sidelined token.
    expect(storage.getStoredBaseUrl("xai")).toBeUndefined();
    expect(await storage.isStaticApiKey("xai")).toBe(true);
  });

  it("keeps serving OAuth when exhausted with no API key (real error must surface)", async () => {
    const storage = await makeStorage();
    await storage.setCredentials(XAI_OAUTH_KEY, oauthCreds());
    await storage.markUsageExhausted(XAI_OAUTH_KEY);
    const creds = await storage.resolveCredentials("xai", { storageKeys: ["xai"] });
    expect(creds.accessToken).toBe("grok-oauth-token");
  });

  it("resumes OAuth once the exhaustion mark lapses", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("xai", apiKeyCreds());
    await storage.setCredentials(XAI_OAUTH_KEY, {
      ...oauthCreds(),
      usageExhaustedUntil: Date.now() - 1_000,
    });
    const creds = await storage.resolveCredentials("xai", { storageKeys: ["xai"] });
    expect(creds.accessToken).toBe("grok-oauth-token");
  });

  it("reports the Grok CLI proxy as the active endpoint while OAuth is live", async () => {
    const storage = await makeStorage();
    await storage.setCredentials(XAI_OAUTH_KEY, oauthCreds());
    expect(storage.getStoredBaseUrl("xai")).toBe("https://cli-chat-proxy.grok.com/v1");
    // Boot paths read the file synchronously before AuthStorage exists — agree.
    expect(readStoredBaseUrlSync(storage.path, "xai")).toBe("https://cli-chat-proxy.grok.com/v1");
  });

  it("either credential satisfies hasProviderAuth", async () => {
    const storage = await makeStorage();
    expect(await storage.hasProviderAuth("xai")).toBe(false);
    await storage.setCredentials(XAI_OAUTH_KEY, oauthCreds());
    expect(await storage.hasProviderAuth("xai")).toBe(true);

    const keyOnly = await makeStorage();
    await keyOnly.setCredentials("xai", apiKeyCreds());
    expect(await keyOnly.hasProviderAuth("xai")).toBe(true);
  });

  it("exposes both storage keys in resolution order", () => {
    expect(providerStorageKeys("xai")).toEqual([XAI_OAUTH_KEY, "xai"]);
    expect(providerStorageKeys("moonshot")).toEqual([MOONSHOT_OAUTH_KEY, "moonshot"]);
    // Single-method providers are unaffected.
    expect(providerStorageKeys("anthropic")).toEqual(["anthropic"]);
    expect(dualAuthProvider("anthropic")).toBeUndefined();
  });
});
