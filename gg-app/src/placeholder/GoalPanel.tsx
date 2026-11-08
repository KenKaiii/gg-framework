import { useEffect, useId, useMemo, useRef, useState } from "react";
import { updateGoal, type GoalContextItem, type GoalStateInfo, type ModelOption } from "../agent";
import type { LiveToolEntry } from "../LiveToolPanel";
import type { Item } from "../transcript-item";
import { GoalContextField, GoalInstructionsField, type ContextPick } from "./GoalForm";
import { GoalFinish } from "./GoalFinish";
import { StatusPill } from "./StatusPill";
import { goalStatusOf, lastRunOf } from "./goal-status";
import {
  FINISH_SETTLE_MS,
  goalFinishOf,
  goalIsQuiet,
  openStretch,
  type GoalFinish as GoalFinishScore,
  type GoalRun,
} from "./goal-finish";
import {
  EMPTY_TALLY,
  blockingAsk,
  coordinatorAtWork,
  describeTally,
  tallyGoal,
  workerPhase,
  type GoalTally,
} from "./goal-progress";
import { COORDINATOR_KEY, collectWorkers, type WorkerGroup } from "./worker-status";
import "./placeholder.css";

export type GoalView = "chat" | "workers";

type GoalRunState = "running" | "paused" | "stopped";

/** What the goal's pause control says, by what the goal is doing. */
const PAUSE_LABEL: Readonly<Record<GoalRunState, string>> = {
  running: "Pause the goal",
  paused: "Resume the goal",
  stopped: "Not running. Carry the goal on",
};

/**
 * The goal's settings: standing instructions and attached folders and files.
 * The coordinator picks the change up on its next step. Placeholder for
 * upstream's GoalSettingsModal.
 */
function GoalSettings({
  context: initialContext,
  instructions: initialInstructions,
  busy,
  onClose,
  onSaved,
}: {
  context: readonly GoalContextItem[];
  instructions: string;
  /** The goal is working: changes wait until it's paused or idle. */
  busy: boolean;
  onClose: () => void;
  onSaved: (next: { context: GoalContextItem[]; instructions: string }) => void;
}): React.ReactElement {
  const [context, setContext] = useState<ContextPick[]>(() =>
    initialContext.map((c) => ({ path: c.path, kind: c.kind })),
  );
  const [instructions, setInstructions] = useState(initialInstructions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed =
    instructions.trim() !== initialInstructions.trim() ||
    context.length !== initialContext.length ||
    context.some((c, i) => c.path !== initialContext[i]?.path);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const next = await updateGoal({
        context: context.map((c) => c.path),
        instructions: instructions.trim(),
      });
      onSaved(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <form
      className="placeholder-form"
      aria-label="Goal settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
      }}
    >
      <GoalInstructionsField
        placeholder="None yet. Add rules for the whole goal."
        value={instructions}
        onChange={setInstructions}
        disabled={saving || busy}
      />
      <GoalContextField
        value={context}
        onChange={setContext}
        disabled={saving || busy}
        onError={setError}
      />
      <span className="placeholder-muted">
        {busy
          ? "The goal is working. Pause it to change its settings."
          : "The coordinator picks up the change on its next step."}
      </span>
      {error && (
        <p role="alert" className="placeholder-attention">
          {error}
        </p>
      )}
      <span>
        <button type="button" onClick={onClose}>
          Cancel
        </button>{" "}
        <button type="submit" disabled={!changed || saving || busy}>
          {saving ? "Saving…" : "Save"}
        </button>
      </span>
    </form>
  );
}

/**
 * Placeholder (the fork owns the desktop design) for upstream's goal chrome: the
 * goal's name and phase, the Chat | Workers switch and the workers' tally once
 * it has started, pause and resume, the question it's blocked on, the goal's
 * settings, and the model its workers run on (upstream's footer picker).
 */
