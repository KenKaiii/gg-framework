import { describe, expect, it } from "vitest";
import {
  MAX_CHANGE_LINES,
  describeResize,
  interactiveLines,
  snapshotChanges,
} from "./browser-snapshot.js";

describe("browser page-change summaries", () => {
  it("reports added, removed and updated elements with refs", () => {
    const before = [
      '- textbox "Email" [ref=e3]',
      '- button "Save" [ref=e4]',
      "- paragraph [ref=e6]: Loading…",
    ].join("\n");
    const after = [
      '- textbox "Email" [ref=e3]: a@b.co',
      '- button "Save" [ref=e4]',
      "- paragraph [ref=e6]: Welcome",
      '- link "Sign out" [ref=e9]',
    ].join("\n");
    expect(snapshotChanges(before, after)).toEqual([
      '~ textbox "Email" [ref=e3]: a@b.co',
      "~ paragraph [ref=e6]: Welcome",
      '+ link "Sign out" [ref=e9]',
    ]);
    expect(snapshotChanges(after, before)).toContain('- link "Sign out"');
  });

  it("ignores focus moves and unnamed containers", () => {
    expect(snapshotChanges('- button "Go" [ref=e1]', '- button "Go" [active] [ref=e1]')).toEqual(
      [],
    );
    expect(snapshotChanges("- generic [ref=e1]", "")).toEqual([]);
  });

  it("caps long change lists", () => {
    const after = Array.from({ length: 50 }, (_, i) => `- button "B${i}" [ref=e${i}]`).join("\n");
    const lines = snapshotChanges("", after);
    expect(lines).toHaveLength(MAX_CHANGE_LINES + 1);
    expect(lines.at(-1)).toMatch(/20 more changes/);
  });

  it("lists only controls for the interactive view", () => {
    const snap = [
      '- heading "Todos" [level=1]',
      '  - button "Add" [ref=e2]',
      "  - text: hello",
    ].join("\n");
    expect(interactiveLines(snap)).toBe('- button "Add" [ref=e2]');
  });
});

describe("resize summaries", () => {
  it("names what the new size hides and shows", () => {
    const changes = snapshotChanges(
      '- button "Save list" [ref=e4]\n- button "Add" [ref=e5]',
      '- button "Add" [ref=e5]\n- button "Menu" [ref=e9]',
    );
    expect(describeResize(changes, "390×844")).toBe(
      'No longer visible at 390×844:\nbutton "Save list"\nNow visible at 390×844:\nbutton "Menu" [ref=e9]',
    );
    expect(describeResize([], "390×844")).toBe("Nothing appeared or disappeared at 390×844.");
  });
});
