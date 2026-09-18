// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockWindows } from "@tauri-apps/api/mocks";
import type * as TauriCore from "@tauri-apps/api/core";

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  invoke: invokeMock,
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
import { PROJECT_COLOUR_NAMES } from "./projectAccent";

// The real native bridge resolves this webview's label during module loading.
mockWindows("main");
const { createProjectColourStore, projectColourKey } = await import("./project-colours");

beforeEach(() => {
  mockWindows("main");
  vi.restoreAllMocks();
  invokeMock.mockReset();
  listenMock.mockReset();
  localStorage.clear();
});

afterEach(() => clearMocks());

describe("personal project colours in the browser", () => {
  it("normalizes full identities but keeps same-named projects independent", () => {
    expect(projectColourKey("/a/project/../project/.")).toBe("/a/project");
    expect(projectColourKey("/a/project")).not.toBe(projectColourKey("/b/project"));
    expect(projectColourKey("C:\\Work\\Project\\")).toBe("c:/work/project");
    expect(projectColourKey("C:\\")).toBe("c:/");
    expect(projectColourKey("\\\\?\\C:\\Work\\Project")).toBe("c:/work/project");
    expect(projectColourKey("\\\\?\\UNC\\Server\\Share\\Project")).toBe("//server/share/project");
    expect(projectColourKey("/work/Project")).not.toBe(projectColourKey("/work/project"));
    for (const cwd of [null, undefined, "", "/", "relative/path", "bad\0path"])
      expect(projectColourKey(cwd)).toBeNull();
  });

  it("loads every colour across restarts, resets Automatic, and persists None and stripe", async () => {
    const store = createProjectColourStore(false);
    expect(store.getSnapshot().stripe).toBe(false);
    await store.setChoice("C:\\", "Blue");
    expect(createProjectColourStore(false).getSnapshot().overrides["c:/"]).toBe("Blue");
    await store.setChoice("C:\\", "Automatic");
    for (const colour of PROJECT_COLOUR_NAMES) {
      await store.setChoice("/a/project", colour);
      expect(createProjectColourStore(false).getSnapshot().overrides["/a/project"]).toBe(colour);
    }
    await store.setChoice("/b/project", "Blue");
    await store.setChoice("/a/project", "None");
    await store.setStripe(true);
    const restarted = createProjectColourStore(false).getSnapshot();
    expect(restarted.overrides).toEqual({ "/a/project": "None", "/b/project": "Blue" });
    expect(restarted.stripe).toBe(true);
    await store.setChoice("/a/project", "Automatic");
    await store.setStripe(false);
    expect(createProjectColourStore(false).getSnapshot().overrides).toEqual({
      "/b/project": "Blue",
    });
    expect(createProjectColourStore(false).getSnapshot().stripe).toBe(false);
  });

  it("shares changes with a second window without losing another project's updates", async () => {
    const first = createProjectColourStore(false);
    const second = createProjectColourStore(false);
    const callback = vi.fn();
    const unsubscribe = second.subscribe(callback);
    await Promise.all([
      first.setChoice("/a/project", "Blue"),
      second.setChoice("/b/project", "Green"),
    ]);
    window.dispatchEvent(new StorageEvent("storage", { key: "gg-project-colour:/a/project" }));
    expect(second.getSnapshot().overrides).toEqual({ "/a/project": "Blue", "/b/project": "Green" });
    expect(callback).toHaveBeenCalled();
    unsubscribe();
    callback.mockClear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(callback).not.toHaveBeenCalled();
  });

  it("ignores malformed values and rejects folderless choices", async () => {
    localStorage.setItem("gg-project-colour:/a/project", "url(secret)");
    localStorage.setItem("gg-project-colour:/b/project", "Green");
    localStorage.setItem("gg-project-colour:relative", "Blue");
    localStorage.setItem("gg-project-colour-stripe", "yes");
    const store = createProjectColourStore(false);
    expect(store.getSnapshot().overrides).toEqual({ "/b/project": "Green" });
    expect(store.getSnapshot().stripe).toBe(false);
    await expect(store.setChoice("", "Blue")).rejects.toThrow();
    expect(localStorage.getItem("gg-project-colour:")).toBeNull();
  });

  it("handles unavailable storage and does not publish failed saves", async () => {
    const store = createProjectColourStore(false);
    await store.setChoice("/a/project", "Green");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await expect(store.setChoice("/a/project", "Blue")).rejects.toThrow("quota");
    await expect(store.setStripe(true)).rejects.toThrow("quota");
    expect(store.getSnapshot().overrides["/a/project"]).toBe("Green");
    expect(store.getSnapshot().stripe).toBe(false);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await expect(store.setChoice("/a/project", "Automatic")).rejects.toThrow("blocked");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const unavailable = createProjectColourStore(false).getSnapshot();
    expect(unavailable.overrides).toEqual({});
    expect(unavailable.error).toContain("Could not load");
  });
});

