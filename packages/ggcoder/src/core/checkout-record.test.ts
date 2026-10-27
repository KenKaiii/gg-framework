import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHECKOUT_RECORD_KIND,
  latestCheckoutRecord,
  parseCheckoutRecord,
  readCheckoutRecord,
} from "./checkout-record.js";
import type { SessionEntry } from "./session-manager.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-checkout-record-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const custom = (data: unknown, kind = CHECKOUT_RECORD_KIND) => ({
  type: "custom",
  kind,
  id: Math.random().toString(36),
  parentId: null,
  timestamp: "2026-10-27T00:00:00.000Z",
  data,
});

describe("checkout records", () => {
  it("validates the stored shape", () => {
    expect(parseCheckoutRecord({ branch: "x", cwd: "/r" })).toEqual({ branch: "x", cwd: "/r" });
    expect(parseCheckoutRecord({ branch: "", cwd: "/r" })).toBeNull();
    expect(parseCheckoutRecord({ branch: "x" })).toBeNull();
    expect(parseCheckoutRecord("x")).toBeNull();
  });

  it("takes the latest record from loaded entries", () => {
    const entries = [
      custom({ branch: "a", cwd: "/r" }),
      custom({ other: true }, "verification_state"),
      custom({ branch: "b", cwd: "/w/b" }),
    ] as unknown as SessionEntry[];
    expect(latestCheckoutRecord(entries)).toEqual({ branch: "b", cwd: "/w/b" });
    expect(latestCheckoutRecord([])).toBeNull();
  });

  it("reads the latest record from a plain or archived conversation file", async () => {
    const lines = [
      JSON.stringify({ type: "session", id: "s" }),
      JSON.stringify(custom({ branch: "a", cwd: "/r" })),
      JSON.stringify({ type: "message", content: `mentions ${CHECKOUT_RECORD_KIND} in text` }),
      "{torn",
      JSON.stringify(custom({ branch: "b", cwd: "/w/b" })),
      "",
    ].join("\n");
    const plain = path.join(dir, "s.jsonl");
    fs.writeFileSync(plain, lines);
    expect(await readCheckoutRecord(plain)).toEqual({ branch: "b", cwd: "/w/b" });
    const archived = path.join(dir, "t.jsonl.gz");
    fs.writeFileSync(archived, gzipSync(lines));
    expect(await readCheckoutRecord(archived)).toEqual({ branch: "b", cwd: "/w/b" });
    expect(await readCheckoutRecord(path.join(dir, "missing.jsonl"))).toBeNull();
  });
});
