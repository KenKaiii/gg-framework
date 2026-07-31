import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { Badge } from "./Badge";
import {
  getSettings,
  saveSettings,
  getPermissionsStatus,
  openPermissionsSettings,
  type PermissionsStatus,
} from "./agent";
import { toast } from "./toast";
import { SoundButton } from "./SoundButton";
import { formatBuildIdentity } from "./build-info";
import { AzureConnectionSettings } from "./AzureConnectionSettings";

interface Props {
  onClose: () => void;
  /** Called with the saved projects root so callers can refresh. */
  onSaved?: (projectsRoot: string) => void;
  onAzureConnectionChanged?: () => void;
}

export function SettingsModal({
  onClose,
  onSaved,
  onAzureConnectionChanged,
}: Props): React.ReactElement {
  const [projectsRoot, setProjectsRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null);
  const buildIdentity = formatBuildIdentity();

  useEffect(() => {
    // Native (Rust) read — no sidecar wait needed.
    void getSettings()
      .then((s) => {
        if (s) setProjectsRoot(s.projectsRoot);
      })
      .catch(() => {});
  }, []);

  // The permission is granted OUTSIDE the app (System Settings), so re-check
  // whenever the window regains focus — the common flow is: click "Grant",
  // flip it in System Settings, alt-tab back. Not applicable on platforms with
  // nothing to grant (Windows/Linux) — the row hides itself in that case.
  useEffect(() => {
    const refresh = (): void => void getPermissionsStatus().then(setPermissions);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  async function browse(): Promise<void> {
    const picked = await open({ directory: true, multiple: false, title: "Projects folder" });
    if (typeof picked === "string") setProjectsRoot(picked);
  }

  async function save(): Promise<void> {
    if (!projectsRoot.trim() || busy) return;
    setBusy(true);
    try {
      // Saved natively in Rust (writes ~/.gg/gg-app.json) — no sidecar round-trip,
      // so this works even while the sidecar is still booting or has crashed.
      await saveSettings(projectsRoot.trim());
      onSaved?.(projectsRoot.trim());
      onClose();
    } catch (e) {
      toast(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Settings" onClose={onClose} className="settings-modal">
      {permissions?.applicable && (
        <>
          <div className="modal-label" style={{ color: theme.textMuted }}>
            Permissions
          </div>
          <div className="modal-row">
            <button
              className="modal-btn"
              onClick={() => void openPermissionsSettings()}
              disabled={permissions.granted}
            >
              {permissions.granted ? "Permissions granted" : "Grant Permissions…"}
            </button>
            <Badge color={permissions.granted ? theme.success : theme.textMuted}>
              {permissions.granted ? "Granted" : "Not granted"}
            </Badge>
          </div>
        </>
      )}
      <div className="modal-label" style={{ color: theme.textMuted }}>
        Sound effects
      </div>
      <div className="modal-row">
        <SoundButton variant="settings" />
      </div>
      <div className="modal-label" style={{ color: theme.textMuted }}>
        Project folder
      </div>
      <div className="modal-hint" style={{ color: theme.textDim }}>
        New projects are created inside this folder.
      </div>
      <div className="modal-row">
        <input
          className="modal-input"
          style={{ color: theme.text, background: theme.inputBackground }}
          value={projectsRoot}
          placeholder="/Users/you/gg-projects"
          onChange={(e) => setProjectsRoot(e.target.value)}
        />
        <button className="modal-btn" onClick={() => void browse()}>
          {"Browse\u2026"}
        </button>
      </div>
      <AzureConnectionSettings onConnectionChanged={onAzureConnectionChanged} />
      {buildIdentity && (
        <div className="modal-build-identity" style={{ color: theme.textDim }}>
          {buildIdentity}
        </div>
      )}
      <div className="modal-actions">
        <button className="modal-btn" onClick={onClose}>
          Cancel
        </button>
        <button className="modal-btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving\u2026" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
