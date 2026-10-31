import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "@kenkaiiii/gg-core";
import {
  LocalEndpointError,
  addCustomEndpoint,
  listAllEndpoints,
  listCustomEndpoints,
  normalizeLocalBaseUrl,
  removeCustomEndpoint,
  syncEndpointCredentials,
  type LocalEndpointStoreOptions,
} from "./local-endpoint-store.js";

let dir: string;
let opts: LocalEndpointStoreOptions;
let auth: AuthStorage;

// Both file paths are injected rather than redirected via $HOME: os.homedir()
// reads USERPROFILE on Windows, so a HOME override silently writes to the real
// ~/.gg there — which leaks state between tests and pollutes the user's files.
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-local-endpoints-"));
  auth = new AuthStorage(path.join(dir, "auth.json"));
  opts = { settingsFile: path.join(dir, "gg-app.json"), auth };
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function settings(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(opts.settingsFile!, "utf-8")) as Record<string, unknown>;
}

describe("normalizeLocalBaseUrl", () => {
  it("accepts the shapes users actually paste", () => {
    expect(normalizeLocalBaseUrl("127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1");
    expect(normalizeLocalBaseUrl("http://localhost:8000")).toBe("http://localhost:8000/v1");
    expect(normalizeLocalBaseUrl("http://localhost:8000/v1")).toBe("http://localhost:8000/v1");
    expect(normalizeLocalBaseUrl("  http://localhost:8000/v1/  ")).toBe("http://localhost:8000/v1");
    expect(normalizeLocalBaseUrl("http://box.lan:8080/v1/chat/completions")).toBe(
      "http://box.lan:8080/v1",
    );
    expect(normalizeLocalBaseUrl("http://box.lan:8080/v1/models")).toBe("http://box.lan:8080/v1");
    // A gateway on a sub-path keeps the path.
    expect(normalizeLocalBaseUrl("https://gw.example.com/openai")).toBe(
      "https://gw.example.com/openai/v1",
    );
  });

  it("rejects empty, malformed, and non-http URLs", () => {
    expect(() => normalizeLocalBaseUrl("   ")).toThrow(LocalEndpointError);
    expect(() => normalizeLocalBaseUrl("http://")).toThrow(LocalEndpointError);
    expect(() => normalizeLocalBaseUrl("ftp://host/v1")).toThrow(LocalEndpointError);
  });
});

describe("custom endpoints", () => {
  it("adds an endpoint, persists it, and writes its auth credential", async () => {
    const endpoint = await addCustomEndpoint(
      { label: "Workstation", baseUrl: "192.168.1.4:8000", apiKey: "secret" },
      opts,
    );

    expect(endpoint).toMatchObject({
      id: "custom-192-168-1-4-8000",
      label: "Workstation",
      baseUrl: "http://192.168.1.4:8000/v1",
      kind: "custom",
      custom: true,
      apiKey: "secret",
    });
    expect(await listCustomEndpoints(opts)).toEqual([endpoint]);

    const creds = await auth.getCredentials("local:custom-192-168-1-4-8000");
    expect(creds).toMatchObject({ accessToken: "secret", baseUrl: "http://192.168.1.4:8000/v1" });
    expect(creds!.expiresAt).toBeGreaterThan(Date.now());
    expect(await auth.hasProviderAuth("local")).toBe(true);
  });

  it("defaults the label to the host and the key to a placeholder", async () => {
    await addCustomEndpoint({ baseUrl: "http://localhost:9999" }, opts);

    const stored = (await listCustomEndpoints(opts))[0]!;
    expect(stored.label).toBe("localhost:9999");
    expect(stored.apiKey).toBeUndefined();
    expect(await auth.getCredentials("local:custom-localhost-9999")).toMatchObject({
      accessToken: "local",
    });
  });

  it("updates in place when the same host is re-added", async () => {
    await addCustomEndpoint({ baseUrl: "http://localhost:9999", apiKey: "wrong" }, opts);
    await addCustomEndpoint(
      { label: "Fixed", baseUrl: "http://localhost:9999/v1", apiKey: "right" },
      opts,
    );

    const stored = await listCustomEndpoints(opts);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ label: "Fixed", apiKey: "right" });
    expect(await auth.getCredentials("local:custom-localhost-9999")).toMatchObject({
      accessToken: "right",
    });
  });

  it("pins a contextLength, survives a re-add that omits it, and stays per-endpoint", async () => {
    await addCustomEndpoint({ baseUrl: "http://localhost:9999", contextLength: 262144 }, opts);
    await addCustomEndpoint({ baseUrl: "http://localhost:7777" }, opts);

    let stored = await listCustomEndpoints(opts);
    expect(stored.find((e) => e.id === "custom-localhost-9999")).toMatchObject({
      contextLength: 262144,
    });
    expect(stored.find((e) => e.id === "custom-localhost-7777")).not.toHaveProperty("contextLength");

    // Re-adding the same host to fix a key keeps the pin unless replaced.
    await addCustomEndpoint({ baseUrl: "http://localhost:9999", apiKey: "right" }, opts);
    stored = await listCustomEndpoints(opts);
    expect(stored).toHaveLength(2);
    expect(stored.find((e) => e.id === "custom-localhost-9999")).toMatchObject({
      apiKey: "right",
      contextLength: 262144,
    });

    // An explicit new pin replaces it; a junk pin is dropped, never stored.
    await addCustomEndpoint({ baseUrl: "http://localhost:9999", contextLength: 131072 }, opts);
    expect((await listCustomEndpoints(opts)).find((e) => e.id === "custom-localhost-9999"))
      .toMatchObject({ contextLength: 131072 });
    await addCustomEndpoint({ baseUrl: "http://localhost:9999", contextLength: -1 }, opts);
    expect((await listCustomEndpoints(opts)).find((e) => e.id === "custom-localhost-9999"))
      .toMatchObject({ contextLength: 131072 });

    // Removing that endpoint leaves the other endpoint's pin untouched.
    await removeCustomEndpoint("custom-localhost-9999", opts);
    expect((await listCustomEndpoints(opts)).find((e) => e.id === "custom-localhost-7777"))
      .not.toHaveProperty("contextLength");
  });

  it("refuses a URL already covered by a built-in endpoint", async () => {
    await expect(addCustomEndpoint({ baseUrl: "http://127.0.0.1:11434/v1" }, opts)).rejects.toThrow(
      /already probed automatically as Ollama/,
    );
  });

  it("removes an endpoint and its credential", async () => {
    await addCustomEndpoint({ baseUrl: "http://localhost:9999" }, opts);

    await removeCustomEndpoint("custom-localhost-9999", opts);

    expect(await listCustomEndpoints(opts)).toEqual([]);
    expect(await auth.getCredentials("local:custom-localhost-9999")).toBeUndefined();
    expect(await auth.hasProviderAuth("local")).toBe(false);
  });

  it("refuses to remove a built-in or unknown endpoint", async () => {
    await expect(removeCustomEndpoint("ollama", opts)).rejects.toThrow(/built-in/);
    await expect(removeCustomEndpoint("custom-nope", opts)).rejects.toThrow(/Unknown local/);
  });

  it("preserves unrelated gg-app.json keys", async () => {
    await fs.writeFile(
      opts.settingsFile!,
      JSON.stringify({ projectsRoot: "/tmp/projects", autopilot: { "/a": true } }),
      "utf-8",
    );

    await addCustomEndpoint({ baseUrl: "http://localhost:9999" }, opts);

    expect(await settings()).toMatchObject({
      projectsRoot: "/tmp/projects",
      autopilot: { "/a": true },
    });
    await removeCustomEndpoint("custom-localhost-9999", opts);
    expect(await settings()).toMatchObject({ projectsRoot: "/tmp/projects" });
  });

  it("ignores a corrupt settings file instead of throwing", async () => {
    await fs.writeFile(opts.settingsFile!, "{not json", "utf-8");

    expect(await listCustomEndpoints(opts)).toEqual([]);
  });

  it("lists built-in endpoints before custom ones", async () => {
    await addCustomEndpoint({ baseUrl: "http://localhost:9999" }, opts);

    expect((await listAllEndpoints(opts)).map((e) => e.id)).toEqual([
      "ollama",
      "custom-localhost-9999",
    ]);
  });
});

describe("syncEndpointCredentials", () => {
  it("writes a baseUrl-carrying credential for every endpoint", async () => {
    await syncEndpointCredentials(await listAllEndpoints(opts), opts);

    expect((await auth.listLocalEndpointIds()).sort()).toEqual(["ollama"]);
    expect(await auth.getCredentials("local:ollama")).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      accessToken: "local",
    });
  });
});
