import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ModalDismissButton, useModalEmbedState } from "./modal-embed";
import { Badge } from "./Badge";
import {
  getSettings,
  saveSettings,
  getPermissionsStatus,
  openPermissionsSettings,
  waitForReady,
  type PermissionsStatus,
} from "./agent";
import { toast } from "./toast";
import { SoundButton } from "./SoundButton";
import { HomeBackgroundButton } from "./HomeBackgroundButton";
import { getKeepAwake, setKeepAwake } from "./kleio/keepAwake";
import { SettingsSection } from "./settings-section";
import { SettingsHeaderAction } from "./settings-header";
import { isPhone } from "./platform";

interface Props {
  onClose: () => void;
  /** Called with the saved projects root so callers can refresh. */
  onSaved?: (projectsRoot: string) => void;
}

export function SettingsModal({ onClose, onSaved }: Props): React.ReactElement {
  const embedded = useModalEmbedState() === "embed";
  const [projectsRoot, setProjectsRoot] = useState("");
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null);
  // null until the sidecar answers; the setting defaults to on.
  const [keepAwake, setKeepAwakeState] = useState<boolean | null>(null);
  const [keepAwakeBusy, setKeepAwakeBusy] = useState(false);

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

  useEffect(() => {
    let cancelled = false;
    void waitForReady()
      .then(getKeepAwake)
      .then((enabled) => {
        if (!cancelled) setKeepAwakeState(enabled);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Saved by the sidecar and applied live, including to a run in progress.
  async function toggleKeepAwake(): Promise<void> {
    if (keepAwake === null || keepAwakeBusy) return;
    setKeepAwakeBusy(true);
    try {
      await waitForReady();
      setKeepAwakeState(await setKeepAwake(!keepAwake));
    } catch (e) {
      toast(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setKeepAwakeBusy(false);
    }
  }

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

  // On the Settings screen this is the General tab; the screen already says
  // "Settings".
  const saveButton = (
    <button
      // In the Settings header it matches the nav bars' small buttons.
      className={embedded ? "btn btn-primary btn-sm" : "modal-btn primary"}
      disabled={busy}
      onClick={() => void save()}
    >
      {busy ? "Saving\u2026" : "Save"}
    </button>
  );

  return (
    <Modal title={embedded ? "General" : "Settings"} onClose={onClose}>
      {/* Columns only on the Settings screen; in the dialog they are
          transparent (see .settings-cols in App.css). */}
      <div className="settings-cols">
        <div className="settings-col">
          {permissions?.applicable && (
            <SettingsSection title="Permissions" description="Full Disk Access for GG Coder.">
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
            </SettingsSection>
          )}
          <SettingsSection
            title="Effects"
            description="Sounds, and the home screen's moving background."
          >
            <div className="modal-row">
              <SoundButton variant="settings" />
              <HomeBackgroundButton />
            </div>
          </SettingsSection>
          <SettingsSection
            title="Power"
            description="Stop your computer sleeping mid-task. The screen can still turn off."
          >
            <label>
              <input
                type="checkbox"
                checked={keepAwake ?? true}
                disabled={keepAwake === null || keepAwakeBusy}
                onChange={() => void toggleKeepAwake()}
              />{" "}
              Keep computer awake while the agent works
            </label>
          </SettingsSection>
        </div>
        <div className="settings-col">
          {embedded && <SettingsHeaderAction>{saveButton}</SettingsHeaderAction>}
          <SettingsSection
            title="Project folder"
            description="Where new projects are created."
            dialogHint={
              <div className="modal-hint" style={{ color: theme.textDim }}>
                New projects are created inside this folder.
              </div>
            }
          >
            <div className="modal-row">
              <input
                className="modal-input"
                style={{ color: theme.text, background: theme.inputBackground }}
                value={projectsRoot}
                placeholder="/Users/you/gg-projects"
                onChange={(e) => setProjectsRoot(e.target.value)}
              />
              {/* kleio: the folder lives on the Mac mini; the iPhone's own file
                  picker could only hand back a path on the phone. */}
              {!isPhone() && (
                <button className="modal-btn" onClick={() => void browse()}>
                  {"Browse\u2026"}
                </button>
              )}
            </div>
          </SettingsSection>
          {/* On the page, Save sits in the screen's header bar instead. */}
          {!embedded && (
            <div className="modal-actions">
              <ModalDismissButton onClick={onClose}>Cancel</ModalDismissButton>
              {saveButton}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
