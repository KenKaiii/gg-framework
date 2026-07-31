import type { RefCallback, RefObject } from "react";
import type { AzureConnectionStatus } from "./agent";
import { theme } from "./theme";
import type { AzureFieldErrors, AzurePendingState } from "./useAzureConnectionFormState";

interface Props {
  status: AzureConnectionStatus | null;
  endpoint: string;
  setEndpoint: (value: string) => void;
  deployment: string;
  setDeployment: (value: string) => void;
  errors: AzureFieldErrors;
  generalError: string | null;
  pending: AzurePendingState;
  connected: boolean;
  disabled: boolean;
  endpointRef: RefObject<HTMLInputElement | null>;
  deploymentRef: RefObject<HTMLInputElement | null>;
  setApiKeyInput: RefCallback<HTMLInputElement>;
  endpointErrorId: string;
  deploymentErrorId: string;
  apiKeyErrorId: string;
  generalErrorId: string;
  onSubmit: () => void;
  onCancelEdit: () => void;
}

export function AzureConnectionForm({
  status,
  endpoint,
  setEndpoint,
  deployment,
  setDeployment,
  errors,
  generalError,
  pending,
  connected,
  disabled,
  endpointRef,
  deploymentRef,
  setApiKeyInput,
  endpointErrorId,
  deploymentErrorId,
  apiKeyErrorId,
  generalErrorId,
  onSubmit,
  onCancelEdit,
}: Props): React.ReactElement {
  return (
    <form
      className="azure-settings-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <label
        className="azure-field-label"
        htmlFor={`${endpointErrorId}-input`}
        style={{ color: theme.textMuted }}
      >
        Endpoint
      </label>
      <input
        ref={endpointRef}
        id={`${endpointErrorId}-input`}
        className="modal-input"
        type="url"
        inputMode="url"
        autoComplete="url"
        value={endpoint}
        disabled={disabled}
        aria-invalid={Boolean(errors.endpoint)}
        aria-describedby={errors.endpoint ? endpointErrorId : undefined}
        placeholder="https://example.openai.azure.com"
        style={{ color: theme.text, background: theme.inputBackground }}
        onChange={(event) => setEndpoint(event.target.value)}
      />
      {errors.endpoint && (
        <p id={endpointErrorId} className="modal-error" role="alert" style={{ color: theme.error }}>
          {errors.endpoint}
        </p>
      )}

      <label
        className="azure-field-label"
        htmlFor={`${deploymentErrorId}-input`}
        style={{ color: theme.textMuted }}
      >
        Deployment
      </label>
      <input
        ref={deploymentRef}
        id={`${deploymentErrorId}-input`}
        className="modal-input"
        autoComplete="off"
        value={deployment}
        disabled={disabled}
        aria-invalid={Boolean(errors.deployment)}
        aria-describedby={errors.deployment ? deploymentErrorId : undefined}
        placeholder="my-gpt-deployment"
        style={{ color: theme.text, background: theme.inputBackground }}
        onChange={(event) => setDeployment(event.target.value)}
      />
      {errors.deployment && (
        <p
          id={deploymentErrorId}
          className="modal-error"
          role="alert"
          style={{ color: theme.error }}
        >
          {errors.deployment}
        </p>
      )}

      <label
        className="azure-field-label"
        htmlFor={`${apiKeyErrorId}-input`}
        style={{ color: theme.textMuted }}
      >
        API key
      </label>
      <input
        ref={setApiKeyInput}
        id={`${apiKeyErrorId}-input`}
        className="modal-input"
        type="password"
        autoComplete="new-password"
        disabled={disabled}
        aria-invalid={Boolean(errors.apiKey)}
        aria-describedby={
          errors.apiKey ? `${apiKeyErrorId}-hint ${apiKeyErrorId}` : `${apiKeyErrorId}-hint`
        }
        placeholder={status?.hasStoredKey ? "Leave blank to keep stored key" : "Enter API key"}
        style={{ color: theme.text, background: theme.inputBackground }}
      />
      <p
        id={`${apiKeyErrorId}-hint`}
        className="modal-hint azure-key-hint"
        style={{ color: theme.textMuted }}
      >
        Write-only. Saved keys are never returned to gg-app.
      </p>
      {errors.apiKey && (
        <p id={apiKeyErrorId} className="modal-error" role="alert" style={{ color: theme.error }}>
          {errors.apiKey}
        </p>
      )}

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
      <div className="azure-settings-actions">
        {connected && (
          <button className="modal-btn" type="button" disabled={disabled} onClick={onCancelEdit}>
            Cancel edit
          </button>
        )}
        <button className="modal-btn primary" type="submit" disabled={disabled}>
          {pending === "saving"
            ? "Validating and saving…"
            : connected
              ? "Save changes"
              : "Validate and connect"}
        </button>
      </div>
    </form>
  );
}
