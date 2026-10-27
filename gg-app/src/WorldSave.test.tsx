// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  worldAccountDelete,
  worldLive,
  worldSaveDelete,
  worldSaveGet,
  worldSavePut,
} from "./agent";
import { WORLD_CONSENT_KEY, WORLD_LIVE_CONSENT_KEY } from "./world-save";
import { WorldScreen, type WorldPlayer } from "./WorldScreen";

vi.mock("./agent", () => ({
  openUrl: vi.fn(),
  worldSaveGet: vi.fn(),
  worldSavePut: vi.fn(),
  worldSaveDelete: vi.fn(),
  worldAccountDelete: vi.fn(),
  worldLive: vi.fn(async () => ({ status: 403, body: null })),
}));

const saved = (ver: number, name: string | null = null, owned: string[] = []) => ({
  status: 200,
  body: {
    profile: { name, look: { hat: 1 }, owned, spent: 5, bests: {}, level: 3 },
    ver,
    updatedAt: 1,
  },
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(worldSaveGet).mockResolvedValue(saved(0));
  vi.mocked(worldSavePut).mockResolvedValue(saved(1));
  vi.mocked(worldSaveDelete).mockResolvedValue({ status: 200, body: { deleted: true } });
  vi.mocked(worldAccountDelete).mockResolvedValue({ status: 200, body: { deleted: true } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  localStorage.clear();
});

const player = (xp: number, by = { prompts: xp, commits: 0, streakBonus: 0 }): WorldPlayer => ({
  level: 3,
  percent: 10,
  xp,
  xpBySource: by,
});

function open(p: WorldPlayer = player(100)) {
  const view = render(<WorldScreen onClose={vi.fn()} player={p} />);
  const frame = screen.getByLabelText<HTMLIFrameElement>("World");
  const win = frame.contentWindow;
  if (!win) throw new Error("no frame window");
  const posted = vi.spyOn(win, "postMessage").mockImplementation(() => {});
  const send = (data: Record<string, unknown>): void => {
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { gg: "world", ...data },
          source: win,
          origin: "null", // World runs sealed: its messages carry an opaque origin
        }),
      );
    });
  };
  const sent = (t: string) =>
    posted.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m.t === t);
  return { view, send, sent };
}

const agreeOnline = () => {
  localStorage.setItem(WORLD_CONSENT_KEY, JSON.stringify({ v: 1, on: true }));
  localStorage.setItem(WORLD_LIVE_CONSENT_KEY, JSON.stringify({ v: 1, on: false }));
};
const profile = { name: "Ken", look: { hat: 2 }, owned: ["cap"], spent: 9 };

