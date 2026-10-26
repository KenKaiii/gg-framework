// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getRadioState = vi.fn();
const setRadio = vi.fn();
const setRadioVolume = vi.fn();
vi.mock("./agent", () => ({
  getRadioState: () => getRadioState() as unknown,
  setRadio: (s: string) => setRadio(s) as unknown,
  setRadioVolume: (v: number) => setRadioVolume(v) as unknown,
}));

import { useWorldRadio } from "./world-radio";

const STATE = {
  stations: [
    { id: "groove", name: "Groove Salad", description: "chill", url: "https://stream.example/x" },
  ],
  current: null,
  volume: 70,
};

describe("World jukebox -> app radio", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getRadioState.mockReset().mockResolvedValue(STATE);
    setRadio.mockReset().mockResolvedValue("groove");
    setRadioVolume.mockReset().mockResolvedValue(40);
  });

  it("answers radio-get with the stations (no stream urls) and the current state", async () => {
    const post = vi.fn();
    const { result } = renderHook(() => useWorldRadio(post));
    expect(result.current.onGameMessage({ t: "radio-get" })).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(post).toHaveBeenCalledWith({
      t: "radio",
      stations: [{ id: "groove", name: "Groove Salad", description: "chill" }],
      current: null,
      volume: 70,
    });
  });

  it("plays / stops through the app radio and saves the last volume once", async () => {
    const post = vi.fn();
    const { result } = renderHook(() => useWorldRadio(post));
    result.current.onGameMessage({ t: "radio-set", station: "groove" });
    expect(setRadio).toHaveBeenCalledWith("groove");
    result.current.onGameMessage({ t: "radio-volume", volume: 30 });
    result.current.onGameMessage({ t: "radio-volume", volume: 140 });
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(setRadioVolume).toHaveBeenCalledTimes(1);
    expect(setRadioVolume).toHaveBeenCalledWith(100);
  });

  it("ignores anything else", () => {
    const { result } = renderHook(() => useWorldRadio(vi.fn()));
    expect(result.current.onGameMessage({ t: "save" })).toBe(false);
    expect(result.current.onGameMessage({ t: "radio-set", station: 5 })).toBe(false);
  });
});
