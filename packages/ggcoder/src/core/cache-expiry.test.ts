import { describe, expect, it } from "vitest";
import type { Message, PreparedContext, Usage } from "@kleio/ai";
import { CacheDiagnostics } from "./cache-diagnostics.js";
import {
  CACHE_EXPIRY_NOTICE_MIN_TOKENS,
  assessCacheExpiry,
  resolveCacheTtl,
  type CacheTtlPolicy,
} from "./cache-expiry.js";

const MIN = 60_000;

describe("resolveCacheTtl", () => {
  it.each([
    [{ provider: "anthropic", model: "claude", cacheRetention: "short" as const }, 5 * MIN],
    [{ provider: "anthropic", model: "claude", cacheRetention: "long" as const }, 60 * MIN],
    [
      {
        provider: "anthropic",
        model: "claude",
        cacheRetention: "long" as const,
        baseUrl: "https://proxy.example.com",
      },
      5 * MIN,
    ],
    [{ provider: "openai", model: "gpt-5.2", cacheRetention: "short" as const }, 60 * MIN],
    [{ provider: "openai", model: "gpt-5.2", cacheRetention: "long" as const }, 24 * 60 * MIN],
    [{ provider: "openai", model: "gpt-5.6", cacheRetention: "long" as const }, 30 * MIN],
    [
      { provider: "openai", model: "gpt-5.2", cacheRetention: "long" as const, accountId: "acct" },
      10 * MIN,
    ],
  ])("%o → %d ms", (input, ttl) => {
    expect(resolveCacheTtl(input)?.ttlMs).toBe(ttl);
  });

  it("marks the GPT-5.6 30m TTL as a minimum, not a hard expiry", () => {
    expect(
      resolveCacheTtl({ provider: "openai", model: "gpt-6", cacheRetention: "short" })?.confidence,
    ).toBe("may_be_cold");
  });

  it("returns null when no TTL is requested or known", () => {
    expect(resolveCacheTtl({ provider: "anthropic", model: "c", cacheRetention: "none" })).toBe(
      null,
    );
    expect(resolveCacheTtl({ provider: "gemini", model: "g", cacheRetention: "long" })).toBe(null);
  });
});

const policy: CacheTtlPolicy = { ttlMs: 5 * MIN, confidence: "expired", source: "test" };
const current = { provider: "anthropic", model: "claude", policy };
const touch = { at: 1_000_000, provider: "anthropic", model: "claude", policy };

describe("assessCacheExpiry", () => {
  it("is warm before the TTL and expired (idle) at/after it", () => {
    const base = { current, lastTouch: touch, prefixTokens: 120_000, hasHistory: true };
    const warm = assessCacheExpiry({ ...base, now: touch.at + 5 * MIN - 1 });
    expect(warm).toMatchObject({ expired: false, notable: false, reason: null });
    expect(warm?.expiresAt).toBe(touch.at + 5 * MIN);
    const cold = assessCacheExpiry({ ...base, now: touch.at + 5 * MIN });
    expect(cold).toMatchObject({ expired: true, notable: true, reason: "idle" });
    expect(cold?.lastRequestAt).toBe(touch.at);
    expect(cold?.estimatedExtraCostUsd).toBeNull();
  });

  it("uses the TTL the entry was written with, not the current setting", () => {
    const longTouch = { ...touch, policy: { ...policy, ttlMs: 60 * MIN } };
    const s = assessCacheExpiry({
      current,
      lastTouch: longTouch,
      now: touch.at + 10 * MIN,
      prefixTokens: 100_000,
      hasHistory: true,
    });
    expect(s?.expired).toBe(false);
  });

  it("treats a resumed chat with no request in this process as age_unknown", () => {
    const s = assessCacheExpiry({
      current,
      lastTouch: null,
      now: 0,
      prefixTokens: 50_000,
      hasHistory: true,
    });
    expect(s).toMatchObject({ expired: true, reason: "age_unknown", expiresAt: null });
  });

  it("treats a model switch as identity_changed", () => {
    const s = assessCacheExpiry({
      current: { ...current, model: "other" },
      lastTouch: touch,
      now: touch.at + 1,
      prefixTokens: 50_000,
      hasHistory: true,
    });
    expect(s).toMatchObject({ expired: true, reason: "identity_changed" });
  });

  it("is notable only at or above the token threshold", () => {
    const base = { current, lastTouch: touch, now: touch.at + 6 * MIN, hasHistory: true };
    expect(CACHE_EXPIRY_NOTICE_MIN_TOKENS).toBe(40_000);
    expect(assessCacheExpiry({ ...base, prefixTokens: 39_999 })?.notable).toBe(false);
    expect(assessCacheExpiry({ ...base, prefixTokens: 40_000 })?.notable).toBe(true);
    expect(assessCacheExpiry({ ...base, prefixTokens: 1_000, minTokens: 500 })?.notable).toBe(true);
  });

  it("returns null for an empty chat or an unknown-TTL route", () => {
    const base = { lastTouch: touch, now: 0, prefixTokens: 90_000 };
    expect(assessCacheExpiry({ ...base, current, hasHistory: false })).toBeNull();
    expect(
      assessCacheExpiry({ ...base, current: { ...current, policy: null }, hasHistory: true }),
    ).toBeNull();
  });
});

describe("CacheDiagnostics cache touch", () => {
  const ctx = (messages: Message[]): PreparedContext => ({
    messages,
    tools: [],
    imagesBefore: 0,
    imagesAfter: 0,
    firstImageDropMessage: null,
  });
  const obs = (at: number) => ({
    provider: "anthropic",
    model: "claude",
    at,
    cacheRetention: "short" as const,
    settings: {},
    route: {},
  });
  const usage: Usage = { inputTokens: 10, outputTokens: 1, cacheRead: 0, cacheWrite: 100 };
  const timing = { providerDurationMs: 1 };

  it("records successful requests and ignores failed attempts", () => {
    const d = new CacheDiagnostics();
    d.prepare(ctx([{ role: "user", content: "a" }]), obs(1_000));
    d.complete(usage, timing);
    expect(d.lastCacheTouch()).toMatchObject({ at: 1_000, provider: "anthropic" });
    expect(d.lastCacheTouch()?.policy.ttlMs).toBe(5 * MIN);

    d.prepare(ctx([{ role: "user", content: "b" }]), obs(9_000));
    d.discardAttempt();
    d.complete(usage, timing); // nothing pending → no-op
    expect(d.lastCacheTouch()?.at).toBe(1_000);

    d.noteCacheTouch({ ...touch, at: 20_000 });
    expect(d.lastCacheTouch()?.at).toBe(20_000);
    d.reset();
    expect(d.lastCacheTouch()).toBeNull();
  });
});
