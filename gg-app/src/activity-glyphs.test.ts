import { describe, expect, it } from "vitest";
import { activityGlyph } from "./activity-glyphs";
import { ACTIVITY_GLYPHS, glyphPath } from "./pixel-glyphs";
import { PROGRESS_PHRASES } from "./task-activity";

describe("activityGlyph", () => {
  it("gives every phrase in a progress pool its pool's own glyph", () => {
    const expected: Record<string, string> = {
      "Thinking…": "think",
      "Working on your request…": "work",
      "Writing a response…": "write",
      "Reading the relevant code…": "read",
      "Making the changes…": "edit",
      "Checking references…": "web",
      "Running checks…": "check",
      "Running a command…": "run",
    };
    expect(Object.keys(PROGRESS_PHRASES).sort()).toEqual(Object.keys(expected).sort());
    for (const [base, phrases] of Object.entries(PROGRESS_PHRASES))
      for (const phrase of phrases) expect(activityGlyph(phrase, "working")).toBe(expected[base]);
  });

  it.each([
    ["Inspecting the app…", "working", "inspect"],
    ["Stepping through the code…", "working", "debug"],
    ["Coordinating agent work…", "working", "agents"],
    ["Checking background work…", "working", "background"],
    ["Ken reviewing…", "reviewing", "review"],
    ["Keeping the task context…", "working", "context"],
    ["Retrying…", "working", "retry"],
    ["Reconnecting…", "working", "reconnect"],
    ["Stopping the task…", "working", "stop"],
    ["Plan needs your decision", "attention", "plan"],
    ["Your decision needed", "attention", "ask"],
    ["Done · checks passed", "done", "done"],
    ["Changes saved", "done", "edit"],
    ["Response ready", "done", "write"],
    ["Findings ready", "done", "read"],
    ["Tool work finished", "done", "run"],
    ["Background work started", "done", "background"],
    ["Checks failed", "failed", "check"],
    ["Task failed", "failed", "fail"],
    ["Ken’s review failed", "failed", "fail"],
    ["Verification incomplete", "unverified", "check"],
    ["Changed · verification incomplete", "unverified", "check"],
    ["Response incomplete", "unverified", "write"],
    ["Plan incomplete", "unverified", "plan"],
    ["Agents still running", "unverified", "agents"],
    ["Paused · review limit reached", "stopped", "review"],
    ["Stopped · unfinished", "stopped", "stop"],
  ] as const)("shows %s (%s) as %s", (label, phase, glyph) => {
    expect(activityGlyph(label, phase)).toBe(glyph);
  });

  it("keeps the tick for passing checks alone, whatever a finished run says", () => {
    for (const label of ["Response ready", "Changes saved", "Something new"])
      expect(activityGlyph(label, "done")).not.toBe("done");
  });

  it("keeps every glyph small enough for its 22px well", () => {
    for (const [name, rows] of Object.entries(ACTIVITY_GLYPHS)) {
      expect(rows.length, name).toBeLessThanOrEqual(7);
      expect(Math.max(...rows.map((r) => r.length)), name).toBeLessThanOrEqual(7);
      expect(glyphPath(rows), name).not.toBe("");
    }
  });
});
