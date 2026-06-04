import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginGemini } from "./gemini.js";

const originalFetch = globalThis.fetch;
const originalCodeAssistEndpoint = process.env.CODE_ASSIST_ENDPOINT;
const originalCodeAssistApiVersion = process.env.CODE_ASSIST_API_VERSION;
const originalGoogleCloudProject = process.env.GOOGLE_CLOUD_PROJECT;
const originalGoogleCloudProjectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
const originalGeminiClientId = process.env.GGCODER_GEMINI_OAUTH_CLIENT_ID;
const originalGeminiClientSecret = process.env.GGCODER_GEMINI_OAUTH_CLIENT_SECRET;

function tokenResponse(): Response {
  return new Response(
    JSON.stringify({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3_600,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function completeLoopbackLogin(authUrl: string): void {
  const loginUrl = new URL(authUrl);
  if (loginUrl.hostname !== "accounts.google.com") return;
  const redirectUri = loginUrl.searchParams.get("redirect_uri");
  const state = loginUrl.searchParams.get("state");
  if (!redirectUri || !state) return;
  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", "oauth-code");
  callbackUrl.searchParams.set("state", state);

  const req = http.get(callbackUrl, (res) => {
    res.resume();
  });
  req.on("error", () => undefined);
}

describe("loginGemini", () => {
  beforeEach(() => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    process.env.GGCODER_GEMINI_OAUTH_CLIENT_ID = "test-client-id";
    process.env.GGCODER_GEMINI_OAUTH_CLIENT_SECRET = "test-client-secret";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalCodeAssistEndpoint === undefined) {
      delete process.env.CODE_ASSIST_ENDPOINT;
    } else {
      process.env.CODE_ASSIST_ENDPOINT = originalCodeAssistEndpoint;
    }
    if (originalCodeAssistApiVersion === undefined) {
      delete process.env.CODE_ASSIST_API_VERSION;
    } else {
      process.env.CODE_ASSIST_API_VERSION = originalCodeAssistApiVersion;
    }
    if (originalGoogleCloudProject === undefined) {
      delete process.env.GOOGLE_CLOUD_PROJECT;
    } else {
      process.env.GOOGLE_CLOUD_PROJECT = originalGoogleCloudProject;
    }
    if (originalGoogleCloudProjectId === undefined) {
      delete process.env.GOOGLE_CLOUD_PROJECT_ID;
    } else {
      process.env.GOOGLE_CLOUD_PROJECT_ID = originalGoogleCloudProjectId;
    }
    if (originalGeminiClientId === undefined) {
      delete process.env.GGCODER_GEMINI_OAUTH_CLIENT_ID;
    } else {
      process.env.GGCODER_GEMINI_OAUTH_CLIENT_ID = originalGeminiClientId;
    }
    if (originalGeminiClientSecret === undefined) {
      delete process.env.GGCODER_GEMINI_OAUTH_CLIENT_SECRET;
    } else {
      process.env.GGCODER_GEMINI_OAUTH_CLIENT_SECRET = originalGeminiClientSecret;
    }
    vi.restoreAllMocks();
  });

  it("opens validation URLs and retries Code Assist setup", async () => {
    process.env.CODE_ASSIST_ENDPOINT = "https://code-assist.example.test";
    process.env.CODE_ASSIST_API_VERSION = "v2test";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ineligibleTiers: [
              {
                reasonCode: "VALIDATION_REQUIRED",
                reasonMessage: "verify account",
                validationUrl: "https://validation.example.test",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            currentTier: { id: "standard-tier" },
            cloudaicompanionProject: "validated-project",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    globalThis.fetch = fetchMock;
    const openedUrls: string[] = [];

    const creds = await loginGemini({
      onOpenUrl: (url) => {
        openedUrls.push(url);
        completeLoopbackLogin(url);
      },
      onPromptCode: async (message) => {
        if (message.includes("validation")) return "";
        throw new Error(`Unexpected Gemini prompt: ${message}`);
      },
      onStatus: vi.fn(),
    });

    expect(creds.projectId).toBe("validated-project");
    expect(openedUrls).toContain("https://validation.example.test");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://code-assist.example.test/v2test:loadCodeAssist",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://code-assist.example.test/v2test:loadCodeAssist",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("uses free-tier onboarding metadata without a project", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            allowedTiers: [{ id: "free-tier", isDefault: true }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            done: true,
            response: { cloudaicompanionProject: { id: "managed-project" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    globalThis.fetch = fetchMock;
    const openedUrls: string[] = [];

    const creds = await loginGemini({
      onOpenUrl: (url) => {
        openedUrls.push(url);
        completeLoopbackLogin(url);
      },
      onPromptCode: async (message) => {
        throw new Error(`Unexpected Gemini prompt: ${message}`);
      },
      onStatus: vi.fn(),
    });

    expect(creds.projectId).toBe("managed-project");
    const [, onboardInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(onboardInit.body as string)).toEqual({
      tierId: "free-tier",
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    });
  });
});
