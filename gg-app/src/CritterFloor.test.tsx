// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CritterFloor as StagedCritterFloor,
  collectFloorAgents,
  type CritterGroup,
} from "./CritterFloor";
import type { SubAgentLine } from "./SubAgentFeed";
import { art } from "./critter-art";
import { TERRAIN_CLOSE_MS } from "./critter-terrain";

/** Leavers are gathered for a moment (so a group goes together), then the
 *  goodbye + beam-out (~2.3s in all), then the lane waits for the terrain to
 *  pack away before it shuts. */
const LEAVE_AND_CLOSE_MS = 2400 + TERRAIN_CLOSE_MS;

// The engine, with the stage held to the classic beam in and out and nothing
// happening by itself: what these tests time. The stage's own arrivals, exits
// and happenings are covered in critter-stage.test.ts.
const CLASSIC = { arrival: "beam", exit: "beam", happenings: false } as const;
function CritterFloor(props: Parameters<typeof StagedCritterFloor>[0]): React.ReactElement {
  return <StagedCritterFloor stage={CLASSIC} {...props} />;
}

// jsdom has no Web Animations API; the floor only needs the calls to exist.
beforeAll(() => {
  const fakeAnimation = (): Animation =>
    ({
      finished: Promise.resolve(),
      cancel: () => undefined,
      onfinish: null,
    }) as unknown as Animation;
  Element.prototype.animate = vi.fn(fakeAnimation) as unknown as Element["animate"];
  Element.prototype.getAnimations = vi.fn(() => []) as unknown as Element["getAnimations"];
});

// These tests act out the animated floor of the window the user is looking
// at; jsdom reports an unfocused document, which the floor treats as resting.
let windowFocused = true;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  windowFocused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => windowFocused);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function line(
  id: string,
  status: SubAgentLine["status"],
  extra?: Partial<SubAgentLine>,
): SubAgentLine {
  return {
    toolCallId: id,
    agentName: "researcher",
    status,
    activities: [],
    toolUseCount: 0,
    tokenUsage: { input: 0, output: 0 },
    ...extra,
  };
}

const group = (id: number, agents: SubAgentLine[], aborted?: boolean): CritterGroup => ({
  id,
  agents,
  ...(aborted === undefined ? {} : { aborted }),
});

function lane(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".critter-lane");
  if (!el) throw new Error("lane missing");
  return el;
}
const critters = (container: HTMLElement): number => container.querySelectorAll(".critter").length;
/** The lane's children, bottom to top, by their first class. */
const layers = (container: HTMLElement): string[] =>
  [...lane(container).children].map((el) => el.classList[0] ?? "");
const terrain = (container: HTMLElement): string | undefined =>
  container.querySelector<HTMLElement>(".critter-lane > .critter-terrain")?.dataset.terrain;

describe("collectFloorAgents", () => {
  it("flattens groups, keys by group + call id, and marks aborted runners interrupted", () => {
    const agents = collectFloorAgents([
      group(1, [line("a", "done", { durationMs: 1000 })]),
      group(2, [line("a", "running", { activities: ["Read x", "Grep y"] })], true),
    ]);
    expect(agents.map((a) => [a.key, a.status, a.activity])).toEqual([
      ["1:a", "done", undefined],
      ["2:a", "interrupted", "Grep y"],
    ]);
    expect(agents[0]?.label).toBe("researcher");
  });
});

