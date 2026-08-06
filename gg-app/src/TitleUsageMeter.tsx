import { useEffect, useState } from "react";
import { getSubscriptionUsage } from "./agent";
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageProviderSnapshot,
  SubscriptionUsageWindow,
} from "./agent";
import { compactResetLabel, fullResetLabel } from "./usage-display";

function supportedProvider(provider: string): provider is SubscriptionUsageProvider {
  return provider === "anthropic" || provider === "openai" || provider === "moonshot";
}

function shortWindowLabel(window: SubscriptionUsageWindow): string {
  if (window.kind === "weekly") return "week";
  return window.label.replace(/-hour$/i, "h").replace(/\s+/g, "");
}

export function TitleUsageMeter({ currentProvider }: { currentProvider: string }) {
  const [snapshot, setSnapshot] = useState<SubscriptionUsageProviderSnapshot | null>(null);
  const [selection, setSelection] = useState<{
    provider: string;
    kind: "current" | "weekly" | null;
  }>({ provider: currentProvider, kind: null });
  const [now, setNow] = useState(() => Date.now());
  const windowKind = selection.provider === currentProvider ? selection.kind : null;

  // Never carry one provider's numbers over to another — clear on switch.
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
        // A transient failure (these quota endpoints hand out 429s freely) comes
        // back as a connected-but-empty snapshot. Dropping it into state would
        // unmount the meter for the whole backoff window and pop it back in on
        // the next success — so keep the last usable snapshot instead.
        const usable = response.connected && !response.error && response.windows.length > 0;
        if (usable || !response.connected) setSnapshot(response);
      } catch {
        // The title strip is ambient status, not an error surface. Keep it quiet
        // when the provider's private usage endpoint is temporarily unavailable.
      }
    };
    void refresh();
    // A newly-active Anthropic window can gain reset timestamps a few seconds
    // after its utilization appears. Poll lightly and refresh immediately when
    // the app regains focus so the countdown fills in without a manual reload.
    const refreshTimer = window.setInterval(() => void refresh(), 10_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
      window.removeEventListener("focus", refresh);
    };
  }, [currentProvider]);

  if (
    !supportedProvider(currentProvider) ||
    snapshot?.provider !== currentProvider ||
    !snapshot.connected ||
    snapshot.error
  ) {
    return null;
  }

  const selectedWindow =
    windowKind === null
      ? snapshot.windows[0]
      : snapshot.windows.find((window) => window.kind === windowKind);
  const selectedKind = selectedWindow?.kind ?? windowKind;
  if (!selectedKind) return null;

  const nextKind = selectedKind === "current" ? "weekly" : "current";
  const nextIsAvailable = snapshot.windows.some((window) => window.kind === nextKind);
  const nextIsKnownUnavailable = snapshot.unavailableWindowKinds?.includes(nextKind) ?? false;
  const canToggle = nextIsAvailable || nextIsKnownUnavailable;
  const unavailable = !selectedWindow;
  const staleWindow = snapshot.staleWindowKinds?.includes(selectedKind) ?? false;
  const percent = selectedWindow
    ? Math.min(100, Math.max(0, selectedWindow.usedPercent))
    : 0;
  const roundedPercent = Math.round(percent);
  const reset = selectedWindow ? compactResetLabel(selectedWindow.resetsAt, now) : "unavailable";
  const label = selectedWindow?.label ?? (selectedKind === "current" ? "Short-term" : "Weekly");
  // `stale` means the sidecar is replaying its last good snapshot because the
  // provider's quota endpoint is failing (usually a 429). A stale window is a
  // recent value preserved from a partial response. Both remain visible, but
  // are explicitly identified rather than presented as live numbers.
  const status = unavailable
    ? "usage unavailable"
    : `${roundedPercent}% used · ${fullResetLabel(selectedWindow.resetsAt, now)}`;
  const staleNote = snapshot.stale
    ? " · last known — usage is temporarily unavailable"
    : staleWindow
      ? " · last known — this window was not included in the latest response"
      : "";
  const title = `${snapshot.displayName} ${label}: ${status}${staleNote}${canToggle ? ` · Click for ${nextKind} usage` : ""}`;

  return (
    <button
      className={`title-usage-meter${snapshot.stale || staleWindow ? " is-stale" : ""}${unavailable ? " is-unavailable" : ""}`}
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={selectedKind === "weekly"}
      onClick={() => canToggle && setSelection({ provider: currentProvider, kind: nextKind })}
    >
      <span className="title-usage-window">
        {selectedWindow
          ? shortWindowLabel(selectedWindow)
          : selectedKind === "current"
            ? "short"
            : "week"}
      </span>
      <span className="title-usage-track" aria-hidden="true">
        {!unavailable && (
          <>
            <span className="title-usage-fill" style={{ width: `${percent}%` }} />
            <span className="title-usage-particles">
              {Array.from({ length: 5 }, (_, index) => (
                <span className="title-usage-particle" key={`particle-${index}`} />
              ))}
            </span>
          </>
        )}
      </span>
      <span className="title-usage-reset">{reset}</span>
    </button>
  );
}