export function GoalPanel({
  goal,
  view,
  onViewChange,
  needsAnswer = false,
  models,
  onSelectWorkerModel,
  items = [],
  groups = [],
  running = false,
  liveTools = [],
  transcriptEpoch = 0,
  runs = [],
  onPauseChange,
  onSaved,
}: {
  goal: GoalStateInfo;
  /** Null while the goal is still being briefed: there is no Workers view yet. */
  view: GoalView | null;
  onViewChange: (view: GoalView) => void;
  /** A question waits on the user (the Chat switch says so). */
  needsAnswer?: boolean;
  models: readonly ModelOption[];
  /** Null follows the coordinator's own model. */
  onSelectWorkerModel: (modelId: string | null) => void;
  /** The transcript, for the question the coordinator is blocked on. */
  items?: readonly Item[];
  /** The transcript's sub-agent groups, for the workers' tally. */
  groups?: readonly WorkerGroup[];
  running?: boolean;
  liveTools?: readonly LiveToolEntry[];
  /** Bumped each time the transcript reloads: reloaded rows get new keys. */
  transcriptEpoch?: number;
  /** Every run of this goal seen live, for the finish card. */
  runs?: readonly GoalRun[];
  /** Pause (true) or resume (false); only for a started goal. */
  onPauseChange?: (paused: boolean) => void;
  /** After the settings were saved, with what the sidecar stored. */
  onSaved?: (next: { context: GoalContextItem[]; instructions: string }) => void;
}): React.ReactElement {
  const modelId = useId();
  const current = goal.critterModel ?? "";
  const active = view !== null;
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The tally: workers working now, tasks done and failed so far. Counting
  // starts afresh for each goal and each transcript reload (reloaded rows get
  // new keys, which would count every worker again).
  const tallySource = `${active ? goal.id : ""}:${transcriptEpoch}`;
  const workers = useMemo(() => (active ? collectWorkers(groups) : []), [active, groups]);
  const tallyInput = useMemo(
    () =>
      active
        ? [
            ...workers.map((worker) => ({
              key: worker.key,
              phase: workerPhase(worker.status),
            })),
            // The coordinator itself, while it does hands-on work.
            ...(running && coordinatorAtWork(liveTools)
              ? [{ key: COORDINATOR_KEY, phase: "working" as const }]
              : []),
          ]
        : [],
    [active, workers, running, liveTools],
  );
  const [tallyState, setTallyState] = useState<{ source: string; tally: GoalTally }>({
    source: "",
    tally: EMPTY_TALLY,
  });
  useEffect(() => {
    setTallyState((prev) => {
      const base = prev.source === tallySource ? prev.tally : EMPTY_TALLY;
      const tally = tallyGoal(base, tallyInput);
      return prev.source === tallySource && tally === prev.tally
        ? prev
        : { source: tallySource, tally };
    });
  }, [tallySource, tallyInput]);
  const tally =
    tallyState.source === tallySource ? tallyState.tally : tallyGoal(EMPTY_TALLY, tallyInput);

  const runState: GoalRunState = goal.paused
    ? "paused"
    : running || tally.working > 0
      ? "running"
      : "stopped";

  // Blocked on a question: said over the Workers view until the user has been
  // to the chat while it waited (seen), then only by the Chat switch.
  const ask = useMemo(() => (active ? blockingAsk(items) : null), [active, items]);
  const [seenAsks, setSeenAsks] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!ask || view !== "chat") return;
    setSeenAsks((seen) => (seen.has(ask.id) ? seen : new Set([...seen, ask.id])));
  }, [ask, view]);
  const askNotice = view === "workers" && ask && !seenAsks.has(ask.id) ? ask : null;

  // A stretch of work finished (nothing left going, and it stayed that way a
  // moment): its score over the Workers view. It comes down when closed, when
  // the user goes to the chat, or when work starts again. Only runs seen live
  // count, so a reopened window shows none.
  const [closedAt, setClosedAt] = useState(0);
  const [finish, setFinish] = useState<GoalFinishScore | null>(null);
  const stretch = useMemo(
    () => (active ? openStretch(runs, goal.id, closedAt) : []),
    [active, runs, goal.id, closedAt],
  );
  const quiet =
    stretch.length > 0 &&
    goalIsQuiet({ paused: goal.paused === true, running, waitingOnUser: needsAnswer, workers });
  const groupsRef = useRef(groups);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);
  useEffect(() => {
    if (!quiet) return;
    const timer = window.setTimeout(() => {
      const last = stretch[stretch.length - 1];
      if (last) setClosedAt(last.endedAt);
      setFinish(goalFinishOf(stretch, groupsRef.current));
    }, FINISH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [quiet, stretch]);
  useEffect(() => {
    if (finish && (running || view === "chat")) setFinish(null);
  }, [finish, running, view]);
  // What the coordinator is doing right now, for the status pill.
  const lastRun = useMemo(
    () => (active ? lastRunOf(runs, goal.id, items) : null),
    [active, runs, goal.id, items],
  );
  const status = useMemo(
    () =>
      active
        ? goalStatusOf({
            running,
            paused: goal.paused === true,
            waitingOnUser: needsAnswer,
            liveTools,
            workers,
            lastRun,
          })
        : null,
    [active, running, goal.paused, needsAnswer, liveTools, workers, lastRun],
  );

  const shownFinish =
    view === "workers" && !askNotice && finish?.goalId === goal.id ? finish : null;

  return (
    <div>
      <div className="placeholder-bar" role="group" aria-label="Goal">
        <strong>{goal.name}</strong>
        <span className="placeholder-muted">{active ? "Underway" : "Briefing"}</span>
        {view && (
          <span role="group" aria-label="Goal view">
            <button
              type="button"
              aria-pressed={view === "chat"}
              onClick={() => onViewChange("chat")}
            >
              {needsAnswer ? "Chat (waiting for you)" : "Chat"}
            </button>{" "}
            <button
              type="button"
              aria-pressed={view === "workers"}
              onClick={() => onViewChange("workers")}
            >
              Workers
            </button>
          </span>
        )}
        {active && (
          <span role="status" className="placeholder-muted">
            {describeTally(tally)}
          </span>
        )}
        {active && onPauseChange && (
          <button
            type="button"
            aria-pressed={runState === "paused"}
            onClick={() => onPauseChange(runState === "running")}
          >
            {PAUSE_LABEL[runState]}
          </button>
        )}
        <button
          type="button"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        >
          Goal settings
        </button>
        <label htmlFor={modelId} className="placeholder-muted">
          Workers&apos; model
        </label>
        <select
          id={modelId}
          value={current}
          onChange={(event) => onSelectWorkerModel(event.target.value || null)}
        >
          <option value="">Same as the coordinator</option>
          {current && !models.some((m) => m.id === current) && (
            <option value={current}>{current}</option>
          )}
          {/* Workers run in parallel and unwatched: the sidecar refuses paid tiers. */}
          {models
            .filter((model) => model.billing?.paid !== true)
            .map((model) => (
              <option key={`${model.provider}:${model.id}`} value={model.id}>
                {model.name}
              </option>
            ))}
        </select>
      </div>
      {status && view === "workers" && (
        <div className="placeholder-bar">
          <StatusPill status={status} />
        </div>
      )}
      {askNotice && (
        <div className="placeholder-notice placeholder-bar" role="status">
          <p className="placeholder-notice-body">
            <span className="placeholder-notice-headline">The coordinator needs you: </span>
            {askNotice.question}
            {askNotice.more > 0 && (
              <span className="placeholder-muted">
                {askNotice.more === 1
                  ? " And 1 more question."
                  : ` And ${askNotice.more} more questions.`}
              </span>
            )}
          </p>
          <button type="button" onClick={() => onViewChange("chat")}>
            Answer in Chat
          </button>
        </div>
      )}
      {shownFinish && (
        <GoalFinish
          finish={shownFinish}
          onShowChat={() => onViewChange("chat")}
          onClose={() => setFinish(null)}
        />
      )}
      {settingsOpen && (
        <div className="placeholder-bar">
          <GoalSettings
            context={goal.context ?? []}
            instructions={goal.instructions ?? ""}
            busy={running}
            onClose={() => setSettingsOpen(false)}
            onSaved={(next) => onSaved?.(next)}
          />
        </div>
      )}
    </div>
  );
}
