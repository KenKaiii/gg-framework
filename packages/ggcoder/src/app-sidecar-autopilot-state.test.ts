import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";

describe("AppSidecarProjectAutopilotState", () => {
  it("converges two same-project sessions and execution policy across enable and disable", async () => {
    const state = new AppSidecarProjectAutopilotState();
    const load = vi.fn(async () => false);
    const firstSessionEvents: boolean[] = [];
    const secondSessionEvents: boolean[] = [];
    const projectPath = path.resolve("work", "project");
    const equivalentProjectPath = `${projectPath}${path.sep}..${path.sep}${path.basename(projectPath)}`;

    await expect(state.initialize(projectPath, load)).resolves.toBe(false);
    await expect(state.initialize(equivalentProjectPath, load)).resolves.toBe(false);
    state.subscribe(projectPath, (enabled) => firstSessionEvents.push(enabled));
    state.subscribe(equivalentProjectPath, (enabled) => secondSessionEvents.push(enabled));

    state.set(equivalentProjectPath, true);
    expect(state.isEnabled(projectPath)).toBe(true);
    expect(firstSessionEvents).toEqual([true]);
    expect(secondSessionEvents).toEqual([true]);

    state.set(projectPath, false);
    expect(state.isEnabled(equivalentProjectPath)).toBe(false);
    expect(firstSessionEvents).toEqual([true, false]);
    expect(secondSessionEvents).toEqual([true, false]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  if (process.platform === "win32") {
    it("normalizes Windows drive, separator, and case variants", async () => {
      const state = new AppSidecarProjectAutopilotState();
      const load = vi.fn(async () => false);

      await state.initialize("C:\\Work\\Project", load);
      await state.initialize("c:/work/./project", load);
      state.set("c:/WORK/project", true);

      expect(state.isEnabled("C:\\work\\project")).toBe(true);
      expect(load).toHaveBeenCalledTimes(1);
    });
  } else {
    it("keeps case-distinct Unix projects isolated", async () => {
      const state = new AppSidecarProjectAutopilotState();

      await state.initialize("/Work/Project", async () => false);
      await state.initialize("/work/project", async () => false);
      state.set("/Work/Project", true);

      expect(state.isEnabled("/Work/Project")).toBe(true);
      expect(state.isEnabled("/work/project")).toBe(false);
    });
  }

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
