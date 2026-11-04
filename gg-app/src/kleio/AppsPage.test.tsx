// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import conf from "../../src-tauri/tauri.conf.json";
import {
  AppsPage,
  COMPOSIO_AUTH_CONFIGS_URL,
  LOGO_ORIGIN,
  appErrorText,
  categoryLabel,
  connectionState,
  logoUrl,
} from "./AppsPage";
import {
  KleioApiError,
  connectToolkit,
  disconnect,
  listConnections,
  listToolkits,
  setSetupKey,
} from "./kleioApi";
import { openUrl } from "../agent";
import type * as KleioApi from "./kleioApi";

vi.mock("../agent", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("./kleioApi", async (importOriginal) => {
  const actual = await importOriginal<typeof KleioApi>();
  return {
    // The real error type and wording; only the calls to the Mac mini are fakes.
    KleioApiError: actual.KleioApiError,
    errorText: actual.errorText,
    listConnections: vi.fn(),
    listToolkits: vi.fn(),
    connectToolkit: vi.fn(),
    disconnect: vi.fn(),
    setSetupKey: vi.fn(),
  };
});

const GMAIL = {
  slug: "gmail",
  name: "Gmail",
  logo: "https://somewhere.example/gmail.png",
  description: "Email by Google.",
  categories: ["productivity"],
};
const NOTION = { ...GMAIL, slug: "notion", name: "Notion", description: "Docs and wikis." };
const SLACK = { ...GMAIL, slug: "slack", name: "Slack", description: "Team chat." };
const HACKER_NEWS = {
  ...GMAIL,
  slug: "hackernews",
  name: "Hacker News",
  description: "Tech news.",
  auth: "none" as const,
};
const X = {
  ...GMAIL,
  slug: "twitter",
  name: "Twitter",
  description: "Posts.",
  auth: "setup" as const,
};

beforeEach(() => {
  vi.mocked(listConnections).mockResolvedValue({ configured: true, connections: [] });
  vi.mocked(listToolkits).mockResolvedValue({ toolkits: [GMAIL, NOTION], nextCursor: "c2" });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderPage(): Promise<void> {
  await act(async () => {
    render(<AppsPage />);
  });
  await screen.findByText("Gmail", {}, { timeout: 2000 });
}

describe("logos", () => {
  it("come from Composio's logo CDN by slug, never from the catalogue's links", () => {
    expect(logoUrl("gmail")).toBe("https://logos.composio.dev/api/gmail");
    expect(logoUrl("Google_Sheets")).toBe("https://logos.composio.dev/api/google_sheets");
    expect(logoUrl("../etc")).toBeNull();
    expect(logoUrl("a/b")).toBeNull();
    expect(logoUrl("")).toBeNull();
  });

  it("are the only remote images the app's CSP allows", () => {
    const csp = conf.app.security.csp;
    const imgSrc = csp.split(";").find((d) => d.trim().startsWith("img-src"));
    expect(imgSrc?.trim().split(/\s+/)).toEqual([
      "img-src",
      "'self'",
      "data:",
      "blob:",
      LOGO_ORIGIN,
    ]);
    // Nothing else talks to the network from the page.
    expect(csp).toContain("connect-src 'self' ipc: http://ipc.localhost;");
  });

  it("render for each app and fall back to a letter when one fails", async () => {
    await renderPage();
    const img = document.querySelector<HTMLImageElement>(
      'img[src="https://logos.composio.dev/api/gmail"]',
    );
    expect(img).not.toBeNull();
    expect(document.querySelector('img[src^="https://somewhere.example"]')).toBeNull();
    act(() => {
      img?.dispatchEvent(new Event("error"));
    });
    expect(document.querySelector('img[src="https://logos.composio.dev/api/gmail"]')).toBeNull();
    expect(screen.getByText("G")).toBeTruthy();
  });
});

describe("AppsPage", () => {
  it("loads more apps from the next page", async () => {
    await renderPage();
    vi.mocked(listToolkits).mockResolvedValueOnce({ toolkits: [NOTION, SLACK], nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Show more apps" }));
    await screen.findByText("Slack");
    expect(listToolkits).toHaveBeenLastCalledWith({ cursor: "c2" });
    // No duplicates, and no more button on the last page.
    expect(screen.getAllByText("Notion")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Show more apps" })).toBeNull();
  });

  it("connects in the browser", async () => {
    vi.mocked(connectToolkit).mockResolvedValue({
      redirectUrl: "https://connect.example/start",
      connectionId: "c1",
    });
    const { openUrl } = await import("../agent");
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://connect.example/start"));
    expect(connectToolkit).toHaveBeenCalledWith("gmail");
  });

  it("refreshes when Kleio comes back from the browser's sign-in, focused or on screen again", async () => {
    await renderPage();
    const loads = (): number => vi.mocked(listConnections).mock.calls.length;
    const before = loads();
    let state: DocumentVisibilityState = "hidden";
    const visibility = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    try {
      // Leaving for Safari reads nothing.
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(loads()).toBe(before);
      // Back on screen: the iPhone, where the window may not be focused.
      state = "visible";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(loads()).toBe(before + 1);
      // The Mac's window focused again.
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(loads()).toBe(before + 2);
    } finally {
      visibility.mockRestore();
    }
  });

  it("asks before disconnecting an app", async () => {
    vi.mocked(listConnections).mockResolvedValue({
      configured: true,
      connections: [
        {
          id: "conn-1",
          toolkit: "gmail",
          name: "Gmail",
          logo: null,
          status: "ACTIVE",
          createdAt: "",
        },
      ],
    });
    vi.mocked(disconnect).mockResolvedValue(undefined);
    await renderPage();
    const mine = screen.getByText("Your apps").closest("section") as HTMLElement;
    fireEvent.click(within(mine).getByRole("button", { name: "Disconnect Gmail" }));
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(mine).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith("conn-1"));
  });

  it("shows an app that needs no sign-in as ready, with nothing to connect", async () => {
    vi.mocked(listToolkits).mockResolvedValue({ toolkits: [GMAIL, HACKER_NEWS], nextCursor: null });
    await renderPage();
    expect(screen.getByText("Ready · no sign-in")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Hacker News" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect Gmail" })).toBeTruthy();
  });

  it("explains an app that needs your own keys, and opens Composio to add them", async () => {
    vi.mocked(listToolkits).mockResolvedValue({ toolkits: [GMAIL, X], nextCursor: null });
    vi.mocked(connectToolkit).mockRejectedValue(
      new KleioApiError(
        409,
        "Composio has no ready-made sign-in for this app. Add your own developer keys for it in Composio, then connect again.",
        undefined,
        "needs_setup",
      ),
    );
    const { openUrl } = await import("../agent");
    await renderPage();
    expect(screen.getByText("Needs your own keys")).toBeTruthy();
    // Still connectable: once the keys are in Composio, Connect works.
    fireEvent.click(screen.getByRole("button", { name: "Connect Twitter" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no ready-made sign-in for this app/);
    expect(alert.textContent).not.toMatch(/\{/);
    fireEvent.click(within(alert).getByRole("button", { name: "Open Composio" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(COMPOSIO_AUTH_CONFIGS_URL));
  });

  it("turns an older host's raw Composio error into words, or into a ready app", async () => {
    vi.mocked(listToolkits).mockResolvedValue({
      toolkits: [GMAIL, { ...HACKER_NEWS, auth: undefined }],
      nextCursor: null,
    });
    vi.mocked(connectToolkit).mockRejectedValue(
      new KleioApiError(
        502,
        "composio",
        '{"error":{"message":"Toolkit hackernews does not require authentication.","code":4326,"slug":"ToolRouterV2_ToolkitsIsNoAuth","status":400}}',
      ),
    );
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Connect Hacker News" }));
    await screen.findByText("Ready · no sign-in");
    expect(screen.queryByRole("alert")).toBeNull();

    expect(
      appErrorText(new KleioApiError(502, "composio", '{"error":{"message":"Rate limited."}}')),
    ).toBe("Composio couldn't do that: Rate limited.");
    expect(appErrorText(new KleioApiError(502, "composio", "plain words"))).toBe(
      "Composio couldn't do that: plain words",
    );
    expect(appErrorText(new KleioApiError(503, "apps not set up"))).toBe("apps not set up");
  });

  it("explains when the Mac mini has no Composio key", async () => {
    vi.mocked(listConnections).mockResolvedValue({ configured: false, connections: [] });
    await act(async () => {
      render(<AppsPage />);
    });
    expect(await screen.findByText("Apps aren't set up yet")).toBeTruthy();
    expect(listToolkits).not.toHaveBeenCalled();
  });

  it("takes a Composio key when the host has none, then shows the apps", async () => {
    vi.mocked(listConnections).mockResolvedValueOnce({ configured: false, connections: [] });
    vi.mocked(setSetupKey).mockResolvedValue({
      admin: true,
      keys: { openai: "missing", composio: "saved", typesafe: "missing" },
    });
    await act(async () => {
      render(<AppsPage />);
    });
    const input = await screen.findByLabelText("Composio API key");
    expect(input.getAttribute("type")).toBe("password");
    expect(screen.queryByText(/composio\.key/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Get a key" }));
    expect(openUrl).toHaveBeenCalledWith("https://dashboard.composio.dev");

    fireEvent.change(input, { target: { value: "ak_test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Gmail", {}, { timeout: 2000 });
    expect(setSetupKey).toHaveBeenCalledWith("composio", "ak_test");
    expect(listConnections).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Apps aren't set up yet")).toBeNull();
  });

  it("says why Composio refused the key", async () => {
    vi.mocked(listConnections).mockResolvedValue({ configured: false, connections: [] });
    vi.mocked(setSetupKey).mockRejectedValue(new KleioApiError(422, "bad_key"));
    await act(async () => {
      render(<AppsPage />);
    });
    fireEvent.change(await screen.findByLabelText("Composio API key"), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Composio didn't accept that key. Check you copied all of it.",
    );
  });

  it("labels categories in sentence case, keeping acronyms whole", () => {
    expect(categoryLabel(["developer tools"])).toBe("Developer tools");
    expect(categoryLabel(["ai"])).toBe("AI");
    expect(categoryLabel(["CRM software", "sales"])).toBe("CRM software");
    expect(categoryLabel(["social media"])).toBe("Social media");
    expect(categoryLabel([])).toBeNull();
    expect(categoryLabel(["  "])).toBeNull();
  });

  it("reads connection states in plain words", () => {
    expect(connectionState("ACTIVE")).toBe("connected");
    expect(connectionState("initiated")).toBe("pending");
    expect(connectionState("EXPIRED")).toBe("expired");
    expect(connectionState("FAILED")).toBe("failed");
    expect(connectionState("weird")).toBe("other");
  });
});
