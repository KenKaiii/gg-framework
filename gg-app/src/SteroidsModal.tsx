import { useEffect, useState } from "react";
import { CheckCircleIcon, XCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ModalDismissButton, useModalEmbedState } from "./modal-embed";
import { SettingsSection } from "./settings-section";
import { ListSkeleton } from "./Skeleton";
import {
  getSteroidsStatus,
  installSteroids,
  onSteroidsChange,
  openUrl,
  type SteroidsStatus,
} from "./agent";
import { toast } from "./toast";

interface Props {
  status: SteroidsStatus | null;
  onStatus: (status: SteroidsStatus) => void;
  onClose: () => void;
}

const README_URL = "https://github.com/KenKaiii/agent-steroids#readme";

function fmt(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * Agent Steroids — a local corpus of real repos the agent reads before it
 * writes. Shows the install/corpus state and installs the `steroids` binary
 * (verified release download, see core/steroids.ts) when it is missing.
 */
export function SteroidsModal({ status, onStatus, onClose }: Props): React.ReactElement {
  const embedded = useModalEmbedState() === "embed";
  const [installing, setInstalling] = useState(false);

  // Re-probe on open so a `cargo install` done in a terminal shows up without
  // an app restart; follow installs finished by any other window.
  useEffect(() => {
    void getSteroidsStatus().then(onStatus);
    return onSteroidsChange(onStatus);
  }, [onStatus]);

  async function install(): Promise<void> {
    if (installing) return;
    setInstalling(true);
    try {
      const next = await installSteroids();
      onStatus(next);
      toast(`Steroids ${next.version ?? ""} installed.`, "success");
    } catch (e) {
      toast(`Install failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setInstalling(false);
    }
  }

  const tone = !status
    ? null
    : status.connected
      ? { color: theme.success, icon: <CheckCircleIcon size={15} />, label: "Connected" }
      : status.installed && !status.error
        ? { color: theme.warning, icon: <WarningCircleIcon size={15} />, label: "Empty corpus" }
        : {
            color: theme.error,
            icon: <XCircleIcon size={15} />,
            label: status.installed ? "Broken" : "Not installed",
          };

  return (
    <Modal title="Steroids" onClose={onClose}>
      <SettingsSection
        title="Status"
        description="Lets your agent read current code from real repos first. Free and offline."
        dialogTitle={null}
        dialogHint={
          <div className="mcp-empty" style={{ color: theme.textMuted }}>
            Your agent writes last year&apos;s code. Steroids lets it read real, current repos on
            your disk first. Free, offline, no limits.
          </div>
        }
      >
        {!status || !tone ? (
          <ListSkeleton rows={1} />
        ) : (
          <div className="mcp-list">
            <div className="mcp-item">
              <span className="mcp-dot" style={{ color: tone.color }}>
                {tone.icon}
              </span>
              <span className="mcp-name" style={{ color: theme.text }}>
                {tone.label}
              </span>
              {status.connected ? (
                <span className="mcp-meta" style={{ color: theme.textDim }}>
                  {`v${status.version} · ${status.repos} repos · ${fmt(status.documents ?? 0)} files`}
                </span>
              ) : !status.installed ? (
                <button
                  className="modal-btn primary"
                  style={{ padding: "2px 12px", fontSize: 12 }}
                  disabled={installing}
                  onClick={() => void install()}
                >
                  {installing ? "Installing\u2026" : "Install Steroids"}
                </button>
              ) : null}
            </div>
          </div>
        )}

        {status?.installed && !status.connected && (
          <div className="modal-hint" style={{ color: status.error ? theme.error : theme.textDim }}>
            {status.error ??
              "No repos yet. Ask the agent: \u201ccurate a Steroids corpus for this project\u201d."}
          </div>
        )}

        <div
          className="modal-hint"
          style={{ color: theme.textDim, ...(embedded ? {} : { marginTop: 12 }) }}
        >
          <a
            className="home-link"
            href={README_URL}
            onClick={(e) => {
              e.preventDefault();
              void openUrl(README_URL);
            }}
          >
            Read the README
          </a>
        </div>
      </SettingsSection>

      <div className="modal-actions">
        <ModalDismissButton onClick={onClose}>Close</ModalDismissButton>
      </div>
    </Modal>
  );
}
