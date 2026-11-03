import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@kleio/ai";
import { AgentSession } from "./agent-session.js";
import type { IdealReviewStats, ReviewCoverageTracker } from "./ideal-review.js";
import type { VerificationGate } from "./verification-gate.js";

interface ReviewInternals {
  settingsManager: { get(key: string): boolean };
  loopMonitor: { stats: IdealReviewStats };
  verificationTracker: { fileEditCounts: Map<string, number> };
  reviewCoverage: ReviewCoverageTracker;
  verificationGate: VerificationGate;
  subAgentManager?: { completionGateMessage(): string | undefined };
  getHookFollowUpMessages(): Promise<Message[] | null>;
  refreshIdealReviewArmed(): void;
  eventBus: AgentSession["eventBus"];
  setIdealReviewSuppressed(suppressed: boolean): void;
}

// Coverage is filesystem-backed: a changed file must still exist to be gated,
// so these fixtures live in a real temp workspace.
const workspaces: string[] = [];
function makeWorkspace(files: readonly string[]): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "gg-review-coverage-"));
  workspaces.push(root);
  for (const file of files) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export const value = 1;\n");
  }
  return root;
}

afterAll(() => {
  for (const root of workspaces) rmSync(root, { recursive: true, force: true });
});

function makeReviewSession(cwd: string, changedFiles: readonly string[]): ReviewInternals {
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-sonnet-5",
    cwd,
    transient: true,
    systemPrompt: "test",
  });
  const internal = session as unknown as ReviewInternals;
  internal.settingsManager = { get: () => true };
  internal.loopMonitor.stats = {
    changedLines: 130,
    toolCalls: 9,
    toolFailures: 0,
    turns: 3,
    writeCalls: 1,
    editCalls: 3,
    bashCalls: 1,
  };
  for (const file of changedFiles) internal.verificationTracker.fileEditCounts.set(file, 1);
  return internal;
}

