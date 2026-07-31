import { Badge } from "./Badge";
import { AzureConnectionForm } from "./AzureConnectionForm";
import { AzureConnectionStatusDisplay } from "./AzureConnectionStatusDisplay";
import { AzureRemoveConfirmation } from "./AzureRemoveConfirmation";
import { theme } from "./theme";
import { useAzureConnectionFormState } from "./useAzureConnectionFormState";

interface Props {
  onConnectionChanged?: () => void;
}

export function AzureConnectionSettings({ onConnectionChanged }: Props): React.ReactElement {
  const formState = useAzureConnectionFormState(onConnectionChanged);

  return (
    <section className="azure-settings" aria-labelledby="azure-settings-title">
      <div className="azure-settings-heading">
        <div>
          <h3
            id="azure-settings-title"
            className="modal-label azure-settings-title"
            style={{ color: theme.textMuted }}
          >
            Azure OpenAI
          </h3>
          <p className="modal-hint azure-settings-description" style={{ color: theme.textMuted }}>
            Connect one deployment. The API key is stored in your operating-system credential vault.
          </p>
        </div>
        {formState.pending === "loading" ? (
          <Badge color={theme.textMuted}>Checking</Badge>
        ) : (
          <Badge
            color={
              formState.connected
                ? theme.success
                : formState.environmentManaged
                  ? theme.info
                  : theme.textMuted
            }
          >
            {formState.connected
              ? "Connected"
              : formState.environmentManaged
                ? "Environment"
                : "Not connected"}
          </Badge>
        )}
      </div>

      {formState.showForm ? (
        <AzureConnectionForm
          status={formState.status}
          endpoint={formState.endpoint}
          setEndpoint={formState.setEndpoint}
          deployment={formState.deployment}
          setDeployment={formState.setDeployment}
          errors={formState.errors}
          generalError={formState.generalError}
          pending={formState.pending}
          connected={formState.connected}
          disabled={formState.disabled}
          endpointRef={formState.endpointRef}
          deploymentRef={formState.deploymentRef}
          setApiKeyInput={formState.setApiKeyInput}
          endpointErrorId={formState.endpointErrorId}
          deploymentErrorId={formState.deploymentErrorId}
          apiKeyErrorId={formState.apiKeyErrorId}
          generalErrorId={formState.generalErrorId}
          onSubmit={() => void formState.submit()}
          onCancelEdit={formState.cancelEdit}
        />
      ) : (
        <AzureConnectionStatusDisplay
          status={formState.status}
          pending={formState.pending}
          generalError={formState.generalError}
          generalErrorId={formState.generalErrorId}
          connected={formState.connected}
          environmentManaged={formState.environmentManaged}
          disabled={formState.disabled}
          confirmingRemove={formState.confirmingRemove}
          onRetry={() => void formState.loadStatus()}
          onEdit={formState.beginEdit}
          onRequestRemove={() => formState.setConfirmingRemove(true)}
        />
      )}

      {formState.connected && !formState.showForm && formState.confirmingRemove && (
        <AzureRemoveConfirmation
          generalErrorId={formState.generalErrorId}
          pending={formState.pending}
          disabled={formState.disabled}
          keepConnectionRef={formState.keepConnectionRef}
          onCancel={() => formState.setConfirmingRemove(false)}
          onConfirm={() => void formState.confirmRemove()}
        />
      )}

      <p
        className="azure-live-status"
        role="status"
        aria-live="polite"
        style={{ color: theme.textSecondary }}
      >
        {formState.liveStatus}
      </p>
    </section>
  );
}
