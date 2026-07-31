// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  modelListener: undefined as (() => void) | undefined,
  unlisten: vi.fn(),
}));

vi.mock("./agent", () => {
  class AzureConnectionCommandError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly field: "endpoint" | "deployment" | "apiKey" | null = null,
    ) {
      super(message);
    }
  }
  return {
    AzureConnectionCommandError,
    getAzureConnectionStatus: agentMocks.getStatus,
    saveAzureConnection: agentMocks.save,
    removeAzureConnection: agentMocks.remove,
    onModelsChanged: vi.fn(async (listener: () => void) => {
      agentMocks.modelListener = listener;
      return agentMocks.unlisten;
    }),
  };
});

import { AzureConnectionCommandError } from "./agent";
import { AzureConnectionSettings } from "./AzureConnectionSettings";
import type { AzureConnectionStatus } from "./agent";

const disconnected: AzureConnectionStatus = {
  configured: false,
  source: "none",
  endpoint: null,
  deployment: null,
  endpointSummary: null,
  deploymentSummary: null,
  hasStoredKey: false,
};

const connected: AzureConnectionStatus = {
  configured: true,
  source: "secure",
  endpoint: "https://sample.openai.azure.com",
  deployment: "gpt-production",
  endpointSummary: "sample.openai.azure.com",
  deploymentSummary: "gpt-production",
  hasStoredKey: true,
};

const environment: AzureConnectionStatus = {
  configured: true,
  source: "environment",
  endpoint: null,
  deployment: null,
  endpointSummary: "env-resource.openai.azure.com",
  deploymentSummary: "env-deployment",
  hasStoredKey: false,
};

async function renderState(state: AzureConnectionStatus): Promise<ReturnType<typeof render>> {
  agentMocks.getStatus.mockResolvedValue(state);
  const result = render(<AzureConnectionSettings />);
  await screen.findByText(
    state.source === "secure"
      ? "Connected"
      : state.source === "environment"
        ? "Environment"
        : "Not connected",
  );
  return result;
}

function fillConnection(key = "canary-secret-value"): void {
  fireEvent.change(screen.getByLabelText("Endpoint"), {
    target: { value: "https://sample.openai.azure.com" },
  });
  fireEvent.change(screen.getByLabelText("Deployment"), {
    target: { value: "gpt-production" },
  });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: key } });
}

beforeEach(() => {
  agentMocks.getStatus.mockReset();
  agentMocks.save.mockReset();
  agentMocks.remove.mockReset();
  agentMocks.unlisten.mockReset();
  agentMocks.modelListener = undefined;
});

afterEach(cleanup);

