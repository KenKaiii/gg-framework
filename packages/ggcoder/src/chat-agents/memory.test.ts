import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "@kenkaiiii/gg-agent";
import {
  buildMemoryTools,
  MEMORY_HARD_LIMIT,
  MEMORY_SOFT_LIMIT,
  MEMORY_TEXT_LIMIT,
  MemoryStore,
} from "./memory.js";

let tempDir: string;
let filePath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-memory-test-"));
  filePath = path.join(tempDir, "nested", "chat-memories.json");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function context(): ToolContext {
  return { signal: new AbortController().signal, toolCallId: "test-call" };
}

describe("MemoryStore", () => {
  it("persists additions, updates, and explicit deletion across store instances", async () => {
    const first = new MemoryStore({ filePath });
    const added = await first.remember("Ken prefers concise answers.", "preference", 4);
    const id = added.memory!.id;

    const second = new MemoryStore({ filePath });
    expect(await second.list()).toEqual([expect.objectContaining({ id, importance: 4 })]);

    await second.update(id, "Ken prefers concise, scannable answers.", undefined, 5);
    expect((await first.list())[0]).toEqual(
      expect.objectContaining({
        id,
        text: "Ken prefers concise, scannable answers.",
        importance: 5,
      }),
    );

    expect((await first.forget(id)).deleted).toBe(true);
    expect(await second.list()).toEqual([]);
  });

  it("coerces recoverable fields and drops unusable rows", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 999,
        memories: [
          { id: "valid", text: "  Durable fact  ", category: "future", importance: 99 },
          { id: "empty", text: "   " },
          null,
        ],
      }),
    );

    expect(await new MemoryStore({ filePath }).list()).toEqual([
      expect.objectContaining({
        id: "valid",
        text: "Durable fact",
        category: "other",
        importance: 5,
      }),
    ]);
  });

  it("rejects near duplicates using token-set Jaccard similarity", async () => {
    const store = new MemoryStore({ filePath });
    const original = await store.remember("Ken likes short direct answers", "preference");
    const duplicate = await store.remember("Ken likes direct short answers", "preference");
    const articleVariant = await store.remember("The Ken likes short direct answers", "preference");

    expect(duplicate.duplicateOf?.id).toBe(original.memory?.id);
    expect(articleVariant.duplicateOf?.id).toBe(original.memory?.id);
    expect(await store.list()).toHaveLength(1);
  });

  it("keeps similarly worded facts about distinct entities", async () => {
    const store = new MemoryStore({ filePath });
    await store.remember(
      "Project Atlas serves enterprise users, prioritizes offline reliability, and launches in January.",
      "project",
    );
    const beacon = await store.remember(
      "Project Beacon serves enterprise users, prioritizes offline reliability, and launches in January.",
      "project",
    );

    expect(beacon.duplicateOf).toBeUndefined();
    expect(await store.list()).toHaveLength(2);
  });

  it("allows one row to absorb related facts during consolidation", async () => {
    const store = new MemoryStore({ filePath });
    const first = await store.remember("Atlas uses PostgreSQL.", "project");
    const second = await store.remember("Atlas launches in January.", "project");

    const updated = await store.update(
      first.memory!.id,
      "Atlas uses PostgreSQL and launches in January.",
      "project",
      3,
      [second.memory!.id],
    );

    expect(updated.duplicateOf).toBeUndefined();
    expect(updated.memory?.text).toContain("launches in January");
    expect(updated.forgotten).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("retains concurrent mutations from independent store instances", async () => {
    const first = new MemoryStore({ filePath });
    const second = new MemoryStore({ filePath });

    await Promise.all([
      first.remember("Ken is building project Alpha.", "project"),
      second.remember("Ken is building project Beta.", "project"),
    ]);

    expect((await first.list()).map((memory) => memory.text).sort()).toEqual([
      "Ken is building project Alpha.",
      "Ken is building project Beta.",
    ]);
  });

  it("groups prompt memories by category with IDs and a consolidation nudge", async () => {
    const store = new MemoryStore({ filePath });
    await store.remember("Ken is the user's name.", "identity", 5);
    await store.remember("Ken prefers TypeScript.", "preference", 4);

    let prompt = store.renderForPrompt();
    expect(prompt).toContain("## identity");
    expect(prompt).toContain("## preference");
    expect(prompt).toMatch(/\[[0-9a-f-]+\] \(importance 5\) Ken is the user's name\./);

    for (let index = 2; index < MEMORY_SOFT_LIMIT; index += 1) {
      await store.remember(`Distinct durable project fact number ${index}.`, "project", 2);
    }
    prompt = store.renderForPrompt();
    expect(prompt).toContain(`Memory has reached ${MEMORY_SOFT_LIMIT}/${MEMORY_HARD_LIMIT}`);
  });

  it("evicts low-importance old rows at the hard cap while protecting identity", async () => {
    let tick = 0;
    const store = new MemoryStore({
      filePath,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    });
    const identity = await store.remember("Ken's legal identity is protected.", "identity", 1);
    const oldest = await store.remember("Old low importance memory.", "other", 1);
    for (let index = 2; index < MEMORY_HARD_LIMIT; index += 1) {
      await store.remember(`Unique durable fact ${index}.`, "project", 3);
    }
    await store.remember("Newest high importance memory.", "project", 5);

    const memories = await store.list();
    expect(memories).toHaveLength(MEMORY_HARD_LIMIT);
    expect(memories.some((memory) => memory.id === identity.memory?.id)).toBe(true);
    expect(memories.some((memory) => memory.id === oldest.memory?.id)).toBe(false);
  });

  it("recovers malformed primary storage from the last good backup", async () => {
    const store = new MemoryStore({ filePath });
    await store.remember("First durable fact.", "other");
    await store.remember("Second durable fact.", "other");
    await fs.writeFile(filePath, "{malformed", "utf8");

    const recovered = await new MemoryStore({ filePath }).list();
    expect(recovered.map((memory) => memory.text)).toEqual(["First durable fact."]);
  });

  it("starts safely empty when both primary and backup are malformed", async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await Promise.all([fs.writeFile(filePath, "bad"), fs.writeFile(`${filePath}.bak`, "also bad")]);
    expect(await new MemoryStore({ filePath }).list()).toEqual([]);
  });
});

