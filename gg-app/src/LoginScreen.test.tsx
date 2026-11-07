// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AuthProvider, SidecarEvent } from "./agent";
import { authLogout, authStatus } from "./agent";
import { LoginScreen } from "./LoginScreen";

const listeners = vi.hoisted(() => new Set<(e: SidecarEvent) => void>());

vi.mock("./agent", () => ({
  authStatus: vi.fn(),
  authLogout: vi.fn(),
  subscribe: (fn: (e: SidecarEvent) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
}));

vi.mock("./provider-logos", () => ({ providerLogo: () => null, providerLogoIsMono: () => false }));

// The brain is three.js + WebGL, which jsdom lacks; record what the page asks of it instead.
const bay = vi.hoisted(() => ({
  mount: vi.fn(),
  setConnected: vi.fn(),
  setMotion: vi.fn(),
  setHot: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("./brain/brain-bay", () => ({
  mountBrainBay: (opts: unknown) => {
    bay.mount(opts);
    return {
      setConnected: bay.setConnected,
      setMotion: bay.setMotion,
      setHot: bay.setHot,
      dispose: bay.dispose,
    };
  },
}));

function providers(connected: string[]): AuthProvider[] {
  return [
    { value: "anthropic", label: "Anthropic", description: "", methods: ["oauth"] },
    { value: "xai", label: "xAI (Grok)", description: "", methods: ["apikey"] },
  ].map((p) => ({ ...p, connected: connected.includes(p.value) })) as AuthProvider[];
}

/** Deliver one frame the way the sidecar/Rust fan-out would. */
async function emit(type: string, data: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    for (const fn of listeners) fn({ type, data } as SidecarEvent);
    await Promise.resolve();
  });
}

beforeEach(() => {
  listeners.clear();
  vi.mocked(authStatus).mockReset();
  for (const fn of Object.values(bay)) fn.mockReset();
});
afterEach(cleanup);

describe("LoginScreen read failure", () => {
  it("says the providers couldn't be read and retries, instead of an empty grid", async () => {
    // authStatus reports a failed read as [] (the real list is never empty).
    vi.mocked(authStatus).mockResolvedValueOnce([]).mockResolvedValue(providers([]));
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    expect(screen.getByText("Couldn't read your AI providers.")).toBeTruthy();
    expect(screen.queryByText("0 connected")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });

    expect(authStatus).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn't read your AI providers.")).toBeNull();
    expect(screen.getByText("0 connected")).toBeTruthy();
  });
});

describe("LoginScreen cross-window auth", () => {
  it("refreshes connection state when another window connects a provider", async () => {
    vi.mocked(authStatus).mockResolvedValue(providers([]));
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    expect(screen.getByText("0 connected")).toBeTruthy();

    // Another window completed a login; auth.json is shared, so this screen is
    // now stale. Without the auth_change subscription it stayed at "0 connected"
    // until the screen was reopened.
    vi.mocked(authStatus).mockResolvedValue(providers(["anthropic"]));
    await emit("auth_change", { provider: "anthropic" });

    expect(screen.getByText("1 connected")).toBeTruthy();
  });

  it("refreshes when another window disconnects a provider", async () => {
    vi.mocked(authStatus).mockResolvedValue(providers(["anthropic"]));
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    expect(screen.getByText("1 connected")).toBeTruthy();

    // Logout is native (Rust), so the sidecar never sees it — Rust emits
    // auth_change directly. `auth_done` would be the wrong signal here: nothing
    // logged in.
    vi.mocked(authStatus).mockResolvedValue(providers([]));
    await emit("auth_change", { provider: "anthropic" });

    expect(screen.getByText("0 connected")).toBeTruthy();
  });

  it("ignores unrelated agent events", async () => {
    vi.mocked(authStatus).mockResolvedValue(providers([]));
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    expect(authStatus).toHaveBeenCalledTimes(1);

    await emit("text_delta", { text: "hi" });
    await emit("run_end", {});

    // A re-read per streamed token would be absurd.
    expect(authStatus).toHaveBeenCalledTimes(1);
  });

  it("shows the Local models tile, naming the servers it covers, and the Hugging Face tile", async () => {
    vi.mocked(authStatus).mockResolvedValue(providers([]));
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    // Not clicking them: the real modals would call agent functions this test's
    // minimal mock doesn't define. The tiles themselves are what need pinning.
    expect(screen.getByText("Local models")).toBeTruthy();
    expect(screen.getByTitle(/LM Studio.*OpenAI-compatible endpoint/)).toBeTruthy();
    expect(screen.getByTitle("Hugging Face: download models to Ollama")).toBeTruthy();
  });
});

describe("LoginScreen brain bay", () => {
  const list = (connected: string[]): AuthProvider[] =>
    [
      { value: "anthropic", label: "Anthropic", methods: ["oauth"] },
      { value: "deepseek", label: "DeepSeek", methods: ["apikey"] },
      { value: "openai", label: "OpenAI", methods: ["oauth"] },
    ].map((p) => ({
      ...p,
      description: "",
      connected: connected.includes(p.value),
      connectedMethods: connected.includes(p.value) ? p.methods : [],
    })) as AuthProvider[];

  it("groups providers by country, with how many of each are connected", async () => {
    vi.mocked(authStatus).mockResolvedValue(list(["openai"]));
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    const us = screen.getByRole("region", { name: "United States" });
    expect(us.textContent).toContain("1 of 2");
    expect(screen.getByRole("region", { name: "China" }).textContent).toContain("DeepSeek");
    expect(screen.getByRole("button", { name: "OpenAI: connected with OAuth" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Anthropic: not connected" })).toBeTruthy();
  });

  it("wires the brain to the providers and re-wires it when another window connects one", async () => {
    vi.mocked(authStatus).mockResolvedValue(list(["openai"]));
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(bay.mount).toHaveBeenCalledTimes(1);
    expect(bay.mount.mock.calls[0]?.[0]).toMatchObject({
      providers: ["anthropic", "deepseek", "openai"],
    });
    expect(bay.setConnected).toHaveBeenLastCalledWith(["openai"]);

    vi.mocked(authStatus).mockResolvedValue(list(["openai", "deepseek"]));
    await emit("auth_change", { provider: "deepseek" });

    // A new connection re-wires the existing brain; it isn't rebuilt.
    expect(bay.mount).toHaveBeenCalledTimes(1);
    expect(bay.setConnected).toHaveBeenLastCalledWith(["deepseek", "openai"]);
  });
});

describe("LoginScreen retired sign-ins", () => {
  const RETIRED_MESSAGE =
    "Grok sign-in was removed: xAI offers SuperGrok and X Premium usage only in apps it partners with. Add an xAI API key instead.";
  function withRetiredSignIn(): AuthProvider[] {
    return providers([]).map((p) =>
      p.value === "xai" ? { ...p, reauthRequired: true, reauthMessage: RETIRED_MESSAGE } : p,
    );
  }

  it("shows the provider's own reconnect message and opens its login", async () => {
    vi.mocked(authStatus).mockResolvedValue(withRetiredSignIn());
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });
    expect(screen.getByText(RETIRED_MESSAGE)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("removes only the retired sign-in on dismiss and hides the notice", async () => {
    vi.mocked(authStatus)
      .mockResolvedValueOnce(withRetiredSignIn())
      .mockResolvedValue(providers([]));
    vi.mocked(authLogout).mockResolvedValue(undefined);
    await act(async () => {
      render(<LoginScreen onClose={vi.fn()} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    });
    expect(authLogout).toHaveBeenCalledWith("xai", "legacy");
    expect(screen.queryByText(RETIRED_MESSAGE)).toBeNull();
  });
});
