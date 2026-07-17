import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuthStorage,
  MOONSHOT_OAUTH_KEY,
  NotLoggedInError,
  XIAOMI_CREDITS_KEY,
} from "./auth-storage.js";

async function tempAuthFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-core-auth-storage-test-"));
  return path.join(dir, "auth.json");
}

const tmpFiles: string[] = [];

afterEach(async () => {
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

  it("resolveCredentials prefers the first storageKey, falling back to the next when only that's configured", async () => {
    // Mirrors mimo-v2.5-pro: prefer Token Plan ("xiaomi"), fall back to
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

  it("treats the xAI API key as a static credential (no refresh mechanism)", async () => {
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
