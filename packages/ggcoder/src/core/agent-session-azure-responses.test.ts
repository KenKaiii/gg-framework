import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const RESPONSES_URL = "https://example.openai.azure.com/openai/v1/responses";

let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalAzureApiKey: string | undefined;
let originalAzureBaseUrl: string | undefined;
let originalAzureDeployment: string | undefined;
let home: string;
let project: string;

function sseResponse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf-8");
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalAzureApiKey = process.env.AZURE_OPENAI_API_KEY;
  originalAzureBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
  originalAzureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-azure-agent-home-"));
  project = await fs.mkdtemp(path.join(os.tmpdir(), "gg-azure-agent-project-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_BASE_URL = RESPONSES_URL;
  process.env.AZURE_OPENAI_DEPLOYMENT = "test-deployment";
  await writeJson(path.join(home, ".gg", "settings.json"), {
    autoCompact: false,
    idealReviewEnabled: false,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalAzureApiKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
  else process.env.AZURE_OPENAI_API_KEY = originalAzureApiKey;
  if (originalAzureBaseUrl === undefined) delete process.env.AZURE_OPENAI_BASE_URL;
  else process.env.AZURE_OPENAI_BASE_URL = originalAzureBaseUrl;
  if (originalAzureDeployment === undefined) delete process.env.AZURE_OPENAI_DEPLOYMENT;
  else process.env.AZURE_OPENAI_DEPLOYMENT = originalAzureDeployment;
  await Promise.all([
    fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
    fs.rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  ]);
});

async function createAzureSession(options: { signal?: AbortSignal } = {}) {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "azure",
    model: `azure:${process.env.AZURE_OPENAI_DEPLOYMENT}`,
    baseUrl: RESPONSES_URL,
    cwd: project,
    systemPrompt: "Azure regression test.",
    maxTurns: 3,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    selfCorrectionHooks: false,
    orchestrationPrompt: false,
    ...options,
  });
  await session.initialize();
  return session;
}

describe("AgentSession Azure Responses tool round trip", () => {
  it("declares, executes, submits, and follows an Azure function call with final text", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return sseResponse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "ls" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "fc_1",
            delta: '{"path":',
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "fc_1",
            delta: '"."}',
          },
          {
            type: "response.function_call_arguments.done",
            output_index: 0,
            item_id: "fc_1",
            arguments: '{"path":"."}',
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "ls",
              arguments: '{"path":"."}',
            },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 3 } },
          },
        ]);
      }
      return sseResponse([
        { type: "response.output_text.delta", delta: "Azure tool complete." },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 14, output_tokens: 4 } },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "azure",
      model: "azure:test-deployment",
      baseUrl: RESPONSES_URL,
      cwd: project,
      systemPrompt: "Use tools when requested.",
      maxTurns: 3,
      transient: true,
      projectCustomization: false,
      loadExtensions: false,
    });
    const text: string[] = [];
    const toolResults: string[] = [];
    session.eventBus.on("text_delta", ({ text: delta }) => text.push(delta));
    session.eventBus.on("tool_call_end", ({ result }) => toolResults.push(result));

    try {
      await session.initialize();
      await session.prompt("List this project, then confirm completion.");
    } finally {
      await session.dispose();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies.map((body) => body.model)).toEqual(["test-deployment", "test-deployment"]);
    expect(requestBodies[0]?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "function", name: "ls" })]),
    );
    expect(JSON.stringify(requestBodies[0]?.input)).toContain("List this project");
    expect(toolResults).toHaveLength(1);

    const secondInput = requestBodies[1]?.input as Record<string, unknown>[];
    expect(secondInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "ls",
          arguments: '{"path":"."}',
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_1",
          output: toolResults[0],
        }),
      ]),
    );
    expect(text.join("")).toBe("Azure tool complete.");
  }, 10_000);

  it("declares and executes an MCP-shaped tool through the normal Azure tool map", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-5.6-sol";
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        return sseResponse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_mcp",
              call_id: "call_mcp",
              name: "mcp__demo__lookup",
            },
          },
          {
            type: "response.function_call_arguments.done",
            output_index: 0,
            item_id: "fc_mcp",
            arguments: '{"query":"Azure"}',
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_mcp",
              call_id: "call_mcp",
              name: "mcp__demo__lookup",
              arguments: '{"query":"Azure"}',
            },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 8, output_tokens: 2 } },
          },
        ]);
      }
      return sseResponse([
        { type: "response.output_text.delta", delta: "MCP complete." },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 10, output_tokens: 2 } },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "azure",
      model: "azure:gpt-5.6-sol",
      baseUrl: RESPONSES_URL,
      cwd: project,
      systemPrompt: "Use the MCP tool.",
      transient: true,
      projectCustomization: false,
      loadExtensions: false,
      selfCorrectionHooks: false,
      orchestrationPrompt: false,
      additionalTools: [
        {
          name: "mcp__demo__lookup",
          description: "Demo MCP lookup",
          parameters: z.object({ query: z.string() }),
          execute: async (args) => {
            const { query } = z.object({ query: z.string() }).parse(args);
            return { content: `MCP result for ${query}` };
          },
        },
      ],
    });

    try {
      await session.initialize();
      await session.prompt("Use the MCP lookup.");
    } finally {
      await session.dispose();
    }

    expect(requestBodies[0]?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function", name: "mcp__demo__lookup" }),
      ]),
    );
    expect(requestBodies[1]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_mcp",
          output: "MCP result for Azure",
        }),
      ]),
    );
  });
});

describe("AgentSession Azure retry boundary", () => {
  it.each([429, 500])(
    "retries transient Azure HTTP %s through the shared agent loop",
    async (status) => {
      process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-5.6-sol";
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: `temporary ${status}` } }), { status }),
        )
        .mockResolvedValueOnce(
          sseResponse([
            { type: "response.output_text.delta", delta: "Recovered." },
            {
              type: "response.completed",
              response: { usage: { input_tokens: 5, output_tokens: 2 } },
            },
          ]),
        );
      vi.stubGlobal("fetch", fetchMock);
      const session = await createAzureSession();

      try {
        await session.prompt("Recover from a transient Azure error.");
      } finally {
        await session.dispose();
      }

      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
    10_000,
  );

  it("surfaces an Azure 401 after one request without rewriting environment or auth storage", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-5.6-sol";
    const authPath = path.join(home, ".gg", "auth.json");
    const authBytes = '{"sentinel":{"accessToken":"unchanged"}}';
    await fs.writeFile(authPath, authBytes, "utf-8");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "revoked Azure key" } }), { status: 401 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const session = await createAzureSession();

    try {
      await expect(session.prompt("Do not replay a revoked key.")).rejects.toMatchObject({
        provider: "azure",
        statusCode: 401,
      });
    } finally {
      await session.dispose();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.env.AZURE_OPENAI_API_KEY).toBe("test-key");
    await expect(fs.readFile(authPath, "utf-8")).resolves.toBe(authBytes);
  });

  it("stops an aborted Azure request without retry", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-5.6-sol";
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      controller.abort();
      throw new DOMException("Cancelled", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const session = await createAzureSession({ signal: controller.signal });

    try {
      await expect(session.prompt("Cancel this Azure request.")).resolves.toBeUndefined();
    } finally {
      await session.dispose();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
