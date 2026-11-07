import { useEffect, useState } from "react";
import { getSubscriptionUsage } from "./agent";
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageProviderSnapshot,
  SubscriptionUsageWindow,
} from "./agent";
import { compactResetLabel, fullResetLabel } from "./usage-display";

function supportedProvider(provider: string): provider is SubscriptionUsageProvider {
  return provider === "anthropic" || provider === "moonshot";
}

function shortWindowLabel(window: SubscriptionUsageWindow): string {
  if (window.kind === "weekly") return "week";
  return window.label.replace(/-hour$/i, "h").replace(/\s+/g, "");
}

/**
 * The current provider's subscription usage (5-hour and weekly windows), kept
 * fresh while the window has focus. Null when the provider has no quota to
 * show, isn't connected, or the last fetch failed with nothing to fall back on.
 */
export function useSubscriptionUsage(currentProvider: string): {
  snapshot: SubscriptionUsageProviderSnapshot | null;
  now: number;
} {
  const [snapshot, setSnapshot] = useState<SubscriptionUsageProviderSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setSnapshot((previous) => (previous?.provider === currentProvider ? previous : null));
  }, [currentProvider]);

  useEffect(() => {
    if (!supportedProvider(currentProvider)) return;
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const response = await getSubscriptionUsage(currentProvider);
        if (disposed) return;
        setNow(Date.now());
        // Keep the last good snapshot when a refresh comes back unusable while
        // still connected; a disconnect clears it.
        const usable = response.connected && !response.error && response.windows.length > 0;
        if (usable || !response.connected) setSnapshot(response);
      } catch {
        // Transient: keep what we had.
      }
    };
    void refresh();
    const refreshTimer = window.setInterval(() => {
      if (document.hasFocus()) void refresh();
    }, 10_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
      window.removeEventListener("focus", refresh);
    };
  }, [currentProvider]);

  const usable =
    supportedProvider(currentProvider) &&
    snapshot?.provider === currentProvider &&
    snapshot.connected &&
    !snapshot.error;
  return { snapshot: usable ? snapshot : null, now };
}

export function TitleUsageMeter({ currentProvider }: { currentProvider: string }) {
  const { snapshot, now } = useSubscriptionUsage(currentProvider);
  const [selection, setSelection] = useState<{
    provider: string;
    kind: "current" | "weekly";
  }>({ provider: currentProvider, kind: "current" });
  const windowKind = selection.provider === currentProvider ? selection.kind : "current";

  if (!snapshot) return null;

  const selectedWindow =
    snapshot.windows.find((window) => window.kind === windowKind) ?? snapshot.windows[0];
  if (!selectedWindow) return null;

  const canToggle = snapshot.windows.some((window) => window.kind !== selectedWindow.kind);
  const percent = Math.min(100, Math.max(0, selectedWindow.usedPercent));
  const roundedPercent = Math.round(percent);
  const reset = compactResetLabel(selectedWindow.resetsAt, now);
  const nextKind = selectedWindow.kind === "current" ? "weekly" : "current";
  // `stale` means the sidecar is replaying its last good snapshot because the
  // provider's quota endpoint is failing (usually a 429). The bar deliberately
  // stays put rather than flickering out, so say so on hover instead of
  // presenting old numbers as live ones.
  const title = `${snapshot.displayName} ${selectedWindow.label}: ${roundedPercent}% used · ${fullResetLabel(selectedWindow.resetsAt, now)}${snapshot.stale ? " · last known — usage is temporarily unavailable" : ""}${canToggle ? ` · Click for ${nextKind} usage` : ""}`;

  return (
    <button
      className={`title-usage-meter${snapshot.stale ? " is-stale" : ""}`}
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={selectedWindow.kind === "weekly"}
      // A provider can report a single window (Codex commonly returns
      // weekly-only). There is nothing to switch to then, so mark the control
      // non-interactive: that drops the pointer/hover affordance and suppresses
      // the global UI click sound, which otherwise cues a press that does
      // nothing. `aria-disabled` rather than `disabled` keeps the usage tooltip
      // reachable on hover.
      aria-disabled={!canToggle}
      onClick={() => canToggle && setSelection({ provider: currentProvider, kind: nextKind })}
    >
      <span className="title-usage-window">{shortWindowLabel(selectedWindow)}</span>
      <span className="title-usage-track" aria-hidden="true">
        <span className="title-usage-fill" style={{ width: `${percent}%` }} />
        <span className="title-usage-particles">
          {Array.from({ length: 5 }, (_, index) => (
            <span className="title-usage-particle" key={index} />
          ))}
        </span>
      </span>
      <span className="title-usage-reset">{reset}</span>
    </button>
  );
}
