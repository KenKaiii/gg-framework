import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { captureVerificationSnapshot } from "./verification-snapshot.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-source-snapshot-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await fs.writeFile(path.join(root, ".gitignore"), "dist/\nignored.ts\n");
  await fs.writeFile(path.join(root, "source.ts"), "const value = 1;\n");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("verification workspace snapshot", () => {
  it("ignores generated output but catches same-size source changes", async () => {
    const before = await captureVerificationSnapshot(root);
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "dist/app.js"), "generated");
    expect(await captureVerificationSnapshot(root)).toBe(before);
    await fs.writeFile(path.join(root, "source.ts"), "const value = 2;\n");
    expect(await captureVerificationSnapshot(root)).not.toBe(before);
  });

  it("detects new files, deleted tracked files, and tracked generated files", async () => {
    execFileSync("git", ["add", "source.ts"], { cwd: root });
    const before = await captureVerificationSnapshot(root);
    await fs.writeFile(path.join(root, "new.ts"), "new");
    expect(await captureVerificationSnapshot(root)).not.toBe(before);
    await fs.unlink(path.join(root, "new.ts"));
    expect(await captureVerificationSnapshot(root)).toBe(before);
    await fs.unlink(path.join(root, "source.ts"));
    expect(await captureVerificationSnapshot(root)).not.toBe(before);
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "dist/tracked.js"), "old");
    execFileSync("git", ["add", "-f", "dist/tracked.js"], { cwd: root });
    const tracked = await captureVerificationSnapshot(root);
    await fs.writeFile(path.join(root, "dist/tracked.js"), "new");
    expect(await captureVerificationSnapshot(root)).not.toBe(tracked);
  });

  it("includes explicitly edited inputs even when Git ignores them", async () => {
    await fs.writeFile(path.join(root, "ignored.ts"), "old");
    const before = await captureVerificationSnapshot(root, ["ignored.ts"]);
    await fs.writeFile(path.join(root, "ignored.ts"), "new");
    expect(await captureVerificationSnapshot(root, ["ignored.ts"])).not.toBe(before);
    expect(await captureVerificationSnapshot(root, ["../outside.ts"])).toBeNull();
  });

  it("declines oversized inputs without reading their full contents", async () => {
    const handle = await fs.open(path.join(root, "large.bin"), "w");
    await handle.truncate(129 * 1024 * 1024);
    await handle.close();
    expect(await captureVerificationSnapshot(root)).toBeNull();
  });

  it("declines non-Git workspaces and directory links instead of following them", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gg-snapshot-outside-"));
    try {
      expect(await captureVerificationSnapshot(outside)).toBeNull();
      await fs.writeFile(path.join(outside, "source.ts"), "outside");
      await fs.symlink(
        outside,
        path.join(root, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(await captureVerificationSnapshot(root, ["linked/source.ts"])).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
