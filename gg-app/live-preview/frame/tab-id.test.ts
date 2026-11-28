import { describe, expect, it } from "vitest";
import { claimTabId } from "./tab-id";

function bus() {
  const members: Array<{ fns: Array<(msg: unknown) => void> }> = [];
  const join = () => {
    const me = { fns: [] as Array<(msg: unknown) => void> };
    members.push(me);
    return {
      post: (msg: unknown) => {
        for (const m of members)
          if (m !== me) for (const fn of m.fns) queueMicrotask(() => fn(msg));
      },
      listen: (fn: (msg: unknown) => void) => void me.fns.push(fn),
    };
  };
  return { join };
}

function store(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
  };
}

let n = 0;
const newId = () => `tab-${++n}`;

describe("live preview tab id", () => {
  it("keeps the tab's id across reloads", async () => {
    const s = store();
    const first = await claimTabId(s, bus().join(), newId, 5);
    expect(await claimTabId(s, bus().join(), newId, 5)).toBe(first);
  });

  it("gives a duplicated tab, which copied the id, an id of its own", async () => {
    const b = bus();
    const original = store();
    const id = await claimTabId(original, b.join(), newId, 5);
    const copy = store({ ...original.data });
    const dup = await claimTabId(copy, b.join(), newId, 5);
    expect(dup).not.toBe(id);
    expect(copy.data["gg-live-tab"]).toBe(dup);
  });
});