describe("AgentSession Ideal review coverage gate", () => {
  it("repeats fail-closed follow-ups until every post-injection changed file is read", async () => {
    const cwd = makeWorkspace(["src/a.ts", "src/b.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);

    // A pre-review read and a model-authored claim cannot satisfy the gate.
    internal.reviewCoverage.recordRead("src/a.ts");
    const first = await internal.getHookFollowUpMessages();
    expect(first?.[0]?.content).toContain("Ideal?");
    expect(first?.[0]?.content).toContain("- src/a.ts");
    const missingA = await internal.getHookFollowUpMessages();
    expect(missingA?.[0]?.content).toContain("- src/a.ts");

    // A successful review-time edit expands expected coverage.
    internal.reviewCoverage.recordChanged("src/b.ts");
    internal.reviewCoverage.recordRead("src/a.ts");
    const missingB = await internal.getHookFollowUpMessages();
    expect(missingB?.[0]?.content).toContain("- src/b.ts");

    internal.reviewCoverage.recordRead(path.join(cwd, "src/b.ts"));
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("orders verification before Ideal and finishes without repeating satisfied gates", async () => {
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);
    const notices: string[] = [];
    internal.eventBus.on("hook", ({ kind }) => notices.push(kind));
    internal.verificationGate.recordMutation("src/a.ts");

    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain(
      "Run the project's verification",
    );
    internal.verificationGate.recordVerification();
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain("Ideal?");
    internal.reviewCoverage.recordRead("src/a.ts");

    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(notices).toEqual(["verification", "ideal"]);
  });

  it("invalidates review reads and earlier verification when a reviewed file changes", async () => {
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);
    internal.verificationGate.recordMutation("src/a.ts");
    internal.verificationGate.recordVerification();
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain("Ideal?");
    internal.reviewCoverage.recordRead("src/a.ts");

    internal.reviewCoverage.recordChanged("src/a.ts");
    internal.verificationGate.recordMutation("src/a.ts");
    expect(internal.reviewCoverage.evidence().missing).toEqual(["src/a.ts"]);
    expect(internal.verificationGate.isOwed()).toBe(true);
    // Voluntary initial checks still get a distinctly labelled post-edit pass.
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain(
      "Re-run the affected checks",
    );
    internal.verificationGate.recordVerification();
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain(
      "coverage is incomplete",
    );
    internal.reviewCoverage.recordRead("src/a.ts");
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("requires rereading only the changed file, not the whole reviewed set", async () => {
    const cwd = makeWorkspace(["src/a.ts", "src/b.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts", "src/b.ts"]);
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain("Ideal?");
    internal.reviewCoverage.recordRead("src/a.ts");
    internal.reviewCoverage.recordRead("src/b.ts");
    internal.reviewCoverage.recordChanged(path.join(cwd, "src/a.ts"));

    expect(internal.reviewCoverage.evidence()).toEqual({
      expected: ["src/a.ts", "src/b.ts"],
      covered: ["src/b.ts"],
      missing: ["src/a.ts"],
    });
    const followUp = (await internal.getHookFollowUpMessages())?.[0]?.content;
    expect(followUp).toContain("- src/a.ts");
    expect(followUp).not.toContain("- src/b.ts");
    internal.reviewCoverage.recordRead("src/a.ts");
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("re-arms verification once when Ideal changes code after the first check", async () => {
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);
    internal.verificationGate.recordMutation("src/a.ts");
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain(
      "Run the project's verification",
    );
    internal.verificationGate.recordVerification();
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain("Ideal?");
    internal.reviewCoverage.recordRead("src/a.ts");
    internal.reviewCoverage.recordChanged("src/a.ts");
    internal.verificationGate.recordMutation("src/a.ts");
    internal.reviewCoverage.recordRead("src/a.ts");

    expect(internal.verificationGate.isOwed()).toBe(true);
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain("Re-run");
    internal.verificationGate.recordVerification();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("retains verification while suppressing Ideal for the independent reviewer", async () => {
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);
    const notices: string[] = [];
    internal.eventBus.on("hook", ({ kind }) => notices.push(kind));
    internal.setIdealReviewSuppressed(true);
    internal.verificationGate.recordMutation("src/a.ts");

    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain(
      "Run the project's verification",
    );
    internal.verificationGate.recordVerification();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(notices).toEqual(["verification"]);
  });

  it("stops gating a changed file the run deleted before review", async () => {
    // The observed loop: a scratch script was created, deleted, and then gated
    // forever because a deleted file can never produce read evidence.
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts", "scripts/probe-many.mjs"]);

    const first = await internal.getHookFollowUpMessages();
    expect(first?.[0]?.content).toContain("- src/a.ts");
    expect(first?.[0]?.content).not.toContain("probe-many.mjs");

    internal.reviewCoverage.recordRead("src/a.ts");
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("escalates to report-what-you-could-not-verify after two coverage follow-ups", async () => {
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);

    // The agent never reads the file: without a budget this repeats forever.
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain("Ideal?");
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain(
      "coverage is incomplete",
    );
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain(
      "coverage is incomplete",
    );

    const escalation = (await internal.getHookFollowUpMessages())?.[0]?.content;
    expect(escalation).toContain("could not verify");
    expect(escalation).toContain("do not repeat your previous answer");
    expect(escalation).toContain("- src/a.ts");

    // Terminal: the gate is closed even though the file was never read.
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("suppresses only Ideal review while Ken owns autopilot verification", async () => {
    const cwd = makeWorkspace(["src/a.ts"]);
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-sonnet-5",
      cwd,
      transient: true,
      systemPrompt: "test",
    });
    const internal = session as unknown as ReviewInternals;
    internal.settingsManager = { get: () => true };
    internal.loopMonitor.stats = {
      changedLines: 130,
      toolCalls: 9,
      toolFailures: 0,
      turns: 3,
      writeCalls: 1,
      editCalls: 3,
      bashCalls: 1,
    };
    internal.verificationTracker.fileEditCounts.set("src/a.ts", 1);

    session.setIdealReviewSuppressed(true);
    expect(await internal.getHookFollowUpMessages()).toBeNull();

    session.setIdealReviewSuppressed(false);
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain("Ideal?");
  });

  it("arms before the draft streams and disarms only after the review hook fires", async () => {
    // Arming is what lets a client hold the candidate final answer back instead
    // of painting a draft the review then deletes, so both edges must fire — and
    // disarm MUST trail the hook, or the client releases the draft into the
    // transcript one render before the hook removes it again.
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);
    const seen: string[] = [];
    internal.eventBus.on("hook_armed", (d) => seen.push(`armed:${d.armed}`));
    internal.eventBus.on("hook", (d) => seen.push(`hook:${d.kind}`));

    internal.refreshIdealReviewArmed();
    expect(seen).toEqual(["armed:true"]);
    // Only edges are broadcast, not every stat update.
    internal.refreshIdealReviewArmed();
    expect(seen).toEqual(["armed:true"]);

    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain("Ideal?");
    // Still armed after the hook: coverage is outstanding, so a stop right now
    // injects again and the next candidate answer is another draft. Disarm only
    // lands once the read evidence is complete.
    expect(seen).toEqual(["armed:true", "hook:ideal"]);

    internal.reviewCoverage.recordRead("src/a.ts");
    internal.refreshIdealReviewArmed();
    expect(seen).toEqual(["armed:true", "hook:ideal", "armed:false"]);
  });

  it("announces the coverage follow-up so the draft it replaces is never painted", async () => {
    // The duplicate-final-answer bug: the coverage retry injected silently, so
    // clients had nothing to hold or discard and painted the pre-coverage answer
    // on top of the reviewed one.
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);
    const seen: string[] = [];
    internal.eventBus.on("hook_armed", (d) => seen.push(`armed:${d.armed}`));
    internal.eventBus.on("hook", (d) => seen.push(`hook:${d.kind}`));

    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain("Ideal?");
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain(
      "coverage is incomplete",
    );
    // Arming lands after the hook here only because nothing computed it earlier
    // in this test; what matters is that it is on while coverage is outstanding.
    expect(seen).toEqual(["hook:ideal", "armed:true", "hook:ideal"]);

    // Escalation is an injection too: announce, then disarm as the gate closes.
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain(
      "coverage is incomplete",
    );
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain("could not verify");
    expect(seen).toEqual([
      "hook:ideal",
      "armed:true",
      "hook:ideal",
      "hook:ideal",
      "hook:ideal",
      "armed:false",
    ]);
  });

  it("arms for a run that only crosses the gate on the draft turn's own turn_end", async () => {
    // `turns` advances at turn_end, so a run sitting one point below the gate
    // would otherwise arm only AFTER the draft streamed — the appear-then-vanish
    // flash. Score here is 3 (60 changed lines + 8 tool calls + 2 mutation
    // calls) until the turn point lands, so arming must predict the crossing.
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, []);
    internal.loopMonitor.stats = {
      changedLines: 60,
      toolCalls: 8,
      toolFailures: 0,
      turns: 5,
      writeCalls: 1,
      editCalls: 1,
      bashCalls: 0,
    };
    const armed: boolean[] = [];
    internal.eventBus.on("hook_armed", (d) => armed.push(d.armed));

    internal.refreshIdealReviewArmed();
    expect(armed).toEqual([true]);

    // And the real gate does fire once that turn is counted.
    internal.loopMonitor.stats.turns = 6;
    expect((await internal.getHookFollowUpMessages())?.[0]?.content).toContain("Ideal?");
  });

  it("stays disarmed while Ken owns autopilot verification", async () => {
    const cwd = makeWorkspace(["src/a.ts"]);
    const internal = makeReviewSession(cwd, ["src/a.ts"]);
    const armed: boolean[] = [];

    internal.setIdealReviewSuppressed(true);
    internal.eventBus.on("hook_armed", (d) => armed.push(d.armed));
    internal.refreshIdealReviewArmed();
    expect(armed).toEqual([]);
  });

  it("prioritizes the child completion gate before Ideal review", async () => {
    const session = new AgentSession({
      provider: "anthropic",
      model: "claude-sonnet-5",
      cwd: "/project",
      transient: true,
      systemPrompt: "test",
    });
    const internal = session as unknown as ReviewInternals;
    internal.settingsManager = { get: () => true };
    internal.subAgentManager = {
      completionGateMessage: () => "Collect child agent recovered-child before finishing.",
    };

    expect(await internal.getHookFollowUpMessages()).toEqual([
      {
        role: "user",
        content: "Collect child agent recovered-child before finishing.",
        provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
      },
    ]);
  });
});
