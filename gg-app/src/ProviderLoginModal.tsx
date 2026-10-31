import { useEffect, useState } from "react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ModalDismissButton } from "./modal-embed";
import { Badge } from "./Badge";
import {
  openUrl,
  authApiKey,
  authOAuthStart,
  authOAuthCode,
  authLogout,
  subscribe,
  type AuthProvider,
  type AuthMethod,
  type SidecarEvent,
} from "./agent";

function defaultVariantKey(provider: AuthProvider): string | undefined {
  return provider.apiKeyVariants?.[0]?.key;
}

/** "in 3h" / "in 12m" — how long OAuth stays sidelined, not an absolute stamp. */
function untilLabel(epochMs: number): string {
  const mins = Math.max(1, Math.round((epochMs - Date.now()) / 60_000));
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

interface Props {
  provider: AuthProvider;
  onClose: () => void;
  /** Called after a successful connect/disconnect so the list can refresh. */
  onChanged: () => void;
  /** Hugging Face only: opens the search-and-pull modal for local models. */
  onOpenHfPull?: () => void;
}

/**
 * Per-provider login modal. Adapts to the provider's supported methods: a
 * method picker when both OAuth and API key are available, an API-key input,
 * or the interactive OAuth flow (opens the browser, collects a pasted code when
 * the provider needs one). Mirrors `ggcoder login`.
 */
export function ProviderLoginModal({
  provider,
  onClose,
  onChanged,
  onOpenHfPull,
}: Props): React.ReactElement {
  const single = provider.methods.length === 1 ? provider.methods[0] : null;
  const [method, setMethod] = useState<AuthMethod | null>(single);
  const [apiKey, setApiKey] = useState("");
  const [baseUrlOverride, setBaseUrlOverride] = useState("");
  const [variantKey, setVariantKey] = useState<string | undefined>(() =>
    defaultVariantKey(provider),
  );
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [codePrompt, setCodePrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Listen for OAuth progress events while this modal is open.
  useEffect(() => {
    const unsub = subscribe((e: SidecarEvent) => {
      const d = e.data as Record<string, unknown>;
      switch (e.type) {
        case "auth_url":
          setStatus("Opening your browser to continue…");
          void openUrl(String(d.url ?? ""));
          break;
        case "auth_status":
          setStatus(String(d.message ?? ""));
          break;
        case "auth_need_code":
          setNeedCode(true);
          setCodePrompt(String(d.message ?? "Paste the code from the browser:"));
          setStatus(null);
          break;
        case "auth_done":
          if (d.provider === provider.value) {
            setBusy(false);
            onChanged();
            onClose();
          }
          break;
        case "auth_error":
          if (d.provider === provider.value) {
            setBusy(false);
            setNeedCode(false);
            setError(String(d.message ?? "Login failed"));
            setStatus(null);
          }
          break;
      }
    });
    return () => unsub();
  }, [provider.value, onChanged, onClose]);

  async function submitApiKey(): Promise<void> {
    if (!apiKey.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await authApiKey(
        provider.value,
        apiKey.trim(),
        variantKey,
        provider.allowCustomBaseUrl && baseUrlOverride.trim() ? baseUrlOverride.trim() : undefined,
      );
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function startOAuth(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus("Starting login…");
    try {
      await authOAuthStart(provider.value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function submitCode(): Promise<void> {
    if (!code.trim()) return;
    setStatus("Verifying…");
    setNeedCode(false);
    try {
      await authOAuthCode(code.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // `method` omitted disconnects the provider entirely; passing one drops just
  // that credential, so a spent API key can go without signing out of the
  // subscription (and vice versa).
  async function disconnect(scope?: AuthMethod): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await authLogout(provider.value, scope);
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const apiKeyLabel = provider.apiKeyLabel ?? provider.label;
  const connectedMethods = provider.connectedMethods ?? [];
  const guidance = provider.methodGuidance ?? [];

  return (
    <Modal title={`Connect ${provider.label}`} onClose={onClose}>
      <div className="login-modal-desc">{provider.description}</div>

      {/* Method picker — only when the provider supports both. Each option spells
          out what it bills against and when to pick it, because the choice is not
          cosmetic: subscription vs. metered credits. Both can be connected at
          once, so each card also shows its own state and its own disconnect. */}
      {!single && !method && (
        <>
          {provider.oauthExhaustedUntil !== undefined && (
            <div className="login-status" style={{ color: theme.warning, marginTop: 0 }}>
              {`Subscription usage is out for ~${untilLabel(provider.oauthExhaustedUntil)} — requests are using the ${apiKeyLabel} API key until it resets.`}
            </div>
          )}
          <div className="login-method-list">
            {(guidance.length > 0
              ? guidance
              : provider.methods.map((m) => ({
                  method: m,
                  label: m === "oauth" ? "Sign in" : `${apiKeyLabel} API key`,
                  billing: "",
                  when: "",
                  requires: undefined as string | undefined,
                }))
            ).map((g) => {
              const isConnected = connectedMethods.includes(g.method);
              const isActive = provider.activeMethod === g.method;
              return (
                <div key={g.method} className="login-method-card">
                  <div className="login-method-card-head">
                    <span className="login-method-card-title">{g.label}</span>
                    {isConnected && (
                      <Badge color={isActive ? theme.success : theme.textDim}>
                        {isActive ? "In use" : "Standby"}
                      </Badge>
                    )}
                  </div>
                  {g.billing && <div className="login-method-card-line">{g.billing}</div>}
                  {g.when && <div className="login-method-card-line">{g.when}</div>}
                  {g.requires && (
                    <div className="login-method-card-note">{`Needs: ${g.requires}`}</div>
                  )}
                  <div className="login-method-card-actions">
                    <button
                      className={"modal-btn" + (isConnected ? "" : " primary")}
                      onClick={() => setMethod(g.method)}
                    >
                      {isConnected ? "Replace" : "Connect"}
                    </button>
                    {isConnected && (
                      <button
                        className="modal-btn"
                        style={{ color: theme.error }}
                        disabled={busy}
                        onClick={() => void disconnect(g.method)}
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {provider.priorityNote && (
            <div className="login-method-note">{provider.priorityNote}</div>
          )}
        </>
      )}

      {/* API key entry. */}
      {method === "apikey" && (
        <>
          {provider.apiKeyVariants && provider.apiKeyVariants.length > 1 && (
            <>
              <div className="modal-label" style={{ color: theme.textMuted }}>
                Endpoint
              </div>
              <div className="login-method-row">
                {provider.apiKeyVariants.map((v) => (
                  <button
                    key={v.key}
                    className={"modal-btn" + (variantKey === v.key ? " primary" : "")}
                    onClick={() => setVariantKey(v.key)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="modal-label" style={{ color: theme.textMuted }}>
            {apiKeyLabel} API key
          </div>
          <input
            className="modal-input"
            style={{ color: theme.text, background: theme.inputBackground }}
            value={apiKey}
            type="password"
            placeholder="Paste your API key"
            autoFocus
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitApiKey();
            }}
          />
          {provider.allowCustomBaseUrl && (
            <>
              <div className="modal-label" style={{ color: theme.textMuted }}>
                API base URL <span style={{ opacity: 0.7 }}>(optional)</span>
              </div>
              <input
                className="modal-input"
                style={{ color: theme.text, background: theme.inputBackground }}
                value={baseUrlOverride}
                placeholder={provider.apiKeyBaseUrl ?? "Default endpoint"}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setBaseUrlOverride(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitApiKey();
                }}
              />
              <div className="login-method-note" style={{ color: theme.textMuted }}>
                Leave empty for the standard {provider.label} endpoint. Set it to route through a
                compatible gateway or proxy — it's stored with this key in `~/.gg/auth.json`.
              </div>
            </>
          )}
        </>
      )}

      {/* OAuth flow. */}
      {method === "oauth" && (
        <>
          {!busy && !status && (
            <div className="login-modal-desc">
              You'll be sent to {provider.label} in your browser to authorize access.
            </div>
          )}
          {needCode && (
            <>
              <div className="modal-label" style={{ color: theme.textMuted }}>
                {codePrompt}
              </div>
              <input
                className="modal-input"
                style={{ color: theme.text, background: theme.inputBackground }}
                value={code}
                placeholder="Paste the code"
                autoFocus
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitCode();
                }}
              />
            </>
          )}
        </>
      )}

      {status && (
        <div className="login-status" style={{ color: theme.textMuted }}>
          {status}
        </div>
      )}
      {error && (
        <div className="login-status" style={{ color: theme.error }}>
          {error}
        </div>
      )}

      {/* Hugging Face is the one provider with a local twin: same Hub, run on
          your machine via Ollama instead of the hosted router. Offer it here so
          people who came looking for open weights find the download path. */}
      {onOpenHfPull && (
        <div className="login-method-note">
          Want to run a model locally instead?{" "}
          <button
            className="link-btn"
            style={{
              color: theme.accent,
              padding: 0,
              font: "inherit",
              border: "none",
              background: "none",
              cursor: "pointer",
              textDecoration: "underline",
            }}
            onClick={onOpenHfPull}
          >
            Search Hugging Face and download with Ollama
          </button>
        </div>
      )}

      <div className="modal-actions">
        {provider.connected && (
          <button
            className="modal-btn"
            style={{ color: theme.error, marginRight: "auto" }}
            disabled={busy}
            onClick={() => void disconnect()}
          >
            {/* Dual-auth providers get per-method disconnects in the picker cards;
                this one is the blunt "remove everything" action, so say so when
                there are two credentials to remove. */}
            {connectedMethods.length > 1 ? "Disconnect both" : "Disconnect"}
          </button>
        )}
        {/* Picking a method is not a one-way door — let the user back out to the
            comparison instead of closing and reopening the modal. */}
        {!single && method && !busy && !needCode && (
          <button className="modal-btn" onClick={() => setMethod(null)}>
            Back
          </button>
        )}
        <ModalDismissButton onClick={onClose}>
          {needCode || busy ? "Cancel" : "Close"}
        </ModalDismissButton>
        {method === "apikey" && (
          <button
            className="modal-btn primary"
            disabled={!apiKey.trim() || busy}
            onClick={() => void submitApiKey()}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        )}
        {method === "oauth" && needCode && (
          <button
            className="modal-btn primary"
            disabled={!code.trim()}
            onClick={() => void submitCode()}
          >
            Submit
          </button>
        )}
        {method === "oauth" && !needCode && (
          <button className="modal-btn primary" disabled={busy} onClick={() => void startOAuth()}>
            {busy ? "Waiting…" : "Continue"}
          </button>
        )}
      </div>
    </Modal>
  );
}
