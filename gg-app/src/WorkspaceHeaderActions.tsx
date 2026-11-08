import type { Dispatch, SetStateAction, JSX } from "react";
import { MetalButton } from "./MetalButton";
import {
  setAutopilot,
  type ProgressSnapshot,
  type WorkspaceMode,
  type AgentState,
  type ProjectTask,
} from "./agent";
import { WindowLayoutButton } from "./WindowLayoutButton";
import { RadioButton } from "./RadioButton";
import { AutopilotToggle } from "./AutopilotToggle";
import { RankBadge } from "./RankBadge";

export function WorkspaceHeaderActions({
  progress,
  rankCelebrateNonce,
  setShowScorecard,
  xpChips,
  workspaceMode,
  phoneHeader,
  newSessionButton,
  brainButton,
  helpButton,
  checklistButton,
  state,
  running,
  autopilotReviewing,
  setState,
  setKenPowerBanner,
  setShowNotes,
  openTasks,
  projectTasks,
  setNavHiddenPersisted,
  setToolsHiddenPersisted,
  needsGitInit,
  setShowInitGit,
  commitCommand,
  windowFocused,
  hasCommit,
  submitText,
}: {
  progress: ProgressSnapshot | null;
  rankCelebrateNonce: string | null;
  setShowScorecard: Dispatch<SetStateAction<boolean>>;
  xpChips: { id: string; label: string }[];
  workspaceMode: WorkspaceMode;
  phoneHeader: boolean;
  newSessionButton: JSX.Element;
  brainButton: false | JSX.Element;
  helpButton: JSX.Element;
  /** Opens the project checklist view (code sessions). */
  checklistButton: JSX.Element;
  state: AgentState | null;
  running: boolean;
  autopilotReviewing: boolean;
  setState: Dispatch<SetStateAction<AgentState | null>>;
  setKenPowerBanner: Dispatch<SetStateAction<"on" | "off" | null>>;
  setShowNotes: Dispatch<SetStateAction<boolean>>;
  openTasks: () => void;
  projectTasks: ProjectTask[];
  setNavHiddenPersisted: (hidden: boolean) => void;
  setToolsHiddenPersisted: (hidden: boolean) => void;
  needsGitInit: boolean;
  setShowInitGit: Dispatch<SetStateAction<boolean>>;
  commitCommand: "commit" | "setup-commit" | null;
  windowFocused: boolean;
  hasCommit: boolean;
  submitText: (text: string, label?: string, opts?: { keepInput?: boolean }) => void;
}) {
  return (
    <>
      <div className="rank-badge-wrap">
        <RankBadge
          snapshot={progress}
          celebrateNonce={rankCelebrateNonce}
          onClick={() => setShowScorecard(true)}
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
          {!phoneHeader && newSessionButton}
          {!phoneHeader && brainButton}
          <RadioButton />
          <WindowLayoutButton />
          {!phoneHeader && helpButton}
        </span>
      ) : (
        <>
          <span className="picker-head-actions">
            <AutopilotToggle
              checked={state?.autopilot ?? false}
              disabled={running || autopilotReviewing}
              onChange={(next) => {
                setState((s) => (s ? { ...s, autopilot: next } : s));
                void setAutopilot(next);
                setKenPowerBanner(next ? "on" : "off");
              }}
            />
            {!phoneHeader && newSessionButton}
            <button
              className="btn btn-sm btn-ghost"
              title="Open your notes for this project"
              onClick={() => setShowNotes(true)}
            >
              Notes
            </button>
            <button
              className="btn btn-sm btn-ghost"
              title="View and run this project's tasks"
              onClick={openTasks}
            >
              {projectTasks.some((t) => t.status !== "done")
                ? `Tasks (${projectTasks.filter((t) => t.status !== "done").length})`
                : "Tasks"}
            </button>
            {checklistButton}
            <RadioButton />
            {/* <GazeButton /> */}
            <WindowLayoutButton
              onArrange={() => {
                setNavHiddenPersisted(true);
                setToolsHiddenPersisted(true);
              }}
            />
            {needsGitInit ? (
              <button
                className="btn btn-sm btn-ghost"
                disabled={running}
                title="Initialize Git + create a GitHub repository"
                onClick={() => setShowInitGit(true)}
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
                  onClick={() =>
                    submitText(
                      `/${commitCommand}`,
                      hasCommit ? "Committing\u2026" : "Setting up commits\u2026",
                    )
                  }
                >
                  {`/${commitCommand}`}
                </MetalButton>
              )
            )}
            {!phoneHeader && helpButton}
          </span>
        </>
      )}
    </>
  );
}
