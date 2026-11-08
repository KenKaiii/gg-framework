// What the goal's coordinator is doing right now, in a word or two, for the
// status pill (StatusPill). Derived from the window's live state only, so it
// can't drift from what's really happening; pure, so it's tested on its own.
// Ported from upstream's goal-ken-status.ts, without Ken's face and the farm's
// thought mark.
//
// It names moments the other notices already carry (a question, the end of a
// run) without repeating them: no question text, no score, no buttons.

import type { LiveToolEntry } from "../LiveToolPanel";
import type { Item } from "../transcript-item";
import type { GoalRun } from "./goal-finish";
import { coordinatorKind, type WorkerAgent } from "./worker-status";

/** How the pill is coloured. */
export type GoalStatusTone = "work" | "ask" | "paused" | "error" | "done" | "idle";

/** What kind of moment it is (upstream's medallion icon). */
export type GoalStatusIcon =
  | "read"
  | "search"
  | "edit"
  | "run"
  | "web"
  | "think"
  | "ask"
  | "delegate"
  | "wait"
  | "paused"
  | "error"
  | "done"
  | "idle";

export interface GoalStatus {
  /** Identity of the moment: a new key is a new step (its timer restarts). */
  readonly key: string;
  readonly tone: GoalStatusTone;
  readonly icon: GoalStatusIcon;
  /** One line, always shown ("Reading search.ts"). */
  readonly headline: string;
  /** What the headline doesn't say, shown when the pill opens; null when there's nothing more. */
  readonly detail: string | null;
  /** Opens by itself, without a hover: something went wrong. */
  readonly opens: boolean;
  /** Thinking between steps: a long one gets a reassuring note. */
  readonly thinking: boolean;
  /** Whether a timer for the moment is worth showing. */
  readonly timed: boolean;
}

/** How the goal's last run (seen live) ended, and why, if it failed. */
export interface LastRun {
  readonly outcome: GoalRun["outcome"];
  /** The run's error headline, when it failed. */
  readonly reason: string | null;
}

export interface GoalStatusInput {
  readonly running: boolean;
  /** The goal is paused (GoalPanel's pause). */
  readonly paused: boolean;
  /** A question waits on the user. */
  readonly waitingOnUser: boolean;
  /** The main run's recent tool calls, oldest first. */
  readonly liveTools: readonly LiveToolEntry[];
  /** The workers the coordinator brought in. */
  readonly workers: readonly WorkerAgent[];
  /** The last run seen live; null when none was (a reopened window). */
  readonly lastRun: LastRun | null;
}

