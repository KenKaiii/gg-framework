import { useEffect, useState } from "react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import { XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import {
  waitForReady,
  listProjects,
  setProjectHidden,
  listSessions,
  selectProject,
  importTranscript,
  getSettings,
  focusWindowByOffset,
  arrangeAllWindows,
  type DiscoveredProject,
  type RecentSession,
} from "./agent";
import { Badge } from "./Badge";
import { sourceStyle } from "./source-style";
import { ListSkeleton } from "./Skeleton";
import { BackButton } from "./BackButton";
import { WindowLayoutButton } from "./WindowLayoutButton";
import { RadioButton } from "./RadioButton";
import { NewProjectModal } from "./NewProjectModal";
import { MetalButton } from "./MetalButton";
import { useWindowFocused } from "./useWindowFocused";
import { toast } from "./toast";

/**
 * Does this row point at another tool's transcript rather than a GG Coder
 * session? Those need an import before they can be opened.
 */
function isForeignSession(session: RecentSession): boolean {
  return session.source === "claude-code" || session.source === "codex";
}

interface Props {
  /** Called after the agent has been re-pointed at `cwd` (+ optional session). */
  onChosen: (cwd: string) => void;
  /**
   * When set, open straight to this project's session list (used by the "back
   * to sessions" affordance from inside a project). Falls back to the full
   * project list if the path isn't among the discovered projects.
   */
  initialProjectPath?: string | null;
  /** Shown when the picker is reachable from an open project (enables "back"). */
  onClose?: () => void;
}

/**
 * Full-window project chooser shown when a window has no project yet. Lists
 * every known project (ggcoder/Claude Code/Codex). Selecting one reveals its
 * latest sessions; picking "New session" or an existing session re-points this
 * window's agent at that project cwd.
 */
