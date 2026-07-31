import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RESPONSES_URL = "https://example.openai.azure.com/openai/v1/responses";
const TEST_API_KEY = "azure-test-key";
const MODEL_ID = "azure:gpt-5.6-sol";
const DEPLOYMENT = "gpt-5.6-sol";
// Exceed the upstream GPT-5.6 Sol 1.05M-window 10% compaction threshold across two turns.
const LARGE_RESPONSE = "old context ".repeat(20_000);
const SUMMARY =
  "### Primary Request and Intent\nPreserve Azure compaction context.\n\n### Next Step\nResume the Azure session.";

let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalAzureApiKey: string | undefined;
let originalAzureBaseUrl: string | undefined;
let originalAzureDeployment: string | undefined;
let home: string;
let project: string;

type CapturedRequest = {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
};

function sseResponse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function textResponse(text: string, inputTokens = 100): Response {
  return sseResponse([
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.completed",
      response: { usage: { input_tokens: inputTokens, output_tokens: 20 } },
    },
  ]);
}

function toolCallResponse(): Response {
  return sseResponse([
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc_recent", call_id: "call_recent", name: "ls" },
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: "fc_recent",
      arguments: '{"path":"."}',
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_recent",
        call_id: "call_recent",
        name: "ls",
        arguments: '{"path":"."}',
      },
    },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 100, output_tokens: 20 } },
    },
  ]);
}

async function writeSettings(autoCompact: boolean, compactThreshold = 0.8): Promise<void> {
  const filePath = path.join(home, ".gg", "settings.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({ autoCompact, compactThreshold, idealReviewEnabled: false }),
    "utf-8",
  );
}

function isSummaryRequest(body: Record<string, unknown>): boolean {
  return JSON.stringify(body).includes("conversation compaction assistant");
}

async function createSession(options: { sessionId?: string } = {}) {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "azure",
    model: MODEL_ID,
    baseUrl: RESPONSES_URL,
    cwd: project,
    systemPrompt: "Use Azure tools and preserve the session.",
    maxTurns: 3,
    projectCustomization: false,
    loadExtensions: false,
    selfCorrectionHooks: false,
    orchestrationPrompt: false,
    ...options,
  });
  await session.initialize();
  return session;
}

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalAzureApiKey = process.env.AZURE_OPENAI_API_KEY;
  originalAzureBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
  originalAzureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-azure-compaction-home-"));
  project = await fs.mkdtemp(path.join(os.tmpdir(), "gg-azure-compaction-project-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.AZURE_OPENAI_API_KEY = TEST_API_KEY;
  process.env.AZURE_OPENAI_BASE_URL = RESPONSES_URL;
  process.env.AZURE_OPENAI_DEPLOYMENT = DEPLOYMENT;
  await writeSettings(false);
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
    fs.rm(home, { recursive: true, force: true }),
    fs.rm(project, { recursive: true, force: true }),
  ]);
});

describe("AgentSession Azure compaction and resume", () => {
  it("persists a compacted continuation and resumes its Azure tool history", async () => {
    const requests: CapturedRequest[] = [];
    let ordinaryRequest = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), headers: new Headers(init?.headers), body });
      if (isSummaryRequest(body)) return textResponse(SUMMARY);

      ordinaryRequest += 1;
      if (ordinaryRequest <= 2) return textResponse(LARGE_RESPONSE, 12_000);
      if (ordinaryRequest === 3) return toolCallResponse();
      if (ordinaryRequest === 4) return textResponse("Tool turn complete.");
      return textResponse("Resumed Azure response.");
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await createSession();
    let continuationPath: string;
    try {
      await session.prompt("Create old Azure context one.");
      await session.prompt("Create old Azure context two.");
      await session.prompt("List the project before compaction.");
      const originalPath = session.getState().sessionPath;

      await session.compact();
      continuationPath = session.getState().sessionPath;
      expect(continuationPath).not.toBe(originalPath);
    } finally {
      await session.dispose();
    }

    const summaryRequest = requests.find((request) => isSummaryRequest(request.body));
    expect(summaryRequest).toBeDefined();
    expect(summaryRequest?.url).toBe(RESPONSES_URL);
    expect(summaryRequest?.headers.get("api-key")).toBe(TEST_API_KEY);
    expect(summaryRequest?.body).toMatchObject({
      model: DEPLOYMENT,
      store: false,
      max_output_tokens: 4096,
    });
    expect(JSON.stringify(summaryRequest?.body.input)).toContain(
      "Summarize the conversation above",
    );

    const persisted = await fs.readFile(continuationPath, "utf-8");
    const [header] = persisted
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(header).toMatchObject({ type: "session", provider: "azure", model: MODEL_ID });
    expect(persisted).toContain("[Previous conversation summary]");
    expect(persisted).toContain('"name":"ls"');
    expect(persisted).toContain('"toolCallId":"call_recent"');
    expect(persisted).not.toContain(TEST_API_KEY);

    const resumed = await createSession({ sessionId: continuationPath });
    try {
      await resumed.prompt("Continue from the compacted Azure history.");
      expect(resumed.getState().sessionPath).toBe(continuationPath);
    } finally {
      await resumed.dispose();
    }

    const resumedRequest = requests.at(-1)?.body;
    const resumedInput = JSON.stringify(resumedRequest?.input);
    expect(resumedRequest?.model).toBe(DEPLOYMENT);
    expect(resumedInput).toContain("[Previous conversation summary]");
    expect(resumedInput).toContain("call_recent");
    expect(resumedInput).toContain("Continue from the compacted Azure history");

    const appended = await fs.readFile(continuationPath, "utf-8");
    expect(appended).toContain("Resumed Azure response.");
    expect(appended).not.toContain(TEST_API_KEY);
  }, 30_000);

  it("uses the shared automatic transform compactor with the Azure endpoint and deployment", async () => {
    await writeSettings(true, 0.1);
    const requests: CapturedRequest[] = [];
    let ordinaryRequest = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), headers: new Headers(init?.headers), body });
      if (isSummaryRequest(body)) return textResponse(SUMMARY);

      ordinaryRequest += 1;
      if (ordinaryRequest <= 2) return textResponse(LARGE_RESPONSE, 100);
      if (ordinaryRequest === 3) return toolCallResponse();
      if (ordinaryRequest === 4) return textResponse("Tool turn complete.", 200_000);
      return textResponse("Automatic compaction continued.");
    });
    vi.stubGlobal("fetch", fetchMock);

    const session = await createSession();
    try {
      await session.prompt("Create first old Azure context.");
      await session.prompt("Create second old Azure context.");
      await session.prompt("List the project before automatic compaction.");
      await session.prompt("Continue after the automatic Azure compactor.");
    } finally {
      await session.dispose();
    }

    const summaryRequest = requests.find((request) => isSummaryRequest(request.body));
    expect(summaryRequest).toMatchObject({ url: RESPONSES_URL });
    expect(summaryRequest?.headers.get("api-key")).toBe(TEST_API_KEY);
    expect(summaryRequest?.body.model).toBe(DEPLOYMENT);
    expect(JSON.stringify(summaryRequest?.body.input)).toContain("Create first old Azure context");
    expect(requests.at(-1)?.body.model).toBe(DEPLOYMENT);
    expect(JSON.stringify(requests.at(-1)?.body.input)).toContain(
      "Continue after the automatic Azure compactor",
    );
  }, 30_000);
});