describe("native-window preference transport", () => {
  const initial = { overrides: {}, stripe: false, revision: 0, projectKey: null };

  it("listens before loading, receives updates in all stores, and rejects stale or invalid events", async () => {
    const callbacks = new Set<(event: { payload: unknown }) => void>();
    const off = vi.fn();
    listenMock.mockImplementation(
      async (_event: string, callback: (event: { payload: unknown }) => void) => {
        callbacks.add(callback);
        return () => {
          callbacks.delete(callback);
          off();
        };
      },
    );
    let saved = initial;
    invokeMock.mockImplementation(
      async (command: string, args: { cwd: string; choice: string }) => {
        if (command === "project_colours_get") return { ...saved, projectKey: args.cwd };
        saved = {
          ...saved,
          overrides: { ...saved.overrides, [args.cwd]: args.choice },
          revision: saved.revision + 1,
        };
        for (const callback of callbacks) callback({ payload: saved });
        return saved;
      },
    );
    const first = createProjectColourStore(true);
    const second = createProjectColourStore(true);
    const stopFirst = first.subscribe(vi.fn());
    const stopSecond = second.subscribe(vi.fn());
    expect(await first.resolveProject("/a/project")).toBe("/a/project");
    expect(listenMock.mock.invocationCallOrder[0]).toBeLessThan(
      invokeMock.mock.invocationCallOrder[0]!,
    );
    await first.setChoice("/a/project", "Blue");
    await second.setChoice("/b/project", "Green");
    expect(first.getSnapshot().overrides).toEqual({ "/a/project": "Blue", "/b/project": "Green" });
    expect(second.getSnapshot().overrides).toEqual(first.getSnapshot().overrides);
    for (const callback of callbacks) {
      callback({ payload: initial });
      callback({ payload: { ...initial, revision: 10, stripe: "yes" } });
      callback({
        payload: {
          ...saved,
          revision: 3,
          overrides: { "/a/project": "url(secret)", "/b/project": "Green" },
        },
      });
    }
    expect(first.getSnapshot().overrides).toEqual({ "/b/project": "Green" });
    expect(first.getSnapshot().stripe).toBe(false);
    stopFirst();
    stopSecond();
    expect(off).toHaveBeenCalledTimes(2);
    expect(callbacks.size).toBe(0);
  });

  it("uses the app-wide event and exact native reset and stripe command payloads", async () => {
    listenMock.mockResolvedValue(vi.fn());
    invokeMock.mockImplementation(
      async (command: string, args: { cwd: string | null; stripe?: boolean | null }) => ({
        ...initial,
        projectKey: command === "project_colours_get" ? args.cwd : null,
        stripe: args.stripe ?? false,
        revision: command === "project_colours_save" ? 1 : 0,
      }),
    );
    const store = createProjectColourStore(true);
    const stop = store.subscribe(vi.fn());
    expect(await store.resolveProject("/a/project")).toBe("/a/project");
    expect(listenMock).toHaveBeenCalledWith("project-colours-changed", expect.any(Function));
    expect(invokeMock).toHaveBeenLastCalledWith("project_colours_get", { cwd: "/a/project" });

    await store.setChoice("/a/project", "Automatic");
    expect(invokeMock).toHaveBeenLastCalledWith("project_colours_save", {
      cwd: "/a/project",
      choice: "Automatic",
      stripe: null,
    });
    await store.setStripe(true);
    expect(invokeMock).toHaveBeenLastCalledWith("project_colours_save", {
      cwd: null,
      choice: null,
      stripe: true,
    });
    expect(store.getSnapshot().stripe).toBe(true);
    await store.setStripe(false);
    expect(store.getSnapshot().stripe).toBe(false);
    stop();
  });

  it("keeps the last confirmed native choice when persistence fails", async () => {
    listenMock.mockResolvedValue(vi.fn());
    invokeMock.mockResolvedValue({ ...initial, overrides: { "/a/project": "Green" } });
    const store = createProjectColourStore(true);
    const stop = store.subscribe(vi.fn());
    await store.resolveProject("/a/project");
    invokeMock.mockRejectedValue(new Error("disk full"));
    await expect(store.setChoice("/a/project", "Blue")).rejects.toThrow("disk full");
    expect(store.getSnapshot().overrides["/a/project"]).toBe("Green");
    stop();
  });

  it("cleans up a listener that finishes attaching after the last subscriber leaves", async () => {
    let attach: (off: () => void) => void = () => {};
    listenMock.mockReturnValue(
      new Promise<() => void>((resolve) => {
        attach = resolve;
      }),
    );
    const store = createProjectColourStore(true);
    const stop = store.subscribe(vi.fn());
    stop();
    const off = vi.fn();
    attach(off);
    await Promise.resolve();
    expect(off).toHaveBeenCalledOnce();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