export function ProjectPicker({
  onChosen,
  initialProjectPath,
  onClose,
}: Props): React.ReactElement {
  const windowFocused = useWindowFocused();
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [loading, setLoading] = useState(true);
  // Project discovery failed; shown instead of "No projects yet".
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selected, setSelected] = useState<DiscoveredProject | null>(null);
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  // Listing the selected project's sessions failed; shown instead of
  // "No previous sessions".
  const [sessionsError, setSessionsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [projectsRoot, setProjectsRoot] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filteredProjects = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    : projects;

  // Multi-window shortcuts work from the picker too, so you can cycle/arrange
  // before choosing a project.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.code === "Backquote" && !e.altKey) {
        e.preventDefault();
        void focusWindowByOffset(e.shiftKey ? -1 : 1);
      } else if (e.shiftKey && (e.key === "a" || e.key === "A") && !e.altKey) {
        e.preventDefault();
        void arrangeAllWindows();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Settings are read natively (Rust) — no sidecar wait needed.
    void getSettings()
      .then((s) => {
        if (!cancelled && s) setProjectsRoot(s.projectsRoot);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    // The window's sidecar serves project discovery; wait for it before asking.
    void waitForReady()
      .then(() => listProjects())
      .then((p) => {
        if (cancelled) return;
        setProjects(p);
        setLoading(false);
        // Deep-link straight to the current project's sessions when asked.
        if (initialProjectPath) {
          const match = p.find((proj) => proj.path === initialProjectPath);
          if (match) openProject(match);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce]);

  /**
   * Drop a project from the list and persist the decision. Removed optimistically
   * because discovery is a multi-store filesystem scan — re-listing to confirm
   * would leave the row sitting there for a visible beat.
   */
  function hideProject(project: DiscoveredProject): void {
    let index = -1;
    setProjects((prev) => {
      index = prev.findIndex((p) => p.path === project.path);
      return prev.filter((p) => p.path !== project.path);
    });
    void setProjectHidden(project.path, true).catch(() => {
      // Persisting failed, so the row is still real: put it back at its old
      // position rather than leaving the list disagreeing with what the next
      // launch will show. Rows are sorted by recency server-side, so restoring
      // by index preserves that order without duplicating the sort here.
      setProjects((prev) => {
        if (prev.some((p) => p.path === project.path)) return prev;
        const next = [...prev];
        next.splice(index < 0 ? next.length : index, 0, project);
        return next;
      });
    });
  }

  function openProject(project: DiscoveredProject): void {
    setSelected(project);
    setSessions([]);
    setResumeError(null);
    setSessionsError(false);
    setSessionsLoading(true);
    void listSessions(project.path)
      .then((s) => {
        setSessions(s);
        setSessionsLoading(false);
      })
      .catch(() => {
        setSessionsError(true);
        setSessionsLoading(false);
      });
  }

  function choose(cwd: string, sessionPath?: string): void {
    if (busy) return;
    setBusy(true);
    setResumeError(null);
    // Rust now resolves this command only after the daemon session is ready.
    // A failed resume therefore stays in the picker and shows its real cause.
    void selectProject(cwd, sessionPath)
      .then(() => onChosen(cwd))
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        setResumeError(
          message
            .replace(/Run ["'`]?ggcoder login["'`]?/gi, "Use AI Providers to sign in")
            .replace(/ggcoder login/gi, "AI Providers"),
        );
        setBusy(false);
      });
  }

  /**
   * Open a session row. A native row resumes directly; a Claude Code / Codex row
   * is imported into a real GG Coder session first, then opened by its new path.
   * The import is silent — from the user's side this is just "open that
   * conversation", which is why there is no separate import affordance.
   */
  function chooseSession(cwd: string, session: RecentSession): void {
    if (busy) return;
    if (!isForeignSession(session)) {
      choose(cwd, session.path);
      return;
    }
    setBusy(true);
    setResumeError(null);
    void importTranscript(session.path, cwd)
      .then((result) => {
        if (!result.ok) {
          setResumeError(`Could not import that conversation: ${result.error}`);
          setBusy(false);
          return;
        }
        // Re-enter the normal resume path with the freshly written session.
        setBusy(false);
        choose(cwd, result.sessionPath);
      })
      .catch((reason: unknown) => {
        setResumeError(
          `Could not import that conversation: ${
            reason instanceof Error ? reason.message : String(reason)
          }`,
        );
        setBusy(false);
      });
  }

  // Open an existing folder from disk as a project. The native folder picker is
  // directories-only (that's where projects live); a chosen path re-points this
  // window's agent exactly like selecting a discovered project.
  function openExisting(): void {
    if (busy) return;
    void openFolderDialog({
      directory: true,
      multiple: false,
      title: "Open existing project",
    })
      .then((picked) => {
        if (typeof picked === "string") choose(picked);
      })
      .catch((e: unknown) => toast(`Couldn't open the folder picker: ${String(e)}`, "error"));
  }

  return (
    <div className="picker">
      <div className="picker-head" data-tauri-drag-region>
        {selected ? (
          <BackButton label="All projects" onClick={() => setSelected(null)} />
        ) : onClose ? (
          <BackButton label="Back" onClick={onClose} />
        ) : null}
        <span className="picker-title">{selected ? selected.name : "Choose a project"}</span>
        {!selected && !loading && !loadError && <Badge>{projects.length}</Badge>}
        {!selected && !loading && projects.length > 0 && (
          <input
            className="picker-search"
            type="text"
            placeholder={"Search projects\u2026"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search projects"
          />
        )}
        <span className="picker-head-actions">
          {selected ? (
            <MetalButton
              windowFocused={windowFocused}
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => choose(selected.path)}
            >
              {"+ New session"}
            </MetalButton>
          ) : (
            <>
              <button
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={openExisting}
              >
                {"Open existing"}
              </button>
              <MetalButton
                windowFocused={windowFocused}
                className="btn btn-primary btn-sm"
                onClick={() => setShowNew(true)}
              >
                {"+ New project"}
              </MetalButton>
            </>
          )}
          <RadioButton />
          <WindowLayoutButton />
        </span>
      </div>

      {!selected ? (
        <div className="picker-list">
          {loading && <ListSkeleton rows={6} />}
          {!loading && loadError && (
            <div className="picker-empty" role="alert">
              <span style={{ color: theme.textMuted }}>Couldn't load your projects.</span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setReloadNonce((n) => n + 1)}
              >
                Try again
              </button>
            </div>
          )}
          {!loading && !loadError && projects.length === 0 && (
            <div className="picker-empty">
              <span style={{ color: theme.textMuted }}>No projects yet.</span>
              <span style={{ display: "flex", gap: "var(--space-4)" }}>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={openExisting}
                >
                  {"Open existing"}
                </button>
                <MetalButton
                  windowFocused={windowFocused}
                  className="btn btn-primary btn-sm"
                  onClick={() => setShowNew(true)}
                >
                  {"+ New project"}
                </MetalButton>
              </span>
            </div>
          )}
          {!loading && projects.length > 0 && filteredProjects.length === 0 && (
            <div className="picker-empty" style={{ color: theme.textMuted }}>
              {`No projects match \u201c${query.trim()}\u201d`}
            </div>
          )}
          {!loading && filteredProjects.length > 0 && (
            <div className="picker-reveal">
              {filteredProjects.map((p) => (
                <div key={p.path} className="picker-item-wrap">
                  <button className="picker-item" onClick={() => openProject(p)} title={p.path}>
                    <span className="picker-row">
                      <span className="picker-name" style={{ color: theme.text }}>
                        {p.name}
                      </span>
                      <Badge>{p.lastActiveDisplay}</Badge>
                    </span>
                    {/* Where the project comes from, as tinted glass pills. */}
                    <span className="picker-sources">
                      {p.sources.map((s) => {
                        const { label, color } = sourceStyle(s);
                        return (
                          <Badge key={s} color={color}>
                            {label}
                          </Badge>
                        );
                      })}
                    </span>
                  </button>
                  <button
                    className="picker-hide"
                    aria-label={`Hide ${p.name}`}
                    title="Hide from this list"
                    onClick={() => hideProject(p)}
                  >
                    {/* The same drawn X as the modal close buttons: a text ×
                        sits low and off-centre in a round button. */}
                    <XIcon size={12} weight="bold" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="picker-list">
          {resumeError && (
            <div className="picker-error" role="alert">
              {resumeError}
            </div>
          )}
          {sessionsError && (
            <div className="picker-error" role="alert">
              <span>Couldn't load this project's sessions.</span>{" "}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => openProject(selected)}
              >
                Try again
              </button>
            </div>
          )}
          {sessionsLoading && <ListSkeleton rows={4} />}
          {!sessionsLoading && !sessionsError && sessions.length === 0 && (
            <div className="picker-empty">
              <span style={{ color: theme.textMuted }}>No previous sessions yet.</span>
              <MetalButton
                windowFocused={windowFocused}
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => choose(selected.path)}
              >
                {"+ New session"}
              </MetalButton>
            </div>
          )}
          {!sessionsLoading && sessions.length > 0 && (
            <div className="picker-reveal">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  className="picker-item"
                  disabled={busy}
                  onClick={() => chooseSession(selected.path, s)}
                  title={
                    isForeignSession(s)
                      ? `From ${sourceStyle(s.source ?? "").label} — opens as a GG Coder session`
                      : undefined
                  }
                >
                  <span className="picker-row">
                    <span className="picker-name picker-preview" style={{ color: theme.text }}>
                      {s.preview || "(no preview)"}
                    </span>
                    <Badge>{s.lastActiveDisplay}</Badge>
                  </span>
                  <span className="picker-meta" style={{ color: theme.textMuted }}>
                    {isForeignSession(s) && (
                      <Badge
                        className="picker-source-tag"
                        color={sourceStyle(s.source ?? "").color}
                      >
                        {sourceStyle(s.source ?? "").label}
                      </Badge>
                    )}
                    <Badge>{`${s.messageCount} msgs`}</Badge>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {showNew && (
        <NewProjectModal
          projectsRoot={projectsRoot}
          onClose={() => setShowNew(false)}
          onCreated={(cwd) => {
            setShowNew(false);
            onChosen(cwd);
          }}
        />
      )}
    </div>
  );
}
