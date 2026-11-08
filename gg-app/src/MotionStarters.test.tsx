// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MOTION_STARTERS } from "./motion-starters";
import { MotionStarters } from "./MotionStarters";

afterEach(() => {
  cleanup();
});

describe("MotionStarters", () => {
  it("offers plain, one-line from-scratch video ideas the user finishes in their own words", () => {
    // One chip per job skill; jobs without a job skill get no chip.
    expect(MOTION_STARTERS.map(({ label }) => label)).toEqual([
      "Make a product launch",
      "Make an app walkthrough",
      "Make a website video",
      "Make a before and after",
      "Make a developer tool video",
      "Make one like my example",
    ]);
    for (const { label, prompt, hint } of MOTION_STARTERS) {
      // Motion designs videos from scratch: every chip starts a new video, none edits one.
      expect(label).toMatch(/^Make /);
      expect(label).not.toMatch(/edit|logo reveal/i);
      // The agent owns design, quality and workflow; the chip only states the job.
      expect(prompt.length).toBeLessThan(60);
      expect(prompt).toMatch(/: $/);
      expect(prompt).not.toMatch(
        /skill|recipe|template|choreograph|render|mixkit|launch kit|30-second|new art direction/i,
      );
      // One everyday line on what the job is for, with no craft or tool terms.
      expect(hint.length).toBeGreaterThan(10);
      expect(hint.length).toBeLessThan(70);
      expect(hint).not.toMatch(/\n|skill|template|render|fps|easing|CTA|LUFS/i);
    }
  });
  it.each(MOTION_STARTERS)(
    "fills the composer with $label without submitting",
    ({ label, prompt, hint }) => {
      const onPick = vi.fn();
      const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
      render(
        <form onSubmit={onSubmit}>
          <MotionStarters onPick={onPick} />
        </form>,
      );

      expect(screen.getAllByRole("button")).toHaveLength(MOTION_STARTERS.length);
      expect(onPick).not.toHaveBeenCalled();
      const button = screen.getByRole("button", { name: label });
      expect(button.getAttribute("title")).toBe(hint);
      fireEvent.click(button);

      expect(onPick).toHaveBeenCalledOnce();
      expect(onPick).toHaveBeenCalledWith(prompt);
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );
});
