import { useEffect, useState } from "react";
import { theme } from "./theme";
import {
  arrangeAllWindows,
  focusWindowByOffset,
  getSettings,
  listSessions,
  selectWorkspace,
  waitForReady,
  type ChatAgentId,
  type RecentSession,
} from "./agent";
import { Badge } from "./Badge";
import { BackButton } from "./BackButton";
import { ListSkeleton } from "./Skeleton";
import { RadioButton } from "./RadioButton";
import { WindowLayoutButton } from "./WindowLayoutButton";

interface Props {
  onChosen: (cwd: string) => void;
  onClose?: () => void;
  initialAgent?: ChatAgentId;
  waitForCatalogReady?: () => Promise<unknown>;
  discoverSessions?: (cwd: string, chatAgent?: ChatAgentId | "all") => Promise<RecentSession[]>;
  bindChat?: (
    cwd: string,
    sessionPath: string | undefined,
    chatAgent: ChatAgentId,
  ) => Promise<unknown>;
  showWindowControls?: boolean;
}

/** Agent and session chooser rooted at the configured projects folder. */
export function ChatPicker({
  onChosen,
  onClose,
  initialAgent = "general",
  waitForCatalogReady = waitForReady,
  discoverSessions = listSessions,
  bindChat = (cwd, sessionPath, chatAgent) => selectWorkspace("chat", cwd, sessionPath, chatAgent),
  showWindowControls = true,
}: Props): React.ReactElement {
  const [projectsRoot, setProjectsRoot] = useState("");
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      if (event.code === "Backquote" && !event.altKey) {
        event.preventDefault();
        void focusWindowByOffset(event.shiftKey ? -1 : 1);
      } else if (event.shiftKey && (event.key === "a" || event.key === "A") && !event.altKey) {
        event.preventDefault();
        void arrangeAllWindows();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getSettings()
      .then(async (settings) => {
        const root = settings?.projectsRoot.trim() ?? "";
        if (!root) throw new Error("Choose a projects folder in Settings before starting a chat.");
        if (!cancelled) setProjectsRoot(root);
        await waitForCatalogReady();
        return discoverSessions(root, "all");
      })
      .then((recent) => {
        if (!cancelled) setSessions(recent);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Chats could not be loaded.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [discoverSessions, waitForCatalogReady]);

  function choose(session?: RecentSession): void {
    if (busy || !projectsRoot) return;
    setBusy(true);
    void bindChat(projectsRoot, session?.path, session?.chatAgent ?? initialAgent)
      .then(() => onChosen(projectsRoot))
      .catch(() => setBusy(false));
  }

  return (
    <div className="picker chat-picker">
      <div className="picker-head" data-tauri-drag-region>
        {onClose ? <BackButton label="Back" onClick={onClose} /> : null}
        <span className="picker-title">Chats</span>
        {!loading && !error && <Badge>{sessions.length}</Badge>}
        <span className="picker-head-actions">
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || loading || !projectsRoot}
            onClick={() => choose()}
          >
            {"+ New chat"}
          </button>
          {showWindowControls && (
            <>
              <RadioButton />
              <WindowLayoutButton />
            </>
          )}
        </span>
      </div>

      <div className="picker-list">
        {loading && <ListSkeleton rows={5} />}
        {!loading && error && (
          <div className="picker-empty" style={{ color: theme.textMuted }}>
            {error}
          </div>
        )}
        {!loading && !error && sessions.length === 0 && (
          <div className="picker-empty">
            <span style={{ color: theme.textMuted }}>No previous chats yet.</span>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => choose()}>
              {"+ New chat"}
            </button>
          </div>
        )}
        {!loading && !error && sessions.length > 0 && (
          <div className="picker-reveal">
            {sessions.map((session) => (
              <button
                key={session.id}
                className="picker-item"
                disabled={busy}
                onClick={() => choose(session)}
              >
                <span className="picker-row">
                  <span className="picker-name picker-preview" style={{ color: theme.text }}>
                    {session.preview || "(no preview)"}
                  </span>
                  <Badge>{session.lastActiveDisplay}</Badge>
                </span>
                <span className="picker-meta" style={{ color: theme.textMuted }}>
                  {`${session.messageCount} msgs`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
