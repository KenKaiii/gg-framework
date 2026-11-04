import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getKeepAwake, holdAwake, setKeepAwake } from "./keepAwake";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const calls = (cmd: string): unknown[][] => invokeMock.mock.calls.filter((c) => c[0] === cmd);

describe("holdAwake", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("acquires with a valid unique hold id", async () => {
    holdAwake();
    holdAwake();
    await flush();
    const acq = calls("keep_awake_acquire");
    expect(acq).toHaveLength(2);
    const ids = acq.map((c) => (c[1] as { hold: string }).hold);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("double release releases once with the same id", async () => {
    const h = holdAwake();
    await flush();
    h.release();
    h.release();
    await flush();
    const rel = calls("keep_awake_release");
    expect(rel).toHaveLength(1);
    expect(rel[0]?.[1]).toEqual(calls("keep_awake_acquire")[0]?.[1]);
  });

  it("release before acquire resolves still ends released, after acquire", async () => {
    let resolveAcquire: () => void = () => undefined;
    invokeMock.mockImplementation((cmd) =>
      cmd === "keep_awake_acquire"
        ? new Promise<void>((r) => {
            resolveAcquire = r;
          })
        : Promise.resolve(undefined),
    );
    const h = holdAwake();
    h.release();
    h.release();
    await flush();
    expect(calls("keep_awake_release")).toHaveLength(0);
    resolveAcquire();
    await flush();
    expect(calls("keep_awake_release")).toHaveLength(1);
    expect(invokeMock.mock.calls.map((c) => c[0])).toEqual([
      "keep_awake_acquire",
      "keep_awake_release",
    ]);
  });

  it("acquire and release failures warn and never throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    invokeMock.mockRejectedValue(new Error("nope"));
    const h = holdAwake();
    expect(() => h.release()).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
  });
});

describe("agent keep-awake setting", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("reads and writes the sidecar setting", async () => {
    invokeMock.mockResolvedValueOnce({ enabled: true });
    await expect(getKeepAwake()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenLastCalledWith("agent_keep_awake_get");
    invokeMock.mockResolvedValueOnce({ enabled: false });
    await expect(setKeepAwake(false)).resolves.toBe(false);
    expect(invokeMock).toHaveBeenLastCalledWith("agent_keep_awake_set", { enabled: false });
  });

  it("surfaces a sidecar error body instead of a value", async () => {
    invokeMock.mockResolvedValueOnce({ error: "enabled must be a boolean" });
    await expect(setKeepAwake(true)).rejects.toThrow("enabled must be a boolean");
    invokeMock.mockResolvedValueOnce({});
    await expect(getKeepAwake()).rejects.toThrow("keep-awake request failed");
  });
});
