import { PlusIcon } from "@phosphor-icons/react";
import type { ProjectTask, WorkspaceMode } from "./agent";
import { AutopilotToggle } from "./AutopilotToggle";
import { MetalButton } from "./MetalButton";
import { RadioButton } from "./RadioButton";
import { RankBadge } from "./RankBadge";
import { WindowLayoutButton } from "./WindowLayoutButton";
import type { ProgressState } from "./useProgress";

/** The workspace header's right side: rank badge + XP chips and the per-mode action buttons. */
export function WorkspaceHeaderActions({
  workspaceMode,
  progress,
  rankCelebrateNonce,
  xpChips,
  onOpenScorecard,
  windowFocused,
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
  onArrange,
  needsGitInit,
  onInitGit,
  commitCommand,
  hasCommit,
  onCommit,
}: {
  workspaceMode: WorkspaceMode;
  progress: ProgressState["snapshot"];
  rankCelebrateNonce: string | null;
  xpChips: Array<{ id: string; label: string }>;
  onOpenScorecard: () => void;
  windowFocused: boolean;
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
  onArrange: () => void;
  needsGitInit: boolean;
  onInitGit: () => void;
  commitCommand: string | null;
  hasCommit: boolean;
  onCommit: () => void;
}): React.ReactElement {
  return (
    <>
      <div className="rank-badge-wrap">
        <RankBadge
          snapshot={progress}
          celebrateNonce={rankCelebrateNonce}
          onClick={onOpenScorecard}
        />
        <div className="rank-xp-chip-layer" aria-hidden="true">
          {xpChips.map((chip) => (
            <span className="rank-xp-chip" key={chip.id}>
              {chip.label}
            </span>
          ))}
        </div>
      </div>
      {workspaceMode !== "code" ? (
        <span className="picker-head-actions">
          <MetalButton
            windowFocused={windowFocused}
            className="btn btn-primary btn-sm"
            disabled={running}
            title={workspaceMode === "motion" ? "Start a new video session" : "Start a new chat"}
            onClick={onNewSession}
          >
            <PlusIcon size={14} aria-hidden="true" />
            New
          </MetalButton>
          <button className="btn btn-sm btn-ghost" title="Open your notes" onClick={onOpenNotes}>
            Notes
          </button>
          {workspaceMode === "chat" && (
            <button
              className="btn btn-sm btn-ghost"
              title="View and curate chat memories and Jiwa"
              onClick={onOpenMemories}
            >
              Brain
            </button>
          )}
          <RadioButton />
          <WindowLayoutButton />
        </span>
      ) : (
        <>
          <span className="picker-head-actions">
            <AutopilotToggle
              checked={autopilot}
              disabled={running || autopilotReviewing}
              onChange={onAutopilotChange}
            />
            {/* Quiet here on purpose: in a project the header's one accent is
                the commit action, so New sits with the other tools. */}
            <button
              className="btn btn-sm btn-ghost"
              disabled={running}
              title="Start a new session for this project"
              onClick={onNewSession}
            >
              <PlusIcon size={14} aria-hidden="true" />
              New
            </button>
            <button
              className="btn btn-sm btn-ghost"
              title="Open your notes for this project"
              onClick={onOpenNotes}
            >
              Notes
            </button>
            <button
              className="btn btn-sm btn-ghost"
              title="View and run this project's tasks"
              onClick={onOpenTasks}
            >
              {projectTasks.some((t) => t.status !== "done")
                ? `Tasks (${projectTasks.filter((t) => t.status !== "done").length})`
                : "Tasks"}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              title="Check this project's health: tests, CI, security, design and more"
              onClick={onOpenChecklist}
              aria-pressed={showChecklist}
            >
              Checklist
            </button>
            <RadioButton />
            <WindowLayoutButton onArrange={onArrange} />
            {needsGitInit ? (
              <button
                className="btn btn-sm btn-ghost"
                disabled={running}
                title="Initialize git + create a GitHub repository"
                onClick={onInitGit}
              >
                {"Initialize Git"}
              </button>
            ) : (
              commitCommand && (
                <MetalButton
                  windowFocused={windowFocused}
                  className={`btn btn-sm ${hasCommit ? "btn-success" : "btn-ghost"}`}
                  disabled={running}
                  title={hasCommit ? "Run /commit" : "Generate a /commit command"}
                  onClick={onCommit}
                >
                  {`/${commitCommand}`}
                </MetalButton>
              )
            )}
          </span>
        </>
      )}
    </>
  );
}
