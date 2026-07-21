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
    kind: "current" | "weekly";
  }>({ provider: currentProvider, kind: "current" });
  const [now, setNow] = useState(() => Date.now());
  const windowKind = selection.provider === currentProvider ? selection.kind : "current";

  useEffect(() => {
    if (!supportedProvider(currentProvider)) return;
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const response = await getSubscriptionUsage(currentProvider);
        if (!disposed) {
          setSnapshot(response);
          setNow(Date.now());
        }
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
    snapshot.windows.find((window) => window.kind === windowKind) ?? snapshot.windows[0];
  if (!selectedWindow) return null;

  const canToggle = snapshot.windows.some((window) => window.kind !== selectedWindow.kind);
  const percent = Math.min(100, Math.max(0, selectedWindow.usedPercent));
  const roundedPercent = Math.round(percent);
  const reset = compactResetLabel(selectedWindow.resetsAt, now);
  const nextKind = selectedWindow.kind === "current" ? "weekly" : "current";
  const title = `${snapshot.displayName} ${selectedWindow.label}: ${roundedPercent}% used · ${fullResetLabel(selectedWindow.resetsAt, now)}${canToggle ? ` · Click for ${nextKind} usage` : ""}`;

  return (
    <button
      className="title-usage-meter"
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={selectedWindow.kind === "weekly"}
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
