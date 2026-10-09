import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

// Run settlement lives inside the daemon closure, with no injectable session seam.
// Pin its routing here; session verification and UI settlement have runtime suites.
describe("desktop verification settlement", () => {
  it("reports an unresolved gate as Unverified, not an unexpected error", async () => {
    const source = await fs.readFile(new URL("./app-sidecar.ts", import.meta.url), "utf8");
    const start = source.indexOf("const verificationProblem =");
    const end = source.indexOf("// Autopilot's review loop", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const settlement = source.slice(start, end);
    // Checks belong to the commit: only an Autopilot cycle, which has a real
    // end, reports unchecked work as Unverified. A plain reply never does.
    expect(settlement).toMatch(
      /const verificationProblem =\s*cancelled \|\| !autopilotActive \? null : session\.getVerificationProblem\(\);/,
    );
    expect(settlement).not.toContain("broadcastError(");
    expect(settlement).toContain('log("WARN", "app-sidecar", "verification incomplete"');
    expect(settlement).toContain('verificationProblem ? "unverified"');
    expect(settlement).toContain("unverified: true");
    expect(settlement).toMatch(
      /reviewPending:\s*!cancelled\s*&&\s*runSucceeded\s*&&\s*!verificationProblem/,
    );
  });
});

// Plan hand-off end to end: app-sidecar-plan-handoff.test.ts (real daemon).
// Task-list runs and the queued-message Stop reset have no scripted
// end-to-end path there, so their wiring is pinned here.
describe("desktop plan hand-off", () => {
  it("offers a plan submitted by a task-list run when the run finishes", async () => {
    const source = await fs.readFile(
      new URL("./app-sidecar/autopilot-runner.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /ctx\.broadcast\("tasks_run_done", \{\}\);[\s\S]{0,200}ctx\.offerPendingPlan\(\);/,
    );
  });

  it("clears a stale Stop when a queued message drains as a fresh turn", async () => {
    const source = await fs.readFile(
      new URL("./app-sidecar/autopilot-runner.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("async function runStrandedQueue");
    expect(start).toBeGreaterThan(-1);
    const drain = source.slice(start);
    expect(drain).toMatch(/ctx\.clearPendingPlan\(\);\s*ctx\.autopilotCancelled = false;/);
  });
});
