import type { ReactNode } from "react";
import type { WorkspaceMode } from "./agent";

interface WorkspaceHeaderProps {
  workspaceMode: WorkspaceMode;
  cwd?: string;
  gitBranch?: string | null;
  gitDirtyFileCount?: number;
  navHidden: boolean;
  onToggleNav: () => void;
  stripExtras?: ReactNode;
  children: ReactNode;
}

export function formatWorkspaceTitle(
  cwd: string | undefined,
  gitBranch: string | null | undefined,
  fallback: string,
  gitDirtyFileCount = 0,
): string {
  const directory = cwd?.split(/[\\/]/).filter(Boolean).pop();
  if (!directory) return fallback;
  const segments = [directory];
  if (gitBranch) segments.push(`⎇ ${gitBranch}`);
  if (gitDirtyFileCount > 0) segments.push(`${gitDirtyFileCount} uncommitted`);
  return segments.join(" │ ");
}

/** Shared code/chat titlebar and collapsible workspace navigation. */
export function WorkspaceHeader({
  workspaceMode,
  cwd,
  gitBranch,
  gitDirtyFileCount = 0,
  navHidden,
  onToggleNav,
  stripExtras,
  children,
}: WorkspaceHeaderProps): React.ReactElement {
  const fallbackTitle = workspaceMode === "chat" ? "GG Chat" : "GG Coder";
  const directory = cwd?.split(/[\\/]/).filter(Boolean).pop();

  return (
    <div className="chat-head">
      <div className="chat-head-strip" data-tauri-drag-region>
        <span
          className="chat-head-title"
          data-tauri-drag-region
          title={formatWorkspaceTitle(cwd, gitBranch, fallbackTitle, gitDirtyFileCount)}
        >
          {directory ? (
            <>
              <span className="chat-head-cwd" data-tauri-drag-region>
                {directory}
              </span>
              {gitBranch && (
                <>
                  <span className="chat-head-sep" data-tauri-drag-region>
                    {"│"}
                  </span>
                  <span className="chat-head-branch" data-tauri-drag-region>
                    {`⎇ ${gitBranch}`}
                  </span>
                </>
              )}
              {gitDirtyFileCount > 0 && (
                <>
                  <span className="chat-head-sep" data-tauri-drag-region>
                    {"│"}
                  </span>
                  <span
                    className="chat-head-dirty"
                    data-tauri-drag-region
                    title={`${gitDirtyFileCount} file${gitDirtyFileCount === 1 ? "" : "s"} not committed`}
                  >
                    {`${gitDirtyFileCount} uncommitted`}
                  </span>
                </>
              )}
            </>
          ) : (
            fallbackTitle
          )}
        </span>
        {stripExtras}
        <button
          className="nav-toggle"
          title={navHidden ? "Show nav buttons" : "Hide nav buttons"}
          aria-label={navHidden ? "Show nav buttons" : "Hide nav buttons"}
          aria-expanded={!navHidden}
          aria-controls="workspace-nav"
          onClick={onToggleNav}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ display: "block" }}
            aria-hidden="true"
          >
            <polyline points={navHidden ? "6 9 12 15 18 9" : "6 15 12 9 18 15"} />
          </svg>
        </button>
      </div>

      {!navHidden && (
        <div id="workspace-nav" className="chat-head-nav" data-tauri-drag-region>
          {children}
        </div>
      )}
    </div>
  );
}
