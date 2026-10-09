import { useCallback, useEffect, useState } from "react";
import { CheckCircleIcon, XCircleIcon, LockIcon, XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ModalDismissButton, useModalEmbedState } from "./modal-embed";
import { ListSkeleton } from "./Skeleton";
import { SettingsCard, SettingsSection } from "./settings-section";
import { SettingsHeaderAction } from "./settings-header";
import {
  openUrl,
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  loginMcpServer,
  listProjects,
  subscribe,
  type McpServerRow,
  type DiscoveredProject,
  type SidecarEvent,
} from "./agent";
import { toast } from "./toast";

interface Props {
  onClose: () => void;
}

/**
 * MCP server manager — mirrors `ggcoder mcp`. Lists configured servers with live
 * connection status + tool counts, adds them via the same paste-a-`claude mcp
 * add …` grammar (the sidecar reuses the CLI parser verbatim), and removes them.
 *
 * Scope: Global writes to ~/.gg/mcp.json (all sessions). Project writes to a
 * chosen project's `.gg/mcp.json` — a project picker appears when Project is
 * selected, since the modal has no inherent project context. Like the CLI, a
 * newly-added server needs an app restart to load (MCP connects once at startup).
 */
export function McpModal({ onClose }: Props): React.ReactElement {
  const embedded = useModalEmbedState() === "embed";
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [loading, setLoading] = useState(true);
  // The last list request failed; shown instead of "No MCP's configured".
  const [loadError, setLoadError] = useState(false);
  const [line, setLine] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [projectPath, setProjectPath] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // The cwd the current `servers` list was loaded with, so project-scoped rows
  // are removed from the project they were listed under.
  const [listCwd, setListCwd] = useState<string | undefined>(undefined);
  // Name of the server currently mid-login (disables its button + shows status).
  const [loggingIn, setLoggingIn] = useState<string | null>(null);

  const refresh = useCallback(async (cwd?: string): Promise<void> => {
    setLoading(true);
    setListCwd(cwd);
    try {
      setServers(await listMcpServers(cwd));
      setLoadError(false);
    } catch (e) {
      setLoadError(true);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  // Stream OAuth login progress for remote MCP servers. `mcp_auth_url` opens the
  // system browser; done/error give the user clear feedback and refresh the list
  // so a freshly-authorized server flips to connected.
  useEffect(() => {
    const unsub = subscribe((e: SidecarEvent) => {
      const d = e.data as Record<string, unknown>;
      const name = String(d.name ?? "");
      switch (e.type) {
        case "mcp_auth_url":
          toast(`Opening your browser to sign in to "${name}"\u2026`, "info");
          void openUrl(String(d.url ?? ""));
          break;
        case "mcp_auth_done": {
          setLoggingIn(null);
          const tools = Number(d.toolCount ?? 0);
          toast(`Signed in to "${name}" \u2014 ${tools} tools.`, "success");
          void refresh(listCwd).catch(() => {});
          break;
        }
        case "mcp_auth_error":
          setLoggingIn(null);
          toast(`Login failed for "${name}": ${String(d.message ?? "unknown error")}`, "error");
          break;
      }
    });
    return () => unsub();
  }, [refresh, listCwd]);

  // Load discovered projects (for the Project-scope picker). Done once on mount
  // so switching to Project scope shows the list instantly.
  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch(() => toast("Couldn't load your projects. Type the project path instead.", "warning"));
  }, []);

  // Re-list when the selected project changes (project servers differ per project).
  useEffect(() => {
    if (scope === "project" && projectPath) void refresh(projectPath).catch(() => {});
    if (scope === "global") void refresh().catch(() => {});
  }, [scope, projectPath, refresh]);

  async function add(): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed || busy) return;
    if (scope === "project" && !projectPath) {
      toast("Enter or pick a project path first.", "warning");
      return;
    }
    setBusy(true);
    try {
      const result = await addMcpServer(
        trimmed,
        scope,
        scope === "project" ? projectPath : undefined,
      );
      setLine("");
      if (result.connected) {
        toast(`Added "${result.name}" — ${result.toolCount} tools.`, "success");
      } else if (result.requiresAuth) {
        toast(`Added "${result.name}". Click "Sign in" to connect.`, "info");
      } else {
        toast(
          `Saved "${result.name}" (not connected${result.error ? `: ${result.error}` : ""}).`,
          "warning",
        );
      }
      await refresh(scope === "project" ? projectPath : undefined);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function signIn(name: string, rowScope: "global" | "project"): Promise<void> {
    if (loggingIn) return;
    setLoggingIn(name);
    try {
      await loginMcpServer(name, rowScope, rowScope === "project" ? listCwd : undefined);
      // Outcome arrives via the mcp_auth_* events above.
    } catch (e) {
      setLoggingIn(null);
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  async function remove(name: string, rowScope: "global" | "project"): Promise<void> {
    try {
      const { removed } = await removeMcpServer(
        name,
        rowScope,
        rowScope === "project" ? listCwd : undefined,
      );
      if (removed) {
        toast(`Removed "${name}".`, "success");
        await refresh(listCwd);
      } else {
        toast(`No "${name}" found.`, "warning");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  // Only show servers for the selected scope — loadServers merges global +
  // project, so without this a project-scoped row could surface in the Global
  // view and its delete would have no project cwd to target. The toggle selects
  // which scope you're managing.
  const visible = servers.filter((s) => s.scope === scope);

  const addButton = (
    <button
      // In the Settings header it matches the nav bars' small buttons.
      className={embedded ? "btn btn-primary btn-sm" : "modal-btn primary"}
      disabled={!line.trim() || busy}
      onClick={() => void add()}
    >
      {busy ? "Adding\u2026" : "Add"}
    </button>
  );

  const serverList = (
    <>
      {loading ? (
        <ListSkeleton rows={3} />
      ) : loadError ? (
        <div className="picker-empty" role="alert">
          <span style={{ color: theme.textMuted }}>Couldn't reach the agent to list servers.</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void refresh(listCwd).catch(() => {})}
          >
            Try again
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="mcp-empty" style={{ color: theme.textMuted }}>
          No MCP’s configured.
        </div>
      ) : (
        <div className="mcp-list">
          {visible.map((s) => (
            <div className="mcp-item" key={`${s.scope}:${s.name}`}>
              <span
                className="mcp-dot"
                style={{
                  color: s.ok ? theme.success : s.requiresAuth ? theme.warning : theme.error,
                }}
              >
                {s.ok ? (
                  <CheckCircleIcon size={15} />
                ) : s.requiresAuth ? (
                  <LockIcon size={14} />
                ) : (
                  <XCircleIcon size={15} />
                )}
              </span>
              <span className="mcp-name" style={{ color: theme.text }} title={s.summary}>
                {s.name}
              </span>
              {s.ok ? (
                <span className="mcp-meta" style={{ color: theme.textDim }}>
                  {`${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`}
                </span>
              ) : s.requiresAuth ? (
                <span className="mcp-meta" style={{ color: theme.warning }}>
                  Requires login
                </span>
              ) : null}
              {s.requiresAuth && !s.ok && (
                <button
                  className="modal-btn primary"
                  style={{ padding: "var(--space-1) var(--space-6)", fontSize: "var(--fs-sm)" }}
                  disabled={loggingIn === s.name}
                  title={`Sign in to "${s.name}"`}
                  onClick={() => void signIn(s.name, s.scope)}
                >
                  {loggingIn === s.name ? "Signing in\u2026" : "Sign in"}
                </button>
              )}
              <button
                className="mcp-delete"
                style={{ color: theme.textDim }}
                title={`Remove "${s.name}"`}
                onClick={() => void remove(s.name, s.scope)}
              >
                <XIcon size={12} weight="bold" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );

  return (
    <Modal title="MCP servers" onClose={onClose}>
      {/* Columns only on the Settings screen: servers beside the add form.
          In the dialog they are transparent (see .settings-cols in App.css). */}
      <div className="settings-cols">
        <div className="settings-col">
          {embedded ? (
            <SettingsCard title="Servers" description="Extra tools your agent can use.">
              {serverList}
            </SettingsCard>
          ) : (
            serverList
          )}
        </div>
        <div className="settings-col">
          {embedded && <SettingsHeaderAction>{addButton}</SettingsHeaderAction>}
          <SettingsSection
            title="Add a server"
            dialogTitle="Add an MCP"
            description="Paste a claude mcp add command. Loads after a restart."
          >
            <input
              className="modal-input"
              style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
              value={line}
              placeholder="claude mcp add --transport http notion https://mcp.notion.com/mcp"
              // A dialog focuses its first field; a Settings page leaves focus on
              // the tab bar so the arrow keys keep switching tabs.
              autoFocus={!embedded}
              onChange={(e) => setLine(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
              }}
            />
            <div className="mcp-scope-toggle">
              <button
                className={`modal-btn${scope === "global" ? " primary" : ""}`}
                onClick={() => setScope("global")}
              >
                Global
              </button>
              <button
                className={`modal-btn${scope === "project" ? " primary" : ""}`}
                onClick={() => setScope("project")}
              >
                Project
              </button>
            </div>
            {scope === "project" && (
              <>
                <input
                  className="modal-input"
                  style={{
                    color: projectPath ? theme.text : theme.textMuted,
                    background: theme.inputBackground,
                    width: "100%",
                    marginTop: "var(--space-5)",
                  }}
                  value={projectPath}
                  placeholder="Type a project path or pick below…"
                  list="mcp-project-paths"
                  onChange={(e) => setProjectPath(e.target.value)}
                />
                <datalist id="mcp-project-paths">
                  {projects.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.name}
                    </option>
                  ))}
                </datalist>
              </>
            )}
          </SettingsSection>

          {/* On the page the section description already says this. */}
          {!embedded && (
            <div
              className="modal-hint"
              style={{ color: theme.textDim, marginTop: "var(--space-6)" }}
            >
              New servers load on next app restart.
            </div>
          )}

          {/* On the page, Add sits in the screen's header bar instead. */}
          {!embedded && (
            <div className="modal-actions">
              <ModalDismissButton onClick={onClose}>Close</ModalDismissButton>
              {addButton}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
