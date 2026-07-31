import { describe, expect, it, vi } from "vitest";
import { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";

describe("AppSidecarProjectAutopilotState", () => {
  it("converges two same-project sessions and execution policy across enable and disable", async () => {
    const state = new AppSidecarProjectAutopilotState();
    const load = vi.fn(async () => false);
    const firstSessionEvents: boolean[] = [];
    const secondSessionEvents: boolean[] = [];

    await expect(state.initialize("C:\\Work\\Project", load)).resolves.toBe(false);
    await expect(state.initialize("c:/work/./project", load)).resolves.toBe(false);
    state.subscribe("C:\\WORK\\PROJECT", (enabled) => firstSessionEvents.push(enabled));
    state.subscribe("c:/work/project", (enabled) => secondSessionEvents.push(enabled));

    state.set("c:/WORK/project", true);
    expect(state.isEnabled("C:\\work\\project")).toBe(true);
    expect(firstSessionEvents).toEqual([true]);
    expect(secondSessionEvents).toEqual([true]);

    state.set("C:\\Work\\Project", false);
    expect(state.isEnabled("c:/work/project")).toBe(false);
    expect(firstSessionEvents).toEqual([true, false]);
    expect(secondSessionEvents).toEqual([true, false]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps different projects isolated", async () => {
    const state = new AppSidecarProjectAutopilotState();
    const otherProjectEvents: boolean[] = [];

    await state.initialize("/work/one", async () => false);
    await state.initialize("/work/two", async () => true);
    state.subscribe("/work/two", (enabled) => otherProjectEvents.push(enabled));

    state.set("/work/one", true);

    expect(state.isEnabled("/work/one")).toBe(true);
    expect(state.isEnabled("/work/two")).toBe(true);
    expect(otherProjectEvents).toEqual([]);
  });

  it("does not let a stale initialization overwrite a newer toggle", async () => {
    const state = new AppSidecarProjectAutopilotState();
    let finishLoad!: (enabled: boolean) => void;
    const loading = state.initialize(
      "/work/project",
      () =>
        new Promise<boolean>((resolve) => {
          finishLoad = resolve;
        }),
    );

    state.set("/work/project", true);
    finishLoad(false);

    await expect(loading).resolves.toBe(true);
    expect(state.isEnabled("/work/project")).toBe(true);
  });
});
