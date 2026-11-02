// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveTextStore } from "./live-text";
import type { Item, ShellItem } from "./transcript-item";

const agent = vi.hoisted(() => ({
  runShellCommand: vi.fn(async () => ({ ok: true as const })),
  cancelShellCommand: vi.fn(async () => {}),
  getShellTrust: vi.fn(async () => false),
  setShellTrust: vi.fn(async (trusted: boolean) => trusted),
}));
vi.mock("./agent", () => agent);

const { shellCommandFromInput, shellItemFromHistory, useShellRuns, withShellShared } =
  await import("./useShellRuns");

function setup() {
  let items: Item[] = [];
  let id = 0;
  const liveText = createLiveTextStore();
  const focusComposer = vi.fn();
  const hook = renderHook(() =>
    useShellRuns({
      setItems: (update) => {
        items = typeof update === "function" ? update(items) : update;
      },
      nextId: () => ++id,
      liveText,
      focusComposer,
      toast: vi.fn(),
    }),
  );
  const shell = (): ShellItem => {
    const row = items.find((it): it is ShellItem => it.kind === "shell");
    if (!row) throw new Error("no shell row");
    return row;
  };
  return { hook, shell, liveText, focusComposer, items: () => items };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shellCommandFromInput", () => {
  it("reads only a leading !", () => {
    expect(shellCommandFromInput("!git status ")).toBe("git status");
    expect(shellCommandFromInput("!")).toBe("");
    expect(shellCommandFromInput(" !ls")).toBeNull();
    expect(shellCommandFromInput("fix this!")).toBeNull();
  });
});

describe("useShellRuns", () => {
  it("asks first, and runs nothing until the user confirms", async () => {
    const { hook, shell, focusComposer } = setup();
    act(() => hook.result.current.submitShell("rm -rf build", "/p"));
    expect(shell()).toMatchObject({ status: "confirm", command: "rm -rf build", cwd: "/p" });
    expect(agent.runShellCommand).not.toHaveBeenCalled();

    await act(async () => hook.result.current.confirm(shell().id, "once"));
    expect(agent.runShellCommand).toHaveBeenCalledWith(shell().runId, "rm -rf build", true);
    expect(shell().status).toBe("running");
    expect(focusComposer).toHaveBeenCalled();
  });

  it("cancelling leaves a quiet row and never runs", () => {
    const { hook, shell } = setup();
    act(() => hook.result.current.submitShell("ls", "/p"));
    act(() => hook.result.current.confirm(shell().id, "cancel"));
    expect(shell().status).toBe("declined");
    expect(agent.runShellCommand).not.toHaveBeenCalled();
  });

  it("'Always allow' saves trust and later commands skip the question", async () => {
    const { hook, shell, items } = setup();
    act(() => hook.result.current.submitShell("ls", "/p"));
    await act(async () => hook.result.current.confirm(shell().id, "always"));
    expect(agent.setShellTrust).toHaveBeenCalledWith(true);
    expect(hook.result.current.shellTrusted).toBe(true);

    await act(async () => hook.result.current.submitShell("pwd", "/p"));
    const all = items();
    const second = all[all.length - 1] as ShellItem;
    expect(second.status).toBe("running");
    expect(agent.runShellCommand).toHaveBeenLastCalledWith(second.runId, "pwd", false);
  });

  it("streams output into the row and finishes it unshared", async () => {
    const { hook, shell, liveText } = setup();
    act(() => hook.result.current.submitShell("echo hi", "/p"));
    await act(async () => hook.result.current.confirm(shell().id, "once"));
    const { id, runId } = shell();
    act(() => {
      hook.result.current.handleShellEvent({
        type: "shell_output",
        data: { id: runId, chunk: "hi\n" },
      });
    });
    expect(liveText.get(id)).toBe("hi\n");
    act(() => {
      hook.result.current.handleShellEvent({
        type: "shell_end",
        data: { id: runId, exitCode: 0, durationMs: 120, cancelled: false },
      });
    });
    expect(shell()).toMatchObject({ status: "done", output: "hi\n", exitCode: 0, shared: false });
    expect(liveText.get(id)).toBeUndefined();
  });

  it("asks again when the project stopped trusting commands elsewhere", async () => {
    agent.runShellCommand.mockResolvedValueOnce({
      ok: false,
      error: "confirmation_required",
    } as never);
    const { hook, shell } = setup();
    agent.getShellTrust.mockResolvedValueOnce(true);
    await act(async () => hook.result.current.refreshShellTrust());
    await act(async () => hook.result.current.submitShell("ls", "/p"));
    expect(shell().status).toBe("confirm");
    expect(hook.result.current.shellTrusted).toBe(false);
  });
});

describe("sharing with the agent", () => {
  const done = (id: number, shared: boolean): ShellItem => ({
    kind: "shell",
    id,
    runId: `r${id}`,
    command: "ls",
    cwd: "/p",
    status: "done",
    output: "",
    shared,
  });

  it("marks finished output shared on the next message, leaving running ones", () => {
    const running: ShellItem = { ...done(3, false), status: "running" };
    const items: Item[] = [done(1, false), done(2, true), running];
    const next = withShellShared(items);
    expect(next.map((it) => (it as ShellItem).shared)).toEqual([true, true, false]);
    expect(withShellShared(next)).toBe(next);
  });

  it("a reopened window shows still-pending output as not yet shared", () => {
    const saved = {
      runId: "r1",
      command: "ls",
      cwd: "/p",
      exitCode: 0,
      durationMs: 5,
      cancelled: false,
      output: "a.ts",
      truncated: false,
    };
    expect(shellItemFromHistory(saved, 1, ["r1"]).shared).toBe(false);
    expect(shellItemFromHistory(saved, 1, [])).toMatchObject({ shared: true, restored: true });
  });
});