describe("memory tools", () => {
  it("are sequential and mutate the store with duplicate guidance", async () => {
    const store = new MemoryStore({ filePath });
    const tools = buildMemoryTools(store);
    expect(tools.map((tool) => [tool.name, tool.executionMode])).toEqual([
      ["remember", "sequential"],
      ["update_memory", "sequential"],
      ["forget", "sequential"],
    ]);

    const remembered = await tools[0]!.execute(
      { content: "Ken has a durable preference.", category: "preference", importance: 4 },
      context(),
    );
    expect(remembered).toMatch(/^Remembered as /);
    const id = (await store.list())[0]!.id;

    const duplicate = await tools[0]!.execute(
      { content: "Ken has a durable preference.", category: "preference" },
      context(),
    );
    expect(duplicate).toContain(`Near-duplicate already exists as ${id}`);

    expect(
      await tools[1]!.execute({ id, content: "Ken has an updated durable preference." }, context()),
    ).toBe(`Updated memory ${id}. 1 memory stored.`);
    expect(await tools[2]!.execute({ id }, context())).toBe(
      `Forgot memory ${id}. 0 memories remain.`,
    );
    expect(await store.list()).toEqual([]);
  });

  it("rejects over-limit content as an ordinary tool error, not a schema failure", async () => {
    const store = new MemoryStore({ filePath });
    const tools = buildMemoryTools(store);
    // The Zod schema must accept long content so validation reaches the store;
    // a schema-level failure would count toward the agent loop's fatal
    // "repeatedly issued invalid arguments" path.
    const longContent = "x".repeat(MEMORY_TEXT_LIMIT + 1);
    expect(tools[0]!.parameters.parse({ content: longContent })).toEqual({ content: longContent });
    await expect(store.remember(longContent)).rejects.toThrow(
      `Memory content is ${MEMORY_TEXT_LIMIT + 1} characters; the limit is ${MEMORY_TEXT_LIMIT}.`,
    );
  });
});
