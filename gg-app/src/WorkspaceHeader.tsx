import type { ReactNode } from "react";
import { openUrl, type WorkspaceMode } from "./agent";

interface WorkspaceHeaderProps {
  workspaceMode: WorkspaceMode;
  cwd?: string;
  gitBranch?: string | null;
  gitDirtyFileCount?: number;
  /** Open issue/PR counts for the project's GitHub origin (null = unknown/hidden). */
  gitHubIssues?: number | null;
  gitHubPRs?: number | null;
  /** Origin repo's web URL — makes the issue/PR chips clickable. */
  gitHubRepoUrl?: string | null;
  navHidden: boolean;
  onToggleNav: () => void;
  stripExtras?: ReactNode;
  children: ReactNode;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatWorkspaceTitle(
  cwd: string | undefined,
  gitBranch: string | null | undefined,
  fallback: string,
  gitDirtyFileCount = 0,
  gitHubIssues: number | null = null,
  gitHubPRs: number | null = null,
): string {
  const directory = cwd?.split(/[\\/]/).filter(Boolean).pop();
  if (!directory) return fallback;
  const segments = [directory];
  if (gitBranch) segments.push(`⎇ ${gitBranch}`);
  if (gitDirtyFileCount > 0) segments.push(`${gitDirtyFileCount} uncommitted`);
  if (gitHubIssues !== null) segments.push(pluralize(gitHubIssues, "issue", "issues"));
  if (gitHubPRs !== null) segments.push(pluralize(gitHubPRs, "PR", "PRs"));
  return segments.join(" │ ");
}

/** Shared code/chat titlebar and collapsible workspace navigation. */
export function WorkspaceHeader({
  workspaceMode,
  cwd,
  gitBranch,
  gitDirtyFileCount = 0,
  gitHubIssues = null,
  gitHubPRs = null,
  gitHubRepoUrl = null,
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
          title={formatWorkspaceTitle(
            cwd,
            gitBranch,
            fallbackTitle,
            gitDirtyFileCount,
            gitHubIssues,
            gitHubPRs,
          )}
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
              {gitHubIssues !== null && (
                <>
                  <span className="chat-head-sep" data-tauri-drag-region>
                    {"│"}
                  </span>
                  <button
                    type="button"
                    className="chat-head-github"
                    disabled={!gitHubRepoUrl}
                    title={`${pluralize(gitHubIssues, "open issue", "open issues")} on GitHub${gitHubRepoUrl ? " — click to view" : ""}`}
                    onClick={() => gitHubRepoUrl && void openUrl(`${gitHubRepoUrl}/issues`)}
                  >
                    {pluralize(gitHubIssues, "issue", "issues")}
                  </button>
                </>
              )}
              {gitHubPRs !== null && (
                <>
                  <span className="chat-head-sep" data-tauri-drag-region>
                    {"│"}
                  </span>
                  <button
                    type="button"
                    className="chat-head-github"
                    disabled={!gitHubRepoUrl}
                    title={`${pluralize(gitHubPRs, "open PR", "open PRs")} on GitHub${gitHubRepoUrl ? " — click to view" : ""}`}
                    onClick={() => gitHubRepoUrl && void openUrl(`${gitHubRepoUrl}/pulls`)}
                  >
                    {pluralize(gitHubPRs, "PR", "PRs")}
                  </button>
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
