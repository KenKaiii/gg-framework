import { useEffect, useRef, useState } from "react";
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
  authSetBaseUrl,
  openRouterCatalog,
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

const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const CHATGPT_WELCOMED_KEY = "gg-chatgpt-plan-welcomed";

/** True once the first-sign-in ChatGPT plan notice was shown on this machine. */
function chatgptWelcomed(): boolean {
  try {
    return localStorage.getItem(CHATGPT_WELCOMED_KEY) === "1";
  } catch {
    return true;
  }
}

function rememberChatgptWelcomed(): void {
  try {
    localStorage.setItem(CHATGPT_WELCOMED_KEY, "1");
  } catch {
    // Storage unavailable: the notice may show once more, which is harmless.
  }
}

const LINK_STYLE: React.CSSProperties = {
  color: theme.accent,
  padding: 0,
  font: "inherit",
  border: "none",
  background: "none",
  cursor: "pointer",
  textDecoration: "underline",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
  const [variantKey, setVariantKey] = useState<string | undefined>(() =>
    defaultVariantKey(provider),
  );
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [codePrompt, setCodePrompt] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // This window started the sign-in (auth_done reaches every window).
  const startedSignIn = useRef(false);
  // OpenAI asks apps to confirm plan use once, after the first ChatGPT sign-in.
  const [planWelcome, setPlanWelcome] = useState(false);
  const [baseUrl, setBaseUrl] = useState(provider.currentBaseUrl ?? "");
  // Only OpenRouter syncs a catalog today; `null` = not checked yet.
  const syncsCatalog = provider.allowCustomBaseUrl === true && provider.value === "openrouter";
  const [catalog, setCatalog] = useState<{ synced: boolean; count: number } | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!syncsCatalog || !provider.connected) return;
    let cancelled = false;
    void openRouterCatalog("status")
      .then((s) => {
        if (!cancelled) setCatalog(s);
      })
      .catch(() => {
        // The note simply stays hidden; Sync still works.
      });
    return () => {
      cancelled = true;
    };
  }, [syncsCatalog, provider.connected]);

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
            if (provider.value === "openai" && startedSignIn.current && !chatgptWelcomed()) {
              rememberChatgptWelcomed();
              setPlanWelcome(true);
              return;
            }
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
        provider.allowCustomBaseUrl ? baseUrl.trim() : undefined,
      );
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function saveBaseUrl(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await authSetBaseUrl(provider.value, baseUrl);
      // A synced list describes the old endpoint; fall back until re-synced.
      if (catalog?.synced) setCatalog(await openRouterCatalog("reset"));
      setStatus(
        syncsCatalog
          ? "Base URL saved. Sync models to list what this endpoint serves."
          : "Base URL saved.",
      );
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function syncModels(reset = false): Promise<void> {
    if (syncing) return;
    setSyncing(true);
    setError(null);
    setStatus(null);
    try {
      const result = await openRouterCatalog(reset ? "reset" : "sync");
      setCatalog(result);
      setStatus(
        reset
          ? "Using the built-in model list."
          : `Synced ${result.count} model${result.count === 1 ? "" : "s"} from ${hostOf(result.baseUrl)}` +
              (result.skipped ? ` (${result.skipped} without tool calling left out).` : "."),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function startOAuth(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus("Starting login…");
    startedSignIn.current = true;
    try {
      await authOAuthStart(provider.value);
    } catch (e) {
      startedSignIn.current = false;
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
  const baseUrlChanged =
    provider.allowCustomBaseUrl === true &&
    baseUrl.trim().replace(/\/+$/, "") !== (provider.currentBaseUrl ?? "");
  // A connected key can move to another endpoint without being pasted again.
  const savesBaseUrlOnly = provider.connected && !apiKey.trim() && baseUrlChanged;
  const connectedMethods = provider.connectedMethods ?? [];
  const guidance = provider.methodGuidance ?? [];

  if (planWelcome) {
    return (
      <Modal title="You're using your ChatGPT plan" onClose={onClose}>
        <div className="login-modal-desc">
          Eligible requests in GG Coder now use your ChatGPT plan. You can review usage and set a
          limit for GG Coder in ChatGPT settings.
        </div>
        <div className="modal-actions">
          <button className="modal-btn" onClick={() => void openUrl(CHATGPT_USAGE_URL)}>
            Manage usage
          </button>
          <button className="modal-btn primary" autoFocus onClick={onClose}>
            Got it
          </button>
        </div>
      </Modal>
    );
  }

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
                Key type
              </div>
              <div className="login-method-row" role="radiogroup" aria-label="Key type">
                {provider.apiKeyVariants.map((v) => (
                  <button
                    key={v.key}
                    role="radio"
                    aria-checked={variantKey === v.key}
                    className={"modal-btn" + (variantKey === v.key ? " primary" : "")}
                    onClick={() => setVariantKey(v.key)}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {/* What this key bills: the chosen variant's line, or the provider's
              own guidance (e.g. GLM's Coding Plan can't be used here). */}
          {(() => {
            const variant = provider.apiKeyVariants?.find((v) => v.key === variantKey);
            const keyGuidance = guidance.find((g) => g.method === "apikey");
            const lines =
              variant?.billing && (provider.apiKeyVariants?.length ?? 0) > 1
                ? [variant.billing]
                : single
                  ? [keyGuidance?.billing, keyGuidance?.when]
                  : [];
            return lines
              .filter((line): line is string => Boolean(line))
              .map((line) => (
                <div key={line} className="login-method-note">
                  {line}
                </div>
              ));
          })()}
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
                API base URL (optional)
              </div>
              <input
                className="modal-input"
                style={{ color: theme.text, background: theme.inputBackground }}
                value={baseUrl}
                aria-label="API base URL"
                inputMode="url"
                placeholder={provider.defaultBaseUrl ?? "https://"}
                onChange={(e) => setBaseUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  if (savesBaseUrlOnly) void saveBaseUrl();
                  else void submitApiKey();
                }}
              />
            </>
          )}
          {syncsCatalog && provider.connected && (
            <div className="login-method-note">
              {catalog?.synced
                ? `Model list synced from the endpoint (${catalog.count}).`
                : "Using the built-in model list."}{" "}
              <button
                className="link-btn"
                style={LINK_STYLE}
                disabled={syncing || busy}
                onClick={() => void syncModels()}
              >
                {syncing ? "Syncing\u2026" : "Sync models"}
              </button>
              {catalog?.synced && !syncing && (
                <>
                  {" · "}
                  <button
                    className="link-btn"
                    style={LINK_STYLE}
                    onClick={() => void syncModels(true)}
                  >
                    Use built-in list
                  </button>
                </>
              )}
            </div>
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
                placeholder="Paste the code or callback URL"
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
          <button className="link-btn" style={LINK_STYLE} onClick={onOpenHfPull}>
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
        {method === "apikey" &&
          (savesBaseUrlOnly ? (
            <button
              className="modal-btn primary"
              disabled={busy}
              onClick={() => void saveBaseUrl()}
            >
              {busy ? "Saving…" : "Save base URL"}
            </button>
          ) : (
            <button
              className="modal-btn primary"
              disabled={!apiKey.trim() || busy}
              onClick={() => void submitApiKey()}
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          ))}
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
            {/* OpenAI's sign-in button must read "Continue with ChatGPT". */}
            {busy ? "Waiting…" : provider.value === "openai" ? "Continue with ChatGPT" : "Continue"}
          </button>
        )}
      </div>
    </Modal>
  );
}
