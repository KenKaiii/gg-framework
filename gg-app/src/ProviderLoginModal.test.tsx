// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { authApiKey, authSetBaseUrl, openRouterCatalog, type AuthProvider } from "./agent";
import { ProviderLoginModal } from "./ProviderLoginModal";

vi.mock("./agent", () => ({
  openUrl: vi.fn(),
  authApiKey: vi.fn(),
  authOAuthStart: vi.fn(),
  authOAuthCode: vi.fn(),
  authLogout: vi.fn(),
  authSetBaseUrl: vi.fn(),
  openRouterCatalog: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));

const authApiKeyMock = vi.mocked(authApiKey);
const authSetBaseUrlMock = vi.mocked(authSetBaseUrl);
const catalogMock = vi.mocked(openRouterCatalog);

const OPENROUTER: AuthProvider = {
  value: "openrouter",
  label: "OpenRouter",
  description: "multi-provider gateway",
  methods: ["apikey"],
  apiKeyLabel: "OpenRouter",
  allowCustomBaseUrl: true,
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  connected: false,
  connectedMethods: [],
};

beforeEach(() => {
  catalogMock.mockResolvedValue({
    synced: false,
    count: 0,
    baseUrl: "https://openrouter.ai/api/v1",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProviderLoginModal — custom base URL", () => {
  it("sends the typed base URL with a new key", async () => {
    authApiKeyMock.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ProviderLoginModal provider={OPENROUTER} onClose={onClose} onChanged={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Paste your API key"), {
      target: { value: "sk-or-1" },
    });
    fireEvent.change(screen.getByLabelText("API base URL"), {
      target: { value: "https://gw.example.com/v1" },
    });
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() =>
      expect(authApiKeyMock).toHaveBeenCalledWith(
        "openrouter",
        "sk-or-1",
        undefined,
        "https://gw.example.com/v1",
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("saves only the base URL for a connected key and drops a stale synced list", async () => {
    catalogMock.mockResolvedValueOnce({
      synced: true,
      count: 12,
      baseUrl: "https://openrouter.ai/api/v1",
    });
    catalogMock.mockResolvedValueOnce({
      synced: false,
      count: 0,
      baseUrl: "https://gw.example.com/v1",
    });
    render(
      <ProviderLoginModal
        provider={{ ...OPENROUTER, connected: true, connectedMethods: ["apikey"] }}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Model list synced from the endpoint \(12\)/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("API base URL"), {
      target: { value: "https://gw.example.com/v1" },
    });
    fireEvent.click(screen.getByText("Save base URL"));

    await waitFor(() =>
      expect(authSetBaseUrlMock).toHaveBeenCalledWith("openrouter", "https://gw.example.com/v1"),
    );
    await waitFor(() => expect(catalogMock).toHaveBeenCalledWith("reset"));
    expect(await screen.findByText(/Sync models to list what this endpoint serves/)).toBeTruthy();
  });

  it("syncs the model list and reports what was left out", async () => {
    render(
      <ProviderLoginModal
        provider={{ ...OPENROUTER, connected: true, connectedMethods: ["apikey"] }}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    await screen.findByText(/Using the built-in model list/);
    catalogMock.mockResolvedValueOnce({
      synced: true,
      count: 390,
      skipped: 65,
      baseUrl: "https://openrouter.ai/api/v1",
    });

    fireEvent.click(screen.getByText("Sync models"));

    expect(
      await screen.findByText(
        "Synced 390 models from openrouter.ai (65 without tool calling left out).",
      ),
    ).toBeTruthy();
    expect(catalogMock).toHaveBeenCalledWith("sync");
  });

  it("shows no base URL field for providers that don't take one", () => {
    render(
      <ProviderLoginModal
        provider={{ ...OPENROUTER, value: "deepseek", allowCustomBaseUrl: false }}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("API base URL")).toBeNull();
    expect(catalogMock).not.toHaveBeenCalled();
  });
});
