import type { ProjectTask, WorkspaceMode } from "./agent";
import { Icon } from "./icons";
import { WindowLayoutButton } from "./WindowLayoutButton";
import { describeTally, type GoalTally } from "./goal-progress";

/** A started goal shows either its conversation or its workers at work. */
export type GoalView = "chat" | "workers";

const GOAL_VIEWS: ReadonlyArray<{ view: GoalView; label: string }> = [
  { view: "chat", label: "Chat" },
  { view: "workers", label: "Workers" },
];

/** What the goal's play/pause control says, by what the goal is doing. */
const GOAL_STATE_LABEL: Readonly<Record<"running" | "paused" | "stopped", string>> = {
  running: "Pause the goal",
  paused: "Resume the goal",
  stopped: "Not running. Carry the goal on",
};

/**
 * The right end of the one-row title bar: what has to stay visible in every
 * window, however small. In a project that's Commit with the count of
 * uncommitted files in it (or "Clean"); in a started Goal, also its
 * Chat / Workers switch, the workers' tally and pause.
 */
export function TitleBarActions({
  workspaceMode,
  isGoal = false,
  goalView = null,
  onGoalViewChange,
  goalNeedsAnswer = false,
  goalTally = null,
  goalState = "stopped",
  onGoalPauseChange,
  xpChips,
  running,
  dirtyCount,
  needsGitInit,
  onInitGit,
  commitCommand,
  hasCommit,
  onCommit,
}: {
  workspaceMode: WorkspaceMode;
  isGoal?: boolean;
  /** A started goal's current view; null before the goal starts. */
  goalView?: GoalView | null;
  onGoalViewChange?: (view: GoalView) => void;
  /** GG Goals is waiting on an answer that only the Chat view shows. */
  goalNeedsAnswer?: boolean;
  /** A started goal's workers: how many are working, and the tasks done and failed so far. */
  goalTally?: GoalTally | null;
  goalState?: "running" | "paused" | "stopped";
  onGoalPauseChange?: (paused: boolean) => void;
  /** XP gains float up from the title bar for a moment. */
  xpChips: Array<{ id: string; label: string }>;
  running: boolean;
  /** Tracked, staged and untracked files not yet committed. */
  dirtyCount: number;
  needsGitInit: boolean;
  onInitGit: () => void;
  commitCommand: string | null;
  hasCommit: boolean;
  onCommit: () => void;
}): React.ReactElement {
  const showGit = workspaceMode === "code" || isGoal;
  return (
    <>
      <div className="rank-xp-chip-layer" aria-hidden="true">
        {xpChips.map((chip) => (
          <span className="rank-xp-chip" key={chip.id}>
            {chip.label}
          </span>
        ))}
      </div>
      {isGoal && goalView && goalTally && (
        <p className="goal-tally" role="status" aria-label={describeTally(goalTally)}>
          <span className="goal-tally-part" data-live={goalTally.working > 0 || undefined}>
            <span className="goal-tally-n">{goalTally.working}</span> working
          </span>
          <span className="goal-tally-part">
            <span className="goal-tally-n">{goalTally.done}</span> done
          </span>
          {goalTally.failed > 0 && (
            <span className="goal-tally-part" data-tone="failed">
              <span className="goal-tally-n">{goalTally.failed}</span> failed
            </span>
          )}
        </p>
      )}
      {isGoal && goalView && onGoalViewChange && (
        <div className="key-group goal-view-switch" role="group" aria-label="Goal view">
          {GOAL_VIEWS.map(({ view, label }) => {
            const attention = view === "chat" && goalView !== "chat" && goalNeedsAnswer;
            return (
              <button
                key={view}
                type="button"
                className="key key-sm goal-view-option"
                aria-pressed={goalView === view}
                data-attention={attention ? "true" : undefined}
                aria-label={attention ? `${label}, a question is waiting for you` : undefined}
                onClick={() => onGoalViewChange(view)}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {isGoal && goalView && onGoalPauseChange && (
        <button
          type="button"
          className="key key-icon"
          aria-pressed={goalState === "paused"}
          title={GOAL_STATE_LABEL[goalState]}
          aria-label={GOAL_STATE_LABEL[goalState]}
          onClick={() => onGoalPauseChange(goalState === "running")}
        >
          <Icon name={goalState === "running" ? "pause" : "play"} size={14} />
        </button>
      )}
      {showGit &&
        (needsGitInit && !isGoal ? (
          <button
            type="button"
            className="key key-sm"
            disabled={running}
            title="Initialize Git + create a GitHub repository"
            onClick={onInitGit}
          >
            Initialize Git
          </button>
        ) : commitCommand && dirtyCount > 0 ? (
          <button
            type="button"
            className="key key-sm commit-key"
            disabled={running}
            title={hasCommit ? `Run /${commitCommand}` : "Generate a /commit command"}
            aria-label={`Commit ${dirtyCount} ${dirtyCount === 1 ? "file" : "files"}`}
            onClick={onCommit}
          >
            <span className="lb">Commit</span>
            <span className="well">{dirtyCount}</span>
          </button>
        ) : commitCommand ? (
          <span className="clean-mark" title="Nothing to commit">
            Clean
          </span>
        ) : null)}
    </>
  );
}

/**
 * The deck's ⋯ keypad: every tool that used to sit in the second header row.
 * Plain words, no icons; the label already says what each does.
 */
export function DeckMenu({
  workspaceMode,
  isGoal = false,
  running,
  autopilot,
  autopilotReviewing,
  onAutopilotChange,
  onNewSession,
  onOpenNotes,
  onOpenMemories,
  projectTasks,
  onOpenTasks,
  showChecklist,
  onOpenChecklist,
  hasHealth = false,
  onOpenHealth,
  onOpenRadio,
  onOpenGoalSettings,
  onAddFolder,
  onRemoveFolder,
  canExport = false,
  exporting = false,
  onExport,
  onArrange,
  onBack,
  backLabel,
}: {
  workspaceMode: WorkspaceMode;
  isGoal?: boolean;
  running: boolean;
  autopilot: boolean;
  autopilotReviewing: boolean;
  onAutopilotChange: (next: boolean) => void;
  onNewSession: () => void;
  onOpenNotes: () => void;
  onOpenMemories: () => void;
  projectTasks: ProjectTask[];
  onOpenTasks: () => void;
  showChecklist: boolean;
  onOpenChecklist: () => void;
  /** A Project Health score exists for this project. */
  hasHealth?: boolean;
  onOpenHealth?: () => void;
  onOpenRadio: () => void;
  onOpenGoalSettings?: () => void;
  /** Code and Chat windows: add another folder GG can work in. */
  onAddFolder?: () => void;
  /** Set only once a folder has been added: pick one to drop. */
  onRemoveFolder?: () => void;
  /** The chat has something to save. */
  canExport?: boolean;
  exporting?: boolean;
  onExport?: () => void;
  onArrange: () => void;
  onBack: () => void;
  backLabel: string;
}): React.ReactElement {
  const pending = projectTasks.filter((t) => t.status !== "done").length;
  const code = workspaceMode === "code" && !isGoal;
  return (
    <>
      {!isGoal && (
        <button
          type="button"
          className="key"
          disabled={running}
          title={
            workspaceMode === "chat"
              ? "Start a new chat"
              : workspaceMode === "motion"
                ? "Start a new video session"
                : "Start a new session for this project"
          }
          onClick={onNewSession}
        >
          {workspaceMode === "chat" ? "New chat" : "New session"}
        </button>
      )}
      {code && (
        <button
          type="button"
          className="key"
          role="switch"
          aria-checked={autopilot}
          disabled={running || autopilotReviewing}
          title="Autopilot: after each run, Ken reviews the work and GG continues if it needs changes"
          onClick={() => onAutopilotChange(!autopilot)}
        >
          Autopilot
          <span className="led" data-state={autopilot ? "on" : undefined} aria-hidden="true" />
        </button>
      )}
      {code && (
        <button
          type="button"
          className="key"
          aria-pressed={showChecklist}
          title="Check this project's health: tests, CI, security, design and more"
          onClick={onOpenChecklist}
        >
          Checklist
        </button>
      )}
      {code && hasHealth && onOpenHealth && (
        <button
          type="button"
          className="key"
          title="Scores for file size, hygiene, safety and debt, with what holds each down"
          onClick={onOpenHealth}
        >
          Project Health
        </button>
      )}
      {onAddFolder && !isGoal && (workspaceMode === "code" || workspaceMode === "chat") && (
        <button
          type="button"
          className="key"
          title="Add another folder GG can work in"
          onClick={onAddFolder}
        >
          Add folder
        </button>
      )}
      {onRemoveFolder && !isGoal && (workspaceMode === "code" || workspaceMode === "chat") && (
        <button
          type="button"
          className="key"
          title="Remove a folder you added"
          onClick={onRemoveFolder}
        >
          Remove folder
        </button>
      )}
      {!isGoal && (
        <button type="button" className="key" title="Your notes" onClick={onOpenNotes}>
          Notes
        </button>
      )}
      {code && (
        <button
          type="button"
          className="key"
          title="View and run this project's tasks"
          onClick={onOpenTasks}
        >
          Tasks
          {pending > 0 && <span className="well">{pending}</span>}
        </button>
      )}
      {workspaceMode === "chat" && !isGoal && (
        <button
          type="button"
          className="key"
          title="View and curate chat memories and Jiwa"
          onClick={onOpenMemories}
        >
          Brain
        </button>
      )}
      {onOpenGoalSettings && (
        <button type="button" className="key" title="Goal settings" onClick={onOpenGoalSettings}>
          Goal settings
        </button>
      )}
      <button type="button" className="key" title="Internet radio" onClick={onOpenRadio}>
        Radio
      </button>
      {onExport && !isGoal && (
        <button
          type="button"
          className="key"
          disabled={!canExport || exporting}
          title="Save this conversation as a Markdown file"
          onClick={onExport}
        >
          {exporting ? "Exporting\u2026" : "Export chat"}
        </button>
      )}
      <WindowLayoutButton onArrange={onArrange} label="Arrange" />
      <button type="button" className="key" title={backLabel} onClick={onBack}>
        {workspaceMode === "chat" ? "All chats" : isGoal ? "All goals" : "Projects"}
      </button>
    </>
  );
}
