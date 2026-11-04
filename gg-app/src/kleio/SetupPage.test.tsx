// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { authStatusWithError, openUrl } from "../agent";
import { useHostReach, useHostReachWords } from "./hostReach";
import {
  KleioApiError,
  getDictationSetup,
  getSetupStatus,
  removeSetupKey,
  setSetupKey,
  type SetupStatus,
} from "./kleioApi";
import type * as KleioApi from "./kleioApi";
import { BrainCard } from "./BrainCard";
import { SetupPage } from "./SetupPage";
import { useKleioRemote } from "./useKleioRemote";
import { VoiceCard } from "./VoiceCard";

vi.mock("./VoiceCard", () => ({ VoiceCard: vi.fn() }));
// Covered by its own tests; here it only has to be in the right place.
vi.mock("./BrainCard", () => ({ BrainCard: vi.fn() }));
vi.mock("./hostReach", () => ({ useHostReach: vi.fn(), useHostReachWords: vi.fn() }));
vi.mock("./useKleioRemote", () => ({ useKleioRemote: vi.fn() }));
vi.mock("../agent", () => ({
  authStatusWithError: vi.fn(),
  openUrl: vi.fn(async () => undefined),
}));
vi.mock("./kleioApi", async (importOriginal) => {
  const actual = await importOriginal<typeof KleioApi>();
  return {
    // The real error type and wording; only the calls to the host are fakes.
    KleioApiError: actual.KleioApiError,
    errorText: actual.errorText,
    getSetupStatus: vi.fn(),
    setSetupKey: vi.fn(),
    removeSetupKey: vi.fn(),
    getDictationSetup: vi.fn(),
    startDictationSetup: vi.fn(),
  };
});

function status(keys: Partial<SetupStatus["keys"]> = {}, admin = true): SetupStatus {
  return { admin, keys: { openai: "missing", composio: "missing", typesafe: "missing", ...keys } };
}

const PROVIDER = {
  value: "anthropic",
  label: "Anthropic",
  description: "",
  methods: [],
  connected: true,
  connectedMethods: [],
};

/** The voice card, standing in: it says whether she can talk, as the real one does. */
function voiceCard(ready: boolean | null) {
  return function StubVoiceCard({
    canEdit,
    onReady,
  }: {
    canEdit?: boolean;
    onReady?: (ready: boolean | null) => void;
  }): React.ReactElement {
    useEffect(() => onReady?.(ready), [onReady]);
    return <p>{canEdit ? "voice card" : "voice card, view only"}</p>;
  };
}

