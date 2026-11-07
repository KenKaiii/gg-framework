import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuthStorage,
  GEMINI_API_KEY,
  GEMINI_API_KEY_BASE_URL,
  KIMI_CODE_KEY,
  NotLoggedInError,
  OPENAI_CHATGPT_KEY,
  XIAOMI_CREDITS_KEY,
  dualAuthProvider,
  providerStorageKeys,
  readStoredBaseUrlSync,
} from "./auth-storage.js";
import { CLAUDE_CODE_AUTH_KEY, CLAUDE_CODE_AUTH_MARKER } from "./claude-code/runtime.js";

const refreshChatGPTToken = vi.hoisted(() => vi.fn());
vi.mock("./oauth/openai.js", () => ({ refreshChatGPTToken }));

async function tempAuthFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-core-auth-storage-test-"));
  return path.join(dir, "auth.json");
}

const tmpFiles: string[] = [];

afterEach(async () => {
  refreshChatGPTToken.mockReset();
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
    await runningSession.setCredentials(
      OPENAI_CHATGPT_KEY,
      oauthCreds("old-token", "revoked-refresh"),
    );

    const loginSession = new AuthStorage(filePath);
    await loginSession.setCredentials(OPENAI_CHATGPT_KEY, oauthCreds("new-token", "new-refresh"));

    const resolved = await runningSession.resolveCredentials(OPENAI_CHATGPT_KEY, {
      forceRefresh: true,
    });
    expect(resolved.accessToken).toBe("new-token");
    expect(refreshChatGPTToken).not.toHaveBeenCalled();
    expect((await new AuthStorage(filePath).getCredentials(OPENAI_CHATGPT_KEY))?.accessToken).toBe(
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
    await sidecar.setCredentials(OPENAI_CHATGPT_KEY, oauthCreds("token-a"));
    expect((await sidecar.resolveCredentials(OPENAI_CHATGPT_KEY)).accessToken).toBe("token-a");

    // Any sibling (another window, a CLI session) refreshing the grant
    // invalidates token-a server-side. Serving it from cache is what surfaced
    // as a random mid-session authentication_error.
    await new AuthStorage(filePath).setCredentials(OPENAI_CHATGPT_KEY, oauthCreds("token-b"));

    expect((await sidecar.resolveCredentials(OPENAI_CHATGPT_KEY)).accessToken).toBe("token-b");
    expect(refreshChatGPTToken).not.toHaveBeenCalled();
  });

  it("detects a rotated token when replacement size and mtime match the cached file", async () => {
    const sidecar = await makeStorage();
    const timestamp = new Date("2026-01-01T00:00:00Z");
    await sidecar.setCredentials(OPENAI_CHATGPT_KEY, oauthCreds("token-a"));
    await fs.utimes(sidecar.path, timestamp, timestamp);
    await sidecar.load();
    const before = await fs.stat(sidecar.path);
    expect((await sidecar.resolveCredentials(OPENAI_CHATGPT_KEY)).accessToken).toBe("token-a");

    await new AuthStorage(sidecar.path).setCredentials(OPENAI_CHATGPT_KEY, oauthCreds("token-b"));
    await fs.utimes(sidecar.path, timestamp, timestamp);
    const after = await fs.stat(sidecar.path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).not.toBe(before.ino);

    expect((await sidecar.resolveCredentials(OPENAI_CHATGPT_KEY)).accessToken).toBe("token-b");
    expect(refreshChatGPTToken).not.toHaveBeenCalled();
  });

  it("adopts a sibling's token on 401 instead of minting one that revokes theirs", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const sessionA = new AuthStorage(filePath);
    await sessionA.setCredentials(OPENAI_CHATGPT_KEY, oauthCreds("token-a"));
    await sessionA.resolveCredentials(OPENAI_CHATGPT_KEY);

    // Sibling rotates the grant; sessionA's in-flight request 401s as a result.
    await new AuthStorage(filePath).setCredentials(OPENAI_CHATGPT_KEY, oauthCreds("token-b"));

    const recovered = await sessionA.resolveCredentials(OPENAI_CHATGPT_KEY, {
      forceRefresh: true,
      rejectedToken: "token-a",
    });

    // Refreshing here would mint token-c and revoke token-b — breaking the
    // sibling and starting a mutual-revocation cascade across processes.
    expect(recovered.accessToken).toBe("token-b");
    expect(refreshChatGPTToken).not.toHaveBeenCalled();
  });

  it("still refreshes when the rejected token is the one on disk", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const session = new AuthStorage(filePath);
    await session.setCredentials(OPENAI_CHATGPT_KEY, oauthCreds("token-a"));
    refreshChatGPTToken.mockResolvedValue({
      accessToken: "token-fresh",
      refreshToken: "refresh-fresh",
      expiresAt: Date.now() + 1_000_000,
    });

    // Nobody else rotated it, so this credential is genuinely dead and a real
    // refresh is the only recovery.
    const refreshed = await session.resolveCredentials(OPENAI_CHATGPT_KEY, {
      forceRefresh: true,
      rejectedToken: "token-a",
    });

    expect(refreshed.accessToken).toBe("token-fresh");
    expect(refreshChatGPTToken).toHaveBeenCalledTimes(1);
  });

  it("keeps a sibling's newer login when its own refresh is rejected mid-request", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const session = new AuthStorage(filePath);
    await session.setCredentials(OPENAI_CHATGPT_KEY, oauthCreds("token-a"));
    await session.setCredentials("anthropic", oauthCreds("anthropic-token"));

    // While this refresh is in flight, a sibling (which broke the file lock)
    // refreshes the same grant and saves token-b; ours is then rejected as reused.
    refreshChatGPTToken.mockImplementation(async () => {
      const disk = JSON.parse(await fs.readFile(filePath, "utf-8"));
      disk[OPENAI_CHATGPT_KEY] = oauthCreds("token-b");
      await fs.writeFile(filePath, JSON.stringify(disk));
      throw new Error("OpenAI token refresh failed (400): invalid_grant");
    });

    const recovered = await session.resolveCredentials(OPENAI_CHATGPT_KEY, { forceRefresh: true });

    // Deleting from the pre-request snapshot used to wipe token-b from disk and
    // sign every window out ("Not logged in"), forcing a manual re-login.
    expect(recovered.accessToken).toBe("token-b");
    const onDisk = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(onDisk[OPENAI_CHATGPT_KEY].accessToken).toBe("token-b");
    expect(onDisk.anthropic.accessToken).toBe("anthropic-token");
  });

  it("still signs out when the rejected refresh token is the one on disk", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const session = new AuthStorage(filePath);
    await session.setCredentials(OPENAI_CHATGPT_KEY, oauthCreds("token-a"));
    await session.setCredentials("anthropic", oauthCreds("anthropic-token"));
    refreshChatGPTToken.mockRejectedValue(
      new Error("OpenAI token refresh failed (400): invalid_grant"),
    );

    await expect(
      session.resolveCredentials(OPENAI_CHATGPT_KEY, { forceRefresh: true }),
    ).rejects.toThrow(NotLoggedInError);
    const onDisk = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(onDisk[OPENAI_CHATGPT_KEY]).toBeUndefined();
    expect(onDisk.anthropic.accessToken).toBe("anthropic-token");
  });
});

