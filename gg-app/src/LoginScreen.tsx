import { useCallback, useEffect, useState } from "react";
import { theme } from "./theme";
import { authStatus, type AuthProvider } from "./agent";
import { Badge } from "./Badge";
import { BackButton } from "./BackButton";
import { ProviderLoginModal } from "./ProviderLoginModal";
import { providerLogo } from "./provider-logos";

interface Props {
  onClose: () => void;
}

/**
 * Provider login hub. Shows every supported AI provider as a grid of logo
 * tiles with a live connection dot; selecting one opens a modal that adapts
 * to OAuth, API key, or both. Mirrors `ggcoder login` in the desktop app.
 */
export function LoginScreen({ onClose }: Props): React.ReactElement {
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<AuthProvider | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const list = await authStatus();
    setProviders(list);
    setLoading(false);
    // Keep the open modal's `connected` flag in sync after a change.
    setActive((cur) => (cur ? (list.find((p) => p.value === cur.value) ?? cur) : cur));
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Auth status is read natively (Rust) — no sidecar wait, so the list renders
    // immediately even while the agent is still booting or has crashed.
    void authStatus()
      .then((list) => {
        if (!cancelled) {
          setProviders(list);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connectedCount = providers.filter((p) => p.connected).length;

  return (
    <div className="picker">
      <div className="picker-head" data-tauri-drag-region>
        <BackButton label="Back" onClick={onClose} />
        <span className="picker-title">AI Providers</span>
        {!loading && (
          <Badge color={connectedCount > 0 ? theme.success : undefined}>
            {`${connectedCount} connected`}
          </Badge>
        )}
      </div>

      <div className="login-scroll">
        <div className="login-grid">
          {loading && (
            <div className="picker-empty" style={{ color: theme.textDim }}>
              {"checking providers\u2026"}
            </div>
          )}
          {providers.map((p) => {
            const logo = providerLogo(p.value);
            return (
              <button key={p.value} className="login-tile" onClick={() => setActive(p)}>
                {p.connected && (
                  <span className="login-conn-dot" title="Connected" aria-label="Connected" />
                )}
                <span className="login-tile-logo">
                  {logo ? (
                    <img className="login-logo" src={logo} alt="" />
                  ) : (
                    <span className="login-logo-fallback">{p.label.charAt(0)}</span>
                  )}
                </span>
                <span className="login-tile-name">{p.label}</span>
                <span className="login-tile-methods">
                  {p.methods.map((m) => (
                    <Badge key={p.value}>{m === "oauth" ? "OAuth" : "API key"}</Badge>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {active && (
        <ProviderLoginModal
          provider={active}
          onClose={() => setActive(null)}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
