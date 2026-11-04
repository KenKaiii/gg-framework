// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
// The link's ticket vectors, which kleio-host's and the link's own tests read too.
import vectors from "../../../packages/kleio-link/tests/fixtures/tickets.json";
import { toast } from "../toast";
import { ConnectionPage, formatLatency, N0_RELAY_LINE, switchWords } from "./ConnectionPage";
import { forgetHint } from "./ForgetHost";
import { RESTART_HOST, RESTART_LINK, START_HOST } from "./connectionDiagnosis";
import { hostHealth, KleioApiError, notificationSettings, setQuoteText } from "./kleioApi";
import type * as KleioApi from "./kleioApi";
import { adoptRelayList, relayList, setRelayList, type RelayList } from "./kleioRelays";
import type * as KleioRelays from "./kleioRelays";
import type { LinkStatus } from "./kleioLink";
import { noTicketWords, PAIR_STATE_POLL_MS } from "./PairingOffer";
import { pairTicket } from "./pairTicket";
import { encodeQr, qrSvgPath } from "./qr";
import {
  type Forgot,
  kleio,
  type Paired,
  type RemoteStatus,
  type TailscaleNode,
  type TailscaleStatus,
} from "./useKleioRemote";
import type * as KleioRemote from "./useKleioRemote";

/** This launch's pairing, as useKleioRemote reads it: by address unless a test says otherwise. */
const remote = vi.hoisted(() => ({ status: null as RemoteStatus | null }));

// Only the Kleio link's commands go through invoke here; everything else the
// page reads is mocked below.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  // The real one needs the Tauri bridge. This keeps its handler, for a test to call.
  Channel: class {
    onmessage: (message: unknown) => void;
    constructor(onmessage: (message: unknown) => void = () => {}) {
      this.onmessage = onmessage;
    }
  },
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => undefined) }));
vi.mock("../toast", () => ({ toast: vi.fn() }));
vi.mock("../agent", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("./kleioApi", async (importOriginal) => ({
  ...(await importOriginal<typeof KleioApi>()),
  hostHealth: vi.fn(),
  notificationSettings: vi.fn(),
  setQuoteText: vi.fn(),
}));
vi.mock("./kleioRelays", async (importOriginal) => ({
  ...(await importOriginal<typeof KleioRelays>()),
  relayList: vi.fn(),
  setRelayList: vi.fn(),
  adoptRelayList: vi.fn(),
}));
vi.mock("./useKleioRemote", async (importOriginal) => {
  const real = await importOriginal<typeof KleioRemote>();
  return {
    ...real,
    useKleioRemote: () => ({ status: remote.status, refresh: vi.fn() }),
    kleio: {
      tailscale: vi.fn(),
      offer: vi.fn(),
      adminState: vi.fn(),
      pairState: vi.fn(),
      cancelOffer: vi.fn(),
      devices: vi.fn(),
      revoke: vi.fn(),
      pair: vi.fn(),
      activatePairing: vi.fn(),
      forget: vi.fn(),
    },
  };
});

const BY_ADDRESS: RemoteStatus = {
  active: {
    base: "https://mac-mini-1.tail0000.ts.net:8443",
    host: "mac-mini-1.tail0000.ts.net",
    deviceId: "self",
    label: "Laptop",
    admin: true,
  },
  // The pairing on disk this launch booted with. (None, with a pairing
  // active, is one forgotten in this launch.)
  paired: {
    baseUrl: "https://mac-mini-1.tail0000.ts.net:8443",
    host: "mac-mini-1.tail0000.ts.net",
    deviceId: "self",
    label: "Laptop",
    admin: true,
    pairedAt: "2026-10-01T09:00:00Z",
  },
};

const [VECTOR] = vectors.good;
if (VECTOR === undefined) throw new Error("no ticket vectors");
/** A v4 ticket as kleio-host builds it, for pair code ABC-DEF. */
const TICKET = VECTOR.ticket;

/** The path a QR code of `text` draws. */
function qrPath(text: string): string {
  const qr = encodeQr(text);
  if (!qr.ok) throw new Error(qr.error);
  return qrSvgPath(qr.value, 4);
}

const MINI: TailscaleNode = {
  name: "mac-mini-1",
  dnsName: "mac-mini-1.tail0000.ts.net",
  ip: "100.64.0.9",
  os: "macOS",
  online: true,
  lastSeen: null,
  direct: true,
  relay: "lhr",
};

function net(over: Partial<TailscaleStatus> = {}): TailscaleStatus {
  return {
    installed: true,
    running: true,
    backendState: "Running",
    tailnet: "me@example.com",
    magicDnsSuffix: "tail0000.ts.net",
    version: "1.90.1-t1",
    health: [],
    self: { ...MINI, name: "laptop", dnsName: "laptop.tail0000.ts.net" },
    host: MINI,
    error: null,
    ...over,
  };
}

async function renderPage(): Promise<void> {
  await act(async () => {
    render(<ConnectionPage />);
  });
}

/** Answers the link's commands from `map`; any other is turned away, as a
 *  Windows or Linux build, which has no link, turns away all of them. */
function linkRoutes(map: Record<string, (args?: Record<string, unknown>) => unknown>): void {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const fn = map[cmd];
    if (!fn) throw new Error(`Command ${cmd} not found`);
    return fn(args as Record<string, unknown> | undefined);
  });
}

/** The relay list as the host gives it: n0's alone, in use. */
const N0_LIST: RelayList = {
  listVersion: 0,
  relays: [{ entry: "n0", state: "home", new: false }],
  inUse: true,
  hostRelay: "https://euc1-1.relay.n0.iroh.link./",
  waiting: 0,
};

beforeEach(() => {
  remote.status = BY_ADDRESS;
  vi.mocked(hostHealth).mockResolvedValue({ sidecar: "up", devices: 2, latencyMs: 38 });
  vi.mocked(notificationSettings).mockResolvedValue({ quoteText: true });
  vi.mocked(relayList).mockResolvedValue(N0_LIST);
  vi.mocked(kleio.tailscale).mockResolvedValue(net());
  vi.mocked(kleio.adminState).mockResolvedValue({
    unlocked: true,
    expiresAt: Date.now() + 15 * 60_000,
    available: true,
  });
  // No host answer about a shown code unless a test gives one.
  vi.mocked(kleio.pairState).mockReturnValue(new Promise(() => {}));
  vi.mocked(kleio.cancelOffer).mockResolvedValue(undefined);
  linkRoutes({});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  document.documentElement.classList.remove("platform-ios");
  localStorage.clear();
});

/** The verdict under the map, once the first check is in, and its checklist rows as "label: text". */
async function verdict(): Promise<{ box: HTMLElement; checks: string[] }> {
  const box = screen.getByRole("region", { name: "Connection check" });
  const list = await within(box).findByRole("list", { name: "What was checked" });
  const checks = within(list)
    .getAllByRole("listitem")
    .map((li) => [...li.querySelectorAll("span")].map((s) => s.textContent).join(": "));
  return { box, checks };
}