describe("World online save", () => {
  it("asks once after ready, and makes no World call before agreeing", async () => {
    const { send } = open();
    expect(screen.queryByRole("dialog")).toBeNull();
    send({ t: "ready" });
    const dialog = await screen.findByRole("dialog", { name: "Save World online?" });
    expect(dialog.textContent).toContain("Never your code, files or prompts.");
    send({ t: "save", profile });
    expect(worldSaveGet).not.toHaveBeenCalled();
    expect(worldSavePut).not.toHaveBeenCalled();
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save online" });
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep it on this computer" }));
    expect(JSON.parse(localStorage.getItem(WORLD_CONSENT_KEY) ?? "")).toEqual({ v: 1, on: false });
    cleanup();
    const again = open();
    again.send({ t: "ready" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(worldSaveGet).not.toHaveBeenCalled();
  });

  it("agreeing turns it on: fetches, hands an existing save to the game, uploads saves with ver", async () => {
    vi.mocked(worldSaveGet).mockResolvedValue(saved(4, "Ken", ["boots"]));
    const { send, sent } = open();
    send({ t: "ready" });
    fireEvent.click(await screen.findByLabelText("I'm 18 or over"));
    fireEvent.click(screen.getByRole("button", { name: "Save online" }));
    await waitFor(() => expect(sent("profile")).toHaveLength(1));
    expect(sent("profile")[0]?.profile).toMatchObject({ name: "Ken", owned: ["boots"] });

    vi.mocked(worldSavePut).mockResolvedValue(saved(5, "Ken"));
    send({ t: "save", profile });
    await waitFor(() => expect(worldSavePut).toHaveBeenCalledOnce());
    // Same name as the server: not sent; owned keeps the server's items too.
    expect(worldSavePut).toHaveBeenCalledWith(4, {
      look: { hat: 2 },
      owned: ["cap", "boots"],
      spent: 9,
      level: 3,
    });
    await waitFor(() =>
      expect(sent("note")).toEqual([{ gg: "world", t: "note", text: "Saved online" }]),
    );
    send({ t: "save", profile: { ...profile, spent: 10 } });
    await waitFor(() => expect(worldSavePut).toHaveBeenCalledTimes(2));
    expect(vi.mocked(worldSavePut).mock.calls[1]?.[0]).toBe(5);
    // "Saved online" only for the first save of the session.
    expect(sent("note")).toHaveLength(1);
  });

  it("on 409 fetches again and retries once with the new ver", async () => {
    agreeOnline();
    vi.mocked(worldSaveGet)
      .mockResolvedValueOnce(saved(2))
      .mockResolvedValueOnce(saved(3, "Old", ["sword"]));
    vi.mocked(worldSavePut)
      .mockResolvedValueOnce({ status: 409, body: { error: "stale" } })
      .mockResolvedValueOnce(saved(4, "Ken"));
    const { send } = open();
    send({ t: "ready" });
    await waitFor(() => expect(worldSaveGet).toHaveBeenCalledOnce());
    send({ t: "save", profile });
    await waitFor(() => expect(worldSavePut).toHaveBeenCalledTimes(2));
    expect(worldSaveGet).toHaveBeenCalledTimes(2);
    expect(vi.mocked(worldSavePut).mock.calls[0]?.[0]).toBe(2);
    expect(vi.mocked(worldSavePut).mock.calls[1]).toEqual([
      3,
      { look: { hat: 2 }, owned: ["cap", "sword"], spent: 9, level: 3, name: "Ken" },
    ]);
  });

  it("retries without a refused name and tells the player why", async () => {
    agreeOnline();
    // an existing row: no immediate first save
    vi.mocked(worldSaveGet).mockResolvedValue(saved(1));
    vi.mocked(worldSavePut)
      .mockResolvedValueOnce({ status: 400, body: { error: "That name is taken." } })
      .mockResolvedValueOnce(saved(1));
    const { send, sent } = open();
    send({ t: "ready" });
    await waitFor(() => expect(worldSaveGet).toHaveBeenCalledOnce());
    send({ t: "save", profile });
    await waitFor(() => expect(worldSavePut).toHaveBeenCalledTimes(2));
    expect(vi.mocked(worldSavePut).mock.calls[1]?.[1]).not.toHaveProperty("name");
    await waitFor(() =>
      expect(sent("note").map((m) => m.text)).toContain(
        "That name can't be used online: That name is taken.",
      ),
    );
  });

  it("deletes the online save from the cloud key, then turns it off", async () => {
    agreeOnline();
    // an existing row: no immediate first save
    vi.mocked(worldSaveGet).mockResolvedValue(saved(1));
    const { send, sent } = open();
    send({ t: "ready" });
    await waitFor(() => expect(worldSaveGet).toHaveBeenCalledOnce());
    send({ t: "cloud-menu", rect: { x: 900, y: 700, w: 40, h: 40 } }); // the game's cloud button
    fireEvent.click(screen.getByRole("button", { name: "Delete my online save" }));
    expect(worldSaveDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete it" }));
    await waitFor(() => expect(worldSaveDelete).toHaveBeenCalledOnce());
    await waitFor(() => expect(sent("note").map((m) => m.text)).toContain("Online save deleted"));
    expect(JSON.parse(localStorage.getItem(WORLD_CONSENT_KEY) ?? "")).toEqual({ v: 1, on: false });
    send({ t: "save", profile });
    expect(worldSavePut).not.toHaveBeenCalled();
  });
});

describe("World online save when the server can't be reached", () => {
  it("retries a dropped read by itself before saying so, then loads the save", async () => {
    agreeOnline();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(worldSaveGet)
        .mockResolvedValueOnce({ status: 0, body: null })
        .mockResolvedValueOnce(saved(3, "Ken"));
      const { send, sent } = open();
      send({ t: "ready" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      await waitFor(() => expect(sent("profile")).toHaveLength(1));
      expect(worldSaveGet).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps trying while World is open, and Try again now works", async () => {
    agreeOnline();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(worldSaveGet).mockResolvedValue({ status: 0, body: null });
      const { send, sent } = open();
      send({ t: "ready" });
      // 3 tries (first + 2 retries), then it shows as failing
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(worldSaveGet).toHaveBeenCalledTimes(3);
      send({ t: "cloud-menu", rect: { x: 900, y: 700, w: 40, h: 40 } }); // the game's cloud button
      expect(screen.getByText("Can't reach the server right now. Trying again")).toBeTruthy();
      // back online: "Try again now" loads it
      vi.mocked(worldSaveGet).mockResolvedValue(saved(2, "Ken"));
      fireEvent.click(screen.getByRole("button", { name: "Try again now" }));
      await waitFor(() => expect(sent("profile")).toHaveLength(1));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("World XP pop-ups", () => {
  it("posts xp only when total xp goes up after the baseline, with why", () => {
    localStorage.setItem(WORLD_CONSENT_KEY, JSON.stringify({ v: 1, on: false }));
    const { view, send, sent } = open(player(100));
    send({ t: "ready" });
    expect(sent("xp")).toHaveLength(0);
    view.rerender(<WorldScreen onClose={vi.fn()} player={player(130)} />);
    expect(sent("xp")).toEqual([{ gg: "world", t: "xp", amount: 30, why: "prompt" }]);
    view.rerender(<WorldScreen onClose={vi.fn()} player={player(130)} />);
    view.rerender(
      <WorldScreen
        onClose={vi.fn()}
        player={player(120, { prompts: 120, commits: 0, streakBonus: 0 })}
      />,
    );
    expect(sent("xp")).toHaveLength(1);
    view.rerender(
      <WorldScreen
        onClose={vi.fn()}
        player={player(150, { prompts: 120, commits: 30, streakBonus: 0 })}
      />,
    );
    expect(sent("xp")[1]).toEqual({ gg: "world", t: "xp", amount: 30, why: "commit" });
  });

  it("saves right after agreeing when there's no online save yet (the live world needs the row)", async () => {
    agreeOnline();
    const { send } = open();
    send({ t: "ready" });
    await waitFor(() => expect(worldSavePut).toHaveBeenCalledOnce());
    expect(vi.mocked(worldSavePut).mock.calls[0]?.[1]).toMatchObject({ level: 3 });
  });
});

describe("World account and live consent", () => {
  it("deletes the account after a confirm step, then turns online save off", async () => {
    agreeOnline();
    vi.mocked(worldSaveGet).mockResolvedValue(saved(1));
    const { send, sent } = open();
    send({ t: "ready" });
    await waitFor(() => expect(worldSaveGet).toHaveBeenCalledOnce());
    send({ t: "cloud-menu", rect: { x: 900, y: 700, w: 40, h: 40 } }); // the game's cloud button
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect(worldAccountDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete my account" }));
    await waitFor(() => expect(worldAccountDelete).toHaveBeenCalledOnce());
    await waitFor(() => expect(sent("note").map((m) => m.text)).toContain("Account deleted"));
    expect(JSON.parse(localStorage.getItem(WORLD_CONSENT_KEY) ?? "")).toEqual({ v: 1, on: false });
  });

  it("stores the live tick with the first consent and only then opens the live world", async () => {
    vi.mocked(worldSaveGet).mockResolvedValue(saved(2));
    const { send } = open();
    send({ t: "ready" });
    fireEvent.click(await screen.findByLabelText("I'm 18 or over"));
    fireEvent.click(
      screen.getByLabelText("Join the live world: meet real players and chat in public"),
    );
    expect(screen.getByRole("link", { name: "Community rules" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save online" }));
    expect(JSON.parse(localStorage.getItem(WORLD_LIVE_CONSENT_KEY) ?? "")).toEqual({
      v: 1,
      on: true,
    });
    await waitFor(() => expect(worldLive).toHaveBeenCalled());
  });

  it("without the live tick, online save works but the live world stays closed", async () => {
    agreeOnline();
    vi.mocked(worldSaveGet).mockResolvedValue(saved(2));
    const { send } = open();
    send({ t: "ready" });
    await waitFor(() => expect(worldSaveGet).toHaveBeenCalledOnce());
    await act(async () => {});
    expect(worldLive).not.toHaveBeenCalled();
  });

  it("asks existing online-save players once for the live tick", async () => {
    localStorage.setItem(WORLD_CONSENT_KEY, JSON.stringify({ v: 1, on: true }));
    vi.mocked(worldSaveGet).mockResolvedValue(saved(2));
    const { send } = open();
    send({ t: "ready" });
    await screen.findByRole("dialog", { name: "Join the live world?" });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(JSON.parse(localStorage.getItem(WORLD_LIVE_CONSENT_KEY) ?? "")).toEqual({
      v: 1,
      on: false,
    });
    cleanup();
    open().send({ t: "ready" });
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("World online-save menu (opened from the game's cloud button)", () => {
  it("opens above the button, tells the game the save state, and closes on Escape or a second press", async () => {
    agreeOnline();
    vi.mocked(worldSaveGet).mockResolvedValue(saved(1));
    const { send, sent } = open();
    send({ t: "ready" });
    await waitFor(() => expect(worldSaveGet).toHaveBeenCalledOnce());
    // the game's cloud icon is kept in step with the save
    await waitFor(() => expect(sent("cloud").slice(-1)[0]).toMatchObject({ on: true }));

    expect(screen.queryByRole("group", { name: "Online save" })).toBeNull();
    send({ t: "cloud-menu", rect: { x: 900, y: 700, w: 40, h: 40 } });
    const menu = screen.getByRole("group", { name: "Online save" });
    expect(menu.style.right).toBe(`${window.innerWidth - 940}px`);
    expect(menu.style.bottom).toBe(`${window.innerHeight - 700 + 8}px`);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Online save" })).toBeNull();
    send({ t: "cloud-menu", rect: { x: 900, y: 700, w: 40, h: 40 } });
    expect(screen.getByRole("group", { name: "Online save" })).toBeTruthy();
    send({ t: "cloud-menu", rect: { x: 900, y: 700, w: 40, h: 40 } });
    expect(screen.queryByRole("group", { name: "Online save" })).toBeNull();
    // no header cloud button any more
    expect(screen.queryByRole("button", { name: "Online save" })).toBeNull();
  });
});
