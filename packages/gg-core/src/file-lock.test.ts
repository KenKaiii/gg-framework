import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "./file-lock.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-file-lock-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
  it("waits for a lock its holder has created but not written yet", async () => {
    const target = path.join(dir, "data.json");
    // A holder's lock between `wx` create and its JSON landing reads as empty.
    await fs.writeFile(`${target}.lock`, "");
    let ran = false;
    const pending = withFileLock(target, async () => {
      ran = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(ran).toBe(false);
    await fs.unlink(`${target}.lock`);
    await pending;
    expect(ran).toBe(true);
  });

  it("runs every caller one at a time", async () => {
    const target = path.join(dir, "data.json");
    let inside = 0;
    let overlapped = false;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        withFileLock(target, async () => {
          inside++;
          if (inside > 1) overlapped = true;
          await new Promise((r) => setTimeout(r, 5));
          inside--;
        }),
      ),
    );
    expect(overlapped).toBe(false);
  });

  it("waits out a Windows pending-delete EPERM on the lock file", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const target = path.join(dir, "data.json");
    const lockPath = `${target}.lock`;
    await fs.writeFile(lockPath, "");
    const realWriteFile = fs.writeFile.bind(fs);
    let refusals = 0;
    vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      if (file === lockPath && refusals < 2) {
        refusals++;
        // The released lock disappears once its pending delete finishes.
        if (refusals === 2) await fs.unlink(lockPath);
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }
      return realWriteFile(file, data, options);
    });
    let ran = false;
    await withFileLock(target, async () => {
      ran = true;
    });
    expect(refusals).toBe(2);
    expect(ran).toBe(true);
  });

  it("still fails on a persistent EPERM with no lock file present", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const target = path.join(dir, "data.json");
    vi.spyOn(fs, "writeFile").mockRejectedValue(
      Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
    );
    await expect(withFileLock(target, async () => {})).rejects.toMatchObject({ code: "EPERM" });
  });

  it("fails at once on EACCES outside Windows, where it is a real permission error", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const target = path.join(dir, "data.json");
    const writeFile = vi
      .spyOn(fs, "writeFile")
      .mockRejectedValue(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    await expect(withFileLock(target, async () => {})).rejects.toMatchObject({ code: "EACCES" });
    expect(writeFile).toHaveBeenCalledOnce();
  });
});
