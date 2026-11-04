import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock } from "./file-lock.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-file-lock-"));
});

afterEach(async () => {
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
});
