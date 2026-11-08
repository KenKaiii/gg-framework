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
    // Background windows skip the poll (focus refreshes them on return): with
    // several windows open, each one waking every 10s kept the daemon fetching
    // the provider's quota endpoint all day while nobody was looking.
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
