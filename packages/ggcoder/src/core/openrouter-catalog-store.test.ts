import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage, getModelsForProvider, setProviderCatalog } from "@kenkaiiii/gg-core";
import {
  CatalogSyncError,
  loadOpenRouterCatalog,
  openRouterCatalogStatus,
  resetOpenRouterCatalog,
  syncOpenRouterCatalog,
} from "./openrouter-catalog-store.js";

const BODY = {
  data: [
    {
      id: "acme/coder",
      name: "Acme Coder",
      context_length: 262144,
      architecture: { input_modalities: ["text"] },
      pricing: { prompt: "0.000002" },
      top_provider: { context_length: 262144, max_completion_tokens: 32768 },
      supported_parameters: ["tools", "reasoning"],
      reasoning: { supported_efforts: ["low", "medium", "high", "xhigh", "max"] },
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

async function connect(baseUrl?: string): Promise<void> {
  await auth.setCredentials("openrouter", {
    accessToken: "sk-or-test",
    refreshToken: "",
    expiresAt: Date.now() + 3_600_000,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-or-catalog-"));
  file = path.join(dir, "openrouter-models.json");
  auth = new AuthStorage(path.join(dir, "auth.json"));
});

afterEach(async () => {
  setProviderCatalog("openrouter", undefined);
  await resetOpenRouterCatalog(auth, { file });
  await fs.rm(dir, { recursive: true, force: true });
});

describe("OpenRouter catalog store", () => {
  it("syncs from the key's own endpoint with the key, and lists only tool-capable rows", async () => {
    await connect("https://gw.example.com/v1/");
    const doFetch = okFetch(BODY);

    const result = await syncOpenRouterCatalog(auth, { file, fetch: doFetch });

    expect(doFetch).toHaveBeenCalledWith(
      "https://gw.example.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-or-test" }),
      }),
    );
    expect(result).toMatchObject({ synced: true, count: 1, skipped: 1 });
    expect(getModelsForProvider("openrouter").map((m) => m.id)).toEqual(["acme/coder"]);
  });

  it("keeps the current list when the endpoint fails or lists nothing usable", async () => {
    await connect();
    await syncOpenRouterCatalog(auth, { file, fetch: okFetch(BODY) });

    await expect(
      syncOpenRouterCatalog(auth, { file, fetch: okFetch({ data: [] }) }),
    ).rejects.toThrow(CatalogSyncError);
    await expect(syncOpenRouterCatalog(auth, { file, fetch: okFetch({}, 401) })).rejects.toThrow(
      /HTTP 401/,
    );
    expect(getModelsForProvider("openrouter").map((m) => m.id)).toEqual(["acme/coder"]);
  });

  it("refuses to sync without a key", async () => {
    await expect(syncOpenRouterCatalog(auth, { file, fetch: okFetch(BODY) })).rejects.toThrow(
      /Connect an OpenRouter API key/,
    );
  });

  it("reloads the cache at boot only for the endpoint it was synced from", async () => {
    await connect("https://gw.example.com/v1");
    await syncOpenRouterCatalog(auth, { file, fetch: okFetch(BODY) });
    setProviderCatalog("openrouter", undefined);

    expect(await loadOpenRouterCatalog(auth, { file })).toMatchObject({ synced: true, count: 1 });

    await connect("https://other.example.com/v1");
    expect(await loadOpenRouterCatalog(auth, { file })).toMatchObject({ synced: false });
    expect(getModelsForProvider("openrouter").some((m) => m.id === "acme/coder")).toBe(false);
  });

  it("drops a live catalog once the key points at another endpoint", async () => {
    await connect("https://gw.example.com/v1");
    await syncOpenRouterCatalog(auth, { file, fetch: okFetch(BODY) });

    await connect("https://other.example.com/v1");

    expect(await openRouterCatalogStatus(auth)).toMatchObject({ synced: false });
    expect(getModelsForProvider("openrouter").some((m) => m.id === "acme/coder")).toBe(false);
  });

  it("ignores tampered cache rows", async () => {
    await connect();
    await fs.writeFile(
      file,
      JSON.stringify({
        baseUrl: "https://openrouter.ai/api/v1",
        syncedAt: 1,
        models: [{ id: "x", provider: "anthropic", contextWindow: 1 }],
      }),
    );

    expect(await loadOpenRouterCatalog(auth, { file })).toMatchObject({ synced: false });
  });
});
