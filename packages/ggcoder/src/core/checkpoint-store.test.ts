import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CheckpointStore } from "./checkpoint-store.js";

let cwd: string;
let baseDir: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ggcoder-cp-cwd-"));
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "ggcoder-cp-store-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
  await fs.rm(baseDir, { recursive: true, force: true });
});

function store(maxCheckpoints?: number): CheckpointStore {
  return new CheckpointStore({ sessionId: "sess-1", cwd, baseDir, maxCheckpoints });
}

describe("CheckpointStore", () => {
  it("records pre-mutation content and restores original bytes after an edit", async () => {
    const file = path.join(cwd, "a.txt");
    await fs.writeFile(file, "original");

    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 5 });
    await s.recordPreMutation(file);

    // Simulate an agent edit.
    await fs.writeFile(file, "mutated");
    expect(await fs.readFile(file, "utf-8")).toBe("mutated");

    const result = await s.restore("cp-0001", "code");
    expect(result.filesRestored).toBe(1);
    expect(result.messageIndex).toBe(5);
    expect(await fs.readFile(file, "utf-8")).toBe("original");
  });

  it("deletes files that were absent at the checkpoint when restoring code", async () => {
    const file = path.join(cwd, "new.txt");
    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 2 });
    // File does not exist yet at snapshot time.
    await s.recordPreMutation(file);

    // Agent creates the file.
    await fs.writeFile(file, "created by agent");

    await s.restore("cp-0001", "code");
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("dedupes identical content into a single blob", async () => {
    const a = path.join(cwd, "a.txt");
    const b = path.join(cwd, "b.txt");
    await fs.writeFile(a, "same bytes");
    await fs.writeFile(b, "same bytes");

    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 0 });
    await s.recordPreMutation(a);
    await s.recordPreMutation(b);

    const blobs = await fs.readdir(path.join(baseDir, "sess-1", "blobs"));
    expect(blobs).toHaveLength(1);
  });

  it("first-write-wins: a file mutated twice in one turn restores to pre-turn state", async () => {
    const file = path.join(cwd, "a.txt");
    await fs.writeFile(file, "v0");

    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 0 });
    await s.recordPreMutation(file);
    await fs.writeFile(file, "v1");
    // Second mutation in the same turn — should NOT overwrite the v0 snapshot.
    await s.recordPreMutation(file);
    await fs.writeFile(file, "v2");

    await s.restore("cp-0001", "code");
    expect(await fs.readFile(file, "utf-8")).toBe("v0");
  });

  it("lists checkpoints in turn order with correct changed-file counts", async () => {
    const a = path.join(cwd, "a.txt");
    const b = path.join(cwd, "b.txt");
    await fs.writeFile(a, "a");
    await fs.writeFile(b, "b");

    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 1 });
    await s.recordPreMutation(a);
    await s.openCheckpoint({ turnIndex: 2, messageIndex: 3 });
    await s.recordPreMutation(a);
    await s.recordPreMutation(b);

    const list = await s.listCheckpoints();
    expect(list.map((c) => c.turnIndex)).toEqual([1, 2]);
    expect(list[0].changedFileCount).toBe(1);
    expect(list[1].changedFileCount).toBe(2);
    expect(list[1].summary).toContain("a.txt");
    expect(list[1].summary).toContain("b.txt");
  });

  it("conversation restore reports the message index without touching files", async () => {
    const file = path.join(cwd, "a.txt");
    await fs.writeFile(file, "original");
    const s = store();
    await s.openCheckpoint({ turnIndex: 1, messageIndex: 9 });
    await s.recordPreMutation(file);
    await fs.writeFile(file, "mutated");

    const result = await s.restore("cp-0001", "conversation");
    expect(result.messageIndex).toBe(9);
    expect(result.filesRestored).toBe(0);
    // File left untouched in conversation-only mode.
    expect(await fs.readFile(file, "utf-8")).toBe("mutated");
  });

  it("prunes old checkpoints beyond the retention cap", async () => {
    const s = store(3);
    for (let turn = 1; turn <= 6; turn++) {
      await s.openCheckpoint({ turnIndex: turn, messageIndex: turn });
    }
    const list = await s.listCheckpoints();
    expect(list).toHaveLength(3);
    expect(list.map((c) => c.turnIndex)).toEqual([4, 5, 6]);
  });
});
