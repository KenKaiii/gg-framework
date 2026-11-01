import { describe, it, expect } from "vitest";
import { resolveShell } from "./shell.js";

describe("resolveShell", () => {
  it("uses bash on macOS/Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const r = resolveShell("ls -la", { platform, env: {}, exists: () => false });
      expect(r).toEqual({
        file: "bash",
        args: ["-o", "pipefail", "-c", "ls -la"],
        isCmdFallback: false,
      });
    }
  });

  it("honors the GG_BASH override on any platform", () => {
    const r = resolveShell("echo hi", {
      platform: "win32",
      env: { GG_BASH: "C:\\msys64\\usr\\bin\\bash.exe" },
      // Even though Git Bash also 'exists', the override wins.
      exists: () => true,
    });
    expect(r).toEqual({
      file: "C:\\msys64\\usr\\bin\\bash.exe",
      args: ["-o", "pipefail", "-c", "echo hi"],
      isCmdFallback: false,
    });
  });

  it("prefers Git Bash at the standard Program Files location on Windows", () => {
    const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
    const r = resolveShell("grep -r foo .", {
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      exists: (p) => p === gitBash,
    });
    expect(r).toEqual({
      file: gitBash,
      args: ["-o", "pipefail", "-c", "grep -r foo ."],
      isCmdFallback: false,
    });
  });

  it("finds per-user Git Bash under LOCALAPPDATA", () => {
    const gitBash = "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    const r = resolveShell("pwd", {
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      exists: (p) => p === gitBash,
    });
    expect(r.file).toBe(gitBash);
    expect(r.isCmdFallback).toBe(false);
  });

  it("derives Git Bash from git.exe on PATH (<root>\\cmd\\git.exe)", () => {
    const gitExe = "C:\\Tools\\Git\\cmd\\git.exe";
    const bash = "C:\\Tools\\Git\\bin\\bash.exe";
    const r = resolveShell("node -v", {
      platform: "win32",
      env: { PATH: "C:\\Windows\\System32;C:\\Tools\\Git\\cmd" },
      exists: (p) => p === gitExe || p === bash,
    });
    expect(r.file).toBe(bash);
    expect(r.isCmdFallback).toBe(false);
  });

  it("NEVER selects WSL's System32 bash.exe (it isn't a Git Bash candidate)", () => {
    // Only System32\bash.exe 'exists' — the resolver must ignore it and fall
    // back to cmd.exe, because WSL runs in a separate Linux filesystem.
    const wslBash = "C:\\Windows\\System32\\bash.exe";
    const r = resolveShell("ls", {
      platform: "win32",
      env: {
        PATH: "C:\\Windows\\System32",
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      },
      exists: (p) => p === wslBash,
    });
    expect(r.file).not.toBe(wslBash);
    expect(r.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(r.isCmdFallback).toBe(true);
  });

  it("falls back to ComSpec cmd.exe on Windows when no Git Bash exists", () => {
    const r = resolveShell("dir", {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      exists: () => false,
    });
    expect(r).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "dir"],
      isCmdFallback: true,
    });
  });

  it("defaults the cmd.exe path when ComSpec is unset", () => {
    const r = resolveShell("dir", { platform: "win32", env: {}, exists: () => false });
    expect(r.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(r.isCmdFallback).toBe(true);
  });
});

describe("resolveShell bashPath setting", () => {
  const env = {};
  const all = () => true;
  it("auto / unset keeps PATH bash", () => {
    expect(resolveShell("x", { platform: "darwin", env, exists: all }).file).toBe("bash");
    expect(resolveShell("x", { platform: "darwin", env, exists: all, bashPath: "auto" }).file).toBe(
      "bash",
    );
  });
  it("system picks /bin/bash on macOS only", () => {
    expect(
      resolveShell("x", { platform: "darwin", env, exists: all, bashPath: "system" }).file,
    ).toBe("/bin/bash");
    expect(
      resolveShell("x", { platform: "linux", env, exists: all, bashPath: "system" }).file,
    ).toBe("bash");
  });
  it("explicit path is used when it exists, else falls back", () => {
    expect(
      resolveShell("x", { platform: "linux", env, exists: all, bashPath: "/opt/b/bash" }).file,
    ).toBe("/opt/b/bash");
    expect(
      resolveShell("x", { platform: "linux", env, exists: () => false, bashPath: "/opt/b/bash" })
        .file,
    ).toBe("bash");
  });
  it("Windows ignores it", () => {
    const r = resolveShell("x", {
      platform: "win32",
      env: {},
      exists: () => false,
      bashPath: "system",
    });
    expect(r.isCmdFallback).toBe(true);
  });
  it("GG_BASH still wins", () => {
    expect(
      resolveShell("x", { platform: "darwin", env: { GG_BASH: "/x" }, bashPath: "system" }).file,
    ).toBe("/x");
  });
});
