import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const child = {
    pid: 987_654_321,
    exitCode: null,
    killed: false,
    once: vi.fn(),
    unref: vi.fn(),
    kill: vi.fn(),
  };
  return {
    child,
    spawn: vi.fn(() => child),
    existsSync: vi.fn((candidate: unknown) => String(candidate).endsWith("/mpv")),
  };
});

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));

import { RADIO_STATIONS, getRadioVolume, playRadio, setRadioVolume, stopRadio } from "./radio.js";

afterEach(() => {
  stopRadio();
  setRadioVolume(70);
  vi.clearAllMocks();
});

describe("radio", () => {
  it("includes the verified SomaFM reggae stream", () => {
    expect(RADIO_STATIONS).toContainEqual(
      expect.objectContaining({
        id: "somafm-heavyweight-reggae",
        url: "https://ice5.somafm.com/reggae-128-mp3",
      }),
    );
  });

  it("keeps the player in the sidecar process group for reliable app-exit cleanup", () => {
    expect(playRadio("somafm-heavyweight-reggae")).toEqual({ ok: true });
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.stringMatching(/mpv$/),
      expect.arrayContaining(["--volume=70", "https://ice5.somafm.com/reggae-128-mp3"]),
      expect.objectContaining({ detached: false, stdio: "ignore" }),
    );
  });

  it("clamps app-wide volume to whole percentages", () => {
    expect(setRadioVolume(-1).ok).toBe(true);
    expect(getRadioVolume()).toBe(0);
    setRadioVolume(55.6);
    expect(getRadioVolume()).toBe(56);
    setRadioVolume(101);
    expect(getRadioVolume()).toBe(100);
  });
});
