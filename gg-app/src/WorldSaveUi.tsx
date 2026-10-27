import { useId, useState } from "react";
import { CloudIcon } from "@phosphor-icons/react";
import { openUrl } from "./agent";
import { Modal } from "./Modal";
import type { WorldSaveStatus } from "./world-save";

export const WORLD_PRIVACY_URL =
  "https://github.com/KenKaiii/gg-framework/blob/main/GG-WORLD-PRIVACY.md";
export const COMMUNITY_RULES_URL =
  "https://github.com/KenKaiii/gg-framework/blob/main/COMMUNITY-RULES.md";

function DocLink({ href, children }: { href: string; children: string }): React.ReactElement {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

const LIVE_TICK = "Join the live world: meet real players and chat in public";

/** The live tick, with its Community rules link. */
function LiveTick({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
}): React.ReactElement {
  const id = useId();
  return (
    <>
      <label className="world-consent-tick" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        {LIVE_TICK}
      </label>
      <DocLink href={COMMUNITY_RULES_URL}>Community rules</DocLink>
    </>
  );
}

/** Asked once of players who agreed to online save before the live world existed. */
export function WorldLiveConsent({
  onAnswer,
  onClose,
}: {
  onAnswer: (on: boolean) => void;
  onClose: () => void;
}): React.ReactElement {
  const [live, setLive] = useState(false);
  return (
    <Modal title="Join the live world?" onClose={onClose} className="world-consent">
      <div className="world-consent-body">
        <p>
          Other players would see your name, look, level, where you are, emotes and public chat.
          Never your code, files, prompts or screen.
        </p>
        <DocLink href={WORLD_PRIVACY_URL}>Privacy</DocLink>
        <LiveTick checked={live} onChange={setLive} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onAnswer(false)}>
          Not now
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!live}
          onClick={() => onAnswer(true)}
        >
          Join
        </button>
      </div>
    </Modal>
  );
}

/** The one-time "Save World online?" box. Nothing is sent before "Save online". */
export function WorldConsent({
  onAnswer,
  onClose,
}: {
  onAnswer: (on: boolean, live?: boolean) => void;
  onClose: () => void;
}): React.ReactElement {
  const [adult, setAdult] = useState(false);
  const [live, setLive] = useState(false);
  const tickId = useId();
  return (
    <Modal title="Save World online?" onClose={onClose} className="world-consent">
      <div className="world-consent-body">
        <p>
          Keeps your character, name and the items you've bought safe across reinstalls and
          computers. It sends only your World name, how your character looks, the items you own,
          coins spent and your coding level. Never your code, files or prompts.
        </p>
        <DocLink href={WORLD_PRIVACY_URL}>Privacy</DocLink>
        <label className="world-consent-tick" htmlFor={tickId}>
          <input
            id={tickId}
            type="checkbox"
            checked={adult}
            onChange={(e) => setAdult(e.target.checked)}
          />
          I'm 18 or over
        </label>
        <LiveTick checked={live} onChange={setLive} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onAnswer(false)}>
          Keep it on this computer
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!adult}
          onClick={() => onAnswer(true, live)}
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
  if (status === "error") return "Can't reach the server right now. Trying again";
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
  onDeleteAccount,
  onRetry,
}: {
  on: boolean;
  status: WorldSaveStatus;
  savedAt: number | null;
  onTurnOn: () => void;
  onTurnOff: () => void;
  onDelete: () => Promise<boolean>;
  /** Delete the whole World account (server + this device). */
  onDeleteAccount: () => Promise<boolean>;
  /** Try the save again now (shown while it's failing). */
  onRetry?: () => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmingAccount, setConfirmingAccount] = useState(false);
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
          setConfirmingAccount(false);
        }}
      >
        <CloudIcon size={16} weight={on ? "fill" : "regular"} aria-hidden="true" />
      </button>
      {open && (
        <div id={panelId} className="world-cloud-panel" role="group" aria-label="Online save">
          <span className="world-cloud-status">{statusText(status, savedAt)}</span>
          {status === "error" && on && onRetry && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>
              Try again now
            </button>
          )}
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
          {confirmingAccount ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost world-cloud-danger"
              onClick={() => {
                void onDeleteAccount().then((ok) => {
                  if (ok) setOpen(false);
                  setConfirmingAccount(false);
                });
              }}
            >
              Yes, delete my account
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setConfirmingAccount(true)}
            >
              Delete my account
            </button>
          )}
        </div>
      )}
    </div>
  );
}