describe("AzureConnectionSettings", () => {
  it("renders a labeled disconnected form with a write-only password field", async () => {
    const { container } = await renderState(disconnected);

    expect(screen.getByLabelText("Endpoint")).toHaveProperty("type", "url");
    expect(screen.getByLabelText("Deployment")).toBeTruthy();
    expect(screen.getByLabelText("API key")).toHaveProperty("type", "password");
    expect(screen.getByRole("button", { name: "Validate and connect" })).toBeTruthy();
    expect(container.textContent).toContain("never returned");
  });

  it("shows a secret-free connected summary and prefilled edit state", async () => {
    const { container } = await renderState(connected);

    expect(screen.getByText("sample.openai.azure.com")).toBeTruthy();
    expect(screen.getByText("gpt-production")).toBeTruthy();
    expect(screen.getByText(/stored securely/)).toBeTruthy();
    expect(container.innerHTML).not.toContain("canary-secret-value");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Endpoint")).toHaveProperty("value", connected.endpoint);
    expect(screen.getByLabelText("Deployment")).toHaveProperty("value", connected.deployment);
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    expect(screen.getByPlaceholderText("Leave blank to keep stored key")).toBeTruthy();
  });

  it("renders environment fallback as read-only and names its controls", async () => {
    await renderState(environment);

    expect(screen.getByText("env-resource.openai.azure.com")).toBeTruthy();
    expect(screen.getByText("Provided by environment")).toBeTruthy();
    expect(screen.getByText(/AZURE_OPENAI_BASE_URL/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  it("reports local field errors, clears the key, and focuses the first invalid field", async () => {
    await renderState(disconnected);
    fillConnection();
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "http://invalid" } });

    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }));

    expect(await screen.findByText(/HTTPS Azure resource endpoint/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Endpoint")));
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
    expect(agentMocks.save).not.toHaveBeenCalled();
  });

  it.each([
    "https://example-francecentral.cognitiveservices.azure.com",
    "https://sample.openai.azure.com/",
    "https://sample.openai.azure.com:443",
  ])("accepts the official Azure resource origin %s", async (endpoint) => {
    agentMocks.save.mockResolvedValue(connected);
    await renderState(disconnected);
    fillConnection();
    fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: endpoint } });

    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }));

    await waitFor(() => expect(agentMocks.save).toHaveBeenCalledTimes(1));
    expect(agentMocks.save).toHaveBeenCalledWith(expect.objectContaining({ endpoint }));
    expect(screen.queryByText(/HTTPS Azure resource endpoint/)).toBeNull();
  });

  it.each([
    ["HTTP", "http://resource.openai.azure.com"],
    ["embedded credentials", "https://user:password@resource.openai.azure.com"],
    ["a Responses path", "https://resource.openai.azure.com/openai/v1/responses"],
    ["a query string", "https://resource.openai.azure.com?api-version=preview"],
    ["a fragment", "https://resource.openai.azure.com#fragment"],
    ["a non-default port", "https://resource.openai.azure.com:8443"],
    ["a dotted OpenAI resource name", "https://nested.resource.openai.azure.com"],
    [
      "a dotted Cognitive Services resource name",
      "https://nested.resource.cognitiveservices.azure.com",
    ],
    ["an unrelated domain", "https://example.com"],
    ["a deceptive OpenAI suffix", "https://resource.openai.azure.com.example.com"],
    [
      "a deceptive Cognitive Services suffix",
      "https://resource.cognitiveservices.azure.com.example.com",
    ],
    ["an IP address", "https://127.0.0.1"],
    ["localhost", "https://localhost"],
  ])("rejects endpoint with %s locally", async (_name, endpoint) => {
    await renderState(disconnected);
    fillConnection();
    const invalidInput = screen.getByLabelText("Endpoint");
    fireEvent.change(invalidInput, { target: { value: endpoint } });

    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }));

    expect(await screen.findByText(/HTTPS Azure resource endpoint/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(invalidInput));
    expect(agentMocks.save).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "oversized deployment names",
      label: "Deployment",
      value: "d".repeat(257),
      error: /1 to 256 characters/,
    },
    {
      name: "oversized API keys",
      label: "API key",
      value: "k".repeat(8_193),
      error: /valid Azure OpenAI API key/,
    },
  ])("rejects $name locally and focuses the invalid field", async ({ label, value, error }) => {
    await renderState(disconnected);
    fillConnection();
    const invalidInput = screen.getByLabelText(label);
    fireEvent.change(invalidInput, { target: { value } });

    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }));

    expect(await screen.findByText(error)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(invalidInput));
    expect(agentMocks.save).not.toHaveBeenCalled();
  });

  it("completes a successful save without waiting for a model refresh event", async () => {
    const onConnectionChanged = vi.fn();
    agentMocks.getStatus.mockResolvedValue(disconnected);
    agentMocks.save.mockResolvedValue(connected);
    const { container } = render(
      <AzureConnectionSettings onConnectionChanged={onConnectionChanged} />,
    );
    await screen.findByText("Not connected");
    fillConnection();

    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }));

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("Azure connection saved. Models refreshed.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Azure connection saved. Models refreshed.",
    );
    expect(screen.getByRole("button", { name: "Edit" })).toHaveProperty("disabled", false);
    expect(agentMocks.save).toHaveBeenCalledTimes(1);
    expect(agentMocks.save).toHaveBeenCalledWith({
      endpoint: connected.endpoint,
      deployment: connected.deployment,
      apiKey: "canary-secret-value",
    });
    expect(onConnectionChanged).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain("canary-secret-value");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("API key")).toHaveProperty("value", "");
  });

  it("clears the key after a sanitized command error and on unmount", async () => {
    agentMocks.save.mockRejectedValue(
      new AzureConnectionCommandError("The API key is invalid.", "invalid_api_key", "apiKey"),
    );
    const result = await renderState(disconnected);
    fillConnection();

    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }));
    expect(await screen.findByText("The API key is invalid.")).toBeTruthy();
    const keyInput = screen.getByLabelText("API key") as HTMLInputElement;
    expect(keyInput.value).toBe("");
    expect(document.activeElement).toBe(keyInput);

    fireEvent.change(keyInput, { target: { value: "second-canary-secret" } });
    result.unmount();
    expect(keyInput.value).toBe("");
  });

  it("completes a successful removal without waiting for a model refresh event", async () => {
    agentMocks.remove.mockResolvedValue(disconnected);
    await renderState(connected);

    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
    expect(screen.getByRole("alertdialog", { name: "Remove Azure connection?" })).toBeTruthy();
    expect(agentMocks.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));

    expect(await screen.findByText("Not connected")).toBeTruthy();
    expect(screen.getByText("Azure connection removed. Models refreshed.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Azure connection removed. Models refreshed.",
    );
    expect(screen.getByRole("button", { name: "Validate and connect" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(agentMocks.remove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("ignores a stale initial status response after a model refresh", async () => {
    let resolveInitial!: (status: AzureConnectionStatus) => void;
    let resolveRefresh!: (status: AzureConnectionStatus) => void;
    agentMocks.getStatus
      .mockReturnValueOnce(new Promise((resolve) => (resolveInitial = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveRefresh = resolve)));

    render(<AzureConnectionSettings />);
    await waitFor(() => expect(agentMocks.modelListener).toEqual(expect.any(Function)));
    await act(async () => agentMocks.modelListener?.());
    await act(async () => resolveRefresh(connected));
    expect(await screen.findByText("Connected")).toBeTruthy();

    await act(async () => resolveInitial(disconnected));
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByText("Not connected")).toBeNull();
  });

  it("reflects a persisted save when only model refresh fails", async () => {
    agentMocks.getStatus.mockResolvedValueOnce(disconnected).mockResolvedValueOnce(connected);
    agentMocks.save.mockRejectedValue(
      new AzureConnectionCommandError(
        "The Azure connection changed, but models did not refresh. Restart gg-app to apply it.",
        "models_refresh_failed",
      ),
    );
    render(<AzureConnectionSettings />);
    await screen.findByText("Not connected");
    fillConnection();

    fireEvent.click(screen.getByRole("button", { name: "Validate and connect" }));

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText(/Restart gg-app to apply it/)).toBeTruthy();
    expect(agentMocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it("reflects a persisted removal when only model refresh fails", async () => {
    agentMocks.getStatus.mockResolvedValueOnce(connected).mockResolvedValueOnce(environment);
    agentMocks.remove.mockRejectedValue(
      new AzureConnectionCommandError(
        "The Azure connection changed, but models did not refresh. Restart gg-app to apply it.",
        "models_refresh_failed",
      ),
    );
    render(<AzureConnectionSettings />);
    await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove connection" }));

    expect(await screen.findByText("Environment")).toBeTruthy();
    expect(screen.getByText(/Restart gg-app to apply it/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("clears the password node on cancel and an external status transition", async () => {
    agentMocks.getStatus.mockResolvedValueOnce(connected).mockResolvedValueOnce(environment);
    render(<AzureConnectionSettings />);
    await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const cancelledKey = screen.getByLabelText("API key") as HTMLInputElement;
    fireEvent.change(cancelledKey, { target: { value: "cancel-canary-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(cancelledKey.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const transitionedKey = screen.getByLabelText("API key") as HTMLInputElement;
    fireEvent.change(transitionedKey, { target: { value: "transition-canary-secret" } });
    await act(async () => agentMocks.modelListener?.());
    expect(await screen.findByText("Environment")).toBeTruthy();
    expect(transitionedKey.value).toBe("");
  });
});
