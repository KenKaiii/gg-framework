import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AzureConnectionCommandError,
  getAzureConnectionStatus,
  onModelsChanged,
  removeAzureConnection,
  saveAzureConnection,
  type AzureConnectionErrorField,
  type AzureConnectionStatus,
} from "./agent";
import type { SafeTauriUnlisten } from "./tauri-listener";

export type AzureFieldErrors = Partial<Record<AzureConnectionErrorField, string>>;
export type AzurePendingState = "loading" | "saving" | "removing" | null;
type RefreshOperation = "save" | "remove";

// Keep these byte limits aligned with src-tauri/src/azure_connection/validation.rs.
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_DEPLOYMENT_LENGTH = 256;
const MAX_API_KEY_LENGTH = 8_192;
const AZURE_HOST_SUFFIXES = [".openai.azure.com", ".cognitiveservices.azure.com"] as const;
const textEncoder = new TextEncoder();

function exceedsByteLength(value: string, maximum: number): boolean {
  return textEncoder.encode(value).length > maximum;
}

function containsControlCharacter(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function localErrors(
  endpoint: string,
  deployment: string,
  hasStoredKey: boolean,
  apiKey: string,
): AzureFieldErrors {
  const errors: AzureFieldErrors = {};
  const trimmedEndpoint = endpoint.trim();
  const invalidEndpoint =
    !trimmedEndpoint ||
    exceedsByteLength(trimmedEndpoint, MAX_ENDPOINT_LENGTH) ||
    containsControlCharacter(trimmedEndpoint);

  if (!invalidEndpoint) {
    try {
      const parsed = new URL(trimmedEndpoint);
      const suffix = AZURE_HOST_SUFFIXES.find((candidate) => parsed.hostname.endsWith(candidate));
      const resource = suffix ? parsed.hostname.slice(0, -suffix.length) : "";
      const validPath = parsed.pathname === "/" || parsed.pathname === "";
      if (
        parsed.protocol !== "https:" ||
        !resource ||
        resource.includes(".") ||
        parsed.port ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        !validPath
      ) {
        errors.endpoint =
          "Enter an HTTPS Azure resource endpoint, such as https://example.openai.azure.com.";
      }
    } catch {
      errors.endpoint =
        "Enter an HTTPS Azure resource endpoint, such as https://example.openai.azure.com.";
    }
  } else {
    errors.endpoint =
      "Enter an HTTPS Azure resource endpoint, such as https://example.openai.azure.com.";
  }

  const trimmedDeployment = deployment.trim();
  if (
    !trimmedDeployment ||
    exceedsByteLength(trimmedDeployment, MAX_DEPLOYMENT_LENGTH) ||
    containsControlCharacter(trimmedDeployment)
  ) {
    errors.deployment = "Enter an Azure deployment name containing 1 to 256 characters.";
  }

  const trimmedApiKey = apiKey.trim();
  if (!hasStoredKey && !trimmedApiKey) {
    errors.apiKey = "Enter an Azure OpenAI API key.";
  } else if (
    trimmedApiKey &&
    (exceedsByteLength(trimmedApiKey, MAX_API_KEY_LENGTH) ||
      containsControlCharacter(trimmedApiKey))
  ) {
    errors.apiKey = "Enter a valid Azure OpenAI API key.";
  }

  return errors;
}

export function useAzureConnectionFormState(onConnectionChanged?: () => void) {
  const [status, setStatus] = useState<AzureConnectionStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [deployment, setDeployment] = useState("");
  const [errors, setErrors] = useState<AzureFieldErrors>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [liveStatus, setLiveStatus] = useState("");
  const [pending, setPending] = useState<AzurePendingState>("loading");
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const endpointRef = useRef<HTMLInputElement>(null);
  const deploymentRef = useRef<HTMLInputElement>(null);
  const keepConnectionRef = useRef<HTMLButtonElement>(null);
  const statusRequestRef = useRef(0);
  const commandPendingRef = useRef(false);
  const onConnectionChangedRef = useRef(onConnectionChanged);
  const endpointErrorId = useId();
  const deploymentErrorId = useId();
  const apiKeyErrorId = useId();
  const generalErrorId = useId();

  useEffect(() => {
    onConnectionChangedRef.current = onConnectionChanged;
  }, [onConnectionChanged]);

  const clearApiKey = useCallback((): void => {
    if (apiKeyRef.current) apiKeyRef.current.value = "";
  }, []);

  const setApiKeyInput = useCallback((node: HTMLInputElement | null): void => {
    if (!node && apiKeyRef.current) apiKeyRef.current.value = "";
    apiKeyRef.current = node;
  }, []);

  const applyStatus = useCallback(
    (nextStatus: AzureConnectionStatus): void => {
      clearApiKey();
      setStatus(nextStatus);
      setEndpoint(nextStatus.endpoint ?? "");
      setDeployment(nextStatus.deployment ?? "");
      setEditing(nextStatus.source === "none");
    },
    [clearApiKey],
  );

  const loadStatus = useCallback(async (): Promise<void> => {
    const request = ++statusRequestRef.current;
    setPending("loading");
    setGeneralError(null);
    try {
      const nextStatus = await getAzureConnectionStatus();
      if (statusRequestRef.current !== request) return;
      applyStatus(nextStatus);
    } catch (error) {
      if (statusRequestRef.current !== request) return;
      setGeneralError(
        error instanceof AzureConnectionCommandError
          ? error.message
          : "Azure connection status could not be loaded. Try again.",
      );
    } finally {
      if (statusRequestRef.current === request) setPending(null);
    }
  }, [applyStatus]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (confirmingRemove) keepConnectionRef.current?.focus();
  }, [confirmingRemove]);

  useEffect(() => {
    let disposed = false;
    let unlisten: SafeTauriUnlisten | undefined;
    void onModelsChanged(() => {
      const request = ++statusRequestRef.current;
      void getAzureConnectionStatus()
        .then((nextStatus) => {
          if (!disposed && statusRequestRef.current === request) {
            applyStatus(nextStatus);
            if (!commandPendingRef.current) setPending(null);
          }
        })
        .catch(() => {});
      onConnectionChangedRef.current?.();
    }).then((stopListening) => {
      if (disposed) void stopListening();
      else unlisten = stopListening;
    });
    return () => {
      disposed = true;
      statusRequestRef.current += 1;
      commandPendingRef.current = false;
      void unlisten?.();
      clearApiKey();
    };
  }, [applyStatus, clearApiKey]);

  function focusFirstError(nextErrors: AzureFieldErrors): void {
    window.setTimeout(() => {
      if (nextErrors.endpoint) endpointRef.current?.focus();
      else if (nextErrors.deployment) deploymentRef.current?.focus();
      else if (nextErrors.apiKey) apiKeyRef.current?.focus();
    });
  }

  function normalizeCommandError(error: unknown): AzureConnectionCommandError {
    return error instanceof AzureConnectionCommandError
      ? error
      : new AzureConnectionCommandError(
          "The Azure connection could not be updated. Try again.",
          "unknown",
        );
  }

  function showCommandError(safeError: AzureConnectionCommandError): void {
    clearApiKey();
    if (safeError.field) {
      const nextErrors = { [safeError.field]: safeError.message };
      setErrors(nextErrors);
      focusFirstError(nextErrors);
    } else {
      setGeneralError(safeError.message);
    }
  }

  async function handleCommandError(error: unknown, operation: RefreshOperation): Promise<void> {
    const safeError = normalizeCommandError(error);
    if (safeError.code !== "models_refresh_failed") {
      showCommandError(safeError);
      return;
    }

    // Native persistence has already succeeded for this code. Re-read the
    // secret-free status rather than presenting the previous connection as live.
    clearApiKey();
    const request = ++statusRequestRef.current;
    try {
      const nextStatus = await getAzureConnectionStatus();
      if (statusRequestRef.current === request) applyStatus(nextStatus);
    } catch {
      // Keep the explicit restart guidance even if the follow-up status read fails.
    }
    if (operation === "remove") setConfirmingRemove(false);
    setErrors({});
    setGeneralError(safeError.message);
  }

  async function submit(): Promise<void> {
    if (pending) return;
    const apiKeyInput = apiKeyRef.current;
    const apiKey = apiKeyInput ? apiKeyInput.value : "";
    const nextErrors = localErrors(endpoint, deployment, status?.hasStoredKey ?? false, apiKey);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setGeneralError(null);
      clearApiKey();
      focusFirstError(nextErrors);
      return;
    }

    statusRequestRef.current += 1;
    commandPendingRef.current = true;
    setErrors({});
    setGeneralError(null);
    setLiveStatus("Validating and saving securely.");
    setPending("saving");
    try {
      const nextStatus = await saveAzureConnection({
        endpoint: endpoint.trim(),
        deployment: deployment.trim(),
        ...(apiKey ? { apiKey } : {}),
      });
      clearApiKey();
      statusRequestRef.current += 1;
      applyStatus(nextStatus);
      setEditing(false);
      commandPendingRef.current = false;
      setPending(null);
      setLiveStatus("Azure connection saved. Models refreshed.");
    } catch (error) {
      await handleCommandError(error, "save");
      commandPendingRef.current = false;
      setPending(null);
      setLiveStatus("");
    }
  }

  async function confirmRemove(): Promise<void> {
    if (pending) return;
    statusRequestRef.current += 1;
    commandPendingRef.current = true;
    setGeneralError(null);
    setLiveStatus("Removing the connection securely.");
    setPending("removing");
    try {
      const nextStatus = await removeAzureConnection();
      clearApiKey();
      statusRequestRef.current += 1;
      applyStatus(nextStatus);
      setConfirmingRemove(false);
      commandPendingRef.current = false;
      setPending(null);
      setLiveStatus("Azure connection removed. Models refreshed.");
    } catch (error) {
      await handleCommandError(error, "remove");
      commandPendingRef.current = false;
      setPending(null);
      setLiveStatus("");
    }
  }

  function beginEdit(): void {
    clearApiKey();
    setErrors({});
    setGeneralError(null);
    setLiveStatus("");
    setConfirmingRemove(false);
    setEndpoint(status?.endpoint ?? "");
    setDeployment(status?.deployment ?? "");
    setEditing(true);
  }

  function cancelEdit(): void {
    clearApiKey();
    setErrors({});
    setGeneralError(null);
    setConfirmingRemove(false);
    setEndpoint(status?.endpoint ?? "");
    setDeployment(status?.deployment ?? "");
    setEditing(false);
  }

  const connected = status?.configured === true && status.source === "secure";
  const environmentManaged = status?.configured === true && status.source === "environment";

  return {
    status,
    endpoint,
    setEndpoint,
    deployment,
    setDeployment,
    errors,
    generalError,
    liveStatus,
    pending,
    connected,
    environmentManaged,
    showForm: editing && !environmentManaged,
    disabled: pending !== null,
    confirmingRemove,
    setConfirmingRemove,
    endpointRef,
    deploymentRef,
    keepConnectionRef,
    setApiKeyInput,
    endpointErrorId,
    deploymentErrorId,
    apiKeyErrorId,
    generalErrorId,
    loadStatus,
    submit,
    confirmRemove,
    beginEdit,
    cancelEdit,
  };
}
