// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  authApiKey,
  authOAuthStart,
  authSetBaseUrl,
  openRouterCatalog,
  subscribe,
  type AuthProvider,
  type SidecarEvent,
} from "./agent";
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

describe("ProviderLoginModal — what each key bills", () => {
  const KIMI: AuthProvider = {
    value: "moonshot",
    label: "Kimi (Moonshot)",
    description: "Kimi K3",
    methods: ["apikey"],
    apiKeyLabel: "Kimi",
    apiKeyVariants: [
      {
        key: "kimi-code",
        label: "Kimi Code plan",
        kind: "plan",
        billing: "Uses your Kimi Code plan. Create the key in the Kimi Code Console.",
      },
      {
        key: "moonshot",
        label: "Moonshot API",
        kind: "payg",
        billing: "Pay-per-token from platform.moonshot.ai.",
      },
    ],
    connected: false,
    connectedMethods: [],
  };

  it("shows the chosen key type's billing and stores the key under it", async () => {
    authApiKeyMock.mockResolvedValue(undefined);
    render(<ProviderLoginModal provider={KIMI} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText(/Uses your Kimi Code plan/)).toBeDefined();

    fireEvent.click(screen.getByRole("radio", { name: "Moonshot API" }));
    expect(screen.getByText("Pay-per-token from platform.moonshot.ai.")).toBeDefined();
    expect(screen.queryByText(/Uses your Kimi Code plan/)).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("Paste your API key"), {
      target: { value: "sk-moonshot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(authApiKeyMock).toHaveBeenCalledWith("moonshot", "sk-moonshot", "moonshot", undefined),
    );
  });

  it("tells a single-key provider's guidance, such as GLM's Coding Plan limit", () => {
    const glm: AuthProvider = {
      value: "glm",
      label: "Z.AI (GLM)",
      description: "GLM-5.3",
      methods: ["apikey"],
      apiKeyLabel: "Z.AI",
      methodGuidance: [
        {
          method: "apikey",
          label: "Z.AI API key",
          billing: "Pay-per-token from your Z.AI account balance.",
          when: "GLM Coding Plan quota can't be used here: Z.AI limits the plan to the tools it lists.",
        },
      ],
      connected: false,
      connectedMethods: [],
    };
    render(<ProviderLoginModal provider={glm} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText(/Z.AI account balance/)).toBeDefined();
    expect(screen.getByText(/Coding Plan quota can't be used here/)).toBeDefined();
  });

  it("labels the OpenAI sign-in Continue with ChatGPT", () => {
    const openai: AuthProvider = {
      value: "openai",
      label: "OpenAI",
      description: "GPT-6.1 Sol",
      methods: ["oauth", "apikey"],
      apiKeyLabel: "OpenAI",
      methodGuidance: [
        {
          method: "oauth",
          label: "Continue with ChatGPT",
          billing: "Uses your ChatGPT plan.",
          when: "",
        },
        { method: "apikey", label: "OpenAI API key", billing: "Pay-per-token.", when: "" },
      ],
      connected: false,
      connectedMethods: [],
    };
    render(<ProviderLoginModal provider={openai} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText("Continue with ChatGPT")).toBeDefined();
    fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[0]!);
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeDefined();
  });
});

describe("ProviderLoginModal — first ChatGPT sign-in", () => {
  const OPENAI: AuthProvider = {
    value: "openai",
    label: "OpenAI",
    description: "GPT-6 Luna",
    methods: ["oauth", "apikey"],
    methodGuidance: [
      {
        method: "oauth",
        label: "Continue with ChatGPT",
        billing: "Uses your ChatGPT plan.",
        when: "",
      },
      { method: "apikey", label: "OpenAI API key", billing: "Pay-per-token.", when: "" },
    ],
    connected: false,
    connectedMethods: [],
  };

  async function signIn(onClose: () => void): Promise<void> {
    let listener: ((e: SidecarEvent) => void) | undefined;
    vi.mocked(subscribe).mockImplementation((fn) => {
      listener = fn as (e: SidecarEvent) => void;
      return () => {};
    });
    vi.mocked(authOAuthStart).mockResolvedValue(undefined);
    render(<ProviderLoginModal provider={OPENAI} onClose={onClose} onChanged={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    await waitFor(() => expect(authOAuthStart).toHaveBeenCalledWith("openai"));
    await act(async () => {
      listener!({ type: "auth_done", data: { provider: "openai" } } as SidecarEvent);
    });
  }

  beforeEach(() => localStorage.removeItem("gg-chatgpt-plan-welcomed"));

  it("confirms plan use once, with Manage usage and Got it", async () => {
    const onClose = vi.fn();
    await signIn(onClose);
    expect(screen.getByText("You're using your ChatGPT plan")).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes straight away on later sign-ins", async () => {
    localStorage.setItem("gg-chatgpt-plan-welcomed", "1");
    const onClose = vi.fn();
    await signIn(onClose);
    expect(screen.queryByText("You're using your ChatGPT plan")).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });
});
