import type { RefObject } from "react";
import { theme } from "./theme";
import type { AzurePendingState } from "./useAzureConnectionFormState";

interface Props {
  generalErrorId: string;
  pending: AzurePendingState;
  disabled: boolean;
  keepConnectionRef: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}

export function AzureRemoveConfirmation({
  generalErrorId,
  pending,
  disabled,
  keepConnectionRef,
  onCancel,
  onConfirm,
}: Props): React.ReactElement {
  return (
    <div
      className="azure-confirm"
      role="alertdialog"
      aria-labelledby={`${generalErrorId}-confirm-title`}
      aria-describedby={`${generalErrorId}-confirm-message`}
    >
      <h4 id={`${generalErrorId}-confirm-title`}>Remove Azure connection?</h4>
      <p id={`${generalErrorId}-confirm-message`} style={{ color: theme.textSecondary }}>
        This deletes the saved credential and refreshes models. An environment-managed connection
        may become active instead.
      </p>
      <div className="azure-settings-actions">
        <button
          ref={keepConnectionRef}
          className="modal-btn"
          type="button"
          disabled={disabled}
          onClick={onCancel}
        >
          Keep connection
        </button>
        <button
          className="modal-btn azure-remove-btn"
          type="button"
          disabled={disabled}
          onClick={onConfirm}
        >
          {pending === "removing" ? "Removing…" : "Remove connection"}
        </button>
      </div>
    </div>
  );
}
