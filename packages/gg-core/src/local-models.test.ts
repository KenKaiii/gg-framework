import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_ENDPOINTS,
  FALLBACK_CONTEXT_WINDOW,
  clearLocalDiscoveryCache,
  discoverLocalModels,
  endpointRoot,
  findProbedModel,
  formatLocalModelId,
  isLocalModelId,
  localAuthStorageKey,
  parseLocalModelId,
  probeEndpoint,
  toModelInfo,
  type LocalEndpoint,
  type LocalEndpointKind,
} from "./local-models.js";

type Routes = Record<string, unknown>;

/** Minimal fake server: exact-path JSON routes, 404 for anything else. */
async function startServer(
  routes: Routes,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const body = routes[path];
    if (body === undefined) {
      res.writeHead(404).end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cleanups: (() => Promise<void>)[] = [];

async function endpointFor(kind: LocalEndpointKind, routes: Routes): Promise<LocalEndpoint> {
  const { baseUrl, close } = await startServer(routes);
  cleanups.push(close);
  return { id: kind, label: kind, baseUrl, kind };
}

afterEach(async () => {
  clearLocalDiscoveryCache();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

describe("model id round-trip", () => {
  it("formats and parses ids, including raw ids containing slashes", () => {
    const id = formatLocalModelId("ollama", "hf.co/user/repo:q4");
    expect(id).toBe("local/ollama/hf.co/user/repo:q4");
    expect(parseLocalModelId(id)).toEqual({
      endpointId: "ollama",
      rawId: "hf.co/user/repo:q4",
    });
    expect(isLocalModelId(id)).toBe(true);
  });

  it("rejects non-local and malformed ids", () => {
    expect(parseLocalModelId("claude-sonnet-5")).toBeUndefined();
    expect(parseLocalModelId("local/ollama")).toBeUndefined();
    expect(parseLocalModelId("local/ollama/")).toBeUndefined();
    expect(parseLocalModelId("local//qwen")).toBeUndefined();
    expect(isLocalModelId("gpt-6.1-sol")).toBe(false);
  });

  it("derives the auth storage key from the endpoint id", () => {
    expect(localAuthStorageKey("lmstudio")).toBe("local:lmstudio");
  });

  it("strips the /v1 suffix to reach the server root", () => {
    expect(endpointRoot("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(endpointRoot("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434");
    expect(endpointRoot("http://host/openai/v1")).toBe("http://host/openai");
  });
});

describe("probeEndpoint — Ollama", () => {
  it("reads capabilities but uses the running allocation, not the architecture maximum", async () => {
    const endpoint = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "qwen3-coder:30b" }, { id: "nomic-embed-text" }] },
      "/api/ps": { models: [{ name: "qwen3-coder:30b", context_length: 4096 }] },
      "/api/show": {
        capabilities: ["completion", "tools", "vision", "thinking"],
        model_info: { "general.architecture": "qwen3", "qwen3.context_length": 262144 },
      },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.reachable).toBe(true);
    // The embedding model is filtered out by id.
    expect(probe.models).toHaveLength(1);
    expect(probe.models[0]).toMatchObject({
      rawId: "qwen3-coder:30b",
      contextWindow: 4096,
      contextWindowKnown: true,
      supportsTools: true,
      supportsImages: true,
      supportsThinking: true,
    });
  });

  it.each([
    undefined,
    null,
    {},
    { models: [] },
    { models: [{ name: "model", context_length: -1 }] },
  ])(
    "does not report the training maximum when running context is unavailable: %j",
    async (running) => {
      const endpoint = await endpointFor("ollama", {
        "/v1/models": { data: [{ id: "model" }] },
        "/api/ps": running,
        "/api/show": {
          capabilities: ["completion"],
          model_info: { "qwen.context_length": 262144 },
        },
      });
      const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });
      expect(probe.models[0]).toMatchObject({
        contextWindow: FALLBACK_CONTEXT_WINDOW,
        contextWindowKnown: false,
      });
      expect(FALLBACK_CONTEXT_WINDOW).toBeLessThanOrEqual(4096);
    },
  );

  it("drops embedding models whose id carries no hint (real: all-minilm)", async () => {
    const endpoint = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "all-minilm:latest" }, { id: "llama3.2:latest" }] },
      // Both ids hit the same fixture route; the per-model capability answer is
      // what distinguishes them, so serve the embedding shape and assert the
      // chat model survives on a second, tool-capable fixture below.
      "/api/show": { capabilities: ["embedding"], model_info: {} },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.reachable).toBe(true);
    expect(probe.models).toEqual([]);
  });

  it("keeps a model that both embeds and completes", async () => {
    const endpoint = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "hybrid" }] },
      "/api/show": { capabilities: ["embedding", "completion", "tools"], model_info: {} },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models.map((m) => m.rawId)).toEqual(["hybrid"]);
  });

  it("reports no tool support when Ollama omits the tools capability", async () => {
    const endpoint = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "gemma3:4b" }] },
      "/api/show": { capabilities: ["completion"], model_info: {} },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models[0]).toMatchObject({
      supportsTools: false,
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
    });
  });
});

