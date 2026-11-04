import { describe, expect, it, vi } from "vitest";

import {
  killProcessTree,
  listDescendantPids,
  resolveWindowsTaskkillPath,
  signalDescendants,
} from "./process.js";

describe("resolveWindowsTaskkillPath", () => {
  it("resolves taskkill from SystemRoot", () => {
    expect(resolveWindowsTaskkillPath({ SystemRoot: "C:\\Windows" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
  });

  it("is case-insensitive about the env var name and falls back to WINDIR", () => {
    expect(resolveWindowsTaskkillPath({ systemroot: "D:/Win" })).toBe(
      "D:\\Win\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({ WINDIR: "E:\\W" })).toBe("E:\\W\\System32\\taskkill.exe");
  });

  it("rejects relative or injected roots and falls back to C:\\Windows", () => {
    expect(resolveWindowsTaskkillPath({ SystemRoot: "windows" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({ SystemRoot: "C:\\Win;C:\\evil" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({})).toBe("C:\\Windows\\System32\\taskkill.exe");
  });
});

describe("killProcessTree", () => {
  it("kills the whole tree with taskkill on Windows (never a negative pid)", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    const kill = vi.fn();

    killProcessTree(4242, {
      platform: "win32",
      kill,
      spawnSync: spawnSync as never,
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(spawnSync).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to the direct pid when taskkill fails", () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 1 });
    const kill = vi.fn();

    killProcessTree(7, { platform: "win32", kill, spawnSync: spawnSync as never, env: {} });

    expect(kill).toHaveBeenCalledWith(7, "SIGKILL");
  });

  it("signals the process group on POSIX", () => {
    const kill = vi.fn();
    killProcessTree(99, { platform: "darwin", kill });
    expect(kill).toHaveBeenCalledWith(-99, "SIGKILL");
  });
});

describe("listDescendantPids / signalDescendants", () => {
  // 1 ─ 10 ─ 11 ─ 12, 10 ─ 13; 20 is unrelated; 30 is its own parent.
  const table: Array<[number, number]> = [
    [10, 1],
    [11, 10],
    [12, 11],
    [13, 10],
    [20, 1],
    [30, 30],
  ];
  const readTable = () => table;

  it("returns every descendant but never the root or unrelated processes", () => {
    expect(listDescendantPids(10, { platform: "darwin", readTable }).sort()).toEqual([11, 12, 13]);
    expect(listDescendantPids(12, { platform: "linux", readTable })).toEqual([]);
    expect(listDescendantPids(30, { platform: "linux", readTable })).toEqual([]);
  });

  it("is a no-op on Windows", () => {
    expect(listDescendantPids(10, { platform: "win32", readTable })).toEqual([]);
  });

  it("signals the descendants and spares the root", () => {
    const kill = vi.fn();
    expect(signalDescendants(10, "SIGTERM", { platform: "darwin", readTable, kill })).toBe(3);
    expect(kill).not.toHaveBeenCalledWith(10, expect.anything());
    expect(kill).toHaveBeenCalledWith(12, "SIGTERM");
  });

  it.skipIf(process.platform === "win32")("finds a real child of this process", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn("sleep", ["5"]);
    try {
      expect(listDescendantPids(process.pid)).toContain(child.pid);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
