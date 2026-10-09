import { describe, expect, it } from "vitest";
import type { SidecarEvent } from "./agent";
import { INITIAL_ACTIVITY, reduceTaskActivity, type TaskActivity } from "./task-activity";
const event = (s: TaskActivity, type: string, data: Record<string, unknown> = {}, now = 1000) =>
  reduceTaskActivity(s, { type, data } as SidecarEvent, now);
const start = () => event(INITIAL_ACTIVITY, "run_start", {}, 100);
const edit = (s: TaskActivity) =>
  event(event(s, "tool_call_start", { name: "edit", toolCallId: "edit-1" }), "tool_call_end", {
    toolCallId: "edit-1",
    isError: false,
  });

describe("whole-task activity", () => {
  it.each([
    ["failed", "failed"],
    ["incomplete", "unverified"],
  ] as const)("settles a blocked review when verification is %s", (verification, phase) => {
    const ended = event(start(), "run_end", {
      failed: false,
      unverified: true,
      reviewPending: true,
      verification,
      verifiedChecks: 0,
      verificationReason: "The verification gate blocked review.",
    });
    expect(ended.phase).toBe(phase);
    expect(ended.reviewPending).toBe(false);
    expect(ended.endedAt).toBe(1000);
    expect(ended.detail).toContain("The verification gate blocked review.");
  });
  it("recovers a live run or review after reconnect without inventing an outcome", () => {
    const s = event(start(), "connection_lost");
    expect(s.label).toBe("Reconnecting…");
    expect(event(s, "thinking_delta")).toBe(s);
    const resumed = event(s, "ready", { running: true });
    expect(resumed.connectionLost).toBe(false);
    expect(event(resumed, "thinking_delta").label).toBe("Thinking…");
    const review = event(s, "ready", { running: false, reviewPending: true });
    expect(review.phase).toBe("reviewing");
    expect(review.label).toBe("Ken reviewing…");
    const lostResult = event(s, "ready", { running: false });
    expect(lostResult.phase).toBe("stopped");
    expect(lostResult.connectionLost).toBe(false);
  });

  it("replaces the previous outcome when reconnect finds a new live run", () => {
    const done = event(start(), "run_end", { verification: "passed", verifiedChecks: 1 });
    const resumed = event(done, "ready", { running: true });
    expect(resumed.phase).toBe("working");
    expect(resumed.verification).toBe("not_recorded");
    expect(resumed.endedAt).toBeNull();
  });

  it("cannot turn a turn limit or unfinished plan into a clean finish", () => {
    for (const s of [
      event(start(), "max_turns", { totalTurns: 20, maxTurns: 20 }),
      event(start(), "plan_progress", { total: 3, completed: [1, 1, 99] }),
    ]) {
      const ended = event(s, "run_end", {
        verification: "passed",
        verifiedChecks: 1,
        reviewPending: true,
      });
      expect(event(ended, "autopilot_done").phase).toBe("unverified");
    }
    let complete = event(start(), "plan_progress", { total: 2, completed: [1, 2] });
    complete = event(complete, "truncated", { reason: "max_tokens", continued: true });
    expect(event(complete, "run_end", { verification: "passed", verifiedChecks: 1 }).phase).toBe(
      "done",
    );
  });

  it("cannot claim completion while a child agent is still running", () => {
    let s = event(start(), "subagent_state", { agent_id: "child", state: "running" });
    expect(s.label).toBe("Agents working…");
    s = event(s, "run_end", { verification: "passed", verifiedChecks: 1 });
    expect(s.phase).toBe("unverified");
    expect(s.label).toBe("Agents still running");
    s = event(s, "subagent_state", { agent_id: "child", state: "completed" });
    expect(s.phase).toBe("unverified");
    expect(s.label).toBe("Review agent results");
  });

  it("keeps a retry from overwriting a user decision and resumes after a failed stop", () => {
    const question = event(start(), "ask_user");
    expect(event(question, "retry")).toBe(question);
    expect(event(start(), "retry", { silent: true }).label).toBe("Working on your request…");
    const failedStop = event(event(start(), "run_cancelling"), "cancel_failed");
    expect(failedStop.cancelling).toBe(false);
    expect(event(failedStop, "thinking_delta").label).toBe("Thinking…");
  });

  it("never calls an interrupted response complete just because checks passed", () => {
    const s = event(start(), "truncated", { reason: "max_tokens", continued: false });
    const finished = event(s, "run_end", { verification: "passed", verifiedChecks: 1 });
    expect(finished.phase).toBe("unverified");
    expect(finished.label).toBe("Response incomplete");
  });

  it("shows retries and native tools instead of stale thinking", () => {
    let s = event(start(), "thinking_delta");
    s = event(s, "retry", { reason: "rate_limit", attempt: 1, delayMs: 1000 });
    expect(s.label).toBe("Retrying…");
    s = event(s, "server_tool_call", { id: "search", name: "web_search" });
    expect(s.label).toBe("Checking references…");
  });

  it("does not let late progress reopen a stopped task", () => {
    const s = event(start(), "run_end", { cancelled: true });
    for (const type of [
      "tool_call_start",
      "compaction_start",
      "autopilot_done",
      "autopilot_prompted",
      "run_cancelling",
      "cancel_failed",
    ]) {
      expect(event(s, type, { name: "read" })).toBe(s);
    }
    expect(event(s, "run_start", { continued: true })).toBe(s);
    expect(event(s, "run_start").phase).toBe("working");
  });

  it("keeps stopping visible until cancellation settles", () => {
    const s = event(start(), "run_cancelling");
    expect(event(s, "thinking_delta").label).toBe("Stopping the task…");
  });

  it("distinguishes thinking from writing and keeps wording stable within each span", () => {
    let s = start();
    expect(s.label).toBe("Working on your request…");
    const thinking = new Set<string>();
    const writing = new Set<string>();
    for (let i = 0; i < 3; i++) {
      s = event(s, "thinking_delta", { text: "Reasoning" });
      thinking.add(s.label);
      expect(s.phase).toBe("working");
      expect(s.label).toMatch(/Thinking|Reasoning/);
      expect(event(s, "thinking_delta", { text: " more reasoning" })).toBe(s);
      s = event(s, "text_delta", { text: "Response" });
      writing.add(s.label);
      expect(s.label).toMatch(/response/);
      expect(event(s, "text_delta", { text: " more response" })).toBe(s);
    }
    expect(thinking.size).toBe(3);
    expect(writing.size).toBe(3);
  });

  it("rotates working and thinking wording across requests in the same session", () => {
    let s = INITIAL_ACTIVITY;
    const working = new Set<string>();
    const thinking = new Set<string>();
    for (let i = 0; i < 3; i++) {
      s = event(s, "run_start");
      working.add(s.label);
      s = event(s, "thinking_delta");
      thinking.add(s.label);
      s = event(s, "run_end");
    }
    expect(working.size).toBe(3);
    expect(thinking.size).toBe(3);
    expect(event(s, "session_reset").phraseCounts).toEqual({});
  });

  it("shows tool work instead of thinking and rotates wording on new tool-work spans", () => {
    let s = start();
    const reading = new Set<string>();
    for (let i = 0; i < 3; i++) {
      s = event(s, "thinking_delta");
      s = event(s, "tool_call_start", { name: "read" });
      reading.add(s.label);
      expect(s.label).toMatch(/code/);
      expect(event(s, "tool_call_start", { name: "grep" }).label).toBe(s.label);
    }
    expect(reading.size).toBe(3);
  });

  it("does not let late thinking overwrite review or a terminal outcome", () => {
    for (const settled of [
      event(start(), "run_end", { reviewPending: true }),
      event(start(), "run_end", { cancelled: true }),
      event(start(), "run_end", { failed: true }),
      event(start(), "run_end"),
      INITIAL_ACTIVITY,
    ]) {
      expect(event(settled, "thinking_delta")).toBe(settled);
    }
  });

  it("grounds progress in tools, not made-up progress percentages", () => {
    let s = start();
    s = event(s, "tool_call_start", { name: "read" });
    expect(s.label).toBe("Reading the relevant code…");
    s = event(s, "tool_call_start", { name: "bash", args: { command: "pnpm test" } });
    expect(s.label).toBe("Running checks…");
    s = event(s, "tool_call_start", { name: "bash", args: { command: "git status" } });
    expect(s.label).toBe("Running a command…");
    expect(event(s, "run_end").verification).toBe("not_recorded");
  });
  it("never paints Done between the builder and Ken", () => {
    const s = event(edit(start()), "run_end", {
      reviewPending: true,
      verification: "passed",
      verifiedChecks: 1,
    });
    expect(s.phase).toBe("reviewing");
    expect(s.label).not.toContain("Done");
    const reviewing = event(s, "autopilot_review_start");
    expect(reviewing.label).toBe("Ken reviewing…");
    const done = event(reviewing, "autopilot_done");
    expect(done.label).toBe("Done · checks passed");
    expect(done.detail).toContain("Ken reviewed");
  });
  it("keeps corrections within one task and includes review usage without double counting", () => {
    let s = event(start(), "turn_end", { usage: { outputTokens: 40 } });
    s = event(s, "agent_done", { totalUsage: { outputTokens: 40 } });
    s = event(s, "run_end", { reviewPending: true });
    s = event(s, "autopilot_usage", { outputTokens: 20 });
    s = event(s, "autopilot_prompted");
    s = event(s, "run_start", { continued: true }, 400);
    expect(s.startedAt).toBe(100);
    expect(s.label).toBe("Applying Ken’s corrections…");
    s = event(s, "agent_done", { totalUsage: { outputTokens: 30 } });
    expect(s.tokens).toBe(90);
    expect(event(s, "run_start", {}, 900).tokens).toBe(0);
  });
  it("does not invent passing checks from a command, approval, or assistant prose", () => {
    let s = edit(start());
    s = event(s, "text_delta", { text: "All tests passed. Everything is perfect." });
    s = event(s, "run_end", { reviewPending: true });
    s = event(s, "autopilot_done");
    // Unchecked edits are saved work (checks run at commit), never "passed".
    expect(s.label).toBe("Changes saved");
    expect(s.verification).toBe("not_recorded");
    expect(s.detail).toContain("No automated checks were recorded");
    const zeroChecks = event(edit(start()), "run_end", {
      verification: "passed",
      verifiedChecks: 0,
    });
    expect(zeroChecks.label).toBe("Changes saved");
    expect(zeroChecks.verification).toBe("not_recorded");
  });
  it("retains cancellation, errors, and limit stops rather than turning ready", () => {
    for (const [type, data, phase] of [
      ["run_end", { cancelled: true }, "stopped"],
      ["run_end", { failed: true }, "failed"],
      ["autopilot_capped", {}, "stopped"],
      ["autopilot_error", {}, "failed"],
    ] as const) {
      const s = event(start(), type, data);
      expect(s.phase).toBe(phase);
      expect(event(s, "autopilot_ignored").phase).toBe(phase);
    }
    const errored = event(start(), "error", { headline: "Provider unavailable" });
    expect(event(errored, "run_end").phase).toBe("failed");
  });
  it("a failed write does not claim changes were made", () => {
    const s = event(
      event(start(), "tool_call_start", { name: "write", toolCallId: "w" }),
      "tool_call_end",
      { toolCallId: "w", isError: true },
    );
    expect(s.changed).toBe(false);
  });
  it("pending questions survive unrelated tool events and run settlement", () => {
    let s = event(start(), "tool_call_start", { name: "ask_user", toolCallId: "question" });
    s = event(s, "ask_user");
    s = event(s, "tool_call_start", { name: "read", toolCallId: "other" });
    s = event(s, "tool_call_end", { toolCallId: "other" });
    s = event(s, "run_end");
    expect(s.phase).toBe("attention");
    expect(s.detail).toContain("Answer the question");
    expect(event(s, "tool_call_end", { toolCallId: "question" }).phase).toBe("working");
  });
  it("resumes an MCP question when the main agent responds, without clearing it on a sibling tool", () => {
    let s = event(start(), "ask_user");
    s = event(s, "tool_call_start", { name: "read", toolCallId: "sibling" });
    s = event(s, "tool_call_end", { toolCallId: "sibling" });
    expect(s.phase).toBe("attention");
    s = event(s, "text_delta", { text: "Continuing after the answer." });
    expect(s.phase).toBe("working");
    expect(s.waitingForAnswer).toBe(false);
  });

  it("distinguishes manual plan approval from automatic review", () => {
    const s = event(start(), "plan_exit");
    expect(event(s, "run_end").phase).toBe("attention");
    const reviewing = event(s, "run_end", { reviewPending: true });
    expect(reviewing.phase).toBe("reviewing");
    expect(event(reviewing, "session_reset", { planTotal: 2 }).startedAt).toBe(100);
    expect(event(reviewing, "autopilot_plan_accepted").label).toContain("preparing implementation");
  });
  it("shows skipped reviews honestly and preserves available evidence", () => {
    const s = event(start(), "run_end", {
      reviewPending: true,
      verification: "passed",
      verifiedChecks: 2,
    });
    const done = event(s, "autopilot_ignored");
    expect(done.phase).toBe("done");
    expect(done.reviewed).toBe(false);
    expect(done.detail).toContain("Ken did not review");
    expect(done.detail).toContain("2 passing checks");
  });
  it("keeps a reviewer limitation in the details", () => {
    const s = event(start(), "run_end", { reviewPending: true });
    expect(
      event(s, "autopilot_done", { reason: "Corpus comparison unavailable" }).detail,
    ).toContain("Corpus comparison unavailable");
  });
  it("resets on a project/session change and does not claim completion after a disconnect", () => {
    expect(event(start(), "session_reset").phase).toBe("idle");
    const s = event(INITIAL_ACTIVITY, "ready", { cwd: "/one", running: true });
    expect(event(s, "ready", { cwd: "/one", running: false }).phase).toBe("stopped");
    expect(event(s, "ready", { cwd: "/two", running: false }).phase).toBe("idle");
  });
  it("presents a verification-gate stop as failed checks rather than a product decision", () => {
    const s = event(edit(start()), "run_end", {
      reviewPending: true,
      verification: "failed",
      verificationReason: "pnpm test failed",
    });
    const failed = event(s, "autopilot_human", {
      reason: "Verification gate stopped: pnpm test failed",
    });
    expect(failed.label).toBe("Checks failed");
    expect(failed.detail).toContain("pnpm test failed");
    expect(event(start(), "autopilot_human", { reason: "Choose a payment provider" }).phase).toBe(
      "attention",
    );
  });

  it("does not let Ken approval hide failed or stale evidence", () => {
    for (const verification of ["failed", "incomplete"]) {
      const s = event(edit(start()), "run_end", { reviewPending: true, verification });
      expect(event(s, "autopilot_done").phase).toBe(
        verification === "failed" ? "failed" : "unverified",
      );
    }
  });
});