describe("probeEndpoint — LM Studio", () => {
  it("prefers v1 loaded instances and matches custom instance ids", async () => {
    const endpoint = await endpointFor("lmstudio", {
      "/v1/models": { data: [{ id: "custom-instance" }, { id: "qwen-vl" }, { id: "unloaded" }] },
      "/api/v1/models": {
        models: [
          {
            key: "qwen-vl",
            type: "llm",
            max_context_length: 262144,
            capabilities: { vision: true },
            loaded_instances: [
              { id: "custom-instance", config: { context_length: 8192 } },
              { id: "second-instance", config: { context_length: 4096 } },
            ],
          },
          { key: "unloaded", type: "llm", max_context_length: 262144, loaded_instances: [] },
        ],
      },
    });
    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });
    expect(probe.models[0]).toMatchObject({
      contextWindow: 8192,
      contextWindowKnown: true,
      supportsImages: true,
      loaded: true,
    });
    expect(probe.models[1]).toMatchObject({
      contextWindow: 4096,
      contextWindowKnown: true,
      loaded: true,
    });
    expect(probe.models[2]).toMatchObject({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
      loaded: false,
    });
  });

  it("uses /api/v0/models for context + type and drops embeddings", async () => {
    const endpoint = await endpointFor("lmstudio", {
      "/v1/models": {
        data: [{ id: "qwen3-vl-8b" }, { id: "text-model" }, { id: "some-embeddings-model" }],
      },
      "/api/v0/models": {
        data: [
          {
            id: "qwen3-vl-8b",
            type: "vlm",
            state: "loaded",
            max_context_length: 32768,
            loaded_context_length: 4096,
          },
          { id: "text-model", type: "llm", state: "not-loaded", max_context_length: 8192 },
          { id: "some-embeddings-model", type: "embeddings", state: "loaded" },
        ],
      },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models.map((m) => m.rawId)).toEqual(["qwen3-vl-8b", "text-model"]);
    expect(probe.models[0]).toMatchObject({
      supportsImages: true,
      contextWindow: 4096,
      contextWindowKnown: true,
      loaded: true,
    });
    expect(probe.models[1]).toMatchObject({
      supportsImages: false,
      loaded: false,
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
    });
  });
});

