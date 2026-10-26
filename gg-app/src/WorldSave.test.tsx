// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { worldSaveDelete, worldSaveGet, worldSavePut } from "./agent";
import { WORLD_CONSENT_KEY } from "./world-save";
import { WorldScreen, type WorldPlayer } from "./WorldScreen";

vi.mock("./agent", () => ({
  openUrl: vi.fn(),
  worldSaveGet: vi.fn(),
  worldSavePut: vi.fn(),
  worldSaveDelete: vi.fn(),
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
          origin: window.location.origin,
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
    const { send, sent } = open();
    send({ t: "ready" });
    await waitFor(() => expect(worldSaveGet).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Online save" }));
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
});
