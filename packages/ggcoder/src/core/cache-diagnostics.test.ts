import { describe, expect, it } from "vitest";
import type { Message, PreparedContext, Usage } from "@kleio/ai";
import { CacheDiagnostics, type CacheRequestObservation } from "./cache-diagnostics.js";

function context(messages: Message[], extra: Partial<PreparedContext> = {}): PreparedContext {
  return {
    messages,
    tools: [],
    imagesBefore: 0,
    imagesAfter: 0,
    firstImageDropMessage: null,
    ...extra,
  };
}
function request(extra: Partial<CacheRequestObservation> = {}): CacheRequestObservation {
  return {
    provider: "anthropic",
    model: "claude-test",
    at: 0,
    cacheRetention: "short",
    settings: {},
    route: {},
    ...extra,
  };
}
function usage(extra: Partial<Usage> = {}): Usage {
  return { inputTokens: 0, outputTokens: 10, cacheRead: 0, cacheWrite: 100_000, ...extra };
}
const timing = { ttftMs: 123, providerDurationMs: 456 };
function user(content: string): Message {
  return { role: "user", content };
}
function thinking(): Message {
  return {
    role: "assistant",
    content: [{ type: "thinking", text: "private reasoning", signature: "private signature" }],
  };
}

describe("session cache diagnostics", () => {
  it("reports an unchanged prefix and reprocessed-input estimate, not all cache writes as waste", () => {
    const tracker = new CacheDiagnostics();
    tracker.prepare(context([user("old")]), request());
    expect(tracker.complete(usage(), timing)).toMatchObject({
      comparison: "first_request",
      reprocessedPromptTokensEstimate: null,
    });
    const report = tracker.prepare(context([user("old"), user("new")]), request({ at: 1000 }));
    expect(report).toMatchObject({
      unchangedMessages: 1,
      changes: [],
      sincePreviousRequestMs: 1000,
    });
    expect(
      tracker.complete(usage({ cacheRead: 100_000, cacheWrite: 10_000 }), timing),
    ).toMatchObject({
      comparison: "comparable",
      reprocessedPromptTokensEstimate: 0,
      cacheWrite: 10_000,
      ttftMs: 123,
      providerDurationMs: 456,
      costStatus: "unavailable",
    });
  });

  it("records actual prune events without claiming they prove the cause of a miss", () => {
    const tracker = new CacheDiagnostics();
    const messages = [user("old output"), user("keep")];
    tracker.prepare(context(messages), request());
    tracker.complete(usage(), timing);
    messages[0] = user("[Pruned]"); // In-place history mutation must not mutate the saved snapshot.
    tracker.noteEdit("tool_prune", 25_000);
    expect(tracker.prepare(context(messages), request())).toMatchObject({
      changes: ["history", "tool_prune"],
      unchangedMessages: 0,
      pruneFreedTokensEstimate: 25_000,
    });
    expect(tracker.complete(usage({ cacheWrite: 80_000 }), timing)).toMatchObject({
      reprocessedPromptTokensEstimate: 80_000,
    });
    expect(tracker.prepare(context(messages), request()).changes).toEqual([]);
  });

  it("distinguishes image-batch changes from continued requests using the same cutoff", () => {
    const tracker = new CacheDiagnostics();
    const trimmed = context([user("image omitted")], {
      imagesBefore: 91,
      imagesAfter: 61,
      firstImageDropMessage: 0,
    });
    expect(tracker.prepare(trimmed, request()).changes).toEqual(["image_budget"]);
    tracker.complete(usage(), timing);
    expect(
      tracker.prepare({ ...trimmed, imagesBefore: 92, imagesAfter: 62 }, request()).changes,
    ).toEqual([]);
    tracker.complete(usage(), timing);
    expect(
      tracker.prepare({ ...trimmed, imagesBefore: 121, imagesAfter: 61 }, request()).changes,
    ).toEqual(["image_budget"]);
  });

  it("treats compaction as a new context, not estimated cache waste", () => {
    const tracker = new CacheDiagnostics();
    tracker.prepare(context([user("long archive")]), request());
    tracker.complete(usage(), timing);
    tracker.noteEdit("compaction");
    tracker.prepare(context([user("summary")]), request());
    expect(tracker.complete(usage({ cacheWrite: 20_000 }), timing)).toMatchObject({
      changes: ["compaction", "history"],
      comparison: "compaction",
      reprocessedPromptTokensEstimate: null,
    });
  });

  it.each([
    { model: "different" },
    { provider: "openai" },
    { route: { accountId: "another account" } },
  ])("does not compare tokenizers or cache routes across a switch: %j", (change) => {
    const tracker = new CacheDiagnostics();
    tracker.prepare(context([user("same")]), request());
    tracker.complete(usage(), timing);
    tracker.prepare(context([user("same")]), request(change));
    expect(tracker.complete(usage(), timing)).toMatchObject({
      changes: ["route_or_model"],
      comparison: "route_changed",
      reprocessedPromptTokensEstimate: null,
    });
  });

  it("detects tool schema and request-setting changes with canonical keys", () => {
    const tracker = new CacheDiagnostics();
    tracker.prepare(context([user("same")]), request({ settings: { a: 1, b: 2 } }));
    tracker.complete(usage(), timing);
    expect(
      tracker.prepare(context([user("same")]), request({ settings: { b: 2, a: 1 } })).changes,
    ).toEqual([]);
    tracker.complete(usage(), timing);
    const tools = [{ name: "read", description: "read", parameters: { type: "object" } }];
    expect(tracker.prepare(context([user("same")], { tools }), request()).changes).toEqual([
      "request_settings",
    ]);
  });

  it("does not mislabel an unreported cache as a total miss", () => {
    const tracker = new CacheDiagnostics();
    const noCache = { inputTokens: 100_000, outputTokens: 10 };
    tracker.prepare(context([user("same")]), request());
    tracker.complete(noCache, timing);
    tracker.prepare(context([user("same")]), request());
    expect(tracker.complete(noCache, timing)).toMatchObject({
      comparison: "cache_unreported",
      reprocessedPromptTokensEstimate: null,
    });
  });

  it("recognizes zero cache reads after earlier reported cache usage", () => {
    const tracker = new CacheDiagnostics();
    tracker.prepare(context([user("same")]), request());
    tracker.complete(usage({ cacheRead: 100_000, cacheWrite: 0 }), timing);
    tracker.prepare(context([user("same")]), request());
    expect(tracker.complete({ inputTokens: 110_000, outputTokens: 10 }, timing)).toMatchObject({
      comparison: "comparable",
      reprocessedPromptTokensEstimate: 100_000,
    });
  });

  it("keeps the successful baseline across failed attempts and resets between conversations", () => {
    const tracker = new CacheDiagnostics();
    tracker.prepare(context([user("baseline")]), request());
    tracker.complete(usage(), timing);
    tracker.prepare(context([user("failed")]), request());
    tracker.discardAttempt();
    expect(tracker.complete(usage(), timing)).toBeUndefined();
    expect(tracker.prepare(context([user("baseline"), user("retry")]), request())).toMatchObject({
      changes: [],
      unchangedMessages: 1,
      request: 3,
    });
    tracker.complete(usage(), timing);
    expect(tracker.complete(usage(), timing)).toBeUndefined();
    tracker.reset();
    tracker.prepare(context([user("fresh")]), request());
    expect(tracker.complete(usage(), timing)?.comparison).toBe("first_request");
  });

  it("labels idle expiry only as a possibility and honors the requested retention", () => {
    const tracker = new CacheDiagnostics();
    tracker.prepare(context([user("same")]), request());
    tracker.complete(usage(), timing);
    expect(
      tracker.prepare(context([user("same")]), request({ at: 360_000 })).requestedTtlExceeded,
    ).toBe(true);
    expect(
      tracker.prepare(context([user("same")]), request({ at: 360_000, cacheRetention: "long" }))
        .requestedTtlExceeded,
    ).toBe(false);
  });

  it("flags image edits before signed thinking on a resumed history without discarding it", () => {
    const tracker = new CacheDiagnostics();
    const messages = [user("old image"), thinking(), user("latest")];
    const original = structuredClone(messages);
    expect(tracker.prepare(context(messages), request()).settledThinkingBlocks).toBe(1);
    expect(
      tracker.prepare(
        context(messages, { imagesBefore: 91, imagesAfter: 61, firstImageDropMessage: 0 }),
        request(),
      ).thinkingPrefixRiskBlocks,
    ).toBe(1);
    expect(messages).toEqual(original);
    expect(
      tracker.prepare(context(messages), request({ provider: "openai" })).thinkingPrefixRiskBlocks,
    ).toBe(0);
  });

  it("also flags opaque redacted thinking preserved for provider round-tripping", () => {
    const tracker = new CacheDiagnostics();
    const messages: Message[] = [
      user("old"),
      {
        role: "assistant",
        content: [{ type: "raw", data: { type: "redacted_thinking", data: "opaque" } }],
      },
    ];
    tracker.prepare(context(messages), request());
    tracker.complete(usage(), timing);
    messages[0] = user("changed");
    expect(tracker.prepare(context(messages), request()).thinkingPrefixRiskBlocks).toBe(1);
  });

  it("does not flag thinking before a changed message or append-only requests", () => {
    const tracker = new CacheDiagnostics();
    tracker.prepare(context([thinking(), user("old")]), request());
    tracker.complete(usage(), timing);
    expect(
      tracker.prepare(context([thinking(), user("new")]), request()).thinkingPrefixRiskBlocks,
    ).toBe(0);
    tracker.complete(usage(), timing);
    expect(
      tracker.prepare(context([thinking(), user("new"), user("append")]), request())
        .thinkingPrefixRiskBlocks,
    ).toBe(0);
  });

  it("flags altered system/tools before signed thinking and never logs content, hashes, or account IDs", () => {
    const tracker = new CacheDiagnostics();
    const messages: Message[] = [{ role: "system", content: "secret prompt" }, thinking()];
    tracker.prepare(context(messages), request({ route: { accountId: "private account" } }));
    tracker.complete(usage(), timing);
    messages[0] = { role: "system", content: "secret prompt changed" };
    const report = tracker.prepare(
      context(messages),
      request({ route: { accountId: "private account" } }),
    );
    expect(report.thinkingPrefixRiskBlocks).toBe(1);
    const text = JSON.stringify(tracker.complete(usage(), timing));
    expect(text).not.toMatch(/secret|private|signature|[a-f0-9]{64}/);
    expect(
      tracker.prepare(context(messages), request({ settings: { thinking: "high" } }))
        .thinkingPrefixRiskBlocks,
    ).toBe(1);
  });
});
