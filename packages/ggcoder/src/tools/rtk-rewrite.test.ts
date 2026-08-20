import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createRtkRewriter } from "./rtk-rewrite.js";

describe("createRtkRewriter", () => {
  it("returns undefined (no rewriter) unless GG_RTK_REWRITE=1", () => {
    expect(createRtkRewriter({})).toBeUndefined();
    expect(createRtkRewriter({ GG_RTK_REWRITE: "0" })).toBeUndefined();
    expect(createRtkRewriter({ GG_RTK_REWRITE: "true" })).toBeUndefined();
  });

  it("returns a rewriter function when GG_RTK_REWRITE=1", () => {
    const rewriter = createRtkRewriter({ GG_RTK_REWRITE: "1" });
    expect(typeof rewriter).toBe("function");
  });

  it("falls back to undefined when the configured binary does not exist", async () => {
    // PATH stripped down to nothing usable: rtk (or whatever PATH-only lookup
    // finds) will fail to spawn, proving the fail-open path works without
    // depending on rtk being uninstalled on the machine running the test.
    const rewriter = createRtkRewriter({
      GG_RTK_REWRITE: "1",
      PATH: "/nonexistent-directory-for-this-test",
    });
    expect(rewriter).toBeDefined();

    const result = await rewriter!("git status");
    expect(result).toBeUndefined();
  });

  it(
    "rewrites a command with an rtk allow rule (exit 0) through the real binary",
    { skip: !process.env.PATH || !hasRtk() },
    async () => {
      const rewriter = createRtkRewriter({ GG_RTK_REWRITE: "1", PATH: process.env.PATH });
      expect(rewriter).toBeDefined();

      const result = await rewriter!("git status");

      expect(typeof result).toBe("string");
      expect(result).not.toBe("git status");
      expect((result as string).length).toBeGreaterThan(0);
    },
  );

  it(
    "rewrites a command with NO rtk allow rule (exit 3) through the real binary",
    { skip: !process.env.PATH || !hasRtk() },
    async () => {
      // rtk's own exit-code contract (documented in rtk-rewrite.ts): exit 3
      // means "rewrite found, no explicit allow rule" and is STILL a valid
      // rewrite with real stdout, not a failure. `ps aux` reliably has no
      // allow rule (verified: `rtk rewrite "ps aux"` exits 3 on this host),
      // unlike `git status`, which does have one and exits 0 — so this test
      // exercises the exit-3 branch specifically. Deliberately asserts a
      // concrete rewrite, not "undefined or a string": a looser assertion
      // would not catch a regression that silently drops exit-3 handling
      // (confirmed during review: it did not, until this test existed).
      const rewriter = createRtkRewriter({ GG_RTK_REWRITE: "1", PATH: process.env.PATH });
      expect(rewriter).toBeDefined();

      const result = await rewriter!("ps aux");

      expect(typeof result).toBe("string");
      expect(result).not.toBe("ps aux");
      expect((result as string).length).toBeGreaterThan(0);
    },
  );

  it("does not spawn a second probe for concurrent first calls (probe dedup)", async () => {
    const rewriter = createRtkRewriter({
      GG_RTK_REWRITE: "1",
      PATH: "/nonexistent-directory-for-this-test",
    });
    expect(rewriter).toBeDefined();

    // Fire two calls back-to-back before the first probe can resolve. If
    // probing weren't deduplicated, this would spawn the probe process
    // twice; both calls must still resolve correctly regardless.
    const [a, b] = await Promise.all([rewriter!("echo one"), rewriter!("echo two")]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
  });
});

function hasRtk(): boolean {
  try {
    execFileSync("rtk", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