describe("AuthStorage — proactive refresh threshold", () => {
  // A short-lived token must refresh at its halfway point, not 60s before
  // expiry: threshold = max(300s, expiresIn * 0.5).
  it("refreshes a 15-min token once it is within the lifetime-scaled threshold", async () => {
    const storage = await makeStorage();
    // 6 min left on a 15-min token → inside the 7.5-min threshold → refresh.
    await storage.setCredentials(OPENAI_CHATGPT_KEY, {
      ...oauthCreds("live-15m"),
      expiresAt: Date.now() + 6 * 60_000,
      expiresIn: 15 * 60,
    });
    refreshChatGPTToken.mockResolvedValue({
      ...oauthCreds("refreshed-15m"),
      expiresAt: Date.now() + 15 * 60_000,
      expiresIn: 15 * 60,
    });

    const resolved = await storage.resolveCredentials(OPENAI_CHATGPT_KEY);
    expect(refreshChatGPTToken).toHaveBeenCalledOnce();
    expect(resolved.accessToken).toBe("refreshed-15m");
  });

  it("does not refresh a 15-min token still outside the threshold", async () => {
    const storage = await makeStorage();
    // 9 min left on a 15-min token → outside the 7.5-min threshold → keep.
    await storage.setCredentials(OPENAI_CHATGPT_KEY, {
      ...oauthCreds("live-9m"),
      expiresAt: Date.now() + 9 * 60_000,
      expiresIn: 15 * 60,
    });

    const resolved = await storage.resolveCredentials(OPENAI_CHATGPT_KEY);
    expect(refreshChatGPTToken).not.toHaveBeenCalled();
    expect(resolved.accessToken).toBe("live-9m");
  });

  it("falls back to the 5-min floor when lifetime is unknown", async () => {
    const storage = await makeStorage();
    // No expiresIn (legacy credential): threshold floors at 300s. 4 min left
    // → inside the floor → refresh.
    await storage.setCredentials(OPENAI_CHATGPT_KEY, {
      ...oauthCreds("legacy-live"),
      expiresAt: Date.now() + 4 * 60_000,
    });
    refreshChatGPTToken.mockResolvedValue({
      ...oauthCreds("legacy-refreshed"),
      expiresAt: Date.now() + 60 * 60_000,
    });

    const resolved = await storage.resolveCredentials(OPENAI_CHATGPT_KEY);
    expect(refreshChatGPTToken).toHaveBeenCalledOnce();
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

  it("uses only the Gemini API key, never the retired Google sign-in", async () => {
    const keys = [GEMINI_API_KEY];
    const both = await makeStorage();
    await both.setCredentials("gemini", { ...oauthCreds("oauth-token"), projectId: "p" });
    await both.setCredentials(GEMINI_API_KEY, {
      accessToken: "aistudio-key",
      refreshToken: "",
      expiresAt: Date.now() + 1_000_000,
      baseUrl: GEMINI_API_KEY_BASE_URL,
    });
    const picked = await both.resolveCredentials("gemini", { storageKeys: keys });
    // The key carries the public API base URL — the transport routes on it.
    expect(picked).toMatchObject({ accessToken: "aistudio-key", baseUrl: GEMINI_API_KEY_BASE_URL });
    expect(await both.hasProviderAuth("gemini")).toBe(true);

    const oauthOnly = await makeStorage();
    await oauthOnly.setCredentials("gemini", { ...oauthCreds("stale"), projectId: "p" });
    expect(await oauthOnly.hasProviderAuth("gemini")).toBe(false);
    await expect(oauthOnly.resolveCredentials("gemini", { storageKeys: keys })).rejects.toThrow(
      NotLoggedInError,
    );
    await expect(oauthOnly.resolveCredentials("gemini")).rejects.toThrow(NotLoggedInError);
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

describe("AuthStorage — OpenAI dual credential (ChatGPT plan vs. API key)", () => {
  const planCreds = () => ({
    accessToken: "chatgpt-plan-token",
    refreshToken: "chatgpt-refresh",
    expiresAt: Date.now() + 1_000_000,
    accountId: "user-sub",
    clientId: "oaiapp_issued",
    baseUrl: "https://api.openai.com/v1",
  });
  const apiKeyCreds = () => ({
    accessToken: "sk-openai-key",
    refreshToken: "",
    expiresAt: Date.now() + 1_000_000,
  });

  it("prefers the ChatGPT plan when both are configured", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("openai", apiKeyCreds());
    await storage.setCredentials(OPENAI_CHATGPT_KEY, planCreds());
    // AgentSession passes storageKeys: ["openai"] — which must NOT shortcut past
    // the plan preference.
    const creds = await storage.resolveCredentials("openai", { storageKeys: ["openai"] });
    expect(creds.accessToken).toBe("chatgpt-plan-token");
    expect(creds.accountId).toBe("user-sub");
    expect(await storage.isStaticApiKey("openai")).toBe(false);
  });

  it("falls back to the API key while the plan is marked usage-exhausted", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("openai", apiKeyCreds());
    await storage.setCredentials(OPENAI_CHATGPT_KEY, planCreds());

    await storage.markUsageExhausted(OPENAI_CHATGPT_KEY);
    const creds = await storage.resolveCredentials("openai", { storageKeys: ["openai"] });
    expect(creds.accessToken).toBe("sk-openai-key");
    expect(creds.accountId).toBeUndefined();
    // The key is active now: a 401 should clear it, not refresh the sidelined plan.
    expect(await storage.isStaticApiKey("openai")).toBe(true);
    expect(storage.getStoredBaseUrl("openai")).toBeUndefined();
  });

  it("honors a provider-stated reset time (unix seconds) for the exhaustion mark", async () => {
    const storage = await makeStorage();
    await storage.setCredentials(OPENAI_CHATGPT_KEY, planCreds());
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    await storage.markUsageExhausted(OPENAI_CHATGPT_KEY, resetsAt);
    const stored = await storage.getCredentials(OPENAI_CHATGPT_KEY);
    expect(stored?.usageExhaustedUntil).toBe(resetsAt * 1000);
  });

  it("resumes the plan once the exhaustion mark lapses", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("openai", apiKeyCreds());
    await storage.setCredentials(OPENAI_CHATGPT_KEY, {
      ...planCreds(),
      usageExhaustedUntil: Date.now() - 1_000,
    });
    const creds = await storage.resolveCredentials("openai", { storageKeys: ["openai"] });
    expect(creds.accessToken).toBe("chatgpt-plan-token");
  });

  it("keeps serving the plan when exhausted with no API key (real error must surface)", async () => {
    const storage = await makeStorage();
    await storage.setCredentials(OPENAI_CHATGPT_KEY, planCreds());
    await storage.markUsageExhausted(OPENAI_CHATGPT_KEY);
    const creds = await storage.resolveCredentials("openai", { storageKeys: ["openai"] });
    expect(creds.accessToken).toBe("chatgpt-plan-token");
  });

  it("markUsageExhausted is a no-op when nothing is stored under the key", async () => {
    const storage = await makeStorage();
    await storage.markUsageExhausted(OPENAI_CHATGPT_KEY);
    expect(await storage.getCredentials(OPENAI_CHATGPT_KEY)).toBeUndefined();
  });

  it("persists the exhaustion mark so a new process (or another app window) sees it", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const storage = new AuthStorage(filePath);
    await storage.setCredentials("openai", apiKeyCreds());
    await storage.setCredentials(OPENAI_CHATGPT_KEY, planCreds());
    await storage.markUsageExhausted(OPENAI_CHATGPT_KEY);

    const secondProcess = new AuthStorage(filePath);
    const creds = await secondProcess.resolveCredentials("openai", { storageKeys: ["openai"] });
    expect(creds.accessToken).toBe("sk-openai-key");
  });

  it("reports the plan endpoint as active while the plan serves", async () => {
    const storage = await makeStorage();
    await storage.setCredentials(OPENAI_CHATGPT_KEY, planCreds());
    expect(storage.getStoredBaseUrl("openai")).toBe("https://api.openai.com/v1");
    expect(readStoredBaseUrlSync(storage.path, "openai")).toBe("https://api.openai.com/v1");
  });

  it("keeps the issued client and ID token across a refresh", async () => {
    const storage = await makeStorage();
    await storage.setCredentials(OPENAI_CHATGPT_KEY, {
      ...planCreds(),
      idToken: "id-token",
      scopes: ["chatgpt.tokens.use.direct"],
      expiresAt: Date.now() - 1_000,
    });
    refreshChatGPTToken.mockResolvedValue({
      accessToken: "fresh",
      refreshToken: "refresh-2",
      expiresAt: Date.now() + 3_600_000,
    });
    const creds = await storage.resolveCredentials("openai");
    expect(refreshChatGPTToken).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "oaiapp_issued", refreshToken: "chatgpt-refresh" }),
    );
    expect(creds).toMatchObject({
      accessToken: "fresh",
      accountId: "user-sub",
      clientId: "oaiapp_issued",
      idToken: "id-token",
      scopes: ["chatgpt.tokens.use.direct"],
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("either credential satisfies hasProviderAuth", async () => {
    const storage = await makeStorage();
    expect(await storage.hasProviderAuth("openai")).toBe(false);
    await storage.setCredentials(OPENAI_CHATGPT_KEY, planCreds());
    expect(await storage.hasProviderAuth("openai")).toBe(true);

    const keyOnly = await makeStorage();
    await keyOnly.setCredentials("openai", apiKeyCreds());
    expect(await keyOnly.hasProviderAuth("openai")).toBe(true);
  });

  it("exposes both storage keys in resolution order", () => {
    expect(providerStorageKeys("openai")).toEqual([OPENAI_CHATGPT_KEY, "openai"]);
    // Kimi and xAI are key-only now.
    expect(providerStorageKeys("moonshot")).toEqual(["moonshot"]);
    expect(providerStorageKeys("xai")).toEqual(["xai"]);
    expect(providerStorageKeys("anthropic")).toEqual(["anthropic"]);
    expect(dualAuthProvider("anthropic")).toBeUndefined();
  });
});

describe("AuthStorage — Kimi Code plan key vs. Moonshot key", () => {
  const key = (accessToken: string, baseUrl?: string) => ({
    accessToken,
    refreshToken: "",
    expiresAt: Date.now() + 1_000_000,
    ...(baseUrl ? { baseUrl } : {}),
  });
  async function storageWith(detect: (key: string) => Promise<string | undefined>) {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    return { filePath, storage: new AuthStorage(filePath, { detectKimiCodeBaseUrl: detect }) };
  }

  it("serves the plan key first and probes its host once", async () => {
    const detect = vi.fn(async () => "https://api.kimi.ai/coding/v1");
    const { filePath, storage } = await storageWith(detect);
    await storage.setCredentials("moonshot", key("moonshot-key"));
    await storage.setCredentials(KIMI_CODE_KEY, key("kimi-code-key"));

    const creds = await storage.resolveCredentials("moonshot", {
      storageKeys: [KIMI_CODE_KEY, "moonshot"],
    });
    expect(creds).toMatchObject({
      accessToken: "kimi-code-key",
      baseUrl: "https://api.kimi.ai/coding/v1",
    });
    expect(readStoredBaseUrlSync(filePath, "moonshot")).toBe("https://api.kimi.ai/coding/v1");
    await storage.resolveCredentials("moonshot", { storageKeys: [KIMI_CODE_KEY, "moonshot"] });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(await storage.isStaticApiKey("moonshot")).toBe(true);
  });

  it("uses the default plan host when the probe is inconclusive, without saving it", async () => {
    const { filePath, storage } = await storageWith(async () => undefined);
    await storage.setCredentials(KIMI_CODE_KEY, key("kimi-code-key"));
    const creds = await storage.resolveCredentials("moonshot", { storageKeys: [KIMI_CODE_KEY] });
    expect(creds.baseUrl).toBe("https://api.kimi.com/coding/v1");
    expect(storage.getStoredBaseUrl("moonshot")).toBe("https://api.kimi.com/coding/v1");
    const saved = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(saved[KIMI_CODE_KEY].baseUrl).toBeUndefined();
  });

  it("falls back to the Moonshot key when no plan key is stored", async () => {
    const detect = vi.fn(async () => undefined);
    const { storage } = await storageWith(detect);
    await storage.setCredentials("moonshot", key("moonshot-key"));
    const creds = await storage.resolveCredentials("moonshot", {
      storageKeys: [KIMI_CODE_KEY, "moonshot"],
    });
    expect(creds.accessToken).toBe("moonshot-key");
    expect(storage.getStoredBaseUrl("moonshot")).toBeUndefined();
    expect(detect).not.toHaveBeenCalled();
  });

  it("either key satisfies hasProviderAuth", async () => {
    const { storage } = await storageWith(async () => undefined);
    expect(await storage.hasProviderAuth("moonshot")).toBe(false);
    await storage.setCredentials(KIMI_CODE_KEY, key("kimi-code-key"));
    expect(await storage.hasProviderAuth("moonshot")).toBe(true);
  });
});

describe("AuthStorage — static API keys", () => {
  it("treats the xAI API key as a static credential", async () => {
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
});

describe("AuthStorage — retired sign-ins", () => {
  const codexToken = {
    accessToken: "codex-jwt",
    refreshToken: "codex-refresh",
    expiresAt: Date.now() + 1_000_000,
    accountId: "acct",
  };

  async function storageWithFile(data: Record<string, unknown>): Promise<AuthStorage> {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    await fs.writeFile(filePath, JSON.stringify(data));
    return new AuthStorage(filePath);
  }

  it("never serves an old Codex sign-in as an OpenAI API key", async () => {
    const storage = await storageWithFile({ openai: codexToken });
    expect(await storage.hasProviderAuth("openai")).toBe(false);
    expect(await storage.isStaticApiKey("openai")).toBe(true);
    await expect(storage.resolveCredentials("openai")).rejects.toThrow(NotLoggedInError);
    await expect(storage.resolveCredentials("openai", { storageKeys: ["openai"] })).rejects.toThrow(
      NotLoggedInError,
    );
    expect(refreshChatGPTToken).not.toHaveBeenCalled();
    expect(storage.getStoredBaseUrl("openai")).toBeUndefined();
  });

  it("ignores old Kimi, Grok and Google sign-ins", async () => {
    const storage = await storageWithFile({
      "moonshot-oauth": { ...codexToken, baseUrl: "https://api.kimi.com/coding/v1" },
      "xai-oauth": { ...codexToken, baseUrl: "https://cli-chat-proxy.grok.com/v1" },
      gemini: { ...codexToken, projectId: "p" },
    });
    for (const provider of ["moonshot", "xai", "gemini"]) {
      expect(await storage.hasProviderAuth(provider), provider).toBe(false);
    }
    expect(storage.getStoredBaseUrl("moonshot")).toBeUndefined();
    expect(storage.getStoredBaseUrl("xai")).toBeUndefined();
    await expect(storage.resolveCredentials("xai")).rejects.toThrow(NotLoggedInError);
    await expect(storage.resolveCredentials("moonshot-oauth")).rejects.toThrow(NotLoggedInError);
  });

  it("lists retired sign-ins with a message per provider", async () => {
    const storage = await storageWithFile({
      openai: codexToken,
      "xai-oauth": codexToken,
      moonshot: { accessToken: "sk-moonshot", refreshToken: "", expiresAt: 0 },
    });
    const retired = await storage.legacySignIns();
    expect(retired.map((r) => r.provider)).toEqual(["openai", "xai"]);
    expect(retired[0]!.message).toMatch(/Continue with ChatGPT/);
    expect(retired[1]!.message).toMatch(/xAI API key/);
  });

  it("removes one provider's retired sign-in exactly once, keeping real keys", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const moonshotKey = { accessToken: "sk-moonshot", refreshToken: "", expiresAt: 0 };
    await fs.writeFile(
      filePath,
      JSON.stringify({ "moonshot-oauth": codexToken, moonshot: moonshotKey }),
    );
    const storage = new AuthStorage(filePath);
    expect(await storage.takeLegacySignIn("moonshot")).toBe(true);
    expect(await storage.takeLegacySignIn("moonshot")).toBe(false);
    const saved = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(saved["moonshot-oauth"]).toBeUndefined();
    expect(saved.moonshot).toEqual(moonshotKey);
  });

  it("drops the retired sign-in when the user connects that provider again", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    await fs.writeFile(
      filePath,
      JSON.stringify({ openai: codexToken, "moonshot-oauth": codexToken }),
    );
    const storage = new AuthStorage(filePath);

    await storage.setCredentials(OPENAI_CHATGPT_KEY, {
      accessToken: "plan",
      refreshToken: "r",
      expiresAt: Date.now() + 1_000_000,
    });
    await storage.setCredentials(KIMI_CODE_KEY, {
      accessToken: "kimi-code-key",
      refreshToken: "",
      expiresAt: 0,
    });
    const saved = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(saved.openai).toBeUndefined();
    expect(saved["moonshot-oauth"]).toBeUndefined();
    expect(Object.keys(saved).sort()).toEqual([KIMI_CODE_KEY, OPENAI_CHATGPT_KEY].sort());
  });

  it("keeps a real OpenAI API key when the user also signs in with ChatGPT", async () => {
    const storage = await storageWithFile({
      openai: { accessToken: "sk-openai", refreshToken: "", expiresAt: 0 },
    });
    await storage.setCredentials(OPENAI_CHATGPT_KEY, {
      accessToken: "plan",
      refreshToken: "r",
      expiresAt: Date.now() + 1_000_000,
    });
    expect((await storage.getCredentials("openai"))?.accessToken).toBe("sk-openai");
  });
});

describe("AuthStorage — clearRejectedApiKey", () => {
  it("drops a rejected provider key but keeps a local endpoint's key", async () => {
    const storage = await makeStorage();
    await storage.setCredentials("glm", {
      accessToken: "bad-key",
      refreshToken: "",
      expiresAt: Date.now() + 60_000,
    });
    await storage.setLocalEndpoint("custom-gw", "https://gw.example/v1", "sk-gateway");

    expect(await storage.clearRejectedApiKey("glm")).toBe(true);
    expect(await storage.clearRejectedApiKey("local:custom-gw")).toBe(false);

    expect(await storage.hasCredentials("glm")).toBe(false);
    expect((await storage.getCredentials("local:custom-gw"))?.accessToken).toBe("sk-gateway");
    expect(await storage.hasProviderAuth("local")).toBe(true);
  });
});

describe("AuthStorage — MiniMax key region", () => {
  async function storageWith(detect: (key: string) => Promise<string | undefined>) {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    return { filePath, storage: new AuthStorage(filePath, { detectMiniMaxBaseUrl: detect }) };
  }
  const minimaxKey = (baseUrl?: string) => ({
    accessToken: "sk-cp-china",
    refreshToken: "",
    expiresAt: Date.now() + 60_000,
    ...(baseUrl ? { baseUrl } : {}),
  });

  it("saves the detected region on a key stored without one, and checks only once", async () => {
    const detect = vi.fn(async () => "https://api.minimax.cn/anthropic");
    const { filePath, storage } = await storageWith(detect);
    await storage.setCredentials("minimax", minimaxKey());

    expect((await storage.resolveCredentials("minimax")).baseUrl).toBe(
      "https://api.minimax.cn/anthropic",
    );
    expect(readStoredBaseUrlSync(filePath, "minimax")).toBe("https://api.minimax.cn/anthropic");

    await storage.resolveCredentials("minimax");
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("leaves the key untouched when the region can't be determined", async () => {
    const { filePath, storage } = await storageWith(async () => undefined);
    await storage.setCredentials("minimax", minimaxKey());

    expect((await storage.resolveCredentials("minimax")).baseUrl).toBeUndefined();
    expect(readStoredBaseUrlSync(filePath, "minimax")).toBeUndefined();
  });

  it("never re-checks a key that already has an endpoint", async () => {
    const detect = vi.fn(async () => "https://api.minimax.cn/anthropic");
    const { storage } = await storageWith(detect);
    await storage.setCredentials("minimax", minimaxKey("https://api.minimax.io/anthropic"));

    expect((await storage.resolveCredentials("minimax")).baseUrl).toBe(
      "https://api.minimax.io/anthropic",
    );
    expect(detect).not.toHaveBeenCalled();
  });
});

describe("AuthStorage — Xiaomi Token Plan cluster", () => {
  const SGP = "https://token-plan-sgp.xiaomimimo.com/v1";
  const AMS = "https://token-plan-ams.xiaomimimo.com/v1";
  async function storageWith(detect: (key: string) => Promise<string | undefined>) {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    return {
      filePath,
      storage: new AuthStorage(filePath, { detectXiaomiTokenPlanBaseUrl: detect }),
    };
  }
  const tokenPlanKey = { accessToken: "tp-eu", refreshToken: "", expiresAt: 1, baseUrl: SGP };

  it("moves a Europe key rejected by Singapore to its own cluster instead of losing it", async () => {
    const { filePath, storage } = await storageWith(async () => AMS);
    await storage.setCredentials("xiaomi", tokenPlanKey);

    expect(await storage.relocateRegionalApiKey(["xiaomi", XIAOMI_CREDITS_KEY])).toBe(AMS);
    expect(readStoredBaseUrlSync(filePath, "xiaomi")).toBe(AMS);
    expect((await storage.resolveCredentials("xiaomi")).accessToken).toBe("tp-eu");
  });

  it("reports nothing to relocate when the key's own cluster rejected it", async () => {
    const { storage } = await storageWith(async () => SGP);
    await storage.setCredentials("xiaomi", tokenPlanKey);
    expect(await storage.relocateRegionalApiKey(["xiaomi"])).toBeUndefined();
  });

  it("never probes for non-regional keys", async () => {
    const detect = vi.fn(async () => AMS);
    const { storage } = await storageWith(detect);
    await storage.setCredentials(XIAOMI_CREDITS_KEY, { ...tokenPlanKey, accessToken: "sk-x" });
    await storage.setCredentials("glm", { ...tokenPlanKey, accessToken: "glm-key" });

    expect(await storage.relocateRegionalApiKey([XIAOMI_CREDITS_KEY])).toBeUndefined();
    expect(await storage.relocateRegionalApiKey(["glm"])).toBeUndefined();
    expect(detect).not.toHaveBeenCalled();
  });
});

describe("AuthStorage — Claude Code sign-in marker", () => {
  it("reports the login and resolves Anthropic without a token", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    await fs.writeFile(
      filePath,
      JSON.stringify({ [CLAUDE_CODE_AUTH_KEY]: CLAUDE_CODE_AUTH_MARKER }),
    );
    const storage = new AuthStorage(filePath);
    expect(await storage.hasClaudeCodeLogin()).toBe(true);
    expect((await storage.resolveCredentials("anthropic")).accessToken).toBe("");
  });

  it("still serves an Anthropic API key stored next to the marker", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    await fs.writeFile(
      filePath,
      JSON.stringify({
        [CLAUDE_CODE_AUTH_KEY]: CLAUDE_CODE_AUTH_MARKER,
        anthropic: {
          accessToken: "sk-ant-api-key",
          refreshToken: "",
          expiresAt: Date.now() + 1e12,
        },
      }),
    );
    const storage = new AuthStorage(filePath);
    expect((await storage.resolveCredentials("anthropic")).accessToken).toBe("sk-ant-api-key");
  });

  it("is signed out without the marker", async () => {
    const storage = await makeStorage();
    expect(await storage.hasClaudeCodeLogin()).toBe(false);
    await expect(storage.resolveCredentials("anthropic")).rejects.toThrow();
  });
  it("treats an old GG Claude sign-in token as signed out and never refreshes it", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const legacy = { accessToken: "sk-ant-oat01-old", refreshToken: "rt", expiresAt: 0 };
    await fs.writeFile(filePath, JSON.stringify({ anthropic: legacy }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const storage = new AuthStorage(filePath);
    expect(await storage.hasProviderAuth("anthropic")).toBe(false);
    await expect(storage.resolveCredentials("anthropic")).rejects.toThrow(NotLoggedInError);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    await fs.writeFile(
      filePath,
      JSON.stringify({ anthropic: legacy, [CLAUDE_CODE_AUTH_KEY]: CLAUDE_CODE_AUTH_MARKER }),
    );
    const signedIn = new AuthStorage(filePath);
    expect(await signedIn.hasProviderAuth("anthropic")).toBe(true);
    expect((await signedIn.resolveCredentials("anthropic")).accessToken).toBe("");
  });

  it("removes an old GG Claude sign-in token exactly once", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const legacy = { accessToken: "sk-ant-oat01-old", refreshToken: "rt", expiresAt: 0 };
    const apiKey = { accessToken: "sk-ant-api03-k", refreshToken: "", expiresAt: 0 };
    await fs.writeFile(filePath, JSON.stringify({ anthropic: legacy, openai: apiKey }));
    const storage = new AuthStorage(filePath);

    expect(await storage.takeLegacySignIn("anthropic")).toBe(true);
    expect(await storage.takeLegacySignIn("anthropic")).toBe(false);
    const saved = JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
    expect(saved.anthropic).toBeUndefined();
    expect(saved.openai).toEqual(apiKey);
  });

  it("keeps an Anthropic API key, which is not an old sign-in", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const apiKey = { accessToken: "sk-ant-api03-k", refreshToken: "", expiresAt: 0 };
    await fs.writeFile(filePath, JSON.stringify({ anthropic: apiKey }));
    const storage = new AuthStorage(filePath);

    expect(await storage.takeLegacySignIn("anthropic")).toBe(false);
    expect((await storage.resolveCredentials("anthropic")).accessToken).toBe("sk-ant-api03-k");
  });

  it("drops the old sign-in token when the user signs in with Claude again", async () => {
    const filePath = await tempAuthFile();
    tmpFiles.push(filePath);
    const legacy = { accessToken: "sk-ant-oat01-old", refreshToken: "rt", expiresAt: 0 };
    await fs.writeFile(filePath, JSON.stringify({ anthropic: legacy }));
    const storage = new AuthStorage(filePath);

    await storage.setClaudeCodeLogin();
    const saved = JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<string, unknown>;
    expect(saved.anthropic).toBeUndefined();
    expect(saved[CLAUDE_CODE_AUTH_KEY]).toEqual(CLAUDE_CODE_AUTH_MARKER);
  });
});
