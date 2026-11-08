import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "./blocked-skills";
import { collapseSecurityRows, takeNewSecurityNotices, withSecurityRow } from "./security-notices";

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const notice = {
  key: "/p/package-lock.json\0debug@4.4.2 (MAL-2025-46974)",
  message: "This project uses a package now known to be infected: debug@4.4.2 (MAL-2025-46974).",
};

describe("security notices", () => {
  it("shows a notice once, across windows and restarts", () => {
    const store = memoryStore();
    expect(takeNewSecurityNotices([notice], store)).toEqual([notice.message]);
    expect(takeNewSecurityNotices([notice], store)).toEqual([]);
  });

  it("a different hit is new; empty or malformed input shows nothing", () => {
    const store = memoryStore();
    takeNewSecurityNotices([notice], store);
    const other = { key: `${notice.key}x`, message: "other" };
    expect(takeNewSecurityNotices([notice, other], store)).toEqual(["other"]);
    expect(takeNewSecurityNotices(undefined, store)).toEqual([]);
    expect(takeNewSecurityNotices([{ key: "", message: "x" }], store)).toEqual([]);
  });

  it("survives broken storage", () => {
    const store: KeyValueStore = {
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(takeNewSecurityNotices([notice], store)).toEqual([notice.message]);
  });
});

describe("security rows don't pile up", () => {
  const row = (id: number, target = "npm i a") => ({
    kind: "security",
    id,
    rule: "malicious-package",
    target,
  });

  it("a repeat of the last row bumps its count instead of adding a row", () => {
    let items: Array<{ kind: string; id: number; rule?: string; target?: string; count?: number }> =
      [];
    for (let i = 0; i < 30; i++) items = withSecurityRow(items, row(i));
    expect(items).toHaveLength(1);
    expect(items[0]?.count).toBe(30);
    items = withSecurityRow(items, row(99, "npm i b"));
    expect(items).toHaveLength(2);
  });

  it("restored history folds consecutive identical rows, keeps others in order", () => {
    const text = { kind: "assistant", id: 0 };
    const out = collapseSecurityRows([row(1), row(2), text, row(3), row(4, "x"), row(5, "x")]);
    expect(out.map((r) => ("count" in r ? r.count : undefined))).toEqual([
      2,
      undefined,
      undefined,
      2,
    ]);
  });

  it("folds 5,000 restored rows fast", () => {
    const many = Array.from({ length: 5000 }, (_, i) => row(i, i % 2 ? "a" : "b"));
    const t = performance.now();
    expect(collapseSecurityRows(many)).toHaveLength(5000);
    expect(performance.now() - t).toBeLessThan(50);
  });
});
