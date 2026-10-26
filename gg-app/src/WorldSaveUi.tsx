import { useId, useState } from "react";
import { CloudIcon } from "@phosphor-icons/react";
import { openUrl } from "./agent";
import { Modal } from "./Modal";
import type { WorldSaveStatus } from "./world-save";

export const WORLD_PRIVACY_URL =
  "https://github.com/KenKaiii/gg-framework/blob/main/GG-ROYALE-PRIVACY.md#gg-world";

/** The one-time "Save World online?" box. Nothing is sent before "Save online". */
export function WorldConsent({
  onAnswer,
  onClose,
}: {
  onAnswer: (on: boolean) => void;
  onClose: () => void;
}): React.ReactElement {
  const [adult, setAdult] = useState(false);
  const tickId = useId();
  return (
    <Modal title="Save World online?" onClose={onClose} className="world-consent">
      <div className="world-consent-body">
        <p>
          Keeps your character, name and the items you've bought safe across reinstalls and
          computers. It sends only your World name, how your character looks, the items you own,
          coins spent and your coding level. Never your code, files or prompts.
        </p>
        <a
          href={WORLD_PRIVACY_URL}
          onClick={(e) => {
            e.preventDefault();
            void openUrl(WORLD_PRIVACY_URL);
          }}
        >
          Privacy
        </a>
        <label className="world-consent-tick" htmlFor={tickId}>
          <input
            id={tickId}
            type="checkbox"
            checked={adult}
            onChange={(e) => setAdult(e.target.checked)}
          />
          I'm 18 or over
        </label>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onAnswer(false)}>
          Keep it on this computer
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!adult}
          onClick={() => onAnswer(true)}
        >
          Save online
        </button>
      </div>
    </Modal>
  );
}

function statusText(status: WorldSaveStatus, savedAt: number | null): string {
  if (status === "off") return "Online save is off";
  if (status === "saving") return "Saving...";
  if (status === "error") return "Couldn't reach the server";
  if (savedAt !== null) {
    const t = new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `Saved online ${t}`;
  }
  return "Online save is on";
}

/** The cloud key beside Back, and its small panel. */
export function WorldCloudKey({
  on,
  status,
  savedAt,
  onTurnOn,
  onTurnOff,
  onDelete,
}: {
  on: boolean;
  status: WorldSaveStatus;
  savedAt: number | null;
  onTurnOn: () => void;
  onTurnOff: () => void;
  onDelete: () => Promise<boolean>;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const panelId = useId();
  return (
    <div className="world-cloud">
      <button
        type="button"
        className="btn-icon world-cloud-key"
        aria-label="Online save"
        title="Online save"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((o) => !o);
          setConfirming(false);
        }}
      >
        <CloudIcon size={16} weight={on ? "fill" : "regular"} aria-hidden="true" />
      </button>
      {open && (
        <div id={panelId} className="world-cloud-panel" role="group" aria-label="Online save">
          <span className="world-cloud-status">{statusText(status, savedAt)}</span>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setOpen(false);
              if (on) onTurnOff();
              else onTurnOn();
            }}
          >
            {on ? "Turn online save off" : "Turn online save on"}
          </button>
          {confirming ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost world-cloud-danger"
              onClick={() => {
                void onDelete().then((ok) => {
                  if (ok) setOpen(false);
                  setConfirming(false);
                });
              }}
            >
              Yes, delete it
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setConfirming(true)}
            >
              Delete my online save
            </button>
          )}
        </div>
      )}
    </div>
  );
}