/** A thinking step longer than this gets the "long think" note. */
export const LONG_THINK_MS = 90_000;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clip(value: string, max: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}\u2026` : single;
}

/** The folder a file sits in, as its last few parts ("server/rag"). */
function folderOf(path: string): string | null {
  const parts = path.split(/[\\/]/).filter(Boolean);
  parts.pop();
  if (parts.length === 0) return null;
  return parts.slice(-3).join("/");
}

/** Shell steps that set up the real command rather than being it. */
const SETUP = /^(cd|export|set|source|\.|unset|sleep|echo|true|:)(\s|$)/;

/**
 * The part of a shell command worth naming: the first step that isn't
 * changing folder or setting variables ("cd app && npx vitest run x" →
 * "npx vitest run x"), with inline `VAR=value` prefixes dropped.
 */
export function commandLabel(command: string): string {
  const steps = command
    .split(/&&|\|\||;|\n/)
    .map((step) => step.trim())
    .filter(Boolean);
  const main = steps.find((step) => !SETUP.test(step)) ?? steps[0] ?? command;
  return main.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").trim();
}

/** A URL's host ("docs.example.com"), or null when it isn't one. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Who among the workers is out working, in words. */
function workersWorking(workers: readonly WorkerAgent[]): string | null {
  const names = workers.filter((w) => w.status === "running").map((w) => w.label);
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is working`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are working`;
  return `${names.length} workers are working`;
}

/**
 * What it just finished, for the line under "Thinking": the step as the
 * pill named it, never a raw command or path ("After running npx vitest").
 */
function afterTool(tool: LiveToolEntry): string {
  const kind = coordinatorKind(tool.name);
  if (kind === "think") return "Planning the next step";
  const was = toolStatus(tool, {
    running: true,
    paused: false,
    waitingOnUser: false,
    liveTools: [],
    workers: [],
    lastRun: null,
  });
  return `After ${was.headline.charAt(0).toLowerCase()}${was.headline.slice(1)}`;
}

type Moment = Omit<GoalStatus, "opens" | "thinking" | "timed"> &
  Partial<Pick<GoalStatus, "opens" | "thinking" | "timed">>;

function status(moment: Moment): GoalStatus {
  return { opens: false, thinking: false, timed: true, ...moment };
}

/** What a running tool call is, as a status. */
function toolStatus(tool: LiveToolEntry, input: GoalStatusInput): GoalStatus {
  const args = tool.args;
  const path = text(args.file_path) ?? text(args.path);
  const file = path ? clip(path.split(/[\\/]/).filter(Boolean).pop() ?? path, 40) : null;
  const folder = path ? folderOf(path) : null;
  const key = `tool:${tool.toolCallId}`;
  const working = { key, tone: "work" as const };
  switch (coordinatorKind(tool.name)) {
    case "read":
      return status({
        ...working,
        icon: "read",
        headline: file ? `Reading ${file}` : "Reading",
        detail: folder ? `In ${folder}` : null,
      });
    case "edit":
      return status({
        ...working,
        icon: "edit",
        headline: `${tool.name === "write" ? "Writing" : "Editing"}${file ? ` ${file}` : ""}`,
        detail: folder ? `In ${folder}` : null,
      });
    case "search": {
      const query = text(args.pattern) ?? text(args.query);
      return status({
        ...working,
        icon: "search",
        headline: "Searching the code",
        detail: query ? `For \u201c${clip(query, 48)}\u201d` : null,
      });
    }
    case "run": {
      // Only the command itself, never the setup round it (folder changes,
      // exported variables): that's noise, and can carry paths and secrets.
      const command = text(args.command);
      const main = command ? commandLabel(command) : null;
      const label = main ? clip(main, 36) : null;
      return status({
        ...working,
        icon: "run",
        headline: label ? `Running ${label}` : "Running a command",
        detail: main && main.length > 36 ? clip(main, 120) : null,
      });
    }
    case "web": {
      const target = text(args.url) ?? text(args.query);
      const host = hostOf(text(args.url));
      return status({
        ...working,
        icon: "web",
        headline: host ? `Browsing ${clip(host, 32)}` : "Searching the web",
        detail: target ? clip(target, 90) : null,
      });
    }
    case "delegate":
      return status({
        ...working,
        icon: "delegate",
        headline: "Bringing in workers",
        detail: workersWorking(input.workers),
      });
    case "wait":
      return tool.name === "task_output"
        ? status({
            ...working,
            icon: "wait",
            headline: "Waiting on a command",
            detail: null,
          })
        : status({
            ...working,
            icon: "wait",
            headline: "Waiting on workers",
            detail: workersWorking(input.workers),
          });
    case "ask":
      return status({
        key,
        tone: "ask",
        icon: "ask",
        headline: "Asking you something",
        detail: null,
      });
    case "think":
      return status({
        ...working,
        icon: "think",
        headline: "Planning",
        detail: null,
      });
  }
}

/** The coordinator's status for this moment. */
export function goalStatusOf(input: GoalStatusInput): GoalStatus {
  if (input.waitingOnUser) {
    return status({
      key: "ask",
      tone: "ask",
      icon: "ask",
      headline: "Waiting for you",
      detail: null,
    });
  }
  if (input.paused) {
    return status({
      key: "paused",
      tone: "paused",
      icon: "paused",
      headline: "Paused",
      detail: "Picks up where it left off",
    });
  }
  if (input.running) {
    const current = [...input.liveTools].reverse().find((t) => t.status === "running");
    if (current) return toolStatus(current, input);
    // Between tool calls: thinking over what it just did.
    const last = input.liveTools[input.liveTools.length - 1];
    return status({
      key: `think:${last?.toolCallId ?? "start"}`,
      tone: "work",
      icon: "think",
      headline: "Thinking",
      detail: last ? afterTool(last) : null,
      thinking: true,
    });
  }
  // Between runs, workers may still be out working.
  const workers = workersWorking(input.workers);
  if (workers) {
    return status({
      key: "workers",
      tone: "work",
      icon: "wait",
      headline: "Waiting on workers",
      detail: workers,
    });
  }
  const run = input.lastRun;
  if (run?.outcome === "failed") {
    return status({
      key: "stopped",
      tone: "error",
      icon: "error",
      headline: "Stopped",
      detail: run.reason ?? "Something went wrong. The chat has the details.",
      opens: true,
      timed: false,
    });
  }
  if (run?.outcome === "cancelled") {
    // The user stopped it: nothing went wrong, so nothing to flag.
    return status({
      key: "cancelled",
      tone: "idle",
      icon: "paused",
      headline: "Stopped by you",
      detail: null,
      timed: false,
    });
  }
  if (run) {
    return status({
      key: `done:${run.outcome}`,
      tone: "done",
      icon: "done",
      headline: run.outcome === "done" ? "Done for now" : "Done, not all checked",
      detail: null,
      timed: false,
    });
  }
  return status({
    key: "idle",
    tone: "idle",
    icon: "idle",
    headline: "Ready when you are",
    detail: null,
    timed: false,
  });
}

/**
 * How the goal's latest run seen live ended, with its error headline when it
 * failed (the newest error the run left in the transcript). Null while one is
 * running, and when none was seen.
 */
export function lastRunOf(
  runs: readonly GoalRun[],
  goalId: string | null,
  items: readonly Item[],
): LastRun | null {
  if (!goalId) return null;
  const run = [...runs].reverse().find((r) => r.goalId === goalId);
  if (!run) return null;
  if (run.outcome !== "failed") return { outcome: run.outcome, reason: null };
  const error = [...items]
    .reverse()
    .find((item) => item.kind === "error" && item.id > run.fromItemId);
  const reason =
    error?.kind === "error" ? (error.headline ?? error.message ?? error.text ?? null) : null;
  return { outcome: run.outcome, reason: reason ? clip(reason, 120) : null };
}
