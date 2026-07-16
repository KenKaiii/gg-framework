import { describe, expect, it } from "vitest";
import {
  getResetClearMode,
  type RenderAppConfig,
  type RuntimeState,
  type SessionStore,
} from "./render.js";
import type { SubAgentManager } from "../core/subagent-manager.js";

describe("getResetClearMode", () => {
  it("uses a full screen redraw for terminal resize remounts", () => {
    expect(getResetClearMode({ resizeRedraw: true })).toBe("screen");
  });

  it("keeps ordinary overlay remounts to a viewport clear", () => {
    expect(getResetClearMode(undefined)).toBe("viewport");
    expect(getResetClearMode({})).toBe("viewport");
  });

  it("uses a full screen redraw for explicit session/history replacement", () => {
    expect(getResetClearMode({ wipeSession: true })).toBe("screen");
    expect(getResetClearMode({ history: [{ kind: "banner", id: "banner" }] })).toBe("screen");
  });

  it("keeps session state focused on resumable conversation data", () => {
    const store = {
      messages: [],
      history: [],
      planSteps: [],
    } satisfies SessionStore;

    expect(store).toEqual({ messages: [], history: [], planSteps: [] });
    expect("sessionTitle" in store).toBe(false);
  });
});

describe("RenderAppConfig async orchestration plumbing", () => {
  it("carries the shared manager and reports model/provider/thinking changes", () => {
    const manager = {} as SubAgentManager;
    const updates: Array<Partial<RuntimeState>> = [];
    const config = {
      subAgentManager: manager,
      onRuntimeStateChange: (update: Partial<RuntimeState>) => updates.push(update),
    } satisfies Partial<RenderAppConfig>;

    config.onRuntimeStateChange({
      provider: "openai",
      model: "gpt-5.6-sol",
      thinking: "ultra",
    });

    expect(config.subAgentManager).toBe(manager);
    expect(updates).toEqual([{ provider: "openai", model: "gpt-5.6-sol", thinking: "ultra" }]);
  });
});
