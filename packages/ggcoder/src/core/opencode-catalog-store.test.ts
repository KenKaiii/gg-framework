import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, getModelsForProvider, setProviderCatalog } from "@kenkaiiii/gg-core";
import { createOpenCodeCatalogStore } from "./opencode-catalog-store.js";

const model = (id: string): Record<string, unknown> => ({
  id,
  name: id.toUpperCase(),
  type: "chat",
  modalities: { input: ["text"] },
  capabilities: { tools: { supported: true }, reasoning: { effort: ["low", "high"] } },
  limit: { context: 262_144, output: 65_536 },
  cost: { text: { input: { price: 1 } } },
  api: { "chat-completions": {} },
});

let dir: string;
let clock: number;
const now = (): number => clock;

function okFetch(ids: string[], status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify({ data: ids.map(model) }), { status }),
  ) as typeof fetch;
}

const listed = (provider: "opencode" | "opencode-go"): string[] =>
  getModelsForProvider(provider).map((m) => m.id);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-oc-catalog-"));
  clock = 1_000_000;
});

afterEach(async () => {
  setProviderCatalog("opencode", undefined);
  setProviderCatalog("opencode-go", undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("OpenCode catalog store", () => {
  it("reads only the connected plan's public list, as GG Coder, with no key", async () => {
    const doFetch = okFetch(["acme-coder"]);
    const store = createOpenCodeCatalogStore({ dir, fetch: doFetch, now });

    expect(await store.refreshStale(["anthropic", "opencode-go"])).toBe(true);

    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(doFetch).mock.calls[0]!;
    expect(url).toBe("https://opencode.ai/inference/go/v1/models");
    const headers = new Headers(init?.headers);
    expect(headers.get("user-agent")).toMatch(/^ggcoder/);
    expect(headers.has("authorization")).toBe(false);
    expect(listed("opencode-go")).toEqual(["opencode-go/acme-coder"]);
    // Pay-as-you-go isn't connected, so it keeps its built-in rows.
    expect(listed("opencode")).toContain("opencode/kimi-k3");
  });

  it("keeps a built-in model resolvable after the live list replaces it", async () => {
    const store = createOpenCodeCatalogStore({ dir, fetch: okFetch(["acme-coder"]), now });
    await store.refreshStale(["opencode-go"]);
    expect(listed("opencode-go")).not.toContain("opencode-go/kimi-k3");
    expect(getModel("opencode-go/kimi-k3")?.provider).toBe("opencode-go");
  });

  it("reads again only once the list is stale", async () => {
    const doFetch = okFetch(["acme-coder"]);
    const store = createOpenCodeCatalogStore({ dir, fetch: doFetch, now });

    await store.refreshStale(["opencode-go"]);
    expect(await store.refreshStale(["opencode-go"])).toBe(false);
    expect(doFetch).toHaveBeenCalledTimes(1);

    clock += 6 * 60 * 60_000;
    // Same answer: read again, but nothing changed for the pickers.
    expect(await store.refreshStale(["opencode-go"])).toBe(false);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the current list when the read fails, and retries after ten minutes", async () => {
    const good = createOpenCodeCatalogStore({ dir, fetch: okFetch(["acme-coder"]), now });
    await good.refreshStale(["opencode-go"]);

    for (const bad of [
      okFetch(["acme-coder"], 503),
      okFetch([]),
      vi.fn(async () => {
        throw new Error("offline");
      }) as typeof fetch,
    ]) {
      const store = createOpenCodeCatalogStore({ dir, fetch: bad, now });
      expect(await store.refreshStale(["opencode-go"])).toBe(false);
      expect(await store.refreshStale(["opencode-go"])).toBe(false);
      expect(bad).toHaveBeenCalledTimes(1);
      clock += 10 * 60_000;
      await store.refreshStale(["opencode-go"]);
      expect(bad).toHaveBeenCalledTimes(2);
      expect(listed("opencode-go")).toEqual(["opencode-go/acme-coder"]);
    }
  });

  it("installs the cached list at boot and waits out its age before reading again", async () => {
    await createOpenCodeCatalogStore({ dir, fetch: okFetch(["acme-coder"]), now }).refreshStale([
      "opencode-go",
    ]);
    setProviderCatalog("opencode-go", undefined);

    const doFetch = okFetch(["newer-coder"]);
    const restarted = createOpenCodeCatalogStore({ dir, fetch: doFetch, now });
    expect(await restarted.load()).toBe(true);
    expect(listed("opencode-go")).toEqual(["opencode-go/acme-coder"]);

    clock += 60_000;
    await restarted.refreshStale(["opencode-go"]);
    expect(doFetch).not.toHaveBeenCalled();

    clock += 6 * 60 * 60_000;
    expect(await restarted.refreshStale(["opencode-go"])).toBe(true);
    expect(listed("opencode-go")).toEqual(["opencode-go/newer-coder"]);
  });

  it("ignores a missing or corrupt cache file", async () => {
    await fs.writeFile(path.join(dir, "opencode-go-models.json"), "{not json");
    const store = createOpenCodeCatalogStore({ dir, fetch: okFetch([]), now });
    expect(await store.load()).toBe(false);
    expect(listed("opencode-go")).toContain("opencode-go/kimi-k3");
  });

  it("shares one read between overlapping refreshes", async () => {
    const doFetch = okFetch(["acme-coder"]);
    const store = createOpenCodeCatalogStore({ dir, fetch: doFetch, now });
    const [a, b] = await Promise.all([
      store.refreshStale(["opencode-go"]),
      store.refreshStale(["opencode-go"]),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });
});
