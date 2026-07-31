import { describe, expect, it } from "vitest";
import { ProviderError } from "@kenkaiiii/gg-ai";
import { formatSidecarError, sidecarSensitiveValues } from "./app-sidecar-error.js";

const ENDPOINT = "https://private-resource.openai.azure.com/openai/v1/responses";
const CREDENTIAL = "fixture-azure-secret";

describe("formatSidecarError", () => {
  it("keeps safe request diagnostics in logs but out of UI events", () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 30;
    const sensitiveValues = sidecarSensitiveValues({
      AZURE_OPENAI_API_KEY: CREDENTIAL,
      AZURE_OPENAI_BASE_URL: ENDPOINT,
    });
    const formatted = formatSidecarError(
      new ProviderError(
        "azure",
        `Capacity failure at private-resource.openai.azure.com using ${CREDENTIAL}`,
        {
          statusCode: 429,
          requestId: "req_safe-123",
          resetsAt,
        },
      ),
      (value) => value,
      sensitiveValues,
    );

    expect(formatted.logFields).toMatchObject({
      provider: "azure",
      statusCode: "429",
      requestId: "req_safe-123",
      resetsAt: String(resetsAt),
    });
    expect(formatted.event).toMatchObject({
      provider: "azure",
      statusCode: 429,
      resetsAt,
    });
    expect(formatted.event).not.toHaveProperty("requestId");
    expect(formatted.event.guidance).toContain("The provider says to retry after");
    expect(JSON.stringify(formatted)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(formatted)).not.toContain("private-resource.openai.azure.com");
    expect(JSON.stringify(formatted)).not.toContain(ENDPOINT);
  });

  it("drops malformed request IDs instead of logging provider payloads", () => {
    const formatted = formatSidecarError(
      new ProviderError("azure", "Temporary failure", {
        statusCode: 503,
        requestId: '{"headers":{"api-key":"raw-secret"}}',
      }),
    );

    expect(formatted.logFields).not.toHaveProperty("requestId");
    expect(formatted.event).not.toHaveProperty("requestId");
    expect(JSON.stringify(formatted)).not.toContain("raw-secret");
  });

  it("logs Azure malformed-stream diagnostics without exposing them to UI events", () => {
    const sensitivePayload = `secret=${CREDENTIAL}&host=private-resource.openai.azure.com`;
    const diagnosticCause = Object.assign(new Error(sensitivePayload), {
      diagnostic: {
        parserStage: "output_item_done_reasoning",
        causeKind: "none",
        eventType: "provider-message-secret",
        eventKeys: ["arguments", "credential-secret"],
        itemKeys: ["nested-secret"],
        arbitraryNested: { credential: CREDENTIAL },
      },
    });
    const formatted = formatSidecarError(
      new ProviderError("azure", "Azure OpenAI returned a malformed response stream.", {
        cause: diagnosticCause,
      }),
      (value) => value,
      sidecarSensitiveValues({
        AZURE_OPENAI_API_KEY: CREDENTIAL,
        AZURE_OPENAI_BASE_URL: ENDPOINT,
      }),
    );

    expect(formatted.logFields).toMatchObject({
      parserStage: "output_item_done_reasoning",
      causeKind: "none",
    });
    expect(Object.keys(formatted.logFields)).not.toEqual(
      expect.arrayContaining(["eventType", "eventKeys", "itemKeys", "arbitraryNested"]),
    );
    expect(formatted.event).not.toHaveProperty("parserStage");
    expect(JSON.stringify(formatted.event)).not.toContain("nested-secret");
    expect(JSON.stringify(formatted)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(formatted)).not.toContain("private-resource.openai.azure.com");
    expect(JSON.stringify(formatted)).not.toContain(sensitivePayload);
  });
});
