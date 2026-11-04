import { describe, expect, it } from "vitest";
import type { SidecarEvent } from "./agent";
import { INITIAL_ACTIVITY, reduceTaskActivity, type TaskActivity } from "./task-activity";

const event = (state: TaskActivity, type: string, data: Record<string, unknown> = {}) =>
  reduceTaskActivity(state, { type, data } as SidecarEvent, 1000);
const start = () => event(INITIAL_ACTIVITY, "run_start");
const tool = (state: TaskActivity, name: string, args = {}, isError = false) =>
  event(event(state, "tool_call_start", { toolCallId: "t", name, args }), "tool_call_end", {
    toolCallId: "t",
    isError,
  });
const turn = (verification = "not_recorded", changed = false) => ({
  verification,
  changed,
  verifiedChecks: verification === "passed" ? 1 : 0,
  reason: "",
});
const end = (state: TaskActivity, data: Record<string, unknown> = {}) =>
  event(state, "run_end", { verification: "not_recorded", turnVerification: turn(), ...data });

describe("request outcome matrix", () => {
  it.each(["passed", "failed", "incomplete"])(
    "separates a read-only answer from earlier %s verification",
    (verification) => {
      const state = end(start(), {
        verification,
        verifiedChecks: verification === "passed" ? 1 : 0,
      });
      expect(state.phase).toBe("done");
      expect(state.label).toBe("Response ready");
      expect(state.verifiedChecks).toBe(0);
      expect(state.workspaceWarning).toBe(
        verification === "failed"
          ? "Earlier checks failed"
          : verification === "incomplete"
            ? "Earlier work unchecked"
            : "",
      );
    },
  );

  it.each(["read", "grep", "find", "ls", "web_search", "web_fetch", "code_search", "code_nav"])(
    "uses findings, not a test verdict, after %s",
    (name) => {
      const state = end(tool(start(), name), { verification: "failed" });
      expect(state.label).toBe("Findings ready");
      expect(state.phase).toBe("done");
      expect(state.workspaceWarning).toBe("Earlier checks failed");
    },
  );

  it.each([
    "git status --short",
    "gh run list",
    "git commit -m change",
    "git push",
    "gh release view v1",
    "node script.mjs",
  ])("never invents checks or deployment from %s", (command) => {
    const state = end(tool(start(), "bash", { command }));
    expect(state.label).toBe("Tool work finished");
    expect(state.verification).toBe("not_recorded");
    expect(state.detail).toContain("does not confirm a release");
  });

  it.each(["generate_image", "screenshot", "skill", "tool_search", "mcp_custom_tool"])(
    "uses neutral results for %s without guessing its success claims",
    (name) => {
      const state = end(tool(start(), name));
      expect(state.label).toBe("Tool work finished");
      expect(state.verifiedChecks).toBe(0);
      expect(state.verification).toBe("not_recorded");
    },
  );

  it("does not blame an earlier turn for a current unconfirmed check", () => {
    const state = end(tool(start(), "bash", { run_in_background: true }), {
      verification: "incomplete",
      turnVerification: turn("incomplete"),
    });
    expect(state.phase).toBe("unverified");
    expect(state.workspaceWarning).toBe("");
  });

  it("never treats assistant prose as verification or release evidence", () => {
    const state = end(
      event(start(), "text_delta", { text: "All tests passed. Released and production ready!" }),
    );
    expect(state.label).toBe("Response ready");
    expect(state.verification).toBe("not_recorded");
  });

  it("calls out a background launch without saying the job completed", () => {
    expect(end(tool(start(), "bash", { run_in_background: true })).label).toBe(
      "Background work started",
    );
    expect(end(tool(start(), "bash", { run_in_background: true }, true)).label).toBe(
      "Response ready",
    );
  });

  it("does not require code tests for a confirmed non-code edit", () => {
    const state = end(tool(start(), "edit"));
    expect(state.label).toBe("Changes saved");
    expect(state.verification).toBe("not_recorded");
  });

  it.each(["failed", "incomplete", "passed", "not_recorded"])(
    "judges current code edits with %s evidence",
    (verification) => {
      const state = end(tool(start(), "edit"), {
        verification,
        verifiedChecks: verification === "passed" ? 1 : 0,
        turnVerification: turn(verification, true),
      });
      // Only a host "incomplete" (an Autopilot cycle's check) is unverified;
      // unchecked edits in a plain reply wait for the commit.
      expect(state.phase).toBe(
        verification === "failed"
          ? "failed"
          : verification === "incomplete"
            ? "unverified"
            : "done",
      );
      expect(state.workspaceWarning).toBe("");
    },
  );

  it("shows new passing checks without hiding older different failed checks", () => {
    const state = end(start(), { verification: "failed", turnVerification: turn("passed") });
    expect(state.label).toBe("Done · checks passed");
    expect(state.workspaceWarning).toBe("Earlier checks failed");
  });

  it("keeps code verification across Ken correction runs", () => {
    let state = end(tool(start(), "edit"), {
      verification: "passed",
      verifiedChecks: 1,
      turnVerification: turn("passed", true),
      reviewPending: true,
    });
    state = event(state, "autopilot_prompted");
    state = event(state, "run_start", { continued: true });
    state = end(state, { verification: "passed", verifiedChecks: 1 });
    expect(state.label).toBe("Done · checks passed");
    state = end(event(state, "run_start"), { verification: "passed", verifiedChecks: 1 });
    expect(state.label).toBe("Response ready");
  });

  it.each([
    ["run_end", { cancelled: true }, "stopped", "Stopped · unfinished"],
    ["run_end", { failed: true }, "failed", "Task failed"],
    ["truncated", {}, "unverified", "Response incomplete"],
    ["max_turns", {}, "unverified", "Response incomplete"],
    ["plan_progress", { total: 3, completed: [1] }, "unverified", "Plan incomplete"],
    [
      "subagent_state",
      { agent_id: "worker", state: "running" },
      "unverified",
      "Agents still running",
    ],
    ["ask_user", {}, "attention", "Your decision needed"],
    ["plan_exit", {}, "attention", "Plan needs your decision"],
  ] as const)(
    "retains %s outcomes instead of replacing them with green checks",
    (type, data, phase, label) => {
      const state = end(event(start(), type, data), {
        verification: "passed",
        verifiedChecks: 1,
        turnVerification: turn("passed"),
      });
      expect(state.phase).toBe(phase);
      expect(state.label).toBe(label);
    },
  );

  it.each([
    ["autopilot_error", "failed"],
    ["autopilot_capped", "stopped"],
    ["autopilot_human", "attention"],
  ] as const)("keeps %s distinct from verification", (type, phase) => {
    const state = event(end(start(), { reviewPending: true }), type);
    expect(state.phase).toBe(phase);
    expect(state.reviewPending).toBe(false);
  });

  it("does not let a malformed turn payload erase failed workspace evidence", () => {
    expect(
      end(start(), { verification: "failed", turnVerification: { verification: "passed" } }).phase,
    ).toBe("failed");
  });
});
