import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthStorage,
  HERMES_PROXY_BASE_URL,
  NOUS_AUTH_KEY,
  getModelsForProvider,
  setProviderCatalog,
} from "@kenkaiiii/gg-core";
import { loadNousCatalog, resetNousCatalog, syncNousCatalog } from "./nous-catalog-store.js";

const BODY = {
  data: [
    {
      id: "acme/coder-9",
      name: "Acme Coder 9",
      context_length: 262144,
      architecture: { input_modalities: ["text"] },
      pricing: { prompt: "0.000001" },
      top_provider: { context_length: 262144, max_completion_tokens: 32768 },
      supported_parameters: ["tools", "reasoning"],
      reasoning: { supported_efforts: ["low", "high", "max"] },
    },
    { id: "acme/chat-only", context_length: 8192, supported_parameters: ["temperature"] },
  ],
};

let dir: string;
let file: string;
let auth: AuthStorage;

function okFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

async function connect(): Promise<void> {
  await auth.setCredentials(NOUS_AUTH_KEY, {
    accessToken: "hermes-proxy",
    refreshToken: "",
    expiresAt: Date.now() + 3_600_000,
    baseUrl: HERMES_PROXY_BASE_URL,
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-nous-catalog-"));
  file = path.join(dir, "nous-models.json");
  auth = new AuthStorage(path.join(dir, "auth.json"));
});

afterEach(async () => {
  setProviderCatalog("nous", undefined);
  await resetNousCatalog({ file });
  await fs.rm(dir, { recursive: true, force: true });
});

describe("Nous catalog store", () => {
  it("syncs through the Hermes proxy and namespaces every id", async () => {
    await connect();
    const doFetch = okFetch(BODY);

    const count = await syncNousCatalog(auth, { file, fetch: doFetch });

    expect(doFetch).toHaveBeenCalledWith(
      `${HERMES_PROXY_BASE_URL}/models`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer hermes-proxy" }),
      }),
    );
    expect(count).toBe(1);
    const models = getModelsForProvider("nous");
    expect(models.map((m) => m.id)).toEqual(["nous/acme/coder-9"]);
    expect(models[0]).toMatchObject({
      provider: "nous",
      maxThinkingLevel: "max",
      thinkingLevels: ["low", "high", "max"],
    });
  });

  it("keeps the cached list when the proxy fails or lists nothing usable", async () => {
    await connect();
    await syncNousCatalog(auth, { file, fetch: okFetch(BODY) });

    await expect(syncNousCatalog(auth, { file, fetch: okFetch({ data: [] }) })).resolves.toBe(0);
    await expect(syncNousCatalog(auth, { file, fetch: okFetch({}, 401) })).rejects.toThrow(
      /HTTP 401/,
    );
    expect(getModelsForProvider("nous").map((m) => m.id)).toEqual(["nous/acme/coder-9"]);
  });

  it("refuses to sync without the Nous connection", async () => {
    await expect(syncNousCatalog(auth, { file, fetch: okFetch(BODY) })).rejects.toThrow(
      /Sign in with Hermes/,
    );
  });

  it("reloads the cache at boot and ignores tampered rows", async () => {
    await connect();
    await syncNousCatalog(auth, { file, fetch: okFetch(BODY) });
    setProviderCatalog("nous", undefined);

    expect(await loadNousCatalog({ file })).toBe(1);
    expect(getModelsForProvider("nous").map((m) => m.id)).toEqual(["nous/acme/coder-9"]);

    await fs.writeFile(
      file,
      JSON.stringify({
        syncedAt: 1,
        models: [{ id: "x", provider: "anthropic", contextWindow: 1 }],
      }),
    );
    setProviderCatalog("nous", undefined);
    expect(await loadNousCatalog({ file })).toBe(0);
  });

  it("drops the plan list on reset", async () => {
    await connect();
    await syncNousCatalog(auth, { file, fetch: okFetch(BODY) });

    await resetNousCatalog({ file });

    expect(getModelsForProvider("nous").some((m) => m.id === "nous/acme/coder-9")).toBe(false);
    await expect(fs.stat(file)).rejects.toThrow();
  });
});
