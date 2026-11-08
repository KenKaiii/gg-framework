// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { WorkerList } from "./WorkerList";

afterEach(cleanup);

describe("WorkerList", () => {
  it("lists the coordinator, then each worker with its state and activity", () => {
    render(
      <WorkerList
        running
        waitingOnUser={false}
        liveTools={[{ toolCallId: "a", name: "spawn_agent", args: {}, status: "running" }]}
        groups={[
          {
            id: 1,
            agents: [
              {
                toolCallId: "t1",
                agentName: "researcher",
                status: "running",
                activities: ["Reading src/app.ts"],
                toolUseCount: 1,
              },
              { toolCallId: "t2", status: "error", activities: [], toolUseCount: 0 },
            ],
          },
        ]}
      />,
    );
    const rows = within(screen.getByRole("region", { name: "Workers" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent?.trim())).toEqual([
      "Kleio Goals WorkingBringing in help",
      "researcher WorkingReading src/app.ts",
      "Agent 2 StoppedStopped",
    ]);
    expect(screen.getAllByRole("img", { name: "Working" })).toHaveLength(2);
    expect(screen.getByRole("img", { name: "Stopped" })).toBeTruthy();
  });

  it("says when no workers have been brought in yet", () => {
    render(<WorkerList running={false} waitingOnUser liveTools={[]} groups={[]} />);
    expect(screen.getByRole("img", { name: "Waiting for you" })).toBeTruthy();
    expect(screen.getByText(/No workers yet/)).toBeTruthy();
  });
});
