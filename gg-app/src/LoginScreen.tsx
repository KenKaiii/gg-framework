import { useCallback, useEffect, useState } from "react";
import { theme } from "./theme";
import { authStatus, subscribe, type AuthProvider, type SidecarEvent } from "./agent";
import { Badge } from "./Badge";
import { BackButton } from "./BackButton";
import { ProviderLoginModal } from "./ProviderLoginModal";
import { LocalModelsModal } from "./LocalModelsModal";
import { HfPullModal } from "./HfPullModal";
import { providerLogo, providerLogoIsMono } from "./provider-logos";
import { SettingsHeaderStatus } from "./settings-header";
import { SettingsCard } from "./settings-section";
import { useSettingsPageReady } from "./settings-ready";

interface Props {
  /**
   * Shown as its own screen, with a header and Back. Omitted inside the
   * Settings screen's AI Providers tab, which supplies both.
   */
  onClose?: () => void;
}

/**
 * Provider login hub. Shows every supported AI provider as a grid of logo
 * tiles with a live connection dot; selecting one opens a modal that adapts
 * to OAuth, API key, or both. Mirrors `ggcoder login` in the desktop app.
 */
export function LoginScreen({ onClose }: Props): React.ReactElement {
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  // In Settings, skip the "checking providers…" frame: the read is native and fast.
  useSettingsPageReady(!loading);
  const [active, setActive] = useState<AuthProvider | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  // Swapped in place (never stacked) so Escape closes exactly one modal.
  const [hfOpen, setHfOpen] = useState(false);
  const openHfPull = useCallback((): void => {
    setActive(null);
    setLocalOpen(false);
    setHfOpen(true);
  }, []);

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

  // ~/.gg/auth.json is shared by every window, so connecting or disconnecting
  // anywhere changes what THIS screen should show. `auth_change` covers both
  // directions (unlike `auth_done`, which only means a login succeeded);
  // without re-reading here the connection dots and the "N connected" badge
  // stay stale until the screen is reopened.
  useEffect(() => {
    const unsub = subscribe((e: SidecarEvent) => {
      if (e.type === "auth_change") void refresh();
    });
    return () => unsub();
  }, [refresh]);

  const connectedCount = providers.filter((p) => p.connected).length;
  // Local endpoints (from the Ollama modal) arrive in this list too so the
  // gates and this badge count them, but they aren't cloud tiles: their home
  // is the Ollama tile below, which opens the endpoint manager.
  const cloudProviders = providers.filter((p) => !p.local);
  // The provider list is static in Rust, so an empty list after loading means
  // the read failed (authStatus reports failure as []). Say so, with a retry,
  // rather than showing a blank grid.
  const readFailed = !loading && providers.length === 0;

  const connectedBadge =
    loading || readFailed ? null : (
      <Badge color={connectedCount > 0 ? theme.success : undefined}>
        {`${connectedCount} connected`}
      </Badge>
    );

  const tiles = (
    <>
      {loading && (
        <div className="picker-empty" style={{ color: theme.textDim }}>
          {"checking providers\u2026"}
        </div>
      )}
      {readFailed && (
        <div className="picker-empty" role="alert">
          <span style={{ color: theme.textMuted }}>Couldn't read your AI providers.</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}
      {cloudProviders.map((p) => {
        const logo = providerLogo(p.value);
        return (
          <button key={p.value} className="login-tile" onClick={() => setActive(p)}>
            {p.connected && (
              <span className="login-conn-dot" title="Connected" aria-label="Connected" />
            )}
            <span className="login-tile-logo">
              {logo ? (
                <img
                  className="login-logo"
                  src={logo}
                  alt=""
                  data-mono={providerLogoIsMono(p.value) || undefined}
                />
              ) : (
                <span className="login-logo-fallback">{p.label.charAt(0)}</span>
              )}
            </span>
            <span className="login-tile-name">{p.label}</span>
            <span className="login-tile-methods">
              {p.methods.map((m) => {
                // Providers can support two methods and have BOTH connected, so
                // colour each badge by its own state instead of the tile's one
                // dot: green = this credential is on file. The dot above still
                // answers "is this provider usable at all".
                const isConnected = (p.connectedMethods ?? []).includes(m);
                const isActive = p.activeMethod === m;
                const label = m === "oauth" ? "OAuth" : "API key";
                return (
                  <Badge
                    key={m}
                    color={isConnected ? theme.success : undefined}
                    title={
                      isConnected
                        ? isActive
                          ? `${label} — connected, in use`
                          : `${label} — connected, standby`
                        : `${label} — not connected`
                    }
                  >
                    {label}
                  </Badge>
                );
              })}
            </span>
          </button>
        );
      })}
      {/* Ollama's official mark (dark-icon-64 from ollama.com), same 48px
              logo box as every provider tile. */}
      {!loading && (
        <button
          className="login-tile"
          onClick={() => setLocalOpen(true)}
          title="Ollama: models running on this machine"
        >
          <span className="login-tile-logo">
            <img className="login-logo" src={providerLogo("ollama")} alt="" />
          </span>
          <span className="login-tile-name">Ollama</span>
          <span className="login-tile-methods">
            <Badge>No key needed</Badge>
          </span>
        </button>
      )}
      {/* The local twin: search the Hub and download models straight into
              Ollama — no token, no account. */}
      {!loading && (
        <button
          className="login-tile"
          onClick={() => setHfOpen(true)}
          title="Hugging Face: download models to Ollama"
        >
          <span className="login-tile-logo">
            <img className="login-logo" src={providerLogo("huggingface")} alt="" />
          </span>
          <span className="login-tile-name">Hugging Face</span>
          <span className="login-tile-methods">
            <Badge>Download models</Badge>
          </span>
        </button>
      )}
    </>
  );

  return (
    <div className={onClose ? "picker" : "settings-panel"}>
      {onClose ? (
        <div className="picker-head" data-tauri-drag-region>
          <BackButton label="Back" onClick={onClose} />
          <span className="picker-title">AI Providers</span>
          {connectedBadge}
        </div>
      ) : (
        <>
          {/* In Settings the screen header names the page; the count joins it. */}
          <SettingsHeaderStatus>{connectedBadge}</SettingsHeaderStatus>
        </>
      )}

      <div className={onClose ? "login-scroll" : undefined}>
        {/* In Settings the tiles sit in a card like every other page's
            sections; on the standalone screen they fill it as before. */}
        {!onClose ? (
          <SettingsCard title="Providers" description="Sign in to the models your agent can use.">
            <div className="login-grid">{tiles}</div>
          </SettingsCard>
        ) : (
          <div className="login-grid">{tiles}</div>
        )}
      </div>

      {active && (
        <ProviderLoginModal
          provider={active}
          onClose={() => setActive(null)}
          onChanged={() => void refresh()}
          {...(active.value === "huggingface" ? { onOpenHfPull: openHfPull } : {})}
        />
      )}

      {localOpen && <LocalModelsModal onClose={() => setLocalOpen(false)} />}

      {hfOpen && <HfPullModal onClose={() => setHfOpen(false)} />}
    </div>
  );
}
