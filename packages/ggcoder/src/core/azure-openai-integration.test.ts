import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { ModelInfo } from "@kenkaiiii/gg-core/models";
import type { AgentSession as AgentSessionType } from "./agent-session.js";

it("sends an AgentSession prompt through the registered Azure OpenAI deployment", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-azure-home-"));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "gg-azure-project-"));
  const deployment = "gpt-5.6-sol";
  const internalModelId = `azure:${deployment}`;
  const apiKey = "azure-integration-secret";
  const baseUrl =
    "https://integration.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview";
  const streamedText = "Hello from mocked Azure.";
  let receivedText = "";

  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("AZURE_OPENAI_API_KEY", apiKey);
  vi.stubEnv("AZURE_OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("AZURE_OPENAI_DEPLOYMENT", deployment);

  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const events = [
      { type: "response.output_text.delta", delta: streamedText },
      {
        type: "response.completed",
        response: { usage: { input_tokens: 7, output_tokens: 4 } },
      },
    ];
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  let session: AgentSessionType | undefined;
  let models: ModelInfo[] | undefined;

  try {
    await fs.mkdir(path.join(home, ".gg"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".gg", "settings.json"),
      JSON.stringify({ autoCompact: false, idealReviewEnabled: false }),
      "utf8",
    );

    const modelRegistry = await import("./model-registry.js");
    models = modelRegistry.MODELS;
    const openAIModel = models.find(
      (model) => model.provider === "openai" && model.id === deployment,
    );
    const azureModel = models.find(
      (model) => model.provider === "azure" && model.id === internalModelId,
    );
    expect(openAIModel).toBeDefined();
    expect(azureModel).toMatchObject({
      provider: "azure",
      id: internalModelId,
      name: "Azure OpenAI (gpt-5.6-sol)",
    });

    const { AgentSession } = await import("./agent-session.js");
    session = new AgentSession({
      provider: azureModel!.provider,
      model: azureModel!.id,
      cwd: project,
      systemPrompt: "Azure integration test system prompt",
      transient: true,
      projectCustomization: false,
      loadExtensions: false,
      orchestrationPrompt: false,
      selfCorrectionHooks: false,
    });
    session.eventBus.on("text_delta", ({ text }) => {
      receivedText += text;
    });

    await session.initialize();
    expect(session.getState()).toMatchObject({ provider: "azure", model: internalModelId });
    await session.prompt("Reply through the Azure deployment.");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(baseUrl);
    expect(new Headers(init?.headers).get("api-key")).toBe(apiKey);

    const requestBody = JSON.parse(String(init?.body)) as {
      model: string;
      input: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    };
    expect(requestBody.model).toBe(deployment);
    expect(requestBody.input).toContainEqual({
      role: "user",
      content: [{ type: "input_text", text: "Reply through the Azure deployment." }],
    });
    expect(receivedText).toBe(streamedText);
  } finally {
    await session?.dispose();
    if (models) {
      const index = models.findIndex(
        (model) => model.provider === "azure" && model.id === internalModelId,
      );
      if (index !== -1) models.splice(index, 1);
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    await Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(project, { recursive: true, force: true }),
    ]);
  }
}, 15_000);