describe("ConnectionPage", () => {
  it("says it's connected, what it checked, and how quick the Mac mini is", async () => {
    await renderPage();
    const { box, checks } = await verdict();
    expect(within(box).getByRole("heading", { name: "Connected to mac-mini-1" })).toBeTruthy();
    expect(checks).toEqual([
      "Tailscale on this Mac: On, as laptop",
      "mac-mini-1 on Tailscale: Online, direct link",
      "Kleio on mac-mini-1: Running",
    ]);
    expect(within(box).queryByText("How to fix it")).toBeNull();
    const mini = screen.getByRole("region", { name: "Host" });
    expect(within(mini).getByText("https://mac-mini-1.tail0000.ts.net:8443")).toBeTruthy();
    expect(within(mini).getByText("38 ms")).toBeTruthy();
    const ts = screen.getByRole("region", { name: "Tailscale" });
    expect(within(ts).getByText("me@example.com")).toBeTruthy();
    expect(within(ts).getByText("100.64.0.9")).toBeTruthy();
    expect(within(ts).getByText("1.90.1")).toBeTruthy();
    // Only a short wait: a Mac mini that dropped off Tailscale never answers.
    expect(hostHealth).toHaveBeenCalledWith(6000);
  });

  it("when Tailscale is off on this Mac, says so in plain words and how to fix it", async () => {
    vi.mocked(hostHealth).mockRejectedValue(
      new Error("failed to lookup address information: nodename nor servname provided"),
    );
    vi.mocked(kleio.tailscale).mockResolvedValue(
      net({
        running: false,
        backendState: "Stopped",
        host: null,
        self: null,
        error: "Tailscale is turned off on this Mac.",
      }),
    );
    await renderPage();
    const { box, checks } = await verdict();
    expect(
      within(box).getByRole("heading", { name: "Tailscale is turned off on this Mac" }),
    ).toBeTruthy();
    expect(checks).toEqual([
      "Tailscale on this Mac: Turned off",
      "Kleio on mac-mini-1: Can't find it",
    ]);
    const steps = within(box)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(steps).toContain("Click the Tailscale icon in the menu bar and turn it on.");
    expect(steps).toContain("Then click Check again.");
    // No raw network error anywhere on the page.
    expect(screen.queryByText(/lookup address/)).toBeNull();
  });

  it("when Kleio on the Mac mini isn't answering, gives the command to restart it, ready to copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.mocked(hostHealth).mockRejectedValue(
      Object.assign(new Error("Bad gateway"), { status: 502 }),
    );
    await renderPage();
    const { box } = await verdict();
    expect(
      within(box).getByRole("heading", { name: "Kleio on mac-mini-1 isn't answering" }),
    ).toBeTruthy();
    // The whole command, as one line of text to read or copy.
    expect(box.querySelector(".conn-command code")?.textContent).toBe(RESTART_HOST);
    await act(async () => {
      fireEvent.click(within(box).getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith(RESTART_HOST);
    expect(within(box).getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("on the iPhone, doesn't read Tailscale and says what to check in the Tailscale app", async () => {
    document.documentElement.classList.add("platform-ios");
    vi.mocked(hostHealth).mockRejectedValue(new Error("dns error: failed to lookup address"));
    await renderPage();
    const { box, checks } = await verdict();
    expect(
      within(box).getByRole("heading", { name: "This iPhone can't find mac-mini-1" }),
    ).toBeTruthy();
    expect(checks[0]).toBe("Tailscale on this iPhone: Check the Tailscale app");
    expect(within(box).getByText("Then tap Check again.")).toBeTruthy();
    expect(kleio.tailscale).not.toHaveBeenCalled();
    // Its Tailscale card would have nothing true to say.
    expect(screen.queryByRole("region", { name: "Tailscale" })).toBeNull();
  });

  it("Pair a device draws the host's link ticket: an iPhone scans it, a Mac pastes its text", async () => {
    vi.mocked(kleio.offer).mockResolvedValue({
      display: "ABC-DEF",
      expiresAt: Date.now() + 5 * 60_000,
      admin: false,
      ticket: TICKET,
      ticketError: null,
    });
    await renderPage();
    const card = screen.getByRole("region", { name: "Pair a device" });
    fireEvent.click(within(card).getByRole("button", { name: "Show pairing QR" }));
    const qr = await within(card).findByRole("img", {
      name: "Pairing QR code for pair code ABC-DEF",
    });
    // A pair code for a device, never an admin one.
    expect(kleio.offer).toHaveBeenCalledWith(false);
    expect(qr.querySelector("path")?.getAttribute("d")).toBe(qrPath(TICKET));
    expect(within(card).getByLabelText("Pairing text, for a Mac")).toHaveProperty("value", TICKET);
    // Nothing to type: the host's address is no part of it, nor Tailscale.
    expect(within(card).queryByText("https://mac-mini-1.tail0000.ts.net:8443")).toBeNull();
    expect(within(card).queryByText(/Tailscale/)).toBeNull();
    expect(within(card).getByText(/expires in [45]:\d\d/)).toBeTruthy();
    // Done checks the connection again, as a pairing may have changed it.
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Done" }));
    });
    expect(hostHealth).toHaveBeenCalledTimes(2);
    expect(within(card).getByRole("button", { name: "Show pairing QR" })).toBeTruthy();
  });

  it("leaving the page with a code on show takes the code away; leaving after Done takes none", async () => {
    const shown = {
      display: "ABC-DEF",
      expiresAt: Date.now() + 5 * 60_000,
      admin: false,
      ticket: TICKET,
      ticketError: null,
    };
    const live = {
      active: true,
      expiresAt: shown.expiresAt,
      redeemed: false,
      admin: false,
      claim: null,
    };
    vi.mocked(kleio.offer).mockResolvedValue(shown);
    vi.mocked(kleio.pairState).mockResolvedValue(live);
    await renderPage();
    const card = screen.getByRole("region", { name: "Pair a device" });
    fireEvent.click(within(card).getByRole("button", { name: "Show pairing QR" }));
    await within(card).findByRole("img", { name: "Pairing QR code for pair code ABC-DEF" });
    // Leaving the page unmounts it.
    cleanup();
    await waitFor(() => expect(kleio.cancelOffer).toHaveBeenCalledTimes(1));

    vi.mocked(kleio.cancelOffer).mockClear();
    await renderPage();
    const card2 = screen.getByRole("region", { name: "Pair a device" });
    fireEvent.click(within(card2).getByRole("button", { name: "Show pairing QR" }));
    await within(card2).findByRole("img", { name: "Pairing QR code for pair code ABC-DEF" });
    await act(async () => {
      fireEvent.click(within(card2).getByRole("button", { name: "Done" }));
    });
    // Done took it away; leaving after takes nothing more.
    await waitFor(() => expect(kleio.cancelOffer).toHaveBeenCalledTimes(1));
    cleanup();
    await act(async () => {
      await Promise.resolve();
    });
    expect(kleio.cancelOffer).toHaveBeenCalledTimes(1);
  });

  it("with no link ticket, Pair a device says why, and draws today's Tailscale QR code to go with the address", async () => {
    vi.mocked(kleio.offer).mockResolvedValue({
      display: "ABC-DEF",
      expiresAt: Date.now() + 5 * 60_000,
      admin: false,
      ticket: null,
      ticketError: "no_link",
    });
    await renderPage();
    const card = screen.getByRole("region", { name: "Pair a device" });
    fireEvent.click(within(card).getByRole("button", { name: "Show pairing QR" }));
    const qr = await within(card).findByRole("img", {
      name: "Pairing QR code for pair code ABC-DEF",
    });
    expect(within(card).getByText(noTicketWords("no_link"))).toBeTruthy();
    const base = "https://mac-mini-1.tail0000.ts.net:8443";
    const v2 = pairTicket(base, "ABC-DEF");
    if (!v2.ok) throw new Error(v2.error);
    expect(qr.querySelector("path")?.getAttribute("d")).toBe(qrPath(v2.value));
    const steps = within(card).getByRole("list");
    expect(within(steps).getByText(base)).toBeTruthy();
    expect(within(steps).getByText("ABC-DEF")).toBeTruthy();
    expect(within(steps).getByText("Pair with your host")).toBeTruthy();
  });

  it("only an admin pairs another device; the card says how to on the host", async () => {
    const active = BY_ADDRESS.active;
    if (active === null) throw new Error("BY_ADDRESS has a pairing");
    remote.status = { ...BY_ADDRESS, active: { ...active, admin: false } };
    await renderPage();
    const card = screen.getByRole("region", { name: "Pair a device" });
    expect(within(card).getByText(/^Only an admin device can pair another device\./)).toBeTruthy();
    expect(within(card).getByText("kleio-host pair")).toBeTruthy();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("lists devices after Touch ID, marks the ones paired this week New, and asks before revoking one", async () => {
    const DAY = 24 * 60 * 60_000;
    const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
    vi.mocked(kleio.devices).mockResolvedValue([
      {
        deviceId: "self",
        label: "Laptop",
        created: ago(DAY),
        lastSeen: null,
        revoked: false,
        admin: true,
      },
      {
        deviceId: "p1",
        label: "Sam's iPhone",
        created: ago(2 * 60 * 60_000),
        lastSeen: null,
        revoked: false,
        admin: false,
      },
      {
        deviceId: "p2",
        label: "Old iPad",
        created: ago(30 * DAY),
        lastSeen: ago(DAY),
        revoked: false,
        admin: false,
      },
    ]);
    vi.mocked(kleio.revoke).mockResolvedValue([]);
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Show devices" }));
    const devices = screen.getByRole("region", { name: "Devices" });
    const row = async (label: string): Promise<HTMLElement> => {
      const li = (await within(devices).findByText(label)).closest("li");
      if (!li) throw new Error(`no row for ${label}`);
      return li;
    };
    // Paired two hours ago: New, and when it paired, as the host names it.
    const sam = await row("Sam's iPhone");
    expect(within(sam).getByText("New")).toBeTruthy();
    expect(within(sam).getByText("Paired 2 h ago")).toBeTruthy();
    // This Mac, new as it is, and last month's device aren't.
    expect(within(await row("Laptop")).queryByText("New")).toBeNull();
    expect(within(await row("Old iPad")).queryByText("New")).toBeNull();
    // This Mac can't revoke itself.
    expect(
      within(devices).queryByRole("button", { name: "Revoke this device: Laptop" }),
    ).toBeNull();
    fireEvent.click(within(sam).getByRole("button", { name: "Revoke this device: Sam's iPhone" }));
    expect(kleio.revoke).not.toHaveBeenCalled();
    fireEvent.click(within(sam).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(kleio.revoke).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Sam's iPhone revoked.", "success"));
  });

  describe("a device paired with Pair a device", () => {
    const LAPTOP = {
      deviceId: "self",
      label: "Laptop",
      created: "2026-10-01T09:00:00Z",
      lastSeen: null,
      revoked: false,
      admin: true,
    };

    /**
     * A code Sam's iPhone pairs with, on a clock the test moves, and the
     * host's device list, with the phone in it once it has paired. `pair`
     * shows the code, and the phone pairs: the code's next check sees it.
     */
    function pairing(): { pair: () => Promise<void> } {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const shown = {
        display: "ABC-DEF",
        expiresAt: Date.now() + 5 * 60_000,
        admin: false,
        ticket: TICKET,
        ticketError: null,
      };
      let paired = false;
      vi.mocked(kleio.offer).mockResolvedValue(shown);
      vi.mocked(kleio.pairState).mockImplementation(async () => ({
        active: true,
        expiresAt: shown.expiresAt,
        redeemed: paired,
        admin: false,
        claim: paired
          ? {
              label: "Sam's iPhone",
              deviceCode: "3F9 AC2",
              at: Date.now(),
              contested: false,
              allowed: true,
            }
          : null,
      }));
      vi.mocked(kleio.devices).mockImplementation(async () =>
        paired
          ? [
              LAPTOP,
              {
                ...LAPTOP,
                deviceId: "p1",
                label: "Sam's iPhone",
                created: new Date().toISOString(),
                admin: false,
              },
            ]
          : [LAPTOP],
      );
      return {
        pair: async () => {
          const card = screen.getByRole("region", { name: "Pair a device" });
          fireEvent.click(within(card).getByRole("button", { name: "Show pairing QR" }));
          await within(card).findByRole("img", { name: "Pairing QR code for pair code ABC-DEF" });
          paired = true;
          await act(async () => {
            await vi.advanceTimersByTimeAsync(PAIR_STATE_POLL_MS);
          });
          expect(toast).toHaveBeenCalledWith("Sam's iPhone is paired.", "success");
          expect(within(card).getByRole("button", { name: "Show pairing QR" })).toBeTruthy();
        },
      };
    }

    it("joins the Devices list on show at once", async () => {
      const { pair } = pairing();
      await renderPage();
      fireEvent.click(screen.getByRole("button", { name: "Show devices" }));
      const devices = screen.getByRole("region", { name: "Devices" });
      await within(devices).findByText("Laptop");
      expect(within(devices).queryByText("Sam's iPhone")).toBeNull();
      await pair();
      expect(await within(devices).findByText("Sam's iPhone")).toBeTruthy();
      expect(kleio.devices).toHaveBeenCalledTimes(2);
    });

    it("leaves a list not on show unshown, as showing it asks for Touch ID", async () => {
      const { pair } = pairing();
      await renderPage();
      await pair();
      expect(kleio.devices).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Show devices" })).toBeTruthy();
    });
  });
});

describe("ConnectionPage — Forget host", () => {
  /** Forget host, confirmed, with the host answering `onHost`: the page as it
   *  reads after, with the pairing gone from disk and this launch still on it. */
  async function forgetWith(onHost: Forgot): Promise<HTMLElement> {
    vi.mocked(kleio.forget).mockImplementation(async () => {
      remote.status = { ...BY_ADDRESS, paired: null };
      return onHost;
    });
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<ConnectionPage />);
    });
    const host = screen.getByRole("region", { name: "Host" });
    fireEvent.click(within(host).getByRole("button", { name: "Forget host…" }));
    await act(async () => {
      fireEvent.click(within(host).getByRole("button", { name: "Forget host" }));
    });
    expect(kleio.forget).toHaveBeenCalledTimes(1);
    await act(async () => {
      view?.rerender(<ConnectionPage />);
    });
    const after = screen.getByRole("region", { name: "Host" });
    expect(within(after).queryByRole("button", { name: /Forget host/ })).toBeNull();
    expect(within(after).getByRole("status").textContent).toMatch(
      /^You just forgot the host\. Restart Kleio to apply/,
    );
    return after;
  }

  it("asks first, then forgets the host, and says it applies at the next launch", async () => {
    vi.mocked(kleio.forget).mockImplementation(async () => {
      remote.status = { ...BY_ADDRESS, paired: null };
      return { onHost: "removed" };
    });
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<ConnectionPage />);
    });
    const host = screen.getByRole("region", { name: "Host" });
    fireEvent.click(within(host).getByRole("button", { name: "Forget host…" }));
    expect(within(host).getByText(forgetHint())).toBeTruthy();
    expect(forgetHint()).toBe(
      "Kleio asks the host to remove this Mac, then forgets the host here. Sessions go back to running on this Mac after a restart. If the host can't be reached, it's forgotten here only, and the host lists this Mac until an admin revokes it.",
    );
    // Keep puts it back as it was, and nothing was forgotten.
    fireEvent.click(within(host).getByRole("button", { name: "Keep" }));
    expect(within(host).queryByText(forgetHint())).toBeNull();
    expect(kleio.forget).not.toHaveBeenCalled();

    fireEvent.click(within(host).getByRole("button", { name: "Forget host…" }));
    await act(async () => {
      fireEvent.click(within(host).getByRole("button", { name: "Forget host" }));
    });
    expect(kleio.forget).toHaveBeenCalledTimes(1);
    // Read again: the pairing is gone from disk, and this launch still runs on it.
    await act(async () => {
      view?.rerender(<ConnectionPage />);
    });
    const after = screen.getByRole("region", { name: "Host" });
    expect(within(after).queryByRole("button", { name: /Forget host/ })).toBeNull();
    expect(within(after).getByRole("status").textContent).toMatch(
      /^You just forgot the host\. Restart Kleio to apply/,
    );
  });

  it("on the iPhone, says the host is asked to remove it, and what if it can't be", async () => {
    document.documentElement.classList.add("platform-ios");
    await renderPage();
    const host = screen.getByRole("region", { name: "Host" });
    fireEvent.click(within(host).getByRole("button", { name: "Forget host…" }));
    expect(
      within(host).getByText(
        "Kleio asks the host to remove this iPhone, then forgets the host here. If the host can't be reached, it's forgotten here only, and the host lists this iPhone until an admin revokes it.",
      ),
    ).toBeTruthy();
  });

  it("host reached: says the host removed this Mac", async () => {
    await forgetWith({ onHost: "removed" });
    expect(toast).toHaveBeenCalledExactlyOnceWith("The host removed this Mac.", "success");
  });

  it("host unreachable: forgets it here anyway, and says the host still lists this Mac", async () => {
    await forgetWith({
      onHost: "notRemoved",
      reason: "the host couldn't be reached (connection refused)",
    });
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      "Forgot the host here only: the host couldn't be reached (connection refused). The host lists this Mac until an admin revokes it.",
      "warning",
      0,
    );
  });

  it("host answers 401: forgets it here anyway, and says it may be revoked already", async () => {
    await forgetWith({ onHost: "refused" });
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      "Forgot the host here. The host turned this Mac's token away (HTTP 401), so it may have been revoked already. If the host still lists this Mac, an admin can revoke it.",
      "warning",
      0,
    );
  });

  it("keeps Keep and Forget host disabled while the host is asked", async () => {
    let answer: (f: Forgot) => void = () => {};
    vi.mocked(kleio.forget).mockImplementation(
      () =>
        new Promise<Forgot>((resolve) => {
          answer = resolve;
        }),
    );
    await renderPage();
    const host = screen.getByRole("region", { name: "Host" });
    fireEvent.click(within(host).getByRole("button", { name: "Forget host…" }));
    await act(async () => {
      fireEvent.click(within(host).getByRole("button", { name: "Forget host" }));
    });
    const forgetting = within(host).getByRole<HTMLButtonElement>("button", { name: "Forgetting…" });
    const keep = within(host).getByRole<HTMLButtonElement>("button", { name: "Keep" });
    expect([forgetting.disabled, keep.disabled]).toEqual([true, true]);
    await act(async () => {
      answer({ onHost: "removed" });
    });
  });

  it("says why when forgetting fails, and keeps the pairing", async () => {
    vi.mocked(kleio.forget).mockRejectedValue(new Error("couldn't remove remote.json"));
    await renderPage();
    const host = screen.getByRole("region", { name: "Host" });
    fireEvent.click(within(host).getByRole("button", { name: "Forget host…" }));
    await act(async () => {
      fireEvent.click(within(host).getByRole("button", { name: "Forget host" }));
    });
    expect(within(host).getByRole("alert").textContent).toMatch(/remote\.json/);
    expect(within(host).queryByRole("status")).toBeNull();
  });

  it("isn't offered with no pairing at all", async () => {
    remote.status = { active: null, paired: null };
    await renderPage();
    const host = screen.getByRole("region", { name: "Host" });
    expect(within(host).queryByRole("button", { name: /Forget host/ })).toBeNull();
    expect(within(host).queryByRole("status")).toBeNull();
  });
});

