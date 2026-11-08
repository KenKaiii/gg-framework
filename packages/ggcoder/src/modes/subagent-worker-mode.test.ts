import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../core/agent-session.js";
import {
  addSharedRoots,
  classifyResolvedTurn,
  parseRootList,
  recoverTimedOutTurn,
  resolveTurnTimeLimit,
} from "./subagent-worker-mode.js";

type RecoverySession = Pick<AgentSession, "prompt" | "setSignal">;

afterEach(() => {
  vi.useRealTimers();
});

describe("addSharedRoots", () => {
  it("adds every shared root, skipping ones already covered or gone", async () => {
    // Kleio Goals' workers reach all of a goal's attached folders; one that has
    // since been removed must not stop the worker from starting.
    const addDirectory = vi.fn(async (dir: string) =>
      dir === "/goal/site"
        ? { ok: true as const, root: dir }
        : dir === "/goal/inside"
          ? { ok: false as const, error: `Already in the workspace: ${dir}` }
          : { ok: false as const, error: `Not found: ${dir}` },
    );
    const added = await addSharedRoots({ addDirectory }, ["/goal/site", "/goal/inside", "/gone"]);
    expect(added).toEqual(["/goal/site"]);
    expect(addDirectory).toHaveBeenCalledTimes(3);
  });
});

describe("parseRootList", () => {
  it("keeps only absolute folder paths from a parent frame", () => {
    const absolute = process.platform === "win32" ? "C:\\goal\\site" : "/goal/site";
    expect(parseRootList([absolute, "relative/dir", 42, null])).toEqual([absolute]);
    expect(parseRootList(undefined)).toEqual([]);
    expect(parseRootList("/goal/site")).toEqual([]);
  });
});

describe("classifyResolvedTurn", () => {
  const quiet = {
    aborted: false,
    abortReason: undefined,
    recoveredAfterTimeout: false,
    loopError: undefined,
  } as const;
  const LOOP_ERROR = "The model repeatedly issued invalid arguments for tool `read`.";

  it.each([
    ["a clean finish", quiet, { status: "completed" }],
    [
      "a loop that stopped on an error",
      { ...quiet, loopError: LOOP_ERROR },
      { status: "failed", error: LOOP_ERROR },
    ],
    [
      "an interrupt, even when the loop also reported an error",
      { ...quiet, aborted: true, abortReason: "interrupt", loopError: LOOP_ERROR },
      { status: "interrupted", error: "Interrupted" },
    ],
    [
      "an aborted signal with no recorded reason",
      { ...quiet, aborted: true },
      { status: "interrupted", error: "Interrupted" },
    ],
    [
      "a timeout whose recovery summary failed",
      { ...quiet, aborted: true, abortReason: "timeout", loopError: LOOP_ERROR },
      { status: "failed", error: "Timed out after 10 minutes; recovery summary failed" },
    ],
    [
      "a timeout under a shorter per-spawn limit, naming that limit",
      { ...quiet, aborted: true, abortReason: "timeout", timeLimitMs: 120_000 },
      { status: "failed", error: "Timed out after 2 minutes; recovery summary failed" },
    ],
    [
      "a timeout rescued by the recovery summary",
      { ...quiet, abortReason: "timeout", recoveredAfterTimeout: true },
      { status: "completed", recovered_after_timeout: true },
    ],
  ] as const)("settles %s", (_label, turn, expected) => {
    expect(classifyResolvedTurn(turn)).toEqual(expected);
  });
});

describe("resolveTurnTimeLimit", () => {
  it.each([
    ["no request", undefined, 600_000],
    ["a shorter limit", 120_000, 120_000],
    ["a longer limit, capped at the default", 3_600_000, 600_000],
    ["zero", 0, 600_000],
    ["a negative number", -5, 600_000],
    ["NaN", Number.NaN, 600_000],
    ["a numeric string", "120000", 600_000],
  ] as const)("resolves %s", (_label, requested, expected) => {
    expect(resolveTurnTimeLimit(requested)).toBe(expected);
  });
});

describe("subagent timeout recovery", () => {
  it("runs exactly one tools-disabled salvage turn and keeps its summary", async () => {
    let output = "research gathered before timeout\n";
    const setSignal = vi.fn();
    const prompt = vi.fn(async () => {
      output += "best available summary";
    });
    const session = { prompt, setSignal } as unknown as RecoverySession;
    let controller: AbortController | undefined;

    await expect(
      recoverTimedOutTurn(
        session,
        () => output,
        (next) => {
          controller = next;
        },
      ),
    ).resolves.toBe(true);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(
      expect.stringContaining("one final 60-second recovery turn"),
      { source: "runtime", kind: "completion_gate", visibility: "hidden" },
      { disableTools: true, capThinking: true },
    );
    expect(setSignal).toHaveBeenCalledOnce();
    expect(setSignal).toHaveBeenCalledWith(controller?.signal);
    expect(controller?.signal.aborted).toBe(false);
  });

  it("aborts the single salvage turn at exactly 60 seconds", async () => {
    vi.useFakeTimers();
    let activeSignal: AbortSignal | undefined;
    const setSignal = vi.fn((signal: AbortSignal) => {
      activeSignal = signal;
    });
    const prompt = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          activeSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const session = { prompt, setSignal } as unknown as RecoverySession;
    let settled = false;
    const recovery = recoverTimedOutTurn(
      session,
      () => "research",
      () => undefined,
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    expect(activeSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(recovery).resolves.toBe(false);
    expect(activeSignal?.aborted).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(expect.any(String), expect.any(Object), {
      disableTools: true,
      capThinking: true,
    });
  });
});
