import { useCallback, useEffect, useState } from "react";
import { theme } from "./theme";
import { authLogout, authStatus, subscribe, type AuthProvider, type SidecarEvent } from "./agent";
import { Badge } from "./Badge";
import { BackButton } from "./BackButton";
import { ProviderLoginModal } from "./ProviderLoginModal";
import { LocalModelsModal } from "./LocalModelsModal";
import { HfPullModal } from "./HfPullModal";
import { ProvidersBay } from "./ProvidersBay";
import { SettingsHeaderStatus } from "./settings-header";
import { useSettingsPageReady } from "./settings-ready";

interface Props {
  /**
   * Shown as its own screen, with a header and Back. Omitted inside the
   * Settings screen's AI Providers tab, which supplies both.
   */
  onClose?: () => void;
}

/**
 * Provider login hub: every supported AI provider around the brain they power
 * (ProvidersBay). Selecting one opens a modal that adapts to OAuth, API key,
 * or both. Mirrors `ggcoder login` in the desktop app.
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
  // without re-reading here the nerves, the brain and the "N connected" badge
  // stay stale until the screen is reopened.
  useEffect(() => {
    const unsub = subscribe((e: SidecarEvent) => {
      if (e.type === "auth_change") void refresh();
    });
    return () => unsub();
  }, [refresh]);

  const connectedCount = providers.filter((p) => p.connected).length;
  // The provider list is static in Rust, so an empty list after loading means
  // the read failed (authStatus reports failure as []). Say so, with a retry,
  // rather than showing a blank grid.
  const readFailed = !loading && providers.length === 0;
  const reauth = providers.find((p) => p.reauthRequired);

  // Dismissing removes only the dead sign-in, so the notice shows until the user acts.
  const dismissReauth = (provider: AuthProvider): void => {
    void authLogout(provider.value, "legacy")
      .catch(() => undefined)
      .then(refresh);
  };

  const connectedBadge =
    loading || readFailed ? null : (
      <Badge color={connectedCount > 0 ? theme.success : undefined}>
        {`${connectedCount} connected`}
      </Badge>
    );

  const body = loading ? (
    <div className="picker-empty" style={{ color: theme.textDim }}>
      {"checking providers\u2026"}
    </div>
  ) : readFailed ? (
    <div className="picker-empty" role="alert">
      <span style={{ color: theme.textMuted }}>Couldn't read your AI providers.</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => void refresh()}>
        Try again
      </button>
    </div>
  ) : (
    <>
      {reauth && (
        <div className="login-reauth" role="status">
          <span className="login-reauth-text">
            {reauth.reauthMessage ?? `Your old ${reauth.label} sign-in no longer works.`}
          </span>
          <div className="login-reauth-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => setActive(reauth)}
            >
              Reconnect
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => dismissReauth(reauth)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div className="providers-frame">
        <ProvidersBay
          providers={providers}
          onOpen={setActive}
          onOpenLocal={() => setLocalOpen(true)}
          onOpenHfPull={() => setHfOpen(true)}
        />
      </div>
    </>
  );

  return (
    <div className={onClose ? "picker" : "settings-panel providers-page"}>
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

      {onClose ? <div className="login-scroll">{body}</div> : body}

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