describe("ConnectionPage — Notifications", () => {
  const QUOTE = { name: "Quote what was said" };
  const ON =
    "They quote the start of a reply, question or error, and some questions can be answered from the lock screen.";
  const OFF =
    "They say what happened, such as Finished or Needs your answer, but quote nothing. Questions are answered in Kleio.";

  /** The card and its switch, once the host's setting is in. */
  async function notifications(): Promise<{ box: HTMLElement; quote: HTMLInputElement }> {
    await renderPage();
    const box = screen.getByRole("region", { name: "Notifications" });
    const quote = within(box).getByRole("checkbox", QUOTE);
    if (!(quote instanceof HTMLInputElement)) throw new Error("not a checkbox");
    await waitFor(() => expect(within(box).queryByText("Checking…")).toBeNull());
    return { box, quote };
  }

  it("says they come through Apple, and an admin device turns quoting off", async () => {
    vi.mocked(setQuoteText).mockResolvedValue({ quoteText: false });
    const { box, quote } = await notifications();
    expect(
      within(box).getByText(
        "iPhone notifications and Live Activities come through Apple, so they aren't end-to-end encrypted like your chats.",
      ),
    ).toBeTruthy();
    expect([quote.checked, quote.disabled]).toEqual([true, false]);
    const words = (): string | null =>
      document.getElementById(quote.getAttribute("aria-describedby") ?? "")?.textContent ?? null;
    expect(words()).toBe(ON);
    fireEvent.click(quote);
    await waitFor(() => expect(quote.checked).toBe(false));
    expect(setQuoteText).toHaveBeenCalledWith(false);
    expect(words()).toBe(OFF);
    expect(within(box).queryByText("Only an admin device can change this.")).toBeNull();
  });

  it("shows another device the host's choice, which only an admin device changes", async () => {
    vi.mocked(notificationSettings).mockResolvedValue({ quoteText: false });
    const active = BY_ADDRESS.active;
    if (active === null) throw new Error("BY_ADDRESS has a pairing");
    remote.status = { ...BY_ADDRESS, active: { ...active, admin: false } };
    const { box, quote } = await notifications();
    expect([quote.checked, quote.disabled]).toEqual([false, true]);
    expect(within(box).getByText(OFF)).toBeTruthy();
    expect(within(box).getByText("Only an admin device can change this.")).toBeTruthy();
  });

  it("a save that fails says why, and the switch stays as the host has it", async () => {
    vi.mocked(setQuoteText).mockRejectedValue(new KleioApiError(0, "request timed out"));
    const { box, quote } = await notifications();
    fireEvent.click(quote);
    expect(await within(box).findByRole("alert")).toBeTruthy();
    expect(quote.checked).toBe(true);
    expect(within(box).getByText(ON)).toBeTruthy();
  });

  it("a host from before the setting: says to update it, with no switch", async () => {
    vi.mocked(notificationSettings).mockRejectedValue(new KleioApiError(404, "not found"));
    await renderPage();
    const box = screen.getByRole("region", { name: "Notifications" });
    expect(
      await within(box).findByText(
        "Kleio on mac-mini-1 can't leave text out of notifications yet. Update it to choose.",
      ),
    ).toBeTruthy();
    expect(within(box).queryByRole("checkbox")).toBeNull();
  });
});

