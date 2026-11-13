import { describe, expect, it } from "vitest";
import { queueIdsForBubbles } from "./queued-bubble";
import type { Item } from "./transcript-item";

const bubble = (id: number, text: string, queued = true): Item => ({
  kind: "user",
  id,
  text,
  ...(queued ? { queued: true } : {}),
});

describe("queueIdsForBubbles", () => {
  it("gives each queued bubble its queue entry, so it can be cancelled from the chat", () => {
    // The queued strip above the composer was dropped (opening and folding it
    // bounced the pinned chat); its cancel now lives on the bubble itself.
    const items = [bubble(1, "old", false), bubble(2, "check the logs"), bubble(3, "stop")];
    const queue = [
      { id: "q1", text: "check the logs" },
      { id: "q2", text: "stop" },
    ];
    expect([...queueIdsForBubbles(items, queue)]).toEqual([
      [2, "q1"],
      [3, "q2"],
    ]);
  });

  it("pairs identical messages in order", () => {
    const items = [bubble(1, "again"), bubble(2, "again")];
    const queue = [
      { id: "q1", text: "again" },
      { id: "q2", text: "again" },
    ];
    expect(queueIdsForBubbles(items, queue).get(2)).toBe("q2");
  });

  it("offers no cancel once the agent is already taking the message", () => {
    const items = [bubble(1, "go")];
    expect(queueIdsForBubbles(items, [{ id: "q1", text: "go", delivering: true }]).size).toBe(0);
    expect(queueIdsForBubbles(items, []).size).toBe(0);
  });
});
