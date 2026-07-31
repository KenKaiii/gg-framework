import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn(),
    listen: vi.fn(async () => vi.fn()),
  }),
}));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));

import {
  asAzureCommandError,
  getAzureConnectionStatus,
  removeAzureConnection,
  saveAzureConnection,
  type AzureConnectionCommandError,
} from "./agent";

beforeEach(() => invoke.mockReset());

describe("Azure connection bridge", () => {
  it("uses typed native commands without requesting stored secrets", async () => {
    const status = {
      configured: true,
      source: "secure",
      endpoint: "https://sample.openai.azure.com",
      deployment: "gpt-production",
      endpointSummary: "sample.openai.azure.com",
      deploymentSummary: "gpt-production",
      hasStoredKey: true,
    } as const;
    invoke.mockResolvedValue(status);

    await expect(getAzureConnectionStatus()).resolves.toEqual(status);
    await expect(
      saveAzureConnection({ endpoint: status.endpoint, deployment: status.deployment }),
    ).resolves.toEqual(status);
    await expect(removeAzureConnection()).resolves.toEqual(status);
    expect(invoke).toHaveBeenNthCalledWith(1, "azure_connection_status");
    expect(invoke).toHaveBeenNthCalledWith(2, "azure_connection_save", {
      connection: { endpoint: status.endpoint, deployment: status.deployment },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "azure_connection_remove");
  });

  it("maps native field failures to fixed secret-free UI copy", () => {
    const azureError = asAzureCommandError(
      {
        code: "invalid_api_key",
        field: "apiKey",
        message: "raw provider body with canary-secret-value",
      },
      "The Azure connection could not be saved. Try again.",
    ) as AzureConnectionCommandError;
    expect(azureError.code).toBe("invalid_api_key");
    expect(azureError.field).toBe("apiKey");
    expect(azureError.message).toBe("The Azure OpenAI API key is invalid.");
  });

  it("sanitizes unknown and stringified failures", async () => {
    invoke
      .mockRejectedValueOnce("provider exploded with canary-secret-value")
      .mockRejectedValueOnce(
        JSON.stringify({
          code: "models_refresh_failed",
          message: "canary-secret-value",
        }),
      );

    await expect(getAzureConnectionStatus()).rejects.toMatchObject({
      code: "unknown",
      message: "Azure connection status could not be loaded. Try again.",
    });
    await expect(removeAzureConnection()).rejects.toMatchObject({
      code: "models_refresh_failed",
      message:
        "The Azure connection changed, but models did not refresh. Restart gg-app to apply it.",
    });
  });

  it("rejects unallowlisted codes, fields, and native messages", () => {
    const fallback = "Safe fallback.";
    const unknown = asAzureCommandError(
      {
        code: "provider_body_canary-secret-value",
        field: "apiKey",
        message: "raw native canary-secret-value",
      },
      fallback,
    );
    expect(unknown).toMatchObject({ code: "unknown", field: null, message: fallback });

    const invalidField = asAzureCommandError(
      { code: "invalid_endpoint", field: "credential", message: "raw native message" },
      fallback,
    );
    expect(invalidField).toMatchObject({
      code: "invalid_endpoint",
      field: null,
      message: "Enter a valid HTTPS Azure resource endpoint.",
    });
  });
});
