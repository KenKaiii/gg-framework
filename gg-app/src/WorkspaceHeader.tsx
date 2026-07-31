import type { ReactNode } from "react";
import { openProjectPath, openUrl, type WorkspaceMode } from "./agent";
import { projectAccent } from "./projectAccent";
import { PRODUCT_DISPLAY_NAME } from "./brand";

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
  /** Extra workspace roots added with /add-dir. */
  additionalRoots?: string[];
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
  additionalRoots: string[] = [],
): string {
  const directory = cwd?.split(/[\\/]/).filter(Boolean).pop();
  if (!directory) return fallback;
  const segments = [directory];
  if (additionalRoots.length > 0)
    segments.push(`+${pluralize(additionalRoots.length, "root", "roots")}`);
  if (gitBranch) segments.push(`⎇ ${gitBranch}`);
  if (gitDirtyFileCount > 0) segments.push(`${gitDirtyFileCount} uncommitted`);
  if (gitHubIssues !== null && gitHubIssues > 0)
    segments.push(pluralize(gitHubIssues, "issue", "issues"));
  if (gitHubPRs !== null && gitHubPRs > 0) segments.push(pluralize(gitHubPRs, "PR", "PRs"));
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
  additionalRoots = [],
  navHidden,
  onToggleNav,
  stripExtras,
  children,
}: WorkspaceHeaderProps): React.ReactElement {
  const fallbackTitle = workspaceMode === "chat" ? "GG Chat" : PRODUCT_DISPLAY_NAME;
  const directory = cwd?.split(/[\\/]/).filter(Boolean).pop();
  // Stable per-project colour, so a wall of identical dark windows becomes
  // identifiable at a glance. Published as a CSS variable (not just inlined on
  // the one rule that uses it) so descendants can opt in later.
  const accent = projectAccent(cwd);

  return (
    <div
      className="chat-head"
      style={accent ? ({ "--project-accent": accent } as React.CSSProperties) : undefined}
    >
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
            additionalRoots,
          )}
        >
          {directory ? (
            <>
              {accent && <span className="chat-head-accent-dot" aria-hidden="true" />}
              <button
                type="button"
                className="chat-head-cwd chat-head-link"
                disabled={!cwd}
                title={cwd ? `${cwd} — open folder` : undefined}
                onClick={() => cwd && void openProjectPath(cwd)}
              >
                {directory}
              </button>
              {gitBranch && (
                <>
                  <span className="chat-head-sep" data-tauri-drag-region>
                    {"│"}
                  </span>
                  {gitHubRepoUrl ? (
                    <button
                      type="button"
                      className="chat-head-branch chat-head-link"
                      title={`${gitBranch} — open ${gitHubRepoUrl} on GitHub`}
                      onClick={() => void openUrl(gitHubRepoUrl)}
                    >
                      {`⎇ ${gitBranch}`}
                    </button>
                  ) : (
                    <span className="chat-head-branch" data-tauri-drag-region>
                      {`⎇ ${gitBranch}`}
                    </span>
                  )}
                </>
              )}
              {additionalRoots.length > 0 && (
                <>
                  <span className="chat-head-sep" data-tauri-drag-region>
                    {"│"}
                  </span>
                  <span
                    className="chat-head-dirty"
                    data-tauri-drag-region
                    title={`Additional workspace roots:\n${additionalRoots.join("\n")}`}
                  >
                    {`+${pluralize(additionalRoots.length, "root", "roots")}`}
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
              {gitHubIssues !== null && gitHubIssues > 0 && (
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
              {gitHubPRs !== null && gitHubPRs > 0 && (
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