describe("ConnectionPage — Kleio's link", () => {
  const EVENT_AT = Date.UTC(2026, 9, 17, 13, 6, 21);
  const N0 = "https://euc1-1.relay.n0.iroh.link./";
  /** A link in use, through n0's relay; `over` replaces fields. */
  function link(over: Partial<LinkStatus> = {}): LinkStatus {
    return {
      paired: true,
      active: true,
      running: true,
      error: null,
      host: "mac-mini-1.tail0000.ts.net",
      hostKey: "ab12cd34ef".padEnd(64, "0"),
      relay: N0,
      relayN0: true,
      refused: null,
      refusal: null,
      connected: true,
      dialling: false,
      unreached: null,
      lastReachedMs: EVENT_AT,
      path: "relay",
      pathAddr: N0,
      pathN0: true,
      rateLimited: false,
      rttMs: 55,
      connectedSinceMs: EVENT_AT,
      redials: 0,
      lastResumeMs: null,
      events: [{ atMs: EVENT_AT, text: "6ef5181507 +0.0s connected: relay (selected)" }],
      debugBuild: false,
      ...over,
    };
  }

  /** This launch reaches the host over the link, as the boot read gives it. */
  function onTheLink(over: Partial<LinkStatus> = {}): void {
    const base = "http://link.kleio.invalid";
    const active = { ...BY_ADDRESS.active, base } as RemoteStatus["active"];
    remote.status = { ...BY_ADDRESS, active };
    linkRoutes({ kleio_link_status: () => link(over) });
  }

  /** Not answering: nothing came back in time. */
  function noAnswer(): void {
    vi.mocked(hostHealth).mockRejectedValue(new Error("request timed out"));
  }

  /** The card, once the page has read the link. */
  async function card(): Promise<HTMLElement> {
    await renderPage();
    return screen.findByRole("region", { name: "Kleio's link" });
  }

  /** A fact's value, by its label. */
  function fact(box: HTMLElement, label: string): string {
    const dt = within(box).getByText(label, { selector: "dt" });
    return dt.nextElementSibling?.textContent ?? "";
  }

  /** Opens one of the card's disclosures, as a click on its summary does. */
  function open(box: HTMLElement, summary: string): HTMLElement {
    const row = within(box).getByText(summary, { selector: "summary" });
    const details = row.closest("details");
    if (!details) throw new Error(`${summary} isn't a disclosure`);
    expect(details.open).toBe(false);
    fireEvent.click(row);
    expect(details.open).toBe(true);
    return details;
  }

  it("isn't there in a build without the link", async () => {
    await renderPage();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("kleio_link_status"));
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Kleio's link" })).toBeNull();
    // The rest of the page is today's.
    expect(screen.getByRole("region", { name: "Host" })).toBeTruthy();
  });

  it("over the link, gives the link's own verdict, and never asks Tailscale", async () => {
    onTheLink();
    await renderPage();
    const { box, checks } = await verdict();
    expect(within(box).getByRole("heading", { name: "Connected to mac-mini-1" })).toBeTruthy();
    expect(box.textContent).toContain(
      "Through the relay. n0's public relay is shared and rate-limited, so big files are slower.",
    );
    expect(checks).toEqual([
      "Kleio's link on this Mac: Connected",
      "Path: Through n0's public relay",
      "Kleio on mac-mini-1: Running",
    ]);
    expect(kleio.tailscale).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Tailscale" })).toBeNull();
    // The host by its name: over the link there's no address to show.
    const host = screen.getByRole("region", { name: "Host" });
    expect(fact(host, "Name")).toBe("mac-mini-1.tail0000.ts.net");
    expect(within(host).queryByText("http://link.kleio.invalid")).toBeNull();
    expect(
      [...document.querySelectorAll(".conn-link-label")].map((label) => label.textContent),
    ).toEqual(["Kleio's link", "Kleio's link"]);
  });

  it("over the link, a host that doesn't answer is asleep or offline, with the restart for its OS", async () => {
    localStorage.setItem("kleio.hostKind", JSON.stringify({ os: "darwin", laptop: false }));
    noAnswer();
    onTheLink({
      connected: false,
      path: null,
      pathAddr: null,
      pathN0: false,
      lastReachedMs: Date.now() - 3 * 60_000,
      unreached: { kind: "host-silent", relays: [] },
    });
    await renderPage();
    const { box } = await verdict();
    expect(
      within(box).getByRole("heading", { name: "mac-mini-1 is asleep or offline" }),
    ).toBeTruthy();
    expect(within(box).getByText("Last reached 3 min ago.")).toBeTruthy();
    expect([...box.querySelectorAll(".conn-command code")].map((c) => c.textContent)).toEqual([
      RESTART_LINK,
    ]);
    // Nothing on the page talks of Tailscale.
    expect(within(box).queryByText(/Tailscale/)).toBeNull();
  });

  it("over the link, the host's link answering for a stopped Kleio gives its restart", async () => {
    localStorage.setItem("kleio.hostKind", JSON.stringify({ os: "linux", laptop: false }));
    vi.mocked(hostHealth).mockRejectedValue(new KleioApiError(502, "kleio_down"));
    onTheLink();
    await renderPage();
    const { box } = await verdict();
    expect(
      within(box).getByRole("heading", { name: "Kleio on mac-mini-1 isn't running" }),
    ).toBeTruthy();
    expect([...box.querySelectorAll(".conn-command code")].map((c) => c.textContent)).toEqual([
      START_HOST,
    ]);
  });

  it("says the link is end-to-end encrypted, what isn't, and what n0's relay is", async () => {
    onTheLink();
    const box = await card();
    expect(
      within(box).getByText(
        "Your chats travel end-to-end encrypted between this Mac and mac-mini-1. Relays pass them on but can't read them.",
      ),
    ).toBeTruthy();
    expect(
      within(box).getByText(
        "iPhone notifications and Live Activities aren't end-to-end encrypted: Apple delivers them, with the start of a reply, question or error.",
      ),
    ).toBeTruthy();
    expect(within(box).getByText(N0_RELAY_LINE)).toBeTruthy();
    // What was measured: Phase 2's EE 4G connections all went through the relay, too.
    expect(N0_RELAY_LINE).toMatch(/on EE 4G no connection went direct\.$/);
    expect(fact(box, "Path")).toBe("Through n0's public relay");
    expect(fact(box, "Relay")).toBe("n0's public relay euc1-1.relay.n0.iroh.link");
    expect(within(box).getByText("Relay", { selector: ".badge" })).toBeTruthy();
  });

  it("says notifications quote nothing once the host leaves the text out", async () => {
    vi.mocked(notificationSettings).mockResolvedValue({ quoteText: false });
    onTheLink();
    const box = await card();
    expect(
      await within(box).findByText(
        "iPhone notifications and Live Activities aren't end-to-end encrypted: Apple delivers them, but they quote nothing that was said.",
      ),
    ).toBeTruthy();
  });

  it("on the iPhone, of its own notifications; through the host's own relay, nothing of n0's", async () => {
    document.documentElement.classList.add("platform-ios");
    const own = "https://relay.example.com./";
    onTheLink({ relay: own, relayN0: false, pathAddr: own, pathN0: false });
    const box = await card();
    expect(
      within(box).getByText(
        "Your chats travel end-to-end encrypted between this iPhone and mac-mini-1. Relays pass them on but can't read them.",
      ),
    ).toBeTruthy();
    expect(
      within(box).getByText(
        "Notifications and Live Activities aren't end-to-end encrypted: Apple delivers them, with the start of a reply, question or error.",
      ),
    ).toBeTruthy();
    expect(within(box).queryByText(N0_RELAY_LINE)).toBeNull();
    expect(fact(box, "Path")).toBe("Through your relay (relay.example.com)");
    expect(fact(box, "Relay")).toBe("relay.example.com");
  });

  it("says when a relay is slowing it", async () => {
    onTheLink({ rateLimited: true });
    const box = await card();
    expect(within(box).getByText("Slowed", { selector: ".badge" })).toBeTruthy();
    expect(fact(box, "Path")).toBe("Through n0's public relay, slowed by the relay");
  });

  it("shows the path, round trip and relay, and the rest under Details", async () => {
    onTheLink({
      path: "direct",
      pathAddr: "192.168.4.68:52617",
      pathN0: false,
      rttMs: 2,
      redials: 3,
      lastResumeMs: 340,
      events: [
        { atMs: EVENT_AT, text: "6ef5181507 +0.0s connected: relay (selected)" },
        {
          atMs: EVENT_AT + 17_400,
          text: "6ef5181507 +17.4s path selected: direct 192.168.4.68:52617",
        },
      ],
    });
    const box = await card();
    expect(within(box).getByText("Direct", { selector: ".badge" })).toBeTruthy();
    expect(fact(box, "Path")).toBe("Direct 192.168.4.68:52617");
    expect(fact(box, "Round trip")).toBe("2 ms");
    expect(fact(box, "Relay")).toBe("n0's public relay euc1-1.relay.n0.iroh.link");
    const details = open(box, "Details");
    expect(fact(details, "Connected")).toMatch(/^Since /);
    expect(fact(details, "Redials")).toBe("3");
    expect(fact(details, "Last resume")).toBe("340 ms");
    expect(fact(details, "Host key")).toBe("ab12cd34ef…");
    const events = within(details).getByRole("list", { name: "Path events" });
    expect(
      within(events)
        .getAllByRole("listitem")
        .map((li) => li.querySelector("span")?.textContent),
    ).toEqual([
      "6ef5181507 +0.0s connected: relay (selected)",
      "6ef5181507 +17.4s path selected: direct 192.168.4.68:52617",
    ]);
    expect(within(box).queryByRole("alert")).toBeNull();
  });

  it("keeps the last 20 path events, in a box of their own that scrolls", async () => {
    const events = Array.from({ length: 25 }, (_, i) => ({
      atMs: EVENT_AT + i * 1_000,
      text: `6ef5181507 +${i}.0s path event ${i + 1}`,
    }));
    onTheLink({ events });
    const details = open(await card(), "Details");
    const scroll = within(details).getByRole("region", { name: "Path events" });
    expect(scroll.getAttribute("tabindex")).toBe("0");
    const shown = within(scroll)
      .getAllByRole("listitem")
      .map((li) => li.querySelector("span")?.textContent);
    expect(shown).toEqual(events.slice(5).map((event) => event.text));
  });

  it("has the events box before the first event, so it moves nothing", async () => {
    onTheLink({ events: [] });
    const details = open(await card(), "Details");
    const scroll = within(details).getByRole("region", { name: "Path events" });
    expect(within(scroll).getByText("None yet.")).toBeTruthy();
  });

  it("takes a direct path over Tailscale for what it is: direct", async () => {
    const text = "6ef5181507 +17.4s path opened: direct 100.73.82.118:49382";
    onTheLink({
      path: "direct",
      pathAddr: "100.73.82.118:49382",
      pathN0: false,
      events: [{ atMs: EVENT_AT, text }],
    });
    const box = await card();
    expect(within(box).getByText("Direct", { selector: ".badge" })).toBeTruthy();
    expect(within(box).queryByRole("alert")).toBeNull();
    expect(within(open(box, "Details")).getByText(text).closest("li")?.className).toBe("");
  });

  it("has no mode switch: the link finds its own path", async () => {
    onTheLink();
    const box = await card();
    expect(within(box).queryByRole("radiogroup")).toBeNull();
    expect(within(box).queryByText("Relay only")).toBeNull();
    expect(within(box).queryByText("Mode")).toBeNull();
  });

  it("when the host has turned this device away, the verdict says so and how to pair again", async () => {
    noAnswer();
    onTheLink({
      connected: false,
      path: null,
      pathAddr: null,
      pathN0: false,
      refused: "This device was removed from your host. Pair it again to use it.",
      refusal: "revoked",
    });
    await renderPage();
    const { box } = await verdict();
    expect(within(box).getByRole("heading", { name: "mac-mini-1 removed this Mac" })).toBeTruthy();
    expect(box.querySelector(".conn-command code")?.textContent).toBe("kleio-host pair");
    const linkCard = screen.getByRole("region", { name: "Kleio's link" });
    expect(within(linkCard).getByText("Turned away", { selector: ".badge" })).toBeTruthy();
  });

  it("once its link pairing is set aside, says the link stays in use until a restart", async () => {
    onTheLink({ paired: false });
    const box = await card();
    expect(
      within(box).getByText(
        "This Mac's link pairing was removed. Kleio keeps using the link until it restarts.",
      ),
    ).toBeTruthy();
    expect(within(box).queryByText("Not paired over the link.")).toBeNull();
  });

  it("a device paired by address pairs over the link from the card, by pasted pairing text on the Mac", async () => {
    const TICKET = JSON.stringify({
      v: 5,
      type: "kleio-pair",
      name: "mac-mini-1",
      key: "ab12cd34ef".padEnd(64, "0"),
      pair: "cd34ef56ab".padEnd(64, "0"),
      relays: ["https://euc1-1.relay.n0.iroh.link./", "n0"],
      code: "ABC-DEF",
    });
    let paired = false;
    linkRoutes({
      kleio_link_status: () =>
        paired
          ? link({ active: false, running: false, connected: false })
          : link({ paired: false, active: false, running: false, debugBuild: false }),
      kleio_link_check_ticket: () => ({
        name: "mac-mini-1",
        keyPrefix: "ab12cd34ef",
        relayHost: "euc1-1.relay.n0.iroh.link.",
        code: "ABC-DEF",
      }),
      kleio_link_pair: (args) => {
        expect(args).toEqual({ ticket: TICKET, label: "", onStage: expect.any(Channel) });
        paired = true;
        return {};
      },
    });
    const box = await card();
    expect(
      within(box).getByText(
        "Reaches your host from anywhere, end-to-end encrypted, with no Tailscale needed.",
      ),
    ).toBeTruthy();
    // Paired by address (over Tailscale): the switch's words, as an admin.
    expect(within(box).getByText(switchWords("Mac", "mac-mini-1", true))).toBeTruthy();
    fireEvent.change(within(box).getByLabelText("Paste pairing text"), {
      target: { value: TICKET },
    });
    fireEvent.click(within(box).getByRole("button", { name: "Use pairing text" }));
    await within(box).findByText("ab12cd34ef…");
    // The confirm step's, not the one in the closed Advanced form (which
    // jsdom, unlike a browser, doesn't hide).
    const confirm = within(box)
      .getAllByRole("button", { name: "Pair" })
      .find((button) => !button.closest("details"));
    if (!confirm) throw new Error("no Pair button in the confirm step");
    fireEvent.click(confirm);
    await within(box).findByText(/Restart Kleio to use it/);
  });

  describe("switching from Tailscale to the link", () => {
    const TICKET = JSON.stringify({
      v: 5,
      type: "kleio-pair",
      name: "mac-mini-1",
      key: "ab12cd34ef".padEnd(64, "0"),
      pair: "cd34ef56ab".padEnd(64, "0"),
      relays: ["https://euc1-1.relay.n0.iroh.link./", "n0"],
      code: "ADM-123",
    });
    const OFFER = {
      display: "ADM-123",
      expiresAt: 0,
      admin: true,
      ticket: TICKET,
      ticketError: null,
    };
    const CHECK = {
      name: "mac-mini-1",
      keyPrefix: "ab12cd34ef",
      relayHost: "euc1-1.relay.n0.iroh.link.",
      code: "ADM-123",
    };

    it("offers an admin Mac the switch, with a code of its own, and keeps Tailscale until the link reaches the host", async () => {
      vi.mocked(kleio.offer).mockResolvedValue(OFFER);
      let paired = false;
      const pairs: unknown[] = [];
      linkRoutes({
        kleio_link_status: () =>
          paired
            ? link({ active: false, running: false, connected: false })
            : link({ paired: false, active: false, running: false, debugBuild: false }),
        kleio_link_check_ticket: (args) => {
          expect(args).toEqual({ ticket: TICKET });
          return CHECK;
        },
        kleio_link_pair: (args) => {
          pairs.push(args);
          paired = true;
          return {};
        },
        kleio_switch_status: () => ({ state: "waiting-for-link", reason: null }),
      });
      const box = await card();
      expect(within(box).getByText(switchWords("Mac", "mac-mini-1", true))).toBeTruthy();
      expect(switchWords("Mac", "mac-mini-1", true)).toBe(
        "This Mac reaches mac-mini-1 over Tailscale. Switch to Kleio's link: no Tailscale needed. It pairs again with a code of its own, so this Mac stays an admin. Your pairing over Tailscale stays until the link has reached mac-mini-1.",
      );
      fireEvent.click(within(box).getByRole("button", { name: "Switch to Kleio's link" }));
      // An admin code, so the link pairing is an admin as the Tailscale one is.
      await within(box).findByText("ab12cd34ef…");
      expect(kleio.offer).toHaveBeenCalledWith(true);
      expect(within(box).getByText("ADM-123")).toBeTruthy();
      const confirm = within(box)
        .getAllByRole("button", { name: "Pair" })
        .find((button) => !button.closest("details"));
      if (!confirm) throw new Error("no Pair button in the confirm step");
      fireEvent.click(confirm);
      expect(
        await within(box).findByText(
          /Restart Kleio to use it\. Your pairing over Tailscale stays until the link has reached mac-mini-1, as the way back\./,
        ),
      ).toBeTruthy();
      expect(pairs).toEqual([{ ticket: TICKET, label: "", onStage: expect.any(Channel) }]);
      expect(
        await within(box).findByText(
          "This Mac's old pairing over Tailscale stays until the link has reached mac-mini-1: it's the way back.",
        ),
      ).toBeTruthy();
    });

    it("a switch whose code can't be made says why, and pairs nothing", async () => {
      vi.mocked(kleio.offer).mockRejectedValue({
        kind: "denied",
        message: "Touch ID was cancelled or didn't match.",
      });
      const pairs: unknown[] = [];
      linkRoutes({
        kleio_link_status: () => link({ paired: false, active: false, running: false }),
        kleio_link_pair: (args) => pairs.push(args),
      });
      const box = await card();
      fireEvent.click(within(box).getByRole("button", { name: "Switch to Kleio's link" }));
      expect((await within(box).findByRole("alert")).textContent).toBe(
        "Touch ID was cancelled or didn't match.",
      );
      expect(pairs).toEqual([]);
      // Still the way it was: the switch is offered again.
      expect(within(box).getByRole("button", { name: "Switch to Kleio's link" })).toBeTruthy();
    });

    it("a device that isn't an admin is told where to get a code, and isn't offered its own", async () => {
      const active = BY_ADDRESS.active;
      if (active === null) throw new Error("BY_ADDRESS has a pairing");
      remote.status = { ...BY_ADDRESS, active: { ...active, admin: false } };
      linkRoutes({
        kleio_link_status: () =>
          link({ paired: false, active: false, running: false, debugBuild: false }),
      });
      const box = await card();
      expect(
        within(box).getByText(
          "This Mac reaches mac-mini-1 over Tailscale. Switch to Kleio's link: no Tailscale needed. Paste pairing text from an admin device's Settings → Connection. Your pairing over Tailscale stays until the link has reached mac-mini-1.",
        ),
      ).toBeTruthy();
      expect(within(box).queryByRole("button", { name: "Switch to Kleio's link" })).toBeNull();
      expect(within(box).getByLabelText("Paste pairing text")).toBeTruthy();
      expect(switchWords("iPhone", "mac-mini-1", false)).toMatch(
        /Scan a pairing QR code from an admin device's Settings → Connection\./,
      );
    });

    it("says what the cleanup is waiting for, then removes the old pairing here once the host refused", async () => {
      let status: { state: string; reason: string | null } = {
        state: "refused",
        reason:
          "The host didn't take this Mac's old pairing's token (HTTP 401): it may have been revoked already, or it doesn't match.",
      };
      const removed: string[] = [];
      onTheLink();
      linkRoutes({
        kleio_link_status: () => link(),
        kleio_switch_status: () => status,
        kleio_switch_remove_old: () => {
          removed.push("old");
          status = { state: "none", reason: null };
        },
      });
      const box = await card();
      const alert = await within(box).findByRole("alert");
      expect(alert.textContent).toBe(
        "The host didn't take this Mac's old pairing's token (HTTP 401): it may have been revoked already, or it doesn't match. The link works, so it can be removed from this Mac. mac-mini-1 lists it until an admin revokes it.",
      );
      await act(async () => {
        fireEvent.click(within(box).getByRole("button", { name: "Remove it from this Mac" }));
      });
      expect(removed).toEqual(["old"]);
      await waitFor(() =>
        expect(within(box).queryByRole("button", { name: /Remove it from/ })).toBeNull(),
      );
    });

    it.each<[string, string | null, RegExp]>([
      [
        "waiting-for-link",
        null,
        /stays until the link has reached mac-mini-1: it's the way back\.$/,
      ],
      ["pending", null, /is removed the next time the link connects\.$/],
      [
        "waiting-for-host",
        "connection refused",
        /once mac-mini-1 answers over Tailscale\. Kleio tries again each time the link connects\. Last try: connection refused$/,
      ],
      [
        "unfinished",
        "the Keychain is locked",
        /mac-mini-1 dropped this Mac's old pairing over Tailscale, but a part of it is still on this Mac\. Kleio removes it the next time the link connects\. \(the Keychain is locked\)$/,
      ],
    ])("says the cleanup is %s", async (state, reason, words) => {
      onTheLink();
      linkRoutes({
        kleio_link_status: () => link(),
        kleio_switch_status: () => ({ state, reason }),
      });
      const box = await card();
      expect(await within(box).findByText(words)).toBeTruthy();
      expect(within(box).queryByRole("button", { name: /Remove it from/ })).toBeNull();
    });
  });

  /** A pairing by address, as `kleio_pair` answers it. */
  function pairedByAddress(setAside: Forgot | null): Paired {
    return {
      baseUrl: "https://mac-mini-1.tail0000.ts.net:8443",
      host: "mac-mini-1.tail0000.ts.net",
      deviceId: "d2",
      label: "Laptop",
      admin: false,
      pairedAt: "2026-10-23T10:00:00Z",
      setAside,
    };
  }

  /** Pairs by address under Advanced, and hands back the form's box. */
  async function pairByAddress(): Promise<HTMLElement> {
    const advanced = open(await card(), "Advanced: connect over your own network");
    fireEvent.change(within(advanced).getByLabelText("Host URL"), {
      target: { value: "https://mac-mini-1.tail0000.ts.net:8443" },
    });
    fireEvent.change(within(advanced).getByLabelText("Pair code"), {
      target: { value: "abc-def" },
    });
    fireEvent.click(within(advanced).getByRole("button", { name: "Pair" }));
    const done = await within(advanced).findByRole("status");
    expect(done.textContent).toMatch(/^Paired over your own network\. Restart Kleio to apply/);
    return advanced;
  }

  it("pairs by the host's address under Advanced, and says what that replaces", async () => {
    vi.mocked(kleio.pair).mockResolvedValue(pairedByAddress({ onHost: "removed" }));
    vi.mocked(kleio.activatePairing).mockResolvedValue("restart");
    onTheLink();
    const advanced = open(await card(), "Advanced: connect over your own network");
    expect(
      within(advanced).getByText(
        "Pairing here replaces this Mac's link pairing from the next launch, and asks mac-mini-1 to remove it. If it can't be reached, mac-mini-1 lists the link pairing until an admin revokes it.",
      ),
    ).toBeTruthy();
    const pair = within(advanced).getByRole("button", { name: "Pair" }) as HTMLButtonElement;
    expect(pair.disabled).toBe(true);
    fireEvent.change(within(advanced).getByLabelText("Host URL"), {
      target: { value: "https://mac-mini-1.tail0000.ts.net:8443" },
    });
    fireEvent.change(within(advanced).getByLabelText("Pair code"), {
      target: { value: "abc-def" },
    });
    fireEvent.click(pair);
    const done = await within(advanced).findByRole("status");
    expect(kleio.pair).toHaveBeenCalledWith(
      "https://mac-mini-1.tail0000.ts.net:8443",
      "ABC-DEF",
      "",
    );
    expect(kleio.activatePairing).toHaveBeenCalledOnce();
    expect(done.textContent).toMatch(/^Paired over your own network\. Restart Kleio to apply/);
    // The link pairing's host was reached, and removed it.
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      "The host removed this Mac's link pairing.",
      "success",
    );
    fireEvent.click(within(advanced).getByRole("button", { name: "Restart now" }));
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("sets the link pairing aside even when its host can't be reached, and says so", async () => {
    vi.mocked(kleio.pair).mockResolvedValue(
      pairedByAddress({
        onHost: "notRemoved",
        reason: "this launch doesn't reach the host over Kleio's link",
      }),
    );
    vi.mocked(kleio.activatePairing).mockResolvedValue("restart");
    onTheLink();
    await pairByAddress();
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      "This Mac's link pairing was set aside here only: this launch doesn't reach the host over Kleio's link. The host lists it until an admin revokes it.",
      "warning",
      0,
    );
  });

  it("sets the link pairing aside when its host answers 401, and says it may be revoked", async () => {
    vi.mocked(kleio.pair).mockResolvedValue(pairedByAddress({ onHost: "refused" }));
    vi.mocked(kleio.activatePairing).mockResolvedValue("restart");
    onTheLink();
    await pairByAddress();
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      "This Mac's link pairing was set aside here. The host turned its token away (HTTP 401), so it may have been revoked already. If the host still lists it, an admin can revoke it.",
      "warning",
      0,
    );
  });

  it("with no link pairing, says the host still lists the pairing it replaces", async () => {
    vi.mocked(kleio.pair).mockResolvedValue(pairedByAddress(null));
    vi.mocked(kleio.activatePairing).mockResolvedValue("restart");
    linkRoutes({ kleio_link_status: () => link({ paired: false, active: false }) });
    const advanced = open(await card(), "Advanced: connect over your own network");
    expect(
      within(advanced).getByText(
        "Pairing here replaces this Mac's pairing from the next launch. mac-mini-1 still lists the old one until an admin revokes it.",
      ),
    ).toBeTruthy();
    cleanup();
    await pairByAddress();
    expect(toast).not.toHaveBeenCalled();
  });

  it("keeps the form and the host's words when a pairing by address fails", async () => {
    vi.mocked(kleio.pair).mockRejectedValue(
      new Error("Code not recognised, or it expired. Mint a fresh one on the host."),
    );
    onTheLink();
    const advanced = open(await card(), "Advanced: connect over your own network");
    fireEvent.change(within(advanced).getByLabelText("Host URL"), {
      target: { value: "https://mac-mini-1.tail0000.ts.net:8443" },
    });
    fireEvent.change(within(advanced).getByLabelText("Pair code"), {
      target: { value: "ZZZ-ZZZ" },
    });
    fireEvent.click(within(advanced).getByRole("button", { name: "Pair" }));
    const alert = await within(advanced).findByRole("alert");
    expect(alert.textContent).toBe(
      "Code not recognised, or it expired. Mint a fresh one on the host.",
    );
    expect(kleio.activatePairing).not.toHaveBeenCalled();
    expect(
      (within(advanced).getByRole("button", { name: "Pair" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect((within(advanced).getByLabelText("Host URL") as HTMLInputElement).value).toBe(
      "https://mac-mini-1.tail0000.ts.net:8443",
    );
  });
});

describe("wording", () => {
  it("reads latency in plain words", () => {
    expect(formatLatency(38)).toBe("38 ms");
    expect(formatLatency(1250)).toBe("1.3 s");
  });
});

describe("ConnectionPage — relays", () => {
  const OWN = "https://relay.example.com/";

  async function relaysCard(): Promise<HTMLElement> {
    await renderPage();
    const card = screen.getByRole("region", { name: "Relays" });
    await within(card).findByRole("list", { name: "Relays, in order" });
    return card;
  }

  function rows(card: HTMLElement): string[] {
    return within(within(card).getByRole("list", { name: "Relays, in order" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
  }

  it("shows the relays in order, and which the host is on", async () => {
    const card = await relaysCard();
    expect(rows(card)).toEqual(["n0's public relaysIn useThe host is on one of them"]);
  });

  it("lets an admin add a relay ahead of n0's, and says the host moves once devices have it", async () => {
    vi.mocked(setRelayList).mockResolvedValue({
      list: {
        listVersion: 1,
        relays: [
          { entry: OWN, state: "untested", new: true },
          { entry: "n0", state: "home", new: false },
        ],
        inUse: false,
        hostRelay: "https://euc1-1.relay.n0.iroh.link./",
        waiting: 2,
        waitingFor: [
          { deviceId: "p", label: "iPhone", lastSeen: null },
          { deviceId: "q", label: "iPad", lastSeen: null },
        ],
      },
      pings: [{ relay: OWN, kind: "relay", ms: 40 }],
    });
    const card = await relaysCard();
    fireEvent.change(within(card).getByLabelText("A relay's address"), {
      target: { value: "relay.example.com" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));
    expect(rows(card)[0]).toBe("relay.example.comNewNot saved yet");
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    });
    expect(setRelayList).toHaveBeenCalledWith(0, [OWN, "n0"], false);
    expect(toast).toHaveBeenCalledWith(
      "Relays saved. The host moves once 2 devices have the new list.",
      "success",
    );
    expect(within(card).getByRole("status").textContent).toBe(
      "The host stays on relays every device knows until 2 devices have the new list: iPhone, iPad. A device opens Kleio to get it.",
    );
    expect(within(card).getByRole("button", { name: "Use it now…" })).toBeTruthy();
  });

  it("says which relays didn't answer, and saves them only when asked to anyway", async () => {
    const refused = new KleioApiError(422, "relay_unreachable", undefined, undefined, {
      error: "relay_unreachable",
      pings: [{ relay: OWN, kind: "no_answer", detail: "no answer in 5 s" }],
    });
    vi.mocked(setRelayList)
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce({ list: { ...N0_LIST, listVersion: 1 }, pings: [] });
    const card = await relaysCard();
    fireEvent.change(within(card).getByLabelText("A relay's address"), {
      target: { value: OWN },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Save" }));
    });
    expect(within(card).getByRole("alert").textContent).toBe(
      "This relay doesn't answer as a relay does:relay.example.com: no answer in 5 s.",
    );
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Save anyway" }));
    });
    expect(vi.mocked(setRelayList).mock.calls).toEqual([
      [0, [OWN, "n0"], false],
      [0, [OWN, "n0"], true],
    ]);
  });

  it("turns away an address that isn't a relay's, and one already listed", async () => {
    const card = await relaysCard();
    const field = within(card).getByLabelText("A relay's address");
    for (const [typed, words] of [
      [
        "http://relay.example.com/",
        "Type a relay's https address, such as https://relay.example.com/.",
      ],
      [
        "https://relay.example.com/path",
        "Type a relay's https address, such as https://relay.example.com/.",
      ],
      ["n0", "n0's public relays is in the list already."],
    ]) {
      fireEvent.change(field, { target: { value: typed } });
      fireEvent.click(within(card).getByRole("button", { name: "Add" }));
      expect(within(card).getByRole("alert").textContent).toBe(words);
    }
    expect(setRelayList).not.toHaveBeenCalled();
  });

  it("moves a relay up, and removes one, but never the last", async () => {
    vi.mocked(relayList).mockResolvedValue({
      ...N0_LIST,
      relays: [
        { entry: "n0", state: "home", new: false },
        { entry: OWN, state: "standby", new: false },
      ],
    });
    const card = await relaysCard();
    fireEvent.click(within(card).getByRole("button", { name: "Move up: relay.example.com" }));
    expect(rows(card).map((r) => r.slice(0, 17))).toEqual([
      "relay.example.com",
      "n0's public relay",
    ]);
    fireEvent.click(within(card).getByRole("button", { name: "Remove: n0's public relays" }));
    expect(rows(card)).toHaveLength(1);
    expect(
      (within(card).getByRole("button", { name: "Remove: relay.example.com" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(within(card).getByRole("button", { name: "Undo" }));
    expect(rows(card)).toHaveLength(2);
  });

  it("uses a waiting list now when an admin says so", async () => {
    vi.mocked(relayList).mockResolvedValue({
      ...N0_LIST,
      listVersion: 2,
      inUse: false,
      waiting: 1,
    });
    vi.mocked(adoptRelayList).mockResolvedValue({ ...N0_LIST, listVersion: 2 });
    const card = await relaysCard();
    // It asks first: a device without the new list pairs again.
    fireEvent.click(within(card).getByRole("button", { name: "Use it now…" }));
    expect(
      within(card).getByText(
        "The host moves at once. A device without the new list then pairs again.",
      ),
    ).toBeTruthy();
    expect(adoptRelayList).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Keep waiting" }));
    fireEvent.click(within(card).getByRole("button", { name: "Use it now…" }));
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Use it now" }));
    });
    expect(adoptRelayList).toHaveBeenCalledOnce();
    expect(adoptRelayList).toHaveBeenCalledWith(2);
    expect(toast).toHaveBeenCalledWith("The host uses the new relays now.", "success");
    expect(within(card).queryByRole("button", { name: /Use it now/ })).toBeNull();
  });

  it("shows a device that isn't an admin the list, and nothing to change it with", async () => {
    remote.status = { ...BY_ADDRESS, active: { ...BY_ADDRESS.active!, admin: false } };
    const card = await relaysCard();
    expect(within(card).queryByRole("button", { name: /Move up|Remove|Add|Save/ })).toBeNull();
    expect(within(card).getByText("Only an admin device can change the relays.")).toBeTruthy();
  });

  it("says when the host is too old to change its relays", async () => {
    vi.mocked(relayList).mockRejectedValue(new KleioApiError(404, "not found"));
    await renderPage();
    const card = screen.getByRole("region", { name: "Relays" });
    expect(
      await within(card).findByText(
        "Kleio on mac-mini-1 can't change its relays yet. Update it to choose.",
      ),
    ).toBeTruthy();
  });
});
