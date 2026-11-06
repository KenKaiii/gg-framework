import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearClaudeCodeUsage,
  mergeClaudeCodeRateLimit,
  readClaudeCodeUsage,
  recordClaudeCodeRateLimit,
} from "./usage.js";

const homes: string[] = [];
async function tempHome(): Promise<string> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "gg-cc-usage-"));
  homes.push(home);
  return home;
}
afterEach(async () => {
  for (const home of homes.splice(0)) await fsp.rm(home, { recursive: true, force: true });
});

describe("mergeClaudeCodeRateLimit", () => {
  it("reads unified windows as percentages with millisecond resets", () => {
    const snapshot = mergeClaudeCodeRateLimit(
      {
        rateLimitType: "seven_day",
        unifiedWindows: {
          seven_day: { utilization: 0.11, resetsAt: 1_794_560_400 },
          five_hour: { utilization: 0.4, resetsAt: 1_794_000_000 },
          seven_day_opus: { utilization: 0.9 },
        },
      },
      null,
      42,
    );
    expect(snapshot).toEqual({
      provider: "anthropic",
      displayName: "Anthropic",
      fetchedAt: 42,
      windows: [
        { kind: "current", label: "5-hour", usedPercent: 40, resetsAt: 1_794_000_000_000 },
        { kind: "weekly", label: "Weekly", usedPercent: 11, resetsAt: 1_794_560_400_000 },
      ],
    });
  });

  it("keeps windows a report doesn't mention and falls back to the top-level fields", () => {
    const first = mergeClaudeCodeRateLimit(
      { unifiedWindows: { seven_day: { utilization: 0.2 } } },
      null,
      1,
    );
    const second = mergeClaudeCodeRateLimit(
      { rateLimitType: "five_hour", utilization: 1.5, resetsAt: 10 },
      first,
      2,
    );
    expect(second.windows).toEqual([
      { kind: "current", label: "5-hour", usedPercent: 100, resetsAt: 10_000 },
      { kind: "weekly", label: "Weekly", usedPercent: 20 },
    ]);
  });
});

describe("Claude Code usage file", () => {
  it("records, merges, expires past windows and clears", async () => {
    const home = await tempHome();
    await recordClaudeCodeRateLimit(
      { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 100 } } },
      { home, now: 1_000 },
    );
    await recordClaudeCodeRateLimit(
      { unifiedWindows: { seven_day: { utilization: 0.25, resetsAt: 900 } } },
      { home, now: 2_000 },
    );
    const live = await readClaudeCodeUsage({ home, now: 50_000 });
    expect(live?.windows.map((w) => w.usedPercent)).toEqual([50, 25]);
    expect(live?.fetchedAt).toBe(2_000);

    // The 5-hour window reset at 100 s; only the weekly one still holds.
    const later = await readClaudeCodeUsage({ home, now: 200_000 });
    expect(later?.windows.map((w) => w.kind)).toEqual(["weekly"]);

    await clearClaudeCodeUsage({ home });
    expect(await readClaudeCodeUsage({ home })).toBeNull();
  });

  it("ignores a missing or corrupt file", async () => {
    const home = await tempHome();
    expect(await readClaudeCodeUsage({ home })).toBeNull();
    await fsp.writeFile(path.join(home, "usage.json"), "{not json");
    expect(await readClaudeCodeUsage({ home })).toBeNull();
  });
});
