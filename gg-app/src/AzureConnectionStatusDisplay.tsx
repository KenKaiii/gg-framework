import type { AzureConnectionStatus } from "./agent";
import { theme } from "./theme";
import type { AzurePendingState } from "./useAzureConnectionFormState";

function summaryValue(value: string | null): string {
  return value?.trim() || "Not available";
}

interface Props {
  status: AzureConnectionStatus | null;
  pending: AzurePendingState;
  generalError: string | null;
  generalErrorId: string;
  connected: boolean;
  environmentManaged: boolean;
  disabled: boolean;
  confirmingRemove: boolean;
  onRetry: () => void;
  onEdit: () => void;
  onRequestRemove: () => void;
}

export function AzureConnectionStatusDisplay({
  status,
  pending,
  generalError,
  generalErrorId,
  connected,
  environmentManaged,
  disabled,
  confirmingRemove,
  onRetry,
  onEdit,
  onRequestRemove,
}: Props): React.ReactElement | null {
  if (pending === "loading" && !status) {
    return (
      <div className="azure-settings-state" role="status" style={{ color: theme.textSecondary }}>
        Checking Azure connection status…
      </div>
    );
  }

  if (generalError && !status) {
    return (
      <div className="azure-settings-state">
        <p id={generalErrorId} className="modal-error" role="alert" style={{ color: theme.error }}>
          {generalError}
        </p>
        <button className="modal-btn" type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  if (environmentManaged && status) {
    return (
      <div className="azure-settings-summary">
        <dl>
          <div>
            <dt>Endpoint</dt>
            <dd>{summaryValue(status.endpointSummary)}</dd>
          </div>
          <div>
            <dt>Deployment</dt>
            <dd>{summaryValue(status.deploymentSummary)}</dd>
          </div>
          <div>
            <dt>API key</dt>
            <dd>Provided by environment</dd>
          </div>
        </dl>
        {generalError && (
          <p
            id={generalErrorId}
            className="modal-error azure-general-error"
            role="alert"
            style={{ color: theme.error }}
          >
            {generalError}
          </p>
        )}
        <p className="modal-hint" style={{ color: theme.textMuted }}>
          Managed with AZURE_OPENAI_BASE_URL, AZURE_OPENAI_DEPLOYMENT, and AZURE_OPENAI_API_KEY.
          Update them outside gg-app, then restart the app.
        </p>
      </div>
    );
  }

  if (!connected || !status) return null;

  return (
    <div className="azure-settings-summary">
      <dl>
        <div>
          <dt>Endpoint</dt>
          <dd>{summaryValue(status.endpointSummary)}</dd>
        </div>
        <div>
          <dt>Deployment</dt>
          <dd>{summaryValue(status.deploymentSummary)}</dd>
        </div>
        <div>
          <dt>API key</dt>
          <dd>•••••••• stored securely</dd>
        </div>
      </dl>
      {generalError && (
        <p
          id={generalErrorId}
          className="modal-error azure-general-error"
          role="alert"
          style={{ color: theme.error }}
        >
          {generalError}
        </p>
      )}
      {!confirmingRemove && (
        <div className="azure-settings-actions">
          <button className="modal-btn" type="button" disabled={disabled} onClick={onEdit}>
            Edit
          </button>
          <button
            className="modal-btn azure-remove-btn"
            type="button"
            disabled={disabled}
            onClick={onRequestRemove}
            aria-haspopup="dialog"
          >
            Remove connection
          </button>
        </div>
      )}
    </div>
  );
}