describe("probeEndpoint — llama.cpp", () => {
  it("takes n_ctx from /props", async () => {
    const endpoint = await endpointFor("llamacpp", {
      "/v1/models": { data: [{ id: "local-gguf" }] },
      "/props": { default_generation_settings: { n_ctx: 16384 } },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models[0]).toMatchObject({
      rawId: "local-gguf",
      contextWindow: 16384,
      contextWindowKnown: true,
      supportsTools: true,
    });
  });

  it("falls back conservatively when /props is missing", async () => {
    const endpoint = await endpointFor("llamacpp", {
      "/v1/models": { data: [{ id: "local-gguf" }] },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models[0]).toMatchObject({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
    });
  });
});

describe("probeEndpoint — generic / vLLM", () => {
  it("uses max_model_len from the model object when present", async () => {
    const endpoint = await endpointFor("vllm", {
      "/v1/models": {
        data: [{ id: "Qwen/Qwen3-32B", max_model_len: 40960 }, { id: "no-len-model" }],
      },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models[0]).toMatchObject({ contextWindow: 40960, contextWindowKnown: true });
    expect(probe.models[1]).toMatchObject({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
      // Servers that report nothing gate tools per-model server-side.
      supportsTools: true,
    });
  });

  it("reads the window from llama.cpp-style spellings on the model object", async () => {
    const endpoint = await endpointFor("custom", {
      "/v1/models": {
        data: [
          { id: "maya-style", context_length: 262144 },
          { id: "llamacpp-style", meta: { n_ctx: 131072 } },
        ],
      },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models[0]).toMatchObject({ contextWindow: 262144, contextWindowKnown: true });
    expect(probe.models[1]).toMatchObject({ contextWindow: 131072, contextWindowKnown: true });
  });

  it("prefers an endpoint-pinned contextLength over what the server reports", async () => {
    const { baseUrl, close } = await startServer({
      "/v1/models": { data: [{ id: "model", max_model_len: 524288 }] },
    });
    cleanups.push(close);

    const probe = await probeEndpoint(
      {
        id: "custom",
        label: "custom",
        baseUrl,
        kind: "custom",
        contextLength: 262144,
      },
      { timeoutMs: 2000 },
    );

    expect(probe.models[0]).toMatchObject({ contextWindow: 262144, contextWindowKnown: true });
  });

  it("ignores junk context fields instead of guessing from them", async () => {
    const endpoint = await endpointFor("custom", {
      "/v1/models": {
        data: [{ id: "model", context_length: -1, max_model_len: 0, meta: { n_ctx: "big" } }],
      },
    });

    const probe = await probeEndpoint(endpoint, { timeoutMs: 2000 });

    expect(probe.models[0]).toMatchObject({
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      contextWindowKnown: false,
    });
  });
});

describe("probeEndpoint — unreachable", () => {
  it("returns a reason instead of throwing when nothing is listening", async () => {
    const endpoint: LocalEndpoint = {
      id: "ollama",
      label: "Ollama",
      // Port 1 is never a model server.
      baseUrl: "http://127.0.0.1:1/v1",
      kind: "ollama",
    };

    const probe = await probeEndpoint(endpoint, { timeoutMs: 500 });

    expect(probe.reachable).toBe(false);
    expect(probe.reason).toContain("http://127.0.0.1:1/v1");
    expect(probe.models).toEqual([]);
  });

  it("reports a rejected key distinctly from a dead server", async () => {
    const server = http.createServer((_req, res) => res.writeHead(401).end("{}"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const probe = await probeEndpoint(
      {
        id: "lmstudio",
        label: "LM Studio",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        kind: "lmstudio",
        apiKey: "wrong",
      },
      { timeoutMs: 2000 },
    );

    expect(probe.reachable).toBe(false);
    expect(probe.reason).toContain("rejected the API key");
  });
});

describe("toModelInfo", () => {
  it("produces a registry entry wired to the endpoint credential", () => {
    const info = toModelInfo(
      {
        rawId: "qwen3-coder:30b",
        endpointId: "ollama",
        contextWindow: 262144,
        contextWindowKnown: true,
        supportsTools: true,
        supportsImages: false,
        supportsThinking: true,
      },
      DEFAULT_LOCAL_ENDPOINTS[0]!,
    );

    expect(info).toMatchObject({
      id: "local/ollama/qwen3-coder:30b",
      name: "qwen3-coder:30b (Ollama)",
      provider: "local",
      contextWindow: 262144,
      supportsThinking: true,
      supportsVideo: false,
      authStorageKeys: ["local:ollama"],
      // Ollama accepts reasoning_effort up to "max" (verified on 0.32).
      maxThinkingLevel: "max",
    });
    // Output cap is bounded so a small local window keeps prompt headroom.
    expect(info.maxOutputTokens).toBe(4096);
  });

  it("scales the output cap down on a tiny context window", () => {
    const info = toModelInfo(
      {
        rawId: "tiny",
        endpointId: "llamacpp",
        contextWindow: 4096,
        contextWindowKnown: true,
        supportsTools: true,
        supportsImages: false,
        supportsThinking: false,
      },
      { id: "llamacpp", label: "llama.cpp", baseUrl: "http://x/v1", kind: "llamacpp" },
    );
    expect(info.maxOutputTokens).toBe(1024);
    // Only Ollama documents "max"; the others stop at the universal "high".
    expect(info.maxThinkingLevel).toBe("high");
  });
});

describe("discoverLocalModels", () => {
  it("aggregates reachable endpoints, skips dead ones, and caches", async () => {
    const live = await endpointFor("llamacpp", {
      "/v1/models": { data: [{ id: "live-model" }] },
      "/props": { default_generation_settings: { n_ctx: 32768 } },
    });
    const dead: LocalEndpoint = {
      id: "vllm",
      label: "vLLM",
      baseUrl: "http://127.0.0.1:1/v1",
      kind: "vllm",
    };

    const first = await discoverLocalModels([live, dead], { timeoutMs: 800 });

    expect(first.models.map((m) => m.id)).toEqual(["local/llamacpp/live-model"]);
    expect(first.probes.find((p) => p.endpoint.id === "vllm")?.reachable).toBe(false);

    // Same endpoint set within the TTL returns the identical cached object.
    const second = await discoverLocalModels([live, dead], { timeoutMs: 800 });
    expect(second).toBe(first);

    const forced = await discoverLocalModels([live, dead], { timeoutMs: 800, force: true });
    expect(forced).not.toBe(first);
    expect(forced.models).toHaveLength(1);
  });

  it("finds a probed model's capabilities by full id", async () => {
    const live = await endpointFor("ollama", {
      "/v1/models": { data: [{ id: "qwen3:8b" }] },
      "/api/show": { capabilities: ["completion", "tools"], model_info: {} },
    });

    const { probes } = await discoverLocalModels([live], { timeoutMs: 2000 });

    expect(findProbedModel(probes, "local/ollama/qwen3:8b")?.model.supportsTools).toBe(true);
    expect(findProbedModel(probes, "local/ollama/absent")).toBeUndefined();
    expect(findProbedModel(probes, "claude-sonnet-5")).toBeUndefined();
  });
});
