import { useEffect, useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ModalDismissButton, useModalEmbedState } from "./modal-embed";
import { SettingsSection } from "./settings-section";
import { SettingsHeaderAction } from "./settings-header";
import { waitForReady, getTelegramStatus, openUrl, saveTelegramConfig } from "./agent";
import { toast } from "./toast";

interface Props {
  onClose: () => void;
  /** Called after a successful save so the caller can refresh serve state. */
  onSaved?: () => void;
}

/**
 * Telegram bot setup — mirrors `ggcoder telegram`. Collects a BotFather token
 * and the authorized numeric user id, verifies the token sidecar-side (getMe),
 * and saves to ~/.gg/telegram.json. The token field is left blank when one is
 * already saved (a masked preview is shown instead).
 */
export function TelegramSettingsModal({ onClose, onSaved }: Props): React.ReactElement {
  const embedded = useModalEmbedState() === "embed";
  const [botToken, setBotToken] = useState("");
  const [userId, setUserId] = useState("");
  const [tokenPreview, setTokenPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void waitForReady()
      .then(() => getTelegramStatus())
      .then((s) => {
        if (s.configured) {
          if (s.userId) setUserId(String(s.userId));
          if (s.tokenPreview) setTokenPreview(s.tokenPreview);
        }
      })
      .catch(() => {});
  }, []);

  const canSave = (botToken.trim().length > 0 || tokenPreview !== null) && userId.trim().length > 0;

  async function save(): Promise<void> {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveTelegramConfig(botToken.trim(), userId.trim());
      onSaved?.();
      toast("Telegram connected.", "success");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function link(url: string, label: string): React.ReactElement {
    return (
      <a
        className="home-link"
        href={url}
        onClick={(e) => {
          e.preventDefault();
          void openUrl(url);
        }}
      >
        {label}
      </a>
    );
  }

  const saveButton = (
    <button
      // In the Settings header it matches the nav bars' small buttons.
      className={embedded ? "btn btn-primary btn-sm" : "modal-btn primary"}
      disabled={!canSave || busy}
      onClick={() => void save()}
    >
      {busy ? "Verifying\u2026" : embedded ? "Save bot" : "Save"}
    </button>
  );

  return (
    <Modal title="Telegram setup" onClose={onClose}>
      {embedded && <SettingsHeaderAction>{saveButton}</SettingsHeaderAction>}
      <SettingsSection
        title="Bot token"
        description={
          <>
            Create a bot with {link("https://t.me/BotFather", "@BotFather")} (/newbot), then paste
            its token.
          </>
        }
        dialogHint={
          <div className="modal-hint" style={{ color: theme.textDim }}>
            Create a bot with {link("https://t.me/BotFather", "@BotFather")} (/newbot), then paste
            its token.
          </div>
        }
      >
        <input
          className="modal-input"
          style={{ color: theme.text, background: theme.inputBackground }}
          value={botToken}
          placeholder={
            tokenPreview ? `Saved (${tokenPreview}) — leave blank to keep` : "123456789:ABCdef…"
          }
          // A dialog focuses its first field; a Settings page leaves focus on
          // the tab bar so the arrow keys keep switching tabs.
          autoFocus={!embedded}
          onChange={(e) => setBotToken(e.target.value)}
        />
      </SettingsSection>

      <SettingsSection
        title="Your Telegram user ID"
        description={<>Message {link("https://t.me/userinfobot", "@userinfobot")} for your ID.</>}
        dialogHint={
          <div className="modal-hint" style={{ color: theme.textDim }}>
            Message {link("https://t.me/userinfobot", "@userinfobot")} for your ID.
          </div>
        }
      >
        <input
          className="modal-input"
          style={{ color: theme.text, background: theme.inputBackground }}
          value={userId}
          placeholder="123456789"
          inputMode="numeric"
          onChange={(e) => setUserId(e.target.value.replace(/[^0-9]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
      </SettingsSection>

      {error && (
        <div className="modal-error" style={{ color: theme.error }}>
          {error}
        </div>
      )}
      {/* On the page, Save sits in the screen's header bar instead. */}
      {!embedded && (
        <div className="modal-actions">
          <ModalDismissButton onClick={onClose}>Cancel</ModalDismissButton>
          {saveButton}
        </div>
      )}
    </Modal>
  );
}