describe("CritterFloor", () => {
  it("summons a critter for a running agent, then teleports it out when done", async () => {
    const { container, rerender } = render(<CritterFloor groups={[]} />);
    expect(lane(container).classList.contains("open")).toBe(false);

    const running = group(1, [line("a", "running")]);
    rerender(<CritterFloor groups={[running]} />);
    expect(lane(container).classList.contains("open")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(critters(container)).toBe(1);
    expect(lane(container).getAttribute("aria-hidden")).toBe("true");

    rerender(<CritterFloor groups={[group(1, [line("a", "done")])]} />);
    expect(container.querySelector(".critter.leaving")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LEAVE_AND_CLOSE_MS);
    });
    expect(critters(container)).toBe(0);
    expect(lane(container).classList.contains("open")).toBe(false);
  });

  it("lets the ground rise before the first critter lands, and sink before the lane shuts", async () => {
    const { container, rerender } = render(<CritterFloor groups={[]} />);
    rerender(<CritterFloor groups={[group(1, [line("a", "running")])]} />);
    expect(lane(container).classList.contains("open")).toBe(true);
    // The ground is still rising: nobody beamed in yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(critters(container)).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(critters(container)).toBe(1);

    // Last one out: the lane stays open but marks itself closing (the terrain
    // packs away), long enough for the whole sequence, then shuts.
    rerender(<CritterFloor groups={[group(1, [line("a", "done")])]} />);
    let closingMs = 0;
    for (let i = 0; i < 80 && lane(container).classList.contains("open"); i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      if (lane(container).classList.contains("closing")) {
        closingMs += 50;
        expect(critters(container)).toBe(0);
      }
    }
    expect(closingMs).toBeGreaterThanOrEqual(TERRAIN_CLOSE_MS - 50);
    expect(lane(container).classList.contains("open")).toBe(false);
    expect(lane(container).classList.contains("closing")).toBe(false);

    // A new agent mid-close turns it straight back around.
    rerender(
      <CritterFloor groups={[group(1, [line("a", "done")]), group(2, [line("b", "running")])]} />,
    );
    expect(lane(container).classList.contains("open")).toBe(true);
    expect(lane(container).classList.contains("closing")).toBe(false);
  });

  it("stands the critters on a terrain, and rolls a different one each time the lane reopens", async () => {
    const roll = (): number => 0;
    const { container, rerender } = render(<CritterFloor groups={[]} random={roll} />);
    const first = terrain(container);
    expect(first).toBeDefined();
    // Painted over its horizon, and before (under) the floor the engine appends.
    expect(layers(container)).toEqual(["critter-backdrop", "critter-terrain", "critter-floor"]);

    // First opening keeps the terrain that was already there.
    rerender(<CritterFloor groups={[group(1, [line("a", "running")])]} random={roll} />);
    expect(terrain(container)).toBe(first);
    rerender(<CritterFloor groups={[group(1, [line("a", "done")])]} random={roll} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LEAVE_AND_CLOSE_MS);
    });
    expect(lane(container).classList.contains("open")).toBe(false);
    expect(terrain(container)).toBe(first);

    // Reopening for the next sub-agent swaps in a new one.
    rerender(
      <CritterFloor
        groups={[group(1, [line("a", "done")]), group(2, [line("b", "running")])]}
        random={roll}
      />,
    );
    expect(lane(container).classList.contains("open")).toBe(true);
    expect(terrain(container)).toBeDefined();
    expect(terrain(container)).not.toBe(first);
    expect(layers(container)).toEqual(["critter-backdrop", "critter-terrain", "critter-floor"]);
  });

  it("teleports out a background agent that finishes as idle, and tips a failed one over", async () => {
    const { container, rerender } = render(
      <CritterFloor groups={[group(1, [line("a", "running"), line("b", "running")])]} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(critters(container)).toBe(2);

    rerender(<CritterFloor groups={[group(1, [line("a", "idle"), line("b", "error")])]} />);
    // A tick over the one that finished, a cross over the one that failed.
    const emote = (state: string): string | null | undefined =>
      container.querySelector(`.critter.${state} .critter-emote img`)?.getAttribute("src");
    expect(emote("leaving")).toBe(art().emotes.ok.url);
    expect(emote("fallen")).toBe(art().emotes.no.url);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LEAVE_AND_CLOSE_MS);
    });
    expect(critters(container)).toBe(0);
    expect(lane(container).classList.contains("open")).toBe(false);
  });

  it("in a background window, lands and clears agents at once and shuts the empty lane", async () => {
    windowFocused = false;
    const { container, rerender } = render(
      <CritterFloor groups={[group(1, [line("a", "running"), line("b", "running")])]} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(critters(container)).toBe(2);
    expect(container.querySelector(".critter.summoning")).toBeNull();

    rerender(<CritterFloor groups={[group(1, [line("a", "idle"), line("b", "error")])]} />);
    expect(critters(container)).toBe(0);
    expect(lane(container).classList.contains("open")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("summons an idle agent back when a follow-up sets it running again", async () => {
    const { container, rerender } = render(
      <CritterFloor groups={[group(1, [line("a", "running")])]} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    rerender(<CritterFloor groups={[group(1, [line("a", "idle")])]} />);
    // The follow-up lands while it is still waving goodbye.
    rerender(<CritterFloor groups={[group(1, [line("a", "running")])]} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(critters(container)).toBe(1);
    expect(container.querySelector(".critter.leaving")).toBeNull();
  });

  it("never summons agents that were already finished (resumed history)", async () => {
    const { container } = render(
      <CritterFloor
        groups={[group(1, [line("a", "done"), line("b", "error"), line("c", "idle")])]}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(critters(container)).toBe(0);
    expect(lane(container).classList.contains("open")).toBe(false);
  });

  it("acts out real tool activity with a prop, and clears it when the agent finishes", async () => {
    const run = (activities: string[], toolUseCount: number): CritterGroup =>
      group(1, [line("a", "running", { activities, toolUseCount })]);
    const { container, rerender, unmount } = render(<CritterFloor groups={[run([], 0)]} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(critters(container)).toBe(1);

    rerender(<CritterFloor groups={[run(["Reading src/auth/session.ts"], 1)]} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    // Every read variant puts a book, scroll or page in its paws/on the floor.
    expect(container.querySelector(".critter-prop")).not.toBeNull();
    // No tool text in a speech bubble; its name tag has it (shortened) instead.
    expect(container.querySelector(".critter-bubble")?.textContent ?? "").not.toContain(
      "session.ts",
    );
    const critter = container.querySelector(".critter");
    if (!critter) throw new Error("no critter");
    fireEvent.mouseEnter(critter);
    expect(container.querySelector(".critter-tag-name")?.textContent).toBe("researcher");
    expect(container.querySelector(".critter-tag-text")?.textContent).toBe("Reading session.ts");
    fireEvent.mouseLeave(critter);
    expect(container.querySelector(".critter-tag")).toBeNull();

    // A different tool kind (read → search) queues behind the current action.
    rerender(
      <CritterFloor groups={[run(["Reading src/auth/session.ts", "grep: refreshToken"], 2)]} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(critters(container)).toBe(1);

    rerender(<CritterFloor groups={[group(1, [line("a", "done", { toolUseCount: 2 })])]} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(critters(container)).toBe(0);
    expect(container.querySelector(".critter-prop")).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps living through a long quiet run (thinks, fidgets) without leaking timers", async () => {
    const { container, unmount } = render(
      <CritterFloor
        groups={[group(1, [line("a", "running"), line("b", "running"), line("c", "running")])]}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(critters(container)).toBe(3);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("brings working critters straight back when the chat is shown again, with no summon", async () => {
    // A goal window hides the chat behind its Workers view with <Activity>,
    // which tears down the floor's effects; going back rebuilt it and beamed
    // every working critter in again.
    const { Activity } = await import("react");
    const working = [group(1, [line("a", "running"), line("b", "running")])];
    const view = (shown: boolean) => (
      <Activity mode={shown ? "visible" : "hidden"}>
        <CritterFloor groups={working} />
      </Activity>
    );
    const { container, rerender } = render(view(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(critters(container)).toBe(2);
    const ground = terrain(container);

    rerender(view(false));
    rerender(view(true));
    // Back at once: no wait for the ground to rise, no beam, same terrain.
    expect(critters(container)).toBe(2);
    expect(container.querySelectorAll(".critter.summoning")).toHaveLength(0);
    expect(container.querySelector(".critter-beam")).toBeNull();
    expect(lane(container).classList.contains("open")).toBe(true);
    expect(terrain(container)).toBe(ground);

    // One that finished while the chat was hidden is gone, and a new one is
    // still summoned the usual way.
    rerender(
      <Activity mode="visible">
        <CritterFloor
          groups={[
            group(1, [line("a", "running"), line("b", "done")]),
            group(2, [line("c", "running")]),
          ]}
        />
      </Activity>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.querySelectorAll(".critter.summoning").length).toBeGreaterThan(0);
  });

  it("removes critters whose agents disappear (session switch) and cleans up on unmount", async () => {
    const { container, rerender, unmount } = render(
      <CritterFloor groups={[group(1, [line("a", "running")])]} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(critters(container)).toBe(1);
    rerender(<CritterFloor groups={[]} />);
    expect(critters(container)).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