/** The Brain card, standing in: a region where the real one goes. */
function StubBrainCard(): React.ReactElement {
  return <section aria-label="Brain">brain card</section>;
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(BrainCard).mockImplementation(StubBrainCard);
  vi.mocked(getSetupStatus).mockResolvedValue(status());
  vi.mocked(getDictationSetup).mockResolvedValue({ state: "absent", bytes: 138_853_314 });
  vi.mocked(authStatusWithError).mockResolvedValue({ providers: [PROVIDER], error: null });
  vi.mocked(useHostReach).mockReturnValue("connected");
  vi.mocked(useHostReachWords).mockReturnValue(null);
  vi.mocked(useKleioRemote).mockReturnValue({
    status: {
      active: {
        base: "https://home-server.example.ts.net:8443",
        host: "home-server.example.ts.net",
        deviceId: "d1",
        label: "Laptop",
        admin: true,
      },
      paired: null,
    },
    refresh: vi.fn(async () => undefined),
  });
  vi.mocked(VoiceCard).mockImplementation(voiceCard(false));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderPage(
  onOpenTab = vi.fn(),
  onIntroduce = vi.fn(async () => {}),
): Promise<typeof onOpenTab> {
  await act(async () => {
    render(<SetupPage onOpenTab={onOpenTab} onIntroduce={onIntroduce} />);
  });
  return onOpenTab;
}

const card = (name: string): HTMLElement => screen.getByRole("region", { name });
const progress = (): HTMLElement => screen.getByRole("progressbar");

describe("SetupPage", () => {
  it("marks Setup as seen on this device", async () => {
    await renderPage();
    expect(localStorage.getItem("kleio-setup-seen")).toBe("1");
  });

  it("counts the needed steps that are done", async () => {
    await renderPage();
    // Host and AI provider: the voice and Apps keys aren't set.
    expect(screen.getByText("2 of 4 done")).toBeTruthy();
    expect(progress().getAttribute("aria-valuenow")).toBe("2");
    expect(progress().getAttribute("aria-valuemax")).toBe("4");
  });

  it("says when every needed step is done, without the optional one", async () => {
    vi.mocked(VoiceCard).mockImplementation(voiceCard(true));
    vi.mocked(getSetupStatus).mockResolvedValue(status({ composio: "saved" }));
    await renderPage();
    expect(screen.getByText("All 4 done")).toBeTruthy();
    expect(within(card("Group chats")).getByText("Not set up")).toBeTruthy();
  });

  it("shows each card's state in its header, and its action", async () => {
    const onOpenTab = await renderPage();
    const host = card("Host");
    expect(within(host).getByText("Done")).toBeTruthy();
    expect(within(host).getByText("Connected to home-server.")).toBeTruthy();
    fireEvent.click(within(host).getByRole("button", { name: "Connection" }));
    expect(onOpenTab).toHaveBeenCalledWith("connection");

    expect(within(card("AI provider")).getByText("Signed in to Anthropic.")).toBeTruthy();
    expect(screen.getByText("voice card")).toBeTruthy();
    const apps = card("Apps");
    expect(within(apps).getByText("Composio")).toBeTruthy();
    expect(within(apps).getByText("Needed")).toBeTruthy();
  });

  it("puts the optional step under its own heading", async () => {
    await renderPage();
    const optional = screen.getByRole("heading", { name: "Optional" });
    const groups = card("Group chats");
    expect(within(groups).getByText("Typesafe")).toBeTruthy();
    expect(within(groups).getByText("Not set up")).toBeTruthy();
    // The heading comes right before the optional card, after every needed one.
    expect(optional.nextElementSibling).toBe(groups);
    expect(
      card("Apps").compareDocumentPosition(optional) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows dictation under Optional, after Group chats, without counting it", async () => {
    await renderPage();
    const dictation = card("Dictation");
    expect(card("Group chats").nextElementSibling).toBe(dictation);
    expect(within(dictation).getByText("Not set up")).toBeTruthy();
    expect(
      within(dictation).getByRole("button", { name: "Download speech model (139 MB)" }),
    ).toBeTruthy();
    expect(screen.getByText("2 of 4 done")).toBeTruthy();
    cleanup();

    // Ready or not, the count of needed steps doesn't move.
    vi.mocked(getDictationSetup).mockResolvedValue({ state: "ready", bytes: 138_853_314 });
    await renderPage();
    expect(within(card("Dictation")).getByText("Done")).toBeTruthy();
    expect(screen.getByText("2 of 4 done")).toBeTruthy();
    expect(progress().getAttribute("aria-valuemax")).toBe("4");
  });

  it("shows Brain last under Optional, with both callbacks, without counting it", async () => {
    const onOpenTab = vi.fn();
    const onIntroduce = vi.fn(async () => {});
    await renderPage(onOpenTab, onIntroduce);

    const brain = card("Brain");
    expect(card("Dictation").nextElementSibling).toBe(brain);
    expect(brain.nextElementSibling).toBeNull();
    expect(vi.mocked(BrainCard).mock.lastCall?.[0]).toEqual({ onIntroduce, onOpenTab });
    expect(screen.getByText("2 of 4 done")).toBeTruthy();
    expect(progress().getAttribute("aria-valuemax")).toBe("4");
  });

  it("shows dictation to a device that isn't the admin, with the download", async () => {
    vi.mocked(getSetupStatus).mockResolvedValue(status({}, false));
    await renderPage();
    expect(
      within(card("Dictation")).getByRole("button", { name: "Download speech model (139 MB)" }),
    ).toBeTruthy();
  });

  it("shows the host's real connection state", async () => {
    vi.mocked(useHostReach).mockReturnValue("disconnected");
    await renderPage();
    const host = card("Host");
    expect(within(host).getByText("Can't reach")).toBeTruthy();
    expect(within(host).getByText("Can't reach home-server right now.")).toBeTruthy();
    expect(within(host).queryByText("Done")).toBeNull();
    expect(screen.getByText("1 of 4 done")).toBeTruthy();
  });

  it("over Kleio's link, says why the host can't be reached", async () => {
    vi.mocked(useHostReach).mockReturnValue("disconnected");
    vi.mocked(useHostReachWords).mockReturnValue({
      tone: "bad",
      badge: "Relay blocked",
      headline: "Kleio can't reach its relay",
      detail: "This network may block it: try mobile data or another Wi-Fi.",
      checks: [],
      fix: [],
    });
    await renderPage();
    const host = card("Host");
    expect(
      within(host).getByText(
        "Kleio can't reach its relay. This network may block it: try mobile data or another Wi-Fi.",
      ),
    ).toBeTruthy();
    expect(within(host).getByText("Can't reach")).toBeTruthy();
  });

  it("says it's still checking the host", async () => {
    vi.mocked(useHostReach).mockReturnValue("checking");
    await renderPage();
    expect(within(card("Host")).getByText("Checking…")).toBeTruthy();
    expect(within(card("Host")).getByText("Checking home-server…")).toBeTruthy();
  });

  it("asks to sign in when no AI provider is", async () => {
    vi.mocked(authStatusWithError).mockResolvedValue({
      providers: [{ ...PROVIDER, connected: false }],
      error: null,
    });
    const onOpenTab = await renderPage();
    const ai = card("AI provider");
    expect(within(ai).getByText("Needed")).toBeTruthy();
    fireEvent.click(within(ai).getByRole("button", { name: "Sign in" }));
    expect(onOpenTab).toHaveBeenCalledWith("providers");
  });

  it("gives an admin each key with its hint and Get a key link", async () => {
    await renderPage();
    const apps = card("Apps");
    const field = within(apps).getByLabelText("Composio API key");
    expect(field.getAttribute("type")).toBe("password");
    expect(field.getAttribute("placeholder")).toBe("Composio API key");
    // The hint is read with the field.
    const hint = within(apps).getByText(
      "In Composio, open Settings, then API Keys, and create a key.",
    );
    expect(field.getAttribute("aria-describedby")).toBe(hint.id);
    fireEvent.click(within(apps).getByRole("button", { name: "Get a key" }));
    expect(openUrl).toHaveBeenCalledWith("https://dashboard.composio.dev");

    const groups = card("Group chats");
    expect(within(groups).getByLabelText("Typesafe API key").getAttribute("placeholder")).toBe(
      "Typesafe API key",
    );
    fireEvent.click(within(groups).getByRole("button", { name: "Get a key" }));
    expect(openUrl).toHaveBeenCalledWith("https://console.typesafe.ai");
  });

  it("shows a non-admin device the states, a note, and no forms", async () => {
    vi.mocked(getSetupStatus).mockResolvedValue(status({ composio: "saved" }, false));
    await renderPage();
    const note = screen.getByRole("note");
    expect(within(note).getByText("Finish setup on your admin device")).toBeTruthy();
    expect(screen.getByText("voice card, view only")).toBeTruthy();
    expect(within(card("Apps")).getByText("Done")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByLabelText("Typesafe API key")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  });

  it("saves a key and shows it done", async () => {
    vi.mocked(setSetupKey).mockResolvedValue(status({ composio: "saved" }));
    await renderPage();
    const apps = card("Apps");
    const input = within(apps).getByLabelText("Composio API key");
    fireEvent.change(input, { target: { value: "ak_live" } });
    await act(async () => {
      fireEvent.click(within(apps).getByRole("button", { name: "Save" }));
    });
    expect(setSetupKey).toHaveBeenCalledWith("composio", "ak_live");
    expect(within(apps).getByText("Done")).toBeTruthy();
    expect(within(apps).getByText("Saved on your host.")).toBeTruthy();
    expect(within(apps).queryByLabelText("Composio API key")).toBeNull();
    expect(within(apps).getByRole("button", { name: "Remove key" })).toBeTruthy();
    expect(screen.getByText("3 of 4 done")).toBeTruthy();
  });

  it("removes a saved key", async () => {
    vi.mocked(getSetupStatus).mockResolvedValue(status({ typesafe: "saved" }));
    vi.mocked(removeSetupKey).mockResolvedValue(status());
    await renderPage();
    const groups = card("Group chats");
    await act(async () => {
      fireEvent.click(within(groups).getByRole("button", { name: "Remove key" }));
    });
    expect(removeSetupKey).toHaveBeenCalledWith("typesafe");
    expect(within(groups).getByText("Not set up")).toBeTruthy();
  });

  it("says a key set on the host can't be changed here", async () => {
    vi.mocked(getSetupStatus).mockResolvedValue(status({ composio: "env" }));
    await renderPage();
    const apps = card("Apps");
    expect(within(apps).getByText("Set on host")).toBeTruthy();
    expect(
      within(apps).getByText("Set on the host itself, so it can't be changed here."),
    ).toBeTruthy();
    expect(within(apps).queryByLabelText("Composio API key")).toBeNull();
    expect(within(apps).queryByRole("button", { name: "Remove key" })).toBeNull();
    // Set on the host counts as done.
    expect(screen.getByText("3 of 4 done")).toBeTruthy();
  });

  it("puts a refused key in plain words, under its field", async () => {
    vi.mocked(setSetupKey).mockRejectedValueOnce(new KleioApiError(422, "bad_key"));
    await renderPage();
    const apps = card("Apps");
    const field = within(apps).getByLabelText("Composio API key");
    fireEvent.change(field, { target: { value: "nope" } });
    await act(async () => {
      fireEvent.click(within(apps).getByRole("button", { name: "Save" }));
    });
    const alert = within(apps).getByRole("alert");
    expect(alert.textContent).toBe("Composio didn't accept that key. Check you copied all of it.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toContain(alert.id);
  });

  it("explains a key the host set itself", async () => {
    vi.mocked(setSetupKey).mockRejectedValueOnce(new KleioApiError(409, "set_by_env"));
    await renderPage();
    const groups = card("Group chats");
    fireEvent.change(within(groups).getByLabelText("Typesafe API key"), {
      target: { value: "ts_x" },
    });
    await act(async () => {
      fireEvent.click(within(groups).getByRole("button", { name: "Save" }));
    });
    expect(within(groups).getByRole("alert").textContent).toBe(
      "This key is set on the host itself, so it can't be changed here.",
    );
  });

  it("tells an older host to update, once, and can't check its keys", async () => {
    vi.mocked(getSetupStatus).mockRejectedValue(new KleioApiError(404, "not_found"));
    await renderPage();
    const note = screen.getByRole("note");
    expect(within(note).getByText("Update Kleio on your host")).toBeTruthy();
    for (const name of ["Apps", "Group chats"]) {
      expect(within(card(name)).getByText("Can't check")).toBeTruthy();
      expect(within(card(name)).queryByRole("textbox")).toBeNull();
    }
  });

  it("offers a retry when setup can't be read", async () => {
    vi.mocked(getSetupStatus).mockRejectedValueOnce(new KleioApiError(500, "boom"));
    await renderPage();
    expect(screen.getByRole("alert").textContent).toContain("boom");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(getSetupStatus).toHaveBeenCalledTimes(2);
    expect(within(card("Apps")).getByText("Needed")).toBeTruthy();
  });
});
