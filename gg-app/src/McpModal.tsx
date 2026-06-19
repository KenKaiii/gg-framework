import { useCallback, useEffect, useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ListSkeleton } from "./Skeleton";
import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  listProjects,
  type McpServerRow,
  type DiscoveredProject,
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
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [line, setLine] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [projectPath, setProjectPath] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // The cwd the current `servers` list was loaded with, so project-scoped rows
  // are removed from the project they were listed under.
  const [listCwd, setListCwd] = useState<string | undefined>(undefined);

  const refresh = useCallback(async (cwd?: string): Promise<void> => {
    setLoading(true);
    setListCwd(cwd);
    try {
      setServers(await listMcpServers(cwd));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  // Load discovered projects (for the Project-scope picker). Done once on mount
  // so switching to Project scope shows the list instantly.
  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch(() => {});
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
      toast("Pick a project first.", "warning");
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

  return (
    <Modal title="MCP servers" onClose={onClose}>
      {loading ? (
        <ListSkeleton rows={3} />
      ) : visible.length === 0 ? (
        <div className="mcp-empty" style={{ color: theme.textMuted }}>
          {scope === "global"
            ? "No global MCP servers configured."
            : "No project MCP servers configured."}
        </div>
      ) : (
        <div className="mcp-list">
          {visible.map((s) => (
            <div className="mcp-item" key={`${s.scope}:${s.name}`}>
              <span className="mcp-dot" style={{ color: s.ok ? theme.success : theme.error }}>
                {s.ok ? "\uD83D\uDFE2" : "\uD83D\uDD34"}
              </span>
              <span className="mcp-name" style={{ color: theme.text }} title={s.summary}>
                {s.name}
              </span>
              {s.ok && (
                <span className="mcp-meta" style={{ color: theme.textDim }}>
                  {`${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`}
                </span>
              )}
              <button
                className="mcp-delete"
                style={{ color: theme.textDim }}
                title={`Remove "${s.name}"`}
                onClick={() => void remove(s.name, s.scope)}
              >
                {"\u00d7"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="modal-label" style={{ color: theme.textMuted, marginTop: 4 }}>
        Add a server
      </div>
      <div className="modal-hint" style={{ color: theme.textDim }}>
        Paste a <code>claude mcp add …</code> or <code>ggcoder mcp add …</code> line.
      </div>
      <input
        className="modal-input"
        style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
        value={line}
        placeholder="claude mcp add --transport http notion https://mcp.notion.com/mcp"
        autoFocus
        onChange={(e) => setLine(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void add();
        }}
      />
      <div className="mcp-scope-toggle">
        <button
          className={`modal-btn${scope === "global" ? " primary" : ""}`}
          style={scopeBtnStyle(scope === "global")}
          onClick={() => setScope("global")}
        >
          Global
        </button>
        <button
          className={`modal-btn${scope === "project" ? " primary" : ""}`}
          style={scopeBtnStyle(scope === "project")}
          onClick={() => setScope("project")}
        >
          Project
        </button>
      </div>
      {scope === "project" && (
        <select
          className="modal-input"
          style={{
            color: projectPath ? theme.text : theme.textMuted,
            background: theme.inputBackground,
            width: "100%",
            marginTop: 10,
            cursor: "pointer",
          }}
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
        >
          <option value="" disabled>
            Choose a project…
          </option>
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
      )}

      <div className="modal-hint" style={{ color: theme.textDim, marginTop: 12 }}>
        New servers load on next app restart.
      </div>

      <div className="modal-actions">
        <button className="modal-btn" style={{ color: theme.textMuted }} onClick={onClose}>
          Close
        </button>
        <button
          className="modal-btn primary"
          style={{
            color: line.trim() && !busy ? theme.background : theme.textDim,
            background: line.trim() && !busy ? theme.primary : "transparent",
            borderColor: line.trim() && !busy ? theme.primary : theme.border,
          }}
          disabled={!line.trim() || busy}
          onClick={() => void add()}
        >
          {busy ? "Adding\u2026" : "Add"}
        </button>
      </div>
    </Modal>
  );
}

/** Inline style for the scope-toggle buttons; active = primary fill. */
function scopeBtnStyle(active: boolean): React.CSSProperties {
  return active
    ? { color: theme.background, background: theme.primary, borderColor: theme.primary }
    : { color: theme.textMuted, background: "transparent", borderColor: theme.border };
}
