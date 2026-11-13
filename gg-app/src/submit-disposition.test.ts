import { describe, expect, it } from "vitest";
import { showsQueuedBubble, submitDisposition } from "./submit-disposition";

describe("submitDisposition", () => {
  it("queues a folder picked while the agent is running instead of dropping it", () => {
    // The regression: `/add-dir <path>` chosen from the native picker mid-run
    // used to be discarded silently — dialog opens, folder chosen, nothing
    // happens. Typed input always queued as steering; now this does too.
    expect(submitDisposition("/add-dir /tmp/sdk", true, true)).toBe("queue");
    expect(submitDisposition("/remove-dir /tmp/sdk", true, true)).toBe("queue");
  });

  it("sends immediately when no run is in flight", () => {
    expect(submitDisposition("/add-dir /tmp/sdk", true, false)).toBe("send");
    expect(submitDisposition("/commit", true, false)).toBe("send");
  });

  it("ignores empty or whitespace-only text", () => {
    expect(submitDisposition("", true, false)).toBe("ignore");
    expect(submitDisposition("   \n\t ", true, false)).toBe("ignore");
    // Still ignored mid-run — queueing nothing would push an empty bubble.
    expect(submitDisposition("   ", true, true)).toBe("ignore");
  });

  it("ignores everything until the sidecar is ready", () => {
    expect(submitDisposition("/add-dir /tmp/sdk", false, false)).toBe("ignore");
    expect(submitDisposition("/add-dir /tmp/sdk", false, true)).toBe("ignore");
  });
});

describe("showsQueuedBubble", () => {
  it("skips the queued look for a prompt that supersedes an open question", () => {
    // The regression: answering a question by typing something else made the
    // bubble render dim + dashed + "queued", then promote a beat later, because
    // releasing the parked call hands it to the agent almost instantly.
    expect(showsQueuedBubble("queue", true)).toBe(false);
  });

  it("still marks an ordinary mid-run send as queued", () => {
    // It really is waiting behind the current tool call, and the pill is the
    // only thing that says so.
    expect(showsQueuedBubble("queue", false)).toBe(true);
  });

  it("never marks a fresh run as queued", () => {
    expect(showsQueuedBubble("send", false)).toBe(false);
    expect(showsQueuedBubble("send", true)).toBe(false);
  });
});
