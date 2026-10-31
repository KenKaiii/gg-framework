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
  type PermissionsStatus,
} from "./agent";
import { toast } from "./toast";
import { SoundButton } from "./SoundButton";
import { AppearancePicker } from "./AppearancePicker";
import { HomeBackgroundButton } from "./HomeBackgroundButton";
import { KeepAwakeButton } from "./KeepAwakeButton";
import { SettingsSection } from "./settings-section";
import { useSettingsPageReady } from "./settings-ready";

interface Props {
  onClose: () => void;
  /** Called with the saved projects root so callers can refresh. */
  onSaved?: (projectsRoot: string) => void;
}

export function SettingsModal({ onClose, onSaved }: Props): React.ReactElement {
  const embedded = useModalEmbedState() === "embed";
  const [projectsRoot, setProjectsRoot] = useState("");
  // What's on disk, so the page saves only a real change and can put the
  // field back after an empty entry or a failed save.
  const [savedRoot, setSavedRoot] = useState("");
  // False while the field only shows the default: nothing is on disk yet, so
  // Home still asks for a folder until this one is saved (issue #125).
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState(false);
  const [permissions, setPermissions] = useState<PermissionsStatus | null>(null);
  const [settingsRead, setSettingsRead] = useState(false);
  // On the Settings page, wait for the folder and the Permissions card so the
  // page doesn't paint without them and then shift.
  useSettingsPageReady(settingsRead && permissions !== null);

  useEffect(() => {
    // Native (Rust) read — no sidecar wait needed.
    void getSettings()
      .then((s) => {
        if (!s) return;
        setProjectsRoot(s.projectsRoot);
        setSavedRoot(s.projectsRoot);
        setConfigured(s.configured);
      })
      .catch(() => {})
      .finally(() => setSettingsRead(true));
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
    if (typeof picked !== "string") return;
    setProjectsRoot(picked);
    if (embedded) void persist(picked);
  }

  /**
   * The Settings page has no Save: like every other setting there, the folder
   * saves as soon as it's chosen (Browse) or the field is left. An empty entry
   * is never saved; the field goes back to the saved folder.
   */
  async function persist(value: string): Promise<void> {
    const root = value.trim();
    if (!root) {
      setProjectsRoot(savedRoot);
      return;
    }
    if ((configured && root === savedRoot) || busy) return;
    setBusy(true);
    try {
      await saveSettings(root);
      setSavedRoot(root);
      setConfigured(true);
      setProjectsRoot(root);
      onSaved?.(root);
    } catch (e) {
      setProjectsRoot(savedRoot);
      toast(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy(false);
    }
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
    <Modal title={embedded ? "General" : "Settings"} onClose={onClose}>
      {/* On the Settings screen: a grid of equal cards, two side by side
          where there's room (see .settings-grid in Deck.css). In the dialog
          the wrapper is transparent and the cards stack. */}
      <div className="settings-cols settings-grid">
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
            title="Appearance"
            description="Light or dark. Auto follows your computer's setting. Applies to every window."
          >
            <div className="modal-row">
              <AppearancePicker />
            </div>
          </SettingsSection>
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
            <div className="modal-row">
              <KeepAwakeButton />
            </div>
          </SettingsSection>
        </div>
        <div className="settings-col">
          <SettingsSection
            title="Project folder"
            description={
              configured
                ? "Where new projects are created."
                : "Not saved yet. Press Enter to use this folder, or Browse for another."
            }
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
                onBlur={embedded ? (e) => void persist(e.currentTarget.value) : undefined}
                onKeyDown={
                  embedded
                    ? (e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }
                    : undefined
                }
              />
              <button className="modal-btn" onClick={() => void browse()}>
                {"Browse\u2026"}
              </button>
            </div>
          </SettingsSection>
          {/* The dialog saves on Save; the page saves as you go (see persist). */}
          {!embedded && (
            <div className="modal-actions">
              <ModalDismissButton onClick={onClose}>Cancel</ModalDismissButton>
              <button className="modal-btn primary" disabled={busy} onClick={() => void save()}>
                {busy ? "Saving\u2026" : "Save"}
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
