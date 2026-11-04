import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CHECKLIST_FILE, CHECKLIST_ITEMS } from "./checklist-items.js";
import {
  checklistStatus,
  checklistView,
  readChecklist,
  serializeChecklist,
  writeChecklistEntry,
  type ChecklistEntry,
} from "./checklist-store.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function entry(overrides: Partial<ChecklistEntry> = {}): ChecklistEntry {
  return {
    checkedAt: NOW.toISOString(),
    commit: "3f2a91c",
    uncommittedChanges: false,
    result: "pass",
    summary: "All good.",
    findings: [],
    evidence: ["pnpm lint — 0 errors"],
    ...overrides,
  };
}

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-checklist-store-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeRaw(content: string): Promise<void> {
  await fs.writeFile(path.join(root, CHECKLIST_FILE), content, "utf-8");
}

describe("readChecklist", () => {
  it("treats a missing file as an empty record", async () => {
    const result = await readChecklist(root, NOW);
    expect(result).toEqual({ ok: true, value: { version: 1, items: {} } });
  });

  it.each([
    ["not JSON", "{ nope", "not valid JSON"],
    ["wrong version", JSON.stringify({ version: 2, items: {} }), "not a version 1"],
    ["items not an object", JSON.stringify({ version: 1, items: [] }), "not a version 1"],
  ])("reports a broken file (%s)", async (_label, content, message) => {
    await writeRaw(content);
    const result = await readChecklist(root, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  it("drops unknown ids, invalid entries and far-future dates", async () => {
    await writeRaw(
      JSON.stringify({
        version: 1,
        items: {
          security: entry(),
          "made-up": entry(),
          tests: { ...entry(), checkedAt: "yesterday-ish" },
          ci: { ...entry(), result: "great" },
          docs: { ...entry(), checkedAt: new Date(NOW.getTime() + 3 * DAY).toISOString() },
          naming: { ...entry(), checkedAt: new Date(NOW.getTime() + 60_000).toISOString() },
        },
      }),
    );
    const result = await readChecklist(root, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.items).sort()).toEqual(["naming", "security"]);
  });

  it("refuses to read or import a linked project's private record", async () => {
    const privateProject = path.join(root, "private");
    const linkedProject = path.join(root, "linked");
    await fs.mkdir(privateProject);
    await fs.mkdir(linkedProject);
    const privateFile = path.join(privateProject, CHECKLIST_FILE);
    const contents = serializeChecklist({ version: 1, items: { security: entry() } });
    await fs.writeFile(privateFile, contents);
    await fs.symlink(privateFile, path.join(linkedProject, CHECKLIST_FILE), "file");

    const read = await readChecklist(linkedProject, NOW);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toContain("not a link");
    expect((await writeChecklistEntry(linkedProject, "tests", entry(), NOW)).ok).toBe(false);
    expect((await fs.lstat(path.join(linkedProject, CHECKLIST_FILE))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(privateFile, "utf-8")).toBe(contents);
    expect(await fs.readdir(linkedProject)).toEqual([CHECKLIST_FILE]);
  });

  it("rejects non-regular and oversized records", async () => {
    await fs.mkdir(path.join(root, CHECKLIST_FILE));
    expect((await readChecklist(root, NOW)).ok).toBe(false);
    await fs.rmdir(path.join(root, CHECKLIST_FILE));
    await writeRaw(" ".repeat(1024 * 1024 + 1));
    const result = await readChecklist(root, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("larger than 1 MB");
  });

  it("clips long text and repairs bad optional fields", async () => {
    await writeRaw(
      JSON.stringify({
        version: 1,
        items: {
          security: {
            ...entry(),
            commit: "not a sha; rm -rf",
            uncommittedChanges: "yes",
            summary: "x".repeat(1000),
            findings: ["y".repeat(1000), 42, "", ...Array.from({ length: 20 }, () => "z")],
            evidence: "not a list",
          },
        },
      }),
    );
    const result = await readChecklist(root, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const security = result.value.items.security;
    expect(security?.commit).toBeNull();
    expect(security?.uncommittedChanges).toBe(false);
    expect(security?.summary).toHaveLength(300);
    expect(security?.findings).toHaveLength(10);
    expect(security?.findings[0]).toHaveLength(300);
    expect(security?.evidence).toEqual([]);
  });
});

describe("writeChecklistEntry", () => {
  it("writes canonical JSON with sorted ids and keeps other entries", async () => {
    await writeChecklistEntry(root, "tests", entry(), NOW);
    const result = await writeChecklistEntry(root, "ci", entry({ result: "issues" }), NOW);
    expect(result.ok).toBe(true);
    const raw = await fs.readFile(path.join(root, CHECKLIST_FILE), "utf-8");
    expect(raw.endsWith("}\n")).toBe(true);
    const parsed = JSON.parse(raw) as { items: Record<string, unknown> };
    expect(Object.keys(parsed.items)).toEqual(["ci", "tests"]);
    if (result.ok) expect(raw).toBe(serializeChecklist(result.value));
    expect((await fs.readdir(root)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("merges concurrent store callers without losing any item or leaving locks", async () => {
    const ids = CHECKLIST_ITEMS.map((item) => item.id);
    const results = await Promise.all(ids.map((id) => writeChecklistEntry(root, id, entry(), NOW)));
    expect(results.filter((result) => !result.ok)).toEqual([]);
    const stored = await readChecklist(root, NOW);
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(Object.keys(stored.value.items).sort()).toEqual([...ids].sort());
    expect(await fs.readdir(root)).toEqual([CHECKLIST_FILE]);
  });

  function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: mkdir`), { code });
  }

  it("waits out a released lock that Windows refuses with EPERM while it is pending delete", async () => {
    const realMkdir = fs.mkdir;
    let lockAttempts = 0;
    const spy = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      if (String(target).endsWith(".lock")) {
        lockAttempts += 1;
        if (lockAttempts === 1) {
          // The releasing writer's lock dir is still there, mid-delete.
          await realMkdir(target, options);
          throw errno("EPERM");
        }
        // Its delete finished before we polled again.
        await fs.rm(String(target), { recursive: true, force: true });
      }
      return realMkdir(target, options);
    });
    try {
      expect(await writeChecklistEntry(root, "tests", entry(), NOW)).toMatchObject({ ok: true });
      expect(lockAttempts).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readdir(root)).toEqual([CHECKLIST_FILE]);
  });

  it("still fails closed with the real error when no lock dir exists to wait for", async () => {
    const realMkdir = fs.mkdir;
    let lockAttempts = 0;
    const spy = vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
      if (String(target).endsWith(".lock")) {
        lockAttempts += 1;
        throw errno("EACCES");
      }
      return realMkdir(target, options);
    });
    try {
      const result = await writeChecklistEntry(root, "tests", entry(), NOW);
      expect(result).toEqual({
        ok: false,
        error: `Could not lock ${CHECKLIST_FILE}: EACCES: mkdir`,
      });
      expect(lockAttempts).toBeLessThanOrEqual(5);
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("cancels a waiting writer without removing another writer's lock", async () => {
    const lock = path.join(root, `${CHECKLIST_FILE}.lock`);
    await fs.mkdir(lock);
    const controller = new AbortController();
    const writing = writeChecklistEntry(root, "tests", entry(), NOW, controller.signal);
    controller.abort();
    expect(await writing).toEqual({ ok: false, error: "Checklist recording cancelled" });
    expect((await fs.stat(lock)).isDirectory()).toBe(true);
    expect(await fs.readdir(root)).toEqual([`${CHECKLIST_FILE}.lock`]);
  });

  it("refuses to overwrite a corrupt file", async () => {
    await writeRaw("{ nope");
    const result = await writeChecklistEntry(root, "tests", entry(), NOW);
    expect(result.ok).toBe(false);
    expect(await fs.readFile(path.join(root, CHECKLIST_FILE), "utf-8")).toBe("{ nope");
  });
});

describe("checklistStatus", () => {
  const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

  it.each([
    ["no entry", undefined, "not-run"],
    ["pass today", entry(), "passed"],
    ["issues today", entry({ result: "issues" }), "needs-work"],
    ["pass 30 days ago", entry({ checkedAt: ago(30) }), "passed"],
    ["pass 31 days ago", entry({ checkedAt: ago(31) }), "due"],
    ["issues 31 days ago", entry({ result: "issues", checkedAt: ago(31) }), "due"],
    [
      "n/a 400 days ago",
      entry({ result: "not-applicable", checkedAt: ago(400) }),
      "not-applicable",
    ],
    ["unparseable date", entry({ checkedAt: "nope" }), "not-run"],
    ["invalid n/a date", entry({ result: "not-applicable", checkedAt: "nope" }), "not-run"],
    ["future date", entry({ checkedAt: ago(-3) }), "not-run"],
  ] as const)("%s → %s", (_label, value, expected) => {
    expect(checklistStatus(value, NOW)).toBe(expected);
  });
});

describe("checklistView", () => {
  it("returns every item in list order, joined with its entry", () => {
    const rows = checklistView(
      CHECKLIST_ITEMS,
      { version: 1, items: { security: entry({ result: "issues", findings: ["a"] }) } },
      NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(CHECKLIST_ITEMS.map((i) => i.id));
    const security = rows.find((r) => r.id === "security");
    expect(security).toMatchObject({
      status: "needs-work",
      commit: "3f2a91c",
      findings: ["a"],
      skill: "bulletproof",
    });
    expect(rows.find((r) => r.id === "docs")).toMatchObject({
      status: "not-run",
      checkedAt: null,
      result: null,
    });
  });
});
